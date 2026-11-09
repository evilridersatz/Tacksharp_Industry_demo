import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { errorMessage, log } from '../../common/logger.js';
import { istClock } from '../../jarvis/jarvis-config.js';
import { OfficeEngine } from '../engine/office-engine.service.js';
import { OfficeSetupService } from '../office-setup.service.js';
import { BUSINESS_EVENTS, eventName } from '../events/business-events.js';
import { untrusted } from '../tools/contract.js';

const SCHEDULE = /^daily@([01]\d|2[0-3]):([0-5]\d)$/;
/** Event-driven plans per organization per hour: a burst of orders must not become a burst of AI spend. */
const EVENT_PLANS_PER_HOUR = 12;

export const WORKFLOW_TEMPLATES = [
  { name: 'Morning operations review', triggerType: 'schedule', trigger: 'daily@08:30', instruction: 'Manage today’s operations: check pending orders and low stock and create staff jobs for real problems, make sure every customer waiting for staff is assigned, and prepare my daily executive report.' },
  { name: 'Evening follow-ups', triggerType: 'schedule', trigger: 'daily@18:00', instruction: 'Find customers who wrote today without ordering, draft a short polite WhatsApp follow-up for each one that can be messaged now, request sending for my approval, and report what was prepared.' },
  { name: 'Big order check', triggerType: 'event', trigger: 'order.created.v1', instruction: 'A new order arrived. If it is unusually large or still pending, create a staff job to confirm it with the customer; otherwise do nothing and report that.' },
] as const;

/**
 * Standing instructions for the office: run by a versioned business event or a daily schedule (India time). Each
 * trigger runs at most once (unique workflow + trigger key), and every run goes through the same planner, budgets and
 * approvals as an owner's instruction.
 */
@Injectable()
export class OfficeWorkflowsService {
  constructor(private readonly prisma: PrismaService, private readonly engine: OfficeEngine, private readonly setup: OfficeSetupService) {}

  list(organizationId: string) {
    return this.prisma.officeWorkflow.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' }, include: { runs: { orderBy: { createdAt: 'desc' }, take: 5 } } });
  }

  catalog() {
    return { events: Object.entries(BUSINESS_EVENTS).map(([type, label]) => ({ type, label })), templates: WORKFLOW_TEMPLATES };
  }

  private clean(body: Record<string, unknown>) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    const triggerType = body.triggerType === 'event' ? 'event' : body.triggerType === 'schedule' ? 'schedule' : '';
    const trigger = typeof body.trigger === 'string' ? body.trigger.trim() : '';
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 4000) : '';
    const mode = ['manual', 'supervised', 'autonomous'].includes(String(body.mode)) ? String(body.mode) : 'supervised';
    if (!name) throw new BadRequestException('Give the workflow a name');
    if (!triggerType) throw new BadRequestException('triggerType must be "event" or "schedule"');
    if (triggerType === 'event' && !(trigger in BUSINESS_EVENTS)) throw new BadRequestException(`Event must be one of ${Object.keys(BUSINESS_EVENTS).join(', ')}`);
    if (triggerType === 'schedule' && !SCHEDULE.test(trigger)) throw new BadRequestException('Schedule must look like daily@08:30 (India time)');
    if (instruction.length < 5) throw new BadRequestException('Write the instruction the office should follow');
    return { name, triggerType, trigger, instruction, mode };
  }

  async create(organizationId: string, body: Record<string, unknown>, actor: string) {
    const d = this.clean(body);
    const wf = await this.prisma.officeWorkflow.create({ data: { organizationId, ...d, createdBy: actor.slice(0, 191) } });
    await this.setup.audit(organizationId, actor, 'workflow.created', `workflow:${wf.id}`, d);
    return wf;
  }

  async update(organizationId: string, id: string, body: Record<string, unknown>, actor: string) {
    const wf = await this.prisma.officeWorkflow.findFirst({ where: { id, organizationId } });
    if (!wf) throw new NotFoundException('Workflow not found');
    const data: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (['name', 'trigger', 'triggerType', 'instruction', 'mode'].some((k) => body[k] !== undefined)) Object.assign(data, this.clean({ ...wf, ...body }));
    const next = await this.prisma.officeWorkflow.update({ where: { id }, data });
    await this.setup.audit(organizationId, actor, 'workflow.updated', `workflow:${id}`, data);
    return next;
  }

  async remove(organizationId: string, id: string, actor: string) {
    const r = await this.prisma.officeWorkflow.deleteMany({ where: { id, organizationId } });
    if (!r.count) throw new NotFoundException('Workflow not found');
    await this.setup.audit(organizationId, actor, 'workflow.deleted', `workflow:${id}`, {});
    return { ok: true };
  }

  /** Run a workflow now (button), once per minute at most. */
  async runNow(organizationId: string, id: string, actor: string) {
    const wf = await this.prisma.officeWorkflow.findFirst({ where: { id, organizationId } });
    if (!wf) throw new NotFoundException('Workflow not found');
    return this.start(wf, `manual:${new Date().toISOString().slice(0, 16)}`, wf.instruction, actor);
  }

  /** Every minute (one process, Redis lock): consume new events and run due schedules. */
  async tick(now = new Date()) {
    let started = 0;
    const events = await this.prisma.officeEvent.findMany({ where: { consumedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
    for (const e of events) {
      await this.prisma.officeEvent.update({ where: { id: e.id }, data: { consumedAt: now } });
      const flows = await this.prisma.officeWorkflow.findMany({ where: { organizationId: e.organizationId, triggerType: 'event', trigger: eventName(e.type, e.version), enabled: true } });
      for (const wf of flows) {
        const recent = await this.prisma.officeWorkflowRun.count({ where: { organizationId: e.organizationId, createdAt: { gte: new Date(now.getTime() - 3_600_000) }, workflow: { triggerType: 'event' }, status: 'started' } });
        if (recent >= EVENT_PLANS_PER_HOUR) {
          await this.prisma.officeWorkflowRun.create({ data: { organizationId: e.organizationId, workflowId: wf.id, triggerKey: e.id, status: 'skipped', note: `More than ${EVENT_PLANS_PER_HOUR} event plans this hour` } }).catch(() => undefined);
          continue;
        }
        const instruction = `${wf.instruction}\n\nEvent ${eventName(e.type, e.version)}: ${untrusted(JSON.stringify(e.payload), 800)}`;
        if (await this.start(wf, e.id, instruction, `workflow:${wf.id}`)) started++;
      }
    }
    const clock = istClock(now);
    const schedules = await this.prisma.officeWorkflow.findMany({ where: { triggerType: 'schedule', enabled: true } });
    for (const wf of schedules) {
      const m = wf.trigger.match(SCHEDULE);
      if (!m) continue;
      if (clock.hour * 60 + clock.minute < Number(m[1]) * 60 + Number(m[2])) continue;
      if (await this.start(wf, `schedule:${clock.date}`, wf.instruction, `workflow:${wf.id}`)) started++;
    }
    return { events: events.length, started };
  }

  /** One run per trigger key (unique): claim the run row first, then plan. */
  private async start(wf: { id: string; organizationId: string; mode: string; name: string }, triggerKey: string, instruction: string, actor: string) {
    let run;
    try {
      run = await this.prisma.officeWorkflowRun.create({ data: { organizationId: wf.organizationId, workflowId: wf.id, triggerKey: triggerKey.slice(0, 191), status: 'started' } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null; // this trigger already ran
      throw e;
    }
    try {
      const plan = await this.engine.createPlan(wf.organizationId, actor, { instruction, idempotencyKey: `wf:${wf.id}:${triggerKey}`, source: 'workflow', workflowRunId: run.id, mode: wf.mode });
      await this.prisma.officeWorkflowRun.update({ where: { id: run.id }, data: { planId: plan.id, note: `Plan ${plan.status}` } });
      await this.prisma.officeWorkflow.update({ where: { id: wf.id }, data: { lastRunAt: new Date() } });
      log.info('office.workflow_run', { organizationId: wf.organizationId, workflowId: wf.id, planId: plan.id, status: plan.status });
      return plan;
    } catch (e) {
      await this.prisma.officeWorkflowRun.update({ where: { id: run.id }, data: { status: 'failed', note: errorMessage(e).slice(0, 500) } });
      log.warn('office.workflow_failed', { organizationId: wf.organizationId, workflowId: wf.id, error: errorMessage(e) });
      return null;
    }
  }
}
