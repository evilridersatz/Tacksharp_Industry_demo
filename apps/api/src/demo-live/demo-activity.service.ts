import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { errorMessage, log } from '../common/logger.js';
import { CALLS, CHATS, FOLLOW_UP_STEP, LEAD_NEXT, NAMES, type ChatScript, type Turn } from './scripts.js';

const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const POOL = 300;
const RETENTION_DAYS = 35;
/**
 * Average new records per minute in a busy hour, per workspace (a believable small business, not a stress test):
 * e.g. ~60–110 WhatsApp chats, 40–100 kitchen orders, ~40 appointments or ~15 hotel bookings a day.
 */
const RATE: Record<string, { chat: number; call?: number; create?: number; lead?: number }> = {
  real_estate: { chat: 0.1, call: 0.04, create: 0.012 },
  textile: { chat: 0.08, call: 0.03, create: 0.025 },
  retail: { chat: 0.1, create: 0.035 },
  restaurant: { chat: 0.1, call: 0.03, create: 0.08 },
  food: { chat: 0.1, call: 0.025, create: 0.1 },
  hotel: { chat: 0.08, call: 0.025, create: 0.02 },
  hospital: { chat: 0.1, call: 0.03, create: 0.05, lead: 0.015 },
  manufacturing: { chat: 0.04, create: 0.03 },
  agency: { chat: 0.06, create: 0.025 },
};
const dec = (v: number) => new Prisma.Decimal(v.toFixed(2));
const istDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10);
const istMinute = (t: number) => { const d = new Date(t + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dayOnly = (d: string) => new Date(`${d}T00:00:00.000Z`);
const addDays = (d: string, k: number) => new Date(dayOnly(d).getTime() + k * DAY).toISOString().slice(0, 10);
const istAt = (d: string, minutes: number) => new Date(dayOnly(d).getTime() + minutes * MIN - IST);
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const ACTOR = 'demo-feed';
/** Synthetic accounts user for the real finance service (verifying is a simulated staff action in a demo workspace). */
const ACCOUNTS = { sub: 'demo-accounts (simulated)', role: 'admin' };

export type ActivitySummary = { industry: string; at: string; chats: number; calls: number; leads: number; followUps: number; records: string[] };

/**
 * Live demo activity for the agent industries (everything except VisionOps, which has its own feed). Every minute,
 * for each DEMO workspace that switched it on: customer chats with AI replies, new leads and lead progress, follow-ups
 * coming due (simulated sends), AI calls with transcripts, handoffs, and each industry's records moving the way they
 * do in a working day (orders through the kitchen, check-ins, appointments, quotations → orders → invoices →
 * payments, inspections, site visits). Records are written in the same shape as the demo seed and carry ids starting
 * "dl_" and are pruned after 35 days. It never touches a non-demo workspace and never sends anything: all
 * customers are synthetic numbers in the reserved demo range, and the assistant replies are canned (no AI provider).
 */
@Injectable()
export class DemoActivityService {
  random: () => number = Math.random;
  /** Tests: their own id prefix (cleaned up afterwards) instead of the live feed's "dl_". */
  idPrefix = 'dl_';
  /** Tests: a fixed time-of-day weight instead of the IST clock. */
  timeWeight?: number;
  private seq = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Optional() private readonly finance?: FinanceService,
  ) {}

  private chance(p: number) { return this.random() < p; }
  private int(a: number, b: number) { return a + Math.floor(this.random() * (b - a + 1)); }
  private pick<T>(a: readonly T[]): T { return a[Math.floor(this.random() * a.length)]; }
  private id(org: string, kind: string, at: number) { return `${this.idPrefix}${org.replace('org_demo_', '')}_${kind}_${at.toString(36)}${(++this.seq % 1296).toString(36).padStart(2, '0')}${Math.floor(this.random() * 1296).toString(36).padStart(2, '0')}`; }
  /** Short record number: minute of creation + 3 random characters (unique enough for demo references, readable). */
  private code(at: number) { return `${Math.floor(at / MIN).toString(36).toUpperCase().slice(-5)}${Math.floor(this.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`; }

  /** Demo workspaces (not VisionOps) with the live feed switched on. */
  async liveOrgs(): Promise<string[]> {
    const orgs = await this.prisma.organization.findMany({ where: { isDemo: true }, select: { id: true } });
    const on: string[] = [];
    for (const o of orgs) {
      const s = await this.settings.get(o.id);
      if (s.industry !== 'cctv' && s.demoLive?.enabled) on.push(o.id);
    }
    return on;
  }

  async industryOf(org: string): Promise<string | null> {
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true, vertical: true } });
    if (!o?.isDemo) return null;
    if (o.vertical === 'restaurant') return 'restaurant';
    return (await this.settings.get(org)).industry;
  }

  /** Poisson draw: how many records arrive in this step (rate per minute × minutes × time-of-day weight). */
  private count(ratePerMin: number | undefined, span: number, at: Date) {
    const lam = (ratePerMin ?? 0) * span * this.weight(at);
    if (lam <= 0) return 0;
    let k = 0, p = 1;
    const L = Math.exp(-Math.min(lam, 30));
    do { k++; p *= this.random(); } while (p > L && k < 200);
    return k - 1;
  }
  /** Quiet nights, busy late mornings and evenings (IST). */
  private weight(at: Date) {
    if (this.timeWeight !== undefined) return this.timeWeight;
    const h = Math.floor(istMinute(at.getTime()) / 60);
    return h < 7 || h >= 23 ? 0.12 : (h >= 10 && h < 14) || (h >= 17 && h < 21) ? 1.2 : 0.8;
  }
  /** A moment inside the step that just passed (records of one step do not all share a timestamp). */
  private within(at: Date, span: number) { return span <= 1 ? at : new Date(at.getTime() - Math.floor(this.random() * span * 0.9 * MIN)); }

  /**
   * Replay activity between two moments in steps of stepMin minutes (oldest first): the demo seed uses it for the last
   * 30 days, the first tick after a pause for the last ~2.5 hours. Everything is timestamped in that past window.
   */
  async simulate(org: string, from: Date, to: Date, stepMin = 45): Promise<ActivitySummary | null> {
    const industry = await this.industryOf(org);
    if (!industry || industry === 'cctv') return null;
    const summary: ActivitySummary = { industry, at: to.toISOString(), chats: 0, calls: 0, leads: 0, followUps: 0, records: [] };
    for (let t = from.getTime() + stepMin * MIN; t <= to.getTime(); t += stepMin * MIN) await this.step(org, industry, new Date(t), summary, true, stepMin);
    return summary;
  }

  /**
   * One minute of activity. On the first tick after a pause (no feed message in 2 hours) it also replays the last
   * ~2.5 hours in 15-minute steps, so "today" pages are not empty the moment the feed is switched on.
   */
  async tick(org: string, now = new Date()): Promise<ActivitySummary | null> {
    const industry = await this.industryOf(org);
    if (!industry || industry === 'cctv') return null;
    const s = await this.settings.get(org);
    if (!s.demoLive?.enabled) return null;
    const recent = await this.prisma.message.count({ where: { organizationId: org, id: { startsWith: 'dl_' }, createdAt: { gte: new Date(now.getTime() - 2 * 3_600_000) } } });
    const summary: ActivitySummary = { industry, at: now.toISOString(), chats: 0, calls: 0, leads: 0, followUps: 0, records: [] };
    if (!recent) {
      const back = await this.simulate(org, new Date(now.getTime() - 165 * MIN), new Date(now.getTime() - MIN), 15);
      if (back) { summary.chats += back.chats; summary.calls += back.calls; summary.leads += back.leads; summary.followUps += back.followUps; summary.records.push(...back.records); }
    }
    await this.step(org, industry, now, summary, false, 1);
    return summary;
  }

  /** One step = `span` minutes of a working day: new arrivals by rate, then everything already open moves on. */
  private async step(org: string, industry: string, at: Date, sum: ActivitySummary, backfill: boolean, span = 1) {
    const run = async (name: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (error) { log.warn('demo_live.step_failed', { org, step: name, error: errorMessage(error) }); }
    };
    const r = RATE[industry] ?? { chat: 0.1 };
    for (let k = this.count(r.chat, span, at); k > 0; k--) await run('chat', () => this.chat(org, industry, this.within(at, span), sum));
    for (let k = Math.max(1, Math.round(span / 15)); k > 0; k--) await run('leads', () => this.progressLeads(org, industry, at, sum));
    await run('followUps', () => this.followUps(org, industry, at, sum));
    if (CALLS[industry]) await run('calls', () => this.calls(org, industry, at, sum, backfill, this.count(r.call, span, at), span));
    const n = this.count(r.create, span, at);
    const fn = ({
      restaurant: () => this.kitchen(org, 'restaurant', at, sum, backfill, n, span),
      food: () => this.kitchen(org, 'food', at, sum, backfill, n, span),
      hotel: () => this.hotel(org, at, sum, backfill, n, span),
      hospital: () => this.hospital(org, at, sum, backfill, n, span, this.count(r.lead, span, at)),
      real_estate: () => this.siteVisits(org, at, sum, n, span),
      textile: () => this.sales(org, 'textile', at, sum, backfill, n, span),
      retail: () => this.sales(org, 'retail', at, sum, backfill, n, span),
      manufacturing: () => this.quality(org, at, sum, backfill, n, span),
      agency: () => this.agency(org, at, sum, n, span),
    } as Record<string, () => Promise<unknown>>)[industry];
    if (fn) await run(industry, fn);
  }

  // ------------------------------------------------------------------ customers, chats, leads, follow-ups

  /** A synthetic customer from this workspace's reserved pool (910000<ws>9xxxx); returning customers are normal. */
  private async customer(org: string, at: Date) {
    const sample = await this.prisma.customer.findFirst({ where: { organizationId: org, isDemo: true, phone: { startsWith: '910000' } }, select: { phone: true } });
    const sp = sample?.phone ?? '';
    const ws = sp.length > 11 ? sp.slice(6, sp.length - 5) : '9';
    const i = this.int(0, POOL - 1);
    const phone = `910000${ws}${String(90000 + i).padStart(5, '0')}`;
    const existing = await this.prisma.customer.findUnique({ where: { organizationId_phone: { organizationId: org, phone } } });
    if (existing) return { ...existing, phone };
    const created = await this.prisma.customer.create({ data: { id: this.id(org, 'cus', at.getTime()), organizationId: org, phone, name: NAMES[i % NAMES.length], isDemo: true, source: 'whatsapp', messagingConsent: true, language: this.pick(['english', 'tamil', 'tanglish']), createdAt: at } });
    return { ...created, phone };
  }

  private async leadFor(org: string, industry: string, customerId: string, at: Date, status = 'new', extra: Record<string, unknown> = {}, source?: string) {
    const last = await this.prisma.lead.findFirst({ where: { organizationId: org, customerId }, orderBy: { createdAt: 'desc' } });
    // A returning customer with a closed or week-old enquiry is a new enquiry (a new lead), as in a real CRM.
    const closed = ['won', 'lost', 'not_interested', 'order_confirmed', 'repeat_customer'];
    const lead = last && !closed.includes(last.status) && at.getTime() - last.createdAt.getTime() < 7 * DAY ? last : null;
    if (lead) {
      if (status !== 'new' && lead.status !== status) await this.prisma.lead.update({ where: { id: lead.id }, data: { status, updatedAt: at } });
      return lead;
    }
    const sources = industry === 'hospital' ? ['meta', 'whatsapp', 'website'] : industry === 'agency' ? ['meta', 'google', 'website', 'linkedin'] : industry === 'real_estate' ? ['meta', 'website', 'magicbricks', 'whatsapp'] : ['whatsapp', 'whatsapp', 'website', 'meta'];
    const created = await this.prisma.lead.create({ data: { id: this.id(org, 'lead', at.getTime()), organizationId: org, customerId, status, source: source ?? this.pick(sources), createdAt: at, updatedAt: at, ...(extra as object) } });
    const step = FOLLOW_UP_STEP[industry];
    if (step) await this.prisma.followUp.create({ data: { id: this.id(org, 'fu', at.getTime()), organizationId: org, leadId: created.id, customerId, channel: 'whatsapp', action: 'message', source: step.source, message: step.message, status: 'scheduled', scheduledAt: new Date(at.getTime() + this.int(10, 180) * MIN), attempts: 0, createdAt: at } });
    return created;
  }

  private async writeMessages(org: string, conversationId: string, turns: Turn[], at: Date, gapSec: number, meta: Record<string, unknown> = {}) {
    const start = at.getTime() - (turns.length - 1) * gapSec * 1000;
    for (const [k, [role, content]] of turns.entries()) {
      await this.prisma.message.create({ data: { id: this.id(org, 'msg', at.getTime()), organizationId: org, conversationId, role, content, createdAt: new Date(start + k * gapSec * 1000), metadata: { demo: true, demoFeed: true, ...(role === 'assistant' ? { simulated: true, path: 'rules' } : {}), ...meta } as never } });
    }
  }

  private async conversation(org: string, customerId: string, phone: string, channel: 'whatsapp' | 'voice', status: string, at: Date) {
    const found = await this.prisma.conversation.findUnique({ where: { organizationId_channel_externalId: { organizationId: org, channel, externalId: phone } } });
    if (found) return this.prisma.conversation.update({ where: { id: found.id }, data: { status, updatedAt: at } });
    return this.prisma.conversation.create({ data: { id: this.id(org, 'conv', at.getTime()), organizationId: org, customerId, channel, externalId: phone, status, createdAt: at, updatedAt: at } });
  }

  private async chat(org: string, industry: string, at: Date, sum: ActivitySummary) {
    const scripts = CHATS[industry];
    if (!scripts?.length) return;
    const script: ChatScript = this.pick(scripts);
    const c = await this.customer(org, at);
    const conv = await this.conversation(org, c.id, c.phone, 'whatsapp', script.status ?? 'active', at);
    await this.writeMessages(org, conv.id, script.turns, at, 25, { channel: 'whatsapp' });
    await this.prisma.customer.update({ where: { id: c.id }, data: { lastInboundAt: at } });
    if (industry === 'restaurant' || industry === 'food') {
      // The shop's WhatsApp processing log: one row per customer message, marked simulated (nothing reached Meta).
      const users = script.turns.filter(([r]) => r === 'user');
      for (const [k, [, text]] of users.entries()) {
        const rid = this.id(org, 'in', at.getTime());
        const when = new Date(at.getTime() - (users.length - 1 - k) * 50_000);
        await this.prisma.inboundMessage.create({ data: { id: rid, organizationId: org, providerMessageId: `demo.${rid}`, fromPhone: c.phone, messageType: 'text', payload: { demo: true, text } as never, status: 'simulated', attempts: 1, conversationId: conv.id, replyStatus: 'simulated', lastError: 'SIMULATED (live demo): handled by the demo feed; no WhatsApp reply was sent', receivedAt: when, processedAt: new Date(when.getTime() + 2000), updatedAt: when } });
      }
    }
    const lead = await this.leadFor(org, industry, c.id, at, script.lead ?? 'new', script.leadExtra);
    if (script.handoff) {
      await this.prisma.followUp.create({ data: { id: this.id(org, 'ho', at.getTime()), organizationId: org, leadId: lead.id, customerId: c.id, channel: 'human', action: 'handoff', source: 'task', status: 'open', message: `Handoff: ${script.handoff}`, scheduledAt: at, createdAt: at } });
      sum.records.push('handoff');
    }
    sum.chats++;
  }

  private async progressLeads(org: string, industry: string, at: Date, sum: ActivitySummary) {
    const next = LEAD_NEXT[industry];
    if (!next || !this.chance(0.5)) return;
    const leads = await this.prisma.lead.findMany({ where: { organizationId: org, status: { in: Object.keys(next) }, updatedAt: { lt: new Date(at.getTime() - 4 * MIN) } }, orderBy: { updatedAt: 'asc' }, take: 20 });
    if (!leads.length) return;
    const l = this.pick(leads);
    const to = next[l.status];
    await this.prisma.lead.update({ where: { id: l.id }, data: { status: to, updatedAt: at } });
    await this.prisma.auditEvent.create({ data: { id: this.id(org, 'aud', at.getTime()), organizationId: org, actor: this.chance(0.6) ? 'ai' : 'user:demo-staff', entityType: 'lead', entityId: l.id, action: `status:${to}`, data: { from: l.status, to, demoFeed: true } as never, createdAt: at } });
    sum.leads++;
  }

  /** Due follow-ups go out (simulated: DRY_RUN / demo numbers); handoffs get picked up; the upcoming list stays filled. */
  private async followUps(org: string, industry: string, at: Date, sum: ActivitySummary) {
    const due = await this.prisma.followUp.findMany({ where: { organizationId: org, status: 'scheduled', scheduledAt: { lte: at } }, take: 6 });
    for (const f of due) {
      const replied = this.chance(0.2);
      await this.prisma.followUp.update({ where: { id: f.id }, data: replied ? { status: 'skipped', lastError: 'customer_replied', completedAt: at, attempts: f.attempts + 1 } : { status: 'simulated', lastError: 'DRY_RUN: message not sent (simulated)', completedAt: at, attempts: f.attempts + 1 } });
      sum.followUps++;
    }
    const open = await this.prisma.followUp.findMany({ where: { organizationId: org, action: 'handoff', status: 'open', scheduledAt: { lt: new Date(at.getTime() - 20 * MIN) } }, take: 5 });
    if (open.length > 2 && this.chance(0.3)) await this.prisma.followUp.update({ where: { id: this.pick(open).id }, data: { status: 'completed', completedAt: at } });
    const upcoming = await this.prisma.followUp.count({ where: { organizationId: org, status: 'scheduled', scheduledAt: { gt: at } } });
    if (upcoming < 6) {
      const leads = await this.prisma.lead.findMany({ where: { organizationId: org }, orderBy: { updatedAt: 'desc' }, take: 30 });
      const step = FOLLOW_UP_STEP[industry];
      if (leads.length && step) {
        const l = this.pick(leads);
        const voice = Boolean(CALLS[industry]) && this.chance(0.25);
        await this.prisma.followUp.create({ data: { id: this.id(org, 'fu', at.getTime()), organizationId: org, leadId: l.id, customerId: l.customerId, channel: voice ? 'voice' : 'whatsapp', action: voice ? 'call' : 'message', source: voice ? 'retry' : step.source, message: voice ? 'call' : step.message, status: 'scheduled', scheduledAt: new Date(at.getTime() + this.int(5, 240) * MIN), attempts: 0, createdAt: at } });
      }
    }
  }

  /** AI calls: some ring and connect (live for a minute, with a transcript), some are not answered. */
  private async calls(org: string, industry: string, at: Date, sum: ActivitySummary, backfill: boolean, n: number, span: number) {
    const live = await this.prisma.call.findMany({ where: { organizationId: org, status: { in: ['ringing', 'in_progress'] }, id: { startsWith: 'dl_' } } });
    for (const c of live) {
      if (at.getTime() - c.updatedAt.getTime() < 50_000 && !backfill) continue;
      const script = CALLS[industry].find((s) => s.summary === c.summary) ?? CALLS[industry][0];
      // Real calls vary in length: the transcript plus listening / thinking time.
      const duration = script.lines.length * 9 + this.int(15, 150);
      const ended = new Date((c.answeredAt ?? c.createdAt).getTime() + duration * 1000);
      await this.prisma.call.update({ where: { id: c.id }, data: { status: 'completed', outcome: script.outcome, endedAt: ended, durationSec: duration, turns: script.lines.length, endReason: 'completed', updatedAt: at } });
      if (script.leadStatus && c.leadId) await this.prisma.lead.update({ where: { id: c.leadId }, data: { status: script.leadStatus, updatedAt: ended } });
    }
    for (let k = 0; k < n; k++) await this.newCall(org, industry, this.within(at, span), sum);
  }

  private async newCall(org: string, industry: string, at: Date, sum: ActivitySummary) {
    const c = await this.customer(org, at);
    const lead = await this.leadFor(org, industry, c.id, at);
    const outbound = this.chance(0.7);
    const base = { id: this.id(org, 'call', at.getTime()), organizationId: org, customerId: c.id, leadId: lead.id, direction: outbound ? 'outbound' : 'inbound', toNumber: outbound ? c.phone : 'demo-line', fromNumber: outbound ? 'demo-line' : c.phone, language: this.pick(['english', 'tamil', 'tanglish']), createdAt: at, updatedAt: at };
    if (outbound && this.chance(0.3)) {
      const st = this.pick(['no_answer', 'no_answer', 'busy', 'failed']);
      await this.prisma.call.create({ data: { ...base, status: st, outcome: st, endedAt: at, durationSec: 0, hangupCause: st === 'failed' ? 'DEMO: simulated network error' : null } });
    } else {
      const script = this.pick(CALLS[industry]);
      // The call started a little earlier: its transcript ends now (never future-dated); it hangs up on the next tick.
      const started = new Date(at.getTime() - (script.lines.length * 9 + 5) * 1000);
      await this.prisma.call.create({ data: { ...base, createdAt: started, status: 'in_progress', answeredAt: new Date(started.getTime() + 4000), summary: script.summary, turns: 0 } });
      const conv = await this.conversation(org, c.id, c.phone, 'voice', 'active', at);
      const callId = base.id;
      for (const [k, [role, content]] of script.lines.entries()) await this.prisma.message.create({ data: { id: this.id(org, 'msg', at.getTime()), organizationId: org, conversationId: conv.id, role, content, createdAt: new Date(started.getTime() + 5000 + k * 9000), metadata: { demo: true, demoFeed: true, channel: 'voice', callId, ...(role === 'assistant' ? { simulated: true, path: 'rules' } : {}) } as never } });
    }
    sum.calls++;
  }

  // ------------------------------------------------------------------ restaurant (GR Chicken demo) and food

  private async kitchen(org: string, kind: 'restaurant' | 'food', at: Date, sum: ActivitySummary, backfill: boolean, n: number, span: number) {
    const t = at.getTime();
    const active = await this.prisma.order.findMany({ where: { organizationId: org, isDemo: true, status: { in: ['pending', 'confirmed', 'preparing', 'ready', 'dispatched'] } }, orderBy: { createdAt: 'asc' }, take: 40 });
    const after: Record<string, [string, number]> = kind === 'food'
      ? { pending: ['confirmed', 3], confirmed: ['preparing', 6], preparing: ['@ready', 18], ready: ['completed', 30], dispatched: ['completed', 42] }
      : { pending: ['confirmed', 3], confirmed: ['preparing', 8], preparing: ['ready', 20], ready: ['completed', 40] };
    for (const o of active) {
      // Minutes after the order was placed when each stage is due. Live: at most one stage per minute. Replay: every
      // stage that fell inside the step, each stamped at the moment it was due (not at the end of the step).
      let status = o.status;
      for (let guard = 0; guard < 6; guard++) {
        const rule = after[status];
        if (!rule) break;
        const due = o.createdAt.getTime() + rule[1] * MIN;
        if (t < due || (!backfill && !this.chance(0.6))) break;
        const when = backfill ? new Date(Math.min(t, due + this.int(0, 150) * 1000)) : at;
        const to = rule[0] === '@ready' ? (o.fulfilment === 'delivery' ? 'dispatched' : 'ready') : rule[0];
        const rated = to === 'completed' && this.chance(0.4);
        const rating = rated ? this.pick([5, 5, 5, 4, 4, 3, 2]) : null;
        await this.prisma.order.update({
          where: { id: o.id },
          data: {
            status: to, updatedAt: when,
            ...(to === 'dispatched' ? { dispatchedAt: when } : {}),
            ...(to === 'completed' ? { collectedAt: when, paymentStatus: kind === 'food' ? 'paid' : o.paymentStatus } : {}),
            ...(to === 'ready' && kind === 'restaurant' ? { readyNotice: this.pick(['whatsapp_sent', 'answered', 'no_answer']), readyNoticeNote: 'SIMULATED (DRY_RUN): no message / call was placed' } : {}),
            ...(rated ? { feedbackRating: rating, feedbackAt: new Date(Math.min(t, when.getTime() + 20 * MIN)), feedbackChannel: 'whatsapp', ...(rating! <= 2 ? { complaintStatus: 'open', complaintNote: kind === 'food' ? 'Demo complaint: food arrived cold' : 'Demo complaint: pieces were small' } : {}) } : {}),
          },
        });
        await this.prisma.orderEvent.create({ data: { id: this.id(org, 'oev', when.getTime()), organizationId: org, orderId: o.id, type: 'status_changed', fromStatus: status, toStatus: to, actor: kind === 'food' ? 'user:demo-kitchen' : 'user:demo-counter', createdAt: when } });
        status = to;
        if (!backfill) break;
      }
    }
    for (let k = 0; k < n; k++) await this.newOrder(org, kind, this.within(at, span), sum);
  }

  private async newOrder(org: string, kind: 'restaurant' | 'food', at: Date, sum: ActivitySummary) {
    const t = at.getTime();
    const outlet = await this.prisma.outlet.findFirst({ where: { organizationId: org }, orderBy: { sortOrder: 'asc' } });
    const items = await this.prisma.menuItem.findMany({ where: { organizationId: org, available: true } });
    if (!outlet || !items.length) return;
    const c = await this.customer(org, at);
    const lines = Array.from({ length: this.int(1, kind === 'food' ? 3 : 2) }, () => this.pick(items)).map((m) => {
      const variants = ((m as { variants?: unknown }).variants as Array<{ name: string; price: number }> | null) ?? [];
      const v = variants.length ? this.pick(variants) : null;
      const unitPrice = v ? v.price : Number(m.price);
      const q = kind === 'restaurant' ? (m.unit === 'piece' ? this.pick([6, 12, 24]) : this.pick([0.5, 1, 1, 1.5, 2])) : this.int(1, 3);
      const cuts = (m.cutOptions as string[] | null) ?? [];
      return { menuItemId: m.id, name: m.name, cut: cuts.length ? this.pick(cuts) : null, unit: m.unit, variant: v?.name ?? null, unitPrice: dec(unitPrice), quantity: dec(q), lineTotal: dec(unitPrice * q) };
    });
    const subtotal = lines.reduce((a, l) => a + Number(l.lineTotal), 0);
    const delivery = kind === 'food' && this.chance(0.5);
    const zone = this.pick([['Anna Nagar', 30], ['Kilpauk', 40], ['Aminjikarai', 35]] as const);
    const tax = kind === 'food' ? Math.round(subtotal * 0.05 * 100) / 100 : 0;
    const fees = kind === 'food' ? 15 + (delivery ? zone[1] : 0) : 0;
    const prefix = kind === 'food' ? 'DEMO-FD' : 'DEMO-GR';
    const id = this.id(org, 'order', t);
    const channel = this.pick(['whatsapp', 'whatsapp', 'voice', kind === 'food' ? 'dashboard' : 'whatsapp']);
    await this.prisma.order.create({
      data: {
        id, organizationId: org, orderNumber: `${prefix}-${this.code(t)}`, customerId: c.id, outletId: outlet.id, channel, status: 'pending', pickupAt: new Date(t + (delivery ? 50 : 30) * MIN),
        subtotal: dec(subtotal), total: dec(subtotal + tax + fees), ...(kind === 'food' ? { taxAmount: dec(tax), deliveryFee: dec(fees), discount: dec(0) } : {}),
        fulfilment: delivery ? 'delivery' : 'pickup', deliveryAddress: delivery ? `DEMO · ${this.int(1, 40)}, ${this.pick(['2nd Street', 'Main Road', 'Cross Street'])}, ${zone[0]}` : null, deliveryZone: delivery ? zone[0] : null,
        paymentMethod: kind === 'food' ? (delivery ? 'pay_on_delivery' : 'pay_at_counter') : this.pick(['cash_at_shop', 'upi_at_shop']), paymentStatus: 'unpaid', idempotencyKey: `dl-${id}`, isDemo: true, createdAt: at, updatedAt: at,
        customerName: c.name, customerPhone: c.phone, language: this.pick(['tanglish', 'tamil', 'english']), demoScenario: 'live_demo',
        items: { create: lines.map((l) => ({ ...l, addOns: Prisma.JsonNull })) },
      } as never,
    });
    await this.prisma.orderEvent.create({ data: { id: this.id(org, 'oev', t), organizationId: org, orderId: id, type: 'created', toStatus: 'pending', actor: channel === 'dashboard' ? 'user:demo' : 'ai', note: 'Live demo order (simulated customer)', createdAt: at } });
    sum.records.push('order');
  }

  // ------------------------------------------------------------------ hotel

  private async hotel(org: string, at: Date, sum: ActivitySummary, backfill: boolean, n: number, span: number) {
    const t = at.getTime();
    const today = istDay(t);
    const minute = istMinute(t);
    // Holds get confirmed by the front desk.
    for (const r of await this.prisma.reservation.findMany({ where: { organizationId: org, status: 'pending_confirmation', createdAt: { lt: new Date(t - 8 * MIN) } }, take: 3 })) {
      if (!backfill && !this.chance(0.5)) continue;
      await this.prisma.reservation.update({ where: { id: r.id }, data: { status: 'confirmed', holdExpiresAt: null, updatedAt: at } });
      await this.audit(org, 'reservation', r.id, 'confirmed', at, 'user:demo-front-desk');
    }
    // Arrivals (from 12:00) and departures (from 08:00) today.
    if (minute >= 12 * 60) {
      const arrivals = await this.prisma.reservation.findMany({ where: { organizationId: org, status: 'confirmed', checkIn: { lte: dayOnly(today) } }, take: 3 });
      for (const r of arrivals) {
        if (!backfill && !this.chance(0.35)) continue;
        const room = await this.prisma.room.findFirst({ where: { organizationId: org, roomTypeId: r.roomTypeId, status: 'available' } });
        if (!room) continue;
        await this.prisma.room.update({ where: { id: room.id }, data: { status: 'occupied' } });
        await this.prisma.reservation.update({ where: { id: r.id }, data: { status: 'checked_in', roomId: room.id, checkedInAt: at, updatedAt: at } });
        await this.audit(org, 'reservation', r.id, 'checked_in', at, 'user:demo-front-desk');
        sum.records.push('check-in');
      }
    }
    if (minute >= 8 * 60) {
      const departures = await this.prisma.reservation.findMany({ where: { organizationId: org, status: 'checked_in', checkOut: { lte: dayOnly(today) } }, take: 3 });
      for (const r of departures) {
        if (!backfill && !this.chance(0.35)) continue;
        if (r.roomId) await this.prisma.room.update({ where: { id: r.roomId }, data: { status: 'available', housekeeping: 'dirty' } });
        const rated = this.chance(0.5);
        await this.prisma.reservation.update({ where: { id: r.id }, data: { status: 'checked_out', checkedOutAt: at, updatedAt: at, ...(rated ? { feedbackRating: this.pick([5, 5, 4, 4, 3]), feedbackComment: this.pick(['Lovely stay', 'Breakfast was great', 'Quick check-out', 'Room was clean']) } : {}) } });
        await this.audit(org, 'reservation', r.id, 'checked_out', at, 'user:demo-front-desk');
        sum.records.push('check-out');
      }
    }
    // Housekeeping turns rooms around.
    const dirty = await this.prisma.room.findMany({ where: { organizationId: org, housekeeping: { in: ['dirty', 'inspecting'] } }, take: 5 });
    if (dirty.length && this.chance(0.4)) { const d = this.pick(dirty); await this.prisma.room.update({ where: { id: d.id }, data: { housekeeping: d.housekeeping === 'dirty' ? 'inspecting' : 'clean' } }); }
    // New booking requests from WhatsApp / website / phone.
    for (let k = 0; k < n; k++) await this.newReservation(org, this.within(at, span), sum);
  }

  private async newReservation(org: string, at: Date, sum: ActivitySummary) {
    const t = at.getTime();
    const today = istDay(t);
    const types = await this.prisma.roomType.findMany({ where: { organizationId: org, active: true }, include: { rooms: { select: { id: true, status: true } } } });
    if (!types.length) return;
    const tp = this.pick(types);
    const ci = addDays(today, this.int(0, 21));
    const nights = this.pick([1, 1, 2, 2, 3]);
    const co = addDays(ci, nights);
    const sell = tp.rooms.filter((r) => r.status !== 'out_of_service').length;
    const overlap = await this.prisma.reservation.count({ where: { organizationId: org, roomTypeId: tp.id, status: { in: ['confirmed', 'checked_in', 'pending_confirmation'] }, checkIn: { lt: dayOnly(co) }, checkOut: { gt: dayOnly(ci) } } });
    if (overlap >= sell) return;
    const base = Number(tp.baseRate), weekend = Number(tp.weekendRate ?? tp.baseRate);
    const breakdown = Array.from({ length: nights }, (_, k) => { const d = addDays(ci, k); const dow = dayOnly(d).getUTCDay(); return dow === 5 || dow === 6 ? { date: d, rate: weekend, source: 'weekend' } : { date: d, rate: base, source: 'base' }; });
    const subtotal = breakdown.reduce((a, b) => a + b.rate, 0);
    const tax = Math.round(subtotal * 0.12 * 100) / 100;
    const c = await this.customer(org, at);
    const lead = await this.leadFor(org, 'hotel', c.id, at, 'won');
    const id = this.id(org, 'res', t);
    const pending = this.chance(0.5);
    await this.prisma.reservation.create({
      data: {
        id, organizationId: org, reference: `DEMO-HB-${this.code(t)}`, customerId: c.id, leadId: lead.id, roomTypeId: tp.id, checkIn: dayOnly(ci), checkOut: dayOnly(co), nights, rooms: 1, adults: this.int(1, Math.min(2, tp.maxAdults)), children: 0,
        status: pending ? 'pending_confirmation' : 'confirmed', holdExpiresAt: pending ? new Date(t + 3 * 3_600_000) : null, subtotal: dec(subtotal), taxAmount: dec(tax), total: dec(subtotal + tax), rateBreakdown: breakdown as never,
        depositAmount: dec(Math.round((subtotal + tax) * 0.2 * 100) / 100), paymentStatus: this.pick(['pending', 'simulated_paid']), channel: this.pick(['whatsapp', 'whatsapp', 'voice', 'website']), guestName: c.name, guestPhone: c.phone,
        specialRequests: this.chance(0.3) ? this.pick(['Early check-in if possible', 'High floor please', 'Airport pickup at 6 AM']) : null, idempotencyKey: `dl-${id}`, isDemo: true, createdBy: 'ai', createdAt: at, updatedAt: at,
      },
    });
    await this.audit(org, 'reservation', id, 'created', at, 'ai');
    sum.records.push('reservation');
  }

  // ------------------------------------------------------------------ hospital

  private async hospital(org: string, at: Date, sum: ActivitySummary, backfill: boolean, n: number, span: number, leads: number) {
    const t = at.getTime();
    const today = istDay(t);
    // Today's clinic: patients arrive, are seen, a few do not turn up.
    const todays = await this.prisma.appointment.findMany({ where: { organizationId: org, startAt: { gte: istAt(today, 0), lt: istAt(today, 24 * 60) }, status: { in: ['booked', 'confirmed', 'checked_in'] } }, include: { doctor: { select: { slotMinutes: true } } } });
    for (const a of todays) {
      const startMs = a.startAt.getTime();
      let to: string | null = null;
      if (a.status === 'checked_in' && t >= startMs + (a.doctor?.slotMinutes ?? 15) * MIN) to = 'completed';
      else if (a.status !== 'checked_in' && t >= startMs - 10 * MIN) to = t >= startMs + 25 * MIN ? (this.chance(0.7) ? 'checked_in' : 'no_show') : this.chance(backfill ? 0.9 : 0.5) ? 'checked_in' : null;
      else if (a.status === 'booked' && t >= startMs - 3 * 3_600_000 && this.chance(0.15)) to = 'confirmed';
      if (!to) continue;
      await this.prisma.appointment.update({ where: { id: a.id }, data: { status: to, updatedAt: at, ...(to === 'completed' && this.chance(0.4) ? { feedbackRating: this.pick([5, 5, 4, 4, 3]) } : {}) } });
      await this.audit(org, 'appointment', a.id, to, at, to === 'confirmed' ? 'ai' : 'user:demo-reception');
    }
    // New bookings for later today / the next days on each doctor's real OPD grid.
    for (let k = 0; k < n; k++) await this.bookAppointment(org, this.within(at, span), sum);
    // Campaign leads arrive from Meta ads.
    for (let k = 0; k < leads; k++) {
      const when = this.within(at, span);
      const c = await this.customer(org, when);
      await this.leadFor(org, 'hospital', c.id, when, 'new', { campaign: this.pick(['Free Heart Check-up Camp', 'Knee Pain Clinic', 'Child Vaccination Week']) }, 'meta');
      sum.records.push('campaign lead');
    }
    // The insurance desk moves cases along.
    if (this.chance(Math.min(1, 0.06 * span))) {
      const next: Record<string, string> = { documents_pending: 'ready_to_submit', ready_to_submit: 'submitted', submitted: this.pick(['approved', 'query_raised']), query_raised: 'submitted', approved: 'settled' };
      const cases = await this.prisma.insuranceCase.findMany({ where: { organizationId: org, status: { in: Object.keys(next) } }, take: 10 });
      if (cases.length) {
        const k = this.pick(cases);
        await this.prisma.insuranceCase.update({ where: { id: k.id }, data: { status: next[k.status], updatedAt: at, ...(k.status === 'documents_pending' ? { receivedDocs: k.requiredDocs as never } : {}), ...(['approved', 'settled'].includes(next[k.status]) ? { amountApproved: k.amountRequested, decidedBy: 'user:demo-insurance-desk' } : {}) } });
        await this.audit(org, 'insurance_case', k.id, next[k.status], at, 'user:demo-insurance-desk');
      }
    }
  }

  private async bookAppointment(org: string, at: Date, sum: ActivitySummary) {
    const t = at.getTime();
    const doctors = await this.prisma.doctor.findMany({ where: { organizationId: org, active: true } });
    if (!doctors.length) return;
    const day = addDays(istDay(t), this.chance(0.6) ? 0 : this.int(1, 6));
    const dow = dayOnly(day).getUTCDay();
    const d = this.pick(doctors);
    const blocks = ((d.schedule as Array<{ day: number; start: string; end: string }> | null) ?? []).filter((b) => b.day === dow);
    if (!blocks.length) return;
    const b = this.pick(blocks);
    const slot = d.slotMinutes ?? 15;
    const count = Math.floor((hm(b.end) - hm(b.start)) / slot);
    const s = this.int(0, Math.max(0, count - 1));
    const start = istAt(day, hm(b.start) + s * slot);
    if (start.getTime() < t + 20 * MIN) return;
    if (await this.prisma.appointment.count({ where: { doctorId: d.id, startAt: start, status: { not: 'cancelled' } } })) return;
    const c = await this.customer(org, at);
    const lead = await this.leadFor(org, 'hospital', c.id, at, 'won');
    const id = this.id(org, 'appt', t);
    await this.prisma.appointment.create({ data: { id, organizationId: org, reference: `DEMO-AP-${this.code(t)}`, customerId: c.id, leadId: lead.id, doctorId: d.id, departmentId: d.departmentId, startAt: start, endAt: new Date(start.getTime() + slot * MIN), status: 'booked', visitType: this.chance(0.3) ? 'follow_up' : 'new', reasonNote: this.pick(['Routine check-up', 'Follow-up visit', 'Wants consultation', null]), channel: this.pick(['whatsapp', 'whatsapp', 'voice', 'website']), patientName: c.name, patientPhone: c.phone, idempotencyKey: `dl-${id}`, isDemo: true, createdBy: 'ai', createdAt: at, updatedAt: at } });
    await this.audit(org, 'appointment', id, 'booked', at, 'ai');
    sum.records.push('appointment');
  }

  // ------------------------------------------------------------------ real estate

  private async siteVisits(org: string, at: Date, sum: ActivitySummary, n: number, span: number) {
    const t = at.getTime();
    for (const v of await this.prisma.siteVisit.findMany({ where: { organizationId: org, status: 'scheduled', scheduledAt: { lt: new Date(t - 30 * MIN) } }, take: 3 })) {
      if (!this.chance(0.4)) continue;
      const to = this.chance(0.75) ? 'completed' : 'no_show';
      await this.prisma.siteVisit.update({ where: { id: v.id }, data: { status: to, updatedAt: at } });
      if (to === 'completed') await this.prisma.lead.update({ where: { id: v.leadId }, data: { status: this.pick(['site_visit', 'won', 'property_interested']), updatedAt: at } }).catch(() => undefined);
    }
    for (let k = 0; k < n; k++) await this.newVisit(org, this.within(at, span), sum);
  }

  private async newVisit(org: string, at: Date, sum: ActivitySummary) {
    const t = at.getTime();
    const leads = await this.prisma.lead.findMany({ where: { organizationId: org, status: { in: ['qualified', 'property_interested', 'contacted'] } }, take: 30 });
    const props = await this.prisma.property.findMany({ where: { organizationId: org } });
    if (!leads.length || !props.length) return;
    const l = this.pick(leads);
    const when = istAt(addDays(istDay(t), this.int(0, 6)), this.pick([10 * 60, 11 * 60, 15 * 60, 16 * 60 + 30]));
    await this.prisma.siteVisit.create({ data: { id: this.id(org, 'visit', t), organizationId: org, leadId: l.id, customerId: l.customerId, propertyId: this.pick(props).id, scheduledAt: when.getTime() > t ? when : new Date(t + 2 * 3_600_000), status: 'scheduled', createdAt: at, updatedAt: at } });
    await this.prisma.lead.update({ where: { id: l.id }, data: { status: 'site_visit', updatedAt: at } });
    sum.records.push('site visit');
  }

  // ------------------------------------------------------------------ textile / retail: quotation → order → invoice → payment → feedback

  private async sales(org: string, kind: 'textile' | 'retail', at: Date, sum: ActivitySummary, backfill: boolean, n: number, span: number) {
    const t = at.getTime();
    const products = await this.prisma.textileProduct.findMany({ where: { organizationId: org, priceApproved: true } });
    // Orders move through fulfilment.
    // Minutes in the current stage before the next one (B2B pace: packed the same day, delivered later).
    const flow: Record<string, [string, number]> = { confirmed: ['processing', 20], processing: ['ready_to_dispatch', 90], ready_to_dispatch: ['dispatched', 180], dispatched: ['delivered', 480] };
    for (const o of await this.prisma.salesOrder.findMany({ where: { organizationId: org, status: { in: Object.keys(flow) } }, orderBy: { updatedAt: 'asc' }, take: 25 })) {
      const [to, mins] = flow[o.status];
      if (t - o.updatedAt.getTime() < mins * MIN || (!backfill && !this.chance(0.35))) continue;
      await this.prisma.salesOrder.update({ where: { id: o.id }, data: { status: to, updatedAt: at, ...(to === 'dispatched' ? { courier: 'ST Courier', trackingRef: `DEMO${this.int(100000, 999999)}` } : {}), ...(to === 'delivered' ? { deliveredAt: at } : {}) } });
      await this.audit(org, 'order', o.id, `status:${to}`, at, 'user:demo-sales');
      if (to === 'dispatched') await this.invoice(org, o.id, at);
      if (to === 'delivered') {
        await this.pay(org, o.id, at);
        const fb = await this.prisma.feedback.findUnique({ where: { orderId: o.id } });
        if (!fb) {
          const received = this.chance(0.6);
          const rating = this.pick([5, 5, 4, 4, 3, 2]);
          await this.prisma.feedback.create({ data: { id: this.id(org, 'fb', t), organizationId: org, customerId: o.customerId, orderId: o.id, channel: 'whatsapp', status: received ? (rating <= 3 ? 'needs_action' : 'received') : 'requested', rating: received ? rating : null, comment: received ? this.pick(rating <= 3 ? ['Colour slightly different from the photo', 'Two pieces had loose stitching'] : ['Good quality', 'Delivered on time', 'Excellent finish']) : null, requestedAt: at, receivedAt: received ? at : null } });
          sum.records.push('feedback');
        }
      }
    }
    // Sent quotations get accepted (→ sales order) or expire; drafts get sent.
    for (const q of await this.prisma.quotation.findMany({ where: { organizationId: org, status: { in: ['draft', 'sent'] }, updatedAt: { lt: new Date(t - 6 * MIN) } }, include: { items: true }, take: 10 })) {
      if (!backfill && !this.chance(0.3)) continue;
      if (q.status === 'draft') { await this.prisma.quotation.update({ where: { id: q.id }, data: { status: 'sent', sentAt: at, updatedAt: at } }); continue; }
      if (this.chance(0.75)) await this.order(org, q, at, sum);
      else await this.prisma.quotation.update({ where: { id: q.id }, data: { status: this.pick(['rejected', 'expired']), updatedAt: at } });
    }
    // New quotation (textile) or a direct order (retail).
    if (!products.length) return;
    for (let k = 0; k < n; k++) await this.newQuotation(org, kind, products, this.within(at, span), sum);
  }

  private async newQuotation(org: string, kind: 'textile' | 'retail', products: Array<{ id: string; sku: string; name: string; priceUnit: string; price: Prisma.Decimal | null }>, at: Date, sum: ActivitySummary) {
    const t = at.getTime();
    const c = await this.customer(org, at);
    const lead = await this.leadFor(org, kind, c.id, at, kind === 'textile' ? 'quotation_sent' : 'order_confirmed');
    const items = Array.from({ length: this.int(1, 3) }, () => this.pick(products)).map((p) => {
      const qty = p.priceUnit === 'metre' ? this.int(100, 500) : this.int(1, kind === 'textile' ? 80 : 3);
      return { productId: p.id, sku: p.sku, description: p.name, quantity: dec(qty), unit: p.priceUnit, unitPrice: p.price, lineTotal: dec(qty * Number(p.price)) };
    });
    const subtotal = items.reduce((a, x) => a + Number(x.lineTotal), 0);
    const qid = this.id(org, 'quo', t);
    const q = await this.prisma.quotation.create({ data: { id: qid, organizationId: org, customerId: c.id, leadId: lead.id, number: `DEMO-Q-${this.code(t)}`, status: kind === 'retail' ? 'accepted' : this.pick(['draft', 'sent', 'sent']), subtotal: dec(subtotal), taxPercent: dec(5), tax: dec(subtotal * 0.05), total: dec(Math.round(subtotal * 1.05 * 100) / 100), origin: this.pick(['ai_request', 'manual']), createdAt: at, updatedAt: at, sentAt: at, items: { create: items } } as never, include: { items: true } });
    sum.records.push(kind === 'retail' ? 'order' : 'quotation');
    if (kind === 'retail') await this.order(org, q as never, at, sum);
  }

  private async order(org: string, q: { id: string; customerId: string; leadId: string | null; total: Prisma.Decimal; items: Array<{ productId: string | null; sku: string | null; description: string; quantity: Prisma.Decimal; unit: string; unitPrice: Prisma.Decimal; lineTotal: Prisma.Decimal }> }, at: Date, sum: ActivitySummary) {
    const t = at.getTime();
    await this.prisma.quotation.update({ where: { id: q.id }, data: { status: 'accepted', updatedAt: at } });
    if (await this.prisma.salesOrder.findUnique({ where: { quotationId: q.id } })) return;
    const id = this.id(org, 'so', t);
    await this.prisma.salesOrder.create({ data: { id, organizationId: org, customerId: q.customerId, leadId: q.leadId, quotationId: q.id, number: `DEMO-SO-${this.code(t)}`, status: 'confirmed', paymentStatus: 'unpaid', total: q.total, createdAt: at, updatedAt: at, items: { create: q.items.map((i) => ({ productId: i.productId, sku: i.sku, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, lineTotal: i.lineTotal })) } } as never });
    await this.audit(org, 'order', id, 'status:confirmed', at, 'user:demo-sales');
    sum.records.push('sales order');
  }

  /** Invoice through the real finance service (draft → approved → issued). */
  private async invoice(org: string, orderId: string, at: Date) {
    if (!this.finance) return;
    try {
      const inv = await this.finance.createInvoice(org, orderId, 'user:demo-accounts (simulated)') as unknown as { id: string; status: string } | { invoice: { id: string; status: string } };
      const row = 'invoice' in inv ? inv.invoice : inv;
      if (row.status === 'draft') await this.finance.setInvoiceStatus(org, row.id, 'approved', ACCOUNTS);
      await this.finance.setInvoiceStatus(org, row.id, 'issued', ACCOUNTS).catch(() => undefined);
      // Replayed history: the invoice belongs to the day the order was dispatched, not to the moment of the replay.
      if (Date.now() - at.getTime() > 10 * MIN) await this.prisma.invoice.update({ where: { id: row.id }, data: { invoiceDate: at, issuedAt: at, dueDate: new Date(at.getTime() + 15 * DAY), createdAt: at } });
    } catch (error) {
      log.warn('demo_live.invoice_failed', { org, orderId, error: errorMessage(error) });
    }
  }

  /** A payment recorded and verified against the order's invoice (simulated staff evidence). Some stay unverified. */
  private async pay(org: string, orderId: string, at: Date) {
    if (!this.finance || !this.chance(0.7)) return;
    const inv = await this.prisma.invoice.findFirst({ where: { organizationId: org, orderId, status: { in: ['issued', 'partially_paid'] } } });
    if (!inv) return;
    const part = this.chance(0.25);
    const amount = Math.round((Number(inv.total) - Number(inv.amountPaid)) * (part ? 0.5 : 1) * 100) / 100;
    if (amount <= 0) return;
    const utr = `DEMOUTR${Math.floor(at.getTime() / 1000)}${this.int(100000, 999999)}`;
    try {
      const p = await this.finance.recordPayment(org, { invoiceId: inv.id, amount, method: this.pick(['upi', 'upi', 'bank_transfer']), reference: utr, paidAt: at.toISOString() }, 'user:demo-accounts (simulated)') as unknown as { payment?: { id: string }; id?: string };
      const pid = p.payment?.id ?? p.id;
      if (pid && this.chance(0.8)) await this.finance.verifyPayment(org, pid, ACCOUNTS, `Demo bank statement (simulated) credit ₹${amount} UTR ${utr}`);
      if (pid && Date.now() - at.getTime() > 10 * MIN) await this.prisma.payment.update({ where: { id: pid }, data: { createdAt: at, verifiedAt: (await this.prisma.payment.findUnique({ where: { id: pid }, select: { verifiedAt: true } }))?.verifiedAt ? new Date(Math.min(Date.now(), at.getTime() + 2 * 3_600_000)) : null } });
    } catch (error) {
      log.warn('demo_live.payment_failed', { org, orderId, error: errorMessage(error) });
    }
  }

  // ------------------------------------------------------------------ manufacturing

  private async quality(org: string, at: Date, sum: ActivitySummary, backfill: boolean, n: number, span: number) {
    const t = at.getTime();
    for (const q of await this.prisma.qualityInspection.findMany({ where: { organizationId: org, status: 'open', inspectedAt: { lt: new Date(t - 20 * MIN) } }, take: 5 })) {
      if (!this.chance(backfill ? 0.3 : 0.08)) continue;
      await this.prisma.qualityInspection.update({ where: { id: q.id }, data: { status: 'resolved', resolvedAt: at, resolution: this.pick(['Die re-polished', 'Operator retrained', 'Supplier lot replaced', 'Fixture recalibrated']), updatedAt: at } });
      await this.prisma.workTask.updateMany({ where: { organizationId: org, entityType: 'quality_inspection', entityId: q.id, status: { not: 'done' } }, data: { status: 'done', updatedAt: at } });
    }
    for (const w of await this.prisma.workTask.findMany({ where: { organizationId: org, status: 'open' }, take: 5 })) if (this.chance(0.1)) await this.prisma.workTask.update({ where: { id: w.id }, data: { status: 'in_progress', updatedAt: at } });
    for (let k = 0; k < n; k++) await this.newInspection(org, this.within(at, span), sum);
  }

  private async newInspection(org: string, at: Date, sum: ActivitySummary) {
    const t = at.getTime();
    const line = this.pick(['Line 1', 'Line 2', 'Line 3']);
    const product = this.pick(['Rubber Gasket 40mm', 'Brass Fitting 1/2"', 'Aluminium Bracket A2', 'Steel Shaft 12mm']);
    const inspected = this.int(200, 1200);
    const rate = line === 'Line 3' ? 0.02 + this.random() * 0.07 : this.random() * 0.035;
    const rejected = Math.round(inspected * rate);
    const cats = ['surface scratch', 'dimension out of tolerance', 'crack', 'burr', 'porosity', 'colour mismatch'];
    const defects = rejected ? Array.from(new Set(Array.from({ length: this.int(1, 2) }, () => this.pick(cats)))).map((c) => ({ category: c, count: Math.max(1, Math.round(rejected / 2)) })) : [];
    const id = this.id(org, 'qi', t);
    const batch = `DEMO-L${this.code(t)}`;
    const open = rejected > 0 && rate > 0.03;
    await this.prisma.qualityInspection.create({ data: { id, organizationId: org, batchCode: batch, productName: product, line, inspector: this.pick(['QC Anand', 'QC Priya', 'QC Ramesh']), inspectedAt: at, inspectedQty: inspected, rejectedQty: rejected, defects: defects as never, status: open ? 'open' : 'resolved', severity: rate > 0.06 ? 'major' : 'minor', resolvedAt: open ? null : at, isDemo: true, createdBy: 'user:demo-qc', createdAt: at, updatedAt: at } });
    if (open && rate > 0.05) await this.prisma.workTask.create({ data: { id: this.id(org, 'wt', t), organizationId: org, agent: 'operations', kind: 'exception', priority: rate > 0.07 ? 'high' : 'normal', title: `Quality alert: batch ${batch} (${product}) rejection ${Math.round(rate * 1000) / 10}%`, detail: 'Corrective action raised by the quality alert scan (live demo).', status: 'open', assignee: this.pick(['QC Priya', 'Maintenance Raju']), entityType: 'quality_inspection', entityId: id, dedupeKey: `demo:${org}:quality_alert:${id}`, createdBy: 'agent:operations', createdAt: at, updatedAt: at } });
    sum.records.push('inspection');
  }

  // ------------------------------------------------------------------ agency

  private async agency(org: string, at: Date, sum: ActivitySummary, n: number, span: number) {
    for (let k = 0; k < n; k++) {
      const when = this.within(at, span);
      await this.newAgencyLead(org, when, sum);
    }
  }

  private async newAgencyLead(org: string, at: Date, sum: ActivitySummary) {
    const c = await this.customer(org, at);
    await this.leadFor(org, 'agency', c.id, at, 'new', { campaign: this.pick(['Diwali Boutique Promo', 'Clinic Lead Gen', 'Restaurant Footfall', null]), notes: this.pick(['Wants Instagram + Meta lead ads', 'Needs a WhatsApp booking flow', 'Monthly SEO + Google Ads retainer', 'Landing page and lead-form setup']) });
    sum.records.push('lead');
  }

  private audit(org: string, entityType: string, entityId: string, action: string, at: Date, actor: string) {
    return this.prisma.auditEvent.create({ data: { id: this.id(org, 'aud', at.getTime()), organizationId: org, actor, entityType, entityId, action, data: { demoFeed: true } as never, createdAt: at } });
  }

  // ------------------------------------------------------------------ retention

  /** Feed records ("dl_" ids) older than 35 days are deleted, children first. Seeded demo rows are never touched. */
  async prune(org: string, now = new Date(), prefix = 'dl_') {
    if (!(await this.industryOf(org))) return 0;
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
    const old = { organizationId: org, id: { startsWith: prefix }, createdAt: { lt: cutoff } };
    let n = 0;
    const del = async (model: string, where: unknown) => {
      const m = (this.prisma as unknown as Record<string, { deleteMany: (a: unknown) => Promise<{ count: number }> }>)[model];
      n += (await m.deleteMany({ where })).count;
    };
    const oldOrders = (await this.prisma.order.findMany({ where: old, select: { id: true } })).map((o) => o.id);
    if (oldOrders.length) { await del('orderEvent', { orderId: { in: oldOrders } }); await del('orderItem', { orderId: { in: oldOrders } }); await del('order', { id: { in: oldOrders } }); }
    const oldSo = (await this.prisma.salesOrder.findMany({ where: old, select: { id: true } })).map((o) => o.id);
    if (oldSo.length) {
      await del('payment', { orderId: { in: oldSo } }); await del('invoice', { orderId: { in: oldSo } }); await del('feedback', { orderId: { in: oldSo } });
      await del('salesOrderItem', { orderId: { in: oldSo } }); await del('salesOrder', { id: { in: oldSo } });
    }
    const oldQ = (await this.prisma.quotation.findMany({ where: { ...old, order: null }, select: { id: true } })).map((q) => q.id);
    if (oldQ.length) { await del('quotationItem', { quotationId: { in: oldQ } }); await del('quotation', { id: { in: oldQ } }); }
    await del('inboundMessage', { organizationId: org, id: { startsWith: prefix }, receivedAt: { lt: cutoff } });
    for (const m of ['message', 'call', 'followUp', 'auditEvent', 'reservation', 'appointment', 'workTask', 'qualityInspection', 'siteVisit']) await del(m, old);
    // Threads and leads the feed opened, once nothing refers to them any more. (The synthetic customer pool is bounded.)
    const quiet = { organizationId: org, id: { startsWith: prefix }, updatedAt: { lt: cutoff } };
    await del('conversation', { ...quiet, Message: { none: {} } });
    await del('lead', { ...quiet, calls: { none: {} }, followUps: { none: {} }, SiteVisit: { none: {} }, quotations: { none: {} }, salesOrders: { none: {} }, textileRequirement: null });
    return n;
  }
}
