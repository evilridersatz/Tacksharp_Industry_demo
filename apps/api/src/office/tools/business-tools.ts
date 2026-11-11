import type { PrismaService } from '../../prisma/prisma.service.js';
import type { JarvisService } from '../../jarvis/jarvis.service.js';
import type { JarvisDataService } from '../../jarvis/jarvis-data.service.js';
import type { WorkTasksService } from '../../governance/work-tasks.service.js';
import type { InboxService } from '../../inbox/inbox.service.js';
import type { ConversationsService } from '../../conversations/conversations.service.js';
import type { WhatsAppSenderService } from '../../whatsapp/whatsapp-sender.service.js';
import type { KnowledgeService } from '../../knowledge/knowledge.service.js';
import { workTaskKey } from '../../governance/work-tasks.service.js';
import { followUpConfig, liveGate } from '../../restaurant/followup-config.js';
import { runInProviderScope } from '../../integrations/provider-scope.js';
import { istDayStart } from '../../jarvis/jarvis-config.js';
import { untrusted, type ToolDef } from './contract.js';

export type ToolDeps = {
  prisma: PrismaService;
  jarvis: JarvisService;
  jarvisData: JarvisDataService;
  workTasks: WorkTasksService;
  inbox: InboxService;
  conversations: ConversationsService;
  sender: WhatsAppSenderService;
  knowledge?: KnowledgeService;
};

const n = (v: unknown) => Number(v ?? 0) || 0;
const firstName = (s: string | null | undefined) => (s ?? '').trim().split(/\s+/)[0]?.slice(0, 30) || 'Customer';
const minutesSince = (d: Date, now = Date.now()) => Math.round((now - d.getTime()) / 60_000);
const STAGES = ['interested', 'qualified', 'converted', 'lost'] as const;
const WORK_KINDS = ['exception', 'review', 'procurement', 'dispatch', 'reconciliation'] as const;
const NO_ARGS = { type: 'object', properties: {}, required: [], additionalProperties: false } as const;

/** The office's tools, bound to this organization's services. Every query is scoped by ctx.organizationId. */
export function buildBusinessTools(d: ToolDeps): ToolDef[] {
  const { prisma } = d;
  return [
    {
      name: 'business_snapshot', risk: 'read', timeoutMs: 20_000, perMinute: 30, perTask: 2,
      description: 'Today’s and yesterday’s numbers: orders, revenue, channels, calls, top items, stock alerts, pending orders, unpaid orders, customers waiting for staff, feedback. Phones are masked.',
      schema: NO_ARGS,
      async run(ctx) {
        const cfg = await d.jarvis.config(ctx.organizationId);
        const s = await d.jarvisData.snapshot(ctx.organizationId, cfg);
        return { result: s };
      },
    },
    {
      name: 'list_pending_orders', risk: 'read', timeoutMs: 15_000, perMinute: 30, perTask: 3,
      description: 'Orders still pending (not confirmed) since yesterday, oldest first, with how many minutes they have waited.',
      schema: NO_ARGS,
      async run(ctx) {
        const R = await d.jarvisData.realOnly(ctx.organizationId);
        const rows = await prisma.order.findMany({ where: { organizationId: ctx.organizationId, ...R.order, status: 'pending', createdAt: { gte: istDayStart(new Date(), 1) } }, select: { id: true, orderNumber: true, channel: true, total: true, createdAt: true, customer: { select: { name: true } } }, orderBy: { createdAt: 'asc' }, take: 30 });
        return { result: { count: rows.length, orders: rows.map((o) => ({ orderId: o.id, orderNumber: o.orderNumber, channel: o.channel, total: n(o.total), waitingMinutes: minutesSince(o.createdAt), customer: firstName(o.customer?.name) })) } };
      },
    },
    {
      name: 'list_low_stock', risk: 'read', timeoutMs: 15_000, perMinute: 30, perTask: 2,
      description: 'Products that are out of stock or below their low-stock level.',
      schema: NO_ARGS,
      async run(ctx) {
        const R = await d.jarvisData.realOnly(ctx.organizationId);
        const rows = await prisma.menuItem.findMany({ where: { organizationId: ctx.organizationId, ...R.menu, stockQty: { not: null } }, select: { id: true, name: true, unit: true, stockQty: true, lowStockThreshold: true, available: true } });
        const low = rows.filter((s) => !s.available || n(s.stockQty) <= 0 || (s.lowStockThreshold !== null && n(s.stockQty) <= n(s.lowStockThreshold)));
        return { result: { tracked: rows.length, items: low.map((s) => ({ itemId: s.id, name: s.name, qty: n(s.stockQty), unit: s.unit, level: !s.available || n(s.stockQty) <= 0 ? 'out' : 'low' })) } };
      },
    },
    {
      name: 'list_waiting_conversations', risk: 'read', timeoutMs: 15_000, perMinute: 30, perTask: 3,
      description: 'Conversations where a customer is waiting for a person (handed over by the AI), oldest first, with who is assigned.',
      schema: NO_ARGS,
      async run(ctx) {
        const R = await d.jarvisData.realOnly(ctx.organizationId);
        const rows = await prisma.conversation.findMany({ where: { organizationId: ctx.organizationId, ...R.conv, status: 'human_handoff', inboxStatus: 'open' }, select: { id: true, channel: true, assigneeId: true, handoffAt: true, handoffReason: true, Customer: { select: { name: true } } }, orderBy: { handoffAt: 'asc' }, take: 30 });
        return { result: { count: rows.length, conversations: rows.map((c) => ({ conversationId: c.id, channel: c.channel, assigned: Boolean(c.assigneeId), waitingMinutes: c.handoffAt ? minutesSince(c.handoffAt) : null, reason: c.handoffReason ? untrusted(c.handoffReason, 200) : null, customer: firstName(c.Customer?.name) })) } };
      },
    },
    {
      name: 'list_followup_candidates', risk: 'read', timeoutMs: 20_000, perMinute: 20, perTask: 2,
      description: 'Customers to follow up: those who wrote on WhatsApp in the last day and have not ordered since, and those whose CRM follow-up date is due. "canMessageNow" says whether WhatsApp allows a normal message now (24-hour window, consent, not opted out).',
      schema: NO_ARGS,
      async run(ctx) {
        const now = Date.now();
        const since = new Date(now - 23 * 3_600_000);
        const R = await d.jarvisData.realOnly(ctx.organizationId);
        const recent = await prisma.conversation.findMany({ where: { organizationId: ctx.organizationId, ...R.conv, channel: 'whatsapp', lastCustomerAt: { gte: since }, customerId: { not: null } }, select: { id: true, lastCustomerAt: true, customerId: true }, orderBy: { lastCustomerAt: 'desc' }, take: 40 });
        const due = await prisma.customer.findMany({ where: { organizationId: ctx.organizationId, ...R.customer, followUpAt: { lte: new Date(now) } }, select: { id: true }, take: 20 });
        const ids = [...new Set([...recent.map((c) => c.customerId!), ...due.map((c) => c.id)])];
        const customers = ids.length ? await prisma.customer.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, name: true, language: true, lastInboundAt: true, optedOutAt: true, doNotContact: true, followUpAt: true, stage: true, isDemo: true } }) : [];
        const out = [];
        for (const c of customers) {
          const conv = recent.find((r) => r.customerId === c.id);
          const orderedSince = conv?.lastCustomerAt ? await prisma.order.count({ where: { organizationId: ctx.organizationId, customerId: c.id, createdAt: { gte: conv.lastCustomerAt } } }) : 0;
          if (conv && orderedSince > 0 && !(c.followUpAt && c.followUpAt.getTime() <= now)) continue;
          const last = conv ? await prisma.message.findFirst({ where: { conversationId: conv.id, role: 'user' }, orderBy: { createdAt: 'desc' }, select: { content: true } }) : null;
          const windowOpen = Boolean(c.lastInboundAt && now - c.lastInboundAt.getTime() < 23.5 * 3_600_000);
          out.push({
            customerId: c.id, name: firstName(c.name), language: c.language ?? null, stage: c.stage ?? 'new',
            reason: conv ? 'wrote in the last day without ordering' : 'CRM follow-up date is due',
            lastMessage: last ? untrusted(last.content, 300) : null,
            canMessageNow: windowOpen && !c.optedOutAt && !c.doNotContact,
            ...(c.isDemo ? { demo: true } : {}),
          });
        }
        return { result: { count: out.length, customers: out.slice(0, 20) } };
      },
    },
    {
      name: 'list_receivables', risk: 'read', timeoutMs: 15_000, perMinute: 20, perTask: 2,
      description: 'Money to collect: overdue invoices (number, amount due, days late) and today’s unpaid orders.',
      schema: NO_ARGS,
      async run(ctx) {
        const now = new Date();
        const inv = await prisma.invoice.findMany({ where: { organizationId: ctx.organizationId, status: { in: ['issued', 'partially_paid'] }, dueDate: { lt: now } }, select: { id: true, number: true, total: true, amountPaid: true, dueDate: true }, orderBy: { dueDate: 'asc' }, take: 30 });
        const R = await d.jarvisData.realOnly(ctx.organizationId);
        const unpaid = await prisma.order.findMany({ where: { organizationId: ctx.organizationId, ...R.order, createdAt: { gte: istDayStart(now) }, status: { not: 'cancelled' }, paymentStatus: { not: 'paid' } }, select: { id: true, orderNumber: true, total: true }, take: 30 });
        return { result: { overdueInvoices: inv.map((i) => ({ invoiceId: i.id, invoiceNumber: i.number, due: n(i.total) - n(i.amountPaid), daysLate: i.dueDate ? Math.floor((now.getTime() - i.dueDate.getTime()) / 86_400_000) : null })), unpaidOrdersToday: unpaid.map((o) => ({ orderId: o.id, orderNumber: o.orderNumber, total: n(o.total) })) } };
      },
    },
    {
      name: 'search_knowledge', risk: 'read', timeoutMs: 15_000, perMinute: 30, perTask: 4,
      description: 'Search the business’s own knowledge base (menu notes, policies, FAQs). Returns passages with their source labels.',
      schema: { type: 'object', properties: { query: { type: 'string', maxLength: 300, description: 'What to look for' } }, required: ['query'], additionalProperties: false },
      async run(ctx, a) {
        if (!d.knowledge) return { result: { passages: [], note: 'The knowledge base is not available.' } };
        const bases = await prisma.knowledgeBase.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true }, take: 5 });
        const found = [];
        for (const b of bases) found.push(...(await d.knowledge.search(ctx.organizationId, b.id, String(a.query), 3)));
        found.sort((x, y) => y.score - x.score);
        return { result: { passages: found.slice(0, 6).map((p) => ({ source: [p.filename, p.source].filter(Boolean).join(' · ') || 'document', text: untrusted(p.text, 800) })) } };
      },
    },
    {
      name: 'read_memory', risk: 'read', timeoutMs: 10_000, perMinute: 30, perTask: 3,
      description: 'Verified facts the business saved in the office memory (pinned first). Optionally filter by words.',
      schema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, required: [], additionalProperties: false },
      async run(ctx, a) {
        const rows = await prisma.officeMemory.findMany({ where: { organizationId: ctx.organizationId, status: 'verified', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], ...(a.query ? { text: { contains: String(a.query) } } : {}) }, orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }], take: 15, select: { id: true, text: true, source: true } });
        return { result: { facts: rows.map((r) => ({ memoryId: r.id, text: untrusted(r.text, 500), source: r.source })) } };
      },
    },
    {
      name: 'read_plan_results', risk: 'read', timeoutMs: 10_000, perMinute: 30, perTask: 2,
      description: 'The verified results of the other tasks in this plan (status, summary, outcome, verification).',
      schema: NO_ARGS,
      async run(ctx) {
        if (!ctx.planId) return { result: { tasks: [] } };
        const rows = await prisma.officeTask.findMany({ where: { organizationId: ctx.organizationId, planId: ctx.planId, id: { not: ctx.taskId } }, select: { key: true, role: true, title: true, status: true, result: true, verification: true }, orderBy: { createdAt: 'asc' } });
        return { result: { tasks: rows.map((t) => ({ key: t.key, role: t.role, title: t.title, status: t.status, result: t.result, verification: t.verification })) } };
      },
    },
    // ---------------------------------------------------------------------------------------- internal writes
    {
      name: 'create_work_task', risk: 'internal', timeoutMs: 10_000, perMinute: 30, perTask: 10,
      description: 'Create a job for the staff (shown under Tasks). Give a dedupeKey that names the problem (for example "pending-order:GR-7K2Q9X"): the same key never creates a second job.',
      schema: {
        type: 'object', additionalProperties: false, required: ['title', 'dedupeKey'],
        properties: {
          title: { type: 'string', maxLength: 200 }, detail: { type: 'string', maxLength: 1500 }, kind: { type: 'string', enum: WORK_KINDS },
          priority: { type: 'string', enum: ['normal', 'high'] }, dedupeKey: { type: 'string', maxLength: 120 },
          entityType: { type: 'string', enum: ['order', 'conversation', 'customer', 'menu_item', 'invoice'] }, entityId: { type: 'string', maxLength: 191 },
        },
      },
      async run(ctx, a) {
        const agent = ['sales', 'finance', 'marketing'].includes(ctx.role) ? (ctx.role as 'sales' | 'finance' | 'marketing') : 'operations';
        const key = `office:${String(a.dedupeKey)}`;
        const { task, created } = await d.workTasks.create(ctx.organizationId, {
          agent, kind: (a.kind as (typeof WORK_KINDS)[number]) ?? 'review', title: String(a.title), detail: a.detail ? String(a.detail) : undefined,
          priority: (a.priority as 'normal' | 'high') ?? 'normal', entityType: a.entityType as string | undefined, entityId: a.entityId as string | undefined,
          dedupeKey: key, createdBy: `office:${ctx.role}`,
        });
        return { result: { workTaskId: task.id, created, status: task.status }, evidence: { workTaskId: task.id, dedupeKey: key } };
      },
      async verify(org, e) {
        const t = await prisma.workTask.findFirst({ where: { id: String(e.workTaskId), organizationId: org }, select: { id: true, dedupeKey: true } });
        if (!t) return { ok: false, detail: 'The staff job does not exist' };
        if (e.dedupeKey && t.dedupeKey !== workTaskKey(org, String(e.dedupeKey))) return { ok: false, detail: 'The staff job has a different key' };
        return { ok: true, detail: `Staff job ${t.id} exists` };
      },
    },
    {
      name: 'assign_conversation', risk: 'internal', timeoutMs: 10_000, perMinute: 30, perTask: 10,
      description: 'Assign a waiting, unassigned conversation to the team member with the fewest open conversations.',
      schema: { type: 'object', properties: { conversationId: { type: 'string', maxLength: 191 } }, required: ['conversationId'], additionalProperties: false },
      async run(ctx, a) {
        const c = await prisma.conversation.findFirst({ where: { id: String(a.conversationId), organizationId: ctx.organizationId }, select: { id: true, assigneeId: true, status: true } });
        if (!c) throw new Error('No such conversation in this business');
        if (c.assigneeId) return { result: { conversationId: c.id, alreadyAssigned: true }, evidence: { conversationId: c.id, assigneeId: c.assigneeId } };
        await d.inbox.assignRoundRobin(null, ctx.organizationId, c.id);
        const after = await prisma.conversation.findFirst({ where: { id: c.id }, select: { assigneeId: true } });
        return { result: { conversationId: c.id, assigned: Boolean(after?.assigneeId) }, evidence: { conversationId: c.id, assigneeId: after?.assigneeId ?? null } };
      },
      async verify(org, e) {
        const c = await prisma.conversation.findFirst({ where: { id: String(e.conversationId), organizationId: org }, select: { assigneeId: true } });
        if (!c) return { ok: false, detail: 'The conversation does not exist' };
        if (!c.assigneeId) return { ok: false, detail: 'The conversation has nobody assigned' };
        if (e.assigneeId && c.assigneeId !== e.assigneeId) return { ok: true, detail: 'Assigned (since reassigned by a person)' };
        return { ok: true, detail: 'Conversation assigned' };
      },
    },
    {
      name: 'draft_whatsapp', risk: 'internal', timeoutMs: 10_000, perMinute: 30, perTask: 10,
      description: 'Save a WhatsApp message draft for one customer (not sent). Sending is a separate step that needs a person’s approval.',
      schema: { type: 'object', properties: { customerId: { type: 'string', maxLength: 191 }, text: { type: 'string', maxLength: 600 } }, required: ['customerId', 'text'], additionalProperties: false },
      async run(ctx, a) {
        const c = await prisma.customer.findFirst({ where: { id: String(a.customerId), organizationId: ctx.organizationId }, select: { id: true, name: true } });
        if (!c) throw new Error('No such customer in this business');
        return { result: { draft: true, customerId: c.id, customer: firstName(c.name), text: a.text }, evidence: { customerId: c.id, chars: String(a.text).length } };
      },
      async verify(org, e) {
        const c = await prisma.customer.count({ where: { id: String(e.customerId), organizationId: org } });
        return c ? { ok: true, detail: 'Draft stored for an existing customer' } : { ok: false, detail: 'The customer does not exist' };
      },
    },
    {
      name: 'update_lead_stage', risk: 'internal', timeoutMs: 10_000, perMinute: 30, perTask: 10,
      description: 'Set a customer’s CRM stage (interested, qualified, converted, lost) when the conversation clearly shows it.',
      schema: { type: 'object', properties: { customerId: { type: 'string', maxLength: 191 }, stage: { type: 'string', enum: STAGES } }, required: ['customerId', 'stage'], additionalProperties: false },
      async run(ctx, a) {
        const r = await prisma.customer.updateMany({ where: { id: String(a.customerId), organizationId: ctx.organizationId }, data: { stage: String(a.stage) } });
        if (!r.count) throw new Error('No such customer in this business');
        await prisma.auditEvent.create({ data: { organizationId: ctx.organizationId, actor: `office:${ctx.role}`, entityType: 'customer', entityId: String(a.customerId), action: 'crm.stage_changed', data: { stage: a.stage, taskId: ctx.taskId } as object } }).catch(() => undefined);
        return { result: { customerId: a.customerId, stage: a.stage }, evidence: { customerId: a.customerId, stage: a.stage } };
      },
      async verify(org, e) {
        const c = await prisma.customer.findFirst({ where: { id: String(e.customerId), organizationId: org }, select: { stage: true } });
        return c?.stage === e.stage ? { ok: true, detail: `Stage is ${String(e.stage)}` } : { ok: false, detail: 'The CRM stage is not what the agent set' };
      },
    },
    {
      name: 'propose_memory', risk: 'internal', timeoutMs: 10_000, perMinute: 20, perTask: 5,
      description: 'Propose a fact for the office memory, with its source. It is stored as "proposed" until a person verifies it.',
      schema: { type: 'object', properties: { text: { type: 'string', maxLength: 500 }, source: { type: 'string', maxLength: 200 }, scope: { type: 'string', enum: ['organization', 'department'] } }, required: ['text', 'source'], additionalProperties: false },
      async run(ctx, a) {
        const m = await prisma.officeMemory.create({ data: { organizationId: ctx.organizationId, scope: String(a.scope ?? 'organization'), text: String(a.text), source: String(a.source), author: `agent:${ctx.role}`, status: 'proposed' } });
        return { result: { memoryId: m.id, status: 'proposed' }, evidence: { memoryId: m.id } };
      },
      async verify(org, e) {
        return (await prisma.officeMemory.count({ where: { id: String(e.memoryId), organizationId: org } })) ? { ok: true, detail: 'Memory proposal stored' } : { ok: false, detail: 'The memory proposal is missing' };
      },
    },
    // ---------------------------------------------------------------------------------------- sensitive
    {
      name: 'send_whatsapp', risk: 'sensitive', timeoutMs: 30_000, perMinute: 10, perTask: 10,
      description: 'Send one WhatsApp message to one customer. Always waits for a person’s approval; sent only if WhatsApp accepts it (24-hour window, not opted out).',
      schema: { type: 'object', properties: { customerId: { type: 'string', maxLength: 191 }, text: { type: 'string', maxLength: 600 } }, required: ['customerId', 'text'], additionalProperties: false },
      async run(ctx, a) {
        if (!ctx.approvedBy) throw new Error('Sending needs an approval');
        const org = ctx.organizationId;
        const customer = await prisma.customer.findFirst({ where: { id: String(a.customerId), organizationId: org } });
        if (!customer) throw new Error('No such customer in this business');
        if (customer.optedOutAt || customer.doNotContact) throw new Error('The customer opted out or is marked do-not-contact: nothing was sent');
        if (!(await d.conversations.isWhatsAppWindowOpen(org, customer.id))) throw new Error('More than 24 hours since the customer last wrote: WhatsApp allows only an approved template. Nothing was sent.');
        const conv = await prisma.conversation.findFirst({ where: { organizationId: org, customerId: customer.id, channel: 'whatsapp' }, orderBy: { updatedAt: 'desc' }, select: { id: true, externalId: true } });
        if (!conv?.externalId) throw new Error('The customer has no WhatsApp conversation');
        const text = String(a.text);
        const gate = liveGate(followUpConfig(), { phone: customer.phone, isDemo: customer.isDemo });
        let providerMessageId: string | null = null;
        if (gate.live) providerMessageId = (await runInProviderScope(org, () => d.sender.sendText(conv.externalId!, text))) ?? null;
        const msg = await d.conversations.addMessage({
          organizationId: org, conversationId: conv.id, role: 'assistant', content: text,
          ...(providerMessageId ? { externalId: providerMessageId } : {}),
          metadata: { author: 'office', agent: ctx.role, taskId: ctx.taskId, approvedBy: ctx.approvedBy, ...(gate.live ? {} : { simulated: true, notSentReason: gate.reason }) } as never,
        });
        await prisma.message.update({ where: { id: msg.id }, data: { deliveryStatus: gate.live ? 'accepted' : null, deliveryUpdatedAt: new Date() } }).catch(() => undefined);
        return { result: { sent: gate.live, messageId: msg.id, ...(gate.live ? {} : { notSentReason: gate.reason }) }, evidence: { messageId: msg.id, providerMessageId, sent: gate.live, notSentReason: gate.reason ?? null } };
      },
      async verify(org, e) {
        const m = await prisma.message.findFirst({ where: { id: String(e.messageId), organizationId: org }, select: { externalId: true } });
        if (!m) return { ok: false, detail: 'The message was not recorded' };
        if (!e.sent) return { ok: false, detail: `Recorded but not sent (${String(e.notSentReason ?? 'not live')})` };
        if (!m.externalId) return { ok: false, detail: 'WhatsApp returned no message id' };
        return { ok: true, detail: `WhatsApp accepted message ${m.externalId}` };
      },
    },
  ];
}
