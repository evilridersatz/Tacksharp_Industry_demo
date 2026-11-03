import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OutreachService } from '../automation/outreach.service.js';
import { runInProviderScope } from '../integrations/provider-scope.js';
import { customerLockKey, withLock } from '../common/redis-lock.js';
import { queueRedis } from '../queues/queues.js';
import { config } from '../common/config.js';
import { describeError } from '../common/errors.js';
import { log } from '../common/logger.js';
import { dueAt, presetFor, validateHours, validateSteps, variantFor, type DripStep } from './drip-plan.js';
import { assertPlanAllows } from '../billing/entitlements.js';

type Actor = { sub: string; org: string };
const RETRY_MINUTES = [5, 15, 60];
const MAX_ENROL = 1000;
/** A claimed enrolment is leased for this long: a crash mid-step lets another tick pick it up later, never twice at once. */
const LEASE_MS = 10 * 60_000;

/**
 * Drip automation for every industry. A sequence is a list of WhatsApp / AI-call steps at day offsets from enrolment.
 * Each due step re-checks the customer first and stops the enrolment on opt-out, do-not-contact, conversion (CRM stage
 * converted, a lead won or an order placed after enrolment), human ownership (team inbox took over) or, when the
 * sequence says so, a reply. Steps run only inside the sequence's IST hours; one step run per (enrolment, step) is
 * recorded before sending so a retry or a second worker never sends twice. Every send goes through the live gate
 * (DRY_RUN / approved test numbers / demo customers): otherwise the step is recorded as simulated and nothing is sent.
 */
@Injectable()
export class DripService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outreach: OutreachService,
  ) {}

  // ----------------------------------------------------------------------------------------------- sequences
  async presets(org: string) {
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { vertical: true } });
    return presetFor(o?.vertical);
  }

  async list(org: string) {
    const [rows, counts] = await Promise.all([
      this.prisma.dripSequence.findMany({ where: { organizationId: org }, orderBy: { createdAt: 'desc' } }),
      this.prisma.dripEnrollment.groupBy({ by: ['sequenceId', 'status'], where: { organizationId: org }, _count: { _all: true } }),
    ]);
    return rows.map((s) => ({ ...s, counts: countsFor(counts.filter((c) => c.sequenceId === s.id)) }));
  }

  async detail(org: string, id: string) {
    const s = await this.find(org, id);
    const [enrollments, counts, runs] = await Promise.all([
      this.prisma.dripEnrollment.findMany({
        where: { sequenceId: s.id },
        orderBy: { enrolledAt: 'desc' },
        take: 200,
        include: { customer: { select: { id: true, name: true, phone: true } }, runs: { orderBy: { stepIndex: 'asc' } } },
      }),
      this.prisma.dripEnrollment.groupBy({ by: ['sequenceId', 'status'], where: { sequenceId: s.id }, _count: { _all: true } }),
      this.prisma.dripStepRun.groupBy({ by: ['stepIndex', 'status'], where: { enrollment: { sequenceId: s.id } }, _count: { _all: true } }),
    ]);
    const steps = s.steps as unknown as DripStep[];
    return {
      ...s,
      counts: countsFor(counts),
      stepStats: steps.map((_, i) => Object.fromEntries(runs.filter((r) => r.stepIndex === i).map((r) => [r.status, r._count._all]))),
      variantStats: await this.variantStats(s.id, steps),
      enrollments: enrollments.map((e) => ({
        id: e.id, status: e.status, stepIndex: e.stepIndex, nextRunAt: e.nextRunAt, stopReason: e.stopReason, lastError: e.lastError,
        enrolledAt: e.enrolledAt, completedAt: e.completedAt,
        customer: { id: e.customer.id, name: e.customer.name, phone: e.customer.phone ? `••••${e.customer.phone.slice(-4)}` : null },
        runs: e.runs.map((r) => ({ stepIndex: r.stepIndex, channel: r.channel, status: r.status, reason: r.reason, at: r.updatedAt })),
      })),
    };
  }

  async create(actor: Actor, body: Record<string, unknown>) {
    const data = this.validate(body, true);
    await assertPlanAllows(this.prisma, actor.org, 'dripSequences');
    try {
      const s = await this.prisma.dripSequence.create({ data: { organizationId: actor.org, createdBy: actor.sub, status: 'draft', ...(data as Required<typeof data>) } });
      await this.audit(actor, s.id, 'drip.created', { name: s.name, steps: (s.steps as unknown[]).length });
      return s;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ message: 'A sequence with this name already exists', errors: { name: 'Name already used' } });
      throw e;
    }
  }

  async update(actor: Actor, id: string, body: Record<string, unknown>) {
    const s = await this.find(actor.org, id);
    const data = this.validate(body, false);
    try {
      const updated = await this.prisma.dripSequence.update({ where: { id: s.id }, data });
      await this.audit(actor, s.id, 'drip.updated', { fields: Object.keys(data) });
      // A changed step list or hours re-times the pending step of every running enrolment.
      if (data.steps || data.sendStartHour !== undefined) await this.retime(updated);
      return updated;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ message: 'A sequence with this name already exists', errors: { name: 'Name already used' } });
      throw e;
    }
  }

  async setStatus(actor: Actor, id: string, status: 'active' | 'paused') {
    const s = await this.find(actor.org, id);
    if (s.status === status) return s;
    const updated = await this.prisma.dripSequence.update({ where: { id: s.id }, data: { status } });
    await this.audit(actor, s.id, status === 'active' ? 'drip.activated' : 'drip.paused', {});
    return updated;
  }

  // ----------------------------------------------------------------------------------------------- enrolment
  /** Enrol customers by id list, CRM stage or tag. Opted-out / do-not-contact customers, customers already in this
   *  sequence and customers running another sequence are skipped (one drip at a time per customer). */
  async enroll(actor: Actor, id: string, body: { customerIds?: unknown; stage?: unknown; tag?: unknown }) {
    const s = await this.find(actor.org, id);
    const where: Prisma.CustomerWhereInput = { organizationId: actor.org };
    if (Array.isArray(body.customerIds) && body.customerIds.length) where.id = { in: body.customerIds.filter((x): x is string => typeof x === 'string').slice(0, MAX_ENROL) };
    else if (typeof body.stage === 'string' && body.stage) where.stage = body.stage === 'new' ? null : body.stage;
    else if (typeof body.tag === 'string' && body.tag) where.tags = { array_contains: [body.tag] };
    else throw new BadRequestException({ message: 'Choose customers, a stage or a tag', errors: { audience: 'Choose customers, a stage or a tag' } });

    const customers = await this.prisma.customer.findMany({ where, select: { id: true, phone: true, optedOutAt: true, doNotContact: true }, take: MAX_ENROL });
    const active = new Set(
      (await this.prisma.dripEnrollment.findMany({ where: { organizationId: actor.org, customerId: { in: customers.map((c) => c.id) }, OR: [{ status: 'active' }, { sequenceId: s.id }] }, select: { customerId: true } })).map((e) => e.customerId),
    );
    const skipped = { opted_out: 0, no_phone: 0, already_enrolled: 0 };
    const ok: string[] = [];
    for (const c of customers) {
      if (c.optedOutAt || c.doNotContact) skipped.opted_out++;
      else if (!c.phone) skipped.no_phone++;
      else if (active.has(c.id)) skipped.already_enrolled++;
      else ok.push(c.id);
    }
    const steps = s.steps as unknown as DripStep[];
    const now = new Date();
    const first = dueAt(now, steps[0], hoursOf(s), config.followUp.timeScale, now);
    const r = ok.length
      ? await this.prisma.dripEnrollment.createMany({
          data: ok.map((customerId) => ({ organizationId: actor.org, sequenceId: s.id, customerId, enrolledBy: actor.sub, enrolledAt: now, nextRunAt: first })),
          skipDuplicates: true,
        })
      : { count: 0 };
    skipped.already_enrolled += ok.length - r.count;
    await this.audit(actor, s.id, 'drip.enrolled', { enrolled: r.count, skipped });
    return { enrolled: r.count, matched: customers.length, skipped, startsAt: first, sequenceActive: s.status === 'active' };
  }

  async stopEnrollment(actor: Actor, enrollmentId: string) {
    const e = await this.prisma.dripEnrollment.findFirst({ where: { id: enrollmentId, organizationId: actor.org } });
    if (!e) throw new NotFoundException('Enrolment not found');
    if (e.status !== 'active') return e;
    const r = await this.prisma.dripEnrollment.update({ where: { id: e.id }, data: { status: 'stopped', stopReason: 'stopped_by_user', nextRunAt: null } });
    await this.audit(actor, e.sequenceId, 'drip.enrolment_stopped', { enrollmentId: e.id });
    return r;
  }

  /** Customer page: the drips this customer is in. */
  forCustomer(org: string, customerId: string) {
    return this.prisma.dripEnrollment.findMany({
      where: { organizationId: org, customerId },
      orderBy: { enrolledAt: 'desc' },
      include: { sequence: { select: { id: true, name: true, status: true } } },
    });
  }

  // ----------------------------------------------------------------------------------------------- execution
  /** Runs every due step (called each minute by the worker). Returns what happened per enrolment. */
  async runDue(limit = 50, now = new Date()) {
    const due = await this.prisma.dripEnrollment.findMany({
      where: { status: 'active', nextRunAt: { lte: now }, sequence: { status: 'active' } },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
      select: { id: true, organizationId: true, customerId: true },
    });
    const out: Array<{ id: string; result: string }> = [];
    for (const d of due) {
      try {
        const result = await runInProviderScope(d.organizationId, () =>
          withLock(queueRedis, customerLockKey(d.customerId), () => this.runOne(d.id, now), { ttlMs: 60_000, waitMs: 30_000 }),
        );
        out.push({ id: d.id, result });
      } catch (e) {
        log.warn('drip.run_failed', { enrollmentId: d.id, error: describeError(e) });
        out.push({ id: d.id, result: `error:${describeError(e)}` });
      }
    }
    return out;
  }

  async runOne(enrollmentId: string, now = new Date()): Promise<string> {
    const e = await this.prisma.dripEnrollment.findUnique({ where: { id: enrollmentId }, include: { sequence: true } });
    if (!e || e.status !== 'active' || !e.nextRunAt || e.nextRunAt > now) return 'not_due';
    if (e.sequence.status !== 'active') return 'sequence_not_active';
    // Lease: only one worker gets past this line for this enrolment.
    const claimed = await this.prisma.dripEnrollment.updateMany({
      where: { id: e.id, status: 'active', updatedAt: e.updatedAt },
      data: { nextRunAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count === 0) return 'already_claimed';

    const stop = await this.stopReason(e, e.sequence);
    if (stop) {
      await this.prisma.dripEnrollment.update({ where: { id: e.id }, data: { status: 'stopped', stopReason: stop, nextRunAt: null } });
      log.info('drip.stopped', { enrollmentId: e.id, reason: stop });
      return `stopped:${stop}`;
    }

    const steps = e.sequence.steps as unknown as DripStep[];
    const step = steps[e.stepIndex];
    if (!step) return this.finish(e.id);
    const hours = hoursOf(e.sequence);
    const inHours = dueAt(now, { ...step, day: 0 }, hours, 1, now);
    if (inHours.getTime() > now.getTime()) {
      await this.prisma.dripEnrollment.update({ where: { id: e.id }, data: { nextRunAt: inHours } });
      return 'outside_hours';
    }

    // One run row per (enrolment, step): created before sending, so a retry never sends the same step twice.
    const prior = await this.prisma.dripStepRun.findUnique({ where: { enrollmentId_stepIndex: { enrollmentId: e.id, stepIndex: e.stepIndex } } });
    if (prior && prior.status !== 'processing') return this.advance(e, steps, now, `already_${prior.status}`);
    if (prior) {
      // A previous attempt stopped mid-send: delivery unknown, so it is NOT repeated.
      await this.prisma.dripStepRun.update({ where: { id: prior.id }, data: { status: 'failed', reason: 'Interrupted while sending: delivery unknown, not repeated' } });
      return this.advance(e, steps, now, 'interrupted');
    }
    let run;
    try {
      run = await this.prisma.dripStepRun.create({ data: { organizationId: e.organizationId, enrollmentId: e.id, stepIndex: e.stepIndex, channel: step.channel, status: 'processing' } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'already_running';
      throw err;
    }

    const variant = step.channel === 'whatsapp' && step.textB ? variantFor(e.id, e.stepIndex) : null;
    if (variant) await this.prisma.dripStepRun.update({ where: { id: run.id }, data: { variant } });
    const outcome = step.channel === 'voice' ? await this.runVoice(e, step) : await this.runWhatsApp(e, variant === 'B' ? { ...step, text: step.textB } : step);
    if (outcome.retryAt) {
      // Temporary: the run row goes so the step can run again later (nothing was sent).
      await this.prisma.dripStepRun.delete({ where: { id: run.id } });
      const attempts = e.attempts + 1;
      if (outcome.countsAsAttempt && attempts > RETRY_MINUTES.length) {
        await this.prisma.dripStepRun.create({ data: { organizationId: e.organizationId, enrollmentId: e.id, stepIndex: e.stepIndex, channel: step.channel, variant, status: 'failed', reason: `Gave up after ${attempts} attempts: ${outcome.reason}`.slice(0, 500) } });
        return this.advance(e, steps, now, "failed");
      }
      await this.prisma.dripEnrollment.update({
        where: { id: e.id },
        data: { nextRunAt: outcome.retryAt, lastError: outcome.reason.slice(0, 500), ...(outcome.countsAsAttempt ? { attempts } : {}) },
      });
      return `retry:${outcome.reason}`;
    }
    await this.prisma.dripStepRun.update({ where: { id: run.id }, data: { status: outcome.status, reason: outcome.reason?.slice(0, 500) ?? null, providerMessageId: outcome.messageId ?? null } });
    log.info('drip.step', { enrollmentId: e.id, step: e.stepIndex, channel: step.channel, status: outcome.status, reason: outcome.reason });
    return this.advance(e, steps, now, outcome.status);
  }

  private async stopReason(
    e: { organizationId: string; customerId: string; enrolledAt: Date },
    s: { stopOnReply: boolean },
  ): Promise<string | null> {
    const c = await this.prisma.customer.findFirst({ where: { id: e.customerId, organizationId: e.organizationId } });
    if (!c) return 'customer_missing';
    if (c.optedOutAt) return 'opted_out';
    if (c.doNotContact) return 'do_not_contact';
    if (c.stage === 'converted') return 'converted';
    if (c.stage === 'lost') return 'lost';
    const [won, ordered, human] = await Promise.all([
      this.prisma.lead.count({ where: { customerId: c.id, status: 'won' } }),
      this.prisma.order.count({ where: { customerId: c.id, createdAt: { gt: e.enrolledAt } } }),
      this.prisma.conversation.count({ where: { organizationId: e.organizationId, customerId: c.id, aiEnabled: false, inboxStatus: { not: 'resolved' } } }),
    ]);
    if (won) return 'converted';
    if (ordered) return 'ordered';
    if (human) return 'human_owner';
    if (s.stopOnReply && c.lastInboundAt && c.lastInboundAt > e.enrolledAt) return 'customer_replied';
    return null;
  }

  private async runWhatsApp(e: { id: string; organizationId: string; customerId: string; sequenceId: string; stepIndex: number; attempts: number }, step: DripStep): Promise<Outcome> {
    const r = await this.outreach.whatsApp(e.organizationId, e.customerId, step, { drip: { sequenceId: e.sequenceId, enrollmentId: e.id, step: e.stepIndex } });
    if (r.retryable) return { retryAt: new Date(Date.now() + RETRY_MINUTES[Math.min(RETRY_MINUTES.length - 1, e.attempts)] * 60_000), reason: r.reason, countsAsAttempt: true };
    return r;
  }

  private async runVoice(e: { id: string; organizationId: string; customerId: string; stepIndex: number }, _step: DripStep): Promise<Outcome> {
    const r = await this.outreach.call(e.organizationId, e.customerId, 'drip', `${e.id}-${e.stepIndex}`);
    if (r.retryable) return { retryAt: r.retryAt ?? new Date(Date.now() + 15 * 60_000), reason: r.reason, countsAsAttempt: false };
    return r;
  }

  private async advance(e: { id: string; stepIndex: number; enrolledAt: Date; sequence: { sendStartHour: number; sendEndHour: number } }, steps: DripStep[], now: Date, result: string) {
    const next = e.stepIndex + 1;
    if (next >= steps.length) return this.finish(e.id, result);
    await this.prisma.dripEnrollment.update({
      where: { id: e.id },
      data: { stepIndex: next, attempts: 0, lastError: null, nextRunAt: dueAt(e.enrolledAt, steps[next], hoursOf(e.sequence), config.followUp.timeScale, now) },
    });
    return result;
  }

  private async finish(id: string, result = 'completed') {
    await this.prisma.dripEnrollment.update({ where: { id }, data: { status: 'completed', completedAt: new Date(), nextRunAt: null } });
    return result === 'completed' ? result : `${result};completed`;
  }

  /** Steps or hours changed: every running enrolment's next step is re-timed from its own enrolment date. */
  private async retime(s: { id: string; steps: Prisma.JsonValue; sendStartHour: number; sendEndHour: number }) {
    const steps = s.steps as unknown as DripStep[];
    const rows = await this.prisma.dripEnrollment.findMany({ where: { sequenceId: s.id, status: 'active' } });
    const now = new Date();
    for (const r of rows) {
      const step = steps[r.stepIndex];
      await this.prisma.dripEnrollment.update({
        where: { id: r.id },
        data: step ? { nextRunAt: dueAt(r.enrolledAt, step, hoursOf(s), config.followUp.timeScale, now) } : { status: 'completed', completedAt: now, nextRunAt: null },
      });
    }
  }

  /**
   * A/B results per step with a variant B: runs per variant (sent / simulated / skipped / failed) and responses, i.e.
   * enrolments that replied, converted or ordered while that step was their latest message (attributed to its variant).
   */
  private async variantStats(sequenceId: string, steps: DripStep[]) {
    const abSteps = steps.map((s, i) => (s.textB ? i : -1)).filter((i) => i >= 0);
    if (!abSteps.length) return [];
    const runs = await this.prisma.dripStepRun.findMany({
      where: { enrollment: { sequenceId }, stepIndex: { in: abSteps }, variant: { not: null } },
      select: { enrollmentId: true, stepIndex: true, variant: true, status: true },
    });
    const ended = await this.prisma.dripEnrollment.findMany({ where: { sequenceId, stopReason: { in: ['customer_replied', 'converted', 'ordered'] } }, select: { id: true, runs: { select: { stepIndex: true }, orderBy: { stepIndex: 'desc' }, take: 1 } } });
    const lastStep = new Map(ended.map((e) => [e.id, e.runs[0]?.stepIndex ?? -1]));
    return abSteps.map((stepIndex) => {
      const per = { A: { runs: 0, delivered: 0, responded: 0 }, B: { runs: 0, delivered: 0, responded: 0 } };
      for (const r of runs.filter((x) => x.stepIndex === stepIndex)) {
        const v = per[r.variant as 'A' | 'B'];
        if (!v) continue;
        v.runs++;
        if (r.status === 'sent' || r.status === 'simulated') v.delivered++;
        if (lastStep.get(r.enrollmentId) === stepIndex) v.responded++;
      }
      return { stepIndex, A: per.A, B: per.B };
    });
  }

  // ----------------------------------------------------------------------------------------------- helpers
  private async find(org: string, id: string) {
    const s = await this.prisma.dripSequence.findFirst({ where: { id, organizationId: org } });
    if (!s) throw new NotFoundException('Sequence not found');
    return s;
  }

  private validate(body: Record<string, unknown>, creating: boolean) {
    const errors: Record<string, string> = {};
    const data: { name?: string; description?: string | null; steps?: Prisma.InputJsonValue; stopOnReply?: boolean; sendStartHour?: number; sendEndHour?: number } = {};
    if (creating || body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 120) errors.name = 'Name is required (up to 120 characters)';
      else data.name = name;
    }
    if (body.description !== undefined) data.description = typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 500) : null;
    if (creating || body.steps !== undefined) {
      const v = validateSteps(body.steps);
      Object.assign(errors, v.errors);
      data.steps = v.steps as unknown as Prisma.InputJsonValue;
    }
    if (body.stopOnReply !== undefined) data.stopOnReply = body.stopOnReply !== false;
    if (creating || body.sendStartHour !== undefined || body.sendEndHour !== undefined) {
      const h = validateHours(body.sendStartHour, body.sendEndHour);
      if (!h) errors.hours = 'Sending hours: start 0-23, end 1-24, end after start';
      else { data.sendStartHour = h.start; data.sendEndHour = h.end; }
    }
    if (Object.keys(errors).length) throw new BadRequestException({ message: 'Please fix the highlighted fields', errors });
    return data;
  }

  private audit(actor: Actor, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent
      .create({ data: { organizationId: actor.org, actor: `user:${actor.sub}`, entityType: 'drip_sequence', entityId, action, data: data as Prisma.InputJsonValue } })
      .catch(() => undefined);
  }
}

type Outcome =
  | { status: 'sent' | 'simulated' | 'skipped' | 'failed'; reason?: string; messageId?: string; retryAt?: undefined }
  | { retryAt: Date; reason: string; countsAsAttempt: boolean; status?: undefined };

function hoursOf(s: { sendStartHour: number; sendEndHour: number }) {
  return { start: s.sendStartHour, end: s.sendEndHour };
}

function countsFor(rows: Array<{ status: string; _count: { _all: number } }>) {
  const c = { active: 0, completed: 0, stopped: 0 };
  for (const r of rows) if (r.status in c) c[r.status as keyof typeof c] += r._count._all;
  return c;
}
