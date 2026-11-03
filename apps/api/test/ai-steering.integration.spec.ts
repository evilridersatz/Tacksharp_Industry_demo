/**
 * Live AI steering, DB-backed (real MySQL TEST database; the AI engine and WhatsApp sender are fakes, the real WhatsApp
 * worker and team inbox run). Proves: review mode only where allowed (WhatsApp, not restaurant ordering, not social);
 * the AI's reply is held (nothing sent, inbound row closed, draft visible and filterable), approved as written (DRY_RUN
 * simulated) or edited and sent live (original kept), never twice, refused after opt-out, discarded; auto mode still
 * sends at once; guidance cleaned, time-limited, expired guidance ignored, never logged in the audit, injected into the
 * real-estate model brief below the facts; held / discarded drafts are not counted as answers in analytics.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activeGuidance, cleanGuidance, guidanceBlock } from '../src/inbox/steering.js';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const run = Date.now().toString(36);
const ORG = `org_steer_a_${run}`;
const REST = `org_steer_r_${run}`;
let n = 0;

describe('steering helpers', () => {
  it('cleans, limits and expires guidance; the block ranks it below facts and keeps it private', () => {
    expect(cleanGuidance('  Offer\nthe   Porur project\u0007 first ')).toBe('Offer the Porur project first');
    expect(cleanGuidance('x'.repeat(900))).toHaveLength(500);
    expect(cleanGuidance('   ')).toBeNull();
    expect(activeGuidance({ aiGuidance: 'a', aiGuidanceUntil: new Date(Date.now() - 1000) })).toBeNull();
    expect(activeGuidance({ aiGuidance: 'a', aiGuidanceUntil: null })).toBe('a');
    const b = guidanceBlock('Push the weekend site visit');
    expect(b).toContain('TEAM GUIDANCE');
    expect(b).toMatch(/VERIFIED facts above and your rules always come first/);
    expect(b).toMatch(/never mention or quote it/);
    expect(guidanceBlock(null)).toBe('');
  });
});

describe.skipIf(!enabled)('live AI steering (integration)', () => {
  let prisma: any, svc: any, conversations: any, inbound: any, processor: any, sender: any, ai: any, admin: any;
  const actor = () => ({ sub: admin.id, org: ORG, role: 'admin' });

  async function chat(org = ORG, channel = 'whatsapp') {
    const phone = `9191${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
    const customer = await conversations.getOrCreateCustomerByPhone(org, phone, { name: `Steer ${n}` });
    await prisma.customer.update({ where: { id: customer.id }, data: { lastInboundAt: new Date() } });
    const conv = await conversations.getOrCreateConversation({ organizationId: org, channel, externalId: phone, customerId: customer.id });
    return { conv, customer, phone };
  }
  async function inboundText(phone: string, text: string) {
    const id = `wamid.steer.${run}.${n++}`;
    await inbound.accept({ organizationId: ORG, providerMessageId: id, fromPhone: phone, messageType: 'text', payload: {} });
    const res = await processor.process({ data: { organizationId: ORG, phoneNumberId: 'p', from: phone, messageId: id, messageType: 'text', text }, attemptsMade: 0, opts: { attempts: 3 }, updateData: vi.fn() });
    return { id, res };
  }

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { InboundMessageService } = await import('../src/whatsapp/inbound-messages.service.js');
    const { InboxService } = await import('../src/inbox/inbox.service.js');
    const { WhatsAppMessageProcessor } = await import('../src/workers/whatsapp-message.processor.js');
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.organization.create({ data: { id: ORG, name: ORG, vertical: 'real_estate' } });
    await prisma.organization.create({ data: { id: REST, name: REST, vertical: 'restaurant' } });
    admin = await prisma.user.create({ data: { organizationId: ORG, email: `steer-${run}@example.test`, name: 'Steer Admin', passwordHash: 'x', role: 'admin' } });
    conversations = new ConversationsService(prisma);
    inbound = new InboundMessageService(prisma);
    sender = { sendText: vi.fn(async () => `wamid.OUT${n++}`), markReadWithTyping: vi.fn(async () => undefined), downloadMedia: vi.fn() };
    svc = new InboxService(prisma, conversations, sender);
    // Fake engine: records the customer message and its reply in the conversation, like the real engines do.
    ai = {
      generateResponse: vi.fn(async (input: any) => {
        const c = await conversations.getOrCreateCustomerByPhone(ORG, input.phone, {});
        const conv = await conversations.getOrCreateConversation({ organizationId: ORG, channel: 'whatsapp', externalId: input.phone, customerId: c.id });
        await conversations.addMessage({ organizationId: ORG, conversationId: conv.id, role: 'user', content: input.message });
        // Like the real-estate engine: the reply is saved in the background, AFTER the answer is returned.
        setTimeout(() => void conversations.addMessage({ organizationId: ORG, conversationId: conv.id, role: 'assistant', content: `AI answer to: ${input.message}` }), 300);
        return { response: `AI answer to: ${input.message}`, conversationId: conv.id, leadId: undefined, path: 'rules' };
      }),
    };
    processor = new WhatsAppMessageProcessor(ai, {} as any, sender, { advanceLeadStatus: vi.fn(async () => undefined) } as any, conversations, inbound, prisma, undefined, svc);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.inboundMessage.deleteMany({ where: { organizationId: ORG } });
    await prisma.user.deleteMany({ where: { email: { contains: `-${run}@example.test` } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, REST] } } });
    await prisma.$disconnect();
  });

  it('review mode is refused for restaurant ordering and for Instagram / Messenger; invalid values refused', async () => {
    const { conv } = await chat();
    await expect(svc.update(actor(), conv.id, { aiMode: 'sometimes' })).rejects.toThrow(/auto or review/);
    const ig = await chat(ORG, 'instagram');
    await expect(svc.update(actor(), ig.conv.id, { aiMode: 'review' })).rejects.toThrow(/WhatsApp/);
    const r = await chat(REST);
    await expect(svc.update({ sub: 'x', org: REST, role: 'admin' }, r.conv.id, { aiMode: 'review' })).rejects.toThrow(/restaurant ordering/);
    expect((await svc.update(actor(), conv.id, { aiMode: 'review' })).aiMode).toBe('review');
  });

  it('review: the AI reply is held (nothing sent), then approved as written (DRY_RUN) or edited and sent live; never twice', async () => {
    const { conv, phone, customer } = await chat();
    await svc.update(actor(), conv.id, { aiMode: 'review' });
    sender.sendText.mockClear();
    const { id, res } = await inboundText(phone, '2BHK under 60L?');
    expect(res).toEqual({ heldForReview: conv.id });
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(await prisma.inboundMessage.findFirst({ where: { organizationId: ORG, providerMessageId: id } })).toMatchObject({ status: 'skipped', lastError: expect.stringMatching(/held_for_review/) });
    let d = await svc.detail(ORG, conv.id);
    expect(d.pendingDrafts).toBe(1);
    const draft = d.messages.find((m: any) => m.deliveryStatus === 'held');
    expect(draft.content).toBe('AI answer to: 2BHK under 60L?');
    expect(d.messages.filter((m: any) => m.deliveryStatus === 'held')).toHaveLength(1); // only this turn's reply
    expect((await svc.list(ORG, admin.id, { ai: 'drafts' })).items.map((i: any) => i.id)).toContain(conv.id);
    expect((await svc.list(ORG, admin.id, { ai: 'review' })).items.map((i: any) => i.id)).toContain(conv.id);

    // DRY_RUN: approved as written -> recorded, not sent.
    const ok = await svc.approveDraft(actor(), conv.id, draft.id, {});
    expect(ok).toMatchObject({ sent: false, notSentReason: 'DRY_RUN is on', pendingDrafts: 0 });
    expect(sender.sendText).not.toHaveBeenCalled();
    const after = await prisma.message.findUnique({ where: { id: draft.id } });
    expect(after.metadata).toMatchObject({ review: { status: 'approved', byName: 'Steer Admin' }, simulated: true });
    await expect(svc.approveDraft(actor(), conv.id, draft.id, {})).rejects.toThrow(/No held AI reply/);

    // Live, edited.
    const prev = { dry: process.env.DRY_RUN, live: process.env.LIVE_TEST_RECIPIENTS };
    try {
      process.env.DRY_RUN = 'false';
      process.env.LIVE_TEST_RECIPIENTS = phone;
      await inboundText(phone, 'Porur options?');
      d = await svc.detail(ORG, conv.id);
      const second = d.messages.find((m: any) => m.deliveryStatus === 'held');
      const sent = await svc.approveDraft(actor(), conv.id, second.id, { text: 'Yes! 3 verified Porur homes under 60L. Shall I send details?' });
      expect(sent.sent).toBe(true);
      expect(sender.sendText).toHaveBeenCalledTimes(1);
      expect(sender.sendText).toHaveBeenCalledWith(phone, 'Yes! 3 verified Porur homes under 60L. Shall I send details?');
      const m2 = await prisma.message.findUnique({ where: { id: second.id } });
      expect(m2).toMatchObject({ content: 'Yes! 3 verified Porur homes under 60L. Shall I send details?', deliveryStatus: 'accepted', externalId: expect.stringMatching(/^wamid\.OUT/) });
      expect(m2.metadata.review).toMatchObject({ status: 'edited', originalAiText: 'AI answer to: Porur options?' });
      // Concurrent approve of one draft: one send.
      await inboundText(phone, 'price?');
      const third = (await svc.detail(ORG, conv.id)).messages.find((m: any) => m.deliveryStatus === 'held');
      sender.sendText.mockClear();
      const results = await Promise.allSettled([svc.approveDraft(actor(), conv.id, third.id, {}), svc.approveDraft(actor(), conv.id, third.id, {})]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(sender.sendText).toHaveBeenCalledTimes(1);
      // Opted out after the draft was made: approve refused, discard works.
      await inboundText(phone, 'one more');
      const fourth = (await svc.detail(ORG, conv.id)).messages.find((m: any) => m.deliveryStatus === 'held');
      await prisma.customer.update({ where: { id: customer.id }, data: { optedOutAt: new Date() } });
      await expect(svc.approveDraft(actor(), conv.id, fourth.id, {})).rejects.toThrow(/opted out/);
      expect((await svc.discardDraft(actor(), conv.id, fourth.id)).pendingDrafts).toBe(0);
      expect((await prisma.message.findUnique({ where: { id: fourth.id } })).deliveryStatus).toBe('discarded');
    } finally {
      process.env.DRY_RUN = prev.dry ?? 'true';
      if (prev.live === undefined) delete process.env.LIVE_TEST_RECIPIENTS; else process.env.LIVE_TEST_RECIPIENTS = prev.live;
    }
    const audit = (await prisma.auditEvent.findMany({ where: { organizationId: ORG, entityId: conv.id } })).map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['inbox.draft_approved', 'inbox.draft_discarded']));
  });

  it('auto mode still sends at once (unchanged)', async () => {
    const { phone } = await chat();
    const prev = { dry: process.env.DRY_RUN, live: process.env.LIVE_TEST_RECIPIENTS };
    try {
      process.env.DRY_RUN = 'false';
      process.env.LIVE_TEST_RECIPIENTS = phone;
      sender.sendText.mockClear();
      const { res } = await inboundText(phone, 'hello');
      expect(res.heldForReview).toBeUndefined();
      expect(sender.sendText).toHaveBeenCalledWith(phone, 'AI answer to: hello');
    } finally {
      process.env.DRY_RUN = prev.dry ?? 'true';
      if (prev.live === undefined) delete process.env.LIVE_TEST_RECIPIENTS; else process.env.LIVE_TEST_RECIPIENTS = prev.live;
    }
  });

  it('guidance: saved with a time limit, shown in detail, not logged, read by the real-estate engine; expired ignored; cleared', async () => {
    const { conv, phone } = await chat();
    await expect(svc.update(actor(), conv.id, { aiGuidance: '   ' })).rejects.toThrow(/Write the guidance/);
    await expect(svc.update(actor(), conv.id, { aiGuidance: 'x', aiGuidanceHours: 999 })).rejects.toThrow(/1-168 hours/);
    const d = await svc.update(actor(), conv.id, { aiGuidance: 'Customer is price sensitive: lead with the 55L Porur option', aiGuidanceHours: 24 });
    expect(d.guidance).toMatchObject({ text: 'Customer is price sensitive: lead with the 55L Porur option' });
    expect(new Date(d.guidance.until).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, entityId: conv.id, action: 'inbox.updated' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(audit.data)).not.toContain('price sensitive');
    // The real-estate engine reads it for its model brief.
    const { ConversationEngine } = await import('../src/ai/conversation-engine.service.js');
    const engine = Object.create(ConversationEngine.prototype);
    engine.prisma = prisma;
    expect(await engine.teamGuidance(ORG, 'whatsapp', phone)).toMatch(/55L Porur/);
    await prisma.conversation.update({ where: { id: conv.id }, data: { aiGuidanceUntil: new Date(Date.now() - 1000) } });
    expect(await engine.teamGuidance(ORG, 'whatsapp', phone)).toBeNull();
    expect((await svc.detail(ORG, conv.id)).guidance).toBeNull();
    expect((await svc.update(actor(), conv.id, { aiGuidance: null })).guidance).toBeNull();
  });

  it('analytics: held and discarded drafts are not counted as answers', async () => {
    const { AnalyticsService } = await import('../src/analytics/analytics.service.js');
    const a = await new AnalyticsService(prisma).advanced(ORG, 1);
    const held = await prisma.message.count({ where: { organizationId: ORG, deliveryStatus: { in: ['held', 'discarded'] } } });
    const allAi = await prisma.message.count({ where: { organizationId: ORG, role: 'assistant' } });
    expect(held).toBeGreaterThan(0);
    expect(a.answeredBy.ai + a.answeredBy.team + a.answeredBy.automatic).toBe(allAi - held);
  });
});
