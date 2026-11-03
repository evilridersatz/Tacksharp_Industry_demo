import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';
import { TelephonyService } from '../telephony/telephony.service.js';
import { config } from '../common/config.js';
import { STAGES, leadScore, toCsv, validateAttributes } from './crm.js';

const LANGS = ['english', 'tamil', 'tanglish', 'hindi', 'malayalam', 'telugu', 'kannada'];
const CONSENT_SOURCES = ['customer_message', 'website_form', 'in_person', 'phone_call', 'import_with_proof', 'other'];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const WINDOW_MS = 24 * 3_600_000;

export type CustomerInput = {
  name?: unknown; phone?: unknown; email?: unknown; language?: unknown; location?: unknown; source?: unknown; tags?: unknown; attributes?: unknown; stage?: unknown; followUpAt?: unknown;
  messagingConsent?: unknown; callingConsent?: unknown; consentSource?: unknown; doNotContact?: unknown; optedOut?: unknown;
};
type Actor = { sub: string; role?: string };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Customer records of ONE organization (every query is scoped by organizationId; ids from another organization are
 * "not found"). Demo workspaces get demo customers (isDemo), real workspaces real ones: never mixed.
 * Contact actions (WhatsApp test / test call) are explicit, confirmed, consent-checked and live-gated
 * (DRY_RUN, approved test recipients, never a demo number); the result reports what the provider actually did.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly whatsapp?: WhatsAppSenderService,
    @Optional() private readonly telephony?: TelephonyService,
  ) {}

  private async isDemoOrg(org: string) {
    return Boolean((await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } }))?.isDemo);
  }

  private audit(org: string, actor: Actor, entityId: string, action: string, data: Record<string, unknown> = {}) {
    return this.prisma.auditEvent.create({ data: { organizationId: org, actor: `user:${actor.sub}`, entityType: 'customer', entityId, action, data: data as never } }).catch(() => undefined);
  }

  async list(org: string, q: { q?: string; consent?: string; source?: string; tag?: string; stage?: string; followUpDue?: string; page?: number; pageSize?: number }) {
    const pageSize = Math.min(100, Math.max(5, Math.round(q.pageSize ?? 25)));
    const page = Math.max(1, Math.round(q.page ?? 1));
    const and: Prisma.CustomerWhereInput[] = [{ organizationId: org }];
    const term = q.q?.trim().slice(0, 80);
    if (term) {
      const digits = term.replace(/\D/g, '');
      and.push({ OR: [{ name: { contains: term } }, { email: { contains: term } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])] });
    }
    if (q.consent === 'messaging') and.push({ messagingConsent: true, optedOutAt: null, doNotContact: false });
    else if (q.consent === 'calling') and.push({ callingConsent: true, optedOutAt: null, doNotContact: false });
    else if (q.consent === 'none') and.push({ messagingConsent: false, callingConsent: false });
    else if (q.consent === 'opted_out') and.push({ OR: [{ optedOutAt: { not: null } }, { doNotContact: true }] });
    if (q.source) and.push({ source: q.source.slice(0, 40) });
    const where: Prisma.CustomerWhereInput = { AND: [...and, ...this.crmFilters(q)] };
    const [total, rows] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({ where, orderBy: [{ updatedAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { leads: true, Conversation: true, calls: true, orders: true } } } }),
    ]);
    return { total, page, pageSize, rows: rows.map((c) => ({ ...this.view(c), lead: leadScore({ ...c, orders: c._count.orders }) })) };
  }

  private crmFilters(q: { tag?: string; stage?: string; followUpDue?: string }): Prisma.CustomerWhereInput[] {
    const out: Prisma.CustomerWhereInput[] = [];
    if (q.tag) out.push({ tags: { array_contains: q.tag.toLowerCase().slice(0, 30) } as never });
    if (q.stage === 'new') out.push({ stage: null });
    else if (q.stage && (STAGES as readonly string[]).includes(q.stage)) out.push({ stage: q.stage });
    if (q.followUpDue === 'true') out.push({ followUpAt: { lte: new Date() } });
    return out;
  }

  /** CSV of the filtered customers (max 5000 rows; formula-injection safe). */
  async exportCsv(org: string, actor: Actor, q: { q?: string; consent?: string; source?: string; tag?: string; stage?: string; followUpDue?: string }) {
    const first = await this.list(org, { ...q, page: 1, pageSize: 1 });
    const total = Math.min(first.total, 5000);
    const rows: Array<Record<string, unknown>> = [];
    for (let page = 1; rows.length < total; page++) {
      const r = await this.list(org, { ...q, page, pageSize: 100 });
      if (!r.rows.length) break;
      rows.push(...(r.rows as Array<Record<string, unknown>>));
    }
    const header = ['name', 'phone', 'email', 'language', 'source', 'stage', 'tags', 'whatsapp_consent', 'calling_consent', 'opted_out', 'do_not_contact', 'follow_up_at', 'lead_score', 'attributes', 'created_at'];
    const csv = toCsv(header, rows.slice(0, total).map((c) => [c.name, c.phone, c.email, c.language, c.source, c.stage ?? 'new', c.tags, c.messagingConsent, c.callingConsent, Boolean(c.optedOutAt), c.doNotContact, c.followUpAt, (c.lead as { score: number }).score, c.attributes, c.createdAt]));
    await this.audit(org, actor, org, 'exported', { rows: Math.min(rows.length, total), filters: q });
    return { csv, rows: Math.min(rows.length, total), truncated: first.total > 5000 };
  }

  /** Possible duplicates: the same email, or the same name, on different customer records. Reported, never merged. */
  async duplicates(org: string) {
    const rows = await this.prisma.customer.findMany({ where: { organizationId: org }, select: { id: true, name: true, phone: true, email: true, createdAt: true }, take: 20000 });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const keys = [r.email ? `email:${r.email.toLowerCase()}` : null, r.name && r.name.trim().length >= 3 ? `name:${r.name.trim().toLowerCase().replace(/\s+/g, ' ')}` : null].filter((k): k is string => Boolean(k));
      for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([key, g]) => ({ match: key.startsWith('email:') ? 'same email' : 'same name', value: key.slice(key.indexOf(':') + 1), customers: g.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, createdAt: c.createdAt })) }))
      // Newest first: a duplicate created today is the one worth fixing now.
      .sort((a, b) => Math.max(...b.customers.map((c) => c.createdAt.getTime())) - Math.max(...a.customers.map((c) => c.createdAt.getTime())))
      .slice(0, 50);
  }

  async addNote(org: string, actor: Actor, id: string, body: unknown) {
    const c = await this.prisma.customer.findFirst({ where: { id, organizationId: org }, select: { id: true } });
    if (!c) throw new NotFoundException('Customer not found');
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text || text.length > 4000) throw new BadRequestException('Write a note (up to 4000 characters).');
    const user = await this.prisma.user.findUnique({ where: { id: actor.sub }, select: { name: true, email: true } });
    const note = await this.prisma.customerNote.create({ data: { organizationId: org, customerId: c.id, authorId: actor.sub, authorName: user?.name ?? user?.email ?? null, body: text } });
    await this.audit(org, actor, c.id, 'note_added', { length: text.length });
    return note;
  }

  /** A follow-up task for the team (Tasks list), linked to the customer. */
  async addTask(org: string, actor: Actor, id: string, body: { title?: unknown; dueAt?: unknown }) {
    const c = await this.prisma.customer.findFirst({ where: { id, organizationId: org }, select: { id: true, name: true } });
    if (!c) throw new NotFoundException('Customer not found');
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length < 3 || title.length > 200) throw new BadRequestException('Task title: 3 to 200 characters.');
    const due = body.dueAt ? new Date(String(body.dueAt)) : null;
    if (due && Number.isNaN(due.getTime())) throw new BadRequestException('dueAt must be a date.');
    const task = await this.prisma.workTask.create({ data: { organizationId: org, agent: 'crm', kind: 'review', title, detail: `Customer: ${c.name ?? c.id}`, status: 'open', priority: 'normal', dueAt: due, entityType: 'customer', entityId: c.id, createdBy: `user:${actor.sub}` } });
    await this.audit(org, actor, c.id, 'task_added', { taskId: task.id });
    return task;
  }

  private view<T extends { phone: string | null; optedOutAt: Date | null; doNotContact: boolean; messagingConsent: boolean; callingConsent: boolean }>(c: T) {
    return { ...c, contactable: { whatsapp: Boolean(c.phone && c.messagingConsent && !c.optedOutAt && !c.doNotContact), call: Boolean(c.phone && c.callingConsent && !c.optedOutAt && !c.doNotContact) } };
  }

  private validate(input: CustomerInput, creating: boolean) {
    const errors: Record<string, string> = {};
    const data: Prisma.CustomerUncheckedUpdateInput = {};
    if (creating || input.name !== undefined) {
      const name = str(input.name, 120);
      if (name.length < 2) errors.name = 'Enter the customer name (at least 2 characters).';
      else data.name = name;
    }
    if (creating || input.phone !== undefined) {
      const phone = normalizePhone(str(input.phone, 30));
      if (!phone || phone.length < 11 || phone.length > 15) errors.phone = 'Enter a valid mobile number with country code (for India: 10 digits, +91 is added).';
      else data.phone = phone;
    }
    if (input.email !== undefined) {
      const email = str(input.email, 254).toLowerCase();
      if (email && !EMAIL.test(email)) errors.email = 'Enter a valid email address or leave it empty.';
      else data.email = email || null;
    }
    if (input.language !== undefined) {
      const l = str(input.language, 20).toLowerCase();
      if (l && !LANGS.includes(l)) errors.language = `Language must be one of ${LANGS.join(', ')}.`;
      else data.language = l || null;
    }
    if (input.location !== undefined) data.location = str(input.location, 120) || null;
    if (input.source !== undefined) data.source = str(input.source, 40) || null;
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags)) errors.tags = 'Tags must be a list.';
      else data.tags = [...new Set(input.tags.map((t) => str(t, 30).toLowerCase().replace(/[^a-z0-9_ -]/g, '')).filter(Boolean))].slice(0, 10) as never;
    }
    if (input.attributes !== undefined) {
      const a = validateAttributes(input.attributes);
      if (!a.ok) errors.attributes = a.error;
      else data.attributes = (a.value ?? Prisma.DbNull) as never;
    }
    if (input.stage !== undefined) {
      const st = input.stage === null || input.stage === '' || input.stage === 'new' ? null : String(input.stage);
      if (st && !(STAGES as readonly string[]).includes(st)) errors.stage = `Stage must be new, ${STAGES.join(', ')}.`;
      else data.stage = st;
    }
    if (input.followUpAt !== undefined) {
      const d = input.followUpAt === null || input.followUpAt === '' ? null : new Date(String(input.followUpAt));
      if (d && Number.isNaN(d.getTime())) errors.followUpAt = 'Follow-up date must be a date.';
      else data.followUpAt = d;
    }
    for (const k of ['messagingConsent', 'callingConsent', 'doNotContact'] as const) {
      if (input[k] !== undefined) {
        if (typeof input[k] !== 'boolean') errors[k] = `${k} must be true or false.`;
        else (data as Record<string, unknown>)[k] = input[k];
      }
    }
    // Recording consent needs to say where it came from (kept in the audit trail).
    const grantsConsent = input.messagingConsent === true || input.callingConsent === true;
    const consentSource = str(input.consentSource, 40);
    if (grantsConsent && !CONSENT_SOURCES.includes(consentSource)) errors.consentSource = `Say how the customer gave consent (${CONSENT_SOURCES.join(', ')}).`;
    if (Object.keys(errors).length) throw new BadRequestException({ message: 'Please fix the highlighted fields.', errors });
    return { data, consentSource: consentSource || null };
  }

  async create(org: string, actor: Actor, input: CustomerInput) {
    const { data, consentSource } = this.validate(input, true);
    const exists = await this.prisma.customer.findUnique({ where: { organizationId_phone: { organizationId: org, phone: data.phone as string } }, select: { id: true, name: true } });
    if (exists) throw new ConflictException({ message: `A customer with this number already exists (${exists.name ?? 'unnamed'}).`, customerId: exists.id });
    const isDemo = await this.isDemoOrg(org);
    const row = await this.prisma.customer.create({ data: { ...(data as Prisma.CustomerUncheckedCreateInput), organizationId: org, source: (data.source as string) ?? 'manual', isDemo } });
    await this.audit(org, actor, row.id, 'created', { source: row.source, messagingConsent: row.messagingConsent, callingConsent: row.callingConsent, consentSource });
    log.info('customers.created', { org, customerId: row.id, by: actor.sub });
    return this.view(row);
  }

  async update(org: string, actor: Actor, id: string, input: CustomerInput) {
    const before = await this.prisma.customer.findFirst({ where: { id, organizationId: org } });
    if (!before) throw new NotFoundException('Customer not found');
    const { data, consentSource } = this.validate(input, false);
    if (data.phone && data.phone !== before.phone) {
      const clash = await this.prisma.customer.findUnique({ where: { organizationId_phone: { organizationId: org, phone: data.phone as string } }, select: { id: true } });
      if (clash) throw new ConflictException({ message: 'Another customer already has this number.', customerId: clash.id });
    }
    if (input.optedOut === true && !before.optedOutAt) Object.assign(data, { optedOutAt: new Date(), messagingConsent: false, callingConsent: false });
    if (input.optedOut === false && before.optedOutAt) {
      // Opting back in is the customer's decision: it needs fresh consent with its source.
      if (input.messagingConsent !== true && input.callingConsent !== true) throw new BadRequestException({ message: 'To remove the opt-out, record the customer\'s new consent and how they gave it.', errors: { optedOut: 'New consent required.' } });
      data.optedOutAt = null;
    }
    const row = await this.prisma.customer.update({ where: { id }, data });
    const changed = Object.keys(data).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((row as Record<string, unknown>)[k]));
    if (changed.length) await this.audit(org, actor, id, 'updated', { changed, consentSource, ...(changed.some((k) => /Consent|optedOut|doNotContact/.test(k)) ? { messagingConsent: row.messagingConsent, callingConsent: row.callingConsent, optedOut: Boolean(row.optedOutAt), doNotContact: row.doNotContact } : {}) });
    return this.view(row);
  }

  /** The customer and everything that happened with them in this workspace. */
  async detail(org: string, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, organizationId: org } });
    if (!c) throw new NotFoundException('Customer not found');
    const [leads, conversations, calls, followUps, orders, reservations, appointments, salesOrders, audit] = await Promise.all([
      this.prisma.lead.findMany({ where: { organizationId: org, customerId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.prisma.conversation.findMany({ where: { organizationId: org, customerId: id }, orderBy: { updatedAt: 'desc' }, take: 5, include: { Message: { orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, role: true, content: true, createdAt: true, deliveryStatus: true, deliveryError: true, metadata: true } } } }),
      this.prisma.call.findMany({ where: { organizationId: org, customerId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, direction: true, status: true, outcome: true, durationSec: true, createdAt: true, endReason: true, summary: true } }),
      this.prisma.followUp.findMany({ where: { organizationId: org, customerId: id }, orderBy: { scheduledAt: 'desc' }, take: 20, select: { id: true, channel: true, action: true, status: true, scheduledAt: true, completedAt: true, lastError: true, message: true } }),
      this.prisma.order.findMany({ where: { organizationId: org, customerId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, orderNumber: true, status: true, total: true, createdAt: true } }),
      this.prisma.reservation.findMany({ where: { organizationId: org, customerId: id }, orderBy: { checkIn: 'desc' }, take: 20, select: { id: true, reference: true, status: true, checkIn: true, checkOut: true, total: true } }),
      this.prisma.appointment.findMany({ where: { organizationId: org, customerId: id }, orderBy: { startAt: 'desc' }, take: 20, select: { id: true, reference: true, status: true, startAt: true } }),
      this.prisma.salesOrder.findMany({ where: { organizationId: org, customerId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, number: true, status: true, total: true, createdAt: true } }),
      this.prisma.auditEvent.findMany({ where: { organizationId: org, entityType: 'customer', entityId: id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const [notes, tasks, orderCount] = await Promise.all([
      this.prisma.customerNote.findMany({ where: { organizationId: org, customerId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.workTask.findMany({ where: { organizationId: org, entityType: 'customer', entityId: id }, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }], take: 20, select: { id: true, title: true, status: true, dueAt: true, createdAt: true } }),
      this.prisma.order.count({ where: { organizationId: org, customerId: id } }),
    ]);
    const lead = leadScore({ ...c, orders: orderCount, leadStatus: leads[0]?.status ?? null });
    return { customer: { ...this.view(c), lead }, leads, conversations, calls, followUps, orders, reservations, appointments, salesOrders, audit, notes, tasks, contactReadiness: await this.readiness(org, c) };
  }

  /** What a test message / call would do right now, and why (shown before the user confirms). */
  async readiness(org: string, c: { id: string; phone: string | null; isDemo: boolean; messagingConsent: boolean; callingConsent: boolean; optedOutAt: Date | null; doNotContact: boolean; lastInboundAt: Date | null }) {
    const cfg = followUpConfig();
    const gate = liveGate(cfg, { phone: c.phone, isDemo: c.isDemo || (await this.isDemoOrg(org)) });
    const callAgent = this.telephony ? await this.telephony.systemAgentId(org) : null;
    const blockers = (channel: 'whatsapp' | 'call') => {
      const b: string[] = [];
      if (!c.phone) b.push('No phone number.');
      if (c.optedOutAt) b.push('Customer opted out.');
      if (c.doNotContact) b.push('Marked do-not-contact.');
      if (channel === 'whatsapp' && !c.messagingConsent) b.push('No WhatsApp consent recorded.');
      if (channel === 'call' && !c.callingConsent) b.push('No calling consent recorded.');
      if (channel === 'whatsapp' && !(config.whatsapp.accessToken && config.whatsapp.phoneNumberId)) b.push('WhatsApp is not configured on this server.');
      if (channel === 'call' && !callAgent) b.push('No Sarvam agent is chosen for automatic calls (Voice agents).');
      return b;
    };
    const windowOpen = Boolean(c.lastInboundAt && Date.now() - c.lastInboundAt.getTime() < WINDOW_MS);
    return {
      live: gate.live, liveReason: gate.live ? null : gate.reason ?? null,
      whatsapp: { blockers: blockers('whatsapp'), windowOpen, needsTemplate: !windowOpen, templateConfigured: Boolean(this.whatsapp?.templateConfigured()) },
      call: { blockers: blockers('call') },
    };
  }

  /**
   * Send ONE WhatsApp test message after explicit confirmation. Blocked (with the reason) when consent, opt-out,
   * configuration or the live gate say no; SIMULATED under DRY_RUN / for demo or unapproved numbers (nothing reaches
   * Meta); otherwise the provider's message id is stored and delivery receipts update it (accepted → sent →
   * delivered / read / failed). Success is only what the provider returned.
   */
  async whatsappTest(org: string, actor: Actor, id: string, body: { confirm?: unknown; message?: unknown }) {
    if (body?.confirm !== true) throw new BadRequestException('Confirm the test message first (confirm: true).');
    const c = await this.prisma.customer.findFirst({ where: { id, organizationId: org } });
    if (!c) throw new NotFoundException('Customer not found');
    const ready = await this.readiness(org, c);
    const text = str(body.message, 1000) || 'Test message from your Tacksharp workspace. Reply STOP to opt out.';
    if (ready.whatsapp.blockers.length) {
      await this.audit(org, actor, id, 'whatsapp_test_blocked', { reasons: ready.whatsapp.blockers });
      return { status: 'blocked', reasons: ready.whatsapp.blockers };
    }
    const conv = await this.prisma.conversation.upsert({
      where: { organizationId_channel_externalId: { organizationId: org, channel: 'whatsapp', externalId: c.phone! } },
      create: { id: randomUUID(), organizationId: org, customerId: c.id, channel: 'whatsapp', externalId: c.phone!, status: 'active', updatedAt: new Date() },
      update: {},
    });
    const useTemplate = ready.whatsapp.needsTemplate;
    if (!ready.live) {
      const msg = await this.prisma.message.create({ data: { id: randomUUID(), organizationId: org, conversationId: conv.id, role: 'assistant', content: `[TEST · SIMULATED] ${text}`, deliveryStatus: null, metadata: { staffTest: true, simulated: true, reason: ready.liveReason, by: actor.sub, template: useTemplate } as never } });
      await this.audit(org, actor, id, 'whatsapp_test_simulated', { reason: ready.liveReason, messageId: msg.id });
      return { status: 'simulated', reason: ready.liveReason, messageId: msg.id };
    }
    if (useTemplate && !ready.whatsapp.templateConfigured) {
      await this.audit(org, actor, id, 'whatsapp_test_blocked', { reasons: ['24-hour window closed and no approved template configured'] });
      return { status: 'blocked', reasons: ['The 24-hour WhatsApp window is closed and no approved template is configured (WHATSAPP_TEMPLATE_NAME).'] };
    }
    try {
      const providerId = useTemplate ? await this.whatsapp!.sendTemplate(c.phone!, [c.name ?? 'there']) : await this.whatsapp!.sendText(c.phone!, text);
      const msg = await this.prisma.message.create({ data: { id: randomUUID(), organizationId: org, conversationId: conv.id, role: 'assistant', content: useTemplate ? `[TEST · template ${this.whatsapp!.templateFor()}]` : `[TEST] ${text}`, externalId: providerId ?? null, deliveryStatus: 'accepted', deliveryUpdatedAt: new Date(), metadata: { staffTest: true, by: actor.sub, template: useTemplate } as never } });
      await this.audit(org, actor, id, 'whatsapp_test_accepted', { providerMessageId: providerId, messageId: msg.id, template: useTemplate });
      return { status: 'accepted', providerMessageId: providerId, messageId: msg.id, note: 'Accepted by Meta. Delivery is confirmed only when the delivery receipt arrives.' };
    } catch (error) {
      const reason = errorMessage(error).slice(0, 300);
      const msg = await this.prisma.message.create({ data: { id: randomUUID(), organizationId: org, conversationId: conv.id, role: 'assistant', content: `[TEST · FAILED] ${text}`, deliveryStatus: 'failed', deliveryError: reason, metadata: { staffTest: true, by: actor.sub } as never } });
      await this.audit(org, actor, id, 'whatsapp_test_failed', { reason, messageId: msg.id });
      return { status: 'failed', reason, messageId: msg.id };
    }
  }

  /** Status of one test message (polled by the dashboard): only what the provider / receipts reported. */
  async messageStatus(org: string, customerId: string, messageId: string) {
    const m = await this.prisma.message.findFirst({ where: { id: messageId, organizationId: org, Conversation: { customerId } }, select: { id: true, deliveryStatus: true, deliveryError: true, deliveryUpdatedAt: true, externalId: true, metadata: true } });
    if (!m) throw new NotFoundException('Message not found');
    return m;
  }

  /** ONE test call after explicit confirmation; consent + live gate checked here and again in the voice service. */
  async testCall(org: string, actor: Actor, id: string, body: { confirm?: unknown }) {
    if (body?.confirm !== true) throw new BadRequestException('Confirm the test call first (confirm: true).');
    const c = await this.prisma.customer.findFirst({ where: { id, organizationId: org } });
    if (!c) throw new NotFoundException('Customer not found');
    const ready = await this.readiness(org, c);
    if (ready.call.blockers.length) {
      await this.audit(org, actor, id, 'test_call_blocked', { reasons: ready.call.blockers });
      return { status: 'blocked', reasons: ready.call.blockers };
    }
    if (!ready.live) {
      await this.audit(org, actor, id, 'test_call_not_live', { reason: ready.liveReason });
      return { status: 'not_placed', reason: ready.liveReason, note: 'No call was placed.' };
    }
    if (!this.telephony) return { status: 'blocked', reasons: ['Voice service not available on this server.'] };
    const r = await this.telephony.placeSystemCall({ organizationId: org, customerId: c.id, purpose: 'test_call', idempotencyKey: `${c.id}:${Date.now()}` });
    await this.audit(org, actor, id, r.started ? 'test_call_started' : 'test_call_not_started', { ...r });
    return r.started ? { status: 'started', requestId: r.requestId } : { status: 'not_placed', reason: r.reason };
  }
}
