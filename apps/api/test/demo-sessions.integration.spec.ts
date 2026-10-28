/**
 * Shared WhatsApp / Plivo number across industry demo workspaces.
 * Real database (TEST_DB_NAME); FAKE: the WhatsApp queue, provider senders and speech — no message is sent, no call
 * placed. Covers: explicit, approved-only session binding; deterministic per-message routing (never the dashboard's
 * current selection); one active session per phone; channel / hub / expiry limits; strict mode; duplicate
 * re-delivery across workspaces; delivery receipts; inbound calls; industry-correct call openings; isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const HUB = 'org_ds_hub';           // owns the shared numbers (a real workspace)
const HOTEL = 'org_ds_hotel';       // demo workspace, industry hotel
const TEXTILE = 'org_ds_textile';   // demo workspace, industry textile
const OTHER_HUB = 'org_ds_otherhub';
const TESTER = '919800011122';
const STRANGER = '919800099999';
const ADMIN = { sub: 'user_ds', role: 'admin' };
const INDUSTRY: Record<string, string> = { [HUB]: 'real_estate', [HOTEL]: 'hotel', [TEXTILE]: 'textile', [OTHER_HUB]: 'real_estate' };

describe.skipIf(!enabled)('shared-number demo sessions (integration)', () => {
  let prisma: any, svc: any, webhook: any, conversations: any, voice: any, perms: any, prompts: any;
  const queue = { add: vi.fn(async (_name: string, _data: any, _opts?: any) => undefined) };
  const saved = { rcpt: process.env.LIVE_TEST_RECIPIENTS, strict: process.env.DEMO_SHARED_NUMBER_STRICT };
  let msgN = 0;
  let savedCfg: { pn: string; from: string } | undefined;
  const wamid = () => `wamid.DS${Date.now()}${msgN++}`;
  const inbound = (from: string, id = wamid(), text = 'hello') => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID_SHARED' }, contacts: [{ wa_id: from, profile: { name: 'Tester' } }], messages: [{ from, id, type: 'text', text: { body: text }, timestamp: '1' }] } }] }],
  });

  async function wipe() {
    const where = { organizationId: { in: [HUB, HOTEL, TEXTILE, OTHER_HUB] } };
    await prisma.demoSession.deleteMany({ where });
    await prisma.auditEvent.deleteMany({ where });
    await prisma.inboundMessage.deleteMany({ where });
    await prisma.message.deleteMany({ where });
    await prisma.conversation.deleteMany({ where });
    await prisma.call.deleteMany({ where });
    await prisma.lead.deleteMany({ where });
    await prisma.followUp.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
  }

  beforeAll(async () => {
    process.env.LIVE_TEST_RECIPIENTS = TESTER;
    delete process.env.DEMO_SHARED_NUMBER_STRICT;
    perms = await import('../src/governance/permissions.js');
    prompts = await import('../src/voice/voice.prompts.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { DemoSessionsService } = await import('../src/demo-sessions/demo-sessions.service.js');
    const { WhatsAppService } = await import('../src/webhooks/whatsapp.service.js');
    const { InboundMessageService } = await import('../src/whatsapp/inbound-messages.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { LeadsService } = await import('../src/leads/leads.service.js');
    const { VoiceService } = await import('../src/voice/voice.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, isDemo] of [[HUB, false], [HOTEL, true], [TEXTILE, true], [OTHER_HUB, false]] as const) await prisma.organization.upsert({ where: { id }, update: { isDemo, vertical: 'real_estate' }, create: { id, name: id, vertical: 'real_estate', isDemo } });
    await wipe();

    const { config } = await import('../src/common/config.js');
    savedCfg = { pn: config.whatsapp.phoneNumberId, from: config.plivo.fromNumber };
    config.whatsapp.phoneNumberId = 'PNID_SHARED'; config.plivo.fromNumber = '914400000000'; // identifiers only; nothing is sent
    const tenancy = new TenancyService(prisma);
    tenancy.resolve = async () => HUB; // both shared numbers belong to HUB in this test
    const settings = { get: async (org: string) => ({ industry: INDUSTRY[org] ?? 'real_estate' }) };
    svc = new DemoSessionsService(prisma, tenancy, settings as never);
    conversations = new ConversationsService(prisma);
    webhook = new WhatsAppService(prisma, { cancelPending: vi.fn(async () => undefined) } as never, tenancy, { applyDeliveryStatus: vi.fn(async () => 0) } as never, conversations, new InboundMessageService(prisma), undefined, svc);
    webhook.queue = queue;

    const aiStub = {
      industry: async (org: string) => INDUSTRY[org] ?? null,
      voiceSessionKey: (_o: string, callId: string) => `call:${callId}`,
      openCallSession: vi.fn(async (p: { organizationId: string; callId: string; phone: string }) => {
        const customer = await prisma.customer.findFirst({ where: { organizationId: p.organizationId, phone: p.phone } });
        const c = await conversations.getOrCreateConversation({ organizationId: p.organizationId, channel: 'voice', externalId: p.phone, customerId: customer.id });
        return { key: `call:${p.callId}`, conversationId: c.id };
      }),
      likelyFirstReplies: vi.fn(() => []), background: (_k: string, w: () => Promise<unknown>) => void w().catch(() => undefined), settle: async () => undefined,
    };
    const sarvamStub = { keyterms: [], textToSpeechUrl: vi.fn(async () => 'https://example.test/a.wav'), textToSpeech: vi.fn(async () => ({ url: 'https://example.test/a.wav', ms: 1, attempts: 1, cached: false, languageCode: 'en-IN' })), languageFor: () => 'en-IN', deleteAudio: vi.fn(async () => undefined) };
    voice = new VoiceService(prisma, aiStub as never, conversations, new LeadsService(prisma), { settingsFor: async () => ({}) } as never, sarvamStub as never, tenancy, svc);
  }, 60_000);

  afterAll(async () => {
    if (saved.rcpt === undefined) delete process.env.LIVE_TEST_RECIPIENTS; else process.env.LIVE_TEST_RECIPIENTS = saved.rcpt;
    if (saved.strict === undefined) delete process.env.DEMO_SHARED_NUMBER_STRICT; else process.env.DEMO_SHARED_NUMBER_STRICT = saved.strict;
    clearInterval(voice?.sweeper);
    if (savedCfg) { const { config } = await import('../src/common/config.js'); config.whatsapp.phoneNumberId = savedCfg.pn; config.plivo.fromNumber = savedCfg.from; }
    if (!prisma) return;
    await wipe();
    await prisma.$disconnect();
    const q = await import('../src/queues/queues.js');
    await Promise.allSettled([q.followUpQueue.close(), q.whatsappQueue.close(), q.agentQueue.close(), q.marketingQueue.close()]);
    await q.closeRedisConnections?.();
  });

  it('a session needs confirmation and an approved test number; it binds a REAL tester contact in the demo workspace', async () => {
    await expect(svc.start(HOTEL, ADMIN, { phone: TESTER })).rejects.toMatchObject({ status: 400 });
    await expect(svc.start(HOTEL, ADMIN, { phone: STRANGER, confirm: true })).rejects.toMatchObject({ status: 400, response: { message: expect.stringMatching(/approved test-recipient/) } });
    const s = await svc.start(HOTEL, ADMIN, { phone: '+91 98000 11122', confirm: true, channels: ['whatsapp', 'voice'] });
    expect(s).toMatchObject({ organizationId: HOTEL, industry: 'hotel', status: 'active', channels: ['whatsapp', 'voice'], phone: expect.stringMatching(/1122$/) });
    const c = await prisma.customer.findUnique({ where: { id: s.customerId } });
    expect(c).toMatchObject({ organizationId: HOTEL, phone: TESTER, isDemo: false, source: 'demo_session', messagingConsent: true, callingConsent: true });
    expect(await prisma.auditEvent.count({ where: { organizationId: HOTEL, entityType: 'demo_session', action: 'started' } })).toBe(1);
  });

  it('WhatsApp to the shared number: the bound tester reaches the hotel workspace; anyone else reaches the owner', async () => {
    queue.add.mockClear();
    await webhook.processWebhook(inbound(TESTER));
    await webhook.processWebhook(inbound(STRANGER));
    const jobs = queue.add.mock.calls.map((c: any[]) => c[1]);
    expect(jobs.find((j: any) => j.from === TESTER)).toMatchObject({ organizationId: HOTEL, demoSessionId: expect.any(String) });
    expect(jobs.find((j: any) => j.from === STRANGER)).toMatchObject({ organizationId: HUB });
    expect(jobs.find((j: any) => j.from === STRANGER).demoSessionId).toBeUndefined();
    expect(await prisma.inboundMessage.count({ where: { organizationId: HOTEL, fromPhone: TESTER } })).toBe(1);
    expect(await prisma.inboundMessage.count({ where: { organizationId: HUB, fromPhone: TESTER } })).toBe(0);
    expect(await prisma.customer.count({ where: { organizationId: HUB, phone: TESTER } })).toBe(0); // no leak into the owner
  });

  it('switching the demo to another industry is explicit: the old session ends, earlier messages stay where they were', async () => {
    const before = await prisma.inboundMessage.count({ where: { organizationId: HOTEL } });
    const s2 = await svc.start(TEXTILE, ADMIN, { phone: TESTER, confirm: true, channels: ['whatsapp'] });
    expect(s2.replaced).toEqual([expect.objectContaining({ organizationId: HOTEL })]);
    const hotel = await svc.list(HOTEL);
    expect(hotel[0]).toMatchObject({ status: 'ended', endedReason: expect.stringMatching(/replaced/) });
    queue.add.mockClear();
    await webhook.processWebhook(inbound(TESTER));
    expect(queue.add.mock.calls[0][1]).toMatchObject({ organizationId: TEXTILE });
    expect(await prisma.inboundMessage.count({ where: { organizationId: HOTEL } })).toBe(before); // nothing moved
    expect(await prisma.demoSession.count({ where: { phone: TESTER, status: 'active' } })).toBe(1);
  });

  it('a re-delivered webhook is never answered twice, even after the binding changed', async () => {
    const id = wamid();
    queue.add.mockClear();
    await webhook.processWebhook(inbound(TESTER, id));       // → textile
    const s = (await svc.list(TEXTILE))[0];
    await svc.end(TEXTILE, ADMIN, s.id);
    await webhook.processWebhook(inbound(TESTER, id));       // Meta retry; would now route to the owner
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(await prisma.inboundMessage.count({ where: { providerMessageId: id } })).toBe(1);
  });

  it('limits: channel not in the session, another hub, or an expired session do not route', async () => {
    const s = await svc.start(HOTEL, ADMIN, { phone: TESTER, confirm: true, channels: ['whatsapp'] });
    expect(await svc.routeInbound('voice', HUB, TESTER)).toBeNull();
    expect(await svc.routeInbound('whatsapp', OTHER_HUB, TESTER)).toBeNull();
    expect(await svc.routeInbound('whatsapp', HUB, TESTER)).toMatchObject({ organizationId: HOTEL, industry: 'hotel' });
    await prisma.demoSession.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await svc.routeInbound('whatsapp', HUB, TESTER)).toBeNull();
    expect((await svc.list(HOTEL))[0]).toMatchObject({ status: 'ended', endedReason: 'expired' });
  });

  it('strict mode: a sender with no session gets no AI reply (recorded, not queued)', async () => {
    process.env.DEMO_SHARED_NUMBER_STRICT = 'true';
    queue.add.mockClear();
    const id = wamid();
    await webhook.processWebhook(inbound(STRANGER, id));
    expect(queue.add).not.toHaveBeenCalled();
    expect(await prisma.inboundMessage.findFirst({ where: { providerMessageId: id } })).toMatchObject({ organizationId: HUB, status: 'skipped' });
    delete process.env.DEMO_SHARED_NUMBER_STRICT;
  });

  it('delivery receipts for a message sent from the demo workspace update it there', async () => {
    await svc.start(HOTEL, ADMIN, { phone: TESTER, confirm: true, channels: ['whatsapp', 'voice'] });
    const cust = await prisma.customer.findFirst({ where: { organizationId: HOTEL, phone: TESTER } });
    const conv = await conversations.getOrCreateConversation({ organizationId: HOTEL, channel: 'whatsapp', externalId: TESTER, customerId: cust.id });
    const mid = wamid();
    const { randomUUID } = await import('node:crypto');
    await prisma.message.create({ data: { id: randomUUID(), organizationId: HOTEL, conversationId: conv.id, role: 'assistant', content: 'Your room is available', externalId: mid, deliveryStatus: 'accepted' } });
    await webhook.processWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID_SHARED' }, statuses: [{ id: mid, status: 'delivered', recipient_id: TESTER }] } }] }] });
    expect((await prisma.message.findFirst({ where: { externalId: mid } })).deliveryStatus).toBe('delivered');
  }, 30_000);

  it('an inbound call from the bound tester is created in the hotel workspace; others reach the owner', async () => {
    await voice.answerInbound({ From: `+${TESTER}`, To: '914400000000', CallUUID: `ds-call-${Date.now()}` });
    const call = await prisma.call.findFirst({ where: { fromNumber: TESTER }, orderBy: { createdAt: 'desc' } });
    expect(call).toMatchObject({ organizationId: HOTEL, direction: 'inbound' });
    await voice.answerInbound({ From: `+${STRANGER}`, To: '914400000000', CallUUID: `ds-call-x-${Date.now()}` });
    const other = await prisma.call.findFirst({ where: { fromNumber: STRANGER }, orderBy: { createdAt: 'desc' } });
    expect(other).toMatchObject({ organizationId: HUB });
  });

  it('call opening lines follow the workspace industry and never mention property outside real estate', () => {
    const c = { name: 'Ravi Kumar', bhk: null, propertyType: null, location: null, budget: null };
    expect(prompts.industryOpening('hotel', c, 'Marina Bay Residency')).toBe('Hello Ravi, this is the AI assistant from Marina Bay Residency, calling about your room booking enquiry. Is this a good time to talk?');
    for (const ind of ['textile', 'retail', 'manufacturing', 'agency', 'food', 'hotel', 'hospital', 'cctv']) expect(prompts.industryOpening(ind, c, 'X')).not.toMatch(/property/i);
    expect(prompts.industryOpening('real_estate', c, 'X')).toBeNull();
    expect(prompts.industryCallReason('hospital', 'Sunrise')).toMatch(/appointment/);
  });

  it('isolation and permissions: another workspace cannot see or end a session; only admins / managers start one', async () => {
    const s = (await svc.list(HOTEL)).find((x: any) => x.status === 'active');
    await expect(svc.end(TEXTILE, ADMIN, s.id)).rejects.toMatchObject({ status: 404 });
    expect((await svc.list(TEXTILE)).some((x: any) => x.id === s.id)).toBe(false);
    const { can, PERMISSIONS } = perms;
    expect(can('admin', PERMISSIONS.customersContact)).toBe(true);
    expect(can('manager', PERMISSIONS.customersContact)).toBe(true);
    expect(can('sales', PERMISSIONS.customersContact)).toBe(false);
  });

  it('status reports configuration honestly and probes nothing unless asked', async () => {
    const st = await svc.status(HOTEL, false);
    expect(st.workspace).toEqual({ organizationId: HOTEL, industry: 'hotel' });
    expect(st.approvedRecipients).toEqual([{ value: TESTER, label: expect.stringMatching(/1122$/) }]);
    expect(['not_configured', 'not_checked']).toContain(st.whatsapp.status);
    expect(['not_configured', 'not_checked']).toContain(st.voice.status);
    expect(st.mode).toBe(st.dryRun ? 'demo_simulated' : 'live');
  });
});
