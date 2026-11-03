/** Pure metric helpers for advanced analytics (all inputs come from the database; nothing is estimated). */

export const IST_MS = 330 * 60_000;
export const istDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
/** 0 = Monday ... 6 = Sunday, hour 0-23, in IST. */
export function istSlot(d: Date): { dow: number; hour: number } {
  const t = new Date(d.getTime() + IST_MS);
  return { dow: (t.getUTCDay() + 6) % 7, hour: t.getUTCHours() };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
export const median = (v: number[]) => percentile(v, 50);

export type Author = 'customer' | 'ai' | 'team' | 'automatic';
/** Who wrote a message: the customer, the AI, a team member, or an automation (acknowledgement, drip, workflow, follow-up). */
export function authorOf(m: { role: string; metadata: unknown }): Author {
  if (m.role === 'user') return 'customer';
  const md = (m.metadata ?? {}) as Record<string, unknown>;
  if (md.author === 'staff') return 'team';
  if (md.autoReply || md.drip || md.workflow || md.followUpId || md.optOut || md.campaign) return 'automatic';
  return 'ai';
}
export const isSimulated = (metadata: unknown) => Boolean((metadata as { simulated?: boolean } | null)?.simulated);

export type Msg = { conversationId: string; role: string; createdAt: Date; metadata: unknown };

/**
 * Response times in seconds. A customer "turn" starts at a customer message that follows a non-customer message (or
 * opens the conversation); its response is the first later message by the AI / team / automation in that conversation.
 * Turns without a response are counted as unanswered. `ai` = answered by the AI, `team` = answered by a person.
 */
export function responseTimes(messages: Msg[]) {
  const byConv = new Map<string, Msg[]>();
  for (const m of messages) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);
  const ai: number[] = [];
  const team: number[] = [];
  let unanswered = 0;
  for (const list of byConv.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let turnStart: Date | null = null;
    for (const m of list) {
      const who = authorOf(m);
      if (who === 'customer') {
        if (!turnStart) turnStart = m.createdAt;
        continue;
      }
      if (turnStart) {
        const s = Math.max(0, (m.createdAt.getTime() - turnStart.getTime()) / 1000);
        if (who === 'ai') ai.push(s);
        else if (who === 'team') team.push(s);
        turnStart = null;
      }
    }
    if (turnStart) unanswered++;
  }
  return { ai, team, unanswered };
}

/** Change against the previous period: null when there is nothing to compare with. */
export function change(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return Math.round(((now - before) / before) * 100);
}

export function csvRows(rows: Array<Array<string | number | null>>): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
