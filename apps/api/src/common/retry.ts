import { errorMessage, log } from './logger.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A write conflict / deadlock (Prisma P2034, MySQL 1213) or lock-wait timeout (1205) means the database
 * rolled the statement or transaction back and nothing was applied. It is safe to repeat THAT operation.
 */
export function isTransientDbError(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string | number }; message?: string } | undefined;
  if (!e) return false;
  if (e.code === 'P2034') return true;
  const mysql = String(e.meta?.code ?? '');
  if (mysql === '1213' || mysql === '1205') return true;
  return /deadlock|write conflict|lock wait timeout/i.test(e.message ?? '');
}

/**
 * Repeat ONE database operation after a transient conflict (3 tries, short jittered back-off). The operation must be
 * atomic or naturally idempotent (a single write, a transaction, "set status to X", "cancel what is still scheduled").
 * Never wrap a sequence that would apply a step twice if only a later step failed (e.g. two inserts in a row).
 */
export async function retryTransient<T>(op: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (attempt >= attempts || !isTransientDbError(error)) throw error;
      log.warn('db.transient_retry', { op: label, attempt, error: errorMessage(error).slice(0, 120) });
      await sleep(20 * 3 ** (attempt - 1) + Math.floor(Math.random() * 20));
    }
  }
}
