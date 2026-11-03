'use client';

import { useState } from 'react';
import { CheckCircle2, GitCompare, History, ListChecks, Play, Plus, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { Badge, Button, cx } from './ui';
import { inputCls } from './textile';
import { toast } from './toast';

type Expect = { contains?: string[]; notContains?: string[]; escalate?: boolean; source?: string };
type Turn = { message: string; expect?: Expect };
type Check = { check: string; ok: boolean; detail?: string };
type TurnResult = { message: string; reply: string; source: string; escalate: boolean; checks: Check[]; ok: boolean };
type TestCase = { id: string; name: string; lang: string | null; turns: Turn[]; lastResult: { ok: boolean; turns: TurnResult[] } | null; lastRunAt: string | null };
type Version = { id: string; version: number; note: string | null; publishedBy: string | null; testSummary: { total: number; passed: number; failed: number } | null; createdAt: string };
type Change = { field: string; before: unknown; after: unknown };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const FIELD_LABEL: Record<string, string> = { name: 'Name', description: 'Description', instructions: 'Instructions', languages: 'Languages', voice: 'Voice', inbound: 'Inbound calls', outbound: 'Outbound calls', greeting: 'Greeting', fallbackMessage: 'Fallback message', knowledgeBaseId: 'Knowledge base', businessHours: 'Business hours', escalation: 'Escalation', callLimits: 'Call limits', telephonyProvider: 'Telephony', sarvamAppId: 'Sarvam agent id', sarvamAppVersion: 'Sarvam agent version' };
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/** Saved test cases: scripted conversations with checks, run through the real agent engine (nothing is sent). */
export function TestSuite({ agentId, canManage, onRan }: { agentId: string; canManage: boolean; onRan: () => void }) {
  const { data, reload } = useApi<TestCase[]>(`/voice-agents/${agentId}/tests`, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [turns, setTurns] = useState<Array<{ message: string; contains: string; notContains: string; escalate: '' | 'yes' | 'no'; source: string }>>([{ message: '', contains: '', notContains: '', escalate: '', source: '' }]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function runAll() {
    setBusy('run');
    try {
      const r = await api.post<{ total: number; passed: number; failed: number }>(`/voice-agents/${agentId}/tests/run`);
      toast(r.total ? `${r.passed} of ${r.total} test(s) passed.` : 'No test cases yet.', r.failed ? 'error' : 'ok');
      await reload();
      onRan();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  async function add() {
    setBusy('add');
    setErrors({});
    try {
      await api.post(`/voice-agents/${agentId}/tests`, {
        name,
        turns: turns.map((t) => ({ message: t.message, expect: { contains: list(t.contains), notContains: list(t.notContains), ...(t.escalate ? { escalate: t.escalate === 'yes' } : {}), ...(t.source ? { source: t.source } : {}) } })),
      });
      toast('Test case saved. Run the tests to see the result.');
      setAdding(false);
      setName('');
      setTurns([{ message: '', contains: '', notContains: '', escalate: '', source: '' }]);
      await reload();
    } catch (e) {
      setErrors(e instanceof ApiError ? ((e.body as { errors?: Record<string, string> })?.errors ?? {}) : {});
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: string) {
    setBusy(`del-${id}`);
    try {
      await api.delete(`/voice-agents/${agentId}/tests/${id}`);
      await reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  const passed = (data ?? []).filter((c) => c.lastResult?.ok).length;
  const ran = (data ?? []).filter((c) => c.lastResult).length;
  return (
    <section className="mt-4 rounded-[12px] border border-line p-4" data-testid="test-suite">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[14px] font-bold text-ink"><ListChecks className="size-4" />Saved test cases</h3>
        {data && data.length > 0 && <Badge tone={ran && passed === data.length ? 'brand' : ran ? 'rose' : 'slate'}>{ran ? `${passed}/${data.length} passed` : `${data.length} not run`}</Badge>}
        <div className="ml-auto flex gap-2">
          {canManage && <Button onClick={() => setAdding((a) => !a)}><Plus className="size-4" />Add test</Button>}
          {canManage && <Button variant="primary" busy={busy === 'run'} disabled={!data?.length} onClick={() => void runAll()}><Play className="size-4" />Run all</Button>}
        </div>
      </div>
      <p className="mt-1 text-[12px] text-muted">Each test plays a customer conversation through this agent (same instructions, knowledge and AI model as live; nothing is sent) and checks every reply. Run them after every change.</p>

      {adding && (
        <div className="mt-3 space-y-2 rounded-[10px] bg-slate-50 p-3" data-testid="test-form">
          <input className={inputCls} aria-label="Test name" placeholder="Test name, e.g. Broiler price in Tanglish" value={name} onChange={(e) => setName(e.target.value)} />
          {errors.name && <p className="text-[12px] text-rose-700">{errors.name}</p>}
          {turns.map((t, i) => (
            <div key={i} className="rounded-[10px] border border-line bg-white p-2">
              <input className={inputCls} aria-label={`Customer message ${i + 1}`} placeholder={`Customer says (message ${i + 1})`} value={t.message} onChange={(e) => setTurns(turns.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))} />
              {errors[`turns.${i}.message`] && <p className="text-[12px] text-rose-700">{errors[`turns.${i}.message`]}</p>}
              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                <input className={inputCls} aria-label={`Reply must mention ${i + 1}`} placeholder="Reply must mention (comma separated)" value={t.contains} onChange={(e) => setTurns(turns.map((x, j) => (j === i ? { ...x, contains: e.target.value } : x)))} />
                <input className={inputCls} aria-label={`Reply must not mention ${i + 1}`} placeholder="Reply must NOT mention" value={t.notContains} onChange={(e) => setTurns(turns.map((x, j) => (j === i ? { ...x, notContains: e.target.value } : x)))} />
                <select className={inputCls} aria-label={`Hand over ${i + 1}`} value={t.escalate} onChange={(e) => setTurns(turns.map((x, j) => (j === i ? { ...x, escalate: e.target.value as '' | 'yes' | 'no' } : x)))}>
                  <option value="">Hand-over: any</option><option value="yes">Must hand over to a person</option><option value="no">Must answer (no hand-over)</option>
                </select>
                <select className={inputCls} aria-label={`Answer source ${i + 1}`} value={t.source} onChange={(e) => setTurns(turns.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))}>
                  <option value="">Answer source: any</option><option value="knowledge">From the knowledge base</option><option value="ai">From the AI model</option><option value="fallback">Fallback message</option><option value="escalation">Hand-over message</option>
                </select>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button disabled={turns.length >= 8} onClick={() => setTurns([...turns, { message: '', contains: '', notContains: '', escalate: '', source: '' }])}><Plus className="size-4" />Next customer message</Button>
            <Button variant="primary" busy={busy === 'add'} onClick={() => void add()}>Save test</Button>
          </div>
        </div>
      )}

      <ul className="mt-3 divide-y divide-line">
        {(data ?? []).map((c) => (
          <li key={c.id} className="py-2" data-testid="test-case">
            <div className="flex flex-wrap items-center gap-2">
              {c.lastResult ? (c.lastResult.ok ? <CheckCircle2 className="size-4 text-brand" /> : <XCircle className="size-4 text-rose" />) : <span className="size-4 rounded-full border border-line" />}
              <button className="text-left text-[13px] font-semibold text-ink hover:underline" onClick={() => setOpen(open === c.id ? null : c.id)}>{c.name}</button>
              <span className="text-[12px] text-muted">{c.turns.length} message(s){c.lastRunAt ? ` · run ${new Date(c.lastRunAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ' · not run'}</span>
              {canManage && <button aria-label={`Delete ${c.name}`} className="ml-auto text-faint hover:text-rose" disabled={busy === `del-${c.id}`} onClick={() => void remove(c.id)}><Trash2 className="size-4" /></button>}
            </div>
            {open === c.id && (
              <ol className="mt-2 space-y-2 pl-6 text-[12.5px]">
                {c.turns.map((t, i) => {
                  const r = c.lastResult?.turns[i];
                  return (
                    <li key={i}>
                      <p><span className="text-muted">Customer:</span> {t.message}</p>
                      {r && <p className="mt-0.5"><span className="text-muted">Agent ({r.source}{r.escalate ? ', handed over' : ''}):</span> {r.reply}</p>}
                      <ul className="mt-0.5 flex flex-wrap gap-1">
                        {(r?.checks ?? []).map((k, j) => <li key={j} className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', k.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700')} title={k.detail}>{k.ok ? '✓' : '✗'} {k.check}</li>)}
                        {!r && <li className="text-faint">not run yet</li>}
                      </ul>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        ))}
        {data && data.length === 0 && !adding && <li className="py-2 text-[12.5px] text-faint">No test cases yet. Add the questions your customers ask most.</li>}
      </ul>
    </section>
  );
}

/** Published versions: compare with the current configuration and restore an earlier one. */
export function Versions({ agentId, canManage, onRestored }: { agentId: string; canManage: boolean; onRestored: () => void }) {
  const { data, reload } = useApi<Version[]>(`/voice-agents/${agentId}/versions`, 0);
  const [diff, setDiff] = useState<{ version: number; changes: Change[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function compare(v: number) {
    setBusy(`cmp-${v}`);
    try {
      const r = await api.get<{ changes: Change[] }>(`/voice-agents/${agentId}/diff?from=${v}&to=current`);
      setDiff({ version: v, changes: r.changes });
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  async function restore(v: number) {
    setBusy(`res-${v}`);
    try {
      await api.post(`/voice-agents/${agentId}/versions/${v}/restore`);
      toast(`Version ${v} restored. Test it, then publish to make it live again.`);
      setDiff(null);
      await reload();
      onRestored();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="rounded-[12px] border border-line p-4" data-testid="agent-versions">
      <h3 className="flex items-center gap-1.5 text-[14px] font-bold text-ink"><History className="size-4" />Published versions</h3>
      {!data?.length ? <p className="mt-1 text-[12.5px] text-faint">Every publish is saved here as a numbered version you can compare and restore.</p> : (
        <ul className="mt-2 divide-y divide-line">
          {data.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]" data-testid="agent-version">
              <Badge tone="violet">v{v.version}</Badge>
              <span className="text-body">{v.note ?? 'No note'}</span>
              <span className="text-faint">{new Date(v.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
              {v.testSummary && <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', v.testSummary.failed ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-800')}>{v.testSummary.passed}/{v.testSummary.total} tests</span>}
              <div className="ml-auto flex gap-1">
                <Button variant="ghost" busy={busy === `cmp-${v.version}`} onClick={() => void compare(v.version)}><GitCompare className="size-4" />Compare</Button>
                {canManage && <Button variant="ghost" busy={busy === `res-${v.version}`} onClick={() => void restore(v.version)}><RotateCcw className="size-4" />Restore</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {diff && (
        <div className="mt-3 rounded-[10px] bg-slate-50 p-3 text-[12.5px]" data-testid="agent-diff">
          <p className="mb-1 font-semibold text-ink">v{diff.version} → current configuration</p>
          {diff.changes.length === 0 ? <p className="text-muted">No differences.</p> : (
            <ul className="space-y-1.5">
              {diff.changes.map((c) => (
                <li key={c.field}>
                  <span className="font-semibold text-ink">{FIELD_LABEL[c.field] ?? c.field}</span>
                  <div className="mt-0.5 grid gap-1 sm:grid-cols-2"><span className="rounded bg-rose-50 px-2 py-1 text-rose-900 line-through decoration-rose-300">{show(c.before)}</span><span className="rounded bg-emerald-50 px-2 py-1 text-emerald-900">{show(c.after)}</span></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
