/**
 * Circuit breaker per agent (idea from Munder Difflin's breaker ladder, rebuilt for a hosted, multi-tenant engine):
 *   healthy → steering → constrained → stopped
 * One level per beat (one finished execution), up when a signal fires, down by one when an execution is clean.
 *   steering    : the agent's next steps carry a correction note (stop repeating, finish or report blocked)
 *   constrained : only read tools are offered; writes wait
 *   stopped     : the agent is paused (kill switch) and a person is alerted; only a person resumes it
 */
export const LEVELS = ['healthy', 'steering', 'constrained', 'stopped'] as const;
export type BreakerLevel = (typeof LEVELS)[number];

export type BreakerSignals = {
  /** The same tool with the same arguments called again within one task (a loop). */
  repeatedCalls: number;
  /** Failed executions among the agent's recent ones. */
  recentFailures: number;
  /** US$ spent by this agent in the last 10 minutes. */
  usdLast10Min: number;
  /** Steps in the last execution that produced no tool result and no output (no progress). */
  idleSteps: number;
};

export const THRESHOLDS = { repeatedCalls: 2, recentFailures: 3, usdLast10Min: 0.5, idleSteps: 3 };

export function tripped(s: BreakerSignals): string[] {
  const why: string[] = [];
  if (s.repeatedCalls >= THRESHOLDS.repeatedCalls) why.push(`repeated the same tool call ${s.repeatedCalls}×`);
  if (s.recentFailures >= THRESHOLDS.recentFailures) why.push(`${s.recentFailures} recent failures`);
  if (s.usdLast10Min >= THRESHOLDS.usdLast10Min) why.push(`spent US$${s.usdLast10Min.toFixed(2)} in 10 minutes`);
  if (s.idleSteps >= THRESHOLDS.idleSteps) why.push(`${s.idleSteps} steps without progress`);
  return why;
}

export function nextLevel(current: string, s: BreakerSignals): { level: BreakerLevel; reasons: string[]; changed: boolean } {
  const i = Math.max(0, LEVELS.indexOf(current as BreakerLevel));
  if (LEVELS[i] === 'stopped') return { level: 'stopped', reasons: [], changed: false }; // only a person resumes
  const reasons = tripped(s);
  const j = reasons.length ? Math.min(i + 1, LEVELS.length - 1) : Math.max(i - 1, 0);
  return { level: LEVELS[j], reasons, changed: i !== j };
}

export const STEERING_NOTE =
  'Correction from the office engine: you have been repeating yourself or failing. Do not call a tool again with the same arguments. Finish with what you have, or report status "blocked" with what is missing.';
