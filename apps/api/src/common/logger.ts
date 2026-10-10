/**
 * Minimal structured JSON logger. One line per event, easy to grep locally
 * and ready for CloudWatch later. Never pass secrets in fields.
 */
type Fields = Record<string, unknown>;

function write(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => write('info', event, fields),
  warn: (event: string, fields?: Fields) => write('warn', event, fields),
  error: (event: string, fields?: Fields) => write('error', event, fields),
};

/** Measures stages: const t = timer(); ...; t.lap('db'); ...; t.done() */
export function timer() {
  const start = Date.now();
  let last = start;
  const laps: Record<string, number> = {};
  return {
    lap(name: string) {
      const now = Date.now();
      laps[name] = now - last;
      last = now;
    },
    done(): Record<string, number> {
      return { ...laps, totalMs: Date.now() - start };
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
