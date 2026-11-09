import { createHash } from 'node:crypto';
import type { OfficeMode } from '../office-config.js';

/**
 * The tool contract. Every office tool is a server-side function with a declared input schema, a risk class, a timeout,
 * a rate limit and (for writes) a verifier. There is no shell, no raw SQL and no free network access: an agent can
 * only do what a tool here does, for its own organization, and only when its configuration allows that tool.
 */
export type Risk =
  /** Reads this organization's data. */
  | 'read'
  /** Changes something inside the platform (a staff job, an assignment, a draft, a CRM stage, a memory proposal). */
  | 'internal'
  /** Reaches a customer or binds the business (messages, payments, contracts, bulk sends, employee or security changes). */
  | 'sensitive';

export type JsonSchema = {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean'; description?: string; enum?: readonly string[]; maxLength?: number; minimum?: number; maximum?: number }>;
  required: readonly string[];
  additionalProperties: false;
};

export type ToolContext = {
  organizationId: string;
  taskId: string;
  planId: string | null;
  role: string;
  /** user:<id> of the person who approved this exact call (sensitive tools only). */
  approvedBy?: string;
};

export type ToolOutput = {
  /** What the agent sees (kept small; untrusted text wrapped in <data>). */
  result: unknown;
  /** What the verifier re-checks later against the database. */
  evidence?: Record<string, unknown>;
};

export type Verification = { ok: true; detail: string } | { ok: false; detail: string; retry?: boolean };

export type ToolDef = {
  name: string;
  description: string;
  risk: Risk;
  schema: JsonSchema;
  timeoutMs: number;
  /** Calls per minute per organization. */
  perMinute: number;
  /** Calls of this tool allowed in one task. */
  perTask: number;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutput>;
  /** Checks the evidence against real state. Absent for reads (nothing to verify). */
  verify?(organizationId: string, evidence: Record<string, unknown>): Promise<Verification>;
};

/**
 * Tools that ALWAYS need a person's approval, in every mode. This list cannot be configured away: an agent
 * configuration may only make a tool stricter (approval / denied), never looser.
 */
export const MANDATORY_APPROVAL: readonly string[] = ['send_whatsapp'];

export type PermissionMode = 'auto' | 'approval' | 'denied';

/** The effective policy for one call: the strictest of the mode, the risk, the mandatory list and the configuration. */
export function policyFor(tool: Pick<ToolDef, 'name' | 'risk'>, mode: OfficeMode, configured: PermissionMode | undefined): PermissionMode {
  if (configured === 'denied') return 'denied';
  if (MANDATORY_APPROVAL.includes(tool.name) || tool.risk === 'sensitive') return 'approval';
  if (tool.risk === 'read') return 'auto';
  if (mode === 'manual') return 'approval';
  return configured === 'approval' ? 'approval' : 'auto';
}

/** Validate tool arguments against the declared schema. Unknown keys are refused (no smuggled parameters). */
export function validateArgs(schema: JsonSchema, args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, errors: ['arguments must be an object'] };
  const a = args as Record<string, unknown>;
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  for (const k of Object.keys(a)) if (!(k in schema.properties)) errors.push(`unknown argument "${k}"`);
  for (const [k, p] of Object.entries(schema.properties)) {
    const v = a[k];
    if (v === undefined || v === null || v === '') {
      if (schema.required.includes(k)) errors.push(`"${k}" is required`);
      continue;
    }
    if (p.type === 'string') {
      if (typeof v !== 'string') { errors.push(`"${k}" must be text`); continue; }
      const s = v.trim();
      if (p.maxLength && s.length > p.maxLength) { errors.push(`"${k}" is longer than ${p.maxLength} characters`); continue; }
      if (p.enum && !p.enum.includes(s)) { errors.push(`"${k}" must be one of ${p.enum.join(', ')}`); continue; }
      value[k] = s;
    } else if (p.type === 'number' || p.type === 'integer') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || (p.type === 'integer' && !Number.isInteger(n))) { errors.push(`"${k}" must be a ${p.type}`); continue; }
      if (p.minimum !== undefined && n < p.minimum) { errors.push(`"${k}" must be at least ${p.minimum}`); continue; }
      if (p.maximum !== undefined && n > p.maximum) { errors.push(`"${k}" must be at most ${p.maximum}`); continue; }
      value[k] = n;
    } else if (p.type === 'boolean') {
      if (typeof v !== 'boolean') { errors.push(`"${k}" must be true or false`); continue; }
      value[k] = v;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Stable JSON (sorted keys): the same arguments always give the same key. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** One key per (task, tool, arguments): a retried task gets the stored result instead of repeating the action. */
export const callKey = (taskId: string, tool: string, args: Record<string, unknown>) => createHash('sha256').update(`${taskId}|${tool}|${stable(args)}`).digest('hex');

/** Wrap text that came from customers, emails, documents or the web: information, never instructions. */
export const untrusted = (s: unknown, max = 500) => `<data>${String(s ?? '').replace(/<\/?data>/gi, '').slice(0, max)}</data>`;

/** Per-organization, per-tool calls per minute (one process; the engine also caps calls per task and per plan). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  allow(key: string, perMinute: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }
}

export class ToolTimeout extends Error {}
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ToolTimeout(`${what} took longer than ${ms / 1000} s`)), ms); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}
