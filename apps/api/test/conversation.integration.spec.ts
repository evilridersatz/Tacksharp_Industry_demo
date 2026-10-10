/**
 * Safety and behaviour tests for the conversation engine, against a real MySQL test database and Redis.
 *
 *   TEST_DB_NAME=tacksharp_test DB_HOST=127.0.0.1 npx vitest run test/conversation.integration.spec.ts
 *
 * What is REAL here: the ConversationEngine, session state machine, transcript/intent/slot/date rules, the
 * booking validation + transaction, and every database write.
 * What is FAKE: the language model (a scripted stand-in that records how it was called). Nothing here
 * talks to OpenAI, Sarvam, Plivo or Meta, so these tests prove the application code is safe whatever the
 * model says - they say nothing about how a real model phrases things.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const ORG = 'org_real_estate_001';
let n = 0;
const uniquePhone = () => `91${String(Date.now()).slice(-7)}${String(n++).padStart(3, '0')}`;

/** "October 18"-style text for a day a few days ahead (always future, whatever day the test runs). */
function futureDayText(daysAhead = 3) {
  const d = new Date(Date.now() + (330 + daysAhead * 24 * 60) * 60_000);
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return { text: `${month} ${d.getUTCDate()}`, day: d.getUTCDate(), month: d.getUTCMonth() + 1 };
}

describe.skipIf(!enabled)('Conversation engine safety (integration)', () => {
  let m: any;
  let prisma: any, conversations: any, leads: any, followUps: any, siteVisits: any, store: any, engine: any;
  const llm = { run: vi.fn() };
  const noModel = async () => ({ text: '', failed: false, aborted: false, usage: { requests: 0 } });

  beforeAll(async () => {
    m = {
      ...(await import('../src/prisma/prisma.service.js')),
      ...(await import('../src/conversations/conversations.service.js')),
      ...(await import('../src/leads/leads.service.js')),
      ...(await import('../src/follow-ups/follow-ups.service.js')),
      ...(await import('../src/properties/properties.service.js')),
      ...(await import('../src/site-visits/site-visits.service.js')),
      ...(await import('../src/ai/conversation-engine.service.js')),
      ...(await import('../src/ai/session.store.js')),
    };
    prisma = new m.PrismaService();
    await prisma.$connect();
    conversations = new m.ConversationsService(prisma);
    leads = new m.LeadsService(prisma);
    followUps = new m.FollowUpsService(prisma);
    siteVisits = new m.SiteVisitsService(prisma);
    store = new m.SessionStore();
    store.useRedis(null);
    engine = new m.ConversationEngine(prisma, conversations, leads, new m.PropertiesService(prisma), siteVisits, followUps, store, llm);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    const { followUpQueue, whatsappQueue, closeRedisConnections } = await import('../src/queues/queues.js');
    await followUpQueue.close();
    await whatsappQueue.close();
    await closeRedisConnections();
  });

  beforeEach(() => {
    llm.run.mockReset();
    llm.run.mockImplementation(noModel);
  });

  // ------------------------------------------------------------------------------------ helpers
  async function newLead(details: { location?: string; budget?: string; bhk?: string } | null = { location: 'Porur', budget: '80 lakhs', bhk: '2' }) {
    const phone = uniquePhone();
    const lead = await leads.createLead({ organizationId: ORG, name: 'Ravi Kumar', phone, source: 'meta_lead_ads', ...(details ?? {}) });
    await followUps.startLeadSequence({ organizationId: ORG, leadId: lead.id, customerId: lead.customerId });
    return { phone, leadId: lead.id as string, customerId: lead.customerId as string };
  }

  /** One phone call. say() = what the customer says; the engine answers; background writes are flushed. */
  async function phoneCall(lead: { phone: string; leadId: string }, callId = `call-${Math.random().toString(36).slice(2)}`) {
    await engine.openCallSession({ organizationId: ORG, callId, phone: lead.phone, leadId: lead.leadId, openingText: 'opening' });
    const key = `call:${callId}`;
    const say = async (message: string, quality: 'ok' | 'weak' = 'ok') => {
      const r = await engine.generate({
        organizationId: ORG, channel: 'voice', phone: lead.phone, message, leadId: lead.leadId, quality,
        callContext: { direction: 'outbound', callId, reason: 'test' },
      });
      await engine.settle(key);
      return r;
    };
    return { callId, key, say, session: () => store.get(key) };
  }

  const visits = (customerId: string) => prisma.siteVisit.findMany({ where: { customerId } });
  const leadStatus = async (leadId: string) => (await prisma.lead.findUnique({ where: { id: leadId } })).status;
  const customerOf = (customerId: string) => prisma.customer.findUnique({ where: { id: customerId } });

  /** Brings a call to "the AI asked: shall I confirm the visit?" and returns the call. */
  async function callAtConfirmation(opts: { when?: string } = {}) {
    const lead = await newLead();
    const call = await phoneCall(lead);
    await call.say('பேசலாம்'); // consent: asks to confirm the details on file
    await call.say('ஆமா'); // yes: searches
    const ask = await call.say('site visit paakanum');
    expect(ask.state).toBe('VISIT_PROPOSAL');
    const proposed = await call.say(opts.when ?? 'tomorrow 11 am');
    expect(proposed.state).toBe('VISIT_CONFIRMATION');
    expect(proposed.response).toMatch(/confirm|Confirm/);
    return { lead, call, proposed };
  }

  // ------------------------------------------------------------------------------------ the reported bug
  describe('the reported bug: "பேசலாம்" must never book', () => {
    it('only "பேசலாம்" (details already on file): one confirming question, no search, no booking, no status change, call not ended', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      const r = await call.say('பேசலாம்');

      expect(r.path).toBe('rules');
      expect(llm.run).not.toHaveBeenCalled(); // not one model request
      expect(r.actions).toEqual({});
      expect(r.actions.endCall).toBeUndefined();
      expect(r.state).toBe('QUALIFICATION');
      expect(r.response.match(/[?？]/g)?.length).toBe(1); // one question
      expect(await visits(lead.customerId)).toHaveLength(0);
      expect(await leadStatus(lead.leadId)).toBe('new'); // not qualified, not property_interested, not site_visit
      expect((await customerOf(lead.customerId)).doNotContact).toBe(false);
      expect((await call.session()).presented).toHaveLength(0); // no property search happened
    });

    it('"பேசலாம்" repeated is still only a question - never an action', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const again = await call.say('பேசலாம்');
      expect(again.path).toBe('rules');
      expect(again.actions).toEqual({});
      expect(await visits(lead.customerId)).toHaveLength(0);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('"hello" → short greeting-style reply with one question, zero model requests', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const r = await call.say('hello');
      expect(r.path).toBe('rules');
      expect(r.response.length).toBeLessThan(80);
      expect(r.response.match(/[?？]/g)?.length).toBe(1);
      expect(llm.run).not.toHaveBeenCalled();
      expect(r.aiUsage).toBeUndefined();
    });

    it('"yes" with nothing proposed never books (no pending proposal)', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      for (const yes of ['yes', 'ஆமா', 'ok confirm', 'சரி book பண்ணுங்க']) {
        const r = await call.say(yes);
        expect(r.booking).toBeUndefined();
        expect(r.actions.siteVisitBooked).toBeUndefined();
      }
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('"yes" after properties were shown starts the visit flow (asks day/time) but books nothing', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const shown = await call.say('ஆமா'); // confirms the details -> search
      expect(shown.state).toBe('PROPERTY_DISCUSSION');
      const next = await call.say('yes');
      expect(next.state).toBe('VISIT_PROPOSAL');
      expect(next.response).toMatch(/\?|\？/);
      expect(await visits(lead.customerId)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------ call isolation
  describe('calls are isolated', () => {
    it('an old call with "October 18 maybe" and an unconfirmed proposal does not leak into a new call', async () => {
      const lead = await newLead();
      const oldCall = await phoneCall(lead);
      await oldCall.say('பேசலாம்');
      await oldCall.say('ஆமா');
      await oldCall.say('site visit paakanum');
      const proposed = await oldCall.say(`${futureDayText().text} 11 am maybe`);
      expect(proposed.state).toBe('VISIT_CONFIRMATION');
      // The old call is abandoned: no hang-up, session still stored. History in the database also has the line.
      const conv = await prisma.conversation.findFirst({ where: { customerId: lead.customerId, channel: 'voice' } });
      expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBeGreaterThan(0);

      const newCall = await phoneCall(lead);
      const hello = await newCall.say('hello');
      const s = await newCall.session();
      expect(s.key).not.toBe((await oldCall.session()).key);
      expect(s.proposal).toBeUndefined();
      expect(s.state).not.toBe('VISIT_CONFIRMATION');
      expect(s.recent.map((x: any) => x.content).join(' ')).not.toMatch(/maybe|confirm/i);
      expect(hello.booking).toBeUndefined();

      const yes = await newCall.say('yes');
      expect(yes.booking).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------ confirmed booking
  describe('booking needs an explicit confirmation of property + day + time', () => {
    it('Scenarios A-G: yes → location → budget → BHK → search → day+time → exact confirmation → only then booked', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const day = futureDayText(4);

      const a = await call.say('Yes.'); // A: answering "may we talk?"
      expect(a.state).toBe('QUALIFICATION');
      expect((await call.session()).presented).toHaveLength(0);
      expect(a.booking).toBeUndefined();

      const b = await call.say('Enakku OMR la property venum.'); // B: asks budget
      expect(b.response).toMatch(/budget/i);
      const c = await call.say('Budget around 50 lakhs.'); // C: asks BHK/type
      expect(c.response).toMatch(/BHK/i);
      expect((await call.session()).presented).toHaveLength(0);

      const d = await call.say('2 BHK.'); // D: searches verified inventory
      expect(d.state).toBe('PROPERTY_DISCUSSION');
      expect((await call.session()).presented.length).toBeGreaterThan(0);
      expect(await visits(lead.customerId)).toHaveLength(0);

      const e = await call.say(`${day.text} morning visit okay.`); // E: exact date/time spoken back
      expect(e.state).toBe('VISIT_CONFIRMATION');
      expect(e.response).toContain(String(day.day));
      expect(await visits(lead.customerId)).toHaveLength(0); // proposing is not booking

      const f = await call.say('Yes.'); // F: only now
      expect(f.booking).toBe('booked');
      expect(f.actions).toMatchObject({ siteVisitBooked: true, outcome: 'site_visit_booked', endCall: true });
      const rows = await visits(lead.customerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ propertyId: 'prop_omr_sunrise', status: 'scheduled' });
      expect(rows[0].notes).toContain('confirmed by customer');
      expect(await leadStatus(lead.leadId)).toBe('site_visit');
      // the automatic sequence stops once a visit is booked
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, status: 'scheduled', source: 'sequence' } })).toBe(0);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('G: "பேசலாம்." in the middle of the flow is not a confirmation', async () => {
      const { lead, call } = await callAtConfirmation();
      const r = await call.say('பேசலாம்.');
      expect(r.booking).toBeUndefined();
      expect(r.actions.endCall).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('explicit confirm after the exact question → exactly one booking, correct property and time', async () => {
      const { lead, call } = await callAtConfirmation({ when: 'tomorrow 11 am' });
      const proposal = (await call.session()).proposal;
      const r = await call.say('ஆமா confirm பண்ணுங்க');
      expect(r.booking).toBe('booked');
      const rows = await visits(lead.customerId);
      expect(rows).toHaveLength(1);
      expect(rows[0].scheduledAt.toISOString()).toBe(new Date(proposal.scheduledAt).toISOString());
      expect(rows[0].propertyId).toBe(proposal.propertyId);
      const ist = new Date(rows[0].scheduledAt.getTime() + 330 * 60_000);
      expect(ist.getUTCHours()).toBe(11);
    });

    it('missing time → no proposal, a question about the time, and a later "yes" books nothing', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('ஆமா');
      await call.say('site visit paakanum');
      const r = await call.say('naalaikku');
      expect(r.state).toBe('VISIT_PROPOSAL');
      expect(r.response).toMatch(/நேரம்|time|மணிக்கு/i);
      expect((await call.session()).proposal).toBeUndefined();
      const yes = await call.say('yes');
      expect(yes.booking).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('a time that is already past is rejected at confirmation, whatever the session says', async () => {
      const { lead, call } = await callAtConfirmation();
      const s = await call.session();
      s.proposal.scheduledAt = new Date(Date.now() - 3 * 3600_000).toISOString().replace('Z', '+00:00'); // stale proposal in the past
      const r = await call.say('yes confirm');
      expect(r.booking).toBe('rejected');
      expect(r.actions.siteVisitBooked).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('an expired proposal can no longer be confirmed', async () => {
      const { lead, call } = await callAtConfirmation();
      const s = await call.session();
      s.proposal.expiresAt = new Date(Date.now() - 1000).toISOString();
      const r = await call.say('yes');
      expect(r.booking).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('a "yes" that does not answer the confirmation question we just asked is not accepted', async () => {
      const { lead, call } = await callAtConfirmation();
      const s = await call.session();
      s.proposal.askedTurn = s.turn - 5; // the question was asked a few turns ago
      const r = await call.say('yes');
      expect(r.booking).toBeUndefined();
      expect(r.response).toMatch(/confirm|Confirm/);
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('a garbled (weak) transcript that looks like "yes" does not book - the customer is asked again', async () => {
      const { lead, call } = await callAtConfirmation();
      const r = await call.say('yes', 'weak');
      expect(r.booking).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
      const real = await call.say('yes', 'ok');
      expect(real.booking).toBe('booked');
    });

    it('"no" declines the proposal; a later "yes" does not resurrect it', async () => {
      const { lead, call } = await callAtConfirmation();
      const no = await call.say('வேண்டாம், வேற நாள்');
      expect(no.booking).toBeUndefined();
      expect(no.actions.notInterested).toBeUndefined(); // refusing the visit is not "stop contacting me"
      const yes = await call.say('yes');
      expect(yes.booking).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
      expect((await customerOf(lead.customerId)).doNotContact).toBe(false);
    });

    it('duplicate booking: the same confirmation twice → one visit; a changed time replaces it', async () => {
      const { lead, call } = await callAtConfirmation();
      const proposal = (await call.session()).proposal;
      const first = await call.say('yes');
      expect(first.booking).toBe('booked');
      await call.say('yes').catch(() => undefined); // webhook retry / customer repeats: must not create another
      expect(await visits(lead.customerId)).toHaveLength(1);

      const args = { organizationId: ORG, customerId: lead.customerId, leadId: lead.leadId, propertyId: proposal.propertyId, scheduledAt: proposal.scheduledAt, presentedPropertyIds: [proposal.propertyId], evidence: 'test' };
      const again = await siteVisits.bookConfirmedVisit(args);
      expect(again.ok).toBe(true);
      expect(again.duplicate).toBe(true);
      const parallel = await Promise.all([siteVisits.bookConfirmedVisit(args), siteVisits.bookConfirmedVisit(args), siteVisits.bookConfirmedVisit(args)]);
      expect(parallel.every((r: any) => r.ok)).toBe(true);
      expect((await visits(lead.customerId)).filter((v: any) => v.status === 'scheduled')).toHaveLength(1);
    });

    it('the service refuses a property that was never presented, a past time and a time outside visiting hours', async () => {
      const lead = await newLead();
      const base = { organizationId: ORG, customerId: lead.customerId, leadId: lead.leadId, evidence: 'test' };
      const t = (h: number) => {
        const ist = new Date(Date.now() + 330 * 60_000 + 24 * 3600_000);
        ist.setUTCHours(h, 0, 0, 0);
        return new Date(ist.getTime() - 330 * 60_000).toISOString();
      };
      const notPresented = await siteVisits.bookConfirmedVisit({ ...base, propertyId: 'prop_omr_sunrise', scheduledAt: t(11), presentedPropertyIds: ['prop_porur_green_valley'] });
      expect(notPresented).toMatchObject({ ok: false, code: 'property_not_presented' });
      const past = await siteVisits.bookConfirmedVisit({ ...base, propertyId: 'prop_omr_sunrise', scheduledAt: new Date(Date.now() - 86_400_000).toISOString(), presentedPropertyIds: ['prop_omr_sunrise'] });
      expect(past).toMatchObject({ ok: false, code: 'past' });
      const night = await siteVisits.bookConfirmedVisit({ ...base, propertyId: 'prop_omr_sunrise', scheduledAt: t(23), presentedPropertyIds: ['prop_omr_sunrise'] });
      expect(night).toMatchObject({ ok: false, code: 'outside_hours' });
      const missing = await siteVisits.bookConfirmedVisit({ ...base, propertyId: 'does-not-exist', scheduledAt: t(11), presentedPropertyIds: ['does-not-exist'] });
      expect(missing).toMatchObject({ ok: false, code: 'property_not_found' });
      const other = await siteVisits.bookConfirmedVisit({ ...base, organizationId: 'org_other', propertyId: 'prop_omr_sunrise', scheduledAt: t(11), presentedPropertyIds: ['prop_omr_sunrise'] });
      expect(other.ok).toBe(false);
      expect(await visits(lead.customerId)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------ the model cannot act
  describe('the language model can phrase a reply but cannot book, end calls or change status', () => {
    it('a model that claims "I have booked your visit" has that sentence removed', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('ஆமா');
      llm.run.mockImplementationOnce(async () => ({ text: 'I have booked your site visit for tomorrow. Anything else I can help with?', failed: false, aborted: false, usage: { requests: 1 } }));
      const r = await call.say('is the builder reliable and when is possession');
      expect(r.path).toBe('llm');
      expect(r.response).not.toMatch(/booked/i);
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('the model is never given a booking, status or end-call tool: only the reply-phrasing toolsets exist', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('ஆமா');
      llm.run.mockImplementation(async () => ({ text: 'Sure, happy to help.', failed: false, aborted: false, usage: { requests: 1 } }));
      await call.say('is the builder reliable');
      const used = llm.run.mock.calls.map((c: any[]) => c[0].toolset);
      expect(used.length).toBeGreaterThan(0);
      for (const toolset of used) expect(['none', 'memory', 'discussion', 'discussion_memory', 'proposal']).toContain(toolset);
      // the agent builder exposes no tool named like an action
      const { getRealEstateAgent } = await import('ai/agents/real-estate-agent.js');
      for (const toolset of ['none', 'memory', 'discussion', 'discussion_memory', 'proposal'] as const) {
        const names = (getRealEstateAgent('voice', toolset).tools as any[]).map((t) => t.name);
        for (const forbidden of ['book_site_visit', 'update_lead_status', 'end_call', 'mark_not_interested', 'request_human_handoff', 'schedule_callback']) {
          expect(names).not.toContain(forbidden);
        }
      }
    });

    it('a model that proposes a visit creates only a pending proposal (never a booking) for a presented property', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('ஆமா');
      const presented = (await call.session()).presented;
      expect(presented.length).toBeGreaterThan(0);
      const tomorrow11 = (() => {
        const d = new Date(Date.now() + 330 * 60_000 + 24 * 3600_000);
        d.setUTCHours(11, 0, 0, 0);
        return new Date(d.getTime() - 330 * 60_000).toISOString();
      })();
      llm.run.mockImplementationOnce(async (args: any) => {
        const bogus = await args.context.proposeSiteVisit({ propertyId: 'made-up-id', scheduledAt: tomorrow11 });
        expect(bogus.ok).toBe(false);
        const real = await args.context.proposeSiteVisit({ propertyId: presented[0].id, scheduledAt: tomorrow11 });
        expect(real.ok).toBe(true);
        return { text: 'Booked!', failed: false, aborted: false, usage: { requests: 1 } };
      });
      const r = await call.say('hmm ok tell me more about the first one, is it near a good school');
      expect(r.state).toBe('VISIT_CONFIRMATION');
      expect(r.booking).toBeUndefined();
      expect(r.response).not.toMatch(/booked/i);
      expect(await visits(lead.customerId)).toHaveLength(0);
      // and the customer still has to say yes in the next turn
      const yes = await call.say('yes');
      expect(yes.booking).toBe('booked');
    });

    it('model failure: first one asks again and keeps the call; a second one hands off to a human with a real task', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('ஆமா');
      llm.run.mockImplementation(async () => ({ text: '', failed: true, aborted: false, error: 'boom', usage: { requests: 1 } }));
      const first = await call.say('is the builder reliable');
      expect(first.actions.endCall).toBeUndefined();
      expect(first.failed).toBe(false);
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, channel: 'human', status: 'open' } })).toBe(0);
      const second = await call.say('what about the builders reputation in chennai');
      expect(second.actions).toMatchObject({ endCall: true, handoff: true });
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, channel: 'human', status: 'open' } })).toBe(1);
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('a model failure on WhatsApp promises a team contact only because a human task was really created', async () => {
      const lead = await newLead();
      llm.run.mockImplementation(async () => ({ text: '', failed: true, aborted: false, error: 'boom', usage: { requests: 1 } }));
      await engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: lead.phone, message: 'tell me about the builder', leadId: lead.leadId });
      await engine.settle(`whatsapp:${ORG}:${lead.phone.replace(/\D/g, '')}`);
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, channel: 'human', status: 'open' } })).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------ control intents
  describe('customer-driven endings are executed by code from the current utterance', () => {
    it('"not interested" on a garbled (weak) transcript is NOT executed - asked again instead', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      const r = await call.say('vendam', 'weak');
      expect(r.actions.notInterested).toBeUndefined();
      expect((await customerOf(lead.customerId)).doNotContact).toBe(false);
    });

    it('a clear "not interested" opts the customer out, stops automation and ends the call', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      const r = await call.say('எனக்கு interest illa, call pannathinga');
      expect(r.actions).toMatchObject({ notInterested: true, endCall: true });
      expect((await customerOf(lead.customerId)).doNotContact).toBe(true);
      expect(await prisma.followUp.count({ where: { customerId: lead.customerId, status: 'scheduled' } })).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------ language
  describe('language handling', () => {
    it('one confident Tamil utterance does not persist any language; a pa-IN STT label is not even an input', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('எனக்கு OMR-ல 2 BHK வேண்டும்');
      expect((await customerOf(lead.customerId)).language).toBeNull();
    });

    it('Tanglish: "Enakku OMR la 2 BHK venum" → area and BHK understood, next question is the budget, in Tamil script voice style', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const r = await call.say('Enakku OMR la 2 BHK venum');
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/Budget/);
      expect(r.response).toMatch(/[஀-௿]/);
      const c = await customerOf(lead.customerId);
      expect(c.location).toBe('OMR');
      expect(c.bhk).toBe(2);
    });

    it('English: "I need a two bedroom apartment in OMR" → English reply asking the budget', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const r = await call.say('I need a two bedroom apartment in OMR');
      expect(r.response).toMatch(/budget/i);
      expect(r.response).not.toMatch(/[஀-௿]/);
      const c = await customerOf(lead.customerId);
      expect(c.location).toBe('OMR');
      expect(c.bhk).toBe(2);
    });

    it('Tamil: "எனக்கு OMR-ல 2 BHK வேண்டும்" → Tamil reply asking the budget', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const r = await call.say('எனக்கு OMR-ல 2 BHK வேண்டும்');
      expect(r.response).toMatch(/[஀-௿]/);
      expect(r.response).toMatch(/Budget|budget/);
    });

    it('English caller: after consistent English the saved language becomes english, replies stay English', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('I am looking for an apartment in OMR please');
      await call.say('my budget is around one crore and I need two bedrooms');
      const r = await call.say('could you tell me what options are available near the beach');
      await engine.settle(call.key);
      expect((await customerOf(lead.customerId)).language).toBe('english');
      expect(r.language).toBe('en-IN');
    });

    it('a stray Tamil word in an English call does not flip the reply language', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('I am looking for an apartment in OMR please');
      await call.say('my budget is around one crore and I need two bedrooms');
      const r = await call.say('seri okay');
      expect(r.response).not.toMatch(/[஀-௿]/);
    });
  });

  // ------------------------------------------------------------------------------------ requirement restated / garbled
  describe('restated requirements and garbled fragments', () => {
    it('"Porur la 2 BHK iruka?" when the enquiry form already said so searches by rules (no model, no new facts needed)', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      const r = await call.say('Porur la 2 BHK iruka? Budget eighty lakhs kulla venum');
      expect(r.response).toMatch(/Green Valley/ /* spoken short name (Residency dropped) */);
      expect(r.path).toBe('rules');
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('a weak, meaningless fragment is asked again by rules instead of being guessed at by the model (twice at most)', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      const a = await call.say('k', 'weak');
      const b = await call.say('k', 'weak');
      expect(a.path).toBe('rules');
      expect(b.path).toBe('rules');
      expect(llm.run).not.toHaveBeenCalled();
      await call.say('Porur la 2 BHK venum'); // a clear turn resets the counter
      expect((await call.say('k', 'weak')).path).toBe('rules');
    });
  });

  // ------------------------------------------------------------------------------------ "no" to our own question
  describe('a bare "no" answers the question we asked; it never opts the customer out', () => {
    it('"no" to "Porur, 2 BHK, 80 lakhs - correct?" starts over, the customer stays contactable', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்'); // -> requirement check question
      const r = await call.say('no');
      expect(r.intent).not.toBe('NOT_INTERESTED');
      expect((await customerOf(lead.customerId)).doNotContact).toBe(false);
      expect(await leadStatus(lead.leadId)).not.toBe('not_interested');
    });
    it('a clear "not interested" in the same spot still opts out', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('I am not interested');
      expect((await customerOf(lead.customerId)).doNotContact).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------ language switching in ONE call
  describe('multilingual calls: the reply follows each utterance, the same session keeps every fact', () => {
    const TA = /[\u0B80-\u0BFF]/;
    const replyIs = (r: any, lang: 'ta' | 'en') => (lang === 'ta' ? expect(r.response).toMatch(TA) : expect(r.response).not.toMatch(TA));
    async function run(script: Array<[string, 'ta' | 'en']>) {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const results = [];
      for (const [utterance, lang] of script) {
        const r = await call.say(utterance);
        replyIs(r, lang);
        results.push(r);
      }
      return { lead, call, results, session: await call.session() };
    }
    const requirement = { ta: 'எனக்கு போரூர்ல 2 BHK வேணும்', tl: 'Enakku Porur la 2 BHK venum', en: 'I need a 2 BHK in Porur' };
    const budget = { ta: 'budget 80 லட்சம் தான்', tl: 'budget 80 lakhs kulla venum', en: 'My budget is around 80 lakhs' };

    it.each([
      ['1. Tamil -> Tamil', [[requirement.ta, 'ta'], [budget.ta, 'ta']]],
      ['2. English -> English', [[requirement.en, 'en'], [budget.en, 'en']]],
      ['3. Tanglish -> Tanglish', [[requirement.tl, 'ta'], [budget.tl, 'ta']]],
      ['4. Tamil -> English', [[requirement.ta, 'ta'], [budget.en, 'en']]],
      ['5. English -> Tamil', [[requirement.en, 'en'], [budget.ta, 'ta']]],
      ['6. Tanglish -> English', [[requirement.tl, 'ta'], [budget.en, 'en']]],
      ['7. English -> Tanglish', [[requirement.en, 'en'], [budget.tl, 'ta']]],
      ['8. Tamil -> Tanglish', [[requirement.ta, 'ta'], [budget.tl, 'ta']]],
    ] as Array<[string, Array<[string, 'ta' | 'en']>]>)('%s: slots kept, no model request', async (_name, script) => {
      const { session } = await run(script);
      expect(session.slots).toMatchObject({ location: 'Porur', bhk: 2, budget: 8_000_000 });
      expect(session.presented.map((p: any) => p.name)).toContain('Green Valley Residency');
      expect(llm.run).not.toHaveBeenCalled();
    });

    it.each([
      ['9. same-turn Tamil + English', 'எனக்கு Porurல 2 BHK வேணும், budget 80 lakhs'],
      ['10. same-turn Tanglish + English', 'Porur la 2 BHK venum, budget is 80 lakhs'],
    ])('%s: everything extracted from one turn, by rules', async (_n, utterance) => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const r = await call.say(utterance);
      expect(r.path).toBe('rules');
      expect((await call.session()).slots).toMatchObject({ location: 'Porur', bhk: 2, budget: 8_000_000 });
      expect(r.response).toMatch(/Green Valley/ /* spoken short name */);
    });

    it('11. Tamil -> English -> Tamil within one call', async () => {
      const { session } = await run([[requirement.ta, 'ta'], ['I want to know the budget options', 'en'], [budget.ta, 'ta']]);
      expect(session.slots).toMatchObject({ location: 'Porur', bhk: 2, budget: 8_000_000 });
    });
    it('12. English -> Tanglish -> English within one call', async () => {
      const { session } = await run([[requirement.en, 'en'], [budget.tl, 'ta'], ['Can you arrange a site visit?', 'en']]);
      expect(session.state).toBe('VISIT_PROPOSAL');
    });
    it('13. Tamil -> Tanglish -> English -> Tamil, ending in a booking only after the explicit yes', async () => {
      const { lead, results, session } = await run([
        ['வணக்கம், பேசலாம்.', 'ta'],
        [requirement.tl, 'ta'],
        ['My budget is around 80 lakhs.', 'en'],
        ['Site visit possible-aa?', 'ta'],
        [`${futureDayText(4).text} morning போகலாம்.`, 'ta'],
        ['ஆமாம்.', 'ta'],
      ]);
      expect(results.slice(0, 5).every((r: any) => r.booking === undefined)).toBe(true);
      expect(results[5].booking).toBe('booked');
      expect(await visits(lead.customerId)).toHaveLength(1);
      expect(session.slots).toMatchObject({ location: 'Porur', bhk: 2, budget: 8_000_000 });
    });
    it('real-call acceptance script, exactly as written in VERIFICATION.md: six turns, four languages, one session, rules only', async () => {
      const day = futureDayText(6).text;
      const { lead, call, results, session } = await run([
        ['வணக்கம், பேசலாம்.', 'ta'],
        ['I need a 2 BHK in Porur.', 'en'],
        ['Budget 60 lakhs தான்.', 'ta'],
        ['Site visit possible-aa?', 'ta'],
        [`${day} morning போகலாம்.`, 'ta'],
        ['Yes, book it.', 'en'],
      ]);
      require('node:fs').writeFileSync(process.env.ACCEPT_OUT ?? '/dev/null', JSON.stringify(results.map((r: any) => ({ state: r.state, path: r.path, lang: r.languageInfo, booking: r.booking, deduped: r.deduped, response: r.response })), null, 1));
      expect(results.map((r: any) => r.path)).toEqual(['rules', 'rules', 'rules', 'rules', 'rules', 'rules']);
      expect(llm.run).not.toHaveBeenCalled();
      // Tamil script with English words ("Budget 60 lakhs தான்") is the mixed style: labelled tanglish, spoken as ta-IN.
      expect(results.map((r: any) => r.languageInfo.current)).toEqual(['tamil', 'english', 'tanglish', 'tanglish', 'tanglish', 'english']);
      expect(results.map((r: any) => r.languageInfo.reply === 'english' ? 'en' : 'ta')).toEqual(['ta', 'en', 'ta', 'ta', 'ta', 'en']);
      expect(results.map((r: any) => r.languageInfo.changed)).toEqual([false, true, true, false, false, true]);
      expect(results[4].state).toBe('VISIT_CONFIRMATION');
      expect(results.slice(0, 5).every((r: any) => r.booking === undefined)).toBe(true);
      expect(results[5].booking).toBe('booked');
      expect(await visits(lead.customerId)).toHaveLength(1);
      expect(session.slots).toMatchObject({ location: 'Porur', bhk: 2, budget: 6_000_000 });
      expect(new Set(results.map((r: any) => r.response)).size).toBe(6);
      expect(call.callId).toBeTruthy();
    });

    it('14-17. switch during qualification, search, proposal and confirmation: "Yes, book it." in English books the Tamil proposal', async () => {
      const { lead, results } = await run([
        ['பேசலாம்', 'ta'],
        ['I need a 2 BHK in Porur', 'en'], // qualification
        ['budget 80 லட்சம் தான்', 'ta'], // search
        ['Can you arrange a site visit?', 'en'], // proposal
        [`${futureDayText(5).text} morning போகலாம்`, 'ta'], // confirmation question (Tamil)
        ['Yes, book it.', 'en'], // confirmation answered in English
      ]);
      expect(results[5].booking).toBe('booked');
      expect(await visits(lead.customerId)).toHaveLength(1);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it.each(['ஆமாம்', 'aama book pannunga', 'Yes, book it.', 'சரி', 'Yes, book pannunga.'])('confirmation "%s" books deterministically (no model)', async (yes) => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('Porur la 2 BHK budget 80 lakhs');
      await call.say(`${futureDayText(4).text} 11 am site visit Green Valley`);
      const r = await call.say(yes);
      expect(r.booking).toBe('booked');
      expect(llm.run).not.toHaveBeenCalled();
    });

    it.each(['இல்லை, 60 லட்சம்.', 'illa, 60 lakhs.', 'No, 60 lakhs.'])('correction "%s" updates the budget, never opts out', async (correction) => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('Porur la 2 BHK venum');
      await call.say('budget 80 lakhs');
      const r = await call.say(correction);
      expect(r.intent).not.toBe('NOT_INTERESTED');
      expect((await call.session()).slots.budget).toBe(6_000_000);
      expect((await customerOf(lead.customerId)).doNotContact).toBe(false);
    });

    it.each(['வேண்டாம்', 'vendam', 'not interested', "I don't want, வேண்டாம்"])('refusal "%s" opts out in any language', async (no) => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const r = await call.say(no);
      expect(r.intent).toBe('NOT_INTERESTED');
      expect((await customerOf(lead.customerId)).doNotContact).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------ fewer model calls, no repeats
  describe('common turns stay deterministic; replies are not repeated or invented', () => {
    it('"no" to "can we talk now?" asks when to call; the customer is NOT opted out', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const r = await call.say('no');
      expect(r.intent).not.toBe('NOT_INTERESTED');
      expect(r.response).toMatch(/call/i);
      expect((await customerOf(lead.customerId)).doNotContact).toBe(false);
      const r2 = await call.say('evening call pannunga');
      expect(r2.actions.outcome).toBe('callback_requested');
    });

    it('"first one paakalaam" / "that one" pick a shown property and ask for the day, by rules', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('Porur la 2 BHK budget 80 lakhs');
      const r = await call.say('that one');
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/Green Valley Residency/);
      expect((await call.session()).state).toBe('VISIT_PROPOSAL');
      const r2 = await call.say('First one paakalaam');
      expect(r2.path).toBe('rules');
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('"what is the price" is answered from inventory, never read as "repeat that"', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('Porur la 2 BHK budget 80 lakhs');
      const r = await call.say('what is the price');
      expect(r.intent).not.toBe('REPEAT_REQUEST');
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/72 lakhs/);
    });

    it('the same question is never asked twice in a row: the next reply moves on', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      const a = await call.say('Porur la 2 BHK venum'); // -> budget question
      const b = await call.say('ok'); // nothing new: the rules would ask the very same budget question
      expect(b.deduped).toBe(true);
      expect(b.response).not.toBe(a.response);
      expect(b.response).toMatch(/budget/i);
      const c = await call.say('Porur la 2 BHK venum'); // restated requirement: asked again in other words, by rules
      expect(c.path).toBe('rules');
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('a model reply that names a property never shown, or a price never quoted, has that sentence removed', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('Porur la 2 BHK budget 80 lakhs');
      llm.run.mockImplementationOnce(async () => ({ text: 'Palm Meadows in Tambaram is also lovely. It costs only 45 lakhs. Green Valley Residency has a park.', failed: false, aborted: false, usage: { requests: 1 } }));
      const r = await call.say('is the neighbourhood good for kids');
      expect(r.path).toBe('llm');
      expect(r.llmFallbackReason).toBeDefined();
      expect(r.response).not.toMatch(/Palm Meadows|45 lakhs/);
      expect(r.response).toMatch(/park/);
    });

    it('voice model turns are limited: one request at most, no search tool, short history', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('Porur la 2 BHK budget 80 lakhs');
      llm.run.mockImplementationOnce(async () => ({ text: 'Yes, it has covered parking.', failed: false, aborted: false, usage: { requests: 1 } }));
      await call.say('does it have covered parking for two cars');
      const args = llm.run.mock.calls[0][0];
      expect(args.toolset).toBe('proposal');
      expect(args.maxTurns).toBe(2);
      expect(args.history.length).toBeLessThanOrEqual(4);
    });

    it('a weak/garbled transcript never confirms a visit, changes language or opts out', async () => {
      const { call, lead } = await callAtConfirmation();
      const before = (await call.session()).language.effective;
      const r = await call.say('yes', 'weak');
      expect(r.booking).toBeUndefined();
      expect((await call.session()).language.effective).toBe(before);
      const r2 = await call.say('not interested', 'weak');
      expect(r2.intent).not.toBe('NOT_INTERESTED');
      expect(await visits(lead.customerId)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------ concurrency
  describe('lead status writers cannot overwrite each other', () => {
    it('an AI "qualified" and a worker "contacted" racing never leave the lead at the older status', async () => {
      for (let i = 0; i < 25; i++) {
        const lead = await newLead();
        await prisma.lead.update({ where: { id: lead.leadId }, data: { status: 'new' } });
        await Promise.all([
          leads.advanceLeadStatus({ organizationId: ORG, leadId: lead.leadId, status: 'qualified' }),
          leads.advanceLeadStatus({ organizationId: ORG, leadId: lead.leadId, status: 'contacted' }),
          leads.advanceLeadStatus({ organizationId: ORG, leadId: lead.leadId, status: 'contacted' }),
        ]);
        expect((await prisma.lead.findUnique({ where: { id: lead.leadId } })).status).toBe('qualified');
      }
    });
  });

  // ------------------------------------------------------------------------------------ metrics
  describe('rule-handled turns do not call the model', () => {
    it('a whole qualification conversation up to a confirmed booking makes zero model requests', async () => {
      const { call } = await callAtConfirmation();
      const r = await call.say('yes');
      expect(r.booking).toBe('booked');
      expect(llm.run).not.toHaveBeenCalled();
    });
  });

  describe('real call 2026-10-09 regressions', () => {
    it.each(['Okay. Cut the call. Okay, cut the call.', 'Cut the call cut the call. Thank you.', 'please hang up', 'call cut pannunga', 'போனை வைங்க', 'கட் பண்ணுங்க'])(
      '"%s" ends the call politely, by rules',
      async (utterance) => {
        const lead = await newLead();
        const call = await phoneCall(lead);
        await call.say('பேசலாம்.');
        const r = await call.say(utterance);
        expect(r.intent).toBe('GOODBYE');
        expect(r.path).toBe('rules');
        expect(r.actions.endCall).toBe(true);
        expect(llm.run).not.toHaveBeenCalled();
      },
    );

    it('"Saturday காலை வச்சிருங்க" (keep it Saturday morning) is not a request to hang up', async () => {
      const { classifyIntent } = await import('../src/conversation/intent.js');
      expect(classifyIntent('Saturday காலை வச்சிருங்க').intent).not.toBe('GOODBYE');
    });

    it('"சரி correct. <noisy transcript>" answers the details check with yes: search by rules, no model', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const call = await phoneCall(lead);
      const check = await call.say('பேசலாம்.');
      expect(check.response).toMatch(/enquiry பண்ணிருந்தீங்க. இப்பவும் அதே தானா\?/); // deliberate wording: form details read back as a check
      const r = await call.say('சரி correct. இது வேணும். இது வேணும். மீசையா? மீசையா? வீட்டு போட்டுக்குவேன். அப்படியே அது கேப்பேன்.');
      expect(r.path).toBe('rules');
      expect(r.state).toBe('PROPERTY_DISCUSSION');
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('a leading yes followed by a hedge or refusal is not a yes', async () => {
      const { leadingAffirmation } = await import('../src/conversation/intent.js');
      expect(leadingAffirmation('சரி. ஆனா budget கம்மி பண்ணணும்')).toBe(false);
      expect(leadingAffirmation('ok. but not now')).toBe(false);
      expect(leadingAffirmation('சரி. வேண்டாம்.')).toBe(false);
      expect(leadingAffirmation('yes correct. this is what I want')).toBe(true);
    });

    it('a model sentence promising to send options on WhatsApp is removed (nothing sends it)', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('Porur la 2 BHK budget 80 lakhs');
      llm.run.mockImplementationOnce(async () => ({ text: 'சரி, புரிஞ்சது. உங்களுக்கு பொருந்துற options வந்ததும் WhatsApp-ல share பண்றேன்.', failed: false, aborted: false, usage: { requests: 1 } }));
      const r = await call.say('is the area safe at night for families');
      expect(r.response).not.toMatch(/WhatsApp/);
    });

    it('WhatsApp: a new budget is answered on the new facts, never swapped for "anything else?"', async () => {
      const lead = await newLead(null);
      const send = (message: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: lead.phone, message, leadId: lead.leadId });
      await send('Porur la 2 BHK venum');
      await send('My budget is 80 lakhs');
      const r = await send('My budget is 1 crore');
      expect(r.deduped).toBeFalsy();
      expect(r.response).not.toMatch(/anything else/i);
    });

    it('the reply prefetched during the opening is exactly what the first turn says', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const call = await phoneCall(lead);
      const likely = engine.likelyFirstReplies((await call.session())!);
      const r = await call.say('பேசலாம்.');
      expect(likely).toContain(r.response);
    });
  });

  describe('real call 2026-10-10 regressions: location correction, rejection, parsing, handoff', () => {
    /** Porur lead, call taken to "which day and time?" for Green Valley Residency (the state of the real call). */
    async function callAtPorurVisitQuestion() {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('ஆமா');
      const ask = await call.say('site visit paakanum');
      expect(ask.state).toBe('VISIT_PROPOSAL');
      return { lead, call };
    }
    const asksVisitTime = (r: any) => /எத்தனை மணிக்கு|எந்த நாள்|which day|what time/i.test(r.response);

    it('TEST 1: "எனக்கு Porur-ல வேண்டாம், Velachery-ல வேணும்." in the Porur visit flow -> Velachery search, no Porur visit, no time question', async () => {
      const { lead, call } = await callAtPorurVisitQuestion();
      const r = await call.say('எனக்கு Porur-ல வேண்டாம், Velachery-ல வேணும்.');
      const s = (await call.session())!;
      expect(s.slots.location).toBe('Velachery');
      expect(r.path).toBe('rules');
      expect(asksVisitTime(r)).toBe(false);
      expect(r.response).toMatch(/Porur வேண்டாம்/);
      expect(r.response).toMatch(/Metro Square/); // the real Velachery row in the test inventory
      expect(r.response).not.toMatch(/Green Valley/);
      expect(s.presented.every((p: any) => /Velachery/.test(p.location))).toBe(true);
      expect(s.proposal?.status === 'pending' && /Green Valley/.test(s.proposal.propertyName)).toBe(false);
      expect(await visits(lead.customerId)).toHaveLength(0);
      // Repeating the area does not fall back into the Porur visit flow either.
      const again = await call.say('Velachery தான் வேணும்');
      expect(asksVisitTime(again)).toBe(false);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('TEST 2: "Porur venda Velachery venum" -> location Velachery', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('Porur venda Velachery venum');
      expect((await call.session())!.slots.location).toBe('Velachery');
    });

    it('TEST 3: "Velachery-la 2 BHK venum" -> real inventory search', async () => {
      const lead = await newLead({ budget: '1 crore' });
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const r = await call.say('Velachery-la 2 BHK venum');
      const s = (await call.session())!;
      expect(s.presented.map((p: any) => p.id)).toEqual(['prop_velachery_metro']);
      expect(r.response).toMatch(/Metro Square/);
      expect(r.path).toBe('rules');
    });

    it('TEST 4: "No, Porur வேண்டாம்" at the Porur confirmation question -> proposal cancelled, nothing booked, other areas offered', async () => {
      const { lead, call } = await callAtConfirmation();
      const r = await call.say('No, Porur வேண்டாம்');
      const s = (await call.session())!;
      expect(r.booking).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
      expect(s.proposal?.status).not.toBe('pending');
      expect(s.slots.location).toBeUndefined();
      expect(r.response).toMatch(/Porur வேண்டாம்/);
      expect(r.response).toMatch(/Velachery/);
      expect(r.response.replace(/Porur வேண்டாம்/, '')).not.toMatch(/Porur/); // Porur is not offered again
      expect(asksVisitTime(r)).toBe(false);
    });

    it('TEST 5: "other area" -> offers areas, never a visit time', async () => {
      const { call } = await callAtPorurVisitQuestion();
      const r = await call.say('other area');
      expect(asksVisitTime(r)).toBe(false);
      expect(r.response).toMatch(/area/);
      expect((await call.session())!.slots.location).toBeUndefined();
      const next = await call.say('Velachery');
      expect(next.response).toMatch(/Metro Square/);
    });

    it('TEST 6 + 7: "tomorrow 11 AM" and "நாளைக்கு 11 மணி" give the same visit time', async () => {
      const { parseWhen } = await import('../src/conversation/when.js');
      const now = new Date();
      expect(parseWhen('tomorrow 11 AM', now)).toEqual(parseWhen('நாளைக்கு 11 மணி', now));
      expect(parseWhen('tomorrow 11 AM', now)).toMatchObject({ hour: 11, minute: 0 });
      for (const t of ['tmrw 11', 'naalaiku morning 11 mani', 'morning 11', 'பதினோரு மணி']) expect(parseWhen(t, now)).toMatchObject({ hour: 11 });
      const { call } = await callAtPorurVisitQuestion();
      const r = await call.say('tomorrow 11 AM');
      expect(r.state).toBe('VISIT_CONFIRMATION');
      const { istParts } = await import('../src/conversation/when.js');
      expect(istParts(new Date((await call.session())!.proposal!.scheduledAt)).hour).toBe(11);
    });

    it('TEST 8-11: budget and BHK words', async () => {
      const { extractSlots } = await import('../src/conversation/slots.js');
      expect(extractSlots('one crore budget').slots.budget).toBe(10_000_000);
      expect(extractSlots('oru kodi budget').slots.budget).toBe(10_000_000);
      expect(extractSlots('budget 80L').slots.budget).toBe(8_000_000);
      expect(extractSlots('0.8 crore').slots.budget).toBe(8_000_000);
      expect(extractSlots('120 lakhs').slots.budget).toBe(12_000_000);
      expect(extractSlots('2 BHK').slots.bhk).toBe(2);
      expect(extractSlots('rendu BHK').slots.bhk).toBe(2);
      expect(extractSlots('two BHK').slots.bhk).toBe(2);
      expect(extractSlots('2 bedroom').slots.bhk).toBe(2);
    });

    it('TEST 12: "yes" at the confirmation question books (valid property, date, time)', async () => {
      const { lead, call } = await callAtConfirmation();
      const r = await call.say('yes');
      expect(r.booking).toBe('booked');
      expect(await visits(lead.customerId)).toHaveLength(1);
    });

    it('TEST 13: "no" at the confirmation question books nothing', async () => {
      const { lead, call } = await callAtConfirmation();
      const r = await call.say('no');
      expect(r.booking).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it.each(['human agent kitta pesanum', 'person kitta pesanum', 'ஒருத்தர் கிட்ட பேசணும்', 'representative', 'call me'])('TEST 14: "%s" -> human handoff', async (t) => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const r = await call.say(t);
      expect(r.intent).toBe('HUMAN_REQUEST');
      expect(r.actions.handoff).toBe(true);
    });

    it('"call me tomorrow" is still a callback, not a handoff', async () => {
      const { classifyIntent } = await import('../src/conversation/intent.js');
      expect(classifyIntent('call me tomorrow').intent).toBe('CALLBACK_REQUEST');
    });

    it('TEST 15: "ok bye" -> conversation completed', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const r = await call.say('ok bye');
      expect(r.state).toBe('COMPLETED');
      expect(r.actions.endCall).toBe(true);
    });

    it('"Venda, adhu venam" / bare "வேண்டாம்" about an offered property turns down THAT property, never "not interested"', async () => {
      for (const t of ['Venda, adhu venam', 'வேண்டாம்', 'not this one']) {
        const lead = await newLead();
        const call = await phoneCall(lead);
        await call.say('பேசலாம்');
        await call.say('ஆமா'); // Green Valley offered
        const r = await call.say(t);
        expect(r.intent).not.toBe('NOT_INTERESTED');
        expect(r.actions.endCall).toBeFalsy();
        expect((await customerOf(lead.customerId)).doNotContact).toBe(false);
        expect((await call.session())!.rejectedPropertyIds).toContain('prop_porur_green_valley');
        expect(r.response).not.toMatch(/Green Valley/);
        expect(asksVisitTime(r)).toBe(false);
      }
    });

    it('a turned-down property is not offered again when the same search runs later', async () => {
      const lead = await newLead();
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('ஆமா');
      await call.say('அது வேண்டாம்');
      const r = await call.say('Porur la 2 BHK budget 80 lakhs');
      expect(r.response).not.toMatch(/Green Valley/);
    });

    it.each([
      ['எனக்கு Porur வேண்டாம் Velachery-ல வேணும்', { location: 'Velachery' }, 'ta-IN'],
      ['enaku Porur venda Velachery la venum', { location: 'Velachery' }, 'ta-IN'],
      ['Enaku 2 BHK apartment Velachery-la venum', { location: 'Velachery', bhk: 2 }, 'ta-IN'],
      ['I need a two BHK in Velachery', { location: 'Velachery', bhk: 2 }, 'en-IN'],
      ['one crore budget', { budget: 10_000_000 }, undefined],
    ])('voice-quality utterance "%s" -> slots %j by rules, reply language %s', async (utterance, slots, lang) => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const r = await call.say(utterance as string);
      expect((await call.session())!.slots).toMatchObject(slots as object);
      expect(r.path).toBe('rules');
      if (lang) expect(r.language === 'ta-IN' || r.language === 'en-IN' ? r.language : (await call.session())!.language.effective === 'english' ? 'en-IN' : 'ta-IN').toBe(lang);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('voice-quality: "naalaiku morning 11 mani" -> visit time 11:00, "yes confirm pannunga" books, all by rules', async () => {
      const { lead, call } = await callAtPorurVisitQuestion();
      const p = await call.say('naalaiku morning 11 mani');
      expect(p.state).toBe('VISIT_CONFIRMATION');
      const { istParts } = await import('../src/conversation/when.js');
      expect(istParts(new Date((await call.session())!.proposal!.scheduledAt)).hour).toBe(11);
      const y = await call.say('yes confirm pannunga');
      expect(y.booking).toBe('booked');
      expect(await visits(lead.customerId)).toHaveLength(1);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('latency: rule-answered turns decide in < 100 ms (p95), measured on the real engine with MariaDB', async () => {
      const samples: number[] = [];
      const script = ['பேசலாம்', 'ஆமா', 'எனக்கு Porur-ல வேண்டாம், Velachery-ல வேணும்.', 'Metro Square paakalam', 'naalaiku morning 11 mani', 'yes'];
      for (let k = 0; k < 4; k++) {
        const lead = await newLead();
        const call = await phoneCall(lead);
        for (const line of script) {
          const t0 = performance.now();
          const r = await call.say(line);
          if (r.path === 'rules') samples.push(performance.now() - t0);
        }
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
      const report = { n: sorted.length, p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +sorted.at(-1)!.toFixed(1) };
      require('node:fs').writeFileSync(process.env.LATENCY_OUT ?? '/dev/null', JSON.stringify(report));
      expect(report.p95).toBeLessThan(100);
      expect(llm.run).not.toHaveBeenCalled();
    });
  });

  describe('real call 2026-10-10 (afternoon): form data, kept visit time, short replies', () => {
    it('"சரிங்க." with form details on file -> read back as a CHECK of the enquiry; the form budget is not spoken', async () => {
      const lead = await newLead({ location: 'Porur', budget: '3 crore', bhk: '2' });
      const call = await phoneCall(lead);
      const r = await call.say('சரிங்க.');
      expect(r.response).toMatch(/enquiry பண்ணிருந்தீங்க/);
      expect(r.response).toMatch(/இப்பவும் அதே தானா\?/);
      expect(r.response).not.toMatch(/crore|கோடி|budget/i);
      for (const same of ['அதே தான்', 'same', 'adhe dhaan']) {
        const l2 = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
        const c2 = await phoneCall(l2);
        await c2.say('சரிங்க.');
        const ok = await c2.say(same);
        expect(ok.state).toBe('PROPERTY_DISCUSSION'); // searched, by rules
      }
    });

    it('"Tomorrow." while choosing between two properties is KEPT; "Green Valley." then asks only the time; booking after yes', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const opts = await call.say('Porur la apartment venum, budget 1 crore');
      expect(opts.response).toMatch(/Green Valley/);
      expect(opts.response).toMatch(/Lake View/);
      await call.say('site visit paakanum');
      const which = await call.say('Tomorrow.');
      expect(which.response).toMatch(/நாளைக்கு/); // the day is acknowledged
      expect(which.response).toMatch(/எதை பாக்கணும்|which one/i);
      expect(which.response).not.toMatch(/எந்த நாள்/);
      expect((await call.session())!.draft?.date).toBeDefined(); // the date was not thrown away
      const time = await call.say('Green Valley.');
      expect(time.response).toMatch(/எத்தனை மணிக்கு/);
      expect(time.response).not.toMatch(/எந்த நாள்/); // the day is already known
      const prop = await call.say('morning 9');
      expect(prop.state).toBe('VISIT_CONFIRMATION');
      const { istParts, addIstDays } = await import('../src/conversation/when.js');
      const at = istParts(new Date((await call.session())!.proposal!.scheduledAt));
      const tomorrow = addIstDays(new Date(), 1);
      expect([at.day, at.hour]).toEqual([tomorrow.day, 9]);
      const yes = await call.say('yes');
      expect(yes.booking).toBe('booked');
      expect(await visits(lead.customerId)).toHaveLength(1);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('day and time given before the property is chosen -> picking it goes straight to the confirmation question', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      await call.say('Porur la apartment venum, budget 1 crore');
      await call.say('naalaikku 11 mani paakalam');
      const r = await call.say('Green Valley');
      expect(r.state).toBe('VISIT_CONFIRMATION');
      expect(r.response).toMatch(/Confirm/);
      expect(await visits(lead.customerId)).toHaveLength(0); // still needs the explicit yes
    });

    it('spoken property list is short: name and price, one question', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const r = await call.say('Porur la apartment venum, budget 1 crore');
      expect(r.response).not.toMatch(/BHK/);
      expect(r.response).not.toMatch(/1 crore budget|Apartment/); // no read-back of what the customer just said
      expect((r.response.match(/\?/g) ?? []).length).toBe(1);
      expect(r.response.length).toBeLessThan(125);
    });
  });

  // Real call 2026-10-10 (evening): normal turns went to the model (2-3 s) or were thrown away; long TTS lines.
  describe('real call 2026-10-10 (evening): no model for normal turns, date/time never lost, short lines', () => {
    it('"ஆ சரி. நீங்க போறீங்களா?" is answered by rules and the pending question is asked again (was: model, 2.8 s)', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('சரிங்க.'); // read-back of the form: "... இப்பவும் அதே தானா?"
      const r = await call.say('ஆ சரி. நீங்க போறீங்களா?');
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/team/);
      expect(r.response).toMatch(/அதே தானா\?/);
      expect(r.booking).toBeUndefined();
      const ai = await call.say('நீங்க AI-ஆ?');
      expect(ai.path).toBe('rules');
      expect(ai.response).toMatch(/AI assistant/);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('"Tomorrow 11 AM." labelled te-IN (weak) is KEPT: options read with the day, the pick goes straight to confirmation', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('சரிங்க.');
      const r = await call.say('Tomorrow 11 AM.', 'weak');
      expect(r.response).not.toMatch(/சரியா கேக்கல/);
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/நாளைக்கு 11 மணி/);
      expect(r.response).toMatch(/Green Valley/);
      const d = (await call.session())!.draft!;
      expect([d.date?.day, d.hour]).toEqual([(await import('../src/conversation/when.js')).addIstDays(new Date(), 1).day, 11]);
      const pick = await call.say('Green Valley');
      expect(pick.state).toBe('VISIT_CONFIRMATION');
      expect(pick.response).toMatch(/^(சரிங்க|ஓகே)\. Green Valley Residency, நாளைக்கு 11 மணி\. Confirm பண்ணட்டுமா\?$/); // cached ack first
      expect(await visits(lead.customerId)).toHaveLength(0);
      const yes = await call.say('ஆமா');
      expect(yes.booking).toBe('booked');
      expect(yes.response).toMatch(/^சூப்பர்\. நாளைக்கு 11 மணிக்கு Green Valley Residency book பண்ணிட்டேன்/);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('"நாளைக்கு காலை ஒம்பது மணி" while details are still missing: kept, next detail asked, no model (was: model, 1.8 s)', async () => {
      const lead = await newLead(null);
      const call = await phoneCall(lead);
      await call.say('பேசலாம்');
      const r = await call.say('நாளைக்கு காலை ஒம்பது மணி');
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/நாளைக்கு 9 மணி/);
      expect(r.response).toMatch(/area/);
      expect((await call.session())!.draft?.hour).toBe(9);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('a weak transcript kept for its time can never confirm a booking', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('சரிங்க.');
      await call.say('naalaikku 11 mani');
      await call.say('Green Valley');
      expect((await call.session())!.state).toBe('VISIT_CONFIRMATION');
      const r = await call.say('yes naalaikku 11 mani', 'weak');
      expect(r.booking).toBeUndefined();
      expect(await visits(lead.customerId)).toHaveLength(0);
    });

    it('budget just given -> the options are named without prices (no read-back of "80 lakhs")', async () => {
      const lead = await newLead({ location: 'Porur', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('சரிங்க.');
      const r = await call.say('எண்பது லட்சம் eighty lakhs.');
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/Green Valley/);
      expect(r.response).not.toMatch(/lakhs|லட்சம்/); // area is said: it was not spoken yet in this call
      expect(r.response.length).toBeLessThan(60);
    });

    it('"என்ன properties இருக்கு?" reads the options by rules', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('சரிங்க.');
      const r = await call.say('என்ன properties இருக்கு?');
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/Green Valley/);
      expect(llm.run).not.toHaveBeenCalled();
    });
  });

  // Real call 2026-10-10 (inbound, 16:54): two model turns that rules should answer, "evening 3" read back as மதியம்,
  // and a WhatsApp "Hi" after the booking offered the old options again.
  describe('real call 2026-10-10 (inbound): location question, "சரி பண்ணிருங்க", evening, WhatsApp after booking', () => {
    it('list says the area when the customer did not; "எந்த location?" is answered from inventory by rules', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
      const call = await phoneCall(lead);
      const list = await call.say('எனக்கு 2 BHK apartment வேணும்.');
      expect(list.response).toMatch(/Porur-ல Green Valley/);
      const where = await call.say('எந்த location?');
      expect(where.path).toBe('rules');
      expect(where.response).toMatch(/Porur-ல/);
      expect(where.response).toMatch(/\?$/);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('"சரி பண்ணிருங்க." to the confirmation question books (was: model re-asked, 2.3 s + a second yes)', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('எனக்கு 2 BHK apartment வேணும்.');
      await call.say('Okay.');
      await call.say('naalaikku');
      const confirm = await call.say("Three o'clock evening.");
      expect(confirm.state).toBe('VISIT_CONFIRMATION');
      expect(confirm.response).toMatch(/சாயங்காலம் 3 மணி/); // the customer said evening
      const yes = await call.say('சரி பண்ணிருங்க.');
      expect(yes.booking).toBe('booked');
      expect(await visits(lead.customerId)).toHaveLength(1);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('WhatsApp "Hi" after a phone booking talks about the booked visit, not the old options', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const send = (message: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: lead.phone, message, leadId: lead.leadId });
      await send('Porur la 2 BHK venum, budget 1 crore'); // chat session with options on the table
      const call = await phoneCall(lead);
      await call.say('சரிங்க.');
      await call.say('அதே தான்');
      await call.say('Green Valley');
      await call.say('naalaikku 11 mani');
      expect((await call.say('ஆமா')).booking).toBe('booked');
      const hi = await send('Hi');
      expect(hi.response).toMatch(/Green Valley/);
      expect(hi.response).toMatch(/booked|book ஆகியிருக்கு|book aagirukku/);
      expect(hi.response).not.toMatch(/Lake View|another area|வேற area/);
    });
  });

  // Real call 2026-10-10 (inbound, 17:16): all rule turns, but the confirmation / booking lines waited 1.3-1.6 s for
  // Sarvam before any audio; WhatsApp then named the wrong (older) visit.
  describe('real call 2026-10-10 (17:16): cached acknowledgement first, the right visits on WhatsApp', () => {
    it('every synthesized rule reply on the phone starts with a pre-recorded acknowledgement; fixed lines do not', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('எனக்கு Porur-ல 2 BHK வேணும்.');
      const ask = await call.say('ம் சரி பார்க்கலாம்.');
      expect(ask.response).toBe('எந்த நாள், எத்தனை மணிக்கு வர முடியும்?'); // fixed line: already cached, no ack
      const confirm = await call.say('Tomorrow 3 PM evening.');
      expect(confirm.response).toMatch(/^(சரிங்க|ஓகே)\. Green Valley Residency, நாளைக்கு சாயங்காலம் 3 மணி\. Confirm பண்ணட்டுமா\?$/);
      const yes = await call.say('சரி பண்ணிருங்க.');
      expect(yes.booking).toBe('booked');
      expect(yes.response).toBe('சூப்பர். நாளைக்கு சாயங்காலம் 3 மணிக்கு Green Valley Residency book பண்ணிட்டேன். Thank you!');
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('WhatsApp "Hi" lists every upcoming visit in time order (not just the earliest)', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const send = (message: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: lead.phone, message, leadId: lead.leadId });
      await send('I need a 2 BHK in Porur, budget 1 crore');
      // An older visit (another property, booked earlier for the day after tomorrow) ...
      const { istDate, addIstDays } = await import('../src/conversation/when.js');
      const d2 = addIstDays(new Date(), 2);
      const { randomUUID } = await import('node:crypto');
      await prisma.siteVisit.create({ data: { id: randomUUID(), organizationId: ORG, leadId: lead.leadId, customerId: lead.customerId, propertyId: 'prop_porur_lake_view', scheduledAt: istDate(d2.year, d2.month, d2.day, 13, 0), status: 'scheduled', updatedAt: new Date() } });
      // ... and the one booked on the phone now, for tomorrow.
      const call = await phoneCall(lead);
      await call.say('சரிங்க.');
      await call.say('அதே தான்');
      await call.say('Green Valley');
      await call.say('naalaikku 3 mani evening');
      expect((await call.say('ஆமா')).booking).toBe('booked');
      const hi = await send('Hi');
      expect(hi.response).toMatch(/^Hi! Your site visit at Green Valley Residency is booked for/); // the one just booked leads
      expect(hi.response).toMatch(/Also booked: Lake View Towers/);
      expect(hi.response).toMatch(/Anything else I can help with\?$/); // nothing cut off by the 3-line chat limit
    });
  });
  // Real call 2026-10-10 (18:38) + brief: WhatsApp list cut off (newest visit missing), date logged as captured=[],
  // long lines, language churn. Letters match the brief's test list (a-l).
  describe('real call 2026-10-10 (18:38): visits on WhatsApp, date state, short lines, confirmation words', () => {
    const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
    async function visitAt(lead: { leadId: string; customerId: string }, propertyId: string, daysAhead: number, hour: number, status = 'scheduled', createdAt?: Date) {
      const { istDate, addIstDays } = await import('../src/conversation/when.js');
      const d = addIstDays(new Date(), daysAhead);
      return prisma.siteVisit.create({ data: { id: randomUUID(), organizationId: ORG, leadId: lead.leadId, customerId: lead.customerId, propertyId, scheduledAt: istDate(d.year, d.month, d.day, hour, 0), status, updatedAt: new Date(), ...(createdAt ? { createdAt } : {}) } });
    }
    const chat = (lead: { phone: string; leadId: string }) => (message: string) => engine.generate({ organizationId: ORG, channel: 'whatsapp', phone: lead.phone, message, leadId: lead.leadId });

    it('(a) WhatsApp "Hi" after older visits + a new phone booking leads with the NEW booking, lists the rest', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const send = chat(lead);
      await send('I need a 2 BHK in Porur, budget 1 crore');
      const hourAgo = new Date(Date.now() - 3 * 3600_000);
      await visitAt(lead, 'prop_porur_lake_view', 1, 13, 'scheduled', hourAgo);
      await visitAt(lead, 'prop_velachery_metro', 1, 15, 'scheduled', hourAgo);
      const call = await phoneCall(lead);
      await call.say('சரிங்க.');
      await call.say('அதே தான்');
      await call.say('Green Valley');
      await call.say('naalaikku saayangaalam 4 mani');
      expect((await call.session())!.state).toBe('VISIT_CONFIRMATION');
      expect((await call.say('பண்ணுங்க.')).booking).toBe('booked');
      const hi = await send('Hi');
      expect(hi.response).toMatch(/^Hi! Your site visit at Green Valley Residency is booked for/);
      expect(hi.response).toMatch(/Also booked: Lake View Towers \(.*\); Metro Square \(/); // older ones, time order
      expect(hi.response).toMatch(/Anything else I can help with\?$/);
    });

    it('(b) all future active visits are retrieved; cancelled and past ones are not; one visit is answered directly', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const send = chat(lead);
      await send('I need a 2 BHK in Porur, budget 1 crore');
      const old = new Date(Date.now() - 5 * 3600_000);
      await visitAt(lead, 'prop_porur_lake_view', 2, 11, 'cancelled', old);
      await visitAt(lead, 'prop_velachery_metro', -2, 11, 'scheduled', old);
      await visitAt(lead, 'prop_omr_sunrise', 3, 16, 'confirmed', old);
      const hi = await send('Hi');
      expect(hi.response).toMatch(/^Hi! Your site visit at Sunrise Heights is booked for .*4 PM\.\nAnything else I can help with\?$/);
      expect(hi.response).not.toMatch(/Lake View|Metro Square/);
      for (const [p, d] of [['prop_porur_green_valley', 1], ['prop_porur_lake_view', 4], ['prop_velachery_metro', 5], ['prop_tambaram_palm', 6]] as const) await visitAt(lead, p, d, 11, 'scheduled', old);
      const many = await send('Hello');
      for (const name of ['Green Valley', 'Sunrise Heights', 'Lake View', 'Metro Square', 'Palm Meadows']) expect(many.response).toContain(name);
      expect(many.response).toMatch(/Anything else I can help with\?$/);
    });

    it('(c) a date-only answer is kept as canonical visit state and logged; (d) it survives into the time turn', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('எனக்கு Porur-ல 2 BHK வேணும்.');
      await call.say('Done. Okay. பார்க்கலாம்.');
      const { istParts, addIstDays } = await import('../src/conversation/when.js');
      const d3 = addIstDays(new Date(), 3);
      const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d3.month - 1];
      const dateOnly = await call.say(`எனக்கு ${d3.day}th ${month}.`);
      expect(dateOnly.response).toMatch(/எத்தனை மணிக்கு/);
      expect((await call.session())!.draft?.date).toEqual({ year: d3.year, month: d3.month, day: d3.day });
      const time = await call.say('சாயங்காலம் நாலு மணிக்கு.');
      expect(time.state).toBe('VISIT_CONFIRMATION');
      const at = istParts(new Date((await call.session())!.proposal!.scheduledAt));
      expect([at.day, at.hour]).toEqual([d3.day, 16]);
      // A weekday that agrees with the date never moves it a week on.
      const { parseWhen, mergeWhen } = await import('../src/conversation/when.js');
      const wd = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d3.weekday];
      const merged = mergeWhen({ date: { year: d3.year, month: d3.month, day: d3.day } }, parseWhen(wd, new Date()));
      expect(merged.date).toEqual({ year: d3.year, month: d3.month, day: d3.day });
    });

    it('(e) 3 PM is read back as evening; (j) the confirmation is short and keeps the exact date', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('எனக்கு Porur-ல 2 BHK வேணும்.');
      await call.say('பார்க்கலாம்');
      const { addIstDays } = await import('../src/conversation/when.js');
      const d3 = addIstDays(new Date(), 3);
      const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d3.month - 1];
      const r = await call.say(`${d3.day} ${month} 3 PM`);
      expect(r.response).toMatch(new RegExp(`Green Valley Residency, ${d3.day} ${month} சாயங்காலம் 3 மணி\\. Confirm பண்ணட்டுமா\\?$`));
      expect(r.response).not.toMatch(/கிழமை/); // no weekday on top of the exact date
      expect(r.response.split(/\s+/).length).toBeLessThanOrEqual(12);
    });

    it('(f) "பண்ணுங்க" and (g) "பண்ணிருங்க" confirm; (h) "பண்ணாதீங்க" never does', async () => {
      for (const [word, books] of [['பண்ணுங்க.', true], ['பண்ணிருங்க', true], ['பண்ணாதீங்க', false]] as const) {
        const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
        const call = await phoneCall(lead);
        await call.say('எனக்கு Porur-ல 2 BHK வேணும்.');
        await call.say('Green Valley');
        await call.say('naalaikku 11 mani');
        expect((await call.session())!.state).toBe('VISIT_CONFIRMATION');
        const r = await call.say(word);
        expect(Boolean(r.booking === 'booked')).toBe(books);
        expect(await visits(lead.customerId)).toHaveLength(books ? 1 : 0);
      }
    });

    it('(i) property alternative is short and says the budget it is above; (k) no model request on any of these turns', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
      const call = await phoneCall(lead);
      const r = await call.say('எனக்கு 3 BHK apartment Porur-ல வேணும்.');
      expect(r.response).not.toMatch(/அந்த budget/);
      expect(r.response).toMatch(/80 lakhs-க்குள்ள இல்லங்க\. Lake View Towers 95 lakhs இருக்கு\. பாக்கலாமா\?$/);
      expect(r.response.replace(/^(சரிங்க|ஓகே)\. /, '').split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(r.path).toBe('rules');
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('(l) follow-ups: one set per booking, none for a repeated booking, and a moved visit leaves no stale steps', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '2' });
      const book = async (when: string) => {
        const call = await phoneCall(lead);
        await call.say('எனக்கு Porur-ல 2 BHK வேணும்.');
        await call.say('Green Valley');
        await call.say(when);
        expect((await call.session())!.state).toBe('VISIT_CONFIRMATION');
        return call.say('ஆமா');
      };
      const steps = async (status = 'scheduled') => prisma.followUp.findMany({ where: { leadId: lead.leadId, source: { in: ['visit', 'alert'] }, status } });
      expect((await book('naalaikku 11 mani')).booking).toBe('booked');
      const first = await steps();
      expect(first.length).toBeGreaterThan(0);
      expect(new Set(first.map((f: any) => f.message)).size).toBe(first.length); // no duplicates
      const again = await book('naalaikku 11 mani'); // same property, same time
      expect(again.booking).toBe('duplicate');
      expect((await steps()).length).toBe(first.length); // nothing new
      expect((await book('naalaikku 3 mani evening')).booking).toBe('booked'); // moved
      const visitsNow = await visits(lead.customerId);
      const live = visitsNow.find((v: any) => v.status === 'scheduled')!;
      const pending = await steps();
      expect(pending.every((f: any) => f.message.endsWith(live.id))).toBe(true); // only the live visit's steps remain
      expect((await steps('cancelled')).some((f: any) => f.message.startsWith('visit:after:'))).toBe(true); // incl. after-visit
    });
  });

  // Real calls 2026-10-10 20:28 / 20:29 (outbound): "Anna Nagar Residency" taken as an area and searched with the old
  // BHK / budget; "சரிங்க, Porur வேண்டாம்." never said by the customer; "Hello" / "sound இல்லையா?" not understood;
  // "Budget இல்ல area மாத்தலாமா?" -> "ஆமா" -> the read-back again, in a loop.
  describe('real calls 2026-10-10 (20:28): named property, no dead ends, line checks, honest wording', () => {
    const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
    beforeAll(async () => {
      await prisma.property.upsert({
        where: { id: 'prop_test_anna_nagar' },
        update: {},
        create: { id: 'prop_test_anna_nagar', organizationId: ORG, name: 'Anna Nagar Residency', location: 'Anna Nagar, Chennai', type: 'Apartment', bhk: 2, price: 11_000_000, status: 'available', updatedAt: new Date() },
      });
      engine.clearInventoryCache();
    });
    afterAll(async () => {
      await prisma.siteVisit.deleteMany({ where: { propertyId: 'prop_test_anna_nagar' } });
      await prisma.property.deleteMany({ where: { id: 'prop_test_anna_nagar' } });
      engine.clearInventoryCache();
    });

    it('call 1: "Hello இது பேசுங்க இந்த Anna Nagar Residency." offers THAT property (2 BHK, 1.1 crore) - no "Porur வேண்டாம்", no dead end', async () => {
      const lead = await newLead({ location: 'Porur', budget: '80 lakhs', bhk: '3' });
      const call = await phoneCall(lead);
      const r = await call.say('Hello இது பேசுங்க இந்த Anna Nagar Residency.');
      expect(r.path).toBe('rules');
      expect(r.response).toMatch(/Anna Nagar Residency, 2 BHK, 1\.1 crore\. பாக்கலாமா\?$/);
      expect(r.response).not.toMatch(/வேண்டாம்|இல்லங்க|மாத்தலாமா/);
      expect((await call.session())!.presented.map((p: any) => p.id)).toEqual(['prop_test_anna_nagar']);
      const sound = await call.say('sound இல்லையா?');
      expect(sound.path).toBe('rules'); // was the model, 3.4 s
      expect(sound.response).toMatch(/^கேக்குதுங்க, சொல்லுங்க\. .*பாக்கலாமா\?$/);
      const notTalking = await call.say('Hello என்ன பேசவே மாட்டேங்குது.');
      expect(notTalking.path).toBe('rules');
      expect(notTalking.response).toMatch(/^கேக்குதுங்க/);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('call 2: read-back -> "அப்போ Anna Nagar Residency-ல" -> "Hello." -> "ஆமா." goes forward to the visit; the read-back is never repeated', async () => {
      const lead = await newLead({ location: 'OMR', budget: '80 lakhs', bhk: '3' });
      const call = await phoneCall(lead);
      const first = await call.say('ஆமா.');
      expect(first.response).toMatch(/அதே தானா\?/);
      const named = await call.say('அப்போ Anna Nagar Residency-ல');
      expect(named.response).toMatch(/Anna Nagar Residency, 2 BHK, 1\.1 crore/);
      expect(named.response).not.toMatch(/OMR வேண்டாம்/);
      const hello = await call.say('Hello.');
      expect(hello.response).toMatch(/^கேக்குதுங்க/);
      expect(hello.response).not.toMatch(/சூப்பர்|enquiry/);
      const yes = await call.say('ஆமா.');
      expect(yes.response).toMatch(/எந்த நாள்|எத்தனை மணி/); // on to the visit
      const all = [first, named, hello, yes].map((x) => x.response).join(' ');
      expect(all.match(/enquiry பண்ணிருந்தீங்க/g)?.length).toBe(1);
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('"இல்ல Anna Nagar Residency-ல." to the read-back offers the property (not "start over, which area?")', async () => {
      const lead = await newLead({ location: 'OMR', budget: '80 lakhs', bhk: '3' });
      const call = await phoneCall(lead);
      await call.say('ஆமா.');
      const r = await call.say('இல்ல Anna Nagar Residency-ல.');
      expect(r.response).toMatch(/Anna Nagar Residency/);
      expect(r.response).not.toMatch(/புதுசா பாக்கலாம்|எந்த area/);
    });

    it('no exact match is never a dead end: the nearest real option is offered (same area, other size)', async () => {
      const lead = await newLead({ location: 'Velachery', budget: '80 lakhs', bhk: '3' });
      const call = await phoneCall(lead);
      await call.say('ஆமா.');
      const r = await call.say('அதே தான்');
      expect(r.response).toMatch(/Velachery-ல 3 BHK 80 lakhs-க்குள்ள இல்லங்க\. Metro Square 2 BHK 84 lakhs இருக்கு\. பாக்கலாமா\?$/);
      const yes = await call.say('ஆமா');
      expect(yes.response).toMatch(/எந்த நாள்|எத்தனை மணி/);
      expect(yes.response).not.toMatch(/enquiry/);
    });

    it('naming another area is a switch, not "X வேண்டாம்"; turning an area down still says so', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const call = await phoneCall(lead);
      const r = await call.say('Velachery-ல வேணும்');
      expect(r.response).not.toMatch(/Porur வேண்டாம்/);
      const lead2 = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      const call2 = await phoneCall(lead2);
      const r2 = await call2.say('Porur வேண்டாம், Velachery வேணும்');
      expect(r2.response).toMatch(/Porur வேண்டாம்/);
    });

    it('an area alone ("Anna Nagar-ல வேணும்") is an area search, not the property with that area in its name', async () => {
      const lead = await newLead({ location: 'Porur', budget: '2 crore', bhk: '2' });
      const call = await phoneCall(lead);
      await call.say('ஆமா.');
      const r = await call.say('Anna Nagar-ல வேணும்');
      expect((await call.session())!.slots.location).toBe('Anna Nagar');
      expect(r.response).toMatch(/Anna Nagar/);
    });

    it('a customer saved as English on WhatsApp, Tamil opening: a neutral "yes" is answered in Tamil', async () => {
      const lead = await newLead({ location: 'Porur', budget: '1 crore', bhk: '2' });
      await prisma.customer.update({ where: { id: lead.customerId }, data: { language: 'english' } });
      const callId = `call-${randomUUID()}`;
      await engine.openCallSession({ organizationId: ORG, callId, phone: lead.phone, leadId: lead.leadId, openingText: 'Hi Ravi, Tacksharp Realty-ல இருந்து AI assistant பேசுறேன். பேசலாமா?' });
      const r = await engine.generate({ organizationId: ORG, channel: 'voice', phone: lead.phone, message: 'yes', leadId: lead.leadId, callContext: { direction: 'outbound', callId, reason: 'test' } });
      expect(r.response).toMatch(/[\u0B80-\u0BFF]/u);
    });
  });
});
