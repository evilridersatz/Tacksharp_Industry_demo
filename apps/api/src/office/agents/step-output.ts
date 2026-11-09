import { isRole, type Role } from './roles.js';

export const ACTS = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'] as const;
export type Act = (typeof ACTS)[number];
/** Only these oblige the recipient to act / reply (stops ping-pong between agents). */
export const OBLIGING: readonly Act[] = ['request', 'query', 'propose'];

export type OutMessage = { to: Role; act: Act; body: string };
export type StepOutput = { status: 'done' | 'blocked'; summary: string; outcome: Record<string, unknown>; messages: OutMessage[] };

/**
 * Parse an agent's final text. Anything that is not the agreed JSON is treated as "blocked" with the text as summary:
 * the engine never reads a free-text claim as success.
 */
export function parseStepOutput(text: string): { ok: true; value: StepOutput } | { ok: false; reason: string; value: StepOutput } {
  const raw = (text ?? '').trim();
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (m ? m[1] : raw).trim();
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  const fallback = (reason: string) => ({ ok: false as const, reason, value: { status: 'blocked' as const, summary: raw.slice(0, 500) || 'No answer.', outcome: {}, messages: [] } });
  if (s < 0 || e <= s) return fallback('the agent did not answer with JSON');
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(body.slice(s, e + 1)) as Record<string, unknown>;
  } catch {
    return fallback('the agent’s JSON could not be read');
  }
  const status = d.status === 'done' ? 'done' : 'blocked';
  const summary = typeof d.summary === 'string' ? d.summary.trim().slice(0, 2000) : '';
  const outcome = d.outcome && typeof d.outcome === 'object' && !Array.isArray(d.outcome) ? (d.outcome as Record<string, unknown>) : {};
  const messages: OutMessage[] = [];
  if (Array.isArray(d.messages)) {
    for (const x of d.messages.slice(0, 5)) {
      const o = (x ?? {}) as Record<string, unknown>;
      const act = String(o.act ?? 'inform') as Act;
      if (!isRole(o.to) || !(ACTS as readonly string[]).includes(act) || typeof o.body !== 'string' || !o.body.trim()) continue;
      messages.push({ to: o.to, act, body: o.body.trim().slice(0, 2000) });
    }
  }
  if (!summary) return { ok: false, reason: 'the agent gave no summary', value: { status: 'blocked', summary: 'No summary.', outcome, messages } };
  return { ok: true, value: { status, summary, outcome, messages } };
}

/**
 * Numbers in a report that cannot be traced to its sources (snapshot, task results). Small integers (0-9) and
 * years/dates are ignored. Numbers are compared on their digits, so "₹4,920" matches 4920.
 */
export function untracedNumbers(report: string, sources: unknown): string[] {
  const pool = new Set<string>();
  const add = (v: number) => {
    pool.add(String(v));
    pool.add(String(Math.round(v)));
    pool.add(v.toFixed(1));
    pool.add(v.toFixed(2));
  };
  const walk = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) add(v);
    else if (typeof v === 'string') for (const m of v.matchAll(/\d[\d,]*(?:\.\d+)?/g)) { const n = Number(m[0].replace(/,/g, '')); if (Number.isFinite(n)) add(n); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(sources);
  const missing: string[] = [];
  for (const m of report.matchAll(/(?<![\w-])\d[\d,]*(?:\.\d+)?%?/g)) {
    const token = m[0].replace(/%$/, '');
    const n = Number(token.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 10 || (n >= 1900 && n <= 2100 && !token.includes('.'))) continue;
    if (!pool.has(String(n)) && !pool.has(n.toFixed(1)) && !pool.has(n.toFixed(2))) missing.push(m[0]);
  }
  return [...new Set(missing)];
}
