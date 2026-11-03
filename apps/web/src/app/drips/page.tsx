'use client';

import { useCallback, useEffect, useState } from 'react';
import { MessageCircle, Pause, Phone, Play, Plus, Trash2, Workflow } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Empty, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Label, inputCls } from '@/components/textile';
import { toast } from '@/components/toast';
import type { Tone } from '@/lib/format';

type Step = { day: number; channel: 'whatsapp' | 'voice'; text?: string; templateName?: string; templateLanguage?: string };
type Counts = { active: number; completed: number; stopped: number };
type Sequence = { id: string; name: string; description: string | null; status: 'draft' | 'active' | 'paused'; steps: Step[]; stopOnReply: boolean; sendStartHour: number; sendEndHour: number; counts: Counts };
type Run = { stepIndex: number; channel: string; status: string; reason: string | null; at: string };
type Enrollment = { id: string; status: string; stepIndex: number; nextRunAt: string | null; stopReason: string | null; lastError: string | null; enrolledAt: string; customer: { id: string; name: string | null; phone: string | null }; runs: Run[] };
type Detail = Sequence & { stepStats: Array<Record<string, number>>; enrollments: Enrollment[] };
type Draft = { name: string; description: string; steps: Step[]; stopOnReply: boolean; sendStartHour: number; sendEndHour: number };

const STATUS_TONE: Record<string, Tone> = { active: 'brand', paused: 'amber', draft: 'slate', completed: 'violet', stopped: 'rose' };
const RUN_TONE: Record<string, string> = { sent: 'bg-emerald-50 text-emerald-800', simulated: 'bg-amber-50 text-amber-900', skipped: 'bg-slate-100 text-muted', failed: 'bg-rose-50 text-rose-700', processing: 'bg-sky-50 text-sky-800' };
const STOP_LABEL: Record<string, string> = {
  opted_out: 'Opted out', do_not_contact: 'Do not contact', converted: 'Converted', ordered: 'Placed an order', human_owner: 'Team took over',
  customer_replied: 'Customer replied', stopped_by_user: 'Stopped by a person', customer_missing: 'Customer deleted', lost: 'Marked lost',
};
/** inputCls without w-full, for controls with their own width. */
const fitCls = inputCls.replace('w-full', '');
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

function errorsOf(e: unknown): Record<string, string> {
  const b = e instanceof ApiError ? (e.body as { errors?: Record<string, string> } | undefined) : undefined;
  return b?.errors ?? {};
}

export default function DripsPage() {
  const list = useApi<Sequence[]>('/drips', 15_000);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  useEffect(() => {
    if (selected === null && list.data?.length) setSelected(list.data[0].id);
  }, [list.data, selected]);

  return (
    <>
      <PageHeader title="Drip sequences" crumb="Customers & Leads" actions={<Button variant="primary" onClick={() => setSelected('new')}><Plus className="size-4" />New sequence</Button>} />
      <p className="mb-4 max-w-3xl text-[13px] text-muted">
        Timed WhatsApp messages and AI calls after a customer is enrolled. A sequence stops by itself when the customer opts out, converts, places an order,
        is taken over by the team, or (if you choose) replies. Messages go out only inside the sending hours and through the same safety gate as every
        automatic message: in test mode they are recorded as <b>simulated</b> and nothing is sent.
      </p>
      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="self-start p-2" data-testid="drip-list">
          {list.loading && !list.data && <Skeleton className="h-24" />}
          {list.data?.length === 0 && <Empty icon={<Workflow className="size-5" />} title="No sequences yet">Create one from your industry&apos;s starting template.</Empty>}
          {list.data?.map((s) => (
            <button key={s.id} onClick={() => setSelected(s.id)} className={cx('w-full rounded-[10px] px-3 py-2 text-left hover:bg-slate-50', selected === s.id && 'bg-slate-100')}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13.5px] font-semibold text-ink">{s.name}</span>
                <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
              </div>
              <div className="mt-0.5 text-[12px] text-muted">{s.steps.length} steps · {s.counts.active} running · {s.counts.completed} done · {s.counts.stopped} stopped</div>
            </button>
          ))}
        </Card>
        <div>
          {selected === 'new' && <NewSequence onCreated={(id) => { list.reload(); setSelected(id); }} />}
          {selected && selected !== 'new' && <SequenceView key={selected} id={selected} onChanged={list.reload} />}
        </div>
      </div>
    </>
  );
}

function NewSequence({ onCreated }: { onCreated: (id: string) => void }) {
  const preset = useApi<{ name: string; steps: Step[] }>('/drips/preset', 0);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (preset.data && !draft) setDraft({ name: preset.data.name, description: '', steps: preset.data.steps, stopOnReply: true, sendStartHour: 9, sendEndHour: 20 });
  }, [preset.data, draft]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!draft) return <Skeleton className="h-64" />;
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const s = await api.post<Sequence>('/drips', draft);
      toast('Sequence saved as a draft. Activate it when you are ready.');
      onCreated(s.id);
    } catch (e) {
      setErrors(errorsOf(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5" data-testid="drip-editor">
      <h2 className="mb-3 text-[16px] font-bold text-ink">New sequence</h2>
      <Editor draft={draft} setDraft={setDraft} errors={errors} />
      <div className="mt-4 flex justify-end"><Button variant="primary" busy={busy} onClick={save}>Save draft</Button></div>
    </Card>
  );
}

function Editor({ draft, setDraft, errors }: { draft: Draft; setDraft: (d: Draft) => void; errors: Record<string, string> }) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setStep = (i: number, patch: Partial<Step>) => set({ steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const err = (k: string) => errors[k] && <p className="mt-1 text-[12px] font-semibold text-rose-700">{errors[k]}</p>;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_120px_120px]">
        <Label text="Name"><input aria-label="Sequence name" className={inputCls} value={draft.name} onChange={(e) => set({ name: e.target.value })} />{err('name')}</Label>
        <Label text="Send from (IST)"><input aria-label="Send from hour" type="number" min={0} max={23} className={inputCls} value={draft.sendStartHour} onChange={(e) => set({ sendStartHour: Number(e.target.value) })} /></Label>
        <Label text="Until (IST)"><input aria-label="Send until hour" type="number" min={1} max={24} className={inputCls} value={draft.sendEndHour} onChange={(e) => set({ sendEndHour: Number(e.target.value) })} /></Label>
      </div>
      {err('hours')}
      <label className="flex items-center gap-2 text-[13px] text-body">
        <input type="checkbox" checked={draft.stopOnReply} onChange={(e) => set({ stopOnReply: e.target.checked })} /> Stop when the customer replies (the AI or the team takes the conversation from there)
      </label>
      {err('steps')}
      <ol className="space-y-2" data-testid="drip-steps">
        {draft.steps.map((s, i) => (
          <li key={i} className="rounded-[12px] border border-line p-3" data-testid={`drip-step-${i}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-bold text-muted">Step {i + 1}</span>
              <label className="flex items-center gap-1 text-[12.5px]">Day <input aria-label={`Step ${i + 1} day`} type="number" min={0} max={90} className={cx(fitCls, 'w-20')} value={s.day} onChange={(e) => setStep(i, { day: Number(e.target.value) })} /></label>
              <select aria-label={`Step ${i + 1} channel`} className={cx(fitCls, 'w-40')} value={s.channel} onChange={(e) => setStep(i, { channel: e.target.value as Step['channel'] })}>
                <option value="whatsapp">WhatsApp message</option>
                <option value="voice">AI call (Sarvam)</option>
              </select>
              <button type="button" aria-label={`Remove step ${i + 1}`} className="ml-auto text-faint hover:text-rose-700" onClick={() => set({ steps: draft.steps.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></button>
            </div>
            {err(`steps.${i}.day`)}
            {err(`steps.${i}.channel`)}
            {s.channel === 'whatsapp' ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_200px]">
                <textarea aria-label={`Step ${i + 1} message`} rows={2} className={cx(inputCls, 'h-auto py-2')} placeholder="Message ({name} and {business} are filled in)" value={s.text ?? ''} onChange={(e) => setStep(i, { text: e.target.value })} />
                <input aria-label={`Step ${i + 1} template`} className={inputCls} placeholder="Approved template (optional)" value={s.templateName ?? ''} onChange={(e) => setStep(i, { templateName: e.target.value })} />
                <div className="sm:col-span-2">{err(`steps.${i}.text`)}{err(`steps.${i}.templateName`)}<p className="text-[11.5px] text-faint">The message is used while the customer&apos;s 24-hour WhatsApp window is open; after that only an approved template can be sent, otherwise the step is skipped.</p></div>
              </div>
            ) : (
              <p className="mt-2 text-[12.5px] text-muted">The organization&apos;s automatic-call Sarvam agent calls the customer (within calling hours and only with calling consent or an enquiry).</p>
            )}
          </li>
        ))}
      </ol>
      <Button onClick={() => set({ steps: [...draft.steps, { day: (draft.steps.at(-1)?.day ?? 0) + 1, channel: 'whatsapp', text: '' }] })} disabled={draft.steps.length >= 10}><Plus className="size-4" />Add step</Button>
    </div>
  );
}

function SequenceView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, reload } = useApi<Detail>(`/drips/${id}`, 15_000);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const act = useCallback(async (key: string, fn: () => Promise<unknown>, ok: (r: any) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      toast(ok(r));
      reload();
      onChanged();
      return true;
    } catch (e) {
      setErrors(errorsOf(e));
      toast(e instanceof Error ? e.message : String(e), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }, [reload, onChanged]);

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-4">
      <Card className="p-5" data-testid="drip-detail">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[17px] font-bold text-ink">{data.name}</h2>
          <Badge tone={STATUS_TONE[data.status]}>{data.status}</Badge>
          <span className="text-[12.5px] text-muted">sends {data.sendStartHour}:00–{data.sendEndHour}:00 IST{data.stopOnReply ? ' · stops on reply' : ''}</span>
          <div className="ml-auto flex gap-2">
            {!editing && <Button onClick={() => { setErrors({}); setEditing({ name: data.name, description: data.description ?? '', steps: data.steps, stopOnReply: data.stopOnReply, sendStartHour: data.sendStartHour, sendEndHour: data.sendEndHour }); }}>Edit</Button>}
            {data.status === 'active' ? (
              <Button busy={busy === 'pause'} onClick={() => act('pause', () => api.post(`/drips/${id}/pause`, {}), () => 'Paused. No step runs until you activate it again.')}><Pause className="size-4" />Pause</Button>
            ) : (
              <Button variant="primary" busy={busy === 'activate'} onClick={() => act('activate', () => api.post(`/drips/${id}/activate`, {}), () => 'Active. Due steps run within a minute, inside the sending hours.')}><Play className="size-4" />Activate</Button>
            )}
          </div>
        </div>
        {editing ? (
          <div className="mt-4">
            <Editor draft={editing} setDraft={setEditing} errors={errors} />
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" busy={busy === 'save'} onClick={async () => { if (await act('save', () => api.patch(`/drips/${id}`, editing), () => 'Saved. Running enrolments follow the new steps.')) setEditing(null); }}>Save</Button>
            </div>
          </div>
        ) : (
          <ol className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="drip-timeline">
            {data.steps.map((s, i) => (
              <li key={i} className="rounded-[12px] border border-line p-3">
                <div className="flex items-center gap-2 text-[12.5px] font-bold text-ink">
                  {s.channel === 'voice' ? <Phone className="size-4 text-brand" /> : <MessageCircle className="size-4 text-emerald-700" />}
                  Day {s.day} · {s.channel === 'voice' ? 'AI call' : 'WhatsApp'}
                </div>
                {s.text && <p className="mt-1 line-clamp-3 text-[12.5px] text-body">{s.text}</p>}
                {s.templateName && <p className="mt-1 text-[11.5px] text-faint">Template: {s.templateName}</p>}
                <div className="mt-2 flex flex-wrap gap-1">
                  {Object.entries(data.stepStats[i] ?? {}).map(([k, v]) => <span key={k} className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', RUN_TONE[k])}>{v} {k}</span>)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Enrol id={id} active={data.status === 'active'} onDone={() => { reload(); onChanged(); }} />
      <Card className="p-5">
        <h3 className="mb-2 text-[14px] font-bold text-ink">Enrolled customers <span className="font-normal text-muted">({data.counts.active} running · {data.counts.completed} done · {data.counts.stopped} stopped)</span></h3>
        {data.enrollments.length === 0 ? (
          <p className="text-[13px] text-muted">Nobody enrolled yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]" data-testid="drip-enrollments">
              <thead className="text-muted"><tr><th className="py-1.5 pr-3">Customer</th><th className="pr-3">Status</th><th className="pr-3">Next</th><th className="pr-3">Steps</th><th /></tr></thead>
              <tbody>
                {data.enrollments.map((e) => (
                  <tr key={e.id} className="border-t border-line align-top" data-testid="drip-enrollment">
                    <td className="py-2 pr-3"><a className="font-semibold text-ink hover:underline" href={`/contacts?open=${e.customer.id}`}>{e.customer.name ?? 'Customer'}</a><div className="text-faint">{e.customer.phone}</div></td>
                    <td className="pr-3"><Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>{e.stopReason && <div className="mt-0.5 text-muted">{STOP_LABEL[e.stopReason] ?? e.stopReason}</div>}{e.lastError && <div className="mt-0.5 text-rose-700">{e.lastError}</div>}</td>
                    <td className="pr-3">{e.status === 'active' ? <>Step {e.stepIndex + 1} · {fmt(e.nextRunAt)}</> : '—'}</td>
                    <td className="pr-3"><div className="flex flex-wrap gap-1">{e.runs.map((r) => <span key={r.stepIndex} title={r.reason ?? ''} className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', RUN_TONE[r.status])}>{r.stepIndex + 1}: {r.status}</span>)}</div></td>
                    <td>{e.status === 'active' && <Button variant="ghost" busy={busy === e.id} onClick={() => act(e.id, () => api.post(`/drips/enrollments/${e.id}/stop`, {}), () => 'Stopped for this customer.')}>Stop</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Enrol({ id, active, onDone }: { id: string; active: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<'stage' | 'tag'>('stage');
  const [stage, setStage] = useState('interested');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ enrolled: number; matched: number; skipped: { opted_out: number; no_phone: number; already_enrolled: number }; sequenceActive: boolean }>(`/drips/${id}/enroll`, mode === 'stage' ? { stage } : { tag });
      const msg = `Enrolled ${r.enrolled} of ${r.matched}. Skipped: ${r.skipped.opted_out} opted out, ${r.skipped.no_phone} without a phone, ${r.skipped.already_enrolled} already in a sequence.${r.sequenceActive ? '' : ' Activate the sequence to start sending.'}`;
      setResult(msg);
      toast(msg);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5" data-testid="drip-enrol">
      <h3 className="text-[14px] font-bold text-ink">Enrol customers</h3>
      <p className="mb-2 text-[12.5px] text-muted">Opted-out customers and customers already running a sequence are skipped. {active ? '' : 'This sequence is not active yet: enrolled customers start when you activate it.'}</p>
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="Enrol by" className={cx(fitCls, 'w-36')} value={mode} onChange={(e) => setMode(e.target.value as 'stage' | 'tag')}>
          <option value="stage">By CRM stage</option>
          <option value="tag">By tag</option>
        </select>
        {mode === 'stage' ? (
          <select aria-label="Stage" className={cx(fitCls, 'w-40')} value={stage} onChange={(e) => setStage(e.target.value)}>
            {[['new', 'New'], ['interested', 'Interested'], ['qualified', 'Qualified']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ) : (
          <input aria-label="Tag" className={cx(fitCls, 'w-48')} placeholder="e.g. wedding" value={tag} onChange={(e) => setTag(e.target.value)} />
        )}
        <Button variant="primary" busy={busy} disabled={mode === 'tag' && !tag.trim()} onClick={go}>Enrol</Button>
      </div>
      {result && <p className="mt-2 text-[12.5px] text-body" data-testid="enrol-result">{result}</p>}
    </Card>
  );
}
