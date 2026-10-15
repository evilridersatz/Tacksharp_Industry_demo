/**
 * GR Chicken follow-ups (WhatsApp + voice), DB-backed. Real MySQL test database; the WhatsApp sender, Plivo
 * dialer and Sarvam are spies that fail the test if a real provider would have been contacted.
 *
 *   TEST_DB_NAME=tacksharp_test npm test -w apps/api
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
const ORG = 'org_test_fu_a';
const ORG_B = 'org_test_fu_b';
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.GR_ORGANIZATION_ID = ORG;
  process.env.PUBLIC_BASE_URL = 'https://example.test';
  process.env.PLIVO_AUTH_ID = 'test';
  process.env.PLIVO_AUTH_TOKEN = 'test';
  process.env.PLIVO_FROM_NUMBER = '914400000000';
  process.env.VOICE_CALL_WINDOW_START = '0';
  process.env.VOICE_CALL_WINDOW_END = '24';
}

const REAL_TEST_PHONE = '919999900001';

describe.skipIf(!enabled)('GR Chicken follow-ups (integration)', () => {
  let prisma: any, fu: any, feedback: any, sender: any, ready: any, conversations: any, seedDemo: any, demoPhone: any;

  async function setupOrg(id: string) {
    await prisma.organization.upsert({ where: { id }, create: { id, name: 'GR Chicken', vertical: 'restaurant' }, update: { vertical: 'restaurant' } });
    const cat = await prisma.menuCategory.upsert({ where: { organizationId_name: { organizationId: id, name: 'Chicken' } }, create: { id: `${id}_cat`, organizationId: id, name: 'Chicken' }, update: {} });
    for (const [name, price, unit] of [['Broiler Chicken', 220, 'kg'], ['Skinless Chicken', 260, 'kg'], ['Country Chicken', 450, 'kg'], ['Boneless Chicken', 380, 'kg'], ['Chicken Wings', 240, 'kg'], ['Chicken Liver', 160, 'kg'], ['Country Eggs', 12, 'piece']] as const) {
      const rid = `${id}_${name.replace(/\s/g, '_')}`;
      const data = { organizationId: id, categoryId: cat.id, name, price, unit, cutOptions: unit === 'kg' ? ['Curry cut', 'Biryani cut', 'Fry cut', 'Whole'] : [], aliases: name.toLowerCase(), available: true };
      await prisma.menuItem.upsert({ where: { id: rid }, create: { id: rid, ...data }, update: data });
    }
    const shop = { organizationId: id, name: 'GR Chicken Shop', address: 'Test', opensAt: '00:00', closesAt: '00:00', prepMinutes: 30, active: true };
    await prisma.outlet.upsert({ where: { id: `${id}_shop` }, create: { id: `${id}_shop`, ...shop }, update: shop });
  }

  /** A collected (delivered) order for a customer. */
  async function collectedOrder(opts: { org?: string; phone: string; isDemo?: boolean; messaging?: boolean; calling?: boolean; scenario?: string; windowOpen?: boolean; language?: string }) {
    const org = opts.org ?? ORG;
    const customer = await prisma.customer.upsert({
      where: { organizationId_phone: { organizationId: org, phone: opts.phone } },
      create: { organizationId: org, phone: opts.phone, name: 'Test Kumar', isDemo: opts.isDemo ?? false, messagingConsent: opts.messaging ?? true, callingConsent: opts.calling ?? true, lastInboundAt: opts.windowOpen === false ? null : new Date() },
      update: { isDemo: opts.isDemo ?? false, messagingConsent: opts.messaging ?? true, callingConsent: opts.calling ?? true, optedOutAt: null, doNotContact: false, lastInboundAt: opts.windowOpen === false ? null : new Date() },
    });
    const n = Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, '7');
    return prisma.order.create({
      data: {
        organizationId: org, orderNumber: `GR-T${n.slice(0, 4)}9`, customerId: customer.id, outletId: `${org}_shop`, channel: 'demo', status: 'completed', pickupAt: new Date(Date.now() - 3600_000),
        subtotal: 440, discount: 0, total: 440, paymentMethod: 'cash_at_shop', paymentStatus: 'paid', idempotencyKey: `t-${Date.now()}-${n}`, customerName: 'Test Kumar', customerPhone: opts.phone,
        isDemo: opts.isDemo ?? false, demoScenario: opts.scenario ?? null, collectedAt: new Date(Date.now() - 3 * 3600_000), language: opts.language ?? 'tanglish',
        items: { create: [{ menuItemId: `${org}_Broiler_Chicken`, name: 'Broiler Chicken', cut: 'Curry cut', unit: 'kg', unitPrice: 220, quantity: 2, lineTotal: 440 }] },
      },
    });
  }

  const followUpsOf = (orderId: string) => prisma.orderFollowUp.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  const due = (orderId: string, kind: string) => prisma.orderFollowUp.findFirst({ where: { orderId, kind } });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { OrdersService } = await import('../src/restaurant/orders.service.js');
    const { ReadyNoticeService } = await import('../src/restaurant/ready-notice.service.js');
    const { FeedbackService } = await import('../src/restaurant/feedback.service.js');
    const { OrderFollowUpService } = await import('../src/restaurant/order-followup.service.js');
    ({ seedDemo, demoPhone } = await import('../scripts/seed-gr-chicken-demo.js'));
    prisma = new PrismaService();
    await prisma.$connect();
    conversations = new ConversationsService(prisma);
    const orders = new OrdersService(prisma);
    sender = { sendText: vi.fn(async () => 'wamid.real'), sendNamedTemplate: vi.fn(async () => 'wamid.real.t') };
    const sarvam = { enabled: true, textToSpeechUrl: vi.fn(async () => 'https://example.test/a.wav'), speechToText: vi.fn(async () => ({ transcript: '' })) };
    ready = new ReadyNoticeService(prisma, orders, conversations, sarvam as any, sender);
    ready.dialer = vi.fn(async () => ({ requestUuid: 'plivo-req' }));
    feedback = new FeedbackService(prisma);
    fu = new OrderFollowUpService(prisma, conversations, sender, ready, sarvam as any, feedback);
    fu.queue = { add: vi.fn(async () => undefined) };
    await setupOrg(ORG);
    await setupOrg(ORG_B);
  });

  beforeEach(async () => {
    process.env.DRY_RUN = 'true';
    delete process.env.LIVE_TEST_RECIPIENTS;
    delete process.env.LIVE_ALLOW_ALL_CUSTOMERS;
    delete process.env.FOLLOWUP_FEEDBACK_TEMPLATE;
    for (const org of [ORG, ORG_B]) {
      await prisma.orderFollowUp.deleteMany({ where: { organizationId: org } });
      await prisma.order.deleteMany({ where: { organizationId: org } });
      await prisma.call.deleteMany({ where: { organizationId: org } });
    }
    sender.sendText.mockClear();
    sender.sendNamedTemplate.mockClear();
    ready.dialer.mockClear();
    fu.queue.add.mockClear();
    fu.mockWhatsApp.sent.length = 0;
    fu.mockVoice.dialed.length = 0;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('demo seed is idempotent, marks everything demo, and never touches a real customer', async () => {
    // A real customer who happens to hold demo number #3 must be left alone.
    await prisma.customer.upsert({ where: { organizationId_phone: { organizationId: ORG, phone: demoPhone(3) } }, create: { organizationId: ORG, phone: demoPhone(3), name: 'Real Person', isDemo: false }, update: { name: 'Real Person', isDemo: false } });
    const a = await seedDemo(prisma);
    const counts = async () => ({
      customers: await prisma.customer.count({ where: { organizationId: ORG, isDemo: true } }),
      orders: await prisma.order.count({ where: { organizationId: ORG, isDemo: true } }),
      followUps: await prisma.orderFollowUp.count({ where: { organizationId: ORG, dedupeKey: { startsWith: 'demo-seed:' } } }),
    });
    const first = await counts();
    const b = await seedDemo(prisma);
    expect(await counts()).toEqual(first);
    expect(a.customers).toBe(9);
    expect(b.orders).toBe(9);
    expect(a.skipped.join()).toContain(demoPhone(3));
    expect((await prisma.customer.findFirst({ where: { organizationId: ORG, phone: demoPhone(3) } })).name).toBe('Real Person');
    // Synthetic numbers cannot be real Indian mobiles (they start with 0 after the country code).
    const phones = (await prisma.customer.findMany({ where: { organizationId: ORG, isDemo: true, source: 'demo' } })).map((c: any) => c.phone);
    expect(phones).toHaveLength(9);
    expect(phones.every((p: string) => /^9100000100\d\d$/.test(p))).toBe(true);
    expect(await prisma.order.count({ where: { organizationId: ORG, isDemo: false, id: { startsWith: 'demo_order_' } } })).toBe(0);
    await prisma.customer.deleteMany({ where: { organizationId: ORG, phone: demoPhone(3), isDemo: false } });
  });

  it('collecting an order schedules one WhatsApp feedback request and one call (scheduling twice creates nothing new)', async () => {
    const order = await collectedOrder({ phone: '919999900010' });
    await fu.onStatusChanged(ORG, order.id, 'completed');
    await fu.onStatusChanged(ORG, order.id, 'completed');
    const rows = await followUpsOf(order.id);
    expect(rows.map((r: any) => [r.kind, r.channel, r.status])).toEqual([['feedback_request', 'whatsapp', 'scheduled'], ['feedback_call', 'voice', 'scheduled']]);
    const callAt = rows[1].scheduledAt.getTime() - Date.now();
    expect(callAt).toBeGreaterThan(115 * 60_000); // default 2 hours after collection
    expect(fu.queue.add).toHaveBeenCalledTimes(2);
    expect(fu.queue.add.mock.calls[0][2].jobId).toBe(`ofu-${rows[0].id}-0`);
    expect((await prisma.order.findUnique({ where: { id: order.id } })).followUpStatus).toBe('scheduled');
  });

  it('WhatsApp payload: the feedback template text, a text body inside 24h, an approved template outside it', async () => {
    const order = await collectedOrder({ phone: '919999900011' });
    const full = await prisma.order.findUnique({ where: { id: order.id }, include: { customer: true, items: true, outlet: true } });
    expect(fu.messageText('feedback_request', full)).toBe(`Hi Test, thank you for ordering from GR Chicken! How was your order ${order.orderNumber}? Reply 1–5 to rate your experience. Reply STOP to opt out.`);

    const { row } = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'p1' });
    await fu.process(row.id);
    expect(fu.mockWhatsApp.sent[0]).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '919999900011', type: 'text', text: { body: fu.messageText('feedback_request', full), preview_url: false } });
    const done = await prisma.orderFollowUp.findUnique({ where: { id: row.id } });
    expect(done.status).toBe('sent');
    expect(done.providerMessageId).toMatch(/^dryrun-wamid-/);
    expect(done.payload.request.type).toBe('text');

    // Outside the 24h window: template with {{1}} name, {{2}} order number.
    process.env.FOLLOWUP_FEEDBACK_TEMPLATE = 'gr_feedback_v1';
    const order2 = await collectedOrder({ phone: '919999900012', windowOpen: false });
    const r2 = await fu.schedule({ organizationId: ORG, orderId: order2.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'p2' });
    await fu.process(r2.row.id);
    expect(fu.mockWhatsApp.sent[1]).toMatchObject({ type: 'template', template: { name: 'gr_feedback_v1', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Test' }, { type: 'text', text: order2.orderNumber }] }] } });
  });

  it('dry-run (the default) never calls the real WhatsApp sender or the Plivo dialer', async () => {
    const order = await collectedOrder({ phone: REAL_TEST_PHONE, scenario: 'call_happy' });
    await fu.onStatusChanged(ORG, order.id, 'completed');
    for (const r of await followUpsOf(order.id)) await fu.process(r.id, new Date(Date.now() + 3 * 3600_000));
    expect(fu.mockWhatsApp.sent).toHaveLength(1);
    expect(fu.mockVoice.dialed).toHaveLength(1);
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendNamedTemplate).not.toHaveBeenCalled();
    expect(ready.dialer).not.toHaveBeenCalled();
    // A real (non-demo) customer is never given invented feedback: the simulated call is "no answer".
    expect((await due(order.id, 'feedback_call')).status).toBe('scheduled'); // retry 1 of 2
    expect((await prisma.order.findUnique({ where: { id: order.id } })).feedbackRating).toBeNull();
  });

  it('live mode reaches only approved test numbers, and never demo customers', async () => {
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_RECIPIENTS = `+${REAL_TEST_PHONE}`;
    const approved = await collectedOrder({ phone: REAL_TEST_PHONE });
    const other = await collectedOrder({ phone: '919999900020' });
    const demo = await collectedOrder({ phone: '910000099999', isDemo: true });
    const ids: Record<string, string> = {};
    for (const [k, o] of Object.entries({ approved, other, demo })) ids[k] = (await fu.schedule({ organizationId: ORG, orderId: (o as any).id, kind: 'feedback_request', at: new Date(), dedupeKey: `live-${k}` })).row.id;
    for (const id of Object.values(ids)) await fu.process(id);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(sender.sendText.mock.calls[0][0]).toBe(REAL_TEST_PHONE);
    expect((await prisma.orderFollowUp.findUnique({ where: { id: ids.other } })).lastError).toContain('not an approved test recipient');
    expect((await prisma.orderFollowUp.findUnique({ where: { id: ids.demo } })).lastError).toContain('demo customer');
  });

  it('duplicate prevention: same dedupe key = one row; processing twice or concurrently sends once', async () => {
    const order = await collectedOrder({ phone: '919999900030' });
    const a = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'dup' });
    const b = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'dup' });
    expect(b.created).toBe(false);
    expect(b.row.id).toBe(a.row.id);
    const results = await Promise.all([fu.process(a.row.id), fu.process(a.row.id), fu.process(a.row.id)]);
    expect(results.filter((r: any) => r.status === 'sent')).toHaveLength(1);
    expect((await fu.process(a.row.id)).skipped).toBe('already processed');
    expect(fu.mockWhatsApp.sent).toHaveLength(1);
    const msgs = await prisma.message.count({ where: { organizationId: ORG, metadata: { path: '$.followUpId', equals: a.row.id } } });
    expect(msgs).toBe(1);
  });

  it('queue retry: a temporary send failure is retried with the same row, sent once, then marked failed after max attempts', async () => {
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_RECIPIENTS = REAL_TEST_PHONE;
    const order = await collectedOrder({ phone: REAL_TEST_PHONE });
    sender.sendText.mockRejectedValueOnce(new Error('WhatsApp API 503: temporarily unavailable'));
    const { row } = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'retry' });
    await expect(fu.process(row.id)).rejects.toThrow('503'); // BullMQ retries this job
    expect((await prisma.orderFollowUp.findUnique({ where: { id: row.id } })).status).toBe('retrying');
    expect((await fu.process(row.id)).status).toBe('sent');
    expect(sender.sendText).toHaveBeenCalledTimes(2);
    expect(await prisma.message.count({ where: { organizationId: ORG, metadata: { path: '$.followUpId', equals: row.id } } })).toBe(1);

    // Every attempt fails: after maxAttempts (3) the row is failed and the job stops retrying.
    sender.sendText.mockRejectedValue(new Error('WhatsApp API 500: boom'));
    const r2 = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'status_update', at: new Date(), dedupeKey: 'retry-fail', payload: { status: 'completed' } });
    await expect(fu.process(r2.row.id)).rejects.toThrow();
    await expect(fu.process(r2.row.id)).rejects.toThrow();
    expect((await fu.process(r2.row.id)).status).toBe('failed');
    const failed = await prisma.orderFollowUp.findUnique({ where: { id: r2.row.id } });
    expect(failed).toMatchObject({ status: 'failed', attempts: 3 });
    // A permanent (4xx) error is not retried.
    sender.sendText.mockRejectedValue(new Error('WhatsApp API 400: invalid recipient'));
    const r3 = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'order_confirmation', at: new Date(), dedupeKey: 'perm' });
    expect((await fu.process(r3.row.id)).status).toBe('failed');
    sender.sendText.mockReset();
    sender.sendText.mockImplementation(async () => 'wamid.real');
  });

  it('connect ETIMEDOUT to Meta (":443" in the address) is a temporary failure, not a permanent 4xx', async () => {
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_RECIPIENTS = REAL_TEST_PHONE;
    const order = await collectedOrder({ phone: REAL_TEST_PHONE });
    const { WhatsAppTransientError } = await import('../src/whatsapp/whatsapp-sender.service.js');
    sender.sendText.mockRejectedValueOnce(new WhatsAppTransientError('WhatsApp API unreachable (not sent): fetch failed <- connect ETIMEDOUT (ETIMEDOUT connect 157.240.1.1:443)'));
    const { row } = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'etimedout' });
    await expect(fu.process(row.id)).rejects.toThrow('ETIMEDOUT');
    const after = await prisma.orderFollowUp.findUnique({ where: { id: row.id } });
    expect(after.status).toBe('retrying');
    expect(after.lastError).toContain('connect ETIMEDOUT');
    expect((await fu.process(row.id)).status).toBe('sent');
  });

  it('voice eligibility: collected order, calling consent, not opted out, no feedback yet, calling hours', async () => {
    const order = await collectedOrder({ phone: '919999900040' });
    const load = () => prisma.order.findUnique({ where: { id: order.id }, include: { customer: true, items: true, outlet: true } });
    const now = new Date();
    expect(fu.callEligibility(await load(), { now })).toEqual({ ok: true });
    await prisma.customer.update({ where: { id: order.customerId }, data: { callingConsent: false } });
    expect(fu.callEligibility(await load(), { now }).reason).toContain('calling consent');
    await prisma.customer.update({ where: { id: order.customerId }, data: { callingConsent: true, optedOutAt: new Date() } });
    expect(fu.callEligibility(await load(), { now }).reason).toContain('STOP');
    await prisma.customer.update({ where: { id: order.customerId }, data: { optedOutAt: null } });
    await prisma.order.update({ where: { id: order.id }, data: { feedbackRating: 4 } });
    expect(fu.callEligibility(await load(), { now }).reason).toContain('already received');
    await prisma.order.update({ where: { id: order.id }, data: { feedbackRating: null, status: 'ready', collectedAt: null } });
    expect(fu.callEligibility(await load(), { now }).reason).toContain('not collected');
    // Outside calling hours: rescheduled to the next window, not an attempt.
    await prisma.order.update({ where: { id: order.id }, data: { status: 'completed', collectedAt: new Date() } });
    process.env.VOICE_CALL_WINDOW_START = '9';
    const { config } = await import('../src/common/config.js');
    const saved = { ...config.voice };
    config.voice.callWindowStartHour = 9;
    config.voice.callWindowEndHour = 21;
    const night = new Date('2026-10-11T23:30:00+05:30');
    const r = fu.callEligibility(await load(), { now: night });
    expect(r.ok).toBe(false);
    expect(r.reschedule.toISOString()).toBe(new Date('2026-10-12T09:00:00+05:30').toISOString());
    Object.assign(config.voice, saved);
  });

  it('no answer: retried after the configured wait, then marked no_answer; every call saved against the order', async () => {
    const order = await collectedOrder({ phone: '910000088888', isDemo: true, scenario: 'no_answer' });
    const { row } = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_call', at: new Date(), dedupeKey: 'na' });
    await fu.process(row.id);
    const afterFirst = await prisma.orderFollowUp.findUnique({ where: { id: row.id } });
    expect(afterFirst).toMatchObject({ status: 'scheduled', attempts: 1 });
    expect(afterFirst.scheduledAt.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(fu.queue.add.mock.calls.at(-1)[2].jobId).toBe(`ofu-${row.id}-1`);
    await fu.process(row.id, new Date(Date.now() + 2 * 3600_000));
    expect(await prisma.orderFollowUp.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'no_answer', attempts: 2 });
    const calls = await prisma.call.findMany({ where: { organizationId: ORG, customerId: order.customerId } });
    expect(calls.map((c: any) => c.status)).toEqual(['no_answer', 'no_answer']);
    expect(ready.dialer).not.toHaveBeenCalled();
  });

  it('complaint escalation from a call: rating 2 + complaint words -> complaint open, chat flagged for staff, audit event', async () => {
    const order = await collectedOrder({ phone: '910000077777', isDemo: true, scenario: 'call_complaint' });
    const conv = await conversations.getOrCreateConversation({ organizationId: ORG, channel: 'whatsapp', externalId: '910000077777', customerId: order.customerId });
    await prisma.order.update({ where: { id: order.id }, data: { conversationId: conv.id } });
    const { row } = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_call', at: new Date(), dedupeKey: 'cc' });
    await fu.process(row.id);
    const o = await prisma.order.findUnique({ where: { id: order.id } });
    expect(o).toMatchObject({ feedbackRating: 2, complaintStatus: 'open', feedbackChannel: 'voice' });
    expect((await prisma.conversation.findUnique({ where: { id: conv.id } })).status).toBe('human_handoff');
    expect(await prisma.orderEvent.count({ where: { orderId: order.id, type: 'complaint' } })).toBe(1);
    const done = await prisma.orderFollowUp.findUnique({ where: { id: row.id } });
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ simulated: true, rating: 2, complaint: true });
    const call = await prisma.call.findUnique({ where: { id: done.callId } });
    expect(call.summary).toContain('[SIMULATED]');
    expect(call.outcome).toBe('human_requested');
  });

  it('WhatsApp reply "2" escalates, the next message is saved as the complaint detail, and the call is not made', async () => {
    const p = '910000066666';
    const order = await collectedOrder({ phone: p, isDemo: true, scenario: 'whatsapp_complaint' });
    await fu.onStatusChanged(ORG, order.id, 'completed');
    const req = await due(order.id, 'feedback_request');
    await fu.process(req.id, new Date(Date.now() + 3600_000));
    const o = await prisma.order.findUnique({ where: { id: order.id } });
    expect(o).toMatchObject({ feedbackRating: 2, complaintStatus: 'open', complaintNote: 'Chicken fresh-ah illa, konjam smell vandhuchu' });
    expect((await prisma.orderFollowUp.findUnique({ where: { id: req.id } })).status).toBe('completed');
    const call = await due(order.id, 'feedback_call');
    expect(call.status).toBe('skipped');
    expect(call.lastError).toContain('already received');
  });

  it('STOP: consent removed, pending follow-ups cancelled, nothing sent later; START re-enables messaging only', async () => {
    const order = await collectedOrder({ phone: '919999900050' });
    await fu.onStatusChanged(ORG, order.id, 'completed');
    const r = await feedback.handleInbound(ORG, order.customerId, 'STOP');
    expect(r.kind).toBe('stop');
    expect(r.reply).toContain('START');
    const c = await prisma.customer.findUnique({ where: { id: order.customerId } });
    expect(c.optedOutAt).not.toBeNull();
    expect(c).toMatchObject({ messagingConsent: false, callingConsent: false });
    expect((await followUpsOf(order.id)).map((x: any) => x.status)).toEqual(['cancelled', 'cancelled']);
    for (const x of await followUpsOf(order.id)) expect((await fu.process(x.id)).skipped).toBe('already processed');
    expect(fu.mockWhatsApp.sent).toHaveLength(0);
    // A new follow-up after STOP is skipped, not sent.
    const { row } = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'status_update', at: new Date(), dedupeKey: 'after-stop', payload: { status: 'completed' } });
    await fu.process(row.id);
    expect(await prisma.orderFollowUp.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'skipped', lastError: 'Customer opted out (STOP)' });
    expect((await feedback.handleInbound(ORG, order.customerId, 'please stop sending me spam')) ?? null).toBeNull(); // not an exact STOP
    const s = await feedback.handleInbound(ORG, order.customerId, 'START');
    expect(s.kind).toBe('start');
    expect(await prisma.customer.findUnique({ where: { id: order.customerId } })).toMatchObject({ optedOutAt: null, messagingConsent: true, callingConsent: false });
  });

  it('no messaging consent -> skipped with the reason; happy WhatsApp rating completes the request', async () => {
    const order = await collectedOrder({ phone: '919999900060', messaging: false });
    const { row } = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'nc' });
    await fu.process(row.id);
    expect(await prisma.orderFollowUp.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'skipped', lastError: 'No messaging consent recorded for this customer' });

    const ok = await collectedOrder({ phone: '919999900061' });
    const r2 = await fu.schedule({ organizationId: ORG, orderId: ok.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'ok' });
    await fu.process(r2.row.id);
    const reply = await feedback.handleInbound(ORG, ok.customerId, '5');
    expect(reply.kind).toBe('rating');
    expect(await prisma.order.findUnique({ where: { id: ok.id } })).toMatchObject({ feedbackRating: 5, complaintStatus: null, followUpStatus: 'done' });
    expect((await prisma.orderFollowUp.findUnique({ where: { id: r2.row.id } })).status).toBe('completed');
  });

  it('tenant isolation: another organization cannot schedule, update, or answer for this tenant\'s orders', async () => {
    const order = await collectedOrder({ phone: '919999900070' });
    await expect(fu.schedule({ organizationId: ORG_B, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'x' })).rejects.toThrow('Order not found');
    const { row } = await fu.schedule({ organizationId: ORG, orderId: order.id, kind: 'feedback_request', at: new Date(), dedupeKey: 'iso' });
    await fu.process(row.id);
    const sent = await prisma.orderFollowUp.findUnique({ where: { id: row.id } });
    expect(await fu.applyDeliveryStatus(ORG_B, sent.providerMessageId, 'read')).toBe(false);
    expect((await prisma.orderFollowUp.findUnique({ where: { id: row.id } })).status).toBe('sent');
    expect(await fu.applyDeliveryStatus(ORG, sent.providerMessageId, 'delivered')).toBe(true);
    expect((await prisma.orderFollowUp.findUnique({ where: { id: row.id } })).status).toBe('delivered');
    expect(await feedback.handleInbound(ORG_B, order.customerId, '5')).toBeUndefined();
    expect((await prisma.order.findUnique({ where: { id: order.id } })).feedbackRating).toBeNull();
    expect(await prisma.orderFollowUp.count({ where: { organizationId: ORG_B } })).toBe(0);
  });

  it('demo run: always simulated through the processor, scenario plays out (call_happy -> 5/5 on a call)', async () => {
    process.env.DRY_RUN = 'false'; // even in live mode a demo run never reaches a provider
    process.env.LIVE_ALLOW_ALL_CUSTOMERS = 'true';
    const order = await collectedOrder({ phone: '910000055555', isDemo: true });
    const run = await fu.runDemo(ORG, { orderId: order.id, scenario: 'call_happy' });
    expect(fu.queue.add).toHaveBeenCalledTimes(2);
    for (const id of run.followUpIds) await fu.process(id, new Date(Date.now() + 10_000));
    const rows = await followUpsOf(order.id);
    expect(rows.every((r: any) => r.dryRun)).toBe(true);
    expect(rows.map((r: any) => [r.kind, r.status])).toEqual([['feedback_request', 'sent'], ['feedback_call', 'completed']]);
    expect(await prisma.order.findUnique({ where: { id: order.id } })).toMatchObject({ feedbackRating: 5, feedbackChannel: 'voice', complaintStatus: null });
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(ready.dialer).not.toHaveBeenCalled();
    await expect(fu.runDemo(ORG, { orderId: (await collectedOrder({ phone: '919999900080' })).id, scenario: 'call_happy' })).rejects.toThrow('only on demo orders');
  });
});
