/**
 * Customer records of a workspace (add / edit / search / history) and the consent-gated contact tests
 * (WhatsApp test message, test call), plus the DRY_RUN / demo guard on every outbound call.
 * Real database (TEST_DB_NAME); FAKE: the WhatsApp sender and voice service recorded, never a real provider.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const A = 'org_cust_a';
const B = 'org_cust_b';
const DEMO = 'org_cust_demo';
const ME = { sub: 'user_cust_test', role: 'admin' };

describe.skipIf(!enabled)('customers (integration)', () => {
  let prisma: any, svc: any, conversations: any, perms: any, config: any;
  const sender = { sendText: vi.fn(async () => 'wamid.TEST1'), sendTemplate: vi.fn(async () => 'wamid.TEMPLATE1'), templateConfigured: vi.fn(() => false), templateFor: vi.fn(() => '') };
  const voice = { startOutboundCall: vi.fn(async () => ({ started: true, callId: 'call_test_1' })) };
  const saved = { dry: process.env.DRY_RUN, rcpt: process.env.LIVE_TEST_RECIPIENTS };

  async function wipe() {
    const where = { organizationId: { in: [A, B, DEMO] } };
    await prisma.auditEvent.deleteMany({ where });
    await prisma.message.deleteMany({ where });
    await prisma.conversation.deleteMany({ where });
    await prisma.call.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
  }

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    perms = await import('../src/governance/permissions.js');
    config = (await import('../src/common/config.js')).config;
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { CustomersService } = await import('../src/customers/customers.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, isDemo] of [[A, false], [B, false], [DEMO, true]] as const) await prisma.organization.upsert({ where: { id }, update: { isDemo }, create: { id, name: id, vertical: 'real_estate', isDemo } });
    await wipe();
    svc = new CustomersService(prisma, sender as never, voice as never);
    conversations = new ConversationsService(prisma);
    // Pretend the providers are configured so the live gate (not missing configuration) decides.
    config.whatsapp.accessToken ||= 'test-token';
    config.whatsapp.phoneNumberId ||= 'test-phone-id';
    config.plivo.fromNumber ||= '910000000099';
  }, 60_000);

  afterAll(async () => {
    process.env.DRY_RUN = saved.dry;
    if (saved.rcpt === undefined) delete process.env.LIVE_TEST_RECIPIENTS; else process.env.LIVE_TEST_RECIPIENTS = saved.rcpt;
    if (!prisma) return;
    await wipe();
    await prisma.$disconnect();
  });

  it('add a customer: validated, normalised, stored in the right workspace with an audit entry; duplicates are refused', async () => {
    await expect(svc.create(A, ME, { name: 'R', phone: '123' })).rejects.toMatchObject({ response: { errors: { name: expect.any(String), phone: expect.any(String) } } });
    await expect(svc.create(A, ME, { name: 'Ravi', phone: '9876543210', messagingConsent: true })).rejects.toMatchObject({ response: { errors: { consentSource: expect.any(String) } } });
    await expect(svc.create(A, ME, { name: 'Ravi', phone: '9876543210', email: 'not-an-email' })).rejects.toMatchObject({ response: { errors: { email: expect.any(String) } } });
    const c = await svc.create(A, ME, { name: 'Ravi Kumar', phone: '98765 43210', email: 'Ravi@Example.com', language: 'tamil', tags: ['VIP', 'wholesale'], messagingConsent: true, consentSource: 'in_person' });
    expect(c).toMatchObject({ organizationId: A, phone: '919876543210', email: 'ravi@example.com', isDemo: false, source: 'manual', messagingConsent: true, callingConsent: false, tags: ['vip', 'wholesale'] });
    expect(c.contactable).toEqual({ whatsapp: true, call: false });
    await expect(svc.create(A, ME, { name: 'Someone', phone: '+91 98765-43210' })).rejects.toMatchObject({ status: 409 });
    // The same number is a different customer in another workspace.
    const other = await svc.create(B, ME, { name: 'Ravi (B)', phone: '9876543210' });
    expect(other.id).not.toBe(c.id);
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: A, entityType: 'customer', entityId: c.id, action: 'created' } });
    expect(audit.data).toMatchObject({ consentSource: 'in_person', messagingConsent: true });
  });

  it('list: search by name / phone / email, consent filters, pagination; only this workspace', async () => {
    for (let i = 0; i < 12; i++) await svc.create(A, ME, { name: `Customer ${i}`, phone: `90000000${String(i).padStart(2, '0')}`, callingConsent: i % 3 === 0, consentSource: i % 3 === 0 ? 'website_form' : undefined });
    const all = await svc.list(A, { pageSize: 5, page: 1 });
    expect(all.total).toBe(13);
    expect(all.rows).toHaveLength(5);
    expect((await svc.list(A, { pageSize: 5, page: 3 })).rows).toHaveLength(3);
    expect((await svc.list(A, { q: 'Ravi' })).rows.map((r: any) => r.name)).toEqual(['Ravi Kumar']);
    expect((await svc.list(A, { q: '43210' })).total).toBe(1);
    expect((await svc.list(A, { q: 'example.com' })).total).toBe(1);
    expect((await svc.list(A, { consent: 'calling' })).total).toBe(4);
    expect((await svc.list(A, { consent: 'messaging' })).total).toBe(1);
    expect((await svc.list(B, {})).rows.every((r: any) => r.organizationId === B)).toBe(true);
  });

  it('edit + history; another workspace cannot read or change the record; opting back in needs fresh consent', async () => {
    const c = (await svc.list(A, { q: 'Ravi' })).rows[0];
    await expect(svc.detail(B, c.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.update(B, ME, c.id, { name: 'Hacked' })).rejects.toMatchObject({ status: 404 });
    const up = await svc.update(A, ME, c.id, { name: 'Ravi K', callingConsent: true, consentSource: 'phone_call' });
    expect(up).toMatchObject({ name: 'Ravi K', callingConsent: true });
    await expect(svc.update(A, ME, c.id, { phone: '9000000001' })).rejects.toMatchObject({ status: 409 });
    const out = await svc.update(A, ME, c.id, { optedOut: true });
    expect(out.optedOutAt).toBeTruthy();
    expect(out).toMatchObject({ messagingConsent: false, callingConsent: false });
    await expect(svc.update(A, ME, c.id, { optedOut: false })).rejects.toMatchObject({ status: 400 });
    const back = await svc.update(A, ME, c.id, { optedOut: false, messagingConsent: true, consentSource: 'customer_message' });
    expect(back.optedOutAt).toBeNull();
    const d = await svc.detail(A, c.id);
    expect(d.audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['created', 'updated']));
    expect(d.customer.id).toBe(c.id);
  });

  it('WhatsApp test: needs confirmation; blocked without consent; simulated under DRY_RUN and for unapproved numbers; real send only to an approved number, and its status follows the delivery receipt', async () => {
    const c = (await svc.list(A, { q: 'Ravi' })).rows[0];
    const noConsent = (await svc.list(A, { q: 'Customer 1' })).rows.find((r: any) => r.name === 'Customer 1');
    await expect(svc.whatsappTest(A, ME, c.id, {})).rejects.toMatchObject({ status: 400 });
    expect(await svc.whatsappTest(A, ME, noConsent.id, { confirm: true })).toMatchObject({ status: 'blocked', reasons: expect.arrayContaining(['No WhatsApp consent recorded.']) });

    process.env.DRY_RUN = 'true';
    const sim = await svc.whatsappTest(A, ME, c.id, { confirm: true });
    expect(sim).toMatchObject({ status: 'simulated', reason: 'DRY_RUN is on' });
    process.env.DRY_RUN = 'false';
    delete process.env.LIVE_TEST_RECIPIENTS;
    expect(await svc.whatsappTest(A, ME, c.id, { confirm: true })).toMatchObject({ status: 'simulated', reason: expect.stringMatching(/approved test recipient/) });
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendTemplate).not.toHaveBeenCalled();

    // Approved test number, but the 24-hour window is closed and no template is configured: blocked, not sent.
    process.env.LIVE_TEST_RECIPIENTS = c.phone;
    expect(await svc.whatsappTest(A, ME, c.id, { confirm: true })).toMatchObject({ status: 'blocked' });
    // The customer messaged us recently: a short text may go out.
    await prisma.customer.update({ where: { id: c.id }, data: { lastInboundAt: new Date() } });
    const sent = await svc.whatsappTest(A, ME, c.id, { confirm: true, message: 'Hello from the test' });
    expect(sent).toMatchObject({ status: 'accepted', providerMessageId: 'wamid.TEST1' });
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect((await svc.messageStatus(A, c.id, sent.messageId)).deliveryStatus).toBe('accepted');
    await conversations.applyDeliveryStatus(A, 'wamid.TEST1', 'delivered');
    expect((await svc.messageStatus(A, c.id, sent.messageId)).deliveryStatus).toBe('delivered');
    await expect(svc.messageStatus(B, c.id, sent.messageId)).rejects.toMatchObject({ status: 404 });
    process.env.DRY_RUN = 'true';
  });

  it('a demo workspace is never live, even with DRY_RUN off and the number approved', async () => {
    sender.sendText.mockClear(); sender.sendTemplate.mockClear(); voice.startOutboundCall.mockClear();
    const d = await svc.create(DEMO, ME, { name: 'Demo Person', phone: '9100000000', messagingConsent: true, callingConsent: true, consentSource: 'other' });
    expect(d.isDemo).toBe(true);
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_RECIPIENTS = d.phone;
    await prisma.customer.update({ where: { id: d.id }, data: { lastInboundAt: new Date() } });
    expect(await svc.whatsappTest(DEMO, ME, d.id, { confirm: true })).toMatchObject({ status: 'simulated' });
    expect(await svc.testCall(DEMO, ME, d.id, { confirm: true })).toMatchObject({ status: 'not_placed' });
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(voice.startOutboundCall).not.toHaveBeenCalled();
    process.env.DRY_RUN = 'true';
  });

  it('test call: needs confirmation and calling consent; not placed under DRY_RUN; placed only for an approved number with DRY_RUN off', async () => {
    const c = (await svc.list(A, { q: 'Customer 3' })).rows.find((r: any) => r.name === 'Customer 3'); // calling consent
    const none = (await svc.list(A, { q: 'Customer 1' })).rows.find((r: any) => r.name === 'Customer 1');
    await expect(svc.testCall(A, ME, c.id, {})).rejects.toMatchObject({ status: 400 });
    expect(await svc.testCall(A, ME, none.id, { confirm: true })).toMatchObject({ status: 'blocked', reasons: expect.arrayContaining(['No calling consent recorded.']) });
    process.env.DRY_RUN = 'true';
    expect(await svc.testCall(A, ME, c.id, { confirm: true })).toMatchObject({ status: 'not_placed', reason: 'DRY_RUN is on' });
    expect(voice.startOutboundCall).not.toHaveBeenCalled();
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_RECIPIENTS = c.phone;
    expect(await svc.testCall(A, ME, c.id, { confirm: true })).toMatchObject({ status: 'started', callId: 'call_test_1' });
    expect(voice.startOutboundCall).toHaveBeenCalledWith(expect.objectContaining({ organizationId: A, customerId: c.id, ignoreCallWindow: false }));
    process.env.DRY_RUN = 'true';
  });

  it('the voice service itself never dials under DRY_RUN or a demo customer, for any business type', async () => {
    const { VoiceService } = await import('../src/voice/voice.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    const v = new VoiceService(prisma, {} as never, conversations, {} as never, { settingsFor: async () => ({}) } as never, {} as never, new TenancyService(prisma));
    const create = vi.fn(async () => ({ requestUuid: 'should-not-happen' }));
    (v as any).plivo = () => ({ calls: { create } });
    const real = (await svc.list(A, { q: 'Customer 6' })).rows.find((r: any) => r.name === 'Customer 6');
    process.env.DRY_RUN = 'true';
    expect(await v.startOutboundCall({ organizationId: A, customerId: real.id, ignoreCallWindow: true })).toMatchObject({ started: false, reason: expect.stringMatching(/DRY_RUN/) });
    const demo = (await svc.list(DEMO, {})).rows[0];
    process.env.DRY_RUN = 'false';
    expect(await v.startOutboundCall({ organizationId: DEMO, customerId: demo.id, ignoreCallWindow: true })).toMatchObject({ started: false, reason: expect.stringMatching(/demo/) });
    process.env.DRY_RUN = 'true';
    expect(create).not.toHaveBeenCalled();
    (v as any).onModuleDestroy?.();
    clearInterval((v as any).sweeper);
  });

  it('permissions: viewing, editing and live contact tests are separate', () => {
    const { can, PERMISSIONS } = perms;
    expect(can('sales', PERMISSIONS.customersManage)).toBe(true);
    expect(can('sales', PERMISSIONS.customersContact)).toBe(false);
    expect(can('manager', PERMISSIONS.customersContact)).toBe(true);
    expect(can('technician', PERMISSIONS.customersView)).toBe(false);
    expect(can('finance', PERMISSIONS.customersView)).toBe(true);
    expect(can('finance', PERMISSIONS.customersManage)).toBe(false);
  });
});
