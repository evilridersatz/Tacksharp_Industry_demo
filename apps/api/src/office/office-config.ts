/**
 * AI Office settings, stored in OrganizationSettings.data.office (one office per organization). Every value is clamped:
 * a bad or missing value falls back to the default, never to "unlimited".
 */
export const MODES = ['manual', 'supervised', 'autonomous'] as const;
export type OfficeMode = (typeof MODES)[number];

export type PlanBudgets = {
  /** Model fees for one plan (US$). */
  maxUsd: number;
  maxTokens: number;
  /** Model steps (agent turns) across the plan. */
  maxSteps: number;
  maxToolCalls: number;
  /** Minutes from start; open tasks are stopped (paused) after it. */
  deadlineMinutes: number;
};

export type OfficeConfig = {
  mode: OfficeMode;
  /** Organization-wide kill switch: no step, no tool call while true. */
  paused: boolean;
  model: string;
  budgets: PlanBudgets;
  /** All plans together in one India day (US$). */
  maxUsdPerDay: number;
  /** Tasks of this organization running at the same time. */
  concurrency: number;
  /** Messages per conversation before the engine stops it and escalates. */
  hopCap: number;
  /** Delegation depth (a task delegating to an agent that delegates ...). */
  maxDepth: number;
  /** Web research: only these domains (https), empty = web research off. */
  webAllowlist: string[];
  /** Optional: shows rupee estimates next to dollars (₹ per US$, as the owner sets it). 0 = not shown. */
  inrPerUsd: number;
  retentionDays: { messages: number; executions: number; audit: number };
};

export const DEFAULT_OFFICE: OfficeConfig = {
  mode: 'supervised',
  paused: false,
  model: 'gpt-5.4-mini',
  budgets: { maxUsd: 1, maxTokens: 400_000, maxSteps: 60, maxToolCalls: 120, deadlineMinutes: 60 },
  maxUsdPerDay: 5,
  concurrency: 2,
  hopCap: 8,
  maxDepth: 3,
  webAllowlist: [],
  inrPerUsd: 0,
  retentionDays: { messages: 180, executions: 180, audit: 730 },
};

/** Models the office may use (prices in budget.ts). Anything else is refused. */
export const OFFICE_MODELS = ['gpt-5.4-mini', 'gpt-5.4'] as const;

const num = (v: unknown, d: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function sanitizeOffice(input: unknown, base: OfficeConfig = DEFAULT_OFFICE): OfficeConfig {
  const i = obj(input);
  const b = obj(i.budgets);
  const r = obj(i.retentionDays);
  const allow = Array.isArray(i.webAllowlist)
    ? [...new Set(i.webAllowlist.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter((d) => DOMAIN.test(d)))].slice(0, 30)
    : base.webAllowlist;
  return {
    mode: (MODES as readonly string[]).includes(String(i.mode)) ? (i.mode as OfficeMode) : base.mode,
    paused: typeof i.paused === 'boolean' ? i.paused : base.paused,
    model: (OFFICE_MODELS as readonly string[]).includes(String(i.model)) ? String(i.model) : base.model,
    budgets: {
      maxUsd: num(b.maxUsd, base.budgets.maxUsd, 0.01, 50),
      maxTokens: Math.round(num(b.maxTokens, base.budgets.maxTokens, 5_000, 5_000_000)),
      maxSteps: Math.round(num(b.maxSteps, base.budgets.maxSteps, 1, 500)),
      maxToolCalls: Math.round(num(b.maxToolCalls, base.budgets.maxToolCalls, 1, 1000)),
      deadlineMinutes: Math.round(num(b.deadlineMinutes, base.budgets.deadlineMinutes, 5, 24 * 60)),
    },
    maxUsdPerDay: num(i.maxUsdPerDay, base.maxUsdPerDay, 0.05, 500),
    concurrency: Math.round(num(i.concurrency, base.concurrency, 1, 5)),
    hopCap: Math.round(num(i.hopCap, base.hopCap, 2, 20)),
    maxDepth: Math.round(num(i.maxDepth, base.maxDepth, 0, 5)),
    webAllowlist: allow,
    inrPerUsd: num(i.inrPerUsd, base.inrPerUsd, 0, 500),
    retentionDays: {
      messages: Math.round(num(r.messages, base.retentionDays.messages, 7, 3650)),
      executions: Math.round(num(r.executions, base.retentionDays.executions, 7, 3650)),
      audit: Math.round(num(r.audit, base.retentionDays.audit, 90, 3650)),
    },
  };
}
