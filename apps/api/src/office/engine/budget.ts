/**
 * Model prices and budget checks. Pure: the engine calls these before every model call and after every usage record,
 * so a budget is enforced in code, never only stated in a prompt.
 *
 * Prices are US$ per million tokens (input, cached input, output). Source: a third-party summary (MorphLLM, updated
 * 31 Oct 2026); confirm on OpenAI's own pricing page before using them for billing. An unknown model is priced at the
 * most expensive known model, so a missing row can only overstate cost.
 */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
};

const FALLBACK = PRICES['gpt-5.4'];

export function priceOf(model: string) {
  return PRICES[model] ?? FALLBACK;
}

/** US$ for one model call. Cached input tokens are part of tokensIn and billed at the cached rate. */
export function costUsd(model: string, tokensIn: number, tokensOut: number, cachedIn = 0): number {
  const p = priceOf(model);
  const cached = Math.min(Math.max(0, cachedIn), Math.max(0, tokensIn));
  const usd = ((tokensIn - cached) * p.input + cached * p.cached + Math.max(0, tokensOut) * p.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Planning assumptions (shown with the estimate, replaced by measurements as plans run). */
export const ESTIMATE = { stepsPerTask: 3, tokensInPerStep: 6_000, tokensOutPerStep: 800, plan: { in: 8_000, out: 1_500 }, report: { in: 10_000, out: 1_000 } };

export function estimatePlan(model: string, tasks: number, inrPerUsd = 0) {
  const tokensIn = ESTIMATE.plan.in + ESTIMATE.report.in + tasks * ESTIMATE.stepsPerTask * ESTIMATE.tokensInPerStep;
  const tokensOut = ESTIMATE.plan.out + ESTIMATE.report.out + tasks * ESTIMATE.stepsPerTask * ESTIMATE.tokensOutPerStep;
  const usd = costUsd(model, tokensIn, tokensOut);
  return { model, tasks, tokensIn, tokensOut, usd, inr: inrPerUsd > 0 ? Math.round(usd * inrPerUsd * 100) / 100 : null };
}

export type Spend = { usd: number; tokens: number; steps: number; toolCalls: number };
export type Limits = { maxUsd: number; maxTokens: number; maxSteps: number; maxToolCalls: number };

/**
 * Whether another model step may start. `next` is the expected size of the coming step (from the estimate), so a plan
 * stops before it crosses its budget, not after.
 */
export function budgetCheck(spent: Spend, limits: Limits, next: { usd: number; tokens: number } = { usd: 0, tokens: 0 }): { ok: true } | { ok: false; reason: string } {
  if (spent.usd + next.usd > limits.maxUsd) return { ok: false, reason: `Budget reached: US$${spent.usd.toFixed(4)} of US$${limits.maxUsd} spent` };
  if (spent.tokens + next.tokens > limits.maxTokens) return { ok: false, reason: `Token budget reached: ${spent.tokens} of ${limits.maxTokens}` };
  if (spent.steps + 1 > limits.maxSteps) return { ok: false, reason: `Step budget reached: ${spent.steps} of ${limits.maxSteps}` };
  if (spent.toolCalls >= limits.maxToolCalls) return { ok: false, reason: `Tool-call budget reached: ${spent.toolCalls} of ${limits.maxToolCalls}` };
  return { ok: true };
}

/** The usual size of one step on this model (used as `next` above). */
export function stepAllowance(model: string) {
  return { usd: costUsd(model, ESTIMATE.tokensInPerStep, ESTIMATE.tokensOutPerStep), tokens: ESTIMATE.tokensInPerStep + ESTIMATE.tokensOutPerStep };
}
