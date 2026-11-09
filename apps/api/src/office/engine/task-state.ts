/**
 * The office task state machine. Pure: no database. The engine is the only writer of a task's status and every change
 * goes through `assertTransition`, so a model can never move a task (it only proposes; code decides).
 *
 *   blocked ──deps done──▶ queued ──claim──▶ running ──▶ verifying ──▶ completed
 *                                              │  ▲            │
 *                              waiting_tool ◀──┤  │            ├──▶ needs_review (a person decides)
 *                          waiting_approval ◀──┘  │            └──▶ queued (QA sent it back once)
 *                                   (approved)────┘
 *   running ──error──▶ failed ──retry──▶ queued   |   failed ──attempts used up──▶ dead_letter
 *   any active state ──▶ paused / cancelled (a person, a kill switch or a budget breaker)
 */
export const TASK_STATUSES = [
  'blocked',
  'queued',
  'running',
  'waiting_tool',
  'waiting_approval',
  'verifying',
  'needs_review',
  'completed',
  'failed',
  'paused',
  'cancelled',
  'dead_letter',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL: readonly TaskStatus[] = ['completed', 'cancelled', 'dead_letter'];
/** States in which the task is still owed work (a plan is finished only when none of its tasks is in one). */
export const OPEN: readonly TaskStatus[] = ['blocked', 'queued', 'running', 'waiting_tool', 'waiting_approval', 'verifying', 'needs_review', 'failed', 'paused'];

const NEXT: Record<TaskStatus, readonly TaskStatus[]> = {
  blocked: ['queued', 'paused', 'cancelled'],
  queued: ['running', 'paused', 'cancelled', 'blocked'],
  running: ['waiting_tool', 'waiting_approval', 'verifying', 'failed', 'paused', 'cancelled', 'queued', 'needs_review'],
  waiting_tool: ['running', 'queued', 'failed', 'paused', 'cancelled'],
  waiting_approval: ['queued', 'failed', 'paused', 'cancelled'],
  verifying: ['completed', 'needs_review', 'failed', 'queued', 'cancelled'],
  needs_review: ['completed', 'failed', 'queued', 'cancelled'],
  failed: ['queued', 'dead_letter', 'cancelled'],
  paused: ['queued', 'blocked', 'cancelled'],
  completed: [],
  cancelled: [],
  dead_letter: ['queued'], // a person may retry a dead-lettered task by hand
};

export const isStatus = (s: unknown): s is TaskStatus => typeof s === 'string' && (TASK_STATUSES as readonly string[]).includes(s);
export const canTransition = (from: string, to: TaskStatus) => isStatus(from) && NEXT[from].includes(to);

export class TransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`A ${from} task cannot move to ${to}`);
  }
}

export function assertTransition(from: string, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** After a failed attempt: retry later, or dead-letter when the attempts are used up. */
export function afterFailure(attempts: number, maxAttempts: number, permanent: boolean): { status: 'queued' | 'dead_letter'; delayMs: number } {
  if (permanent || attempts >= maxAttempts) return { status: 'dead_letter', delayMs: 0 };
  return { status: 'queued', delayMs: Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000) };
}

/** A blocked task becomes queued when every task it depends on is completed. */
export function readyToQueue(dependencyStatuses: string[]): boolean {
  return dependencyStatuses.every((s) => s === 'completed');
}

/** A plan's status from its tasks' statuses. */
export function planStatusFrom(statuses: string[]): 'running' | 'completed' | 'failed' | 'cancelled' {
  if (!statuses.length) return 'completed';
  if (statuses.every((s) => s === 'cancelled')) return 'cancelled';
  if (statuses.some((s) => (OPEN as readonly string[]).includes(s))) return 'running';
  return statuses.some((s) => s === 'dead_letter') ? 'failed' : 'completed';
}
