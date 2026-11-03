import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { CredentialsService } from '../integrations/credentials.service.js';
import { InboxService } from '../inbox/inbox.service.js';
import { optKeyword, optReply } from '../consent/opt-out.js';
import { queueRedis } from '../queues/queues.js';
import { withLock } from '../common/redis-lock.js';
import { recordWebhookFailure } from '../common/webhook-failures.js';
import { describeError } from '../common/errors.js';
import { log } from '../common/logger.js';
import { COMMENT_CHANNEL, SocialSenderService, type SocialChannel } from './social-sender.service.js';
import { SocialAiService } from './social-ai.service.js';

type Attachment = { type?: string; payload?: { url?: string } };
type MessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; attachments?: Attachment[]; is_echo?: boolean; is_deleted?: boolean; quick_reply?: { payload?: string }; reply_to?: { mid?: string; story?: { url?: string; id?: string } } };
  /** Messenger: delivered up to `watermark` (and these mids when present). */
  delivery?: { mids?: string[]; watermark?: number };
  /** Messenger: read up to `watermark`; Instagram: read this `mid`. */
  read?: { watermark?: number; mid?: string };
  /** An emoji reaction to message `mid` (react / unreact). */
  reaction?: { mid?: string; action?: string; reaction?: string; emoji?: string };
};
type CommentValue = { id?: string; text?: string; from?: { id?: string; username?: string }; media?: { id?: string; media_product_type?: string }; parent_id?: string };
type Entry = { id?: string; time?: number; messaging?: MessagingEvent[]; field?: string; value?: CommentValue; changes?: Array<{ field?: string; value?: CommentValue }> };
type Body = { object?: string; entry?: Entry[] };

/** Only Meta's own CDN links are kept for display (https; fbcdn / cdninstagram / fbsbx / facebook / instagram hosts). */
export function metaMediaUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    return /(^|\.)(fbcdn\.net|cdninstagram\.com|fbsbx\.com|facebook\.com|instagram\.com)$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}


const LABEL: Record<string, string> = { image: '[Image]', video: '[Video]', audio: '[Voice message]', file: '[File]', story_mention: '[Story mention]', share: '[Shared post]', reel: '[Reel]', ig_reel: '[Reel]' };
export const SOCIAL_HANDOFF_REASON = 'Instagram / Messenger: answered by the team (no AI agent is chosen in the Instagram & Messenger settings)';

/**
 * Instagram / Messenger inbound (Meta webhook, signature checked by the controller). The organization comes from the
 * Page id / Instagram account id Meta puts in the delivery, mapped when the business enabled the integration; an
 * unknown id is dropped (no default organization). Each message is stored once (Meta's message id, under a per-person
 * lock), linked to a customer record through SocialIdentity, and lands in the team inbox. When the business chose an
 * active agent (Instagram & Messenger settings) the AI answers (SocialAiService); otherwise the team does. STOP / START
 * are honoured. Media is labelled, never
 * downloaded or stored. An optional automatic acknowledgement goes out after 24 h of silence, through the live gate.
 */
@Injectable()
export class SocialWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly conversations: ConversationsService,
    private readonly creds: CredentialsService,
    private readonly sender: SocialSenderService,
    @Optional() private readonly inbox?: InboxService,
    @Optional() private readonly ai?: SocialAiService,
  ) {}

  /** The channel and the organization for one entry (from Meta's ids, never from the message). */
  async route(object: string | undefined, entryId: string | undefined): Promise<{ channel: SocialChannel; organizationId: string } | null> {
    const channel: SocialChannel | null = object === 'page' ? 'messenger' : object === 'instagram' ? 'instagram' : null;
    if (!channel || !entryId) return null;
    const organizationId = await this.tenancy.resolve(channel === 'messenger' ? 'messenger_page_id' : 'instagram_account_id', entryId);
    if (!organizationId) return null;
    // Disabled (or failing) integration: nothing is accepted, even while the routing lookup is still cached.
    const c = await this.creds.resolve(organizationId, 'meta_social').catch(() => null);
    return c?.source === 'organization' ? { channel, organizationId } : null;
  }

  /** App secrets that may sign this delivery: those of the organizations owning the Page / account in it. */
  async appSecrets(body: unknown): Promise<string[]> {
    const b = body as Body;
    const out = new Set<string>();
    for (const e of (b?.entry ?? []).slice(0, 5)) {
      const r = await this.route(b.object, e.id).catch(() => null);
      if (!r) continue;
      const c = await this.creds.resolve(r.organizationId, 'meta_social').catch(() => null);
      if (c?.source === 'organization' && c.secrets.appSecret) out.add(c.secrets.appSecret);
    }
    return [...out];
  }

  async process(body: unknown) {
    const b = body as Body;
    if (b?.object !== 'page' && b?.object !== 'instagram') return { success: true, ignored: true };
    let stored = 0;
    for (const entry of b.entry ?? []) {
      const r = await this.route(b.object, entry.id);
      if (!r) {
        log.warn('social.unknown_account', { object: b.object, events: entry.messaging?.length ?? 0 });
        recordWebhookFailure('whatsapp', 'social_unknown_account', '/webhooks/meta-social');
        continue;
      }
      // Instagram comments: Instagram Login format (entry.field / entry.value) or Facebook Login format (entry.changes[]).
      const comments = [...(entry.field === 'comments' && entry.value ? [entry.value] : []), ...(entry.changes ?? []).filter((c) => c.field === 'comments' && c.value).map((c) => c.value!)];
      if (r.channel === 'instagram') {
        for (const v of comments) {
          if (!v.id || !v.from?.id || v.from.id === entry.id) continue; // our own replies come back as comments too
          const done = await withLock(queueRedis, `social:${r.organizationId}:comment:${v.from.id}`, () => this.handleComment(r.organizationId, v), { ttlMs: 30_000, waitMs: 20_000 });
          if (done) stored++;
        }
      }
      for (const ev of entry.messaging ?? []) {
        if (ev.delivery || ev.read) {
          await this.receipt(r.organizationId, r.channel, ev).catch((e) => log.warn('social.receipt_failed', { error: describeError(e) }));
          continue;
        }
        if (ev.reaction) {
          await this.react(r.organizationId, r.channel, ev).catch((e) => log.warn('social.reaction_failed', { error: describeError(e) }));
          continue;
        }
        const m = ev.message;
        const from = ev.sender?.id;
        // Our own sends come back as echoes; read / delivery / reaction events carry no message.
        if (!m?.mid || !from || m.is_echo || m.is_deleted || from === entry.id) continue;
        const done = await withLock(queueRedis, `social:${r.organizationId}:${r.channel}:${from}`, () => this.handle(r.organizationId, r.channel, from, m), { ttlMs: 30_000, waitMs: 20_000 });
        if (done) stored++;
      }
    }
    return { success: true, stored };
  }

  private async handle(org: string, channel: SocialChannel, from: string, m: NonNullable<MessagingEvent['message']>): Promise<boolean> {
    if (await this.prisma.message.findFirst({ where: { organizationId: org, externalId: m.mid! }, select: { id: true } })) {
      log.info('social.duplicate', { channel });
      return false;
    }
    const kinds = (m.attachments ?? []).map((a) => a.type ?? 'file');
    const text = (m.text ?? '').trim().slice(0, 4000);
    const story = m.reply_to?.story ? { id: String(m.reply_to.story.id ?? '').slice(0, 100) || null, url: metaMediaUrl(m.reply_to.story.url) } : null;
    const base = text || kinds.map((k) => LABEL[k] ?? '[Attachment]').join(' ') || '[Message]';
    const content = story ? `[Reply to your story] ${base}` : base;
    // Media is never downloaded or stored: the Meta CDN link (it expires) is kept for the inbox to show.
    const media = (m.attachments ?? []).map((a) => ({ type: String(a.type ?? 'file').slice(0, 20), url: metaMediaUrl(a.payload?.url) })).filter((a) => a.url).slice(0, 10);

    const customer = await this.customerFor(org, channel, from);
    const previousInbound = customer.lastInboundAt;
    const kw = optKeyword(text);
    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { lastInboundAt: new Date(), ...(kw === 'stop' ? { optedOutAt: new Date() } : kw === 'start' ? { optedOutAt: null } : {}) },
    });

    const agent = (await this.ai?.agentFor(org).catch(() => null)) ?? null;
    const existing = await this.prisma.conversation.findFirst({ where: { organizationId: org, channel, externalId: from }, select: { id: true } });
    const conv = await this.conversations.getOrCreateConversation({ organizationId: org, channel, externalId: from, customerId: customer.id });
    // Without a chosen agent every new conversation is the team's, said plainly in the inbox.
    if (!existing && !agent) await this.prisma.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false, handoffReason: SOCIAL_HANDOFF_REASON, handoffAt: new Date() } });
    const inbound = await this.conversations.addMessage({ organizationId: org, conversationId: conv.id, role: 'user', content, externalId: m.mid!, metadata: { social: { channel, attachments: kinds, ...(media.length ? { media } : {}), ...(story ? { story } : {}) } } as never });
    await this.inbox?.onCustomerMessage(org, conv.id).catch((e) => log.warn('inbox.update_failed', { error: describeError(e) }));

    // STOP / START confirmation, or the optional acknowledgement after 24 h of silence.
    let reply: { text: string; kind: 'opt' | 'auto' } | null = null;
    const current = await this.prisma.conversation.findUnique({ where: { id: conv.id } });
    if (!kw && agent && current?.aiEnabled && !customer.optedOutAt && !customer.doNotContact) {
      const did = await this.ai!.answer(org, channel, current, customer, from, text, inbound.id, agent).catch(async (e) => {
        // The customer must not be left without an answer and without a person: hand over.
        log.warn('social.ai_failed', { channel, error: describeError(e) });
        await this.prisma.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false, status: 'human_handoff', handoffReason: 'The AI could not reply (internal error): the team takes over.', handoffAt: new Date(), inboxStatus: 'open' } }).catch(() => undefined);
        return 'handoff' as const;
      });
      await this.inbox?.onCustomerMessage(org, conv.id).catch(() => undefined);
      log.info('social.inbound', { channel, organizationId: org, attachments: kinds.length, ai: did });
      return true;
    }
    if (kw) {
      const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { name: true } });
      reply = { text: optReply(kw, o?.name ?? 'us', customer.language), kind: 'opt' };
    } else if (!customer.optedOutAt && !this.sender.windowOpen(previousInbound)) {
      const cred = await this.creds.resolve(org, 'meta_social').catch(() => null);
      const auto = cred?.source === 'organization' ? cred.config.autoReply?.trim() : '';
      if (auto) reply = { text: auto, kind: 'auto' };
    }
    if (reply) {
      const sent = await this.sender.send(org, channel, from, customer.isDemo, reply.text);
      await this.conversations.addMessage({
        organizationId: org,
        conversationId: conv.id,
        role: 'assistant',
        content: reply.text,
        ...(sent.messageId ? { externalId: sent.messageId } : {}),
        metadata: { ...(reply.kind === 'opt' ? { optOut: true } : { autoReply: true }), ...(sent.sent ? {} : { simulated: !sent.error, notSentReason: sent.notSentReason ?? sent.error }) } as never,
      });
    }
    log.info('social.inbound', { channel, organizationId: org, attachments: kinds.length });
    return true;
  }

  /**
   * Delivery / read receipts for what we sent in this conversation. Messenger: `delivery.mids` (when present) and the
   * `watermark` time (everything sent up to then); Instagram: `read.mid` (that message and everything sent before it).
   * Statuses only move forward (accepted -> delivered -> read), through the same rule as WhatsApp receipts.
   */
  private async receipt(org: string, channel: SocialChannel, ev: MessagingEvent) {
    const user = ev.sender?.id;
    if (!user) return;
    const conv = await this.prisma.conversation.findFirst({ where: { organizationId: org, channel, externalId: user }, select: { id: true } });
    if (!conv) return;
    const status = ev.read ? 'read' : 'delivered';
    const ids = new Set<string>();
    for (const mid of ev.delivery?.mids ?? []) if (typeof mid === 'string') ids.add(mid);
    let upTo: Date | null = null;
    const wm = Number(ev.read?.watermark ?? ev.delivery?.watermark);
    if (Number.isFinite(wm) && wm > 0) upTo = new Date(wm);
    if (ev.read?.mid) {
      const m = await this.prisma.message.findFirst({ where: { organizationId: org, conversationId: conv.id, externalId: ev.read.mid }, select: { createdAt: true } });
      if (m) { ids.add(ev.read.mid); upTo = m.createdAt; }
    }
    if (upTo) {
      const earlier = await this.prisma.message.findMany({ where: { organizationId: org, conversationId: conv.id, role: 'assistant', externalId: { not: null }, createdAt: { lte: upTo } }, select: { externalId: true }, take: 200, orderBy: { createdAt: 'desc' } });
      for (const e of earlier) ids.add(e.externalId!);
    }
    let n = 0;
    for (const id of ids) n += await this.conversations.applyDeliveryStatus(org, id, status);
    if (n) log.info('social.receipt', { channel, status, updated: n });
  }

  /**
   * A customer's emoji reaction to a message in their conversation (ours or theirs): kept on that message so the thread
   * shows it; "unreact" removes it. Only messages of that person's conversation can be touched.
   */
  private async react(org: string, channel: SocialChannel, ev: MessagingEvent) {
    const user = ev.sender?.id;
    const mid = ev.reaction?.mid;
    if (!user || !mid || user === ev.recipient?.id) return;
    const conv = await this.prisma.conversation.findFirst({ where: { organizationId: org, channel, externalId: user }, select: { id: true } });
    if (!conv) return;
    const m = await this.prisma.message.findFirst({ where: { organizationId: org, conversationId: conv.id, externalId: mid }, select: { id: true, metadata: true } });
    if (!m) return;
    const md = { ...((m.metadata ?? {}) as Record<string, unknown>) };
    if (ev.reaction!.action === 'unreact') delete md.reaction;
    else md.reaction = { emoji: String(ev.reaction!.emoji ?? '').slice(0, 16) || null, kind: String(ev.reaction!.reaction ?? '').slice(0, 30) || null, at: new Date().toISOString() };
    await this.prisma.message.update({ where: { id: m.id }, data: { metadata: md as never } });
  }

  /**
   * An Instagram comment: its own inbox conversation (channel instagram_comment, one per comment), linked to the
   * commenter's customer record. The AI never answers comments; the team replies publicly or with one private message.
   */
  private async handleComment(org: string, v: CommentValue): Promise<boolean> {
    if (await this.prisma.message.findFirst({ where: { organizationId: org, externalId: v.id! }, select: { id: true } })) return false;
    const customer = await this.customerFor(org, 'instagram', v.from!.id!, v.from!.username ? `@${v.from!.username}`.slice(0, 60) : undefined);
    const conv = await this.conversations.getOrCreateConversation({ organizationId: org, channel: COMMENT_CHANNEL, externalId: v.id!, customerId: customer.id });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false, handoffReason: 'Instagram comment: answered by the team (public reply or one private message).', handoffAt: new Date(), inboxStatus: 'open' } });
    const text = (v.text ?? '').trim().slice(0, 2200) || '[Comment]';
    await this.conversations.addMessage({ organizationId: org, conversationId: conv.id, role: 'user', content: text, externalId: v.id!, metadata: { comment: { commentId: v.id, userId: v.from!.id, username: v.from!.username ?? null, mediaId: v.media?.id ?? null, mediaType: v.media?.media_product_type ?? null, parentId: v.parent_id ?? null } } as never });
    await this.inbox?.onCustomerMessage(org, conv.id).catch(() => undefined);
    log.info('social.comment', { organizationId: org });
    return true;
  }

  /** The customer record behind a Meta user id (created on first contact; no phone number). */
  private async customerFor(org: string, channel: SocialChannel, userId: string, knownName?: string) {
    const found = await this.prisma.socialIdentity.findUnique({ where: { organizationId_channel_externalUserId: { organizationId: org, channel, externalUserId: userId } }, include: { customer: true } });
    if (found) return found.customer;
    const name = knownName ?? (await this.sender.profileName(org, userId));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const c = await tx.customer.create({ data: { organizationId: org, name: name ?? `${channel === 'instagram' ? 'Instagram' : 'Messenger'} user ••${userId.slice(-4)}`, source: channel, lastInboundAt: null } });
        await tx.socialIdentity.create({ data: { organizationId: org, channel, externalUserId: userId, customerId: c.id, displayName: name ?? null } });
        return c;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.socialIdentity.findUnique({ where: { organizationId_channel_externalUserId: { organizationId: org, channel, externalUserId: userId } }, include: { customer: true } });
        if (again) return again.customer;
      }
      throw e;
    }
  }
}
