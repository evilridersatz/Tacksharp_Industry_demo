import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CredentialsService } from '../integrations/credentials.service.js';
import * as clients from '../integrations/provider-clients.js';
import type { FetchLike } from '../integrations/provider-clients.js';
import { followUpConfig } from '../restaurant/followup-config.js';
import { log } from '../common/logger.js';

export const SOCIAL_CHANNELS = ['instagram', 'messenger'] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];
export const isSocialChannel = (c: string | null | undefined): c is SocialChannel => (SOCIAL_CHANNELS as readonly string[]).includes(c ?? '');

/** Meta's standard messaging window: a business may reply for 24 hours after the person's last message. */
export const SOCIAL_WINDOW_MS = 24 * 3600_000;

/**
 * Live gate for Instagram / Messenger, the same rules as every other send: DRY_RUN never sends; demo customers are
 * never contacted; live mode reaches only ids listed in LIVE_TEST_SOCIAL_IDS until LIVE_ALLOW_ALL_CUSTOMERS=true.
 */
export function socialLiveGate(userId: string, isDemo: boolean, env: NodeJS.ProcessEnv = process.env): { live: boolean; reason?: string } {
  const cfg = followUpConfig(env);
  if (cfg.dryRun) return { live: false, reason: 'DRY_RUN is on' };
  if (isDemo) return { live: false, reason: 'demo customer: never contacted' };
  if (cfg.liveAllowAll) return { live: true };
  const ids = (env.LIVE_TEST_SOCIAL_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.includes(userId) ? { live: true } : { live: false, reason: 'not an approved test account (LIVE_TEST_SOCIAL_IDS)' };
}

export type SocialSendResult = { sent: boolean; messageId?: string; notSentReason?: string; error?: string; ambiguous?: boolean };

/** Sends a text reply on Instagram / Messenger through the organization's own Page. */
@Injectable()
export class SocialSenderService {
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: CredentialsService,
  ) {}

  /** Refusals a person must see (thrown by the caller as 400): opt-out, window closed, not connected. */
  async check(org: string, conversation: { channel: string; externalId: string | null; customerId: string | null }): Promise<{ ok: true; customer: { id: string; isDemo: boolean } } | { ok: false; reason: string }> {
    if (!isSocialChannel(conversation.channel) || !conversation.externalId) return { ok: false, reason: 'Not an Instagram / Messenger conversation.' };
    const customer = conversation.customerId ? await this.prisma.customer.findFirst({ where: { id: conversation.customerId, organizationId: org } }) : null;
    if (!customer) return { ok: false, reason: 'This conversation has no customer record.' };
    if (customer.optedOutAt || customer.doNotContact) return { ok: false, reason: 'The customer opted out (STOP) or is marked do-not-contact: no message can be sent.' };
    if (!customer.lastInboundAt || Date.now() - customer.lastInboundAt.getTime() >= SOCIAL_WINDOW_MS) return { ok: false, reason: 'More than 24 hours since the customer last wrote: Meta does not allow a reply now. Wait for the customer to write again.' };
    return { ok: true, customer: { id: customer.id, isDemo: customer.isDemo } };
  }

  windowOpen(lastInboundAt: Date | null | undefined) {
    return Boolean(lastInboundAt && Date.now() - lastInboundAt.getTime() < SOCIAL_WINDOW_MS);
  }

  async send(org: string, channel: SocialChannel, recipientId: string, isDemo: boolean, text: string): Promise<SocialSendResult> {
    const gate = socialLiveGate(recipientId, isDemo);
    if (!gate.live) return { sent: false, notSentReason: gate.reason };
    const cred = await this.creds.resolve(org, 'meta_social');
    if (cred.source !== 'organization') return { sent: false, notSentReason: `Instagram & Messenger is not connected: ${cred.reason ?? 'not enabled'}` };
    const r = await clients.metaSocialSend(this.fetchImpl, cred.secrets.pageAccessToken, cred.config.pageId, recipientId, text);
    await this.prisma.integrationEvent
      .create({ data: { organizationId: org, provider: 'meta_social', kind: 'message', ok: r.ok, latencyMs: r.latencyMs, errorCode: r.errorCode ?? null, message: `${channel}: ${r.message}`.slice(0, 500), units: 1, unitType: 'messages', source: 'organization' } })
      .catch(() => undefined);
    if (!r.ok) {
      log.warn('social.send_failed', { channel, errorCode: r.errorCode });
      return { sent: false, error: r.message, ambiguous: r.ambiguous };
    }
    return { sent: true, messageId: r.messageId };
  }

  /** Display name from Meta (best effort, only when the integration is live; never blocks a message). */
  async profileName(org: string, userId: string): Promise<string | undefined> {
    if (followUpConfig().dryRun) return undefined;
    const cred = await this.creds.resolve(org, 'meta_social').catch(() => null);
    if (cred?.source !== 'organization') return undefined;
    return clients.metaProfileName(this.fetchImpl, cred.secrets.pageAccessToken, userId).catch(() => undefined);
  }
}
