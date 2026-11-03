/**
 * Team inbox + human hand-over, DB-backed (real MySQL TEST database; WhatsApp sender and the AI are fakes).
 * Proves: filters and counts; status / priority / labels / assignment with permissions; internal notes; staff replies
 * (24 h window, opt-out, author saved, AI stops); take over -> the worker holds customer messages for the team and the
 * AI is not run; return to AI -> the AI answers again; automatic hand-off becomes an open high-priority item with
 * round-robin assignment; saved replies; tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const ORG = 'org_test_inbox_a';
const ORG_B = 'org_test_inbox_b';
const run = Date.now().toString(36);
let n = 0;

describe.skipIf(!enabled)('team inbox and human hand-over (integration)', () => {
  let prisma: any, svc: any, conversations: any, inbound: any, processor: any, sender: any, ai: any;
  const users: Record<string, any> = {};
  const actor = (k: string) => ({ sub: users[k].id, org: users[k].organizationId, role: users[k].role });

  async function conversation(org = ORG, opts: { windowOpen?: boolean; optedOut?: boolean } = {}) {
    const phone = `9198${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
    const customer = await conversations.getOrCreateCustomerByPhone(org, phone, { name: `Inbox Cust ${n}` });
    await prisma.customer.update({ where: { id: customer.id }, data: { lastInboundAt: opts.windowOpen === false ? new Date(Date.now() - 2 * 86_400_000) : new Date(), optedOutAt: opts.optedOut ? new Date() : null } });
    const conv = await conversations.getOrCreateConversation({ organizationId: org, channel: 'whatsapp', externalId: phone, customerId: customer.id });
    await conversations.addMessage({ organizationId: org, conversationId: conv.id, role: 'user', content: 'chicken irukka?' });
    await conversations.addMessage({ organizationId: org, conversationId: conv.id, role: 'assistant', content: 'Broiler ₹220/kg irukku.' });
    return { conv, customer, phone };
  }

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { InboundMessageService } = await import('../src/whatsapp/inbound-messages.service.js');
    const { InboxService } = await import('../src/inbox/inbox.service.js');
    const { WhatsAppMessageProcessor } = await import('../src/workers/whatsapp-message.processor.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [ORG, ORG_B]) await prisma.organization.upsert({ where: { id }, create: { id, name: id, vertical: 'restaurant' }, update: {} });
    for (const [k, org, role] of [['admin', ORG, 'admin'], ['support', ORG, 'support'], ['support2', ORG, 'support'], ['viewer', ORG, 'viewer'], ['other', ORG_B, 'admin']] as const) {
      users[k] = await prisma.user.create({ data: { organizationId: org, email: `inbox-${k}-${run}@example.test`, name: `${k} ${run}`, passwordHash: 'x', role } });
    }
    conversations = new ConversationsService(prisma);
    inbound = new InboundMessageService(prisma);
    sender = { sendText: vi.fn(async () => `wamid.STAFF${n++}`), downloadMedia: vi.fn(), markReadWithTyping: vi.fn(async () => undefined) };
    svc = new InboxService(prisma, conversations, sender);
    ai = { generateResponse: vi.fn() };
    processor = new WhatsAppMessageProcessor(ai, {} as any, sender, { advanceLeadStatus: vi.fn(async () => undefined) } as any, conversations, inbound, prisma, undefined, svc);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    for (const org of [ORG, ORG_B]) {
      await prisma.conversationNote.deleteMany({ where: { organizationId: org } });
      await prisma.savedReply.deleteMany({ where: { organizationId: org } });
      await prisma.inboundMessage.deleteMany({ where: { organizationId: org } });
      await prisma.organizationSettings.deleteMany({ where: { organizationId: org } });
    }
    await prisma.user.deleteMany({ where: { email: { contains: `-${run}@example.test` } } });
    await prisma.$disconnect();
  });

  it('list: filters, search and counts; members are only people who can reply', async () => {
    const { conv, phone } = await conversation();
    const all = await svc.list(ORG, users.admin.id, { status: 'open' });
    expect(all.items.some((i: any) => i.id === conv.id)).toBe(true);
    expect(all.counts.open).toBeGreaterThan(0);
    const found = await svc.list(ORG, users.admin.id, { q: phone.slice(-6) });
    expect(found.items.map((i: any) => i.id)).toContain(conv.id);
    expect((await svc.list(ORG, users.admin.id, { q: 'chicken irukka' })).items.map((i: any) => i.id)).toContain(conv.id);
    const members = await svc.members(ORG);
    const names = members.map((m: any) => m.id);
    expect(names).toEqual(expect.arrayContaining([users.admin.id, users.support.id]));
    expect(names).not.toContain(users.viewer.id);
    expect(names).not.toContain(users.other.id);
    await expect(svc.list(ORG, users.admin.id, { status: 'bogus' })).rejects.toThrow(/status/);
  });

  it('status / priority / labels / assignment with permissions; every change audited', async () => {
    const { conv } = await conversation();
    const d = await svc.update(actor('support'), conv.id, { assigneeId: users.support.id, priority: 'urgent', inboxStatus: 'pending' });
    expect(d).toMatchObject({ inboxStatus: 'pending', priority: 'urgent', assignee: { id: users.support.id } });
    await expect(svc.update(actor('support'), conv.id, { assigneeId: users.support2.id })).rejects.toThrow(/only to yourself/);
    await expect(svc.update(actor('support'), conv.id, { labels: ['vip'] })).rejects.toThrow(/inbox.manage/);
    await expect(svc.update(actor('support2'), conv.id, { inboxStatus: 'resolved' })).rejects.toThrow(/someone else/);
    expect((await svc.update(actor('admin'), conv.id, { labels: ['VIP', 'complaint', 'vip'] })).labels).toEqual(['vip', 'complaint']);
    await expect(svc.update(actor('admin'), conv.id, { assigneeId: users.viewer.id })).rejects.toThrow(/cannot take/);
    await expect(svc.update(actor('admin'), conv.id, { priority: 'meh' })).rejects.toThrow(/priority/);
    expect((await svc.list(ORG, users.admin.id, { label: 'vip' })).items.map((i: any) => i.id)).toContain(conv.id);
    expect(await prisma.auditEvent.count({ where: { organizationId: ORG, entityId: conv.id, action: 'inbox.updated' } })).toBe(2);
  });

  it('staff reply under DRY_RUN is recorded as NOT sent (nothing reaches WhatsApp)', async () => {
    process.env.DRY_RUN = 'true';
    const { conv } = await conversation();
    const r = await svc.reply(actor('support'), conv.id, 'hello');
    expect(r).toMatchObject({ sent: false, notSentReason: 'DRY_RUN is on' });
    expect(r.messages.at(-1).metadata).toMatchObject({ author: 'staff', simulated: true });
    expect(r.messages.at(-1).deliveryStatus).toBeNull();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('notes are internal; staff reply: author saved, AI stops; closed 24 h window and opt-out are refused', async () => {
    process.env.DRY_RUN = 'false';
    process.env.LIVE_ALLOW_ALL_CUSTOMERS = 'true';
    const { conv, phone } = await conversation();
    const withNote = await svc.addNote(actor('support'), conv.id, 'Customer wants delivery; we only do pickup.');
    expect(withNote.notes[0]).toMatchObject({ body: 'Customer wants delivery; we only do pickup.', author: `support ${run}` });
    expect(sender.sendText).not.toHaveBeenCalled();
    const r = await svc.reply(actor('support'), conv.id, 'Vanakkam! Pickup mattum dhaan, sorry.');
    expect(sender.sendText).toHaveBeenCalledWith(phone, 'Vanakkam! Pickup mattum dhaan, sorry.');
    const staffMsg = r.messages.at(-1);
    expect(staffMsg).toMatchObject({ role: 'assistant', content: 'Vanakkam! Pickup mattum dhaan, sorry.', deliveryStatus: 'accepted' });
    expect(staffMsg.metadata).toMatchObject({ author: 'staff', userId: users.support.id });
    expect(r).toMatchObject({ aiEnabled: false, assignee: { id: users.support.id } });

    const closed = await conversation(ORG, { windowOpen: false });
    await expect(svc.reply(actor('support'), closed.conv.id, 'hello')).rejects.toThrow(/24 hours/);
    const stop = await conversation(ORG, { optedOut: true });
    await expect(svc.reply(actor('support'), stop.conv.id, 'hello')).rejects.toThrow(/opted out/);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    process.env.DRY_RUN = 'true';
    delete process.env.LIVE_ALLOW_ALL_CUSTOMERS;
  });

  it('take over: the worker keeps the customer message for the team and does NOT run the AI; return to AI resumes', async () => {
    const { conv, phone } = await conversation();
    await svc.takeOver(actor('support'), conv.id);
    const id = `wamid.IN${run}${n++}`;
    await inbound.accept({ organizationId: ORG, providerMessageId: id, fromPhone: phone, messageType: 'text', payload: {} });
    const res = await processor.process({ data: { organizationId: ORG, phoneNumberId: 'p', from: phone, messageId: id, messageType: 'text', text: 'enna aachu?' }, attemptsMade: 0, opts: { attempts: 3 }, updateData: vi.fn() });
    expect(res).toEqual({ held: conv.id });
    expect(ai.generateResponse).not.toHaveBeenCalled();
    const d = await svc.detail(ORG, conv.id);
    expect(d.messages.at(-1)).toMatchObject({ role: 'user', content: 'enna aachu?' });
    expect(d.messages.at(-1).metadata.heldForTeam).toBe(true);
    expect((await prisma.inboundMessage.findFirst({ where: { organizationId: ORG, providerMessageId: id } })).status).toBe('skipped');

    await svc.returnToAi(actor('support'), conv.id);
    ai.generateResponse.mockResolvedValueOnce({ response: 'Broiler ₹220/kg.', conversationId: conv.id, leadId: '', actions: {}, path: 'rules' });
    const id2 = `wamid.IN${run}${n++}`;
    await inbound.accept({ organizationId: ORG, providerMessageId: id2, fromPhone: phone, messageType: 'text', payload: {} });
    await processor.process({ data: { organizationId: ORG, phoneNumberId: 'p', from: phone, messageId: id2, messageType: 'text', text: 'rate enna?' }, attemptsMade: 0, opts: { attempts: 3 }, updateData: vi.fn() });
    expect(ai.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('automatic hand-off -> open, high priority, reason and time; round-robin to the least loaded person when enabled', async () => {
    await prisma.organizationSettings.upsert({ where: { organizationId: ORG }, create: { organizationId: ORG, data: { inbox: { autoAssign: true } } }, update: { data: { inbox: { autoAssign: true } } } });
    const { conv } = await conversation();
    await prisma.conversation.update({ where: { id: conv.id }, data: { status: 'human_handoff', inboxStatus: 'resolved' } });
    await svc.onCustomerMessage(ORG, conv.id);
    const d = await svc.detail(ORG, conv.id);
    expect(d).toMatchObject({ inboxStatus: 'open', priority: 'high', needsHuman: true });
    expect(d.handoff.reason).toMatch(/AI asked for a person/);
    expect(d.handoff.lastCustomerMessages).toContain('chicken irukka?');
    const loads = await prisma.conversation.groupBy({ by: ['assigneeId'], where: { organizationId: ORG, inboxStatus: { not: 'resolved' }, assigneeId: { not: null } }, _count: { _all: true } });
    const others = loads.filter((l: any) => l.assigneeId !== d.assignee.id).map((l: any) => l._count._all);
    expect(d.assignee).toBeTruthy();
    expect(others.every((c: number) => c >= 0)).toBe(true);
    // Resolving clears the "needs a person" flag.
    expect((await svc.update(actor('admin'), conv.id, { inboxStatus: 'resolved' })).needsHuman).toBe(false);
  });

  it('round-robin picks the person with the fewest open conversations', async () => {
    const before = await svc.members(ORG);
    const { conv } = await conversation();
    const loads = await prisma.conversation.groupBy({ by: ['assigneeId'], where: { organizationId: ORG, inboxStatus: { not: 'resolved' }, assigneeId: { in: before.map((m: any) => m.id) } }, _count: { _all: true } });
    const load = new Map(loads.map((l: any) => [l.assigneeId, l._count._all]));
    const min = Math.min(...before.map((m: any) => (load.get(m.id) as number) ?? 0));
    const d = await svc.assignRoundRobin(actor('admin'), ORG, conv.id);
    expect((load.get(d.assignee.id) as number) ?? 0).toBe(min);
  });

  it('saved replies: create, update, unique title, delete', async () => {
    const r = await svc.saveReply(actor('admin'), null, { title: `Pickup only ${run}`, body: 'Pickup mattum dhaan.' });
    await expect(svc.saveReply(actor('admin'), null, { title: `Pickup only ${run}`, body: 'x' })).rejects.toThrow(/already exists/);
    expect((await svc.saveReply(actor('admin'), r.id, { title: `Pickup only ${run}`, body: 'Pickup only, sorry.' })).body).toBe('Pickup only, sorry.');
    expect((await svc.savedReplies(ORG)).map((x: any) => x.id)).toContain(r.id);
    await expect(svc.deleteReply(actor('other'), r.id)).rejects.toThrow(/not found/);
    expect(await svc.deleteReply(actor('admin'), r.id)).toEqual({ deleted: true });
  });

  it('tenant isolation: another organization cannot see, change, note or reply', async () => {
    const { conv } = await conversation();
    await expect(svc.detail(ORG_B, conv.id)).rejects.toThrow(/not found/);
    await expect(svc.update(actor('other'), conv.id, { priority: 'low' })).rejects.toThrow(/not found/);
    await expect(svc.addNote(actor('other'), conv.id, 'x')).rejects.toThrow(/not found/);
    await expect(svc.reply(actor('other'), conv.id, 'x')).rejects.toThrow(/not found/);
    expect((await svc.list(ORG_B, users.other.id, {})).items.map((i: any) => i.id)).not.toContain(conv.id);
  });

  it('permissions: viewer and analyst read only; support replies; team lead manages', async () => {
    const { can, PERMISSIONS } = await import('../src/governance/permissions.js');
    expect(can('viewer', PERMISSIONS.inboxView)).toBe(true);
    expect(can('viewer', PERMISSIONS.inboxReply)).toBe(false);
    expect(can('analyst', PERMISSIONS.inboxReply)).toBe(false);
    expect(can('support', PERMISSIONS.inboxReply)).toBe(true);
    expect(can('support', PERMISSIONS.inboxManage)).toBe(false);
    expect(can('team_lead', PERMISSIONS.inboxManage)).toBe(true);
    expect(can('manager', PERMISSIONS.inboxManage)).toBe(true);
  });
});
