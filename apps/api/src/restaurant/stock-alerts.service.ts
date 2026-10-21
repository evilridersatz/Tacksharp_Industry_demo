import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { describeError } from '../common/errors.js';
import { log } from '../common/logger.js';
import { alertLevel, stockStatus, stockText } from './inventory.js';

/** Sends one message to an admin channel. The default is Amazon SNS; tests inject a fake. */
export type AlertPublisher = { publish(input: { topicArn: string; subject: string; message: string }): Promise<{ messageId?: string }> };

/**
 * Optional settings (names only; values in apps/api/.env or the server environment):
 *   STOCK_ALERT_SNS_TOPIC_ARN   admin SNS topic for low / out-of-stock alerts. Empty = alerts are skipped (logged).
 *   AWS_REGION                  region of that topic (falls back to the region inside the topic ARN).
 * Credentials come from the standard AWS chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, a profile, or an
 * instance role). They are never read, logged or stored by this code.
 */
export function stockAlertConfig(env: NodeJS.ProcessEnv = process.env) {
  const topicArn = (env.STOCK_ALERT_SNS_TOPIC_ARN ?? '').trim();
  const regionFromArn = /^arn:aws[\w-]*:sns:([a-z0-9-]+):/.exec(topicArn)?.[1];
  return { topicArn, region: (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? regionFromArn ?? '').trim(), enabled: Boolean(topicArn) };
}

class SnsPublisher implements AlertPublisher {
  private client?: { send(command: unknown): Promise<{ MessageId?: string }> };
  constructor(private readonly region: string) {}
  async publish(input: { topicArn: string; subject: string; message: string }) {
    const sns = await import('@aws-sdk/client-sns');
    this.client ??= new sns.SNSClient({ region: this.region || undefined }) as never;
    const out = await this.client!.send(new sns.PublishCommand({ TopicArn: input.topicArn, Subject: input.subject.slice(0, 99), Message: input.message }));
    return { messageId: out.MessageId };
  }
}

/**
 * Low / out-of-stock alerts to the shop's admin topic — never to customers.
 *
 * Called only after stock actually changed (an order reserved stock, a cancellation returned it, staff set it); a
 * customer asking about stock never triggers one. The level last alerted is stored on the product
 * (stockAlertLevel) and claimed with a compare-and-set, so concurrent changes and repeated checks send one alert
 * per crossing: none → low, low → out. Going back above the threshold clears it for the next time.
 */
@Injectable()
export class StockAlertService {
  publisher?: AlertPublisher;
  config = stockAlertConfig();

  constructor(private readonly prisma: PrismaService) {}

  async check(organizationId: string, itemIds: string[]): Promise<Array<{ itemId: string; level: 'low' | 'out'; sent: boolean; skipped?: string }>> {
    const results: Array<{ itemId: string; level: 'low' | 'out'; sent: boolean; skipped?: string }> = [];
    if (!itemIds.length) return results;
    const items = await this.prisma.menuItem.findMany({ where: { organizationId, id: { in: [...new Set(itemIds)] } }, include: { organization: { select: { name: true } } } });
    for (const item of items) {
      const level = alertLevel(stockStatus(item));
      const previous = item.stockAlertLevel as 'low' | 'out' | null;
      if (level === previous) continue;
      const rank = { null: 0, low: 1, out: 2 } as const;
      const escalated = rank[String(level) as keyof typeof rank] > rank[String(previous) as keyof typeof rank];
      // Claim the new level; only the caller that wins sends the alert.
      const claimed = await this.prisma.menuItem.updateMany({ where: { id: item.id, organizationId, stockAlertLevel: previous }, data: { stockAlertLevel: level } });
      if (claimed.count !== 1 || !level || !escalated) continue;

      const qty = Number(item.stockQty ?? 0);
      const unit = item.unit === 'piece' ? 'piece' : 'kg';
      const demo = item.stockIsDemo ? '[DEMO STOCK] ' : '';
      const subject = `${demo}${item.organization.name}: ${item.name} ${level === 'out' ? 'out of stock' : 'low stock'}`;
      const message = [
        `${demo}${item.name} is ${level === 'out' ? 'OUT OF STOCK' : 'running low'} at ${item.organization.name}.`,
        `Stock now: ${stockText(qty, unit)}${item.lowStockThreshold !== null ? ` (alert level ${stockText(Number(item.lowStockThreshold), unit)})` : ''}.`,
        item.stockIsDemo ? 'These are demo / sample stock numbers, not counted shop inventory.' : 'Update the stock on the dashboard (Products & rates) after restocking.',
      ].join('\n');

      if (!this.config.enabled) {
        log.info('inventory.alert_skipped', { organizationId, itemId: item.id, level, reason: 'STOCK_ALERT_SNS_TOPIC_ARN not set' });
        results.push({ itemId: item.id, level, sent: false, skipped: 'not_configured' });
        continue;
      }
      try {
        this.publisher ??= new SnsPublisher(this.config.region);
        const out = await this.publisher.publish({ topicArn: this.config.topicArn, subject, message });
        log.info('inventory.alert_sent', { organizationId, itemId: item.id, level, demo: item.stockIsDemo, messageId: out.messageId });
        results.push({ itemId: item.id, level, sent: true });
      } catch (error) {
        // Give the level back so the next stock change tries again; the stock change itself already succeeded.
        await this.prisma.menuItem.updateMany({ where: { id: item.id, organizationId, stockAlertLevel: level }, data: { stockAlertLevel: previous } });
        log.error('inventory.alert_failed', { organizationId, itemId: item.id, level, dependency: 'sns', error: describeError(error) });
        results.push({ itemId: item.id, level, sent: false, skipped: 'publish_failed' });
      }
    }
    return results;
  }

  /** Fire-and-forget after a stock change: an alert problem never fails an order or a stock update. */
  checkInBackground(organizationId: string, itemIds: string[]) {
    if (!itemIds.length) return;
    void this.check(organizationId, itemIds).catch((error) => log.error('inventory.alert_check_failed', { organizationId, error: describeError(error) }));
  }
}
