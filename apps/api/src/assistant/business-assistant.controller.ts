import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, Param, Post, Query, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CurrentUser, Org, Public } from '../auth/decorators.js';
import { webhookSecret } from '../telephony/webhook-token.js';
import { callPhoneKey, sharedCartStore } from '../telephony/sarvam-tools.service.js';
import type { SessionClaims } from '../auth/token.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { AiService } from '../ai/ai.service.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';
import { config } from '../common/config.js';
import { providerCredentials } from '../integrations/provider-scope.js';
import { SARVAM_SPEAKERS } from '../integrations/providers.js';
import { AssistantService, detectStyle, type AssistantVoice } from './assistant.service.js';
import type { Style } from './knowledge.js';

/** The business's own greeting in the dashboard assistant (Tamil, Tanglish, English). */
const greeting = (name: string, ordering: boolean): Record<Style, string> => ordering
  ? {
      en: `Vanakkam! This is the ${name} assistant. Ask for the menu or today's prices, or place an order by chat, voice or video. Answers come from your shop's live menu and records.`,
      ta: `வணக்கம்! ${name} assistant பேசுறேன். Menu, இன்றைய விலை கேளுங்க, அல்லது chat, voice, video-ல order பண்ணுங்க.`,
      tanglish: `Vanakkam! ${name} assistant pesuren. Menu, inniku price kelunga, illa chat, voice, video la order pannunga.`,
    }
  : {
      en: `Vanakkam! This is the ${name} assistant. Ask anything a customer would ask; answers come from your business's own records.`,
      ta: `வணக்கம்! ${name} assistant பேசுறேன். ஒரு customer கேட்கற மாதிரி எதுவேணாலும் கேளுங்க.`,
      tanglish: `Vanakkam! ${name} assistant pesuren. Customer kekura maadhiri edhu venaalum kelunga.`,
    };

/** Sarvam Voice Agents runtime (the base the official web SDK uses: sarvam-conv-ai-sdk SocketManager). */
const SARVAM_RUNTIME = 'https://apps.sarvam.ai/api/app-runtime/';
const LIVE_TOKEN_TTL_MS = 2 * 60_000;

/** A short-lived ticket for ONE live-call URL request: bound to the organization and the Sarvam app it may open. */
function liveTicket(organizationId: string, appId: string, exp: number, secret: string) {
  return createHmac('sha256', secret).update(`webcall|${organizationId}|${appId}|${exp}`).digest('hex');
}

/**
 * The dashboard assistant in "business" mode: staff talk to THEIR business's assistant as a customer would, by chat,
 * voice or the video presenter. Every turn goes through the same engine as WhatsApp and phone calls (a restaurant:
 * the ordering engine with the live menu, prices, stock, outlets and the customer's history by mobile number), on the
 * dashboard test channel: nothing is sent on WhatsApp and no call is placed. A confirmed order is a real order record.
 * Logged-in staff only; the organization always comes from the session.
 */
@Controller('business-assistant')
export class BusinessAssistantController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly ai: AiService,
    private readonly assistant: AssistantService,
  ) {}

  private async workspace(organizationId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true, isDemo: true } });
    const ordering = (await this.tenancy.vertical(organizationId).catch(() => 'unknown')) === 'restaurant';
    const industry = ordering ? 'restaurant' : ((await this.ai.industry(organizationId)) ?? 'other');
    // Other industries' engines can book visits or update records: like the agent playground, demo workspaces only.
    const enabled = ordering || Boolean(org?.isDemo);
    return { name: org?.name ?? 'Your business', isDemo: Boolean(org?.isDemo), ordering, industry, enabled };
  }

  /**
   * The agent that answers the business's phone: the one chosen for calls in Settings, else the most recently updated
   * Sarvam phone agent (active first). Its voice and greeting are used here so the assistant sounds like the phone line.
   */
  private async phoneAgent(organizationId: string) {
    const st = await this.prisma.organizationSettings.findUnique({ where: { organizationId } }).catch(() => null);
    const chosen = (st?.data as { telephony?: { systemAgentId?: string } } | null)?.telephony?.systemAgentId;
    const select = { id: true, name: true, voice: true, greeting: true, sarvamAppId: true, sarvamAppVersion: true } as const;
    if (chosen) {
      const a = await this.prisma.voiceAgent.findFirst({ where: { id: chosen, organizationId }, select });
      if (a) return a;
    }
    const rows = await this.prisma.voiceAgent.findMany({ where: { organizationId, sarvamAppId: { not: null }, status: { not: 'archived' } }, orderBy: [{ updatedAt: 'desc' }], select: { ...select, status: true }, take: 10 });
    return rows.find((r) => r.status === 'active') ?? rows[0] ?? null;
  }

  /**
   * The phone call's voice: the business's Sarvam account (its own key when it has one), the phone agent's speaker
   * and pace when set, otherwise the account / deployment phone voice; same model and temperature as calls.
   */
  private async phoneVoice(organizationId: string): Promise<AssistantVoice & { agentName: string | null; source: 'agent' | 'account' }> {
    const [agent, cred] = await Promise.all([this.phoneAgent(organizationId), providerCredentials('sarvam', organizationId).catch(() => null)]);
    const key = cred && cred.source !== 'none' ? String(cred.secrets.apiKey ?? '') : '';
    const model = String(cred?.config.ttsModel || config.sarvam.ttsModel);
    const v = (agent?.voice ?? null) as { speaker?: string; pace?: number } | null;
    const fromAgent = Boolean(v?.speaker && (SARVAM_SPEAKERS as readonly string[]).includes(v.speaker));
    const speaker = fromAgent ? v!.speaker! : String(cred?.config.ttsSpeaker || config.sarvam.ttsSpeaker);
    const pace = fromAgent && typeof v?.pace === 'number' && v.pace >= 0.5 && v.pace <= 2 ? v.pace : config.sarvam.ttsPace;
    // `temperature` exists only on bulbul:v3 / v4-flash (as in the phone path).
    const temperature = /^bulbul:(v3|v4-flash)/.test(model) ? config.sarvam.ttsTemperature : undefined;
    return { key: key || config.sarvam.apiKey, model, speaker, pace, temperature, agentName: agent?.name ?? null, source: fromAgent ? 'agent' : 'account' };
  }

  @Get('status')
  async status(@Org() organizationId: string, @Query('lang') lang?: string) {
    const ws = await this.workspace(organizationId);
    const style = (['ta', 'en', 'tanglish'].includes(String(lang)) ? lang : 'en') as Style;
    const [agent, voice, live] = await Promise.all([
      this.phoneAgent(organizationId),
      this.phoneVoice(organizationId),
      this.liveAccount(organizationId).catch(() => null),
    ]);
    const base = this.assistant.status();
    // The video call is the live phone agent with the avatar lip-syncing ITS audio: it needs the Simli key and face and
    // the live agent, not our own text-to-speech key.
    const simli = Boolean(process.env.SIMLI_API_KEY && process.env.SIMLI_FACE_ID);
    return {
      ...base,
      voice: Boolean(voice.key),
      video: simli && Boolean(live),
      // Why the Video call button is unavailable (shown on the button), or null when it works.
      videoReason: !simli ? 'Video needs SIMLI_API_KEY and SIMLI_FACE_ID on the server.' : !live ? 'Video uses the live phone agent: set it up first (Sarvam agent id on Voice agents).' : null,
      enabled: ws.enabled,
      reason: ws.enabled ? null : 'Your business assistant can be tried here in a demo workspace. Live customers talk to it on WhatsApp and phone.',
      organizationName: ws.name,
      industry: ws.industry,
      ordering: ws.ordering,
      // The phone agent's own opening line when it has one: the assistant opens exactly like a call.
      greeting: agent?.greeting?.replace(/\{\{[^}]*\}\}/g, '').replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim() || greeting(ws.name, ws.ordering)[style],
      phoneVoice: { agent: voice.agentName, speaker: voice.speaker, pace: voice.pace, model: voice.model, source: voice.source },
      // Voice / video calls go to the business's real Sarvam phone agent when it is set up (same as a phone call).
      liveAgent: live ? { name: live.agentName, version: live.version } : null,
    };
  }

  /** What the business already knows about this customer (the same records WhatsApp and phone calls use). */
  @Get('customer')
  async customer(@Org() organizationId: string, @Query('phone') raw?: string) {
    const phone = normalizePhone(raw);
    if (!phone) throw new BadRequestException('Enter a 10-digit mobile number.');
    const c = await this.prisma.customer.findFirst({ where: { organizationId, phone }, select: { id: true, name: true, language: true, createdAt: true } });
    if (!c) return { known: false, phone };
    const [orders, count, conversations] = await Promise.all([
      this.prisma.order.findMany({ where: { organizationId, customerId: c.id }, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, orderNumber: true, total: true, status: true, channel: true, createdAt: true } }).catch(() => []),
      this.prisma.order.count({ where: { organizationId, customerId: c.id } }).catch(() => 0),
      this.prisma.conversation.findMany({ where: { organizationId, customerId: c.id }, orderBy: { updatedAt: 'desc' }, take: 5, select: { channel: true, updatedAt: true } }),
    ]);
    return {
      known: true,
      phone,
      name: c.name,
      language: c.language,
      since: c.createdAt,
      orderCount: count,
      recentOrders: orders.map((o) => ({ id: o.id, orderNumber: o.orderNumber, total: Number(o.total), status: o.status, channel: o.channel, at: o.createdAt })),
      channels: [...new Set(conversations.map((v) => v.channel))],
      lastContactAt: conversations[0]?.updatedAt ?? null,
    };
  }

  /** One customer turn. `spoken` = the assistant is in voice or video mode (replies worded for speech). */
  @Post('chat')
  @HttpCode(200)
  async chat(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { message?: unknown; phone?: unknown; name?: unknown; spoken?: unknown; sttLanguage?: unknown }) {
    if (user.role === 'viewer') throw new ForbiddenException('Your role can only view.');
    const ws = await this.workspace(organizationId);
    if (!ws.enabled) throw new ForbiddenException('Your business assistant can be tried here in a demo workspace.');
    const phone = normalizePhone(typeof body?.phone === 'string' ? body.phone : '');
    if (!phone) throw new BadRequestException('Enter the customer’s 10-digit mobile number first.');
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 1000) throw new BadRequestException('Message must be 1–1000 characters.');
    const spoken = body?.spoken === true;
    const started = Date.now();
    try {
      const r = await this.ai.generateResponse({
        organizationId,
        channel: 'web',
        phone,
        message,
        customerName: typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : undefined,
        // Orders confirmed here are real orders of this customer (channel "assistant"), not test-chat orders.
        metadata: { assistant: 'dashboard', by: `user:${user.sub}`, spoken, orderChannel: 'assistant', ...(typeof body?.sttLanguage === 'string' ? { sttLanguage: body.sttLanguage.slice(0, 10) } : {}) },
      });
      const order = (r as { order?: { status: string; id: string; orderNumber: string; total: number } }).order ?? null;
      log.info('business_assistant.reply', { organizationId, spoken, ms: Date.now() - started, path: r.path ?? null, order: order?.orderNumber ?? null });
      return { reply: r.response, style: detectStyle(r.response), step: r.state ?? null, order, path: r.path ?? 'rules', sent: false };
    } catch (e) {
      log.warn('business_assistant.failed', { organizationId, error: errorMessage(e) });
      throw new BadRequestException('The assistant could not answer just now. Please try again.');
    }
  }

  // ---- Live call: the business's own Sarvam phone agent, in the browser -------------------------------------------
  //
  // Same agent, voice, speed, speech recognition and tools as a phone call (Sarvam's official web SDK streams the
  // microphone and the agent's audio over a WebSocket). The browser never sees the Sarvam key: it asks our API for a
  // two-minute ticket, and the SDK's one "signed URL" request comes to us; we check the ticket and ask Sarvam with the
  // key. The agent's tools answer from our database for the customer number given as the caller (user identifier).

  private async liveAccount(organizationId: string) {
    const [agent, cred] = await Promise.all([this.phoneAgent(organizationId), providerCredentials('sarvam_telephony', organizationId).catch(() => null)]);
    const apiKey = cred && cred.source !== 'none' && !cred.reason ? String(cred.secrets.apiKey ?? '') : '';
    const orgId = String(cred?.config.orgId ?? '');
    const workspaceId = String(cred?.config.workspaceId ?? '');
    if (!agent?.sarvamAppId || !apiKey || !orgId || !workspaceId || !webhookSecret()) return null;
    return { apiKey, orgId, workspaceId, appId: agent.sarvamAppId, version: agent.sarvamAppVersion ?? null, agentName: agent.name };
  }

  @Post('live/session')
  @HttpCode(200)
  async liveSession(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { phone?: unknown }) {
    if (user.role === 'viewer') throw new ForbiddenException('Your role can only view.');
    const ws = await this.workspace(organizationId);
    if (!ws.enabled) throw new ForbiddenException('Your business assistant can be tried here in a demo workspace.');
    const phone = normalizePhone(typeof body?.phone === 'string' ? body.phone : '');
    if (!phone) throw new BadRequestException('Enter the customer’s 10-digit mobile number first.');
    const acct = await this.liveAccount(organizationId);
    if (!acct) throw new ServiceUnavailableException('The live phone agent is not set up for this business (Sarvam agent id on the voice agent, and the Sarvam calling account).');
    const exp = Date.now() + LIVE_TOKEN_TTL_MS;
    const ticket = `${exp}.${liveTicket(organizationId, acct.appId, exp, webhookSecret()!)}`;
    log.info('business_assistant.live_session', { organizationId, appId: acct.appId, version: acct.version });
    return {
      ticket,
      organizationId,
      agentName: acct.agentName,
      config: { org_id: acct.orgId, workspace_id: acct.workspaceId, app_id: acct.appId, ...(acct.version ? { version: acct.version } : {}), user_identifier: `+${phone}`, user_identifier_type: 'phone_number' },
    };
  }

  /** The SDK's signed-URL request (GET {base}orgs/{org}/workspaces/{ws}/apps/{app}/url), checked and forwarded. */
  @Public()
  @Get('live/runtime/:tenant/orgs/:org/workspaces/:ws/apps/:app/url')
  async liveUrl(@Param() p: { tenant: string; org: string; ws: string; app: string }, @Query() q: Record<string, unknown>, @Req() req: Request) {
    const secret = webhookSecret();
    const [expRaw, mac] = String(req.headers['x-assistant-ticket'] ?? '').split('.');
    const exp = Number(expRaw);
    if (!secret || !mac || !Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + LIVE_TOKEN_TTL_MS + 5_000) throw new UnauthorizedException('Ticket expired. Start the call again.');
    const expected = liveTicket(p.tenant, p.app, exp, secret);
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new UnauthorizedException('Invalid ticket.');
    const acct = await this.liveAccount(p.tenant);
    if (!acct || acct.appId !== p.app || acct.orgId !== p.org || acct.workspaceId !== p.ws) throw new ForbiddenException('This agent is not the business’s phone agent.');
    const qs = new URLSearchParams();
    if (q.interaction_type === 'call' || q.interaction_type === 'chat') qs.set('interaction_type', q.interaction_type);
    if (/^\d{1,6}$/.test(String(q.version ?? ''))) qs.set('version', String(q.version));
    const url = `${SARVAM_RUNTIME}orgs/${encodeURIComponent(acct.orgId)}/workspaces/${encodeURIComponent(acct.workspaceId)}/apps/${encodeURIComponent(acct.appId)}/url${qs.size ? `?${qs}` : ''}`;
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { 'X-API-Key': acct.apiKey }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      log.warn('business_assistant.live_unreachable', { organizationId: p.tenant, error: errorMessage(e) });
      throw new ServiceUnavailableException('Sarvam is not reachable right now.');
    }
    const data = (await res.json().catch(() => null)) as { url?: string; reference_id?: string } | null;
    if (!res.ok || !data?.url || !data.reference_id) {
      log.warn('business_assistant.live_refused', { organizationId: p.tenant, status: res.status, ms: Date.now() - started });
      throw new HttpException(res.status === 404 ? 'Sarvam could not find a committed version of this agent.' : 'Sarvam refused the live call.', res.status >= 400 && res.status < 600 ? res.status : 502);
    }
    log.info('business_assistant.live_url', { organizationId: p.tenant, ms: Date.now() - started });
    return { url: data.url, reference_id: data.reference_id };
  }

  /**
   * The browser tells us which Sarvam interaction is this dashboard call (the SDK knows its id once connected): the
   * agent's tools can then find the customer number from the Interaction ID even when Sarvam's "User Identifier" is
   * empty for a web call. Kept 2 hours.
   */
  @Post('live/bind')
  @HttpCode(200)
  async liveBind(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { interactionId?: unknown; phone?: unknown }) {
    if (user.role === 'viewer') throw new ForbiddenException('Your role can only view.');
    const id = typeof body?.interactionId === 'string' && /^[\w-]{4,120}$/.test(body.interactionId) ? body.interactionId : '';
    const phone = normalizePhone(typeof body?.phone === 'string' ? body.phone : '');
    if (!id || !phone) throw new BadRequestException('interactionId and phone are required.');
    await sharedCartStore().set(callPhoneKey(organizationId, id), phone, 2 * 60 * 60_000);
    return { bound: true };
  }

  /**
   * After a live call from the dashboard: the call and its transcript go on the customer's record (AI voice calls and
   * the customer's voice conversation), like a phone call. Saved once per Sarvam interaction.
   */
  @Post('live/transcript')
  @HttpCode(200)
  async liveTranscript(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { phone?: unknown; interactionId?: unknown; durationSec?: unknown; lines?: unknown }) {
    if (user.role === 'viewer') throw new ForbiddenException('Your role can only view.');
    const phone = normalizePhone(typeof body?.phone === 'string' ? body.phone : '');
    if (!phone) throw new BadRequestException('Mobile number required.');
    const lines = (Array.isArray(body?.lines) ? body.lines : [])
      .filter((l): l is { role: string; content: string } => Boolean(l) && typeof (l as { content?: unknown }).content === 'string')
      .slice(0, 200)
      .map((l) => ({ role: l.role === 'user' ? ('user' as const) : ('assistant' as const), content: l.content.trim().slice(0, 4000) }))
      .filter((l) => l.content);
    if (!lines.length) return { saved: false };
    const interactionId = typeof body?.interactionId === 'string' && /^[\w-]{1,120}$/.test(body.interactionId) ? body.interactionId : `web-${randomUUID()}`;
    if (await this.prisma.call.findFirst({ where: { organizationId, providerCallId: interactionId }, select: { id: true } })) return { saved: false, duplicate: true };
    const durationSec = Number.isFinite(Number(body?.durationSec)) ? Math.max(0, Math.min(7200, Math.round(Number(body.durationSec)))) : null;
    const customer = (await this.prisma.customer.findFirst({ where: { organizationId, phone } })) ?? (await this.prisma.customer.create({ data: { organizationId, phone, source: 'voice_web' } }));
    const since = new Date(Date.now() - ((durationSec ?? 0) + 120) * 1000);
    const orders = await this.prisma.order.findMany({ where: { organizationId, customerId: customer.id, createdAt: { gte: since } }, select: { orderNumber: true, total: true }, take: 5 });
    const first = lines.find((l) => l.role === 'user' && l.content.length > 3);
    const summary = [`Dashboard live call by staff (user:${user.sub}).`, first ? `Caller: "${first.content.slice(0, 160)}"` : '', ...orders.map((o) => `Order ${o.orderNumber} placed (₹${Number(o.total)}).`), orders.length ? '' : 'No order placed.'].filter(Boolean).join(' ');
    const call = await this.prisma.call.create({ data: { organizationId, customerId: customer.id, direction: 'inbound', status: 'completed', outcome: 'web_call', toNumber: '', fromNumber: phone, providerCallId: interactionId, durationSec, provider: 'sarvam', endedAt: new Date(), summary: summary.slice(0, 1000) } });
    const conv = (await this.prisma.conversation.findFirst({ where: { organizationId, channel: 'voice', externalId: phone } })) ?? (await this.prisma.conversation.create({ data: { id: randomUUID(), organizationId, channel: 'voice', externalId: phone, customerId: customer.id, updatedAt: new Date() } }));
    await this.prisma.message.createMany({ data: lines.map((l, i) => ({ id: `${call.id}-${i}`.slice(0, 191), organizationId, conversationId: conv.id, role: l.role, content: l.content, metadata: { callId: call.id, provider: 'sarvam', via: 'dashboard' } })) });
    log.info('business_assistant.live_saved', { organizationId, callId: call.id, lines: lines.length, durationSec });
    return { saved: true, callId: call.id };
  }

  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);

  /** The video presenter for a live call: signed-in staff, the business limits (300 s idle / 3600 s in all). */
  @Post('video/session')
  @HttpCode(200)
  async videoSession(@Org() organizationId: string, @CurrentUser() user: SessionClaims) {
    if (user.role === 'viewer') throw new ForbiddenException('Your role can only view.');
    if (!(await this.workspace(organizationId)).enabled) throw new ForbiddenException('Your business assistant can be tried here in a demo workspace.');
    return this.assistant.videoSession({ business: true });
  }

  // Speech for the business assistant (signed-in staff; not the public per-visitor allowance).
  @Post('stt')
  @HttpCode(200)
  stt(@Body() body: { audioBase64?: unknown }) {
    return this.assistant.speechToText(body ?? {});
  }

  /** Spoken in the phone agent's voice (speaker, pace, model, temperature), as on a call. */
  @Post('tts')
  @HttpCode(200)
  async tts(@Org() organizationId: string, @Body() body: { text?: unknown; style?: unknown; sampleRate?: unknown }) {
    return this.assistant.textToSpeech(body ?? {}, await this.phoneVoice(organizationId));
  }
}
