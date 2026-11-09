'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Play, Plus, Trash2 } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, CardHeader, Empty, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { toast } from '@/components/toast';
import { FormField } from '@/components/jarvis';
import { StatusPill, ago, errorText, inputCls } from '@/components/office';

type Run = { id: string; status: string; note: string | null; planId: string | null; createdAt: string };
type Workflow = { id: string; name: string; triggerType: 'event' | 'schedule'; trigger: string; instruction: string; mode: string; enabled: boolean; lastRunAt: string | null; runs: Run[] };
type Data = { items: Workflow[]; events: Array<{ type: string; label: string }>; templates: Array<{ name: string; triggerType: 'event' | 'schedule'; trigger: string; instruction: string }> };
const blank = { name: '', triggerType: 'schedule' as 'event' | 'schedule', trigger: 'daily@08:30', instruction: '', mode: 'supervised' };

const triggerText = (w: { triggerType: string; trigger: string }, events: Data['events']) => (w.triggerType === 'schedule' ? `Every day at ${w.trigger.replace('daily@', '')} (India time)` : `When: ${events.find((e) => e.type === w.trigger)?.label ?? w.trigger}`);

export default function OfficeWorkflowsPage() {
  const { data, error, reload } = useApi<Data>('/office/workflows', 20_000);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok); reload(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };
  const time = form.trigger.startsWith('daily@') ? form.trigger.slice(6) : '08:30';
  return (
    <>
      <PageHeader title="Office workflows" crumb="AI Office" />
      <p className="mb-4 text-[12.5px] text-muted">Standing instructions. Each run goes through the CEO, your budget and your approvals like any instruction; one run per event or per day, however often it is seen. At most 12 event-started plans an hour.</p>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-80" /> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0">
            {data.items.length === 0 ? <Card><Empty title="No workflows yet">Start from a template on the right, or write your own.</Empty></Card> : (
              <ul className="flex flex-col gap-3">
                {data.items.map((w) => (
                  <li key={w.id}>
                    <Card className={cx('p-4', !w.enabled && 'opacity-70')}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0"><p className="text-[14px] font-semibold text-ink">{w.name}</p><p className="text-[12px] text-muted">{triggerText(w, data.events)} · <span className="capitalize">{w.mode}</span>{w.lastRunAt ? ` · last run ${ago(w.lastRunAt)}` : ''}</p></div>
                        <div className="flex flex-wrap gap-2">
                          <label className="flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" className="size-4" checked={w.enabled} onChange={(e) => void run(`t${w.id}`, () => api.put(`/office/workflows/${w.id}`, { enabled: e.target.checked }), e.target.checked ? 'Workflow on.' : 'Workflow off.')} />On</label>
                          <Button onClick={() => void run(`r${w.id}`, () => api.post(`/office/workflows/${w.id}/run`), 'Started: the CEO is planning it.')} busy={busy === `r${w.id}`}><Play className="size-4" aria-hidden /> Run now</Button>
                          <Button onClick={() => { if (window.confirm(`Delete “${w.name}”?`)) void run(`d${w.id}`, () => api.delete(`/office/workflows/${w.id}`), 'Deleted.'); }} busy={busy === `d${w.id}`} aria-label={`Delete ${w.name}`}><Trash2 className="size-4" aria-hidden /></Button>
                        </div>
                      </div>
                      <p className="mt-2 text-[13px] text-body">{w.instruction}</p>
                      {w.runs.length > 0 && (
                        <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-[12px]">
                          {w.runs.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2"><StatusPill status={r.status} /><span className="text-muted">{ago(r.createdAt)}</span>{r.note && <span className="text-body">{r.note}</span>}{r.planId && <Link href={`/office/command?plan=${r.planId}`} className="underline">plan</Link>}</li>)}
                        </ul>
                      )}
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <Card className="mb-4">
              <CardHeader title="New workflow" />
              <div className="flex flex-col gap-3 px-5 pb-5">
                <FormField label="Name"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} /></FormField>
                <FormField label="Starts">
                  <select className={inputCls} value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value as 'event' | 'schedule', trigger: e.target.value === 'schedule' ? 'daily@08:30' : data.events[0]?.type ?? '' })}><option value="schedule">Every day at a time</option><option value="event">When something happens</option></select>
                </FormField>
                {form.triggerType === 'schedule'
                  ? <FormField label="Time (India)"><input type="time" className={inputCls} value={time} onChange={(e) => setForm({ ...form, trigger: `daily@${e.target.value}` })} /></FormField>
                  : <FormField label="Event"><select className={inputCls} value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>{data.events.map((e) => <option key={e.type} value={e.type}>{e.label} ({e.type})</option>)}</select></FormField>}
                <FormField label="Instruction for the CEO"><textarea rows={4} maxLength={4000} className="w-full rounded-[10px] border border-line bg-white px-3 py-2 text-[13.5px] outline-none focus:border-slate-400" value={form.instruction} onChange={(e) => setForm({ ...form, instruction: e.target.value })} /></FormField>
                <FormField label="Mode"><select className={inputCls} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}><option value="manual">Manual</option><option value="supervised">Supervised (you start each plan)</option><option value="autonomous">Autonomous within budget</option></select></FormField>
                <Button variant="primary" onClick={() => void run('create', () => api.post('/office/workflows', form), 'Workflow created.').then(() => setForm(blank))} busy={busy === 'create'}><Plus className="size-4" aria-hidden /> Create</Button>
              </div>
            </Card>
            <Card>
              <CardHeader title="Templates" />
              <ul className="divide-y divide-line border-t border-line">
                {data.templates.map((t) => (
                  <li key={t.name} className="px-5 py-3">
                    <p className="text-[13px] font-semibold text-ink">{t.name}</p>
                    <p className="text-[12px] text-muted">{triggerText(t, data.events)}</p>
                    <button type="button" className="mt-1 text-[12.5px] font-semibold underline" onClick={() => setForm({ ...blank, ...t })}>Use this</button>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
