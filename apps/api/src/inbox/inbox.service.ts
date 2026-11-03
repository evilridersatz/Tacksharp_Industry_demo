import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { PERMISSIONS, can } from '../governance/permissions.js';
import { describeError } from '../common/errors.js';
import { log } from '../common/logger.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';

export type Actor = { sub: string; org: string; role: string };
export const INBOX_STATUSES = ['open', 'pending', 'resolved'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,29}$/u;
/** Roles that can be given conversations (they can reply). */
const ASSIGNABLE = (role: string) => can(role, PERMISSIONS.inboxReply);

/**
 * The team inbox on top of the existing conversations (WhatsApp, voice, web): one row per conversation, shared by
 * every industry. People see, assign, label and prioritise conversations, add internal notes, reply as themselves,
 * and take a conversation over from the AI (the AI then stays silent until it is returned). Every change is audited.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly sender: WhatsAppSenderService,
  ) {}

  // ------------------------------------------------------------------------------------------------ read

  async list(org: string, me: string, q: { status?: string; assignee?: string; label?: string; priority?: string; channel?: string; q?: string; ai?: string }) {
    const where: Prisma.ConversationWhereInput = { organizationId: org };
    if (q.status && q.status !== 'all') {
      if (!(INBOX_STATUSES as readonly string[]).includes(q.status)) throw new BadRequestException('status: open, pending, resolved or all.');
      where.inboxStatus = q.status;
    }
    if (q.assignee === 'me') where.assigneeId = me;
    else if (q.assignee === 'unassigned') where.assigneeId = null;
    else if (q.assignee && q.assignee !== 'all') where.assigneeId = q.assignee;
    if (q.priority && q.priority !== 'all') where.priority = q.priority;
    if (q.channel && q.channel !== 'all') where.channel = q.channel;
    if (q.ai === 'off') where.aiEnabled = false;
    if (q.ai === 'handoff') where.status = 'human_handoff';
    if (q.label) where.labels = { array_contains: q.label } as never;
    const text = (q.q ?? '').trim().slice(0, 80);
    if (text) {
      const digits = text.replace(/\D/g, '');
      where.OR = [
        { Customer: { name: { contains: text } } },
        ...(digits.length >= 3 ? [{ externalId: { contains: digits } }] : []),
        { Message: { some: { content: { contains: text } } } },
      ];
    }
    const [rows, counts] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        take: 200,
        include: { Customer: { select: { id: true, name: true, phone: true, tags: true, optedOutAt: true } }, Message: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, role: true, createdAt: true, metadata: true } } },
      }),
      this.counts(org, me),
    ]);
    const users = await this.userNames(org, rows.map((r) => r.assigneeId).filter((x): x is string => Boolean(x)));
    return {
      counts,
      items: rows.map(({ Customer, Message, ...c }) => ({
        id: c.id,
        channel: c.channel,
        externalId: c.externalId,
        inboxStatus: c.inboxStatus,
        priority: c.priority,
        labels: (c.labels as string[] | null) ?? [],
        aiEnabled: c.aiEnabled,
        needsHuman: c.status === 'human_handoff',
        handoffReason: c.handoffReason,
        assignee: c.assigneeId ? { id: c.assigneeId, name: users.get(c.assigneeId) ?? 'Team member' } : null,
        customer: Customer,
        lastMessage: Message[0] ?? null,
        lastCustomerAt: c.lastCustomerAt,
        updatedAt: c.updatedAt,
      })),
    };
  }

  private async counts(org: string, me: string) {
    const by = await this.prisma.conversation.groupBy({ by: ['inboxStatus'], where: { organizationId: org }, _count: { _all: true } });
    const [mine, unassigned, handoff, aiOff] = await Promise.all([
      this.prisma.conversation.count({ where: { organizationId: org, assigneeId: me, inboxStatus: { not: 'resolved' } } }),
      this.prisma.conversation.count({ where: { organizationId: org, assigneeId: null, inboxStatus: 'open' } }),
      this.prisma.conversation.count({ where: { organizationId: org, status: 'human_handoff', inboxStatus: { not: 'resolved' } } }),
      this.prisma.conversation.count({ where: { organizationId: org, aiEnabled: false, inboxStatus: { not: 'resolved' } } }),
    ]);
    const s = Object.fromEntries(by.map((b) => [b.inboxStatus, b._count._all])) as Record<string, number>;
    return { open: s.open ?? 0, pending: s.pending ?? 0, resolved: s.resolved ?? 0, mine, unassigned, needsHuman: handoff, aiOff };
  }

  async detail(org: string, id: string) {
    const c = await this.prisma.conversation.findFirst({
      where: { id, organizationId: org },
      include: {
        Customer: { select: { id: true, name: true, phone: true, email: true, language: true, tags: true, source: true, messagingConsent: true, callingConsent: true, optedOutAt: true, doNotContact: true, lastInboundAt: true, createdAt: true } },
        notes: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    const messages = await this.prisma.message.findMany({ where: { organizationId: org, conversationId: id }, orderBy: { createdAt: 'asc' }, take: 500 });
    const customerId = c.Customer?.id;
    const [orders, leads, windowOpen] = await Promise.all([
      customerId ? this.prisma.order.findMany({ where: { organizationId: org, customerId }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, orderNumber: true, status: true, total: true, createdAt: true } }) : [],
      customerId ? this.prisma.lead.findMany({ where: { organizationId: org, customerId }, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, status: true, source: true, createdAt: true } }) : [],
      customerId ? this.conversations.isWhatsAppWindowOpen(org, customerId) : false,
    ]);
    const users = await this.userNames(org, [c.assigneeId, ...c.notes.map((n) => n.authorId)].filter((x): x is string => Boolean(x)));
    // Hand-over summary from facts only: why it was handed over and what the customer last said.
    const lastAsks = messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.content.slice(0, 200));
    return {
      id: c.id,
      channel: c.channel,
      externalId: c.externalId,
      inboxStatus: c.inboxStatus,
      priority: c.priority,
      labels: (c.labels as string[] | null) ?? [],
      aiEnabled: c.aiEnabled,
      needsHuman: c.status === 'human_handoff',
      handoff: c.status === 'human_handoff' || !c.aiEnabled ? { reason: c.handoffReason, at: c.handoffAt, lastCustomerMessages: lastAsks } : null,
      assignee: c.assigneeId ? { id: c.assigneeId, name: users.get(c.assigneeId) ?? 'Team member' } : null,
      customer: c.Customer,
      orders: orders.map((o) => ({ ...o, total: Number(o.total) })),
      leads,
      replyWindow: c.channel === 'whatsapp' ? { open: windowOpen, note: windowOpen ? 'You can reply with free text (customer wrote in the last 24 h).' : 'More than 24 h since the customer wrote: WhatsApp allows only an approved template. Free-text replies are blocked.' } : { open: false, note: 'Replies from the inbox are available for WhatsApp conversations.' },
      notes: c.notes.map((n) => ({ id: n.id, body: n.body, author: n.authorName ?? users.get(n.authorId) ?? 'Team member', createdAt: n.createdAt })),
      messages,
    };
  }

  async members(org: string) {
    const [home, guests] = await Promise.all([
      this.prisma.user.findMany({ where: { organizationId: org, disabledAt: null }, select: { id: true, name: true, email: true, role: true } }),
      this.prisma.organizationMembership.findMany({ where: { organizationId: org }, include: { user: { select: { id: true, name: true, email: true, disabledAt: true } } } }),
    ]);
    const all = [...home.map((u) => ({ id: u.id, name: u.name ?? u.email, role: u.role })), ...guests.filter((g) => !g.user.disabledAt && !home.some((h) => h.id === g.user.id)).map((g) => ({ id: g.user.id, name: g.user.name ?? g.user.email, role: g.role }))];
    return all.filter((m) => ASSIGNABLE(m.role)).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async userNames(org: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const rows = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
    return new Map(rows.map((u) => [u.id, u.name ?? u.email]));
  }

  // ------------------------------------------------------------------------------------------------ change

  private async get(org: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, organizationId: org } });
    if (!c) throw new NotFoundException('Conversation not found');
    return c;
  }

  /** Status / priority / labels / assignee. Changing someone else's assignment needs inbox.manage. */
  async update(actor: Actor, id: string, body: Record<string, unknown>) {
    const c = await this.get(actor.org, id);
    const data: Prisma.ConversationUpdateInput = {};
    const changes: Record<string, unknown> = {};
    const manage = can(actor.role, PERMISSIONS.inboxManage);
    if (body.inboxStatus !== undefined) {
      if (!(INBOX_STATUSES as readonly string[]).includes(String(body.inboxStatus))) throw new BadRequestException('inboxStatus: open, pending or resolved.');
      if (!manage && c.assigneeId && c.assigneeId !== actor.sub) throw new ForbiddenException('This conversation is assigned to someone else.');
      data.inboxStatus = String(body.inboxStatus);
      changes.inboxStatus = data.inboxStatus;
      // Resolving clears the "needs a person" flag; the AI's own state is unchanged (return it explicitly).
      if (data.inboxStatus === 'resolved' && c.status === 'human_handoff') data.status = 'active';
    }
    if (body.priority !== undefined) {
      if (!(PRIORITIES as readonly string[]).includes(String(body.priority))) throw new BadRequestException('priority: low, normal, high or urgent.');
      data.priority = String(body.priority);
      changes.priority = data.priority;
    }
    if (body.labels !== undefined) {
      if (!manage) throw new ForbiddenException('You need the "inbox.manage" permission to change labels.');
      if (!Array.isArray(body.labels) || body.labels.length > 10 || body.labels.some((l) => typeof l !== 'string' || !LABEL.test(l.trim()))) throw new BadRequestException('labels: up to 10 short words (letters, numbers, space, - or _).');
      const labels = [...new Set((body.labels as string[]).map((l) => l.trim().toLowerCase()))];
      data.labels = labels as Prisma.InputJsonValue;
      changes.labels = labels;
    }
    if (body.assigneeId !== undefined) {
      const to = body.assigneeId === null || body.assigneeId === '' ? null : String(body.assigneeId);
      if (to !== actor.sub && !manage) throw new ForbiddenException('You can assign conversations only to yourself.');
      if (to && !(await this.members(actor.org)).some((m) => m.id === to)) throw new BadRequestException('That person cannot take conversations in this workspace.');
      data.assigneeId = to;
      changes.assigneeId = to;
    }
    if (!Object.keys(changes).length) throw new BadRequestException('Nothing to change.');
    await this.prisma.conversation.update({ where: { id: c.id }, data });
    await this.audit(actor, c.id, 'inbox.updated', changes);
    return this.detail(actor.org, c.id);
  }

  /** A person takes over: the AI stops replying in this conversation until it is returned. */
  async takeOver(actor: Actor, id: string) {
    const c = await this.get(actor.org, id);
    await this.prisma.conversation.update({ where: { id: c.id }, data: { aiEnabled: false, inboxStatus: 'open', assigneeId: c.assigneeId ?? actor.sub, handoffAt: c.handoffAt ?? new Date(), handoffReason: c.handoffReason ?? 'Taken over by the team' } });
    await this.audit(actor, c.id, 'inbox.taken_over', {});
    return this.detail(actor.org, c.id);
  }

  /** Back to the AI with the full history kept; the "needs a person" flag is cleared. */
  async returnToAi(actor: Actor, id: string) {
    const c = await this.get(actor.org, id);
    await this.prisma.conversation.update({ where: { id: c.id }, data: { aiEnabled: true, status: c.status === 'human_handoff' ? 'active' : c.status, handoffReason: null, handoffAt: null } });
    await this.audit(actor, c.id, 'inbox.returned_to_ai', {});
    return this.detail(actor.org, c.id);
  }

  async addNote(actor: Actor, id: string, body: unknown) {
    const c = await this.get(actor.org, id);
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text || text.length > 4000) throw new BadRequestException('Write a note (up to 4000 characters).');
    const user = await this.prisma.user.findUnique({ where: { id: actor.sub }, select: { name: true, email: true } });
    await this.prisma.conversationNote.create({ data: { organizationId: actor.org, conversationId: c.id, authorId: actor.sub, authorName: user?.name ?? user?.email ?? null, body: text } });
    await this.audit(actor, c.id, 'inbox.note_added', { length: text.length });
    return this.detail(actor.org, c.id);
  }

  /**
   * A person replies on WhatsApp as the business. Refused (with the reason) when the customer opted out / is
   * do-not-contact, or outside WhatsApp's 24 h window (only approved templates may be sent then). Replying takes the
   * conversation over from the AI. The message is saved with the author; only Meta's receipts can say "delivered".
   */
  async reply(actor: Actor, id: string, body: unknown) {
    const c = await this.get(actor.org, id);
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text || text.length > 4096) throw new BadRequestException('Write a reply (up to 4096 characters).');
    if (c.channel !== 'whatsapp' || !c.externalId) throw new BadRequestException('Replies from the inbox are available for WhatsApp conversations.');
    const customer = c.customerId ? await this.prisma.customer.findFirst({ where: { id: c.customerId, organizationId: actor.org } }) : null;
    if (!customer) throw new BadRequestException('This conversation has no customer record.');
    if (customer.optedOutAt || customer.doNotContact) throw new BadRequestException('The customer opted out (STOP) or is marked do-not-contact: no message can be sent.');
    if (!(await this.conversations.isWhatsAppWindowOpen(actor.org, customer.id))) throw new BadRequestException('More than 24 hours since the customer last wrote: WhatsApp allows only an approved template. Use a campaign template or wait for the customer.');
    const user = await this.prisma.user.findUnique({ where: { id: actor.sub }, select: { name: true, email: true } });
    let providerMessageId: string | undefined;
    let deliveryStatus: string | null = 'accepted';
    let error: string | undefined;
    // Same live gate as every other send: DRY_RUN, demo customers and unapproved numbers are recorded, not sent.
    const gate = liveGate(followUpConfig(), { phone: customer.phone, isDemo: customer.isDemo });
    if (!gate.live) deliveryStatus = null;
    else {
      try {
        providerMessageId = await this.sender.sendText(c.externalId, text);
      } catch (e) {
        error = describeError(e);
        deliveryStatus = 'failed';
        log.warn('inbox.reply_failed', { conversationId: c.id, error });
      }
    }
    const msg = await this.conversations.addMessage({
      organizationId: actor.org,
      conversationId: c.id,
      role: 'assistant',
      content: text,
      ...(providerMessageId ? { externalId: providerMessageId } : {}),
      metadata: { author: 'staff', userId: actor.sub, authorName: user?.name ?? user?.email ?? 'Team member', ...(gate.live ? {} : { simulated: true, notSentReason: gate.reason }) } as never,
    });
    await this.prisma.message.update({ where: { id: msg.id }, data: { deliveryStatus, deliveryError: error?.slice(0, 500) ?? null, deliveryUpdatedAt: new Date() } }).catch(() => undefined);
    await this.prisma.conversation.update({ where: { id: c.id }, data: { aiEnabled: false, assigneeId: c.assigneeId ?? actor.sub, inboxStatus: c.inboxStatus === 'resolved' ? 'open' : c.inboxStatus, updatedAt: new Date() } });
    await this.audit(actor, c.id, 'inbox.replied', { ok: !error, sent: gate.live });
    if (error) throw new BadRequestException(`WhatsApp did not accept the message: ${error.slice(0, 200)}`);
    return { ...(await this.detail(actor.org, c.id)), sent: gate.live, ...(gate.live ? {} : { notSentReason: gate.reason }) };
  }

  /** Round-robin: the person able to reply with the fewest open conversations (ties: alphabetical). */
  async assignRoundRobin(actor: Actor | null, org: string, id: string) {
    const c = await this.get(org, id);
    const people = await this.members(org);
    if (!people.length) throw new BadRequestException('Nobody in this workspace can take conversations yet (invite a support agent).');
    const loads = await this.prisma.conversation.groupBy({ by: ['assigneeId'], where: { organizationId: org, inboxStatus: { not: 'resolved' }, assigneeId: { in: people.map((p) => p.id) } }, _count: { _all: true } });
    const load = new Map(loads.map((l) => [l.assigneeId!, l._count._all]));
    const pick = [...people].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.name.localeCompare(b.name))[0];
    await this.prisma.conversation.update({ where: { id: c.id }, data: { assigneeId: pick.id } });
    await this.audit(actor ?? { sub: 'system', org, role: 'system' }, c.id, 'inbox.assigned_round_robin', { assigneeId: pick.id });
    return this.detail(org, c.id);
  }

  /**
   * Called by the WhatsApp worker after every customer message: re-opens a resolved conversation, records when the
   * customer last wrote, and turns an AI hand-off (status human_handoff) into an open, high-priority inbox item
   * (assigned round-robin when the workspace enabled it).
   */
  async onCustomerMessage(org: string, conversationId: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id: conversationId, organizationId: org } });
    if (!c) return;
    const data: Prisma.ConversationUpdateInput = { lastCustomerAt: new Date() };
    if (c.inboxStatus === 'resolved') data.inboxStatus = 'open';
    const newHandoff = c.status === 'human_handoff' && !c.handoffAt;
    if (newHandoff) {
      data.handoffAt = new Date();
      data.handoffReason = c.handoffReason ?? 'The AI asked for a person (complaint, request for staff, or a question it could not answer).';
      data.inboxStatus = 'open';
      if (c.priority === 'low' || c.priority === 'normal') data.priority = 'high';
    }
    await this.prisma.conversation.update({ where: { id: c.id }, data });
    if (newHandoff && !c.assigneeId) {
      const st = await this.prisma.organizationSettings.findUnique({ where: { organizationId: org } });
      if ((st?.data as { inbox?: { autoAssign?: boolean } } | null)?.inbox?.autoAssign) await this.assignRoundRobin(null, org, c.id).catch((e) => log.warn('inbox.auto_assign_failed', { error: describeError(e) }));
    }
  }

  // ------------------------------------------------------------------------------------------------ saved replies

  savedReplies(org: string) {
    return this.prisma.savedReply.findMany({ where: { organizationId: org }, orderBy: { title: 'asc' } });
  }

  async saveReply(actor: Actor, id: string | null, body: Record<string, unknown>) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!title || title.length > 120) throw new BadRequestException('title: 1 to 120 characters.');
    if (!text || text.length > 4096) throw new BadRequestException('body: 1 to 4096 characters.');
    try {
      if (id) {
        const r = await this.prisma.savedReply.findFirst({ where: { id, organizationId: actor.org } });
        if (!r) throw new NotFoundException('Saved reply not found');
        return await this.prisma.savedReply.update({ where: { id: r.id }, data: { title, body: text } });
      }
      return await this.prisma.savedReply.create({ data: { organizationId: actor.org, title, body: text, createdBy: actor.sub } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new BadRequestException('A saved reply with this title already exists.');
      throw e;
    }
  }

  async deleteReply(actor: Actor, id: string) {
    const r = await this.prisma.savedReply.findFirst({ where: { id, organizationId: actor.org } });
    if (!r) throw new NotFoundException('Saved reply not found');
    await this.prisma.savedReply.delete({ where: { id: r.id } });
    return { deleted: true };
  }

  private audit(actor: Actor, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: actor.sub.includes(':') || actor.sub === 'system' ? actor.sub : `user:${actor.sub}`, entityType: 'conversation', entityId, action, data: data as Prisma.InputJsonValue } });
  }
}
