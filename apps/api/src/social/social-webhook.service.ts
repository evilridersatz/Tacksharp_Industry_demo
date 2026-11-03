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
import { SocialSenderService, type SocialChannel } from './social-sender.service.js';

type Attachment = { type?: string; payload?: { url?: string } };
type MessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; attachments?: Attachment[]; is_echo?: boolean; is_deleted?: boolean; quick_reply?: { payload?: string } };
};
type Body = { object?: string; entry?: Array<{ id?: string; time?: number; messaging?: MessagingEvent[] }> };

const LABEL: Record<string, string> = { image: '[Image]', video: '[Video]', audio: '[Voice message]', file: '[File]', story_mention: '[Story mention]', share: '[Shared post]', reel: '[Reel]', ig_reel: '[Reel]' };
export const SOCIAL_HANDOFF_REASON = 'Instagram / Messenger: answered by the team (AI replies on this channel are pending)';

/**
 * Instagram / Messenger inbound (Meta webhook, signature checked by the controller). The organization comes from the
 * Page id / Instagram account id Meta puts in the delivery, mapped when the business enabled the integration; an
 * unknown id is dropped (no default organization). Each message is stored once (Meta's message id, under a per-person
 * lock), linked to a customer record through SocialIdentity, and lands in the team inbox as an open conversation with
 * the AI off (AI replies on these channels are not built yet). STOP / START are honoured. Media is labelled, never
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
      for (const ev of entry.messaging ?? []) {
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
    const content = text || kinds.map((k) => LABEL[k] ?? '[Attachment]').join(' ') || '[Message]';

    const customer = await this.customerFor(org, channel, from);
    const previousInbound = customer.lastInboundAt;
    const kw = optKeyword(text);
    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { lastInboundAt: new Date(), ...(kw === 'stop' ? { optedOutAt: new Date() } : kw === 'start' ? { optedOutAt: null } : {}) },
    });

    const existing = await this.prisma.conversation.findFirst({ where: { organizationId: org, channel, externalId: from }, select: { id: true } });
    const conv = await this.conversations.getOrCreateConversation({ organizationId: org, channel, externalId: from, customerId: customer.id });
    // The AI does not answer on these channels yet: every conversation is the team's, said plainly in the inbox.
    if (!existing) await this.prisma.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false, handoffReason: SOCIAL_HANDOFF_REASON, handoffAt: new Date() } });
    await this.conversations.addMessage({ organizationId: org, conversationId: conv.id, role: 'user', content, externalId: m.mid!, metadata: { social: { channel, attachments: kinds } } as never });
    await this.inbox?.onCustomerMessage(org, conv.id).catch((e) => log.warn('inbox.update_failed', { error: describeError(e) }));

    // STOP / START confirmation, or the optional acknowledgement after 24 h of silence.
    let reply: { text: string; kind: 'opt' | 'auto' } | null = null;
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

  /** The customer record behind a Meta user id (created on first contact; no phone number). */
  private async customerFor(org: string, channel: SocialChannel, userId: string) {
    const found = await this.prisma.socialIdentity.findUnique({ where: { organizationId_channel_externalUserId: { organizationId: org, channel, externalUserId: userId } }, include: { customer: true } });
    if (found) return found.customer;
    const name = await this.sender.profileName(org, userId);
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
