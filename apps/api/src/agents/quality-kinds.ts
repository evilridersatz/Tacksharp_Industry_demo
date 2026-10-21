import type { WorkTasksService } from '../governance/work-tasks.service.js';
import type { QualityService } from '../industry/quality.service.js';
import type { TaskKind } from './agent-types.js';

type Deps = { quality: QualityService; workTasks: WorkTasksService };
const obj = (raw: unknown) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const days = (raw: unknown, def: number) => Math.min(365, Math.max(1, Math.round(Number(obj(raw).days)) || def));

/**
 * Manufacturing quality tasks for the Operations agent. They read recorded inspections only (no camera, sensor or CV
 * model is connected) and never change an inspection; alerts become corrective-action tasks for people.
 */
export function buildQualityKinds({ quality, workTasks }: Deps): TaskKind[] {
  const summary: TaskKind<{ days: number }> = {
    kind: 'operations.quality_summary',
    agent: 'operations',
    label: 'Quality summary',
    description: 'Inspections, units inspected, defect and rejection rates, top defect categories and open issues for the period, from recorded inspections.',
    userRunnable: true,
    parse: (raw) => ({ days: days(raw, 30) }),
    async run(ctx, { days: d }) {
      const s = await ctx.tool('quality.read', () => quality.stats(ctx.organizationId, d));
      if (!s.inspections) return { status: 'completed', summary: `No inspections recorded in the last ${d} days`, result: { days: d, inspections: 0 } };
      const top = s.byCategory.slice(0, 3).map((c) => `${c.category} (${c.count})`).join(', ') || 'none recorded';
      const worstLine = [...s.byLine].sort((a, b) => b.rejectionRate - a.rejectionRate)[0];
      return {
        status: 'completed',
        summary: `${s.inspections} inspection(s), ${s.unitsInspected} units: rejection ${s.rejectionRate}%, defect rate ${s.defectRate}%. Top defects: ${top}. ${s.open} open issue(s).`,
        result: {
          days: d, inspections: s.inspections, unitsInspected: s.unitsInspected, unitsRejected: s.unitsRejected, defects: s.defects, defectRate: s.defectRate, rejectionRate: s.rejectionRate,
          topDefects: s.byCategory.slice(0, 5), worstLine: worstLine ?? null, open: s.open, avgResolutionHours: s.avgResolutionHours,
          note: 'From recorded inspections only. Correlation is shown; no root cause is claimed.',
        },
      };
    },
  };

  const alertScan: TaskKind<{ days: number; thresholdPct: number }> = {
    kind: 'operations.quality_alert_scan',
    agent: 'operations',
    label: 'Quality alert scan',
    description: 'Open inspections whose rejection rate is above the threshold get one corrective-action task each (deduplicated per batch).',
    userRunnable: true,
    parse: (raw) => ({ days: days(raw, 14), thresholdPct: Math.min(100, Math.max(0.1, Number(obj(raw).thresholdPct) || 5)) }),
    async run(ctx, { days: d, thresholdPct }) {
      const s = await ctx.tool('quality.read', () => quality.stats(ctx.organizationId, d));
      const flagged = s.rows.filter((r) => r.status === 'open' && r.rejectionRate > thresholdPct);
      let created = 0;
      for (const r of flagged) {
        const t = await ctx.tool('worktask.create', () =>
          workTasks.create(ctx.organizationId, {
            agent: 'operations', kind: 'exception', priority: r.severity === 'critical' || r.rejectionRate > thresholdPct * 3 ? 'high' : 'normal',
            title: `Quality alert: batch ${r.batchCode} (${r.productName}) rejection ${r.rejectionRate}%`,
            detail: `Rejected ${r.rejectedQty} of ${r.inspectedQty}. Defects: ${r.defects.map((x) => `${x.category} ${x.count}`).join(', ') || 'not categorised'}. Record the corrective action on the inspection when done.`,
            entityType: 'quality_inspection', entityId: r.id, dedupeKey: `quality_alert:${r.id}`, createdBy: ctx.actor,
          }),
        );
        if (t.created) created++;
      }
      return { status: 'completed', summary: `${flagged.length} batch(es) above ${thresholdPct}% rejection; ${created} new corrective-action task(s)`, result: { thresholdPct, flagged: flagged.map((r) => ({ id: r.id, batchCode: r.batchCode, rejectionRate: r.rejectionRate })), created } };
    },
  };

  return [summary, alertScan] as unknown as TaskKind[];
}
