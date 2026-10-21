import type { RunContext } from '@openai/agents';
import type { TacksharpAgentContext } from '../types.js';

export function ctx(
  runContext: RunContext<TacksharpAgentContext> | undefined,
): TacksharpAgentContext {
  if (!runContext?.context) {
    throw new Error('Missing Tacksharp agent context');
  }
  return runContext.context;
}

/** Tool errors are returned to the model as data so it can recover instead of crashing the turn. */
export async function safe<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
