import { Injectable } from '@nestjs/common';
import plivo from 'plivo';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { SarvamService } from '../sarvam/sarvam.service.js';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { config } from '../common/config.js';
import { istHour } from '../common/time.js';
import { errorMessage, log } from '../common/logger.js';
import { escapeXml, HANGUP, response, sayXml } from '../voice/plivo-xml.js';
import { firstName } from '../whatsapp/message-templates.js';
import { OrdersService, type OrderView } from './orders.service.js';
import { itemsPhrase, say, type Style } from './replies.js';

type PlivoParams = Record<string, string | undefined>;
type Dialer = (from: string, to: string, answerUrl: string, hangupUrl: string) => Promise<{ requestUuid?: string }>;

const styleOf = (lang: string | null | undefined): Style => (lang === 'english' ? 'en' : 'ta');
const waStyleOf = (lang: string | null | undefined): Style => (lang === 'english' ? 'en' : lang === 'tamil' ? 'ta' : 'tl');

/** What the customer said on the ready call, read deterministically (Tamil script, Tanglish, English). */
export function readCallReply(transcript: string): 'coming' | 'later' | 'cancel' | 'unclear' {
  const t = ` ${(transcript ?? '').toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (t.trim().length < 2) return 'unclear';
  if (/ (venam|vendam|vendaam|cancel|vara mudiyathu|vara mudiyadhu|not coming|wont come|dont want) |வேண்டாம்|வேணாம்|கேன்சல்|வர முடியாது|முடியாது/.test(t)) return 'cancel';
  if (/ (naalaikku|nalaiku|naalaiku|tomorrow|late|later|konjam neram|aprom|apram|evening|saayangaalam|night) |நாளைக்கு|லேட்|அப்புறம்|கொஞ்ச நேரம்|சாயங்காலம்|நைட்/.test(t)) return 'later';
  if (/ (varen|vareen|varuven|varuvom|vanthuruven|vandhuruven|coming|ok|okay|sari|seri|aama|aamam|yes|ippo|now|minutes|nimisham|thanks|nandri) |வர்றேன்|வரேன்|வருவேன்|வந்துருவேன்|சரி|ஆமா|ஆமாம்|ஓகே|இப்போ|நிமிஷ|நன்றி/.test(t)) return 'coming';
  return 'unclear';
}

/**
 * "Your order is ready, exactly as you asked — come and collect it."
 * When staff mark an order Ready, the assistant calls the customer (Tamil voice, short two-way call:
 * it listens to one reply and notes it on the order). If calling is not set up, outside calling
 * hours, or the call is not answered, the same message goes on WhatsApp. Every outcome is written
 * to the order's history; nothing is reported as delivered unless it was.
 */
@Injectable()
export class ReadyNoticeService {
  private client?: InstanceType<typeof plivo.Client>;
  /** Replaced in tests; production dials through Plivo. */
  dialer: Dialer = async (from, to, answerUrl, hangupUrl) => {
    this.client ??= new plivo.Client(config.plivo.authId, config.plivo.authToken);
    const r = (await this.client.calls.create(from, to, answerUrl, {
      answerMethod: 'POST',
      hangupUrl,
      hangupMethod: 'POST',
      ringTimeout: config.plivo.ringTimeoutSec,
      timeLimit: 180,
    })) as { requestUuid?: string | string[] };
    return { requestUuid: Array.isArray(r.requestUuid) ? r.requestUuid[0] : r.requestUuid };
  };
  /** Replaced in tests: fetch a Plivo recording. */
  fetchRecording = async (url: string): Promise<Buffer> => {
    const auth = 'Basic ' + Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString('base64');
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await fetch(url, { headers: attempt ? { Authorization: auth } : {}, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length > 44) return b;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Recording not available');
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly conversations: ConversationsService,
    private readonly sarvam: SarvamService,
    private readonly sender: WhatsAppSenderService,
  ) {}

  /** Can we place a real call? Names of what is missing, never values. */
  voiceStatus(): { ready: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!config.plivo.authId) missing.push('PLIVO_AUTH_ID');
    if (!config.plivo.authToken) missing.push('PLIVO_AUTH_TOKEN');
    if (!config.plivo.fromNumber) missing.push('PLIVO_FROM_NUMBER');
    if (!this.sarvam.enabled) missing.push('SARVAM_API_KEY');
    if (!/^https:\/\//.test(config.publicBaseUrl) || /localhost|127\.0\.0\.1/.test(config.publicBaseUrl)) missing.push('PUBLIC_BASE_URL (public https)');
    return { ready: missing.length === 0, missing };
  }

  /** Staff marked the order Ready (or pressed "Call again"). Never throws: failures are recorded on the order. */
  async notify(organizationId: string, orderId: string, opts: { force?: boolean } = {}) {
    try {
      const order = await this.orders.getOrder(organizationId, orderId);
      if (order.status !== 'ready') return;
      if (!opts.force && order.readyNotice && ['calling', 'answered', 'whatsapp_sent'].includes(order.readyNotice)) return;
      const voice = this.voiceStatus();
      if (!voice.ready) return this.whatsapp(order, `Call not placed: voice calling not set up (${voice.missing.join(', ')})`);
      const hour = istHour();
      if (hour < config.voice.callWindowStartHour || hour >= config.voice.callWindowEndHour) {
        return this.whatsapp(order, `Call not placed: outside calling hours (${config.voice.callWindowStartHour}:00–${config.voice.callWindowEndHour}:00 IST)`);
      }
      if (!order.customerPhone) return this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'not_sent', note: 'No phone number on the order' });
      await this.call(order);
    } catch (error) {
      log.error('ready_notice.failed', { organizationId, orderId, error: errorMessage(error) });
    }
  }

  private async call(order: OrderView) {
    const organizationId = await this.orgOf(order.id);
    const live = await this.prisma.call.findFirst({ where: { customerId: order.customerId, status: { in: ['queued', 'ringing', 'in_progress'] }, createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } });
    if (live) return this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'calling', readyCallId: live.id, note: 'A call to this customer is already in progress' });
    const call = await this.prisma.call.create({
      data: {
        organizationId,
        customerId: order.customerId,
        direction: 'outbound',
        status: 'queued',
        toNumber: order.customerPhone!,
        fromNumber: config.plivo.fromNumber,
        language: order.language === 'english' ? 'en-IN' : 'ta-IN',
        summary: `Order ready call for ${order.orderNumber}`,
      },
    });
    const base = config.publicBaseUrl;
    try {
      const r = await this.dialer(config.plivo.fromNumber, order.customerPhone!, `${base}/voice/ready/answer?callId=${call.id}`, `${base}/voice/ready/hangup?callId=${call.id}`);
      await this.prisma.call.update({ where: { id: call.id }, data: { status: 'ringing', providerRequestId: r.requestUuid } });
      await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'calling', readyCallId: call.id });
      log.info('ready_notice.dialing', { organizationId, orderId: order.id, callId: call.id });
    } catch (error) {
      await this.prisma.call.update({ where: { id: call.id }, data: { status: 'failed', outcome: 'failed', hangupCause: errorMessage(error).slice(0, 190), endedAt: new Date() } });
      await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'failed', readyCallId: call.id, note: `Call failed: ${errorMessage(error).slice(0, 200)}` });
      await this.whatsapp(order, 'Call failed');
    }
  }

  /** Plivo answer URL: say the ready message and listen for one reply. */
  async answer(callId: string, params: PlivoParams): Promise<string> {
    const ctx = await this.context(callId);
    if (!ctx) return response(HANGUP);
    const { call, order } = ctx;
    await this.prisma.call.update({ where: { id: call.id }, data: { status: 'in_progress', answeredAt: call.answeredAt ?? new Date(), providerCallId: params.CallUUID ?? call.providerCallId } });
    const st = styleOf(order.language);
    const opening = say.readyCallOpening(st, {
      name: firstName(order.customerName) || undefined,
      business: (await this.prisma.organization.findUnique({ where: { id: call.organizationId }, select: { name: true } }))?.name ?? 'GR Chicken',
      items: itemsPhrase(order.items, st),
      shop: order.outlet.name.replace(/\s*\(Demo\)/, ''),
      pickupAt: new Date(order.pickupAt),
      total: order.total,
      paid: order.paymentStatus === 'paid',
    });
    const english = say.readyCallOpening('en', { name: firstName(order.customerName) || undefined, business: 'GR Chicken', items: itemsPhrase(order.items, 'en'), shop: order.outlet.name, pickupAt: new Date(order.pickupAt), total: order.total, paid: order.paymentStatus === 'paid' });
    await this.saveLine(call.organizationId, order, 'assistant', opening, call.id);
    await this.orders.recordReadyNotice(call.organizationId, order.id, { readyNotice: 'answered', readyCallId: call.id });
    const url = await this.sarvam.textToSpeechUrl(opening).catch(() => '');
    const action = `${config.publicBaseUrl}/voice/ready/turn?callId=${encodeURIComponent(call.id)}`;
    const record = `<Record action="${escapeXml(action)}" method="POST" fileFormat="wav" maxLength="15" timeout="3" playBeep="false" redirect="true" />`;
    return response(`${sayXml(url, english)}\n${record}`);
  }

  /** Plivo <Record> action: the customer's one reply. Answer, note it on the order, hang up. */
  async turn(callId: string, params: PlivoParams): Promise<string> {
    const ctx = await this.context(callId);
    if (!ctx) return response(HANGUP);
    const { call, order } = ctx;
    const st = styleOf(order.language);
    let transcript = '';
    if (params.RecordUrl) {
      try {
        const audio = await this.fetchRecording(params.RecordUrl);
        transcript = (await this.sarvam.speechToText(audio, 'reply.wav', 'audio/wav')).transcript?.trim() ?? '';
      } catch (error) {
        log.warn('ready_notice.stt_failed', { callId, error: errorMessage(error) });
      }
    }
    const kind = readCallReply(transcript);
    if (transcript) await this.saveLine(call.organizationId, order, 'user', transcript, call.id);
    const reply = kind === 'coming' ? say.readyCallComing(st) : kind === 'later' ? say.readyCallLater(st) : kind === 'cancel' ? say.readyCallCancel(st) : say.readyCallUnclear(st);
    await this.saveLine(call.organizationId, order, 'assistant', reply, call.id);
    const note = transcript ? `Customer said on the call: "${transcript.slice(0, 300)}" (${kind})` : 'No clear reply on the call';
    await this.orders.recordReadyNotice(call.organizationId, order.id, { readyNotice: 'answered', readyCallId: call.id, note });
    await this.prisma.call.update({ where: { id: call.id }, data: { outcome: kind === 'cancel' ? 'human_requested' : kind === 'coming' ? 'interested' : 'connected', turns: { increment: 1 } } });
    if (kind === 'cancel' && order.conversationId) {
      await this.prisma.conversation.updateMany({ where: { id: order.conversationId, organizationId: call.organizationId }, data: { status: 'human_handoff', updatedAt: new Date() } });
    }
    if (kind === 'unclear') await this.whatsapp(order, 'Reply on the call was not clear', { keepStatus: true });
    const url = await this.sarvam.textToSpeechUrl(reply).catch(() => '');
    return response(`${sayXml(url, kind === 'coming' ? 'Great, thank you!' : 'Thank you. We will message you the details.')}\n${HANGUP}`);
  }

  /** Plivo hangup URL. An unanswered call falls back to WhatsApp. */
  async hangup(callId: string | undefined, params: PlivoParams) {
    if (!callId) return { ok: true };
    const ctx = await this.context(callId);
    if (!ctx) return { ok: true };
    const { call, order } = ctx;
    const answered = Boolean(call.answeredAt);
    const duration = Number(params.Duration ?? params.BillDuration ?? 0) || undefined;
    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        status: answered ? 'completed' : params.HangupCause === 'USER_BUSY' ? 'busy' : 'no_answer',
        outcome: call.outcome ?? (answered ? 'connected' : 'no_answer'),
        endedAt: new Date(),
        durationSec: duration,
        hangupCause: params.HangupCause?.slice(0, 190),
      },
    });
    if (!answered) {
      await this.orders.recordReadyNotice(call.organizationId, order.id, { readyNotice: 'no_answer', readyCallId: call.id, note: `Call not answered (${params.HangupCause ?? 'no answer'})` });
      await this.whatsapp(order, 'Call not answered');
    }
    return { ok: true };
  }

  /** The ready message on WhatsApp (within 24h: free text; otherwise the approved order-ready template). */
  private async whatsapp(order: OrderView, why: string, opts: { keepStatus?: boolean } = {}) {
    const organizationId = await this.orgOf(order.id);
    const st = waStyleOf(order.language);
    const text = say.readyWhatsApp(st, { orderNumber: order.orderNumber, items: itemsPhrase(order.items, st), shop: order.outlet.name, total: order.total, paid: order.paymentStatus === 'paid' });
    if (order.channel === 'test') {
      // Dashboard test chat: show the message in the test conversation, send nothing.
      if (order.conversationId) await this.conversations.addMessage({ organizationId, conversationId: order.conversationId, role: 'assistant', content: text, metadata: { kind: 'order_ready', test: true } });
      if (!opts.keepStatus) await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'whatsapp_sent', note: `${why}. Test chat: ready message shown in the test conversation (not sent on WhatsApp).` });
      return;
    }
    try {
      const windowOpen = await this.conversations.isWhatsAppWindowOpen(organizationId, order.customerId);
      let content = text;
      if (windowOpen) await this.sender.sendText(order.customerPhone!, text);
      else if (config.whatsapp.stepTemplates.order_ready) {
        await this.sender.sendNamedTemplate(order.customerPhone!, config.whatsapp.stepTemplates.order_ready, [order.orderNumber]);
        content = `[template:${config.whatsapp.stepTemplates.order_ready}] ${order.orderNumber}`;
      } else {
        throw new Error('Customer has not messaged in 24h and WHATSAPP_TEMPLATE_ORDER_READY is not set');
      }
      if (order.conversationId) await this.conversations.addMessage({ organizationId, conversationId: order.conversationId, role: 'assistant', content, metadata: { kind: 'order_ready' } });
      if (!opts.keepStatus) await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'whatsapp_sent', note: `${why}. Ready message sent on WhatsApp.` });
    } catch (error) {
      if (!opts.keepStatus) await this.orders.recordReadyNotice(organizationId, order.id, { readyNotice: 'not_sent', note: `${why}. WhatsApp also failed: ${errorMessage(error).slice(0, 200)}. Please call the customer.` });
    }
  }

  private async context(callId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) return undefined;
    const row = await this.prisma.order.findFirst({ where: { organizationId: call.organizationId, readyCallId: call.id } });
    if (!row) return undefined;
    return { call, order: await this.orders.getOrder(call.organizationId, row.id) };
  }

  private async orgOf(orderId: string) {
    return (await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { organizationId: true } })).organizationId;
  }

  /** Call lines go into the customer's voice conversation so staff can read the call in the inbox. */
  private async saveLine(organizationId: string, order: OrderView, role: 'user' | 'assistant', content: string, callId: string) {
    if (!order.customerPhone) return;
    const conv = await this.conversations.getOrCreateConversation({ organizationId, channel: 'voice', externalId: order.customerPhone, customerId: order.customerId });
    await this.conversations.addMessage({ organizationId, conversationId: conv.id, role, content, metadata: { callId, orderId: order.id, kind: 'order_ready_call' } });
  }
}
