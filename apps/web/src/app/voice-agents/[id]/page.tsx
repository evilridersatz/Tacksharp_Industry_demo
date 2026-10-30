'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Check, ChevronLeft, ChevronRight, FileText, Loader2, RefreshCw, RotateCcw, Rocket, Search, Trash2, Upload } from 'lucide-react';
import { API_URL, ApiError, api, useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { inputCls } from '@/components/textile';
import { toast } from '@/components/toast';
import { AgentConsole, type AgentReply } from '@/components/agent-console';
import type { Agent } from '../page';

const STEPS = ['Industry', 'Configure', 'Knowledge', 'Voice & phone', 'Test', 'Review', 'Publish'] as const;
const INDUSTRIES: Array<[string, string]> = [['retail', 'Retail'], ['restaurant', 'Restaurant'], ['real_estate', 'Real estate'], ['healthcare', 'Healthcare'], ['education', 'Education'], ['automotive', 'Automotive'], ['banking', 'Banking'], ['manufacturing', 'Manufacturing / B2B'], ['hospitality', 'Hospitality'], ['general', 'General support'], ['other', 'Other']];
const SPEAKERS = ['roopa', 'anushka', 'manisha', 'vidya', 'arya', 'abhilash', 'karun', 'hitesh'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type Doc = { id: string; filename: string; kind: string; sizeBytes: number; status: 'uploaded' | 'processing' | 'indexed' | 'failed'; error: string | null; chunkCount: number; flaggedLines: number; createdAt: string };
type Base = { id: string; name: string; documents: Doc[]; agents: Array<{ id: string; name: string; status: string }> };
const DOC_TONE = { uploaded: 'sky', processing: 'sky', indexed: 'brand', failed: 'rose' } as const;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const label = 'mb-1 block text-[12.5px] font-semibold text-ink';
const area = 'w-full rounded-[10px] border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-brand';

/** Agent Builder: Industry → Configure → Knowledge → Voice & phone → Test → Review → Publish. */
export default function AgentBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const { workspace } = useWorkspace();
  const canManage = !workspace?.role || ['admin', 'manager'].includes(workspace.role);
  const { data: agent, error, reload } = useApi<Agent>(`/voice-agents/${id}`, 0);
  const [form, setForm] = useState<Agent | null>(null);
  const [step, setStep] = useState(0);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [voiceOn, setVoiceOn] = useState(false);
  useEffect(() => { if (agent && !form) setForm(agent); }, [agent, form]);
  useEffect(() => { api.get<{ voice: boolean }>('/assistant/status').then((s) => setVoiceOn(Boolean(s.voice))).catch(() => setVoiceOn(false)); }, []);
  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const dirty = useMemo(() => Boolean(form && agent && JSON.stringify(payload(form)) !== JSON.stringify(payload(agent))), [form, agent]);

  const save = useCallback(async (quiet = false) => {
    if (!form) return false;
    setSaving(true); setFieldErrs({});
    try {
      const updated = await api.patch<Agent>(`/voice-agents/${id}`, payload(form));
      setForm(updated); await reload();
      if (!quiet) toast('Saved. Test the agent again before publishing.');
      return true;
    } catch (e) {
      setFieldErrs(e instanceof ApiError ? ((e.body as { fields?: Record<string, string> })?.fields ?? {}) : {});
      toast(errMsg(e), 'error');
      return false;
    } finally { setSaving(false); }
  }, [form, id, reload]);
  const go = async (n: number) => { if (dirty && canManage && !(await save(true))) return; setStep(n); };

  async function lifecycle(action: 'publish' | 'archive' | 'restore') {
    setSaving(true); setProblems([]);
    try {
      const updated = await api.post<Agent>(`/voice-agents/${id}/${action}`);
      setForm(updated); await reload();
      toast(action === 'publish' ? 'Published: the agent is live on its channels.' : action === 'archive' ? 'Archived.' : 'Restored as a draft.');
    } catch (e) {
      const p = e instanceof ApiError ? (e.body as { problems?: string[] })?.problems : undefined;
      if (p?.length) setProblems(p); else toast(errMsg(e), 'error');
    } finally { setSaving(false); }
  }

  if (error && !agent) return <ErrorBanner message={error} onRetry={reload} />;
  if (!form) return <Skeleton className="h-96" />;
  const ro = !canManage || form.status === 'archived';
  const err = (k: string) => fieldErrs[k] && <p className="mt-1 text-[12px] text-rose">{fieldErrs[k]}</p>;

  return (
    <>
      <PageHeader title={form.name} crumb="Voice agents" actions={
        <div className="flex items-center gap-2">
          <Badge tone={form.status === 'active' ? 'brand' : form.status === 'draft' ? 'amber' : 'slate'} dot>{form.status}</Badge>
          {canManage && form.status !== 'archived' && <Button className="h-9" onClick={() => void lifecycle('archive')}><Archive className="size-4" />Archive</Button>}
          {canManage && form.status === 'archived' && <Button className="h-9" onClick={() => void lifecycle('restore')}><RotateCcw className="size-4" />Restore</Button>}
        </div>
      } />
      <Link href="/voice-agents" className="mb-3 inline-flex items-center gap-1 text-[12.5px] font-semibold text-muted hover:text-ink"><ChevronLeft className="size-3.5" />All agents</Link>
      <ol className="mb-4 flex gap-1 overflow-x-auto rounded-[12px] bg-white p-1 ring-1 ring-line" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s} className="shrink-0">
            <button onClick={() => void go(i)} aria-current={step === i ? 'step' : undefined} className={cx('inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[12.5px] font-semibold', step === i ? 'bg-ink text-white' : 'text-muted hover:text-ink')}>
              <span className={cx('grid size-4 place-items-center rounded-full text-[10px]', step === i ? 'bg-white text-ink' : 'bg-canvas')}>{i + 1}</span>{s}
            </button>
          </li>
        ))}
      </ol>

      <Card>
        {step === 0 && (
          <div className="space-y-3">
            <h2 className="text-[15px] font-semibold text-ink">Which industry is this agent for?</h2>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4" role="radiogroup" aria-label="Industry">
              {INDUSTRIES.map(([v, l]) => (
                <button key={v} role="radio" aria-checked={form.industry === v} disabled={ro} onClick={() => set('industry', v)} className={cx('rounded-[10px] border px-3 py-2.5 text-left text-[13px] font-semibold', form.industry === v ? 'border-ink bg-ink text-white' : 'border-line text-ink hover:bg-canvas')}>{l}</button>
              ))}
            </div>
            {err('industry')}
            <label className="block"><span className={label}>Use case</span><input disabled={ro} className={inputCls} value={form.useCase ?? ''} onChange={(e) => set('useCase', e.target.value)} placeholder="e.g. Phone orders and delivery questions" /></label>
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block"><span className={label}>Agent name</span><input disabled={ro} className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} />{err('name')}</label>
            <label className="block"><span className={label}>Description</span><input disabled={ro} className={inputCls} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} />{err('description')}</label>
            <label className="block lg:col-span-2"><span className={label}>Instructions and behaviour</span><textarea disabled={ro} rows={8} className={area} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} /><span className="text-[11.5px] text-muted">What it does, what it must never do, how it speaks. Facts belong in the knowledge base.</span>{err('instructions')}</label>
            <label className="block"><span className={label}>Greeting</span><textarea disabled={ro} rows={2} className={area} value={form.greeting} onChange={(e) => set('greeting', e.target.value)} />{err('greeting')}</label>
            <label className="block"><span className={label}>Fallback message (when the answer is not known)</span><textarea disabled={ro} rows={2} className={area} value={form.fallbackMessage} onChange={(e) => set('fallbackMessage', e.target.value)} />{err('fallbackMessage')}</label>
            <fieldset className="lg:col-span-2"><legend className={label}>Languages</legend>
              <div className="flex gap-3">{[['ta', 'Tamil'], ['en', 'English'], ['tanglish', 'Tanglish']].map(([v, l]) => (
                <label key={v} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" disabled={ro} checked={form.languages.includes(v)} onChange={(e) => set('languages', e.target.checked ? [...form.languages, v] : form.languages.filter((x) => x !== v))} />{l}</label>
              ))}</div>{err('languages')}
            </fieldset>
            <fieldset className="lg:col-span-2 rounded-[10px] border border-line p-3"><legend className="px-1 text-[12.5px] font-semibold">Escalation and handoff</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block"><span className={label}>Handoff keywords (comma separated)</span><input disabled={ro} className={inputCls} value={(form.escalation?.keywords ?? []).join(', ')} onChange={(e) => set('escalation', { keywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean), handoffMessage: form.escalation?.handoffMessage ?? '', phone: form.escalation?.phone ?? null })} /></label>
                <label className="block"><span className={label}>Handoff message</span><input disabled={ro} className={inputCls} value={form.escalation?.handoffMessage ?? ''} onChange={(e) => set('escalation', { keywords: form.escalation?.keywords ?? [], handoffMessage: e.target.value, phone: form.escalation?.phone ?? null })} /></label>
                <label className="block"><span className={label}>Staff phone (optional)</span><input disabled={ro} className={inputCls} value={form.escalation?.phone ?? ''} onChange={(e) => set('escalation', { keywords: form.escalation?.keywords ?? [], handoffMessage: form.escalation?.handoffMessage ?? '', phone: e.target.value || null })} placeholder="+91…" /></label>
              </div>{err('escalation')}
            </fieldset>
            <fieldset className="lg:col-span-2 rounded-[10px] border border-line p-3"><legend className="px-1 text-[12.5px] font-semibold">Business hours</legend>
              <label className="mb-2 flex items-center gap-1.5 text-[13px]"><input type="checkbox" disabled={ro} checked={Boolean(form.businessHours)} onChange={(e) => set('businessHours', e.target.checked ? { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '21:00', timezone: 'Asia/Kolkata', afterHoursMessage: '' } : null)} />Only answer as "open" during set hours</label>
              {form.businessHours && (
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="sm:col-span-4 flex flex-wrap gap-2">{DAYS.map((d, i) => (
                    <label key={d} className="flex items-center gap-1 text-[12.5px]"><input type="checkbox" disabled={ro} checked={form.businessHours!.days.includes(i + 1)} onChange={(e) => set('businessHours', { ...form.businessHours!, days: e.target.checked ? [...form.businessHours!.days, i + 1].sort() : form.businessHours!.days.filter((x) => x !== i + 1) })} />{d}</label>
                  ))}</div>
                  <label><span className={label}>Opens</span><input type="time" disabled={ro} className={inputCls} value={form.businessHours.start} onChange={(e) => set('businessHours', { ...form.businessHours!, start: e.target.value })} /></label>
                  <label><span className={label}>Closes</span><input type="time" disabled={ro} className={inputCls} value={form.businessHours.end} onChange={(e) => set('businessHours', { ...form.businessHours!, end: e.target.value })} /></label>
                  <label className="sm:col-span-2"><span className={label}>After-hours message</span><input disabled={ro} className={inputCls} value={form.businessHours.afterHoursMessage} onChange={(e) => set('businessHours', { ...form.businessHours!, afterHoursMessage: e.target.value })} /></label>
                </div>
              )}{err('businessHours')}
            </fieldset>
          </div>
        )}

        {step === 2 && <KnowledgeStep agent={form} readOnly={ro} onAttach={async (kbId) => { set('knowledgeBaseId', kbId); try { const u = await api.patch<Agent>(`/voice-agents/${id}`, { knowledgeBaseId: kbId }); setForm(u); await reload(); toast(kbId ? 'Knowledge base attached.' : 'Knowledge base detached.'); } catch (e) { toast(errMsg(e), 'error'); } }} />}

        {step === 3 && (
          <div className="grid gap-3 lg:grid-cols-2">
            <fieldset className="rounded-[10px] border border-line p-3"><legend className="px-1 text-[12.5px] font-semibold">Voice</legend>
              <label className="block"><span className={label}>Voice</span><select disabled={ro} className={inputCls} value={form.voice?.speaker ?? 'roopa'} onChange={(e) => set('voice', { speaker: e.target.value, pace: form.voice?.pace ?? 1 })}>{SPEAKERS.map((s) => <option key={s}>{s}</option>)}</select></label>
              <label className="mt-2 block"><span className={label}>Speaking pace ({(form.voice?.pace ?? 1).toFixed(2)})</span><input type="range" min={0.7} max={1.5} step={0.05} disabled={ro} value={form.voice?.pace ?? 1} onChange={(e) => set('voice', { speaker: form.voice?.speaker ?? 'roopa', pace: Number(e.target.value) })} className="w-full" /></label>{err('voice')}
            </fieldset>
            <fieldset className="rounded-[10px] border border-line p-3"><legend className="px-1 text-[12.5px] font-semibold">Telephony provider</legend>
              <select disabled={ro} className={inputCls} value={form.telephonyProvider} onChange={(e) => set('telephonyProvider', e.target.value as Agent['telephonyProvider'])}>
                <option value="plivo">Plivo (our engine speaks with your instructions and knowledge base)</option>
                <option value="sarvam">Sarvam Voice Agents (agent hosted by Sarvam)</option>
              </select>
              {form.telephonyProvider === 'sarvam' && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label><span className={label}>Sarvam agent (app) id</span><input disabled={ro} className={inputCls} value={form.sarvamAppId ?? ''} onChange={(e) => set('sarvamAppId', e.target.value || null)} />{err('sarvamAppId')}</label>
                  <label><span className={label}>App version</span><input disabled={ro} type="number" min={1} className={inputCls} value={form.sarvamAppVersion ?? 1} onChange={(e) => set('sarvamAppVersion', Number(e.target.value) || null)} /></label>
                  <p className="sm:col-span-2 rounded-[8px] bg-amber-50 p-2 text-[12px] text-amber-900">Sarvam runs this call with the agent configured in Sarvam. Copy these instructions and upload the same documents to that Sarvam agent: Sarvam has no documented API to push them from here.</p>
                </div>
              )}
            </fieldset>
            <fieldset className="rounded-[10px] border border-line p-3"><legend className="px-1 text-[12.5px] font-semibold">Inbound calls</legend>
              <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" disabled={ro} checked={Boolean(form.inbound?.enabled)} onChange={(e) => set('inbound', { enabled: e.target.checked, phoneNumber: form.inbound?.phoneNumber ?? null })} />Answer calls to a number</label>
              {form.inbound?.enabled && <label className="mt-2 block"><span className={label}>Number customers dial</span><input disabled={ro} className={inputCls} value={form.inbound.phoneNumber ?? ''} onChange={(e) => set('inbound', { enabled: true, phoneNumber: e.target.value })} placeholder="+91 44 1234 5678" /></label>}
              <p className="mt-2 text-[11.5px] text-muted">A purchased number does not take calls by itself: it must be routed to this organization (Plivo) or assigned to an inbound deployment (Sarvam).</p>{err('inbound')}
            </fieldset>
            <fieldset className="rounded-[10px] border border-line p-3"><legend className="px-1 text-[12.5px] font-semibold">Outbound calls and limits</legend>
              <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" disabled={ro} checked={Boolean(form.outbound?.enabled)} onChange={(e) => set('outbound', { enabled: e.target.checked, purpose: form.outbound?.purpose ?? '' })} />Allow outbound calls (consenting customers only)</label>
              {form.outbound?.enabled && <label className="mt-2 block"><span className={label}>Call purpose</span><input disabled={ro} className={inputCls} value={form.outbound.purpose} onChange={(e) => set('outbound', { enabled: true, purpose: e.target.value })} /></label>}
              <div className="mt-2 grid grid-cols-3 gap-2">
                {([['maxCallSeconds', 'Max call (s)'], ['maxConcurrent', 'Concurrent'], ['dailyLimit', 'Per day']] as const).map(([k, l]) => (
                  <label key={k}><span className={label}>{l}</span><input type="number" disabled={ro} className={inputCls} value={form.callLimits?.[k] ?? ''} onChange={(e) => set('callLimits', { maxCallSeconds: 300, maxConcurrent: 2, dailyLimit: 50, ...form.callLimits, [k]: Number(e.target.value) })} /></label>
                ))}
              </div>{err('callLimits')}
            </fieldset>
          </div>
        )}

        {step === 4 && (
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <AgentConsole key={form.updatedAt} greeting={form.greeting} examples={['What are your timings?', 'Price evlo?', 'I want to talk to a person']} label="Test mode · nothing is sent" voice={voiceOn}
              send={(message, history) => api.post<AgentReply>(`/voice-agents/${id}/test`, { message, history }).then((r) => { void reload(); return r; })} />
            <div className="space-y-2 text-[12.5px] text-body">
              <p className="font-semibold text-ink">Test before publishing</p>
              <p>Ask what your customers ask, in Tamil, English and Tanglish. Each answer shows which document it came from, or that the agent used its fallback message.</p>
              <p>{dirty ? 'You have unsaved changes: they are saved when you leave this step.' : form.lastTestedAt ? <span className="inline-flex items-center gap-1 text-brand-dark"><Check className="size-3.5" />Tested after the latest changes.</span> : 'Not tested since the latest changes.'}</p>
            </div>
          </div>
        )}

        {step === 5 && (
          <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[180px_1fr]">
            {[
              ['Industry / use case', `${form.industry} · ${form.useCase ?? '-'}`],
              ['Languages', form.languages.join(', ')],
              ['Greeting', form.greeting],
              ['Fallback', form.fallbackMessage],
              ['Knowledge base', form.knowledgeBase?.name ?? 'None (answers only from instructions)'],
              ['Voice', `${form.voice?.speaker ?? 'roopa'} · pace ${form.voice?.pace ?? 1}`],
              ['Telephony', form.telephonyProvider === 'sarvam' ? `Sarvam app ${form.sarvamAppId ?? '(missing)'} v${form.sarvamAppVersion ?? 1}` : 'Plivo'],
              ['Inbound', form.inbound?.enabled ? `+${form.inbound.phoneNumber}` : 'Off'],
              ['Outbound', form.outbound?.enabled ? `On · ${form.outbound.purpose || 'no purpose given'}` : 'Off'],
              ['Limits', form.callLimits ? `${form.callLimits.maxCallSeconds}s · ${form.callLimits.maxConcurrent} at once · ${form.callLimits.dailyLimit}/day` : '-'],
              ['Business hours', form.businessHours ? `${form.businessHours.days.map((d) => DAYS[d - 1]).join(' ')} ${form.businessHours.start}-${form.businessHours.end}` : 'Always'],
              ['Handoff keywords', form.escalation?.keywords.join(', ') || '-'],
              ['Last test', form.lastTestedAt ? new Date(form.lastTestedAt).toLocaleString() : 'Not tested since the latest changes'],
            ].map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="text-ink">{v}</dd></div>)}
          </dl>
        )}

        {step === 6 && (
          <div className="space-y-3">
            <p className="text-[13.5px] text-body">Publishing makes the agent active on the channels you enabled. The server checks: a test since your latest changes, every document indexed, a Sarvam agent id when Sarvam places calls, and an inbound number that belongs to this organization.</p>
            {problems.length > 0 && <ul role="alert" className="list-disc space-y-1 rounded-[10px] bg-rose-50 py-2 pr-3 pl-7 text-[13px] text-rose-900">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            {form.status === 'active' ? <p className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-brand-dark"><Check className="size-4" />Active since {form.publishedAt ? new Date(form.publishedAt).toLocaleString() : 'now'}.</p> : null}
            {canManage && form.status !== 'archived' && <Button variant="primary" busy={saving} onClick={() => void lifecycle('publish')}><Rocket className="size-4" />{form.status === 'active' ? 'Re-publish' : 'Publish agent'}</Button>}
          </div>
        )}

        <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
          <Button disabled={step === 0} onClick={() => void go(step - 1)}><ChevronLeft className="size-4" />Back</Button>
          {canManage && step !== 2 && step < 4 && <Button disabled={!dirty || ro} busy={saving} onClick={() => void save()}>Save</Button>}
          <span className="flex-1" />
          {step < STEPS.length - 1 && <Button variant="primary" busy={saving} onClick={() => void go(step + 1)}>Next: {STEPS[step + 1]}<ChevronRight className="size-4" /></Button>}
        </div>
      </Card>
    </>
  );
}

/** Only the editable fields (what the server validates). */
function payload(a: Agent) {
  return {
    name: a.name, description: a.description ?? '', industry: a.industry, useCase: a.useCase ?? '', instructions: a.instructions, languages: a.languages,
    greeting: a.greeting, fallbackMessage: a.fallbackMessage, voice: a.voice ?? { speaker: 'roopa', pace: 1 }, inbound: a.inbound ?? { enabled: false, phoneNumber: null },
    outbound: a.outbound ?? { enabled: false, purpose: '' }, businessHours: a.businessHours, escalation: a.escalation ?? { keywords: [], handoffMessage: '', phone: null },
    callLimits: a.callLimits ?? { maxCallSeconds: 300, maxConcurrent: 2, dailyLimit: 50 }, telephonyProvider: a.telephonyProvider, sarvamAppId: a.sarvamAppId, sarvamAppVersion: a.sarvamAppVersion,
  };
}

/** Knowledge base: create / choose, upload (status shown until really indexed), retry, delete, and try retrieval. */
function KnowledgeStep({ agent, readOnly, onAttach }: { agent: Agent; readOnly: boolean; onAttach: (id: string | null) => Promise<void> }) {
  const { data: bases, reload } = useApi<Base[]>('/knowledge-bases', 0);
  const current = bases?.find((b) => b.id === agent.knowledgeBaseId) ?? null;
  const pending = current?.documents.some((d) => d.status === 'uploaded' || d.status === 'processing');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Array<{ text: string; filename: string; source: string }> | null>(null);
  // Poll while a document is being processed.
  useEffect(() => { if (!pending) return; const t = setInterval(() => void reload(), 2000); return () => clearInterval(t); }, [pending, reload]);

  async function create() {
    setBusy('create');
    try { const kb = await api.post<Base>('/knowledge-bases', { name }); setName(''); await reload(); await onAttach(kb.id); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || !current) return;
    for (const f of Array.from(files)) {
      setBusy(`up:${f.name}`);
      const form = new FormData();
      form.append('file', f);
      try {
        const res = await fetch(`${API_URL}/knowledge-bases/${current.id}/documents`, { method: 'POST', body: form, credentials: 'include' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.message ?? `Upload failed (${res.status})`);
        toast(`${f.name}: uploaded, processing…`);
      } catch (e) { toast(`${f.name}: ${errMsg(e)}`, 'error'); }
    }
    setBusy(null);
    await reload();
  }
  async function act(fn: () => Promise<unknown>, done: string) {
    try { await fn(); toast(done); await reload(); } catch (e) { toast(errMsg(e), 'error'); }
  }

  if (!bases) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-60 flex-1"><span className={label}>Knowledge base for this agent</span>
          <select disabled={readOnly} className={inputCls} value={agent.knowledgeBaseId ?? ''} onChange={(e) => void onAttach(e.target.value || null)}>
            <option value="">None</option>
            {bases.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.documents.length} documents)</option>)}
          </select>
        </label>
        {!readOnly && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <input className={inputCls} placeholder="New knowledge base name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New knowledge base name" />
            <Button type="submit" disabled={name.trim().length < 2} busy={busy === 'create'}>Create</Button>
          </form>
        )}
      </div>
      {current && (
        <>
          {!readOnly && (
            <label className={cx('flex cursor-pointer flex-col items-center gap-1 rounded-[12px] border-2 border-dashed border-line px-4 py-6 text-center text-[13px] text-body hover:border-ink/30', busy?.startsWith('up:') && 'opacity-60')}>
              {busy?.startsWith('up:') ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
              <span className="font-semibold text-ink">Upload PDF, Word (.docx), TXT or CSV</span>
              <span className="text-[12px] text-muted">Up to 10 MB each. Text PDFs only (scanned images are not read). Instructions hidden in documents are ignored.</span>
              <input type="file" multiple accept=".pdf,.docx,.txt,.csv,.md" className="sr-only" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
            </label>
          )}
          <ul className="divide-y divide-line rounded-[12px] border border-line" aria-label="Documents">
            {current.documents.length === 0 && <li className="px-3 py-4 text-[13px] text-muted">No documents yet.</li>}
            {current.documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]" data-testid="kb-doc">
                <FileText className="size-4 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{d.filename}</span>
                <Badge tone={DOC_TONE[d.status]} dot>{d.status === 'uploaded' || d.status === 'processing' ? 'processing' : d.status}</Badge>
                {d.status === 'indexed' && <span className="text-[12px] text-muted">{d.chunkCount} passages{d.flaggedLines ? ` · ${d.flaggedLines} instruction-like line(s) removed` : ''}</span>}
                {d.status === 'failed' && <span className="w-full text-[12px] text-rose">{d.error}</span>}
                {!readOnly && d.status === 'failed' && <Button className="h-7" onClick={() => void act(() => api.post(`/knowledge-documents/${d.id}/reprocess`), 'Processing again…')}><RefreshCw className="size-3.5" />Retry</Button>}
                {!readOnly && <button aria-label={`Delete ${d.filename}`} onClick={() => void act(() => api.delete(`/knowledge-documents/${d.id}`), 'Document deleted.')} className="grid size-7 place-items-center rounded-[8px] text-muted hover:bg-rose-50 hover:text-rose"><Trash2 className="size-3.5" /></button>}
              </li>
            ))}
          </ul>
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { setHits((await api.get<{ results: Array<{ text: string; filename: string; source: string }> }>(`/knowledge-bases/${current.id}/search?q=${encodeURIComponent(q)}`)).results); } catch (x) { toast(errMsg(x), 'error'); } }}>
            <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Try a question: which passages would the agent use?" aria-label="Test retrieval" />
            <Button type="submit" disabled={!q.trim()}><Search className="size-4" />Find</Button>
          </form>
          {hits && (hits.length === 0 ? <p className="text-[12.5px] text-muted">No matching passage: the agent would use its fallback message.</p> : (
            <ol className="space-y-1.5 text-[12.5px]">{hits.map((h, i) => <li key={i} className="rounded-[8px] bg-canvas p-2"><span className="font-semibold">{h.filename} · {h.source}:</span> {h.text.slice(0, 300)}</li>)}</ol>
          ))}
        </>
      )}
    </div>
  );
}
