import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CredentialsService } from '../integrations/credentials.service.js';
import * as clients from '../integrations/provider-clients.js';
import type { FetchLike } from '../integrations/provider-clients.js';
import { describeError } from '../common/errors.js';
import { log } from '../common/logger.js';
import { actionSourceFor, buildEvent } from './capi-payload.js';

const WINDOW_MS = 7 * 86_400_000; // Meta accepts events up to 7 days old
const BATCH = 100;
const RETRY_MINUTES = [5, 15, 60];
const STUCK_MS = 10 * 60_000;
const STATUSES = ['queued', 'sending', 'sent', 'simulated', 'failed', 'skipped'] as const;

/**
 * Meta Conversions API, per organization (its own dataset and token; there is no shared account).
 *
 * collect(): for every organization whose meta_capi integration is enabled AND has passed its connection test, records
 *   Purchase events for orders completed (restaurant / food) and sales orders delivered (textile / retail), and Lead
 *   events for new enquiries, from the last 7 days. event_id = "<source>:<id>" is unique per organization, so running it
 *   again records nothing twice. Newest first, up to 2000 per source per minute. Opted-out, do-not-contact and demo customers are recorded as skipped (never sent).
 * deliver(): sends queued events in batches of 100. Only hashed customer data (phone, email, customer id) is sent.
 *   DRY_RUN -> "simulated", nothing sent. Temporary failures retry after 5 / 15 / 60 minutes (safe: Meta de-duplicates on
 *   event_id); a rejected request is "failed" with Meta's sanitized message. Each row is claimed before sending, so
 *   several API instances never send the same row at once; a row stuck in "sending" after a crash is queued again.
 */
@Injectable()
export class MetaCapiService {
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: CredentialsService,
  ) {}

  async tick(now = new Date()) {
    const collected = await this.collect(now);
    const delivered = await this.deliver(now);
    return { collected, delivered };
  }

  private async enabledOrgs() {
    const rows = await this.prisma.integrationCredential.findMany({ where: { provider: 'meta_capi', enabled: true, status: 'ok' }, select: { organizationId: true, config: true } });
    return rows.map((r) => ({ org: r.organizationId, events: String(((r.config ?? {}) as Record<string, string>).events ?? 'purchase_and_lead') }));
  }

  async collect(now = new Date()) {
    let total = 0;
    const since = new Date(now.getTime() - WINDOW_MS);
    for (const { org, events } of await this.enabledOrgs()) {
      const rows: Prisma.MetaCapiEventCreateManyInput[] = [];
      if (events !== 'lead') {
        const orders = await this.prisma.order.findMany({ where: { organizationId: org, status: 'completed', updatedAt: { gte: since } }, select: { id: true, orderNumber: true, customerId: true, channel: true, total: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 2000 });
        for (const o of orders) rows.push({ organizationId: org, eventId: `order:${o.id}`, eventName: 'Purchase', sourceType: 'order', sourceId: o.id, customerId: o.customerId, eventTime: o.updatedAt, actionSource: actionSourceFor(o.channel), value: o.total, currency: 'INR', orderRef: o.orderNumber });
        const sales = await this.prisma.salesOrder.findMany({ where: { organizationId: org, status: 'delivered', deliveredAt: { gte: since } }, select: { id: true, number: true, customerId: true, total: true, currency: true, deliveredAt: true }, orderBy: { deliveredAt: 'desc' }, take: 2000 });
        for (const s of sales) rows.push({ organizationId: org, eventId: `sales_order:${s.id}`, eventName: 'Purchase', sourceType: 'sales_order', sourceId: s.id, customerId: s.customerId, eventTime: s.deliveredAt!, actionSource: 'chat', value: s.total, currency: (s.currency || 'INR').slice(0, 3), orderRef: s.number });
      }
      if (events !== 'purchase') {
        const leads = await this.prisma.lead.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { id: true, customerId: true, source: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 2000 });
        for (const l of leads) rows.push({ organizationId: org, eventId: `lead:${l.id}`, eventName: 'Lead', sourceType: 'lead', sourceId: l.id, customerId: l.customerId, eventTime: l.createdAt, actionSource: actionSourceFor(l.source), value: null, currency: null, orderRef: null });
      }
      if (!rows.length) continue;
      // Customers who must not be reported are recorded as skipped, so the page explains why.
      const blocked = new Set(
        (await this.prisma.customer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.customerId))] }, OR: [{ optedOutAt: { not: null } }, { doNotContact: true }, { isDemo: true }] }, select: { id: true } })).map((c) => c.id),
      );
      for (const r of rows) if (blocked.has(r.customerId)) Object.assign(r, { status: 'skipped', lastError: 'Customer opted out, is do-not-contact or is a demo record' });
      const res = await this.prisma.metaCapiEvent.createMany({ data: rows, skipDuplicates: true });
      total += res.count;
    }
    return total;
  }

  async deliver(now = new Date()) {
    // Crash recovery: a row left in "sending" is queued again (re-sending is safe, Meta de-duplicates on event_id).
    await this.prisma.metaCapiEvent.updateMany({ where: { status: 'sending', updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }, data: { status: 'queued' } });
    const due = await this.prisma.metaCapiEvent.findMany({
      where: { status: 'queued', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    const byOrg = new Map<string, typeof due>();
    for (const e of due) byOrg.set(e.organizationId, [...(byOrg.get(e.organizationId) ?? []), e]);
    const out = { sent: 0, simulated: 0, failed: 0, retry: 0, skipped: 0 };
    for (const [org, events] of byOrg) {
      const cred = await this.creds.resolve(org, 'meta_capi');
      for (let i = 0; i < events.length; i += BATCH) {
        const batch: typeof events = [];
        for (const e of events.slice(i, i + BATCH)) {
          const claimed = await this.prisma.metaCapiEvent.updateMany({ where: { id: e.id, status: 'queued' }, data: { status: 'sending' } });
          if (claimed.count) batch.push(e);
        }
        if (!batch.length) continue;
        const done = (ids: string[], data: Prisma.MetaCapiEventUpdateManyMutationInput) => this.prisma.metaCapiEvent.updateMany({ where: { id: { in: ids } }, data });
        if (cred.source !== 'organization') {
          await done(batch.map((e) => e.id), { status: 'skipped', lastError: `Not sent: ${cred.reason ?? 'integration not enabled'}`.slice(0, 500) });
          out.skipped += batch.length;
          continue;
        }
        const stale = batch.filter((e) => now.getTime() - e.eventTime.getTime() > WINDOW_MS);
        if (stale.length) {
          await done(stale.map((e) => e.id), { status: 'skipped', lastError: 'Older than 7 days: Meta no longer accepts it' });
          out.skipped += stale.length;
        }
        const fresh = batch.filter((e) => !stale.includes(e));
        if (!fresh.length) continue;
        const customers = new Map(
          (await this.prisma.customer.findMany({ where: { id: { in: fresh.map((e) => e.customerId) } }, select: { id: true, phone: true, email: true, optedOutAt: true, doNotContact: true } })).map((c) => [c.id, c]),
        );
        // Re-checked at send time: a customer who opted out after the event was recorded is not reported.
        const sendable = fresh.filter((e) => { const c = customers.get(e.customerId); return c && !c.optedOutAt && !c.doNotContact; });
        const dropped = fresh.filter((e) => !sendable.includes(e));
        if (dropped.length) {
          await done(dropped.map((e) => e.id), { status: 'skipped', lastError: 'Customer deleted, opted out or do-not-contact' });
          out.skipped += dropped.length;
        }
        if (!sendable.length) continue;
        const ids = sendable.map((e) => e.id);
        if (process.env.DRY_RUN !== 'false') {
          await done(ids, { status: 'simulated', lastError: 'DRY_RUN is on: not sent to Meta' });
          out.simulated += ids.length;
          continue;
        }
        const testCode = cred.config.testEventCode || undefined;
        let r: Awaited<ReturnType<typeof clients.metaCapiSend>>;
        try {
          r = await clients.metaCapiSend(this.fetchImpl, cred.secrets.accessToken, cred.config.pixelId, sendable.map((e) => buildEvent(e, customers.get(e.customerId)!)), testCode);
        } catch (err) {
          r = { ok: false, latencyMs: 0, errorCode: 'network', message: describeError(err), retryable: true };
        }
        if (r.ok) {
          await done(ids, { status: 'sent', sentAt: now, fbtraceId: r.fbtraceId ?? null, testEvent: Boolean(testCode), lastError: null, attempts: { increment: 1 } });
          out.sent += ids.length;
        } else if (r.retryable) {
          // All rows of a batch share the attempt count (they were sent together).
          const attempts = Math.max(...sendable.map((e) => e.attempts)) + 1;
          if (attempts > RETRY_MINUTES.length) {
            await done(ids, { status: 'failed', attempts, lastError: `Gave up after ${attempts} attempts: ${r.message}`.slice(0, 500) });
            out.failed += ids.length;
          } else {
            await done(ids, { status: 'queued', attempts, nextAttemptAt: new Date(now.getTime() + RETRY_MINUTES[attempts - 1] * 60_000), lastError: r.message.slice(0, 500) });
            out.retry += ids.length;
          }
        } else {
          await done(ids, { status: 'failed', attempts: { increment: 1 }, lastError: r.message.slice(0, 500) });
          out.failed += ids.length;
        }
        log.info('meta_capi.batch', { organizationId: org, events: ids.length, ok: r.ok, errorCode: r.errorCode });
        await this.prisma.integrationEvent
          .create({ data: { organizationId: org, provider: 'meta_capi', kind: 'message', ok: r.ok, latencyMs: r.latencyMs, errorCode: r.errorCode ?? null, message: r.message.slice(0, 500), units: ids.length, unitType: 'events', source: 'organization' } })
          .catch(() => undefined);
      }
    }
    return out;
  }

  /** Recent events and counts for the settings page (no customer data: name only through the customer link). */
  async list(org: string, status?: string) {
    const where: Prisma.MetaCapiEventWhereInput = { organizationId: org, ...(status && (STATUSES as readonly string[]).includes(status) ? { status } : {}) };
    const [items, counts] = await Promise.all([
      this.prisma.metaCapiEvent.findMany({ where, orderBy: [{ eventTime: 'desc' }, { createdAt: 'desc' }], take: 200 }),
      this.prisma.metaCapiEvent.groupBy({ by: ['status'], where: { organizationId: org }, _count: { _all: true } }),
    ]);
    return {
      items: items.map((e) => ({ id: e.id, eventName: e.eventName, sourceType: e.sourceType, sourceId: e.sourceId, customerId: e.customerId, orderRef: e.orderRef, value: e.value?.toString() ?? null, currency: e.currency, actionSource: e.actionSource, eventTime: e.eventTime, status: e.status, attempts: e.attempts, lastError: e.lastError, testEvent: e.testEvent, sentAt: e.sentAt })),
      counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])),
    };
  }

  /** Queue a failed / skipped event again (e.g. after fixing the token). */
  async retry(org: string, id: string) {
    const r = await this.prisma.metaCapiEvent.updateMany({ where: { id, organizationId: org, status: { in: ['failed', 'skipped'] } }, data: { status: 'queued', attempts: 0, nextAttemptAt: null, lastError: null } });
    return { requeued: r.count };
  }
}
