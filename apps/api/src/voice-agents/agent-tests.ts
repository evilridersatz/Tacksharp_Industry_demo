/**
 * Advanced agent builder: saved test cases and published versions (pure helpers).
 *
 * A test case is a scripted conversation: each customer turn has optional checks on the agent's reply:
 *   contains     every phrase must appear (case-insensitive)
 *   notContains  none of the phrases may appear
 *   escalate     true = the agent must hand over to a person; false = it must not
 *   source       where the answer must come from: knowledge | ai | fallback | escalation
 */
export type TurnExpect = { contains?: string[]; notContains?: string[]; escalate?: boolean; source?: 'knowledge' | 'ai' | 'fallback' | 'escalation' };
export type TestTurn = { message: string; expect?: TurnExpect };
export type Check = { check: string; ok: boolean; detail?: string };
export type TurnResult = { message: string; reply: string; source: string; escalate: boolean; checks: Check[]; ok: boolean };

export const MAX_CASES = 50;
export const MAX_TURNS = 8;
const SOURCES = ['knowledge', 'ai', 'fallback', 'escalation'] as const;

const phrases = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((p) => String(p).trim()).filter((p) => p.length > 0 && p.length <= 100).slice(0, 10);

export function validateTestCase(body: Record<string, unknown>): { value: { name: string; lang: string | null; turns: TestTurn[] }; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) errors.name = 'Name the test (up to 120 characters).';
  const lang = ['ta', 'en', 'tanglish'].includes(String(body.lang)) ? String(body.lang) : null;
  const raw = Array.isArray(body.turns) ? body.turns : [];
  if (!raw.length) errors.turns = 'Add at least one customer message.';
  if (raw.length > MAX_TURNS) errors.turns = `At most ${MAX_TURNS} customer messages per test.`;
  const turns: TestTurn[] = raw.slice(0, MAX_TURNS).map((t, i) => {
    const r = (t ?? {}) as Record<string, unknown>;
    const message = typeof r.message === 'string' ? r.message.trim().slice(0, 600) : '';
    if (!message) errors[`turns.${i}.message`] = 'Write what the customer says.';
    const e = (r.expect ?? {}) as Record<string, unknown>;
    const expect: TurnExpect = {};
    const contains = phrases(e.contains);
    const notContains = phrases(e.notContains);
    if (contains.length) expect.contains = contains;
    if (notContains.length) expect.notContains = notContains;
    if (e.escalate === true || e.escalate === false) expect.escalate = e.escalate;
    if (e.source !== undefined && e.source !== null && e.source !== '') {
      if ((SOURCES as readonly string[]).includes(String(e.source))) expect.source = e.source as TurnExpect['source'];
      else errors[`turns.${i}.source`] = `Source: ${SOURCES.join(', ')}.`;
    }
    return { message, ...(Object.keys(expect).length ? { expect } : {}) };
  });
  return { value: { name, lang, turns }, errors };
}

export function evaluateTurn(expect: TurnExpect | undefined, r: { reply: string; source: string; escalate: boolean }): Check[] {
  const checks: Check[] = [];
  const text = r.reply.toLowerCase();
  for (const p of expect?.contains ?? []) checks.push({ check: `mentions "${p}"`, ok: text.includes(p.toLowerCase()) });
  for (const p of expect?.notContains ?? []) checks.push({ check: `does not mention "${p}"`, ok: !text.includes(p.toLowerCase()) });
  if (expect?.escalate !== undefined) checks.push({ check: expect.escalate ? 'hands over to a person' : 'does not hand over', ok: r.escalate === expect.escalate, detail: r.escalate ? 'handed over' : 'answered' });
  if (expect?.source) checks.push({ check: `answers from ${expect.source}`, ok: r.source === expect.source, detail: `answered from ${r.source}` });
  return checks;
}

/** What a version keeps: everything that changes what the agent says or how it is reached. */
export const SNAPSHOT_FIELDS = ['name', 'description', 'instructions', 'languages', 'voice', 'inbound', 'outbound', 'greeting', 'fallbackMessage', 'knowledgeBaseId', 'businessHours', 'escalation', 'callLimits', 'telephonyProvider', 'sarvamAppId', 'sarvamAppVersion'] as const;
export type Snapshot = Partial<Record<(typeof SNAPSHOT_FIELDS)[number], unknown>>;

export function snapshotOf(agent: Record<string, unknown>): Snapshot {
  return Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, agent[f] ?? null]));
}

/** Field-by-field differences between two snapshots (JSON-equal values are the same). */
export function diffSnapshots(a: Snapshot, b: Snapshot): Array<{ field: string; before: unknown; after: unknown }> {
  const out: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const f of SNAPSHOT_FIELDS) {
    const x = a[f] ?? null;
    const y = b[f] ?? null;
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field: f, before: x, after: y });
  }
  return out;
}
