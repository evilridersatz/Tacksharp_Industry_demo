import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import plivo from 'plivo';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiService } from '../ai/ai.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { SarvamService } from '../sarvam/sarvam.service.js';
import { bindOrganization, providerCredentials, type ResolvedCredentials } from '../integrations/provider-scope.js';
import { config } from '../common/config.js';
import { normalizePhone } from '../common/phone.js';
import { nextAllowedCallTime } from '../common/time.js';
import { effectiveCallWindow, nextRetryAt } from '../settings/tenant-settings.js';
import { errorMessage, log, timer } from '../common/logger.js';
import { mask } from '../whatsapp/whatsapp-sender.service.js';
import { firstName } from '../whatsapp/message-templates.js';
import { HANGUP, escapeXml, recordXml, response, sayXml, streamXml } from './plivo-xml.js';
import { buildCallSummary } from './call-summary.js';
import { recordTurn } from '../common/latency.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { DemoSessionsService } from '../demo-sessions/demo-sessions.service.js';
import { TenancyService, type Vertical } from '../tenancy/tenancy.service.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';
import { spoken } from '../restaurant/replies.js';
import { assessTranscript } from '../conversation/transcript-gate.js';
import { ACK_LINES, staticVoiceLines } from '../conversation/replies.js';
import { TurnDedupe, type DedupeRedis } from './turn-dedupe.js';
import { queueRedis } from '../queues/queues.js';
import {
  ENGLISH_FALLBACK,
  FILLERS,
  PROMPTS,
  callReason,
  inboundOpening,
  inboundCallReason,
  outboundOpening,
  outboundOpeningEnglish,
  industryOpening,
  industryCallReason,
} from './voice.prompts.js';

const MAX_TURNS = 24;
const MAX_SILENT_TURNS = 2;
/** Restaurant goodbyes that promise nothing the system does not do. */
const RESTAURANT_TOO_LONG = 'இந்த call ரொம்ப நேரம் ஆயிடுச்சு. மீதி details WhatsApp-ல சொல்லுங்க. நன்றி!';
const RESTAURANT_NO_RESPONSE = 'சரிங்க, இப்போ பேச முடியல போல. எப்போ வேணும்னாலும் WhatsApp-ல order பண்ணலாம். நன்றி!';

/**
 * When does a call end after a customer turn? Documented terminal conditions only:
 *  - the conversation engine says the customer ended it (explicit goodbye, done after their order, asked for staff);
 *  - the call reached MAX_TURNS (bounded length);
 *  - real estate only: the engine failed (it says sorry and that the team will call back, and a task is created).
 * A restaurant turn whose processing failed already asked the customer to repeat: the call stays open.
 * Every other answer keeps the call open.
 */
export function decideCallEnd(p: { vertical: Vertical; turns: number; maxTurns: number; endCall: boolean; endReason?: string; failed: boolean }): { end: boolean; reason?: string } {
  if (p.endCall) return { end: true, reason: p.endReason ?? 'conversation_end' };
  if (p.turns >= p.maxTurns) return { end: true, reason: 'max_turns' };
  if (p.failed && p.vertical !== 'restaurant') return { end: true, reason: 'technical' };
  return { end: false };
}

export type StartCallResult =
  | { started: true; callId: string }
  | { started: false; reason: string; retryAt?: Date };

type PlivoParams = Record<string, string | undefined>;

/**
 * Everything the turn handler needs about a live call, kept in memory so a turn does not re-read the
 * call / customer / lead from the database. Rebuilt from the database if the API restarted mid-call.
 */
export type CallRuntime = {
  callId: string;
  organizationId: string;
  /** The organization's product: decides the opening line, the conversation engine and the STT vocabulary. */
  vertical: Vertical;
  /** Speech-to-text vocabulary for this business (restaurant: its products, cuts, shops). Undefined = service default. */
  keyterms?: string[];
  /** Why WE ended the call (customer_goodbye, max_turns, no_response, technical...). */
  endReason?: string;
  customerId: string;
  leadId?: string;
  phone: string;
  direction: 'outbound' | 'inbound';
  reason: string;
  providerCallId?: string;
  sessionKey: string;
  turns: number;
  silentTurns: number;
  ended: boolean;
  /** Static prompts ("could you repeat") are spoken in English once the customer has been speaking English. */
  english: boolean;
  outcome?: string;
  startedAt: number;
  /** Last processed recording: Plivo retries the same webhook -> same answer, no second AI turn. */
  last?: { key: string; xml: string };
  /** Recordings being processed right now: a retry joins the running work instead of starting another turn. */
  inflight: Map<string, Promise<string>>;
  /** Audio of the last reply we played (replayed after repeated silence instead of "can you hear me"). */
  lastAudioUrl?: string;
  /** Opening line audio; in real-time mode it is played over the stream instead of a <Play>. */
  openingUrl?: string;
  /** Opening line text (real-time mode compares echo of it against what the caller "said"). */
  openingText?: string;
};

type GenerateResult = Awaited<ReturnType<AiService['generateResponse']>>;
/**
 * A reply that names one customer's order (order number) or contains a phone-length number is personal: its audio
 * is made for this call only and deleted after it, never stored in the shared disk cache (which is keyed by text and
 * kept for days). Generic rule replies ("How many kg of Boneless Chicken?") are still cached and reused.
 */
export function isPersonalLine(text: string): boolean {
  return /\b[A-Z]{2,4}-[A-Z0-9]{4,}\b/.test(text) || /\d[\d\s-]{6,}\d/.test(text);
}

export type ReplyTurn = { kind: 'reply'; turns: number; result: GenerateResult; finalText: string; end: boolean; cacheable: boolean };
export type UnclearTurn = { kind: 'unclear'; text: string; english: string; replayUrl?: string; end: boolean };
export type DecidedTurn = ReplyTurn | UnclearTurn;

const STALE_RUNTIME_MS = 60 * 60_000;

/** The ~10 lines worth having on disk before the first call (see warmStaticAudio). Tamil first; English acks too. */
export function startupAudioLines(): string[] {
  const lines = [
    ...ACK_LINES.ta,
    ...FILLERS.ta,
    PROMPTS.didntHear,
    PROMPTS.unclear,
    PROMPTS.lineIssue,
    ...ACK_LINES.en,
  ];
  return [...new Set(lines.map((line) => VoiceService.cleanForSpeech(line)))];
}

@Injectable()
export class VoiceService implements OnModuleInit, OnModuleDestroy {
  private client?: InstanceType<typeof plivo.Client>;
  /** Opening audio generated before dialing so the customer hears it instantly on answer. */
  private readonly openingAudio = new Map<string, { url: string; text: string }>();
  /** XML returned on answer, so a repeated answer webhook doesn't save the greeting twice. */
  private readonly answerXml = new Map<string, string>();
  /** Generated audio files per call, deleted when the call ends. */
  private readonly callAudio = new Map<string, string[]>();
  private readonly calls = new Map<string, CallRuntime>();
  private readonly mutex = new KeyedMutex();
  private readonly orgNames = new Map<string, { at: number; name: string }>();
  /** Voice lines with no customer-specific content: synthesized once, then played from the audio cache. */
  private readonly staticReplies = new Set<string>(staticVoiceLines().map((line) => VoiceService.cleanForSpeech(line)));
  private sweeper?: NodeJS.Timeout;
  /** One AI turn per recording across restarts and instances (Redis); see TurnDedupe. */
  readonly turnDedupe = new TurnDedupe(queueRedis as unknown as DedupeRedis);

  private trackAudio(callId: string, url: string) {
    if (!url) return;
    const list = this.callAudio.get(callId) ?? [];
    list.push(url);
    this.callAudio.set(callId, list);
  }

  private async releaseCall(callId: string) {
    const files = this.callAudio.get(callId) ?? [];
    this.callAudio.delete(callId);
    this.calls.delete(callId);
    this.answerXml.delete(callId);
    this.openingAudio.delete(callId);
    await this.sarvam.deleteAudio(files);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly conversations: ConversationsService,
    private readonly leads: LeadsService,
    private readonly followUps: FollowUpsService,
    private readonly sarvam: SarvamService,
    private readonly tenancy: TenancyService,
    @Optional() private readonly demoSessions?: DemoSessionsService,
  ) {
    // A call whose hang-up webhook never arrives must not stay in memory forever.
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - STALE_RUNTIME_MS;
      for (const [id, rt] of this.calls) if (rt.startedAt < cutoff) this.calls.delete(id);
    }, 10 * 60_000);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  async onModuleInit() {
    // Bias STT toward inventory place / project names (used with saaras:v4).
    try {
      const properties = await this.prisma.property.findMany({
        where: { organizationId: config.defaultOrganizationId },
        select: { name: true, location: true },
        take: 200,
      });
      const terms = new Set([...this.sarvam.keyterms]);
      for (const p of properties) {
        terms.add(p.location.split(',')[0].trim());
        terms.add(p.name.trim());
      }
      this.sarvam.keyterms = [...terms].filter((t) => t && t.length <= 64).slice(0, 50);
    } catch (error) {
      log.warn('voice.keyterms_failed', { error: errorMessage(error) });
    }
    // Warm the audio cache for every fixed line (a few seconds in the background; later calls play them with no TTS call).
    void this.warmStaticAudio();
  }

  /** While the opening line plays, synthesize the reply the rules will most likely give next (cached on disk). */
  private prefetchFirstReply(session: Parameters<AiService['likelyFirstReplies']>[0]) {
    for (const text of this.ai.likelyFirstReplies(session)) {
      void this.sarvam.textToSpeech(text, { cache: true, priority: 'live' }).catch(() => undefined); // needed within seconds
    }
  }

  /**
   * Startup warm-up: only the handful of lines played the instant a turn ends (acks, wait lines, "didn't hear").
   * Everything else is synthesized when first needed and then cached on disk. Warming 100+ lines at startup used
   * to run into Sarvam HTTP 429 rate limits just as the first call started.
   * One request at a time, background priority, never while a call is live, and a 429 ends the warm-up
   * (no retries): Sarvam capacity belongs to callers.
   */
  async warmStaticAudio() {
    if (!this.sarvam.enabled) {
      // Without TTS every reply falls back to Plivo's English <Speak> (or silence for Tamil): say so at startup.
      log.error('voice.tts_disabled', { key: 'SARVAM_API_KEY', effect: 'calls have no Tamil audio; replies fall back to Plivo English speech' });
      return;
    }
    const lines = startupAudioLines();
    let made = 0;
    let cached = 0;
    let sample = '';
    for (const line of lines) {
      while (this.calls.size > 0) await new Promise((resolve) => setTimeout(resolve, 2000)); // a live call has priority
      const r = await this.sarvam.textToSpeech(line, { cache: true, priority: 'background' }).catch(() => undefined);
      if (r?.url) sample ||= r.url;
      if (r?.url && r.cached) cached++;
      if (r && !r.cached && r.url) {
        made++;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (!r?.url) {
        // Rate limit, wrong key or outage: stop. Calls still work - each line is synthesized when first needed.
        log.warn('voice.static_audio_stopped', { reason: r?.error ?? 'tts failed', synthesized: made, alreadyCached: cached, remaining: lines.length - lines.indexOf(line) - 1 });
        return;
      }
    }
    // synthesized = new Sarvam requests now; alreadyCached = valid audio files from an earlier run (synthesized: 0
    // with alreadyCached = lines is normal after a restart — it does NOT mean audio failed).
    log.info('voice.static_audio_ready', { lines: lines.length, synthesized: made, alreadyCached: cached });
    if (sample) void this.checkAudioReachable(sample);
  }

  /**
   * Can Plivo fetch our audio? In record mode Plivo downloads every reply from PUBLIC_BASE_URL/voice/audio/...; if
   * that URL is not public, or a tunnel answers with an HTML page instead of the WAV, the transcript still appears on
   * the dashboard but the caller hears nothing. One GET of a cached prompt at startup, logged (no audio, no secrets).
   */
  async checkAudioReachable(url: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; reason?: string; status?: number; contentType?: string }> {
    const base = config.publicBaseUrl;
    let result: { ok: boolean; reason?: string; status?: number; contentType?: string };
    if (!/^https:\/\//i.test(base) || /^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(base)) {
      result = { ok: false, reason: 'not_public_https' };
    } else {
      try {
        const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'tacksharp-audio-check' } });
        const contentType = res.headers.get('content-type') ?? '';
        const head = Buffer.from(await res.arrayBuffer()).subarray(0, 12).toString('ascii');
        result = res.ok && /audio\/(x-)?wav/i.test(contentType) && head.startsWith('RIFF')
          ? { ok: true, status: res.status, contentType }
          : { ok: false, reason: res.ok ? 'not_audio' : 'http_error', status: res.status, contentType };
      } catch (error) {
        result = { ok: false, reason: `unreachable:${errorMessage(error).slice(0, 80)}` };
      }
    }
    if (result.ok) log.info('voice.audio_url_check', { ok: true, status: result.status, contentType: result.contentType, mode: config.voice.mode });
    else
      log.error('voice.audio_url_check', {
        ...result,
        key: 'PUBLIC_BASE_URL',
        mode: config.voice.mode,
        effect: config.voice.mode === 'record' ? 'Plivo cannot download reply audio: callers hear silence' : 'stream mode sends audio over the socket; the URL is still needed for webhooks',
      });
    return result;
  }

  private async orgName(organizationId: string): Promise<string> {
    const hit = this.orgNames.get(organizationId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    const name = org?.name ?? config.defaultOrganizationName;
    this.orgNames.set(organizationId, { at: Date.now(), name });
    return name;
  }

  /** The opening line for a call WE placed: a restaurant never mentions property, a real-estate lead its enquiry. */
  /** Industry from Settings for call wording (tests may pass an AI stub without it). */
  private async industryOf(organizationId: string): Promise<string | null> {
    return typeof this.ai.industry === 'function' ? this.ai.industry(organizationId).catch(() => null) : null;
  }

  private outboundOpeningFor(vertical: Vertical, customer: Parameters<typeof outboundOpening>[0] & { language?: string | null }, orgName: string, industry?: string | null) {
    if (vertical !== 'restaurant') {
      const other = industryOpening(industry, customer, orgName);
      if (other) return other;
    }
    if (vertical === 'restaurant') return spoken.outboundOpening(customer.language === 'english' ? 'en' : 'ta', { name: firstName(customer.name) || undefined, business: orgName });
    return outboundOpening(customer, orgName, config.voice.agentName);
  }

  /**
   * The Plivo client for the account that serves this organization (resolved credentials: its own saved, tested
   * account, or the deployment's environment account for pre-existing organizations). Never another organization's.
   */
  private plivo(creds?: ResolvedCredentials) {
    const authId = creds?.source === 'organization' ? creds.secrets.authId : config.plivo.authId;
    const authToken = creds?.source === 'organization' ? creds.secrets.authToken : config.plivo.authToken;
    if (!authId || !authToken) throw new Error('Plivo is not configured for this organization');
    if (creds?.source === 'organization') {
      let c = this.orgClients.get(authId);
      if (!c || c.token !== authToken) {
        c = { token: authToken, client: new plivo.Client(authId, authToken) };
        this.orgClients.set(authId, c);
      }
      return c.client;
    }
    this.client ??= new plivo.Client(authId, authToken);
    return this.client;
  }

  private readonly orgClients = new Map<string, { token: string; client: InstanceType<typeof plivo.Client> }>();

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async startOutboundCall(params: {
    organizationId?: string;
    customerId: string;
    leadId?: string;
    followUpId?: string;
    ignoreCallWindow?: boolean;
  }): Promise<StartCallResult> {
    const organizationId = params.organizationId ?? config.defaultOrganizationId;
    const customer = await this.prisma.customer.findFirst({ where: { id: params.customerId, organizationId } });
    if (!customer?.phone) return { started: false, reason: 'customer_has_no_phone' };
    if (customer.doNotContact) return { started: false, reason: 'do_not_contact' };
    // STOP (any business type): never call a customer who opted out.
    if (customer.optedOutAt) return { started: false, reason: 'opted_out' };
    const vertical = await this.tenancy.vertical(organizationId);
    if (vertical === 'restaurant') {
      // Restaurant customers: the same consent and dry-run rules as order follow-ups. A dashboard or script
      // "call now" never rings a number that is not explicitly approved for live testing.
      if (!customer.callingConsent) return { started: false, reason: 'no_calling_consent' };
      const gate = liveGate(followUpConfig(), customer);
      if (!gate.live) {
        log.info('voice.call_not_live', { customerId: customer.id, reason: gate.reason });
        return { started: false, reason: `not_live: ${gate.reason}` };
      }
    }
    bindOrganization(organizationId);
    const pv = await providerCredentials('plivo', organizationId);
    if (pv.source === 'none') return { started: false, reason: `plivo_not_configured: ${pv.reason ?? 'no account'}` };
    const fromNumber = pv.source === 'organization' ? pv.config.fromNumber : config.plivo.fromNumber;
    if (!fromNumber) return { started: false, reason: 'PLIVO_FROM_NUMBER missing' };

    if (!params.ignoreCallWindow) {
      // The business's own window, never wider than the deployment's legal window from .env.
      const w = effectiveCallWindow(await this.followUps.settingsFor(organizationId));
      const allowedAt = nextAllowedCallTime(new Date(), w.start, w.end);
      if (allowedAt.getTime() > Date.now() + 60_000) {
        return { started: false, reason: 'outside_call_window', retryAt: allowedAt };
      }
    }

    // Duplicate-call guard: one live call per customer.
    const live = await this.prisma.call.findFirst({
      where: {
        customerId: customer.id,
        status: { in: ['queued', 'ringing', 'in_progress'] },
        createdAt: { gt: new Date(Date.now() - 20 * 60_000) },
      },
    });
    if (live) return { started: false, reason: 'call_already_in_progress' };

    // DRY_RUN (default) means no call is placed for ANY business type, and a demo (synthetic) customer is never
    // dialled. Production sets DRY_RUN=false deliberately.
    if (process.env.DRY_RUN !== 'false') {
      log.info('voice.call_not_live', { customerId: customer.id, reason: 'DRY_RUN is on' });
      return { started: false, reason: 'not_live: DRY_RUN is on (no call placed)' };
    }
    if (customer.isDemo) return { started: false, reason: 'not_live: demo customer (synthetic number)' };

    // Leads are the real-estate pipeline; a restaurant call belongs to the customer only.
    const lead =
      vertical === 'restaurant'
        ? null
        : params.leadId
          ? await this.prisma.lead.findFirst({ where: { id: params.leadId, organizationId } })
          : await this.leads.ensureActiveLead(organizationId, customer.id, 'voice');
    if (!lead && vertical !== 'restaurant') return { started: false, reason: 'lead_not_found' };

    const attempt =
      (await this.prisma.call.count({ where: lead ? { leadId: lead.id, direction: 'outbound' } : { customerId: customer.id, direction: 'outbound' } })) + 1;

    const call = await this.prisma.call.create({
      data: {
        organizationId,
        customerId: customer.id,
        leadId: lead?.id ?? null,
        direction: 'outbound',
        status: 'queued',
        toNumber: customer.phone,
        fromNumber,
        attempt,
        followUpId: params.followUpId,
      },
    });

    // Prepare the opening line before dialing (TTS ~1s) so there is no silence on answer.
    const organization = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    const orgName = organization?.name ?? config.defaultOrganizationName;
    const openingText = this.outboundOpeningFor(vertical, customer, orgName, await this.industryOf(organizationId));
    const openingUrl = await this.sarvam.textToSpeechUrl(openingText);
    this.trackAudio(call.id, openingUrl);
    this.openingAudio.set(call.id, { url: openingUrl, text: openingText });
    setTimeout(() => this.openingAudio.delete(call.id), 30 * 60_000).unref();

    const base = config.publicBaseUrl;
    try {
      const result = await this.plivo(pv).calls.create(
        fromNumber,
        customer.phone,
        `${base}/voice/answer?callId=${call.id}`,
        {
          answerMethod: 'POST',
          hangupUrl: `${base}/voice/hangup?callId=${call.id}`,
          hangupMethod: 'POST',
          ringTimeout: config.plivo.ringTimeoutSec,
          timeLimit: config.plivo.maxCallSec,
        },
      );
      const requestUuid = (result as { requestUuid?: string | string[] }).requestUuid;
      await this.prisma.call.update({
        where: { id: call.id },
        data: {
          status: 'ringing',
          providerRequestId: Array.isArray(requestUuid) ? requestUuid[0] : requestUuid,
        },
      });
      log.info('voice.dialing', { callId: call.id, leadId: lead?.id, vertical, to: mask(customer.phone), attempt });
      return { started: true, callId: call.id };
    } catch (error) {
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', outcome: 'failed', hangupCause: errorMessage(error).slice(0, 190), endedAt: new Date() },
      });
      log.error('voice.dial_failed', { callId: call.id, error: errorMessage(error) });
      await this.releaseCall(call.id);
      return { started: false, reason: `plivo_error: ${errorMessage(error)}` };
    }
  }

  /** Plivo answer_url for outbound calls. */
  async answerOutbound(callId: string, params: PlivoParams) {
    const call = await this.prisma.call.findUnique({ where: { id: callId }, include: { customer: true, lead: true } });
    if (!call) {
      log.warn('voice.answer_unknown_call', { callId });
      return response(HANGUP);
    }
    const repeated = this.answerXml.get(call.id);
    if (repeated) {
      log.info('voice.answer_duplicate', { callId });
      return repeated;
    }
    const alreadyAnswered = Boolean(call.answeredAt);
    const orgName = await this.orgName(call.organizationId);
    const vertical = await this.tenancy.vertical(call.organizationId);
    const industry = await this.industryOf(call.organizationId);

    let opening = this.openingAudio.get(call.id);
    if (!opening) {
      const text = this.outboundOpeningFor(vertical, call.customer, orgName, industry);
      opening = { text, url: await this.sarvam.textToSpeechUrl(text) };
    }

    const reason = vertical === 'restaurant' ? 'Restaurant call: help the customer order or answer questions about their order.' : industryCallReason(industry, orgName) ?? callReason(call.customer, call.lead?.source);
    const rt = this.newRuntime(call, call.customer.phone!, 'outbound', reason, call.lead?.id, vertical);
    rt.providerCallId = params.CallUUID;
    const markAnswered = this.prisma.call.update({
      where: { id: call.id },
      data: { status: 'in_progress', answeredAt: call.answeredAt ?? new Date(), providerCallId: params.CallUUID ?? call.providerCallId },
    });
    if (vertical === 'restaurant') {
      // The restaurant ordering session (shared customer, same rules as WhatsApp); no real-estate session or lead.
      const [, keyterms] = await Promise.all([
        alreadyAnswered ? undefined : this.ai.openRestaurantCall({ organizationId: call.organizationId, phone: call.customer.phone!, customerName: call.customer.name ?? undefined, openingText: opening.text, callId: call.id }),
        this.ai.restaurantKeyterms(call.organizationId).catch(() => undefined),
        markAnswered,
      ]);
      rt.keyterms = keyterms;
    } else {
      // The call row and the call-scoped conversation session are independent: do both at once.
      const [session] = await Promise.all([
        this.ai.openCallSession({
          organizationId: call.organizationId,
          callId: call.id,
          phone: call.customer.phone!,
          leadId: call.leadId ?? undefined,
          customerName: call.customer.name ?? undefined,
          openingText: opening.text,
          direction: 'outbound',
        }),
        markAnswered,
      ]);
      if (!alreadyAnswered) this.saveOpeningLine(session.key, call.organizationId, session.conversationId, opening.text);
      this.prefetchFirstReply(session);
    }

    log.info('voice.answered', { callId, leadId: call.leadId, vertical, providerCallId: params.CallUUID, direction: 'outbound' });
    rt.openingUrl = opening.url;
    rt.openingText = opening.text;
    const xml =
      config.voice.mode === 'stream' && opening.url
        ? response(streamXml(call.id))
        : response(sayXml(opening.url, vertical === 'restaurant' ? spoken.outboundOpening('en', { business: orgName }) : industryOpening(industry, call.customer, orgName) ?? outboundOpeningEnglish(call.customer, orgName)) + '\n' + recordXml(call.id));
    this.answerXml.set(call.id, xml);
    return xml;
  }

  // ---------------------------------------------------------------------------
  // Inbound (secondary path): customer calls the Plivo number
  // ---------------------------------------------------------------------------

  async answerInbound(params: PlivoParams) {
    const phone = normalizePhone(params.From);
    if (!phone) {
      // Hidden caller ID: nothing to link the call to.
      log.warn('voice.inbound_no_caller_id', { providerCallId: params.CallUUID });
      return response('<Speak voice="WOMAN" language="en-US">Sorry, we could not see your number. Please call again without hiding your number.</Speak>\n' + HANGUP);
    }
    // Plivo can retry the answer webhook: one Call record per Plivo call.
    if (params.CallUUID) {
      const existing = await this.prisma.call.findFirst({ where: { providerCallId: params.CallUUID } });
      if (existing) {
        const cached = this.answerXml.get(existing.id);
        log.info('voice.answer_duplicate', { callId: existing.id, direction: 'inbound' });
        return cached ?? response(recordXml(existing.id));
      }
    }

    // Which business was called decides the organization. A number we do not know is never given to the default organization.
    const dialed = normalizePhone(params.To) ?? params.To;
    const owner = await this.tenancy.resolve('plivo_number', dialed);
    if (!owner) {
      log.warn('voice.inbound_unknown_number', { providerCallId: params.CallUUID });
      return response('<Speak voice="WOMAN" language="en-US">Sorry, this number is not in service. Goodbye.</Speak>\n' + HANGUP);
    }
    // Shared demo number: an approved tester bound to an industry workspace reaches that workspace's agent. The call
    // record is created there, so every later webhook (turn / hangup by callId) keeps this industry.
    const routed = this.demoSessions ? await this.demoSessions.routeInbound('voice', owner, phone) : null;
    if (routed && 'unrouted' in routed) {
      log.warn('voice.inbound_unrouted_shared_number', { providerCallId: params.CallUUID });
      return response('<Speak voice="WOMAN" language="en-US">This is the Tacksharp demo line. Please ask your presenter to start a demo session, then call again. Goodbye.</Speak>\n' + HANGUP);
    }
    const organizationId = routed ? routed.organizationId : owner;

    // Unknown callers become new customers (+ leads for real estate); they are never rejected.
    const vertical = await this.tenancy.vertical(organizationId);
    const customer = await this.conversations.getOrCreateCustomerByPhone(organizationId, phone, { source: 'voice_inbound' });
    if (customer.doNotContact) {
      // They chose to call us: allow follow-up again.
      await this.prisma.customer.update({ where: { id: customer.id }, data: { doNotContact: false } });
    }
    const lead = vertical === 'restaurant' ? null : await this.leads.ensureActiveLead(organizationId, customer.id, 'voice_inbound');
    const orgName = await this.orgName(organizationId);
    const text =
      vertical === 'restaurant'
        ? spoken.inboundOpening(customer.language === 'english' ? 'en' : 'ta', { name: firstName(customer.name) || undefined, business: orgName })
        : inboundOpening(orgName, customer.name);
    // The call row and the opening audio do not depend on each other.
    const [call, url] = await Promise.all([
      this.prisma.call.create({
        data: {
          organizationId,
          customerId: customer.id,
          leadId: lead?.id ?? null,
          direction: 'inbound',
          status: 'in_progress',
          toNumber: dialed ?? '',
          fromNumber: phone,
          providerCallId: params.CallUUID,
          answeredAt: new Date(),
        },
      }),
      this.sarvam.textToSpeechUrl(text, { cache: !customer.name }),
    ]);
    if (customer.name) this.trackAudio(call.id, url);

    const rt = this.newRuntime(
      call,
      phone,
      'inbound',
      lead ? inboundCallReason(customer, lead.status) : 'The customer called the shop. Help them order or answer questions about their order.',
      lead?.id,
      vertical,
    );
    rt.providerCallId = params.CallUUID;
    if (vertical === 'restaurant') {
      const [, keyterms] = await Promise.all([
        this.ai.openRestaurantCall({ organizationId, phone, customerName: customer.name ?? undefined, openingText: text, callId: call.id }),
        this.ai.restaurantKeyterms(organizationId).catch(() => undefined),
      ]);
      rt.keyterms = keyterms;
    } else {
      const session = await this.ai.openCallSession({
        organizationId,
        callId: call.id,
        phone,
        leadId: lead!.id,
        customerName: customer.name ?? undefined,
        openingText: text,
        direction: 'inbound',
      });
      this.saveOpeningLine(session.key, organizationId, session.conversationId, text);
    }

    log.info('voice.answered', { callId: call.id, leadId: lead?.id, vertical, providerCallId: params.CallUUID, direction: 'inbound', known: Boolean(customer.name) });
    rt.openingUrl = url;
    rt.openingText = text;
    const xml =
      config.voice.mode === 'stream' && url
        ? response(streamXml(call.id))
        : response(sayXml(url, 'Hello, thank you for calling. How can I help you?') + '\n' + recordXml(call.id));
    this.answerXml.set(call.id, xml);
    return xml;
  }

  // ---------------------------------------------------------------------------
  // One conversational turn: recording -> Saaras STT -> quality gate -> engine -> Bulbul TTS
  // ---------------------------------------------------------------------------

  async handleTurn(callId: string, params: PlivoParams) {
    const rt = await this.runtime(callId);
    if (!rt || rt.ended) return response(HANGUP);

    // Plivo retries a webhook that was slow to answer. The same recording never produces a second AI turn:
    // a finished one replays its answer, a running one is joined.
    const key = params.RecordUrl || undefined;
    if (key) {
      if (rt.last?.key === key) {
        log.info('voice.turn_duplicate', { callId });
        return rt.last.xml;
      }
      const running = rt.inflight.get(key);
      if (running) {
        log.info('voice.turn_duplicate_inflight', { callId });
        return running;
      }
    }
    const work = this.mutex
      // Shared across restarts / instances: a retry that reaches a restarted or different API process gets the reply
      // the first delivery produced, instead of a second AI turn (the duplicate transcript + reply on the dashboard).
      .run(rt.callId, async () => (key ? (await this.turnDedupe.run(rt.callId, key, () => this.processTurn(rt, params), () => response(recordXml(rt.callId)))).xml : this.processTurn(rt, params)))
      .then((xml) => {
        if (key) rt.last = { key, xml };
        return xml;
      })
      .finally(() => {
        if (key) rt.inflight.delete(key);
      });
    if (key) rt.inflight.set(key, work);
    return work;
  }

  private async processTurn(rt: CallRuntime, params: PlivoParams): Promise<string> {
    const t = timer();
    if (rt.ended) return response(HANGUP);

    const durationMs = Number(params.RecordingDurationMs ?? Number(params.RecordingDuration ?? 0) * 1000);
    let transcript = '';
    let sttLanguage: string | undefined;

    if (params.RecordUrl && durationMs >= 600) {
      try {
        const audio = await this.downloadRecording(params.RecordUrl);
        t.lap('download');
        const stt = await this.sarvam.speechToText(audio, 'turn.wav', 'audio/wav', rt.keyterms);
        transcript = stt.transcript;
        sttLanguage = stt.languageCode;
        t.lap('stt');
      } catch (error) {
        log.error('voice.stt_failed', { callId: rt.callId, error: errorMessage(error) });
      }
    }

    const decided = await this.understand(rt, transcript, sttLanguage, durationMs);
    t.lap('ai');
    if (decided.kind === 'unclear') {
      if (decided.end) return this.goodbye(decided.text, rt.vertical === 'restaurant' ? 'Thank you. Goodbye.' : ENGLISH_FALLBACK.goodbye);
      if (decided.replayUrl) return response(`<Play>${escapeXml(decided.replayUrl)}</Play>` + '\n' + recordXml(rt.callId));
      const url = await this.sarvam.textToSpeechUrl(decided.text, { cache: true });
      return response(sayXml(url, decided.english) + '\n' + recordXml(rt.callId));
    }

    const { finalText, end, cacheable } = decided;
    const tts = await this.sarvam.textToSpeech(finalText, { cache: cacheable });
    let audioUrl = tts.url;
    if (audioUrl && !tts.cached && !cacheable) this.trackAudio(rt.callId, audioUrl);
    let ttsFallback: string | undefined;
    if (!audioUrl && !end) {
      const fb = await this.ttsFailed(rt, decided, tts.error, tts.attempts);
      audioUrl = fb.url;
      ttsFallback = fb.fallback;
    }
    if (audioUrl) rt.lastAudioUrl = audioUrl;
    t.lap('tts');
    this.logTurn(rt, decided, t.done(), { languageCode: tts.languageCode, cached: tts.cached, attempts: tts.attempts, fallback: ttsFallback, mode: 'record' });

    if (end) return response(sayXml(audioUrl, rt.vertical === 'restaurant' ? 'Thank you. Goodbye.' : ENGLISH_FALLBACK.goodbye) + '\n' + HANGUP);
    // English reply whose audio failed: Plivo speaks the same words (not a generic line).
    return response(sayXml(audioUrl, ttsFallback === 'plivo_speak' ? finalText : ENGLISH_FALLBACK.unclear) + '\n' + recordXml(rt.callId));
  }

  /**
   * The transport-independent part of a turn (record mode and the real-time stream share it): quality gate ->
   * conversation engine -> call bookkeeping. Returns what to say; producing and delivering the audio is the caller's.
   */
  async understand(rt: CallRuntime, transcript: string, sttLanguage: string | undefined, durationMs: number): Promise<DecidedTurn> {
    // Quality gate: silence, noise and garbled text never reach the conversation engine.
    const gate = assessTranscript({ transcript, sttLanguage, durationMs, knownTerms: this.sarvam.keyterms });
    log.info('voice.heard', { callId: rt.callId, chars: gate.text.length, verdict: gate.verdict, reasons: gate.reasons, sttLanguage });
    if (gate.verdict === 'reject') return this.unclearDecision(rt, durationMs);

    const turns = rt.turns + 1;
    const result = await this.ai.generateResponse({
      organizationId: rt.organizationId,
      channel: 'voice',
      phone: rt.phone,
      message: gate.text,
      leadId: rt.leadId,
      quality: gate.verdict === 'ok' ? 'ok' : 'weak',
      callContext: { direction: rt.direction, callId: rt.callId, reason: rt.reason },
      metadata: { callId: rt.callId, sttLanguage, recordingMs: durationMs, quality: gate.verdict },
    });

    rt.turns = turns;
    rt.silentTurns = 0;
    if (result.language) rt.english = result.language.startsWith('en');
    if (result.actions.outcome) rt.outcome = result.actions.outcome;

    const decision = decideCallEnd({
      vertical: rt.vertical,
      turns,
      maxTurns: MAX_TURNS,
      endCall: Boolean(result.actions.endCall),
      endReason: (result as { endReason?: string }).endReason,
      failed: Boolean(result.failed),
    });
    const tooLong = decision.reason === 'max_turns';
    const end = decision.end;
    const reply = VoiceService.cleanForSpeech(result.response);
    const finalText = tooLong ? `${reply} ${rt.vertical === 'restaurant' ? RESTAURANT_TOO_LONG : PROMPTS.tooLongGoodbye}` : reply;
    if (end) rt.endReason = decision.reason;

    // The call row is updated after the audio is on its way. The hang-up handler waits for these writes.
    this.persistCall(rt, {
      turns,
      silentTurns: 0,
      ...(result.language ? { language: result.language } : {}),
      ...(result.actions.outcome ? { outcome: result.actions.outcome } : {}),
      ...(end ? { endReason: decision.reason } : {}),
    });
    if (tooLong && rt.leadId) {
      // The goodbye promises a team contact: make it true.
      this.ai.background(rt.sessionKey, () =>
        this.followUps.createHumanTask({
          organizationId: rt.organizationId,
          leadId: rt.leadId!,
          customerId: rt.customerId,
          reason: 'AI call reached its maximum length. Please follow up with the customer.',
        }),
      );
    }
    // Rule replies are deterministic text: cache them (a repeated question costs no TTS request). Model replies are
    // one-off and are deleted after the call.
    return { kind: 'reply', turns, result, finalText, end, cacheable: result.path === 'rules' && !tooLong && !isPersonalLine(finalText) };
  }

  /**
   * TTS failed even after retries. Never play an unrelated line in its place:
   *  - the customer did not hear this reply, so a pending confirmation question does not count as asked;
   *  - English replies are spoken by Plivo's own voice (same words); Tamil replies ask the customer to repeat.
   */
  async ttsFailed(rt: CallRuntime, decided: ReplyTurn, error: string | undefined, attempts: number, mode: 'record' | 'stream' = 'record'): Promise<{ url: string; fallback: string }> {
    this.ai.markReplyNotHeard(rt.sessionKey);
    let fallback = 'plivo_speak';
    let url = '';
    if (/[\u0B80-\u0BFF]/.test(decided.finalText)) {
      url = await this.sarvam.textToSpeechUrl(PROMPTS.lineIssue, { cache: true });
      fallback = 'line_issue_prompt';
    } else if (mode === 'stream') {
      // No Plivo <Speak> inside an audio stream: a cached English "please say that again".
      url = await this.sarvam.textToSpeechUrl(PROMPTS.lineIssueEn, { cache: true });
      fallback = 'line_issue_prompt_en';
    }
    log.error('voice.tts_fallback', { callId: rt.callId, turn: decided.turns, fallback, error, attempts });
    return { url, fallback };
  }

  logTurn(
    rt: CallRuntime,
    decided: ReplyTurn,
    timings: Record<string, number>,
    tts: { languageCode?: string; cached?: boolean; attempts?: number; fallback?: string; mode: 'record' | 'stream'; firstAudioMs?: number; sentences?: number; filler?: boolean },
  ) {
    const { result } = decided;
    recordTurn({
      downloadMs: timings.download,
      sttMs: timings.stt,
      aiMs: timings.ai,
      ttsMs: timings.tts,
      totalMs: timings.totalMs,
      aiRequests: result.aiUsage?.requests ?? 0,
      toolMs: result.aiUsage?.toolMs,
      pureAiMs: result.aiUsage?.pureAiMs,
      firstToolCallMs: result.aiUsage?.firstToolCallMs,
      path: result.path,
    });
    log.info('voice.turn', {
      callId: rt.callId,
      providerCallId: rt.providerCallId,
      customerId: rt.customerId,
      leadId: rt.leadId,
      direction: rt.direction,
      mode: tts.mode,
      turn: decided.turns,
      end: decided.end,
      path: result.path,
      state: result.state,
      intent: result.intent,
      outcome: result.actions.outcome,
      booking: result.booking,
      ...timings,
      ...(tts.firstAudioMs !== undefined ? { firstAudioMs: tts.firstAudioMs, sentences: tts.sentences, filler: tts.filler } : {}),
      aiRequests: result.aiUsage?.requests ?? 0,
      llmFallbackReason: result.llmFallbackReason,
      llm: result.llm,
      currentLanguage: result.languageInfo?.current,
      languageChanged: result.languageInfo?.changed,
      ttsLanguage: tts.languageCode,
      ttsCached: tts.cached,
      ttsAttempts: tts.attempts,
      ttsFallback: tts.fallback,
    });
  }

  // ---------------------------------------------------------------------------
  // Real-time stream support (see stream/stream-call.ts)
  // ---------------------------------------------------------------------------

  /** A fixed line pre-recorded at startup (static replies, prompts, wait lines): plays from disk instantly. */
  isStaticLine(text: string): boolean {
    const clean = VoiceService.cleanForSpeech(text);
    return this.staticReplies.has(clean) || Object.values(PROMPTS).includes(clean) || FILLERS.ta.includes(clean) || FILLERS.en.includes(clean);
  }

  /** The live call a stream belongs to (null when unknown or already ended). */
  async streamRuntime(callId: string): Promise<CallRuntime | undefined> {
    const rt = await this.runtime(callId);
    return rt && !rt.ended ? rt : undefined;
  }

  /** One turn at a time per call, shared with the webhook path. */
  withCallLock<T>(callId: string, work: () => Promise<T>) {
    return this.mutex.run(callId, work);
  }

  /** Spoken audio for a reply sentence; per-call (non-cached) files are deleted when the call ends. */
  async speakForStream(rt: CallRuntime, text: string, cache: boolean) {
    const tts = await this.sarvam.textToSpeech(VoiceService.cleanForSpeech(text), { cache });
    if (tts.url && !tts.cached && !cache) this.trackAudio(rt.callId, tts.url);
    if (tts.url) rt.lastAudioUrl = tts.url;
    return tts;
  }

  /** Real-time mode hangs up through the REST API once the goodbye has played. */
  async hangupLive(rt: CallRuntime, reason: string) {
    if (!rt.providerCallId) return;
    try {
      await this.plivo(await providerCredentials('plivo', rt.organizationId)).calls.hangup(rt.providerCallId);
      log.info('voice.stream_hangup', { callId: rt.callId, reason });
    } catch (error) {
      // Already over (customer hung up first) is fine; anything else is logged.
      log.warn('voice.stream_hangup_failed', { callId: rt.callId, reason, error: errorMessage(error) });
    }
  }

  /** Silence, noise or garbled speech: ask again; after a few in a row, end politely. Nothing else happens. */
  private unclearDecision(rt: CallRuntime, durationMs: number): UnclearTurn {
    rt.silentTurns += 1;
    this.persistCall(rt, { silentTurns: rt.silentTurns });
    if (rt.silentTurns > MAX_SILENT_TURNS) {
      rt.endReason = 'no_response';
      this.persistCall(rt, { outcome: rt.outcome ?? 'connected', endReason: 'no_response' });
      return { kind: 'unclear', text: rt.vertical === 'restaurant' ? RESTAURANT_NO_RESPONSE : PROMPTS.noResponseGoodbye, english: ENGLISH_FALLBACK.goodbye, end: true };
    }
    const heardSomething = durationMs >= 600;
    // Second empty / garbled turn in a row: say our last question again (its audio is already made) instead of
    // another "can you hear me?". Nothing in the conversation state changes on an empty turn.
    if (rt.silentTurns === 2 && rt.lastAudioUrl) {
      log.info('voice.replay_last_reply', { callId: rt.callId, silentTurns: rt.silentTurns });
      return { kind: 'unclear', text: '', english: ENGLISH_FALLBACK.unclear, replayUrl: rt.lastAudioUrl, end: false };
    }
    const text = heardSomething ? (rt.english ? PROMPTS.unclearEn : PROMPTS.unclear) : rt.english ? PROMPTS.didntHearEn : PROMPTS.didntHear;
    return { kind: 'unclear', text, english: heardSomething ? ENGLISH_FALLBACK.unclear : ENGLISH_FALLBACK.didntHear, end: false };
  }

  /** A turn handler crashed: leave a task for the team so the "we will call you back" message is true. */
  async recordHandlerFailure(callId: string | undefined): Promise<boolean> {
    if (!callId) return false;
    try {
      const rt = await this.runtime(callId);
      if (!rt?.leadId) return false;
      await this.followUps.createHumanTask({
        organizationId: rt.organizationId,
        leadId: rt.leadId,
        customerId: rt.customerId,
        reason: 'A technical error interrupted an AI call. Please follow up with the customer.',
      });
      return true;
    } catch (error) {
      log.error('voice.failure_task_failed', { callId, error: errorMessage(error) });
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-call runtime
  // ---------------------------------------------------------------------------

  private newRuntime(
    call: { id: string; organizationId: string; customerId: string; turns?: number; silentTurns?: number },
    phone: string,
    direction: 'outbound' | 'inbound',
    reason: string,
    leadId?: string,
    vertical: Vertical = 'real_estate',
  ): CallRuntime {
    const rt: CallRuntime = {
      callId: call.id,
      organizationId: call.organizationId,
      vertical,
      customerId: call.customerId,
      leadId,
      phone,
      direction,
      reason,
      sessionKey: this.ai.voiceSessionKey(call.organizationId, call.id, phone),
      turns: call.turns ?? 0,
      silentTurns: call.silentTurns ?? 0,
      ended: false,
      english: false,
      startedAt: Date.now(),
      inflight: new Map(),
    };
    this.calls.set(call.id, rt);
    return rt;
  }

  private async runtime(callId: string): Promise<CallRuntime | undefined> {
    const cached = this.calls.get(callId);
    if (cached) return cached;
    // Not in memory (API restarted during the call): rebuild from the database once.
    const call = await this.prisma.call.findUnique({ where: { id: callId }, include: { customer: true, lead: true } });
    if (!call?.customer.phone || call.endedAt) return undefined;
    const direction = call.direction === 'inbound' ? 'inbound' : 'outbound';
    const vertical = await this.tenancy.vertical(call.organizationId);
    const reason = direction === 'inbound' ? inboundCallReason(call.customer, call.lead?.status) : industryCallReason(await this.industryOf(call.organizationId), await this.orgName(call.organizationId)) ?? callReason(call.customer, call.lead?.source);
    const rt = this.newRuntime(call, call.customer.phone, direction, reason, call.leadId ?? undefined, vertical);
    if (vertical === 'restaurant') rt.keyterms = await this.ai.restaurantKeyterms(call.organizationId).catch(() => undefined);
    rt.providerCallId = call.providerCallId ?? undefined;
    rt.outcome = call.outcome ?? undefined;
    return rt;
  }

  /** Queue a Call-row update behind the reply; the hang-up handler waits for it. */
  private persistCall(rt: CallRuntime, data: Record<string, unknown>) {
    this.ai.background(rt.sessionKey, () => this.prisma.call.update({ where: { id: rt.callId }, data }));
  }

  private saveOpeningLine(sessionKey: string, organizationId: string, conversationId: string, text: string) {
    this.ai.background(sessionKey, () =>
      this.conversations.addMessage({ organizationId, conversationId, role: 'assistant', content: text }),
    );
  }

  // ---------------------------------------------------------------------------
  // Hangup: record outcome, update CRM, decide retries
  // ---------------------------------------------------------------------------

  async handleHangup(callId: string | undefined, params: PlivoParams) {
    // Outbound hang-ups carry our callId; inbound ones (Plivo application Hangup URL) only CallUUID.
    let call = callId
      ? await this.prisma.call.findUnique({ where: { id: callId } })
      : params.CallUUID
        ? await this.prisma.call.findFirst({ where: { providerCallId: params.CallUUID } })
        : null;
    if (!call) {
      log.warn('voice.hangup_unknown_call', { callId, providerCallId: params.CallUUID });
      return { ok: false };
    }
    callId = call.id;
    if (call.endedAt && ['completed', 'no_answer', 'busy', 'failed'].includes(call.status)) {
      return { ok: true, duplicate: true }; // Plivo may retry the hangup webhook
    }

    // The customer may hang up while a turn is still being processed. Let it finish, then wait for the
    // background writes (turn counts, outcome, messages) so the outcome below is the final one.
    const sessionKey = this.ai.voiceSessionKey(call.organizationId, call.id, '');
    const live = this.calls.get(call.id);
    if (live) await this.mutex.run(call.id, async () => void (live.ended = true));
    await this.ai.settle(sessionKey);
    call = (await this.prisma.call.findUnique({ where: { id: call.id } })) ?? call;

    const cause = `${params.HangupCauseName ?? ''} ${params.HangupCause ?? ''} ${params.CallStatus ?? ''}`.toLowerCase();
    const duration = Number(params.Duration ?? params.BillDuration ?? 0) || null;

    let status: string;
    let outcome: string;
    if (call.answeredAt) {
      status = 'completed';
      outcome = call.outcome ?? 'connected';
    } else if (cause.includes('busy')) {
      status = outcome = 'busy';
    } else if (/no.?answer|timeout|not answered|cancel/.test(cause)) {
      status = 'no_answer';
      outcome = 'no_answer';
    } else if (/unallocated|invalid|not exist|unknown destination|incompatible/.test(cause)) {
      status = 'failed';
      outcome = 'invalid_number';
    } else {
      status = 'failed';
      outcome = 'failed';
    }

    // Who ended it: our own reason (goodbye, max turns, no response) if we did, otherwise the customer / network.
    const endReason = call.endReason ?? (call.answeredAt ? 'customer_or_network_hangup' : status);
    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        status,
        outcome,
        endReason,
        endedAt: new Date(),
        durationSec: duration,
        hangupCause: (params.HangupCauseName ?? params.HangupCause ?? params.CallStatus ?? '').slice(0, 190) || null,
        providerCallId: call.providerCallId ?? params.CallUUID,
      },
    });
    log.info('voice.ended', {
      callId,
      providerCallId: call.providerCallId ?? params.CallUUID,
      customerId: call.customerId,
      leadId: call.leadId,
      direction: call.direction,
      status,
      outcome,
      endReason,
      turns: call.turns,
      durationSec: duration,
      attempt: call.attempt,
    });
    await this.releaseCall(call.id);

    try {
      await this.applyOutcome({ ...call, status, outcome });
    } catch (error) {
      log.error('voice.apply_outcome_failed', { callId, error: errorMessage(error) });
    }
    try {
      await this.saveSummary(call.id);
    } catch (error) {
      log.error('voice.summary_failed', { callId, error: errorMessage(error) });
    }
    await this.ai.closeSession(sessionKey).catch((error) => log.warn('voice.session_close_failed', { callId, error: errorMessage(error) }));
    return { ok: true };
  }

  /** Plain-language summary for the business owner, from saved facts only. */
  private async saveSummary(callId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId }, include: { customer: true } });
    if (!call) return;
    const visit = await this.prisma.siteVisit.findFirst({
      where: { customerId: call.customerId, createdAt: { gte: call.createdAt } },
      orderBy: { createdAt: 'desc' },
      include: { Property: true },
    });
    const summary = buildCallSummary({
      direction: call.direction,
      outcome: call.outcome ?? call.status,
      durationSec: call.durationSec,
      turns: call.turns,
      language: call.language,
      customer: call.customer,
      siteVisit: visit ? { propertyName: visit.Property.name, scheduledAt: visit.scheduledAt } : null,
    });
    await this.prisma.call.update({ where: { id: call.id }, data: { summary } });
  }

  private async applyOutcome(call: {
    id: string;
    organizationId: string;
    customerId: string;
    leadId: string | null;
    attempt: number;
    direction: string;
    status: string;
    outcome: string;
  }) {
    const { organizationId, customerId, leadId } = call;
    if (!leadId) return;

    if (call.status === 'completed') {
      await this.leads.advanceLeadStatus({ organizationId, leadId, status: 'contacted' });
      // We spoke to them: stop the remaining automatic sequence (callbacks they asked for stay).
      await this.followUps.cancelPending({
        organizationId,
        customerId,
        reason: `Call connected (${call.outcome})`,
        sources: ['sequence', 'retry'],
      });
      if (call.outcome === 'connected') {
        // Talked, but no clear result: let a human look at it.
        await this.followUps.createHumanTask({
          organizationId,
          leadId,
          customerId,
          reason: 'AI call connected without a clear outcome - please review the transcript.',
        });
      } else if (call.outcome === 'site_visit_requested') {
        // The customer wanted a visit but the call ended before they confirmed it: nothing was booked.
        await this.followUps.createHumanTask({
          organizationId,
          leadId,
          customerId,
          reason: 'Customer showed interest in a site visit but did not confirm a slot before the call ended - nothing was booked. Please follow up.',
        });
      }
      return;
    }

    if (call.outcome === 'invalid_number') {
      await this.prisma.customer.update({ where: { id: customerId }, data: { doNotContact: true } });
      await this.leads.updateLeadStatus({ organizationId, leadId, status: 'lost' });
      await this.followUps.cancelPending({ organizationId, customerId, reason: 'Invalid phone number' });
      return;
    }

    // no_answer / busy / failed -> the business's retry cadence (+30 min, then next day at 11 by default).
    if (call.direction === 'outbound') {
      const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
      if (customer?.doNotContact) return;
      const settings = await this.followUps.settingsFor(organizationId);
      if (call.attempt === 1 && settings.nurture.missedCallWhatsApp && ['no_answer', 'busy'].includes(call.outcome)) {
        // "Sorry we missed you" a couple of minutes later, unless they call or message back first.
        await this.followUps.create({
          organizationId,
          leadId,
          customerId,
          channel: 'whatsapp',
          action: 'message',
          message: 'missed_call',
          scheduledAt: new Date(Date.now() + 2 * 60_000 * config.followUp.timeScale),
          source: 'retry',
        });
      }
      const pendingVoice = await this.followUps.hasActiveVoiceAutomation(customerId);
      if (pendingVoice) return;
      const at = nextRetryAt(call.attempt, new Date(), settings, config.followUp.timeScale);
      if (!at) return;
      await this.followUps.create({
        organizationId,
        leadId,
        customerId,
        channel: 'voice',
        action: 'call',
        message: `retry after ${call.outcome}`,
        scheduledAt: at,
        source: 'retry',
      });
    }
  }

  // ---------------------------------------------------------------------------

  private goodbye(text: string, english: string) {
    return this.sarvam
      .textToSpeechUrl(text, { cache: true })
      .then((url) => response(sayXml(url, english) + '\n' + HANGUP));
  }

  private async saveAssistantLine(organizationId: string, customerId: string, phone: string, text: string) {
    const conversation = await this.conversations.getOrCreateConversation({
      organizationId,
      channel: 'voice',
      externalId: phone,
      customerId,
    });
    await this.conversations.addMessage({ organizationId, conversationId: conversation.id, role: 'assistant', content: text });
  }

  /** Plivo stores the recording asynchronously; retry briefly if it's not there yet. */
  private async downloadRecording(url: string): Promise<Buffer> {
    // The account that served this call (the scope is bound to the call's organization by the webhook handler).
    const pv = await providerCredentials('plivo');
    const id = pv.source === 'organization' ? pv.secrets.authId : config.plivo.authId;
    const token = pv.source === 'organization' ? pv.secrets.authToken : config.plivo.authToken;
    const auth = 'Basic ' + Buffer.from(`${id}:${token}`).toString('base64');
    let useAuth = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await fetch(url, {
        headers: useAuth ? { Authorization: auth } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > 44) return buffer;
      } else if ((res.status === 401 || res.status === 403) && !useAuth) {
        useAuth = true;
        continue;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Recording not available');
  }

  static cleanForSpeech(value: string) {
    return value
      .replace(/\*\*/g, '')
      .replace(/[*_`#>]/g, '')
      .replace(/₹\s?/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
