/**
 * One customer WhatsApp message -> at most one logical reply, whatever happens around it: Meta re-delivering the
 * webhook, two workers running the same job (stall / retry), a crash or Redis timeout after sending, transient and
 * ambiguous provider failures. Real MySQL TEST database; the AI and Meta's API are fakes.
 *
 *   TEST_DB_NAME=tacksharp_test npm test -w apps/api
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const ORG = 'org_test_wa_inbound';
let n = 0;
const msgId = () => `wamid.T${Date.now()}${n++}`;

describe.skipIf(!enabled)('WhatsApp inbound: one message, one reply (integration)', () => {
  let prisma: any, inbound: any, svc: any, processor: any, conversations: any;
  let ai: any, sender: any, queue: any;

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { InboundMessageService } = await import('../src/whatsapp/inbound-messages.service.js');
    const { WhatsAppService } = await import('../src/webhooks/whatsapp.service.js');
    const { WhatsAppMessageProcessor } = await import('../src/workers/whatsapp-message.processor.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.organization.upsert({ where: { id: ORG }, create: { id: ORG, name: 'GR Chicken', vertical: 'restaurant' }, update: {} });
    inbound = new InboundMessageService(prisma);
    conversations = new ConversationsService(prisma);
    svc = new WhatsAppService(prisma, { cancelPending: vi.fn(async () => undefined) } as any, { resolve: async () => ORG } as any, { applyDeliveryStatus: vi.fn(async () => 0) } as any, conversations, inbound);
    ai = { generateResponse: vi.fn() };
    sender = { sendText: vi.fn(), downloadMedia: vi.fn() };
    processor = new WhatsAppMessageProcessor(ai, {} as any, sender, { advanceLeadStatus: vi.fn(async () => undefined) } as any, { recordReplySend: vi.fn(async () => undefined) } as any, inbound);
  });

  beforeEach(async () => {
    await prisma.inboundMessage.deleteMany({ where: { organizationId: ORG } });
    queue = { add: vi.fn(async () => undefined) };
    svc.queue = queue;
    ai.generateResponse.mockReset();
    ai.generateResponse.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30)); // a real AI turn takes time: lets concurrent jobs overlap
      return { response: 'Broiler Chicken irukku ✅ — ₹220/kg.', conversationId: 'conv_1', leadId: '', actions: {}, path: 'rules' };
    });
    sender.sendText.mockReset();
    sender.sendText.mockImplementation(async () => `wamid.OUT${n++}`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const webhook = (id: string, from = '919000000123') => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pnid' }, contacts: [{ wa_id: from, profile: { name: 'Priya' } }], messages: [{ from, id, type: 'text', text: { body: 'chicken irukka?' } }] } }] }],
  });
  const job = (id: string, attemptsMade = 0): any => ({ data: { organizationId: ORG, phoneNumberId: 'pnid', from: '919000000123', messageId: id, messageType: 'text', text: 'chicken irukka?' }, attemptsMade, opts: { attempts: 3 }, updateData: vi.fn() });

  it('one inbound message → persisted once, queued once, answered once', async () => {
    const id = msgId();
    expect(await svc.processWebhook(webhook(id))).toEqual({ success: true, queued: 1 });
    expect(queue.add).toHaveBeenCalledWith('incoming-message', expect.objectContaining({ messageId: id }), { jobId: `whatsapp-${id}` });
    await processor.process(job(id));
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    const row = await prisma.inboundMessage.findUnique({ where: { organizationId_providerMessageId: { organizationId: ORG, providerMessageId: id } } });
    expect(row).toMatchObject({ status: 'replied', replyStatus: 'accepted', attempts: 1, replyText: 'Broiler Chicken irukku ✅ — ₹220/kg.' });
    expect(row.replyStatus).not.toBe('delivered'); // only Meta's receipt can say delivered
  });

  it('the same webhook delivered 3 times (and the job run again) still gives one reply', async () => {
    const id = msgId();
    await svc.processWebhook(webhook(id));
    expect(await svc.processWebhook(webhook(id))).toEqual({ success: true, queued: 0 });
    expect(await svc.processWebhook(webhook(id))).toEqual({ success: true, queued: 0 });
    await processor.process(job(id));
    await processor.process(job(id)); // a re-delivered / re-added job
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(ai.generateResponse).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(await prisma.inboundMessage.count({ where: { organizationId: ORG, providerMessageId: id } })).toBe(1);
  });

  it('two workers processing the same job at the same moment: one AI run, one send', async () => {
    const id = msgId();
    await svc.processWebhook(webhook(id));
    // Separate processor instances = separate processes (no shared in-memory lock).
    const { WhatsAppMessageProcessor } = await import('../src/workers/whatsapp-message.processor.js');
    const other = new WhatsAppMessageProcessor(ai, {} as any, sender, { advanceLeadStatus: vi.fn() } as any, { recordReplySend: vi.fn(async () => undefined) } as any, inbound);
    const results = await Promise.all([processor.process(job(id)), other.process(job(id)), processor.process(job(id))]);
    expect(ai.generateResponse).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(results.filter((r: any) => r.skipped === 'claimed_or_done')).toHaveLength(2);
  });

  it('queue down during the webhook: answered 500, kept as "received"; Meta\'s retry queues it, still one reply', async () => {
    const id = msgId();
    queue.add.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    await expect(svc.processWebhook(webhook(id))).rejects.toThrow('ETIMEDOUT');
    expect((await prisma.inboundMessage.findFirst({ where: { providerMessageId: id } })).status).toBe('received');
    expect(await svc.processWebhook(webhook(id))).toEqual({ success: true, queued: 1 });
    await processor.process(job(id));
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('transient send failure (Meta unreachable): retried with the SAME stored reply, AI not run again, sent once', async () => {
    const { WhatsAppTransientError } = await import('../src/whatsapp/whatsapp-sender.service.js');
    const id = msgId();
    await svc.processWebhook(webhook(id));
    sender.sendText.mockRejectedValueOnce(new WhatsAppTransientError('WhatsApp API unreachable (not sent): connect ETIMEDOUT'));
    await expect(processor.process(job(id, 0))).rejects.toThrow('ETIMEDOUT');
    expect(await prisma.inboundMessage.findFirst({ where: { providerMessageId: id } })).toMatchObject({ status: 'queued', replyStatus: 'pending' });
    await processor.process(job(id, 1)); // BullMQ retry
    expect(ai.generateResponse).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledTimes(2); // first never reached Meta
    expect(await prisma.inboundMessage.findFirst({ where: { providerMessageId: id } })).toMatchObject({ status: 'replied', replyStatus: 'accepted' });
  });

  it('timeout after the request was sent: "unknown", never resent; a crash mid-send is treated the same way', async () => {
    const { WhatsAppAmbiguousSendError } = await import('../src/whatsapp/whatsapp-sender.service.js');
    const id = msgId();
    await svc.processWebhook(webhook(id));
    sender.sendText.mockRejectedValueOnce(new WhatsAppAmbiguousSendError('did not answer after the request was sent'));
    await expect(processor.process(job(id))).rejects.toThrow();
    await processor.process(job(id, 1));
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(await prisma.inboundMessage.findFirst({ where: { providerMessageId: id } })).toMatchObject({ status: 'reply_unknown', replyStatus: 'unknown' });

    // Crash (or Redis timeout) while "sending": the claim expires, the next attempt does not send again.
    const id2 = msgId();
    await svc.processWebhook(webhook(id2));
    const row = await prisma.inboundMessage.findFirst({ where: { providerMessageId: id2 } });
    await prisma.inboundMessage.update({ where: { id: row.id }, data: { status: 'processing', replyText: 'x', replyStatus: 'sending', lockedUntil: new Date(Date.now() - 1000) } });
    expect(await processor.process(job(id2, 1))).toEqual({ skipped: 'delivery_unknown' });
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('a failure after sending (CRM / Redis bookkeeping) never causes a second send', async () => {
    const id = msgId();
    await svc.processWebhook(webhook(id));
    const crm = { advanceLeadStatus: vi.fn(async () => Promise.reject(new Error('(conn:-1) pool timeout'))) };
    const { WhatsAppMessageProcessor } = await import('../src/workers/whatsapp-message.processor.js');
    const p = new WhatsAppMessageProcessor(ai, {} as any, sender, crm as any, { recordReplySend: vi.fn(async () => Promise.reject(new Error('redis down'))) } as any, inbound);
    await expect(p.process(job(id))).resolves.toBeDefined();
    await p.process(job(id, 1));
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('AI failure: nothing sent, the message is released for a bounded retry and failed on the last attempt', async () => {
    const id = msgId();
    await svc.processWebhook(webhook(id));
    ai.generateResponse.mockRejectedValue(new Error('db down'));
    await expect(processor.process(job(id, 0))).rejects.toThrow('db down');
    expect((await prisma.inboundMessage.findFirst({ where: { providerMessageId: id } })).status).toBe('queued');
    await expect(processor.process(job(id, 2))).rejects.toThrow('db down'); // third and last attempt
    expect((await prisma.inboundMessage.findFirst({ where: { providerMessageId: id } })).status).toBe('failed');
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('provider refuses (not configured / invalid number): failed, reply marked failed — never "sending" or "accepted"', async () => {
    const { WhatsAppPermanentError } = await import('../src/whatsapp/whatsapp-sender.service.js');
    const id = msgId();
    await svc.processWebhook(webhook(id));
    sender.sendText.mockRejectedValueOnce(new WhatsAppPermanentError('WhatsApp not configured: WHATSAPP_ACCESS_TOKEN missing', 0));
    await expect(processor.process(job(id))).rejects.toThrow('not configured');
    expect(await prisma.inboundMessage.findFirst({ where: { providerMessageId: id } })).toMatchObject({ status: 'failed', replyStatus: 'failed' });
    await processor.process(job(id, 1));
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('the same message id at two organizations is two messages (tenant-scoped key)', async () => {
    await prisma.organization.upsert({ where: { id: `${ORG}_b` }, create: { id: `${ORG}_b`, name: 'Other', vertical: 'restaurant' }, update: {} });
    const id = msgId();
    const a = await inbound.accept({ organizationId: ORG, providerMessageId: id, fromPhone: '91900', messageType: 'text' });
    const b = await inbound.accept({ organizationId: `${ORG}_b`, providerMessageId: id, fromPhone: '91900', messageType: 'text' });
    expect([a.outcome, b.outcome]).toEqual(['new', 'new']);
    await prisma.inboundMessage.deleteMany({ where: { organizationId: `${ORG}_b` } });
  });
});
