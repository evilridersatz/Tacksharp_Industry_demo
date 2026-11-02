/**
 * WhatsApp multimodal (voice notes, images, documents) through the REAL worker, the REAL GR Chicken ordering engine and
 * the real MySQL TEST database. Faked: Meta's media API (bytes are a real OGG/Opus file made with ffmpeg), Sarvam STT /
 * TTS and the vision model — so no provider is contacted and nothing is billed.
 * Proves: Tamil / Tanglish voice orders are answered with the database price; an image is checked against the actual
 * menu (an item the shop does not sell is never invented); payment screenshots go to staff (never "verified"); low
 * confidence asks for confirmation; bad media is refused before use; audio replies are only real Sarvam audio; media
 * metadata, transcription and status are saved on the conversation; one message = one reply.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/whatsapp-multimodal.integration.spec.ts
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
}
const ORG = 'org_test_mm_a';
let n = 0;
const msgId = () => `wamid.MM${Date.now()}${n++}`;
const phone = () => `9196${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`; // as the webhook normalises it

/** A real 3-second OGG/Opus voice note (what WhatsApp sends), made locally with ffmpeg. */
function oggVoiceNote(seconds = 3): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { maxBuffer: 10 * 1024 * 1024 });
}

describe.skipIf(!enabled)('WhatsApp multimodal: voice, image, document (integration)', () => {
  let prisma: any, inbound: any, processor: any, conversations: any, mm: any, sender: any, sarvam: any, vision: any;
  const pending: Promise<unknown>[] = [];

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { InboundMessageService } = await import('../src/whatsapp/inbound-messages.service.js');
    const { CatalogService } = await import('../src/restaurant/catalog.service.js');
    const { OrdersService } = await import('../src/restaurant/orders.service.js');
    const { OffersService } = await import('../src/restaurant/offers.service.js');
    const { OrderSessionStore } = await import('../src/restaurant/order-session.store.js');
    const { OrderingEngine } = await import('../src/restaurant/ordering-engine.service.js');
    const { FeedbackService } = await import('../src/restaurant/feedback.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    const { AiService } = await import('../src/ai/ai.service.js');
    const { WhatsAppMessageProcessor } = await import('../src/workers/whatsapp-message.processor.js');
    const { MultimodalService } = await import('../src/media/multimodal.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.organization.upsert({ where: { id: ORG }, create: { id: ORG, name: 'GR Chicken MM', vertical: 'restaurant' }, update: { vertical: 'restaurant' } });
    const cat = await prisma.menuCategory.upsert({ where: { organizationId_name: { organizationId: ORG, name: 'Chicken' } }, create: { id: `${ORG}_cat`, organizationId: ORG, name: 'Chicken' }, update: {} });
    for (const p of [
      { key: 'broiler', name: 'Broiler Chicken', price: 220, aliases: 'broiler, chicken, kozhi, கோழி, பிராய்லர்', cuts: ['Curry cut', 'Biryani cut', 'Whole'] },
      { key: 'country', name: 'Country Chicken', price: 450, aliases: 'country, nattu kozhi, naatu kozhi, நாட்டுக்கோழி', cuts: ['Curry cut', 'Whole'] },
    ]) {
      const data = { organizationId: ORG, categoryId: cat.id, name: p.name, price: p.price, aliases: p.aliases, cutOptions: p.cuts, unit: 'kg', minQty: 0.5, maxQty: 10, qtyStep: 0.25, available: true, isDemo: false };
      await prisma.menuItem.upsert({ where: { id: `${ORG}_${p.key}` }, create: { id: `${ORG}_${p.key}`, ...data }, update: data });
    }
    const shop = { organizationId: ORG, name: 'GR Chicken Shop', address: 'Test', opensAt: '00:00', closesAt: '00:00', prepMinutes: 30, minOrderValue: 0, acceptOutsideHours: false, active: true };
    await prisma.outlet.upsert({ where: { id: `${ORG}_shop` }, create: { id: `${ORG}_shop`, ...shop }, update: shop });

    conversations = new ConversationsService(prisma);
    inbound = new InboundMessageService(prisma);
    const catalog = new CatalogService(prisma);
    const orders = new OrdersService(prisma);
    const waStub = { sendText: vi.fn(async () => 'wamid.x'), sendNamedTemplate: vi.fn(async () => 'wamid.t') };
    const offers = new OffersService(prisma, conversations, waStub as any, catalog);
    const store = new OrderSessionStore();
    store.useRedis(null);
    const llmFake = { run: vi.fn(async () => ({ text: '', failed: true, aborted: false, usage: {} })) };
    const followUps = { onOrderCreated: vi.fn(async () => undefined), onStatusChanged: vi.fn(async () => undefined) };
    const engine = new OrderingEngine(prisma, conversations, catalog, orders, offers, new FeedbackService(prisma), followUps as any, store, llmFake as any);
    const reEngine = { generate: vi.fn(), background: (_k: string, w: () => Promise<unknown>) => void pending.push(w().catch(() => undefined)), settle: async () => void (await Promise.all(pending)), closeSession: async () => undefined };
    const ai = new AiService(reEngine as any, new TenancyService(prisma), engine);

    sender = {
      sendText: vi.fn(async () => `wamid.OUT${n++}`),
      downloadMedia: vi.fn(),
      uploadMedia: vi.fn(async () => 'media-up-1'),
      sendAudio: vi.fn(async () => 'wamid.AUDIO1'),
      markReadWithTyping: vi.fn(async () => undefined),
    };
    sarvam = { speechToText: vi.fn(), speechBytes: vi.fn() };
    vision = { id: 'fake-vision', analyze: vi.fn() };
    mm = new MultimodalService(sarvam, sender);
    mm.visionOverride = vision;
    processor = new WhatsAppMessageProcessor(ai, sarvam, sender, { advanceLeadStatus: vi.fn(async () => undefined) } as any, conversations, inbound, prisma, mm);
  }, 60_000);

  beforeEach(() => {
    for (const f of [sender.sendText, sender.downloadMedia, sender.uploadMedia, sender.sendAudio, sarvam.speechToText, sarvam.speechBytes, vision.analyze]) f.mockClear();
    delete process.env.WHATSAPP_VOICE_REPLIES;
  });

  afterAll(async () => {
    if (!prisma) return;
    await Promise.all(pending);
    await prisma.inboundMessage.deleteMany({ where: { organizationId: ORG } });
    await prisma.$disconnect();
  });

  /** Runs one inbound WhatsApp message through the real worker (persisted first, like the webhook does). */
  async function receive(from: string, fields: Record<string, unknown>) {
    const id = msgId();
    await inbound.accept({ organizationId: ORG, providerMessageId: id, fromPhone: from, messageType: String(fields.messageType), payload: {} });
    const job = { data: { organizationId: ORG, phoneNumberId: 'pnid', from, messageId: id, customerName: 'Priya', ...fields }, attemptsMade: 0, opts: { attempts: 3 }, updateData: vi.fn() };
    const r = await processor.process(job);
    const reply = sender.sendText.mock.calls.at(-1)?.[1] as string | undefined;
    if (process.env.MM_DEBUG) console.log('REPLY>>', JSON.stringify(reply));
    const conv = await prisma.conversation.findFirst({ where: { organizationId: ORG, channel: 'whatsapp', externalId: from }, include: { Message: { orderBy: { createdAt: 'asc' } } } });
    return { r, reply, messages: conv?.Message ?? [], id, conv };
  }
  const audioMedia = () => ({ buffer: oggVoiceNote(), mimeType: 'audio/ogg', sizeBytes: 1 });
  const image = () => ({ buffer: Buffer.alloc(2048, 7), mimeType: 'image/jpeg', sizeBytes: 2048 });

  it('Tamil voice note: OGG converted to 16 kHz WAV for Sarvam, transcribed, answered with the DATABASE price; metadata saved', async () => {
    sender.downloadMedia.mockResolvedValueOnce(audioMedia());
    sarvam.speechToText.mockResolvedValueOnce({ transcript: 'நாட்டுக்கோழி விலை என்ன', languageCode: 'ta-IN' });
    const from = phone();
    const { reply, messages } = await receive(from, { messageType: 'audio', audioId: 'media-audio-1' });
    expect(sender.downloadMedia).toHaveBeenCalledWith('media-audio-1', 'audio');
    const [bytes, filename, mime] = sarvam.speechToText.mock.calls[0];
    expect(mime).toBe('audio/wav'); // converted by ffmpeg
    expect(filename).toMatch(/^part-000\.wav$/);
    expect((bytes as Buffer).toString('ascii', 0, 4)).toBe('RIFF');
    expect(reply).toContain('450'); // Country Chicken from the database, not the model
    const user = messages.find((m: any) => m.role === 'user');
    expect(user.content).toBe('நாட்டுக்கோழி விலை என்ன');
    expect(user.metadata.media).toMatchObject({ messageType: 'voice', mimeType: 'audio/ogg', processing: 'ok', transcription: 'நாட்டுக்கோழி விலை என்ன', sttLanguage: 'ta-IN', converted: true, pieces: 1 });
    expect(user.metadata.viaVoiceNote).toBe(true);
  });

  it('Tanglish voice order, start to finish by voice: priced by the engine (2 kg broiler curry cut = ₹440) and SAVED', async () => {
    const from = phone();
    const voice = async (transcript: string) => {
      sender.downloadMedia.mockResolvedValueOnce(audioMedia());
      sarvam.speechToText.mockResolvedValueOnce({ transcript, languageCode: 'ta-IN' });
      return receive(from, { messageType: 'audio', audioId: `media-${n++}` });
    };
    const first = await voice('rendu kilo broiler curry cut venum');
    expect(first.reply).toContain('₹220'); // the menu shown comes from the database
    expect(first.reply).toMatch(/Payment/i); // items, quantity and cut were understood: the next question is payment
    await voice('cash la tharen');
    const summary = await voice('oru mani nerathula varen');
    expect(summary.reply).toMatch(/440/);
    const placed = await voice('sari confirm');
    expect(placed.reply).toMatch(/GR-[A-Z0-9]+/);
    const order = await prisma.order.findFirst({ where: { organizationId: ORG, customerPhone: from }, include: { items: true } });
    expect(order).toBeTruthy();
    expect(Number(order.total)).toBe(440);
    expect(order.items[0]).toMatchObject({ name: 'Broiler Chicken', cut: 'Curry cut' });
    expect(Number(order.items[0].quantity)).toBe(2);
    expect(placed.reply).toContain(order.orderNumber);
  });

  it('unclear speech is never acted on: the customer is asked to type; nothing reaches the engine', async () => {
    sender.downloadMedia.mockResolvedValueOnce(audioMedia());
    sarvam.speechToText.mockResolvedValueOnce({ transcript: '', languageCode: 'unknown' });
    const { reply, messages } = await receive(phone(), { messageType: 'audio', audioId: 'media-audio-3' });
    expect(reply).toMatch(/Text-la/);
    expect(messages.find((m: any) => m.role === 'user').metadata.media).toMatchObject({ messageType: 'voice', processing: 'failed', reason: 'unclear_speech' });
  });

  it('bad media is refused before use (type / size) with a polite reply; STT is never called', async () => {
    const { MediaRejectedError } = await import('../src/whatsapp/whatsapp-sender.service.js');
    sender.downloadMedia.mockRejectedValueOnce(new MediaRejectedError('unsupported_type:application/x-msdownload'));
    const { reply, messages } = await receive(phone(), { messageType: 'audio', audioId: 'media-evil' });
    expect(sarvam.speechToText).not.toHaveBeenCalled();
    expect(reply).toMatch(/kekka mudiyala/);
    expect(messages.find((m: any) => m.role === 'user').metadata.media).toMatchObject({ processing: 'rejected', reason: 'unsupported_type:application/x-msdownload' });
  });

  it('order screenshot: the items are read, checked against the actual menu and taken into the order', async () => {
    sender.downloadMedia.mockResolvedValueOnce(image());
    vision.analyze.mockResolvedValueOnce({ kind: 'order_screenshot', description: 'A chat with an order', text: '2 kg broiler curry cut', items: [{ name: 'broiler curry cut', quantity: 2, unit: 'kg' }], confidence: 0.92, provider: 'fake', model: 'fake' });
    const { reply, messages } = await receive(phone(), { messageType: 'image', imageId: 'media-img-1' });
    expect(sender.downloadMedia).toHaveBeenCalledWith('media-img-1', 'image');
    expect(vision.analyze.mock.calls[0][2].catalogue).toEqual(expect.arrayContaining(['Broiler Chicken', 'Country Chicken']));
    expect(reply).toContain('₹220');
    expect(reply).toMatch(/pay/i); // the order was understood; next question is payment
    const user = messages.find((m: any) => m.role === 'user');
    expect(user.content).toMatch(/2 kg broiler curry cut/);
    expect(user.metadata.media).toMatchObject({ messageType: 'image', processing: 'ok', vision: { kind: 'order_screenshot', confidence: 0.92 } });
  });

  it('food photo of something the shop does not sell: never invented as available or priced', async () => {
    sender.downloadMedia.mockResolvedValueOnce(image());
    vision.analyze.mockResolvedValueOnce({ kind: 'food_photo', description: 'A plate of mutton biryani', text: '', items: [{ name: 'mutton biryani' }], confidence: 0.9, provider: 'fake', model: 'fake' });
    const { reply } = await receive(phone(), { messageType: 'image', imageId: 'media-img-2', caption: 'idhu irukka?' });
    expect(reply).not.toMatch(/mutton biryani[^.]*₹|₹\s?\d+[^.]*mutton/i);
    expect(reply).not.toMatch(/mutton[^.]*(irukku|available)/i);
  });

  it('low confidence: the reading is shown back for confirmation; nothing is ordered or priced', async () => {
    sender.downloadMedia.mockResolvedValueOnce(image());
    vision.analyze.mockResolvedValueOnce({ kind: 'menu_screenshot', description: 'A blurry menu', text: '', items: [{ name: 'chicken 65' }], confidence: 0.3, provider: 'fake', model: 'fake' });
    const { reply, messages } = await receive(phone(), { messageType: 'image', imageId: 'media-img-3' });
    expect(reply).toMatch(/chicken 65/);
    expect(reply).toMatch(/sure-ah illa|not sure/);
    expect(messages.find((m: any) => m.role === 'user').metadata.media).toMatchObject({ processing: 'weak', reason: 'low_confidence' });
  });

  it('payment screenshot: handed to staff (conversation flagged), never confirmed as paid', async () => {
    sender.downloadMedia.mockResolvedValueOnce(image());
    vision.analyze.mockResolvedValueOnce({ kind: 'payment_screenshot', description: 'A UPI payment screen', text: 'Paid ₹440', items: [], confidence: 0.95, provider: 'fake', model: 'fake' });
    const { reply, conv } = await receive(phone(), { messageType: 'image', imageId: 'media-img-4' });
    expect(reply).toMatch(/team/);
    expect(reply).not.toMatch(/payment (is )?(received|confirmed)/i);
    expect(conv.status).toBe('human_handoff');
  });

  it('vision not configured: with a caption the customer\'s words still drive the reply; without, an honest message', async () => {
    const { VisionNotConfiguredError } = await import('../src/media/vision.provider.js');
    sender.downloadMedia.mockResolvedValue(image());
    vision.analyze.mockRejectedValueOnce(new VisionNotConfiguredError('no OpenAI account'));
    const a = await receive(phone(), { messageType: 'image', imageId: 'media-img-5', caption: 'broiler rate enna?' });
    expect(a.reply).toContain('220');
    vision.analyze.mockRejectedValueOnce(new VisionNotConfiguredError('no OpenAI account'));
    const b = await receive(phone(), { messageType: 'image', imageId: 'media-img-6' });
    expect(b.reply).toMatch(/text-la sollunga|type what you need/);
    sender.downloadMedia.mockReset();
  });

  it('document: acknowledged and handed to staff (extraction pending), stored with its type', async () => {
    const { reply, messages, conv } = await receive(phone(), { messageType: 'document', documentId: 'media-doc-1', mediaMime: 'application/pdf', caption: 'bill' });
    expect(reply).toMatch(/team/);
    expect(messages[0].metadata.media).toMatchObject({ messageType: 'document', mimeType: 'application/pdf' });
    expect(conv.status).toBe('human_handoff');
  });

  it('voice reply: sent only when Sarvam produced real audio; a TTS failure sends nothing extra (text already sent)', async () => {
    process.env.WHATSAPP_VOICE_REPLIES = 'true';
    sender.downloadMedia.mockResolvedValueOnce(audioMedia());
    sarvam.speechToText.mockResolvedValueOnce({ transcript: 'broiler rate enna', languageCode: 'ta-IN' });
    sarvam.speechBytes.mockResolvedValueOnce({ ok: false, error: 'sarvam_tts_429' });
    await receive(phone(), { messageType: 'audio', audioId: 'media-audio-4' });
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(sender.uploadMedia).not.toHaveBeenCalled();
    expect(sender.sendAudio).not.toHaveBeenCalled();

    sender.downloadMedia.mockResolvedValueOnce(audioMedia());
    sarvam.speechToText.mockResolvedValueOnce({ transcript: 'broiler rate enna', languageCode: 'ta-IN' });
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(400, 1)]);
    sarvam.speechBytes.mockResolvedValueOnce({ ok: true, bytes: mp3, mimeType: 'audio/mpeg', languageCode: 'ta-IN', ms: 5 });
    const from = phone();
    const { messages } = await receive(from, { messageType: 'audio', audioId: 'media-audio-5' });
    expect(sender.uploadMedia).toHaveBeenCalledWith(mp3, 'audio/mpeg', 'reply.mp3');
    expect(sender.sendAudio).toHaveBeenCalledWith(from, 'media-up-1');
    expect(messages.some((m: any) => m.role === 'assistant' && m.metadata?.media?.generated === true)).toBe(true);
  });

  it('the same media message processed twice is answered once (no second STT, no second reply)', async () => {
    sender.downloadMedia.mockResolvedValueOnce(audioMedia());
    sarvam.speechToText.mockResolvedValueOnce({ transcript: 'broiler irukka', languageCode: 'ta-IN' });
    const from = phone();
    const id = msgId();
    await inbound.accept({ organizationId: ORG, providerMessageId: id, fromPhone: from, messageType: 'audio', payload: {} });
    const job = { data: { organizationId: ORG, phoneNumberId: 'pnid', from, messageId: id, messageType: 'audio', audioId: 'media-dup' }, attemptsMade: 0, opts: { attempts: 3 }, updateData: vi.fn() };
    await processor.process(job);
    await processor.process(job);
    expect(sarvam.speechToText).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });
});
