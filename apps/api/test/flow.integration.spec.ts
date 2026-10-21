/**
 * DB-backed integration tests. Services are constructed directly against a real MySQL test
 * database + Redis; external APIs (Plivo, Sarvam, OpenAI, Meta) are stubbed.
 *
 *   TEST_DB_NAME=tacksharp_test npm test -w apps/api
 * Skipped automatically when TEST_DB_NAME is not set (never runs against your real DB).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
  process.env.PLIVO_AUTH_ID = 'test';
  process.env.PLIVO_AUTH_TOKEN = 'test';
  process.env.PLIVO_FROM_NUMBER = '914400000000';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'wa-phone-1';
  process.env.PUBLIC_BASE_URL = 'https://example.test';
}

const ORG = 'org_real_estate_001';
const WA_PHONE_ID = 'wa-phone-1';
let n = 0;
const uniquePhone = () => `9${String(Date.now()).slice(-6)}${String(n++).padStart(3, '0')}`;

describe.skipIf(!enabled)('Tacksharp flow (integration)', () => {
  let m: any; // loaded modules
  let store: any, engine: any, prisma: any, conversations: any, leads: any, followUps: any, ai: any, meta: any, voice: any, processor: any, whatsappWebhook: any;
  // Stand-in for AiService: generateResponse is scripted per test; the session / background helpers behave like
  // the real ones (writes queued per call, settle() waits for them) so the voice layer can be tested for real.
  const bg = new Map<string, Promise<unknown>>();
  const aiStub = {
    generateResponse: vi.fn(),
    voiceSessionKey: (_org: string, callId: string) => `call:${callId}`,
    openCallSession: vi.fn(async (p: { organizationId: string; callId: string; phone: string }) => {
      const customer = await prisma.customer.findFirst({ where: { organizationId: p.organizationId, phone: p.phone } });
      const conversation = await conversations.getOrCreateConversation({ organizationId: p.organizationId, channel: 'voice', externalId: p.phone, customerId: customer.id });
      return { key: `call:${p.callId}`, conversationId: conversation.id };
    }),
    background: (key: string, work: () => Promise<unknown>) => {
      bg.set(key, (bg.get(key) ?? Promise.resolve()).then(work).catch(() => undefined));
    },
    settle: async (key: string) => void (await bg.get(key)),
    closeSession: vi.fn(async () => undefined),
    markReplyNotHeard: vi.fn(),
    likelyFirstReplies: vi.fn(() => []),
  };
  const sarvamStub = {
    keyterms: [] as string[],
    speechToText: vi.fn(),
    textToSpeechUrl: vi.fn(async (_text: string) => 'https://example.test/voice/audio/x.wav'),
    textToSpeech: vi.fn(async (_text: string, _o?: unknown): Promise<{ url: string; ms: number; attempts: number; cached: boolean; languageCode: string; error?: string }> => ({ url: 'https://example.test/voice/audio/x.wav', ms: 1, attempts: 1, cached: false, languageCode: 'ta-IN' })),
    languageFor: () => 'ta-IN',
    deleteAudio: vi.fn(async (_files: string[]) => undefined),
  };
  const voiceStub = { startOutboundCall: vi.fn() };
  // Scripted language model for the real ConversationEngine: by default it must not be needed.
  const llmFake = { run: vi.fn(async (_args: any) => ({ text: '', failed: false, aborted: false, usage: { requests: 0 } })) };
  const whatsappStub = { sendWithinPolicy: vi.fn() };

  beforeAll(async () => {
    m = {
      ...(await import('../src/prisma/prisma.service.js')),
      ...(await import('../src/whatsapp/inbound-messages.service.js')),
      ...(await import('../src/conversations/conversations.service.js')),
      ...(await import('../src/leads/leads.service.js')),
      ...(await import('../src/follow-ups/follow-ups.service.js')),
      ...(await import('../src/properties/properties.service.js')),
      ...(await import('../src/site-visits/site-visits.service.js')),
      ...(await import('../src/ai/ai.service.js')),
      ...(await import('../src/webhooks/meta-leads/meta-leads.service.js')),
      ...(await import('../src/voice/voice.service.js')),
      ...(await import('../src/workers/follow-up.processor.js')),
      ...(await import('../src/webhooks/whatsapp.service.js')),
      ...(await import('../src/tenancy/tenancy.service.js')),
      ...(await import('../src/ai/conversation-engine.service.js')),
      ...(await import('../src/ai/session.store.js')),
    };
    prisma = new m.PrismaService();
    await prisma.$connect();
    conversations = new m.ConversationsService(prisma);
    leads = new m.LeadsService(prisma);
    followUps = new m.FollowUpsService(prisma);
    const properties = new m.PropertiesService(prisma);
    const siteVisits = new m.SiteVisitsService(prisma);
    const tenancy = new m.TenancyService(prisma);
    store = new m.SessionStore();
    store.useRedis(null); // sessions in memory only: these tests do not need Redis for them
    engine = new m.ConversationEngine(prisma, conversations, leads, properties, siteVisits, followUps, store, llmFake);
    ai = aiStub;
    meta = new m.MetaLeadsService(prisma, leads, followUps, tenancy);
    voice = new m.VoiceService(prisma, aiStub, conversations, leads, followUps, sarvamStub, tenancy);
    processor = new m.FollowUpProcessor(prisma, conversations, leads, voiceStub, whatsappStub);
    whatsappWebhook = new m.WhatsAppService(prisma, followUps, tenancy, undefined, conversations, new m.InboundMessageService(prisma));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    const { followUpQueue, whatsappQueue, closeRedisConnections } = await import('../src/queues/queues.js');
    await followUpQueue.close();
    await whatsappQueue.close();
    await closeRedisConnections();
  });

  beforeEach(() => vi.clearAllMocks());

  async function newMetaLead(phone = uniquePhone(), extra: Record<string, string> = {}) {
    const leadgenId = `lg-${phone}`;
    const fields = { full_name: 'Ravi Kumar', phone_number: `+91 ${phone}`, location: 'Porur', budget: '80 lakhs', bhk: '2', ...extra };
    const result = await meta.handleLead(leadgenId, {
      id: leadgenId,
      field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })),
    });
    return { ...result, phone: `91${phone}`, leadgenId };
  }

  // ---------------------------------------------------------------- dedup
  describe('lead deduplication', () => {
    it('same person in Meta / WhatsApp / Plivo formats is ONE customer and ONE lead', async () => {
      const p = uniquePhone();
      const a = await leads.createLead({ organizationId: ORG, phone: `+91 ${p}`, source: 'meta_lead_ads', budget: '80 lakhs' });
      const b = await leads.createLead({ organizationId: ORG, phone: `91${p}`, source: 'whatsapp' });
      const c = await conversations.getOrCreateCustomerByPhone(ORG, `0${p}`);
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.id).toBe(a.id);
      expect(c.id).toBe(a.customerId);
      const customer = await prisma.customer.findUnique({ where: { id: a.customerId } });
      expect(customer.phone).toBe(`91${p}`);
      expect(customer.source).toBe('meta_lead_ads'); // attribution not overwritten
      expect(Number(customer.budget)).toBe(8_000_000);
    });

    it('duplicate Meta webhook (same leadgen_id) does not create a second lead or sequence', async () => {
      const first = await newMetaLead();
      const again = await meta.handleLead(first.leadgenId, { id: first.leadgenId, field_data: [] });
      expect(again.duplicate).toBe(true);
      expect(await prisma.lead.count({ where: { customerId: first.customerId } })).toBe(1);
      expect(await prisma.followUp.count({ where: { leadId: first.leadId } })).toBe(4);
    });

    it('a second enquiry (new leadgen_id) from the same person does not restart the sequence', async () => {
      const first = await newMetaLead();
      const raw = first.phone.slice(2);
      await meta.handleLead(`lg-second-${raw}`, {
        id: `lg-second-${raw}`,
        field_data: [{ name: 'phone_number', values: [raw] }],
      });
      expect(await prisma.lead.count({ where: { customerId: first.customerId } })).toBe(1);
      expect(await prisma.followUp.count({ where: { customerId: first.customerId } })).toBe(4);
    });
  });

  // ---------------------------------------------------------------- follow-ups
  describe('follow-up creation and cancellation', () => {
    it('new Meta lead (speed to lead, default): WhatsApp intro at once, AI call ~1 minute later, then WhatsApp on day 3 and day 7', async () => {
      const before = Date.now();
      const lead = await newMetaLead();
      const rows = await prisma.followUp.findMany({ where: { leadId: lead.leadId }, orderBy: { scheduledAt: 'asc' } });
      expect(rows.map((r: any) => `${r.channel}:${r.message}`)).toEqual([
        'whatsapp:first_contact',
        'voice:call',
        'whatsapp:nurture_day3',
        'whatsapp:nurture_day7',
      ]);
      expect(rows.every((r: any) => r.status === 'scheduled' && r.source === 'sequence')).toBe(true);
      const callInMs = rows[1].scheduledAt.getTime() - before;
      expect(callInMs).toBeGreaterThan(55_000);
      expect(callInMs).toBeLessThan(2 * 60_000);
    });

    it('a business that turns instant call off keeps the classic WhatsApp → WhatsApp → call → WhatsApp sequence', async () => {
      const { DEFAULT_SETTINGS } = await import('../src/settings/tenant-settings.js');
      const classic = new m.FollowUpsService(prisma, { get: async () => ({ ...DEFAULT_SETTINGS, speedToLead: { instantCall: false, callDelayMinutes: 1 } }) });
      const lead = await leads.createLead({ organizationId: ORG, name: 'Classic', phone: uniquePhone(), source: 'meta_lead_ads', location: 'Porur' });
      await classic.startLeadSequence({ organizationId: ORG, leadId: lead.id, customerId: lead.customerId });
      const rows = await prisma.followUp.findMany({ where: { leadId: lead.id }, orderBy: { scheduledAt: 'asc' } });
      expect(rows.map((r: any) => `${r.channel}:${r.message}`)).toEqual(['whatsapp:first_contact', 'whatsapp:reminder', 'voice:call', 'whatsapp:final']);
    });

    it('cancelPending stops the sequence but keeps a customer-requested callback', async () => {
      const lead = await newMetaLead();
      await followUps.create({
        organizationId: ORG, leadId: lead.leadId, customerId: lead.customerId,
        channel: 'voice', action: 'callback', scheduledAt: new Date(Date.now() + 3_600_000), source: 'callback',
      });
      const cancelled = await followUps.cancelPending({
        organizationId: ORG, customerId: lead.customerId, reason: 'Customer replied on WhatsApp', sources: ['sequence', 'retry'],
      });
      expect(cancelled).toBe(4);
      const callback = await prisma.followUp.findFirst({ where: { customerId: lead.customerId, source: 'callback' } });
      expect(callback.status).toBe('scheduled');
    });

    it('processor skips when the customer replied after scheduling', async () => {
      const lead = await newMetaLead();
      await prisma.customer.update({ where: { id: lead.customerId }, data: { lastInboundAt: new Date(Date.now() + 1000) } });
      const fu = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, channel: 'voice' } });
      expect(await processor.process(fu.id)).toEqual({ skipped: 'customer_replied' });
      expect(voiceStub.startOutboundCall).not.toHaveBeenCalled();
    });

    it('processor skips do-not-contact and closed leads', async () => {
      const a = await newMetaLead();
      await prisma.customer.update({ where: { id: a.customerId }, data: { doNotContact: true } });
      const fa = await prisma.followUp.findFirst({ where: { leadId: a.leadId, channel: 'voice' } });
      expect(await processor.process(fa.id)).toEqual({ skipped: 'do_not_contact' });

      const b = await newMetaLead();
      await prisma.lead.update({ where: { id: b.leadId }, data: { status: 'human_handoff' } });
      const fb = await prisma.followUp.findFirst({ where: { leadId: b.leadId, channel: 'voice' } });
      expect(await processor.process(fb.id)).toEqual({ skipped: 'lead_human_handoff' });
    });

    it('processor places the call for the voice step when nothing has changed', async () => {
      const lead = await newMetaLead();
      voiceStub.startOutboundCall.mockResolvedValue({ started: true, callId: 'call-x' });
      const fu = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, channel: 'voice' } });
      expect(await processor.process(fu.id)).toEqual({ callId: 'call-x' });
      expect(voiceStub.startOutboundCall).toHaveBeenCalledWith(expect.objectContaining({ customerId: lead.customerId, leadId: lead.leadId }));
      expect((await prisma.followUp.findUnique({ where: { id: fu.id } })).status).toBe('completed');
    });

    it('processor never places a sequence call once a site visit is booked, or after a call already connected', async () => {
      const a = await newMetaLead();
      await prisma.lead.update({ where: { id: a.leadId }, data: { status: 'site_visit' } });
      const fa = await prisma.followUp.findFirst({ where: { leadId: a.leadId, channel: 'voice' } });
      expect(await processor.process(fa.id)).toEqual({ skipped: 'site_visit_booked' });

      const b = await newMetaLead();
      await prisma.call.create({ data: { organizationId: ORG, customerId: b.customerId, leadId: b.leadId, direction: 'outbound', status: 'completed', toNumber: b.phone, fromNumber: 'x' } });
      const fb = await prisma.followUp.findFirst({ where: { leadId: b.leadId, channel: 'voice' } });
      expect(await processor.process(fb.id)).toEqual({ skipped: 'already_spoke_on_call' });
      expect(voiceStub.startOutboundCall).not.toHaveBeenCalled();
    });

    it('processor stops automatic calls after the maximum number of attempts', async () => {
      const lead = await newMetaLead();
      const { config } = await import('../src/common/config.js');
      for (let i = 0; i < config.voice.maxCallAttempts; i++) {
        await prisma.call.create({ data: { organizationId: ORG, customerId: lead.customerId, leadId: lead.leadId, direction: 'outbound', status: 'no_answer', toNumber: lead.phone, fromNumber: 'x', createdAt: new Date(Date.now() - (i + 2) * 86_400_000) } });
      }
      const fu = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, channel: 'voice' } });
      expect(await processor.process(fu.id)).toEqual({ skipped: 'max_call_attempts' });
      expect((await prisma.followUp.findUnique({ where: { id: fu.id } })).cancellationReason).toBe('max_call_attempts');
      expect(voiceStub.startOutboundCall).not.toHaveBeenCalled();
    });

    it('processor never calls twice within the minimum gap: it reschedules instead', async () => {
      const lead = await newMetaLead();
      await prisma.call.create({ data: { organizationId: ORG, customerId: lead.customerId, leadId: lead.leadId, direction: 'outbound', status: 'no_answer', toNumber: lead.phone, fromNumber: 'x' } });
      const fu = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, channel: 'voice' } });
      const r = await processor.process(fu.id);
      expect(r.reason).toBe('recent_contact');
      expect(new Date(r.rescheduled).getTime()).toBeGreaterThan(Date.now());
      expect(voiceStub.startOutboundCall).not.toHaveBeenCalled();
    });

    it('WhatsApp step without template and closed window is skipped, not failed', async () => {
      const lead = await newMetaLead();
      const { WhatsAppWindowClosedError } = await import('../src/whatsapp/whatsapp-sender.service.js');
      whatsappStub.sendWithinPolicy.mockRejectedValue(new WhatsAppWindowClosedError());
      const fu = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: 'first_contact' } });
      expect(await processor.process(fu.id)).toEqual({ skipped: 'no_template' });
      expect((await prisma.followUp.findUnique({ where: { id: fu.id } })).status).toBe('skipped');
    });
  });

  // ---------------------------------------------------------------- agent tool effects
  describe('conversation outcomes stop / reschedule automation', () => {
    /** A live phone call for a fresh lead; the customer "says" things and the real engine decides. */
    async function callFor() {
      const lead = await newMetaLead();
      const callId = `call-${lead.leadId}`;
      await engine.openCallSession({ organizationId: ORG, callId, phone: lead.phone, leadId: lead.leadId });
      const say = async (message: string, quality: 'ok' | 'weak' = 'ok') => {
        const r = await engine.generate({
          organizationId: ORG, channel: 'voice', phone: lead.phone, message, leadId: lead.leadId, quality,
          callContext: { direction: 'outbound', callId, reason: 'test' },
        });
        await engine.settle(`call:${callId}`);
        return r;
      };
      return { lead, callId, say };
    }

    it('"vendam" / "not interested" → do-not-contact, lead not_interested, all follow-ups cancelled', async () => {
      const { lead, say } = await callFor();
      const r = await say('எனக்கு வேண்டாம், interest illa');
      expect(r.actions).toMatchObject({ notInterested: true, endCall: true, outcome: 'not_interested' });
      expect(r.path).toBe('rules');
      const customer = await prisma.customer.findUnique({ where: { id: lead.customerId } });
      expect(customer.doNotContact).toBe(true);
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('not_interested');
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, status: 'scheduled' } })).toBe(0);
    });

    it('"human agent" → open human task, lead human_handoff, automation cancelled', async () => {
      const { lead, say } = await callFor();
      const r = await say('Agent kitta pesanum, human kooda pesanum');
      expect(r.actions).toMatchObject({ handoff: true, endCall: true });
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('human_handoff');
      const task = await prisma.followUp.findFirst({ where: { customerId: lead.customerId, channel: 'human' } });
      expect(task.status).toBe('open');
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, status: 'scheduled' } })).toBe(0);
    });

    it('"call me later" with a time → sequence replaced by ONE callback call at that time', async () => {
      const { lead, say } = await callFor();
      const r = await say('please call me tomorrow at 6 pm');
      expect(r.actions.callbackAt).toBeTruthy();
      const scheduled = await prisma.followUp.findMany({ where: { customerId: lead.customerId, status: 'scheduled' } });
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ channel: 'voice', action: 'callback', source: 'callback' });
      expect(scheduled[0].scheduledAt.toISOString()).toBe(new Date(r.actions.callbackAt as string).toISOString());
      const ist = new Date(scheduled[0].scheduledAt.getTime() + 330 * 60_000);
      expect(ist.getUTCHours()).toBe(18); // 6 pm IST
      expect(scheduled[0].scheduledAt.getTime()).toBeGreaterThan(Date.now());
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('callback');
    });

    it('"call me later" without a time → human task instead of guessing', async () => {
      const { lead, say } = await callFor();
      const r = await say('later call pannunga');
      expect(r.actions.callbackAt).toBeUndefined();
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, status: 'scheduled' } })).toBe(0);
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, channel: 'human', status: 'open' } })).toBe(1);
    });

    it('memory tool normalizes Tanglish values and syncs the lead', async () => {
      const { lead, say } = await callFor();
      // The model (scripted here) saves facts through its one memory tool; the application normalizes them.
      llmFake.run.mockImplementationOnce(async (args: any) => {
        await args.context.updateCustomerMemory({ budget: 'eighty five lakhs', bhk: '3BHK', location: 'Velachery la' });
        return { text: 'Sari, noted.', failed: false, aborted: false, usage: { requests: 2 } };
      });
      const first = await say('பேசலாம்'); // the lead already has area/BHK/budget: the first turn searches by rules
      expect(first.path).toBe('rules');
      const second = await say('naan oru kathai sollanum, konjam neram irukka?'); // free-form: rules cannot answer, so the model runs
      expect(second.path).toBe('llm');
      const l = await prisma.lead.findUnique({ where: { id: lead.leadId } });
      expect(Number(l.budget)).toBe(8_500_000);
      expect(l.bhk).toBe(3);
      expect(l.location).toBe('Velachery');
    });

    it('property search only returns inventory rows', async () => {
      const properties = new m.PropertiesService(prisma);
      const r = await properties.searchForAgent({ organizationId: ORG, location: 'porur', bhk: 2, maxBudget: 8_000_000 });
      expect(r.properties.map((p: any) => p.name)).toEqual(['Green Valley Residency']);
    });
  });

  // ---------------------------------------------------------------- call identity
  describe('voice call identity', () => {
    async function makeCall(status = 'ringing', attempt = 1) {
      const lead = await newMetaLead();
      const call = await prisma.call.create({
        data: {
          organizationId: ORG, customerId: lead.customerId, leadId: lead.leadId, direction: 'outbound',
          status, toNumber: lead.phone, fromNumber: '914400000000', attempt,
        },
      });
      return { lead, call };
    }

    it('answer resolves the customer from callId and ignores Plivo From/To', async () => {
      const { lead, call } = await makeCall();
      const xml = await voice.answerOutbound(call.id, { CallUUID: 'uuid-1', From: '914400000000', To: '910000000000' });
      expect(xml).toContain(`/voice/turn?callId=${call.id}`);
      const updated = await prisma.call.findUnique({ where: { id: call.id } });
      expect(updated.providerCallId).toBe('uuid-1');
      expect(updated.status).toBe('in_progress');
      const spoken = String((sarvamStub.textToSpeechUrl.mock.calls.at(-1) as unknown[] | undefined)?.[0] ?? '');
      expect(spoken).toContain('Ravi'); // the lead's own name, not a lookup by From
      expect(spoken).toContain('Porur');
      const conv = await prisma.conversation.findFirst({ where: { customerId: lead.customerId, channel: 'voice' } });
      expect(conv.externalId).toBe(lead.phone);
    });

    it('turn: recorded audio bytes reach STT, AI runs for the CALL customer (not From)', async () => {
      const { lead, call } = await makeCall('in_progress');
      const audio = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4000, 7)]);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(audio, { status: 200 }));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Porur la 2 BHK iruka?', languageCode: 'ta-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'சரி, Porur-ல ஒரு option இருக்கு.', actions: {}, timings: {}, leadId: lead.leadId });

      const xml = await voice.handleTurn(call.id, {
        RecordUrl: 'https://media.plivo.test/rec-1.wav', RecordingDurationMs: '2300', From: '919999999999', CallUUID: 'uuid-2',
      });
      const fetchedUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
      fetchSpy.mockRestore();

      expect(fetchedUrls).toContain('https://media.plivo.test/rec-1.wav');
      expect(Buffer.compare(sarvamStub.speechToText.mock.calls[0][0], audio)).toBe(0);
      expect(aiStub.generateResponse).toHaveBeenCalledWith(
        expect.objectContaining({ phone: lead.phone, channel: 'voice', callContext: expect.objectContaining({ callId: call.id }) }),
      );
      expect(xml).toContain('<Play>');
      expect(xml).toContain('<Record');
      await aiStub.settle(`call:${call.id}`); // the Call row is updated after the audio is on its way
      const updated = await prisma.call.findUnique({ where: { id: call.id } });
      expect(updated.turns).toBe(1);
      // The language is whatever the engine established from the transcript - never the raw STT label.
      expect(updated.language).toBeNull();
    });

    it('Call.language is saved only when the engine reports an established language (a pa-IN label is ignored)', async () => {
      const { lead, call } = await makeCall('in_progress');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 1)));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Porur la 2 BHK venum', languageCode: 'pa-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'சரி.', actions: {}, timings: {}, leadId: lead.leadId, language: 'ta-IN', path: 'rules' });
      await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/pa.wav', RecordingDurationMs: '1800' });
      fetchSpy.mockRestore();
      await aiStub.settle(`call:${call.id}`);
      expect((await prisma.call.findUnique({ where: { id: call.id } })).language).toBe('ta-IN');
      expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).language).not.toBe('pa-IN');
    });

    it('a turn the engine ends hangs up and stores the outcome', async () => {
      const { lead, call } = await makeCall('in_progress');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 1)));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Enakku vendam', languageCode: 'ta-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({
        response: 'சரி, Thank you!', actions: { endCall: true, outcome: 'not_interested' }, timings: {}, leadId: lead.leadId,
      });
      const xml = await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/r.wav', RecordingDurationMs: '1500' });
      fetchSpy.mockRestore();
      expect(xml).toContain('<Hangup/>');
      await aiStub.settle(`call:${call.id}`);
      expect((await prisma.call.findUnique({ where: { id: call.id } })).outcome).toBe('not_interested');
    });

    it('TTS fails for a Tamil reply: the customer is asked to repeat (never an unrelated line) and the reply counts as unheard', async () => {
      const { lead, call } = await makeCall('in_progress');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 1), { status: 200 }));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Saturday 11 மணிக்கு', languageCode: 'ta-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'Green Valley site visit, சனிக்கிழமை 11 மணி. Confirm பண்ணட்டுமா?', actions: {}, timings: {}, leadId: lead.leadId, path: 'rules' });
      sarvamStub.textToSpeech.mockResolvedValueOnce({ url: '', ms: 8000, attempts: 3, cached: false, languageCode: 'ta-IN', error: 'http_429' });
      sarvamStub.textToSpeechUrl.mockResolvedValueOnce('https://example.test/voice/audio/prompt-line.wav');
      const xml = await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/t1.wav', RecordingDurationMs: '2000', CallUUID: 'u-tts' });
      fetchSpy.mockRestore();
      expect(aiStub.markReplyNotHeard).toHaveBeenCalledWith(`call:${call.id}`);
      expect(sarvamStub.textToSpeechUrl).toHaveBeenCalledWith(expect.stringContaining('line'), { cache: true });
      expect(xml).toContain('prompt-line.wav');
      expect(xml).toContain('<Record');
      await aiStub.settle(`call:${call.id}`);
    });

    it('TTS fails for an English reply: Plivo speaks the SAME words', async () => {
      const { lead, call } = await makeCall('in_progress');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 1), { status: 200 }));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'I need a 2 BHK in Porur', languageCode: 'en-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'Got it. Porur, 2 BHK. What is your budget range?', actions: {}, timings: {}, leadId: lead.leadId, path: 'rules' });
      sarvamStub.textToSpeech.mockResolvedValueOnce({ url: '', ms: 8000, attempts: 3, cached: false, languageCode: 'en-IN', error: 'http_503' });
      const xml = await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/t2.wav', RecordingDurationMs: '2000', CallUUID: 'u-tts2' });
      fetchSpy.mockRestore();
      expect(xml).toContain('<Speak');
      expect(xml).toContain('What is your budget range?');
      await aiStub.settle(`call:${call.id}`);
    });

    it('after a reply, a second empty recording replays our last question (no AI, no state change)', async () => {
      const { lead, call } = await makeCall('in_progress');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 1), { status: 200 }));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Porur la 2 BHK venum', languageCode: 'ta-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'Budget எவ்வளவு?', actions: {}, timings: {}, leadId: lead.leadId, path: 'rules' });
      sarvamStub.textToSpeech.mockResolvedValueOnce({ url: 'https://example.test/voice/audio/prompt-budget.wav', ms: 1, attempts: 1, cached: true, languageCode: 'ta-IN' });
      await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/t3.wav', RecordingDurationMs: '2000', CallUUID: 'u-s1' });
      fetchSpy.mockRestore();
      aiStub.generateResponse.mockClear();
      const first = await voice.handleTurn(call.id, { RecordingDurationMs: '0', CallUUID: 'u-s2' });
      const second = await voice.handleTurn(call.id, { RecordingDurationMs: '0', CallUUID: 'u-s3' });
      expect(first).not.toContain('prompt-budget.wav');
      expect(second).toContain('prompt-budget.wav');
      expect(aiStub.generateResponse).not.toHaveBeenCalled();
      await aiStub.settle(`call:${call.id}`);
    });

    it('silence twice then goodbye; AI is never called', async () => {
      const { call } = await makeCall('in_progress');
      expect(await voice.handleTurn(call.id, { RecordingDurationMs: '0' })).toContain('<Record');
      expect(await voice.handleTurn(call.id, { RecordingDurationMs: '0' })).toContain('<Record');
      expect(await voice.handleTurn(call.id, { RecordingDurationMs: '0' })).toContain('<Hangup/>');
      expect(aiStub.generateResponse).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------ hangup / retry
    it('completed call saves duration + outcome, marks contacted, cancels the sequence', async () => {
      const { lead, call } = await makeCall('in_progress');
      await prisma.call.update({ where: { id: call.id }, data: { answeredAt: new Date(), outcome: 'qualified' } });
      await voice.handleHangup(call.id, { CallStatus: 'completed', HangupCauseName: 'Normal Hangup', Duration: '74' });
      const c = await prisma.call.findUnique({ where: { id: call.id } });
      expect(c).toMatchObject({ status: 'completed', outcome: 'qualified', durationSec: 74 });
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('contacted');
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, status: 'scheduled' } })).toBe(0);
    });

    it('no answer on attempt 1 schedules ONE retry inside calling hours; duplicate hangup ignored', async () => {
      const { lead, call } = await makeCall();
      await followUps.cancelPending({ organizationId: ORG, customerId: lead.customerId, reason: 'test isolation' });
      await voice.handleHangup(call.id, { CallStatus: 'no-answer', HangupCauseName: 'No Answer' });
      expect(await voice.handleHangup(call.id, { CallStatus: 'no-answer' })).toEqual({ ok: true, duplicate: true });
      const retries = await prisma.followUp.findMany({ where: { customerId: lead.customerId, source: 'retry', channel: 'voice' } });
      expect(retries).toHaveLength(1);
      // Attempt 2 comes ~30 minutes later (pushed into the calling window if needed).
      expect(retries[0].scheduledAt.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
      // ...and a "sorry we missed you" WhatsApp goes out a couple of minutes after the missed call.
      const missed = await prisma.followUp.findMany({ where: { customerId: lead.customerId, source: 'retry', channel: 'whatsapp' } });
      expect(missed.map((f: any) => f.message)).toEqual(['missed_call']);
      expect(missed[0].scheduledAt.getTime() - Date.now()).toBeLessThan(3 * 60_000);
      const hourIst = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(retries[0].scheduledAt)) % 24;
      expect(hourIst).toBeGreaterThanOrEqual(9);
      expect(hourIst).toBeLessThan(21);
      expect((await prisma.call.findUnique({ where: { id: call.id } })).outcome).toBe('no_answer');
    });

    it('busy is retried; the last allowed attempt is not', async () => {
      const a = await makeCall();
      await followUps.cancelPending({ organizationId: ORG, customerId: a.lead.customerId, reason: 'test isolation' });
      await voice.handleHangup(a.call.id, { CallStatus: 'busy', HangupCauseName: 'Busy Line' });
      expect(await prisma.followUp.count({ where: { customerId: a.lead.customerId, source: 'retry', channel: 'voice' } })).toBe(1);

      const b = await makeCall('ringing', 3);
      await followUps.cancelPending({ organizationId: ORG, customerId: b.lead.customerId, reason: 'test isolation' });
      await voice.handleHangup(b.call.id, { CallStatus: 'no-answer' });
      // Third (last) attempt: no more calls, and the missed-call WhatsApp is only for the first miss.
      expect(await prisma.followUp.count({ where: { customerId: b.lead.customerId, source: 'retry' } })).toBe(0);
    });

    it('invalid number → lead lost, do-not-contact, no retry', async () => {
      const { lead, call } = await makeCall();
      await voice.handleHangup(call.id, { CallStatus: 'failed', HangupCauseName: 'Invalid Destination Address' });
      expect((await prisma.call.findUnique({ where: { id: call.id } })).outcome).toBe('invalid_number');
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('lost');
      expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).doNotContact).toBe(true);
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, source: 'retry' } })).toBe(0);
    });

    it('outbound dial refuses a second live call to the same customer', async () => {
      const { lead } = await makeCall('in_progress');
      const r = await voice.startOutboundCall({ customerId: lead.customerId, leadId: lead.leadId, ignoreCallWindow: true });
      expect(r).toEqual({ started: false, reason: 'call_already_in_progress' });
    });
  });
  // ---------------------------------------------------------------- inbound voice
  describe('inbound voice (customer calls the business)', () => {
    const uuid = () => `in-${Date.now()}-${n++}`;

    it('unknown caller: creates customer + lead + inbound call and answers in Tamil', async () => {
      const phone = `91${uniquePhone()}`;
      const callUuid = uuid();
      const xml = await voice.answerInbound({ From: `+${phone}`, To: '914400000000', CallUUID: callUuid });
      const customer = await prisma.customer.findFirst({ where: { phone } });
      const call = await prisma.call.findFirst({ where: { providerCallId: callUuid } });
      expect(customer).toBeTruthy();
      expect(await prisma.lead.count({ where: { customerId: customer.id } })).toBe(1);
      expect(call).toMatchObject({ direction: 'inbound', status: 'in_progress', customerId: customer.id, fromNumber: phone });
      expect(xml).toContain(`/voice/turn?callId=${call.id}`);
      expect(xml).not.toContain('<Speak'); // Tamil Bulbul audio, no English Plivo prompt
      expect(String(sarvamStub.textToSpeechUrl.mock.calls.at(-1)?.[0])).toContain('வணக்கம்');
    });

    it('known caller: greeted by name, existing lead reused, opted-out flag cleared', async () => {
      const lead = await newMetaLead();
      await prisma.customer.update({ where: { id: lead.customerId }, data: { doNotContact: true } });
      await voice.answerInbound({ From: lead.phone, To: '914400000000', CallUUID: uuid() });
      expect(String(sarvamStub.textToSpeechUrl.mock.calls.at(-1)?.[0])).toContain('Ravi');
      expect(await prisma.lead.count({ where: { customerId: lead.customerId } })).toBe(1);
      expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).doNotContact).toBe(false);
    });

    it('Plivo retrying the answer webhook does not create a second call', async () => {
      const phone = `91${uniquePhone()}`;
      const callUuid = uuid();
      await voice.answerInbound({ From: phone, To: '914400000000', CallUUID: callUuid });
      await voice.answerInbound({ From: phone, To: '914400000000', CallUUID: callUuid });
      expect(await prisma.call.count({ where: { providerCallId: callUuid } })).toBe(1);
    });

    it('same Voice AI agent, told the customer called (not a follow-up); hang-up resolved by CallUUID', async () => {
      const lead = await newMetaLead();
      const callUuid = uuid();
      await voice.answerInbound({ From: lead.phone, To: '914400000000', CallUUID: callUuid });
      const call = await prisma.call.findFirst({ where: { providerCallId: callUuid } });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 2)));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Saturday site visit pannalaama?', languageCode: 'ta-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'சரி!', actions: { outcome: 'site_visit_requested' }, timings: {}, leadId: lead.leadId });
      await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/in-1.wav', RecordingDurationMs: '2000', From: lead.phone });
      fetchSpy.mockRestore();
      const ctxArg = aiStub.generateResponse.mock.calls[0][0];
      expect(ctxArg.channel).toBe('voice');
      expect(ctxArg.callContext.direction).toBe('inbound');
      expect(ctxArg.callContext.reason).toContain('called the business');

      await voice.handleHangup(undefined, { CallUUID: callUuid, CallStatus: 'completed', Duration: '48' });
      const ended = await prisma.call.findUnique({ where: { id: call.id } });
      expect(ended).toMatchObject({ status: 'completed', outcome: 'site_visit_requested', durationSec: 48 });
      expect(ended.summary).toContain('Customer called in. Customer wants a site visit.');
      expect(sarvamStub.deleteAudio).toHaveBeenCalled(); // per-call audio cleaned up
    });

    it('hidden caller ID is answered politely and hung up', async () => {
      const xml = await voice.answerInbound({ From: 'anonymous', To: '914400000000', CallUUID: uuid() });
      expect(xml).toContain('<Hangup/>');
    });
  });

  // ---------------------------------------------------------------- duplicate Plivo webhooks / state
  describe('duplicate Plivo webhooks and call state', () => {
    async function liveCall() {
      const lead = await newMetaLead();
      const call = await prisma.call.create({
        data: { organizationId: ORG, customerId: lead.customerId, leadId: lead.leadId, direction: 'outbound', status: 'ringing', toNumber: lead.phone, fromNumber: '914400000000' },
      });
      return { lead, call };
    }

    it('answer webhook twice: greeting saved once, same XML', async () => {
      const { lead, call } = await liveCall();
      const a = await voice.answerOutbound(call.id, { CallUUID: 'dup-a' });
      const b = await voice.answerOutbound(call.id, { CallUUID: 'dup-a' });
      expect(b).toBe(a);
      await aiStub.settle(`call:${call.id}`);
      const conv = await prisma.conversation.findFirst({ where: { customerId: lead.customerId, channel: 'voice' } });
      expect(await prisma.message.count({ where: { conversationId: conv.id, role: 'assistant' } })).toBe(1);
    });

    it('turn webhook retried with the same recording: AI runs once', async () => {
      const { lead, call } = await liveCall();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(Buffer.alloc(3000, 3)));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Porur la 2 BHK iruka?', languageCode: 'ta-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'சரி.', actions: {}, timings: {}, leadId: lead.leadId });
      const params = { RecordUrl: 'https://media.plivo.test/same.wav', RecordingDurationMs: '1800' };
      const x1 = await voice.handleTurn(call.id, params);
      const x2 = await voice.handleTurn(call.id, params);
      fetchSpy.mockRestore();
      expect(x2).toBe(x1);
      expect(aiStub.generateResponse).toHaveBeenCalledTimes(1);
      await aiStub.settle(`call:${call.id}`);
      expect((await prisma.call.findUnique({ where: { id: call.id } })).turns).toBe(1);
    });

    it('a turn after the call ended does nothing', async () => {
      const { call } = await liveCall();
      await prisma.call.update({ where: { id: call.id }, data: { endedAt: new Date(), status: 'completed' } });
      expect(await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/late.wav', RecordingDurationMs: '1500' })).toContain('<Hangup/>');
      expect(aiStub.generateResponse).not.toHaveBeenCalled();
    });

    it('AI failure or timeout: polite goodbye and hang up, never dead air', async () => {
      const { lead, call } = await liveCall();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 4)));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'hello', languageCode: 'en-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'technical issue', actions: {}, timings: {}, leadId: lead.leadId, failed: true });
      const xml = await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/fail.wav', RecordingDurationMs: '1500' });
      fetchSpy.mockRestore();
      expect(xml).toContain('<Hangup/>');
    });

    it('a single English utterance does not change the saved customer language (voice layer never writes it)', async () => {
      const { lead, call } = await liveCall();
      await prisma.customer.update({ where: { id: lead.customerId }, data: { language: null } });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 5)));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Please speak in English', languageCode: 'en-IN', latencyMs: 5 });
      aiStub.generateResponse.mockResolvedValue({ response: 'Sure.', actions: {}, timings: {}, leadId: lead.leadId, path: 'llm' });
      await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/en.wav', RecordingDurationMs: '1500' });
      fetchSpy.mockRestore();
      await aiStub.settle(`call:${call.id}`);
      expect((await prisma.call.findUnique({ where: { id: call.id } })).language).toBeNull();
      expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).language).toBeNull();
    });

    it('garbled speech-to-text is rejected by the quality gate: the AI is never called, the customer is asked again', async () => {
      const { call } = await liveCall();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(3000, 6)));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'ha ha ha ha ha ha ha ha', languageCode: 'pa-IN', latencyMs: 5 });
      const xml = await voice.handleTurn(call.id, { RecordUrl: 'https://media.plivo.test/garbled.wav', RecordingDurationMs: '1500' });
      fetchSpy.mockRestore();
      expect(aiStub.generateResponse).not.toHaveBeenCalled();
      expect(xml).toContain('<Record');
      await aiStub.settle(`call:${call.id}`);
      expect((await prisma.call.findUnique({ where: { id: call.id } })).silentTurns).toBe(1);
    });

    it('a retry that arrives while the first request is still being processed joins it: one AI turn', async () => {
      const { lead, call } = await liveCall();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(Buffer.alloc(3000, 8)));
      sarvamStub.speechToText.mockResolvedValue({ transcript: 'Porur la 2 BHK iruka?', languageCode: 'ta-IN', latencyMs: 5 });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      aiStub.generateResponse.mockImplementation(async () => {
        await gate;
        return { response: 'சரி.', actions: {}, timings: {}, leadId: lead.leadId, path: 'rules' };
      });
      const params = { RecordUrl: 'https://media.plivo.test/slow.wav', RecordingDurationMs: '1800' };
      const first = voice.handleTurn(call.id, params);
      await new Promise((r) => setTimeout(r, 50));
      const retry = voice.handleTurn(call.id, params);
      release();
      const [a, b] = await Promise.all([first, retry]);
      fetchSpy.mockRestore();
      expect(b).toBe(a);
      expect(aiStub.generateResponse).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------- wrong number, duplicates, race, isolation
  describe('wrong number, duplicate messages, race, organization isolation', () => {
    it('"wrong number" → do-not-contact, automation stopped', async () => {
      const lead = await newMetaLead();
      const callId = `call-wn-${lead.leadId}`;
      await engine.openCallSession({ organizationId: ORG, callId, phone: lead.phone, leadId: lead.leadId });
      const r = await engine.generate({ organizationId: ORG, channel: 'voice', phone: lead.phone, message: 'wrong number, naan enquire pannala', leadId: lead.leadId, callContext: { direction: 'outbound', callId, reason: 'test' } });
      await engine.settle(`call:${callId}`);
      expect(r.actions.outcome).toBe('wrong_number');
      expect((await prisma.customer.findUnique({ where: { id: lead.customerId } })).doNotContact).toBe(true);
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, status: 'scheduled' } })).toBe(0);
    });

    it('duplicate WhatsApp webhook (same message id) is queued once', async () => {
      const lead = await newMetaLead();
      const id = `wamid.dup.${Date.now()}`;
      const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_PHONE_ID }, messages: [{ from: lead.phone, id, type: 'text', text: { body: 'hi' } }] } }] }] };
      await whatsappWebhook.processWebhook(body);
      await whatsappWebhook.processWebhook(body);
      const { whatsappQueue } = await import('../src/queues/queues.js');
      const jobs = await whatsappQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
      expect(jobs.filter((j: any) => j?.data?.messageId === id)).toHaveLength(1);
    });

    it('race: reply arrives first → follow-up worker sends nothing', async () => {
      const lead = await newMetaLead();
      const first = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: 'first_contact' } });
      await whatsappWebhook.processWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_PHONE_ID }, messages: [{ from: lead.phone, id: `wamid.r1.${Date.now()}`, type: 'text', text: { body: 'yes' } }] } }] }] });
      const r = await processor.process(first.id);
      expect(['customer_replied', 'cancelled']).toContain(r.skipped);
      expect(whatsappStub.sendWithinPolicy).not.toHaveBeenCalled();
    });

    it('race: reply and follow-up at the same moment → never a send after the reply, nothing left pending', async () => {
      const lead = await newMetaLead();
      const first = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: 'first_contact' } });
      let sentAt = 0;
      whatsappStub.sendWithinPolicy.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 150)); // slow send widens the race window
        sentAt = Date.now();
        return { kind: 'text', content: 'hi' };
      });
      await Promise.all([
        processor.process(first.id),
        new Promise((r) => setTimeout(r, 20)).then(() =>
          whatsappWebhook.processWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_PHONE_ID }, messages: [{ from: lead.phone, id: `wamid.r2.${Date.now()}`, type: 'text', text: { body: 'yes' } }] } }] }] }),
        ),
      ]);
      const customer = await prisma.customer.findUnique({ where: { id: lead.customerId } });
      expect(whatsappStub.sendWithinPolicy.mock.calls.length).toBeLessThanOrEqual(1);
      if (sentAt) expect(sentAt).toBeLessThanOrEqual(customer.lastInboundAt.getTime() + 5);
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, status: 'scheduled', source: 'sequence' } })).toBe(0);
      whatsappStub.sendWithinPolicy.mockReset();
    });

    it('organization isolation: another organization cannot read or act on this lead', async () => {
      const lead = await newMetaLead();
      await prisma.organization.upsert({ where: { id: 'org_other' }, create: { id: 'org_other', name: 'Other Realty' }, update: {} });
      expect(await leads.getLeadDetail('org_other', lead.leadId)).toBeNull();
      expect(await leads.updateLeadStatus({ organizationId: 'org_other', leadId: lead.leadId, status: 'won' })).toBeNull();
      const fu = await prisma.followUp.findFirst({ where: { leadId: lead.leadId } });
      await expect(followUps.findOne('org_other', fu.id)).rejects.toThrow('not found');
      const r = await voice.startOutboundCall({ organizationId: 'org_other', customerId: lead.customerId, leadId: lead.leadId, ignoreCallWindow: true });
      expect(r.started).toBe(false);
      expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('new');
    });
  });

  // ---------------------------------------------------------------- visit follow-through, team alerts, hot leads
  describe('visit follow-through, team alerts and hot leads', () => {
    const TEAM = ['919811100001', '919811100002'];
    let DEFAULTS: any;
    let teamFollowUps: any, teamProcessor: any;
    const settingsStub = (extra: any = {}) => ({
      get: async () => ({
        ...DEFAULTS,
        team: { ...DEFAULTS.team, alertPhones: TEAM },
        visits: { ...DEFAULTS.visits, sites: { prop_porur_green_valley: { address: '12 Lake Rd, Porur', mapUrl: 'https://maps.example/gv' } } },
        ...extra,
      }),
    });
    const sender = { sendWithinPolicy: vi.fn(), sendText: vi.fn(), sendNamedTemplate: vi.fn() };

    beforeAll(async () => {
      DEFAULTS = (await import('../src/settings/tenant-settings.js')).DEFAULT_SETTINGS;
      teamFollowUps = new m.FollowUpsService(prisma, settingsStub());
      teamProcessor = new m.FollowUpProcessor(prisma, conversations, leads, voiceStub, sender, teamFollowUps);
    });
    beforeEach(() => {
      sender.sendWithinPolicy.mockReset().mockImplementation(async (p: any) => ({ kind: 'text', messageId: 'wamid.t', content: p.text }));
      sender.sendText.mockReset().mockResolvedValue('wamid.alert');
      sender.sendNamedTemplate.mockReset().mockResolvedValue('wamid.tpl');
    });

    async function bookedVisit(hoursAhead: number, status = 'scheduled') {
      const lead = await newMetaLead();
      const { randomUUID } = await import('node:crypto');
      const visit = await prisma.siteVisit.create({
        data: {
          id: randomUUID(), organizationId: ORG, leadId: lead.leadId, customerId: lead.customerId, propertyId: 'prop_porur_green_valley',
          scheduledAt: new Date(Date.now() + hoursAhead * 3600_000), status, updatedAt: new Date(),
        },
      });
      return { lead, visit };
    }
    const steps = async (leadId: string) =>
      (await prisma.followUp.findMany({ where: { leadId, source: { in: ['visit', 'alert'] } }, orderBy: { scheduledAt: 'asc' } })).map((f: any) => f.message.split(':').slice(0, 2).join(':'));

    it('a booking 3 days out schedules: team alert now, confirm the day before, reminder 2 h before, team 30 min before, after-visit; idempotent', async () => {
      const { lead, visit } = await bookedVisit(72);
      await teamFollowUps.scheduleVisitFollowThrough(visit);
      await teamFollowUps.scheduleVisitFollowThrough(visit); // a second call creates nothing new
      expect(await steps(lead.leadId)).toEqual(['alert:booked', 'visit:confirm', 'visit:reminder', 'alert:visit_soon', 'visit:after']);
      const confirm = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `visit:confirm:${visit.id}` } });
      expect(Math.abs(confirm.scheduledAt.getTime() - (visit.scheduledAt.getTime() - 24 * 3600_000))).toBeLessThan(1000);
    });

    it('a visit booked for later today gets no day-before confirmation; no team phones = no team alerts', async () => {
      const { lead, visit } = await bookedVisit(5);
      await teamFollowUps.scheduleVisitFollowThrough(visit);
      expect(await steps(lead.leadId)).toEqual(['alert:booked', 'visit:reminder', 'alert:visit_soon', 'visit:after']);
      const b = await bookedVisit(72);
      await followUps.scheduleVisitFollowThrough(b.visit); // default settings: no team phones
      expect(await steps(b.lead.leadId)).toEqual(['visit:confirm', 'visit:reminder', 'visit:after']);
    });

    it('team alert: every team phone gets the lead, property and slot', async () => {
      const { lead, visit } = await bookedVisit(72);
      await teamFollowUps.scheduleVisitFollowThrough(visit);
      const alert = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `alert:booked:${visit.id}` } });
      expect(await teamProcessor.process(alert.id)).toEqual({ alerted: 2, failed: 0 });
      expect(sender.sendText.mock.calls.map((c: any[]) => c[0])).toEqual(TEAM);
      expect(sender.sendText.mock.calls[0][1]).toContain('Green Valley Residency');
      expect(sender.sendText.mock.calls[0][1]).toContain(`+${lead.phone}`);
    });

    it('team alert that WhatsApp refuses becomes a dashboard task, never silently lost', async () => {
      const { lead, visit } = await bookedVisit(72);
      sender.sendText.mockRejectedValue(new Error('WhatsApp API 400: Re-engagement message (code 131047)'));
      await teamFollowUps.scheduleVisitFollowThrough(visit);
      const alert = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `alert:booked:${visit.id}` } });
      expect(await teamProcessor.process(alert.id)).toEqual({ alerted: 0, failed: 2 });
      const task = await prisma.followUp.findFirst({ where: { customerId: lead.customerId, channel: 'human', status: 'open' } });
      expect(task.message).toContain('New site visit booked');
    });

    it('day-before confirmation goes out even if the customer chatted since; a cancelled visit sends nothing', async () => {
      const { lead, visit } = await bookedVisit(72);
      await teamFollowUps.scheduleVisitFollowThrough(visit);
      await prisma.customer.update({ where: { id: lead.customerId }, data: { lastInboundAt: new Date(Date.now() + 1000) } });
      const confirm = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `visit:confirm:${visit.id}` } });
      expect(await teamProcessor.process(confirm.id)).toEqual({ sent: 'text', step: 'confirm' });
      expect(sender.sendWithinPolicy.mock.calls[0][0].text).toContain('"YES"');

      const c = await bookedVisit(72, 'cancelled');
      await teamFollowUps.scheduleVisitFollowThrough({ ...c.visit, status: 'scheduled' });
      const step = await prisma.followUp.findFirst({ where: { leadId: c.lead.leadId, message: `visit:confirm:${c.visit.id}` } });
      expect(await teamProcessor.process(step.id)).toEqual({ skipped: 'visit_cancelled' });
    });

    it('reminder carries the site address and map link; an opted-out customer gets nothing', async () => {
      const { lead, visit } = await bookedVisit(72);
      await teamFollowUps.scheduleVisitFollowThrough(visit);
      const reminder = await prisma.followUp.findFirst({ where: { leadId: lead.leadId, message: `visit:reminder:${visit.id}` } });
      await teamProcessor.process(reminder.id);
      expect(sender.sendWithinPolicy.mock.calls[0][0].text).toContain('12 Lake Rd, Porur');
      expect(sender.sendWithinPolicy.mock.calls[0][0].text).toContain('https://maps.example/gv');

      const d = await bookedVisit(72);
      await teamFollowUps.scheduleVisitFollowThrough(d.visit);
      await prisma.customer.update({ where: { id: d.lead.customerId }, data: { doNotContact: true } });
      const r2 = await prisma.followUp.findFirst({ where: { leadId: d.lead.leadId, message: `visit:reminder:${d.visit.id}` } });
      expect(await teamProcessor.process(r2.id)).toEqual({ skipped: 'do_not_contact' });
    });

    it('after the visit: thank-you if visited; unmarked -> look again tomorrow, then ask the team to mark it', async () => {
      const done = await bookedVisit(72, 'completed');
      await teamFollowUps.scheduleVisitFollowThrough({ ...done.visit, status: 'scheduled' });
      const after = await prisma.followUp.findFirst({ where: { leadId: done.lead.leadId, message: `visit:after:${done.visit.id}` } });
      expect(await teamProcessor.process(after.id)).toEqual({ sent: 'text', step: 'after' });
      expect(sender.sendWithinPolicy.mock.calls[0][0].text).toContain('thanks');

      const open = await bookedVisit(72);
      await teamFollowUps.scheduleVisitFollowThrough(open.visit);
      const a2 = await prisma.followUp.findFirst({ where: { leadId: open.lead.leadId, message: `visit:after:${open.visit.id}` } });
      expect(await teamProcessor.process(a2.id)).toEqual({ rescheduled: true, reason: 'visit_not_marked_yet' });
      expect(await teamProcessor.process(a2.id)).toEqual({ skipped: 'visit_not_marked' });
      const task = await prisma.followUp.findFirst({ where: { customerId: open.lead.customerId, channel: 'human', status: 'open' } });
      expect(task.message).toContain('Please mark whether');
    });

    async function askedToConfirm() {
      const v = await bookedVisit(26);
      await prisma.followUp.create({
        data: { organizationId: ORG, leadId: v.lead.leadId, customerId: v.lead.customerId, channel: 'whatsapp', action: 'message', message: `visit:confirm:${v.visit.id}`, scheduledAt: new Date(), status: 'completed', source: 'visit' },
      });
      return v;
    }

    it('WhatsApp "yes" to the day-before message confirms THAT visit (no new booking)', async () => {
      const { lead, visit } = await askedToConfirm();
      const r = await engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: lead.phone, message: 'yes', leadId: lead.leadId });
      expect(r.response).toMatch(/confirm/i);
      expect((await prisma.siteVisit.findUnique({ where: { id: visit.id } })).status).toBe('confirmed');
      expect(await prisma.siteVisit.count({ where: { customerId: lead.customerId } })).toBe(1);
    });

    it('WhatsApp "no" asks for a new day and time and changes nothing yet', async () => {
      const { lead, visit } = await askedToConfirm();
      const r = await engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: lead.phone, message: 'no', leadId: lead.leadId });
      expect(r.response).toMatch(/day and time|naal|நாள்/i);
      expect((await prisma.siteVisit.findUnique({ where: { id: visit.id } })).status).toBe('scheduled');
    });

    it('a "yes" on a phone call, or without our confirmation message, never confirms a visit', async () => {
      const { lead, visit } = await askedToConfirm();
      const callId = `call-${Math.random().toString(36).slice(2)}`;
      await engine.generate({ organizationId: ORG, channel: 'voice', phone: lead.phone, message: 'ஆமா', leadId: lead.leadId, callContext: { direction: 'outbound', callId, reason: 'test' } });
      expect((await prisma.siteVisit.findUnique({ where: { id: visit.id } })).status).toBe('scheduled');

      const quiet = await bookedVisit(26); // no confirmation message was sent for this one
      await engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: quiet.lead.phone, message: 'yes', leadId: quiet.lead.leadId });
      expect((await prisma.siteVisit.findUnique({ where: { id: quiet.visit.id } })).status).toBe('scheduled');
    });

    it('hot lead (buying immediately + a matching property shown) alerts the team once', async () => {
      const hotEngine = new m.ConversationEngine(prisma, conversations, leads, new m.PropertiesService(prisma), new m.SiteVisitsService(prisma), teamFollowUps, store, llmFake);
      const lead = await newMetaLead();
      const key = `call:hot-${Math.random().toString(36).slice(2)}`;
      const callId = key.slice(5);
      await hotEngine.openCallSession({ organizationId: ORG, callId, phone: lead.phone, leadId: lead.leadId, openingText: 'hi' });
      await hotEngine.generate({ organizationId: ORG, channel: 'voice', phone: lead.phone, message: 'Porur la 2 BHK iruka? urgent ah venum', leadId: lead.leadId, callContext: { direction: 'outbound', callId, reason: 'test' } });
      await hotEngine.generate({ organizationId: ORG, channel: 'voice', phone: lead.phone, message: 'immediately venum', leadId: lead.leadId, callContext: { direction: 'outbound', callId, reason: 'test' } });
      await hotEngine.settle(key);
      const alerts = await prisma.followUp.findMany({ where: { leadId: lead.leadId, message: `alert:hot:${lead.leadId}` } });
      expect(alerts).toHaveLength(1);
    });
  });
});
