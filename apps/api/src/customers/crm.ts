/**
 * CRM helpers shared by the customers API: stages, custom attributes, a transparent lead score and safe CSV export.
 * The score is computed from facts in the database (never a model's guess) and always comes with its reasons.
 */
export const STAGES = ['interested', 'qualified', 'converted', 'lost'] as const;
export type Stage = (typeof STAGES)[number];
const KEY = /^[a-z][a-z0-9_]{0,29}$/;

export function validateAttributes(v: unknown): { ok: true; value: Record<string, string | number | boolean> | null } | { ok: false; error: string } {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'Attributes must be an object of name: value.' };
  const out: Record<string, string | number | boolean> = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 20) return { ok: false, error: 'At most 20 attributes.' };
  for (const [k, val] of entries) {
    if (!KEY.test(k)) return { ok: false, error: `Attribute name "${k.slice(0, 30)}": lowercase letters, digits and _ (starting with a letter).` };
    if (typeof val === 'string') out[k] = val.trim().slice(0, 200);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean') out[k] = val;
    else return { ok: false, error: `Attribute "${k}": text, number or true/false.` };
  }
  return { ok: true, value: out };
}

export type ScoreInput = {
  stage: string | null; optedOutAt: Date | null; doNotContact: boolean; messagingConsent: boolean; callingConsent: boolean;
  lastInboundAt: Date | null; email: string | null; orders?: number; leadStatus?: string | null;
};

/** 0..100 with the reasons that produced it. Opted-out / do-not-contact / lost customers score 0. */
export function leadScore(c: ScoreInput, now = Date.now()): { score: number; reasons: string[] } {
  if (c.optedOutAt || c.doNotContact) return { score: 0, reasons: ['Opted out / do not contact'] };
  if (c.stage === 'lost') return { score: 0, reasons: ['Marked lost'] };
  const parts: Array<[number, string]> = [];
  if (c.stage === 'converted') parts.push([40, 'Converted']);
  else if (c.stage === 'qualified') parts.push([30, 'Qualified']);
  else if (c.stage === 'interested') parts.push([15, 'Interested']);
  if (c.lastInboundAt) {
    const days = (now - c.lastInboundAt.getTime()) / 86_400_000;
    if (days <= 1) parts.push([25, 'Wrote in the last day']);
    else if (days <= 7) parts.push([15, 'Wrote this week']);
    else if (days <= 30) parts.push([5, 'Wrote this month']);
  }
  if (c.orders) parts.push([Math.min(20, c.orders * 5), `${c.orders} order${c.orders > 1 ? 's' : ''}`]);
  if (c.messagingConsent) parts.push([5, 'WhatsApp consent']);
  if (c.callingConsent) parts.push([5, 'Calling consent']);
  if (c.email) parts.push([3, 'Email known']);
  if (c.leadStatus && ['site_visit', 'negotiation', 'won', 'qualified'].includes(c.leadStatus)) parts.push([10, `Lead: ${c.leadStatus.replace(/_/g, ' ')}`]);
  return { score: Math.min(100, parts.reduce((s, [n]) => s + n, 0)), reasons: parts.map(([, r]) => r) };
}

/** One CSV cell: quoted, and formula-injection safe (cells starting with = + - @ are prefixed with '). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
