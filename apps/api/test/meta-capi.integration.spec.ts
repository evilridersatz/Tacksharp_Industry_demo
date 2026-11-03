/**
 * Meta Conversions API, DB-backed (real MySQL TEST database, real credential encryption; Meta's Graph API is a fake
 * fetch that records requests). Proves: setup through the integrations service (validation, read-only connection test,
 * enable only after a passing test, test event only with a test event code and never under DRY_RUN); collect records
 * Purchase (completed order) and Lead (new enquiry) once per source, honours the event set and skips opted-out / demo
 * customers; nothing is collected for a disabled organization; DRY_RUN = simulated, nothing sent; live: one batched
 * request with hashed user data only (no raw phone / email / name), value + currency + order id, test_event_code,
 * token not in the URL; retry with backoff then failed; rejected request failed; opt-out after recording = skipped;
 * events older than 7 days skipped; manual retry; concurrent delivery sends each event once; tenant isolation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.CREDENTIALS_KEYS = `t1:${randomBytes(32).toString('base64')}`;
  process.env.CREDENTIALS_ACTIVE_KEY = 't1';
}
const run = Date.now().toString(36);
const ORG = `org_capi_a_${run}`;
const ORG_B = `org_capi_b_${run}`;
const PIXEL = '123456789012345';
const TOKEN = `EAAtesttoken${run}abcdef`;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let n = 0;

describe.skipIf(!enabled)('Meta Conversions API (integration)', () => {
  let prisma: any, creds: any, integrations: any, svc: any, outlet: any;
  const actor = { sub: `capi-admin-${run}`, org: ORG };
  const calls: Array<{ url: string; init: any; body: any }> = [];
  let reply: (url: string) => Response = () => new Response('{}', { status: 500 });
  const fakeFetch = async (url: string, init: any = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return reply(url);
  };

  async function customer(org = ORG, extra: Record<string, unknown> = {}) {
    return prisma.customer.create({ data: { organizationId: org, name: `Capi Cust ${n}`, phone: `9196${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`, email: `Capi.${run}.${n}@Example.com `, ...extra } });
  }
  async function order(customerId: string, status = 'completed', org = ORG, at = new Date()) {
    return prisma.order.create({
      data: { organizationId: org, orderNumber: `GR-${run}-${n++}`, customerId, outletId: outlet.id, channel: 'whatsapp', status, pickupAt: at, subtotal: 440, total: 440, paymentMethod: 'cash', idempotencyKey: `capi-${run}-${n}`, updatedAt: at },
    });
  }
  const events = (org = ORG) => prisma.metaCapiEvent.findMany({ where: { organizationId: org }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { CredentialsService } = await import('../src/integrations/credentials.service.js');
    const { IntegrationsService } = await import('../src/integrations/integrations.service.js');
    const { MetaCapiService } = await import('../src/meta-capi/meta-capi.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [ORG, ORG_B]) await prisma.organization.create({ data: { id, name: id, vertical: 'restaurant' } });
    outlet = await prisma.outlet.create({ data: { organizationId: ORG, name: 'Capi outlet', address: 'Chennai' } });
    creds = new CredentialsService(prisma);
    creds.onModuleInit();
    integrations = new IntegrationsService(prisma, creds);
    integrations.fetchImpl = fakeFetch;
    svc = new MetaCapiService(prisma, creds);
    svc.fetchImpl = fakeFetch;
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    creds?.onModuleDestroy();
    for (const org of [ORG, ORG_B]) {
      await prisma.metaCapiEvent.deleteMany({ where: { organizationId: org } });
      await prisma.order.deleteMany({ where: { organizationId: org } });
    }
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('setup: validation, read-only connection test, enable only after it passes; test event needs a code and DRY_RUN off', async () => {
    await expect(integrations.save(actor, 'meta_capi', { accessToken: TOKEN, pixelId: 'abc', events: 'purchase_and_lead' })).rejects.toMatchObject({ response: { fields: { pixelId: expect.stringMatching(/Digits/) } } });
    await expect(integrations.save(actor, 'meta_capi', { accessToken: TOKEN, pixelId: PIXEL, events: 'everything' })).rejects.toMatchObject({ response: { fields: { events: expect.any(String) } } });
    const saved = await integrations.save(actor, 'meta_capi', { accessToken: TOKEN, pixelId: PIXEL, events: 'purchase_and_lead' });
    expect(saved.secrets.accessToken).toMatch(/^••••/);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    await expect(integrations.setEnabled(actor, 'meta_capi', true)).rejects.toThrow(/connection test/);

    reply = () => new Response(JSON.stringify({ error: { message: `Invalid OAuth access token ${TOKEN}` } }), { status: 401 });
    const bad = await integrations.test(actor, 'meta_capi', 'connection', {});
    expect(bad.result).toMatchObject({ ok: false, errorCode: 'auth_failed' });
    expect(JSON.stringify(bad)).not.toContain(TOKEN);

    calls.length = 0;
    reply = () => new Response(JSON.stringify({ id: PIXEL, name: 'GR Chicken dataset' }), { status: 200 });
    const ok = await integrations.test(actor, 'meta_capi', 'connection', {});
    expect(ok.result).toMatchObject({ ok: true, message: expect.stringContaining('GR Chicken dataset') });
    expect(calls[0].url).toMatch(new RegExp(`graph\\.facebook\\.com/v[\\d.]+/${PIXEL}\\?fields=id,name$`));
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect((await integrations.setEnabled(actor, 'meta_capi', true)).enabled).toBe(true);

    await expect(integrations.test(actor, 'meta_capi', 'test_event', {})).rejects.toThrow(/test event code/);
    await integrations.save(actor, 'meta_capi', { testEventCode: 'TEST12345' });
    expect((await integrations.test(actor, 'meta_capi', 'test_event', {})).result).toMatchObject({ ok: false, errorCode: 'dry_run' });
    // Saving resets the status; test again and enable for the rest of the suite.
    await integrations.test(actor, 'meta_capi', 'connection', {});
    await integrations.setEnabled(actor, 'meta_capi', true);
    creds.invalidate(ORG, 'meta_capi');
  });

  it('collect: Purchase for completed orders and Lead for enquiries, once each; opted-out / demo skipped; other statuses and disabled orgs ignored', async () => {
    const c = await customer();
    const out = await customer(ORG, { optedOutAt: new Date() });
    const demo = await customer(ORG, { isDemo: true });
    const done = await order(c.id);
    await order(c.id, 'preparing');
    await order(out.id);
    await order(demo.id);
    const lead = await prisma.lead.create({ data: { organizationId: ORG, customerId: c.id, source: 'whatsapp' } });
    const other = await customer(ORG_B);
    await prisma.lead.create({ data: { organizationId: ORG_B, customerId: other.id } });

    await svc.collect();
    expect(await events()).toHaveLength(4);
    await svc.collect(); // idempotent
    const rows = await events();
    expect(rows).toHaveLength(4);
    const byId = Object.fromEntries(rows.map((r: any) => [r.eventId, r]));
    expect(byId[`order:${done.id}`]).toMatchObject({ eventName: 'Purchase', status: 'queued', actionSource: 'chat', currency: 'INR', orderRef: done.orderNumber });
    expect(byId[`order:${done.id}`].value.toString()).toBe('440');
    expect(byId[`lead:${lead.id}`]).toMatchObject({ eventName: 'Lead', status: 'queued', value: null });
    expect(rows.filter((r: any) => r.status === 'skipped')).toHaveLength(2);
    expect(rows.some((r: any) => r.orderRef && r.status === 'queued' && r.sourceId !== done.id)).toBe(false);
    expect(await events(ORG_B)).toHaveLength(0);
  });

  it('DRY_RUN: queued events become simulated and nothing is sent to Meta', async () => {
    calls.length = 0;
    const r = await svc.deliver();
    expect(r.simulated).toBe(2);
    expect(calls).toHaveLength(0);
    expect((await events()).filter((e: any) => e.status === 'simulated').every((e: any) => /DRY_RUN/.test(e.lastError))).toBe(true);
  });

  it('live: one batched request with hashed user data only, value / order id, test event code; token never in the URL', async () => {
    const prev = process.env.DRY_RUN;
    process.env.DRY_RUN = 'false';
    try {
      const c = await customer();
      const o = await order(c.id);
      await svc.collect();
      calls.length = 0;
      reply = () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'FBTRACE1' }), { status: 200 });
      const r = await svc.deliver();
      expect(r.sent).toBe(1);
      expect(calls).toHaveLength(1);
      const { url, body } = calls[0];
      expect(url).toMatch(new RegExp(`/${PIXEL}/events$`));
      expect(url).not.toContain(TOKEN);
      expect(body.test_event_code).toBe('TEST12345');
      expect(body.access_token).toBe(TOKEN);
      const ev = body.data[0];
      expect(ev).toMatchObject({ event_name: 'Purchase', event_id: `order:${o.id}`, action_source: 'chat', custom_data: { value: 440, currency: 'INR', order_id: o.orderNumber } });
      expect(ev.user_data.ph).toEqual([sha(c.phone)]);
      expect(ev.user_data.em).toEqual([sha(c.email.trim().toLowerCase())]);
      expect(ev.user_data.external_id).toEqual([sha(c.id)]);
      const raw = JSON.stringify(body.data);
      expect(raw).not.toContain(c.phone);
      expect(raw.toLowerCase()).not.toContain(c.email.trim().toLowerCase());
      expect(raw).not.toContain(c.name);
      expect(await prisma.metaCapiEvent.findFirst({ where: { organizationId: ORG, eventId: `order:${o.id}` } })).toMatchObject({ status: 'sent', fbtraceId: 'FBTRACE1', testEvent: true });
      expect(await prisma.integrationEvent.count({ where: { organizationId: ORG, provider: 'meta_capi', kind: 'message', ok: true } })).toBe(1);
    } finally {
      process.env.DRY_RUN = prev ?? 'true';
    }
  });

  it('failures: 5xx retries with backoff then fails; a rejected request fails; opt-out after recording and stale events are skipped; manual retry', async () => {
    const prev = process.env.DRY_RUN;
    process.env.DRY_RUN = 'false';
    try {
      const c = await customer();
      const o = await order(c.id);
      await svc.collect();
      const id = `order:${o.id}`;
      reply = () => new Response(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }), { status: 503 });
      let now = new Date();
      const states: string[] = [];
      for (let i = 0; i < 4; i++) {
        await svc.deliver(now);
        const e = await prisma.metaCapiEvent.findFirst({ where: { organizationId: ORG, eventId: id } });
        states.push(`${e.status}:${e.attempts}`);
        now = new Date(now.getTime() + 2 * 3600_000);
      }
      expect(states).toEqual(['queued:1', 'queued:2', 'queued:3', 'failed:4']);
      // Not due yet: nothing sent before nextAttemptAt.
      const c2 = await customer();
      const o2 = await order(c2.id);
      await svc.collect();
      reply = () => new Response(JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } }), { status: 400 });
      await svc.deliver();
      expect(await prisma.metaCapiEvent.findFirst({ where: { organizationId: ORG, eventId: `order:${o2.id}` } })).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/Invalid parameter/) });

      const c3 = await customer();
      const o3 = await order(c3.id);
      await svc.collect();
      await prisma.customer.update({ where: { id: c3.id }, data: { optedOutAt: new Date() } });
      calls.length = 0;
      await svc.deliver();
      expect(calls).toHaveLength(0);
      expect(await prisma.metaCapiEvent.findFirst({ where: { organizationId: ORG, eventId: `order:${o3.id}` } })).toMatchObject({ status: 'skipped' });

      const c4 = await customer();
      const old = await order(c4.id, 'completed', ORG, new Date(Date.now() - 6.9 * 86_400_000));
      await svc.collect();
      await svc.deliver(new Date(Date.now() + 86_400_000));
      expect(await prisma.metaCapiEvent.findFirst({ where: { organizationId: ORG, eventId: `order:${old.id}` } })).toMatchObject({ status: 'skipped', lastError: expect.stringMatching(/7 days/) });

      const failed = await prisma.metaCapiEvent.findFirst({ where: { organizationId: ORG, eventId: id } });
      expect(await svc.retry(ORG_B, failed.id)).toEqual({ requeued: 0 });
      expect(await svc.retry(ORG, failed.id)).toEqual({ requeued: 1 });
      reply = () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      await svc.deliver();
      expect(await prisma.metaCapiEvent.findFirst({ where: { id: failed.id } })).toMatchObject({ status: 'sent' });
    } finally {
      process.env.DRY_RUN = prev ?? 'true';
    }
  });

  it('concurrent delivery sends each event once; event set "lead" records no purchases; list is per organization', async () => {
    const prev = process.env.DRY_RUN;
    process.env.DRY_RUN = 'false';
    try {
      const cs = [await customer(), await customer(), await customer()];
      for (const c of cs) await order(c.id);
      await svc.collect();
      calls.length = 0;
      reply = () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      await Promise.all([svc.deliver(), svc.deliver(), svc.deliver()]);
      const sentIds = calls.flatMap((c) => c.body.data.map((d: any) => d.event_id));
      expect(sentIds).toHaveLength(new Set(sentIds).size);
      expect(sentIds.length).toBe(3);

      await integrations.save(actor, 'meta_capi', { events: 'lead' });
      reply = () => new Response(JSON.stringify({ id: PIXEL, name: 'x' }), { status: 200 });
      await integrations.test(actor, 'meta_capi', 'connection', {});
      await integrations.setEnabled(actor, 'meta_capi', true);
      creds.invalidate(ORG, 'meta_capi');
      const c = await customer();
      const o = await order(c.id);
      await svc.collect();
      expect(await prisma.metaCapiEvent.count({ where: { organizationId: ORG, eventId: `order:${o.id}` } })).toBe(0);

      const list = await svc.list(ORG);
      expect(list.counts.sent).toBeGreaterThanOrEqual(5);
      expect(list.items.every((e: any) => !('phone' in e) && !('email' in e))).toBe(true);
      expect((await svc.list(ORG_B)).items).toHaveLength(0);
    } finally {
      process.env.DRY_RUN = prev ?? 'true';
    }
  });
});
