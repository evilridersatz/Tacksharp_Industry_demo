import { config } from './config.js';

/**
 * Where the periodic work runs (VisionOps monitoring and the live demo feed). On by default wherever the BullMQ
 * workers run (RUN_WORKERS, the previous home of the VisionOps sweep). TACKSHARP_SCHEDULER (or the older
 * VISIONOPS_SCHEDULER) = true / false overrides that, so a staging API with RUN_WORKERS=false can still run it:
 * alerts stay DRY_RUN-gated and demo records are never sent. With several API processes a Redis lock lets one of
 * them run each minute.
 */
export function schedulerEnabled(env = process.env): { on: boolean; reason: string } {
  const name = env.TACKSHARP_SCHEDULER !== undefined ? 'TACKSHARP_SCHEDULER' : 'VISIONOPS_SCHEDULER';
  const v = (env.TACKSHARP_SCHEDULER ?? env.VISIONOPS_SCHEDULER)?.trim().toLowerCase();
  if (v === 'true' || v === 'on' || v === '1') return { on: true, reason: `${name}=true` };
  if (v === 'false' || v === 'off' || v === '0') return { on: false, reason: `${name}=false` };
  if (env.VITEST) return { on: false, reason: 'test run' };
  return config.runWorkers ? { on: true, reason: 'RUN_WORKERS is on' } : { on: false, reason: 'RUN_WORKERS=false and TACKSHARP_SCHEDULER not set' };
}
