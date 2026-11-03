/**
 * Plans and entitlements (pure). Limits are counts; null = unlimited. Prices are not listed: they are agreed per
 * organization (Subscription.price), as the public pricing page says.
 */
export const RESOURCES = ['users', 'voiceAgents', 'workflows', 'dripSequences', 'mcpKeys'] as const;
export type Resource = (typeof RESOURCES)[number];
export type Limits = Record<Resource, number | null>;

export const PLANS: Record<'pilot' | 'growth' | 'enterprise', { name: string; limits: Limits }> = {
  pilot: { name: 'Pilot', limits: { users: 3, voiceAgents: 1, workflows: 3, dripSequences: 3, mcpKeys: 0 } },
  growth: { name: 'Growth', limits: { users: 15, voiceAgents: 5, workflows: 25, dripSequences: 25, mcpKeys: 3 } },
  enterprise: { name: 'Enterprise', limits: { users: null, voiceAgents: 50, workflows: 200, dripSequences: 200, mcpKeys: 20 } },
};
export type PlanCode = keyof typeof PLANS;
export const PLAN_CODES = Object.keys(PLANS) as PlanCode[];
export const STATUSES = ['trial', 'active', 'past_due', 'cancelled'] as const;
export const CYCLES = { monthly: 1, quarterly: 3, yearly: 12 } as const;
export type Cycle = keyof typeof CYCLES;

export const RESOURCE_LABEL: Record<Resource, string> = { users: 'team members', voiceAgents: 'voice agents', workflows: 'workflows', dripSequences: 'drip sequences', mcpKeys: 'MCP access keys' };

/** The plan's limits with the contract's overrides on top (only known resources; null = unlimited). */
export function effectiveLimits(planCode: string, override: unknown): Limits {
  const base = PLANS[planCode as PlanCode]?.limits ?? PLANS.pilot.limits;
  const o = (override && typeof override === 'object' ? override : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const r of RESOURCES) {
    if (!(r in o)) continue;
    const v = o[r];
    out[r] = v === null ? null : Number.isInteger(v) && (v as number) >= 0 ? (v as number) : out[r];
  }
  return out;
}

export function validateOverride(raw: unknown): { value: Partial<Limits> | null; error?: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { value: null, error: 'Limits must be an object like {"users": 40}.' };
  const out: Partial<Limits> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(RESOURCES as readonly string[]).includes(k)) return { value: null, error: `Unknown limit "${k}". Known: ${RESOURCES.join(', ')}.` };
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100_000)) return { value: null, error: `${k}: a whole number 0-100000, or null for unlimited.` };
    out[k as Resource] = v as number | null;
  }
  return { value: Object.keys(out).length ? out : null };
}

/** End of a billing period that starts at `start` (calendar months; day clamped to the month's last day). */
export function addCycle(start: Date, cycle: Cycle): Date {
  const months = CYCLES[cycle];
  const d = new Date(start.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** Amounts in paise to avoid floating-point drift; tax rounded half up to the paisa. */
export function invoiceAmounts(price: number, taxRatePct: number) {
  const sub = Math.round(price * 100);
  const tax = Math.round((sub * taxRatePct) / 100);
  return { subtotal: sub / 100, tax: tax / 100, total: (sub + tax) / 100 };
}

/** TS-2026-00042 */
export const invoiceNumber = (year: number, seq: number) => `TS-${year}-${String(seq).padStart(5, '0')}`;
