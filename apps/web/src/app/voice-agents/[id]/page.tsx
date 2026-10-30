'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, FileText, Loader2, Phone, RefreshCw, RotateCcw, Rocket, Search, Trash2, Upload, XCircle } from 'lucide-react';
import { API_URL, ApiError, api, useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { inputCls } from '@/components/textile';
import { toast } from '@/components/toast';
import { AgentConsole, type AgentReply } from '@/components/agent-console';
import type { Agent } from '../page';
import { explainCallReason } from '@/lib/call-reasons';

const STEPS = ['Purpose', 'Business', 'Assistant', 'Knowledge', 'Channels', 'Safety', 'Test', 'Launch'] as const;
const INDUSTRIES: Array<[string, string]> = [['retail', 'Retail'], ['restaurant', 'Restaurant / chicken shop'], ['real_estate', 'Real estate'], ['healthcare', 'Healthcare'], ['education', 'Education'], ['automotive', 'Automotive'], ['banking', 'Banking'], ['manufacturing', 'Manufacturing / B2B'], ['hospitality', 'Hospitality'], ['general', 'General support'], ['other', 'Other']];
const SPEAKERS = ['roopa', 'anushka', 'manisha', 'vidya', 'arya', 'abhilash', 'karun', 'hitesh'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TONES: Array<[string, string]> = [['friendly', 'Warm and friendly'], ['professional', 'Polite and professional'], ['brief', 'Short and to the point']];
/** What custom agents can actually do on this platform (unavailable ones are shown, labelled, not selectable). */
const PURPOSES: Array<{ id: string; label: string; detail: string; unavailable?: string }> = [
  { id: 'answer', label: 'Answer customer questions', detail: 'By chat, voice on the website, and phone calls, from your instructions and documents.' },
  { id: 'orders', label: 'Handle order enquiries', detail: 'Menu, prices, availability and order questions from your documents. Orders themselves are taken by your industry ordering assistant.' },
  { id: 'leads', label: 'Follow up with leads', detail: 'Call customers who agreed to be called, one call per request.' },
  { id: 'outbound', label: 'Make authorized outbound calls', detail: 'Calls only to customers with recorded consent, within your calling hours and limits.' },
  { id: 'updates', label: 'Send customer updates on WhatsApp', detail: '', unavailable: 'Not available for custom agents: WhatsApp updates are sent by your industry assistant’s follow-ups.' },
];
type Doc = { id: string; filename: string; kind: string; sizeBytes: number; status: 'uploaded' | 'processing' | 'indexed' | 'failed'; error: string | null; chunkCount: number; flaggedLines: number; createdAt: string };
type Base = { id: string; name: string; documents: Doc[]; agents: Array<{ id: string; name: string; status: string }> };
type Check = { id: string; label: string; ok: boolean; required: boolean; detail: string; action?: { label: string; href: string } };
type Readiness = { ready: boolean; dryRun: boolean; checks: Check[]; missing: string[] };
type Channel = { id: string; label: string; status: 'connected' | 'not_connected' | 'needs_attention' | 'incomplete'; detail: string; href: string };
const DOC_TONE = { uploaded: 'sky', processing: 'sky', indexed: 'brand', failed: 'rose' } as const;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const label = 'mb-1 block text-[12.5px] font-semibold text-ink';
const area = 'w-full rounded-[10px] border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-brand';
const purposesOf = (a: Agent) => (a.useCase ?? '').split(',').map((x) => x.trim()).filter((x) => PURPOSES.some((p) => p.id === x));
const toneOf = (instructions: string) => (/^Tone: (\w+)/.exec(instructions)?.[1] ?? '');
const withTone = (instructions: string, tone: string) => `Tone: ${tone}. ${TONES.find(([t]) => t === tone)?.[1] ?? ''}.\n${instructions.replace(/^Tone: \w+\.[^\n]*\n?/, '')}`;

/** Guided agent setup: Purpose → Business → Assistant → Knowledge → Channels → Safety → Test → Launch. */
export default function AgentBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const { workspace } = useWorkspace();
  const canManage = !workspace?.role || ['admin', 'manager'].includes(workspace.role);
  const { data: agent, error, reload } = useApi<Agent>(`/voice-agents/${id}`, 0);
  const { data: readiness, reload: reloadReadiness } = useApi<Readiness>(`/telephony/agents/${id}/readiness`, 0);
  const { data: home } = useApi<{ channels: Channel[]; business: { name: string; industryLabel: string } }>('/home?range=today', 0);
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
      setForm(updated); await reload(); await reloadReadiness();
      if (!quiet) toast('Saved. Test the agent again before publishing.');
      return true;
    } catch (e) {
      setFieldErrs(e instanceof ApiError ? ((e.body as { fields?: Record<string, string> })?.fields ?? {}) : {});
      toast(errMsg(e), 'error');
      return false;
    } finally { setSaving(false); }
  }, [form, id, reload, reloadReadiness]);
  const go = async (n: number) => { if (dirty && canManage && !(await save(true))) return; setStep(n); void reloadReadiness(); };

  async function lifecycle(action: 'publish' | 'archive' | 'restore') {
    setSaving(true); setProblems([]);
    try {
      const updated = await api.post<Agent>(`/voice-agents/${id}/${action}`);
      setForm(updated); await reload(); await reloadReadiness();
      toast(action === 'publish' ? 'Published: your assistant is live on the channels you chose.' : action === 'archive' ? 'Archived.' : 'Restored as a draft.');
    } catch (e) {
      const p = e instanceof ApiError ? (e.body as { problems?: string[] })?.problems : undefined;
      if (p?.length) setProblems(p); else toast(errMsg(e), 'error');
    } finally { setSaving(false); }
  }

  if (error && !agent) return <ErrorBanner message={error} onRetry={reload} />;
  if (!form) return <Skeleton className="h-96" />;
  const ro = !canManage || form.status === 'archived';
  const err = (k: string) => fieldErrs[k] && <p className="mt-1 text-[12px] text-rose">{fieldErrs[k]}</p>;
  const purposes = purposesOf(form);
  const togglePurpose = (p: string, on: boolean) => {
    const next = on ? [...new Set([...purposes, p])] : purposes.filter((x) => x !== p);
    set('useCase', next.join(', '));
    if (p === 'outbound' || p === 'leads') {
      const wantsCalls = next.includes('outbound') || next.includes('leads');
      set('outbound', { enabled: wantsCalls, purpose: form.outbound?.purpose ?? '' });
    }
  };
  const launchBlocking = readiness?.checks.filter((c) => c.required && !c.ok && c.id !== 'active') ?? [];

  return (
    <>
      <PageHeader title={form.name} crumb="AI agents" actions={
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
          <fieldset className="space-y-2">
            <legend className="mb-2 text-[16px] font-semibold text-ink">What would you like your AI assistant to do?</legend>
            {PURPOSES.map((p) => (
              <label key={p.id} className={cx('flex items-start gap-3 rounded-[12px] border p-3 text-[13px]', p.unavailable ? 'border-dashed border-line bg-canvas opacity-75' : 'border-line')}>
                <input type="checkbox" className="mt-0.5" disabled={ro || Boolean(p.unavailable)} checked={p.id === 'answer' ? true : purposes.includes(p.id)} onChange={(e) => p.id !== 'answer' && togglePurpose(p.id, e.target.checked)} />
                <span><span className="block font-semibold text-ink">{p.label}{p.unavailable && <span className="ml-2 rounded-full bg-white px-1.5 text-[11px] text-muted ring-1 ring-line">Not available</span>}</span><span className="text-[12.5px] text-body">{p.unavailable ?? p.detail}</span></span>
              </label>
            ))}
          </fieldset>
        )}

        {step === 1 && (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-[10px] bg-canvas p-3 text-[13px] lg:col-span-2"><span className="text-muted">Business: </span><span className="font-semibold text-ink">{home?.business.name ?? workspace?.name}</span> · {home?.business.industryLabel ?? ''} <Link href="/settings" className="ml-2 text-[12.5px] font-semibold text-brand-dark underline">Edit business profile</Link></div>
            <div className="lg:col-span-2">
              <p className={label}>Industry for this assistant</p>
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4" role="radiogroup" aria-label="Industry">
                {INDUSTRIES.map(([v, l]) => (
                  <button key={v} role="radio" aria-checked={form.industry === v} disabled={ro} onClick={() => set('industry', v)} className={cx('rounded-[10px] border px-3 py-2.5 text-left text-[13px] font-semibold', form.industry === v ? 'border-ink bg-ink text-white' : 'border-line text-ink hover:bg-canvas')}>{l}</button>
                ))}
              </div>
              {err('industry')}
            </div>
            <label className="block lg:col-span-2"><span className={label}>Business description and service area</span><textarea disabled={ro} rows={3} className={area} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="What you sell, where you deliver or serve, anything callers often ask." />{err('description')}</label>
            <fieldset className="rounded-[10px] border border-line p-3 lg:col-span-2"><legend className="px-1 text-[12.5px] font-semibold">Working hours</legend>
              <label className="mb-2 flex items-center gap-1.5 text-[13px]"><input type="checkbox" disabled={ro} checked={Boolean(form.businessHours)} onChange={(e) => set('businessHours', e.target.checked ? { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '21:00', timezone: 'Asia/Kolkata', afterHoursMessage: '' } : null)} />Tell callers when you are closed</label>
              {form.businessHours && (
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="flex flex-wrap gap-2 sm:col-span-4">{DAYS.map((d, i) => (
                    <label key={d} className="flex items-center gap-1 text-[12.5px]"><input type="checkbox" disabled={ro} checked={form.businessHours!.days.includes(i + 1)} onChange={(e) => set('businessHours', { ...form.businessHours!, days: e.target.checked ? [...form.businessHours!.days, i + 1].sort() : form.businessHours!.days.filter((x) => x !== i + 1) })} />{d}</label>
                  ))}</div>
                  <label><span className={label}>Opens</span><input type="time" disabled={ro} className={inputCls} value={form.businessHours.start} onChange={(e) => set('businessHours', { ...form.businessHours!, start: e.target.value })} /></label>
                  <label><span className={label}>Closes</span><input type="time" disabled={ro} className={inputCls} value={form.businessHours.end} onChange={(e) => set('businessHours', { ...form.businessHours!, end: e.target.value })} /></label>
                  <label className="sm:col-span-2"><span className={label}>Message when closed</span><input disabled={ro} className={inputCls} value={form.businessHours.afterHoursMessage} onChange={(e) => set('businessHours', { ...form.businessHours!, afterHoursMessage: e.target.value })} /></label>
                </div>
              )}{err('businessHours')}
            </fieldset>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block"><span className={label}>Agent name</span><input disabled={ro} className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} />{err('name')}</label>
            <label className="block"><span className={label}>Personality and tone</span>
              <select disabled={ro} className={inputCls} value={toneOf(form.instructions)} onChange={(e) => e.target.value && set('instructions', withTone(form.instructions, e.target.value))}>
                <option value="">As written in the instructions</option>
                {TONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <fieldset className="lg:col-span-2"><legend className={label}>Languages</legend>
              <div className="flex gap-3">{[['ta', 'Tamil'], ['en', 'English'], ['tanglish', 'Tanglish']].map(([v, l]) => (
                <label key={v} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" disabled={ro} checked={form.languages.includes(v)} onChange={(e) => set('languages', e.target.checked ? [...form.languages, v] : form.languages.filter((x) => x !== v))} />{l}</label>
              ))}</div>{err('languages')}
            </fieldset>
            <label className="block"><span className={label}>Greeting</span><textarea disabled={ro} rows={2} className={area} value={form.greeting} onChange={(e) => set('greeting', e.target.value)} />{err('greeting')}</label>
            <label className="block"><span className={label}>When it does not know the answer</span><textarea disabled={ro} rows={2} className={area} value={form.fallbackMessage} onChange={(e) => set('fallbackMessage', e.target.value)} />{err('fallbackMessage')}</label>
            {form.templateKey && <p className="text-[12.5px] text-muted lg:col-span-2">Started from the <span className="font-semibold">{form.templateKey.replace('_', ' ')}</span> template.</p>}
            <details className="rounded-[10px] border border-line p-3 lg:col-span-2" open={Boolean(fieldErrs.instructions || fieldErrs.escalation)}>
              <summary className="cursor-pointer text-[13px] font-semibold text-ink">Advanced settings: instructions, handoff, voice</summary>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <label className="block lg:col-span-2"><span className={label}>Instructions and behaviour</span><textarea disabled={ro} rows={8} className={area} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} /><span className="text-[11.5px] text-muted">What it does, what it must never do, how it speaks. Facts belong in the knowledge base.</span>{err('instructions')}</label>
                <label className="block"><span className={label}>Hand over to a person when the caller says (comma separated)</span><input disabled={ro} className={inputCls} value={(form.escalation?.keywords ?? []).join(', ')} onChange={(e) => set('escalation', { keywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean), handoffMessage: form.escalation?.handoffMessage ?? '', phone: form.escalation?.phone ?? null })} /></label>
                <label className="block"><span className={label}>Handover message</span><input disabled={ro} className={inputCls} value={form.escalation?.handoffMessage ?? ''} onChange={(e) => set('escalation', { keywords: form.escalation?.keywords ?? [], handoffMessage: e.target.value, phone: form.escalation?.phone ?? null })} /></label>
                <label className="block"><span className={label}>Voice</span><select disabled={ro} className={inputCls} value={form.voice?.speaker ?? 'roopa'} onChange={(e) => set('voice', { speaker: e.target.value, pace: form.voice?.pace ?? 1 })}>{SPEAKERS.map((s) => <option key={s}>{s}</option>)}</select></label>
                <label className="block"><span className={label}>Speaking pace ({(form.voice?.pace ?? 1).toFixed(2)})</span><input type="range" min={0.7} max={1.5} step={0.05} disabled={ro} value={form.voice?.pace ?? 1} onChange={(e) => set('voice', { speaker: form.voice?.speaker ?? 'roopa', pace: Number(e.target.value) })} className="w-full" /></label>
                {err('escalation')}{err('voice')}
              </div>
            </details>
          </div>
        )}

        {step === 3 && <KnowledgeStep agent={form} readOnly={ro} onAttach={async (kbId) => { set('knowledgeBaseId', kbId); try { const u = await api.patch<Agent>(`/voice-agents/${id}`, { knowledgeBaseId: kbId }); setForm(u); await reload(); toast(kbId ? 'Knowledge base attached.' : 'Knowledge base detached.'); } catch (e) { toast(errMsg(e), 'error'); } }} />}

        {step === 4 && (
          <div className="grid gap-4">
            <ul className="grid gap-2 sm:grid-cols-2" aria-label="Channels">
              {(home?.channels ?? []).map((c) => (
                <li key={c.id} className="rounded-[12px] border border-line p-3 text-[13px]">
                  <p className="flex items-center gap-2 font-semibold text-ink">{c.label}<Badge tone={c.status === 'connected' ? 'brand' : c.status === 'needs_attention' ? 'rose' : c.status === 'incomplete' ? 'amber' : 'slate'}>{c.status === 'connected' ? 'Connected' : c.status === 'needs_attention' ? 'Needs attention' : c.status === 'incomplete' ? 'Configuration incomplete' : 'Not connected'}</Badge></p>
                  <p className="mt-0.5 text-[12.5px] text-body">{c.detail}</p>
                  {c.status !== 'connected' && <Link href={c.href} className="mt-1 inline-block text-[12.5px] font-semibold text-brand-dark underline">Set up</Link>}
                </li>
              ))}
            </ul>
            <p className="text-[12.5px] text-muted">Website chat and voice: always available for testing on this page. Custom agents answer phone calls; WhatsApp is answered by your industry assistant.</p>
            <div className="grid gap-3 lg:grid-cols-2">
              <fieldset className="rounded-[10px] border border-line p-3"><legend className="px-1 text-[12.5px] font-semibold">Voice provider for this agent</legend>
                <select disabled={ro} className={inputCls} value={form.telephonyProvider} onChange={(e) => set('telephonyProvider', e.target.value as Agent['telephonyProvider'])} aria-label="Voice provider">
                  <option value="plivo">Plivo (your instructions and documents answer every call)</option>
                  <option value="sarvam">Sarvam Voice Agents (the agent you set up in Sarvam answers)</option>
                </select>
                {form.telephonyProvider === 'sarvam' && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label><span className={label}>Sarvam agent (app) id</span><input disabled={ro} className={inputCls} value={form.sarvamAppId ?? ''} onChange={(e) => set('sarvamAppId', e.target.value || null)} />{err('sarvamAppId')}</label>
                    <label><span className={label}>App version</span><input disabled={ro} type="number" min={1} className={inputCls} value={form.sarvamAppVersion ?? 1} onChange={(e) => set('sarvamAppVersion', Number(e.target.value) || null)} /></label>
                    <p className="rounded-[8px] bg-amber-50 p-2 text-[12px] text-amber-900 sm:col-span-2">Sarvam answers with the agent configured in Sarvam. Copy these instructions and upload the same documents there: Sarvam has no documented way to push them from here.</p>
                  </div>
                )}
              </fieldset>
              <fieldset className="rounded-[10px] border border-line p-3"><legend className="px-1 text-[12.5px] font-semibold">Phone calls</legend>
                <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" disabled={ro} checked={Boolean(form.inbound?.enabled)} onChange={(e) => set('inbound', { enabled: e.target.checked, phoneNumber: form.inbound?.phoneNumber ?? null })} />Answer calls to a number</label>
                {form.inbound?.enabled && <label className="mt-2 block"><span className={label}>Number customers dial</span><input disabled={ro} className={inputCls} value={form.inbound.phoneNumber ?? ''} onChange={(e) => set('inbound', { enabled: true, phoneNumber: e.target.value })} placeholder="+91 44 1234 5678" /></label>}
                <label className="mt-2 flex items-center gap-1.5 text-[13px]"><input type="checkbox" disabled={ro} checked={Boolean(form.outbound?.enabled)} onChange={(e) => set('outbound', { enabled: e.target.checked, purpose: form.outbound?.purpose ?? '' })} />Allow outbound calls (consenting customers only)</label>
                {form.outbound?.enabled && <label className="mt-2 block"><span className={label}>Call purpose</span><input disabled={ro} className={inputCls} value={form.outbound.purpose} onChange={(e) => set('outbound', { enabled: true, purpose: e.target.value })} /></label>}
                <p className="mt-2 text-[11.5px] text-muted">A purchased number does not take calls by itself: it must be routed to your workspace (Plivo) or assigned to an inbound deployment (Sarvam).</p>{err('inbound')}
              </fieldset>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="grid gap-4">
            <p className="text-[13.5px] text-body">Before any real call, Tacksharp checks all of this on the server, every time. It cannot be skipped from here.</p>
            {form.outbound?.enabled && (
              <div className="grid gap-3 sm:grid-cols-3">
                {([['maxCallSeconds', 'Longest call (seconds)'], ['maxConcurrent', 'Calls at the same time'], ['dailyLimit', 'Calls per day']] as const).map(([k, l]) => (
                  <label key={k}><span className={label}>{l}</span><input type="number" disabled={ro} className={inputCls} value={form.callLimits?.[k] ?? ''} onChange={(e) => set('callLimits', { maxCallSeconds: 300, maxConcurrent: 2, dailyLimit: 50, ...form.callLimits, [k]: Number(e.target.value) })} /></label>
                ))}
                {err('callLimits')}
              </div>
            )}
            <ReadinessList readiness={readiness} only={['provider', 'sarvam_app', 'inbound_number', 'consent', 'hours', 'limits', 'live']} empty="This agent does not make or take phone calls, so no calling checks apply. Turn calls on under Channels." />
            <ul className="grid gap-1 text-[12.5px] text-body">
              <li>• Customers who opted out or asked not to be contacted are never called.</li>
              <li>• Each call request is placed once. It is never redialled automatically.</li>
              <li>• Numbers on Tacksharp&apos;s test list are not treated as consent.</li>
            </ul>
          </div>
        )}

        {step === 6 && (
          <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
            <AgentConsole key={form.updatedAt} greeting={form.greeting} examples={['What are your timings?', 'Price evlo?', 'I want to talk to a person']} label="Test mode · nothing is sent" voice={voiceOn}
              send={(message, history) => api.post<AgentReply>(`/voice-agents/${id}/test`, { message, history }).then((r) => { void reload(); void reloadReadiness(); return r; })} />
            <div className="space-y-3 text-[12.5px] text-body">
              <p className="font-semibold text-ink">Test before launching</p>
              <p>Ask what your customers ask, in Tamil, English and Tanglish. Each answer shows which document it came from, or that the agent used its fallback message.</p>
              <p>{dirty ? 'You have unsaved changes: they are saved when you leave this step.' : form.lastTestedAt ? <span className="inline-flex items-center gap-1 text-brand-dark"><Check className="size-3.5" />Tested after the latest changes.</span> : 'Not tested since the latest changes.'}</p>
              {form.outbound?.enabled && <TestCall agent={form} readiness={readiness} />}
            </div>
          </div>
        )}

        {step === 7 && (
          <div className="space-y-4">
            {!readiness ? <Skeleton className="h-32" /> : launchBlocking.length === 0 ? (
              <p className="flex items-center gap-2 rounded-[12px] bg-brand-soft px-4 py-3 text-[15px] font-semibold text-brand-dark" data-testid="launch-verdict"><Check className="size-5" />{form.status === 'active' ? 'Your assistant is live.' : 'Your assistant is ready to launch.'}</p>
            ) : (
              <div className="rounded-[12px] bg-amber-50 px-4 py-3 text-amber-950" data-testid="launch-verdict">
                <p className="text-[15px] font-semibold">Your assistant is not ready yet.</p>
                <p className="mt-0.5 text-[13px]">Missing: {launchBlocking.map((c) => c.label).join(', ')}.</p>
              </div>
            )}
            <ReadinessList readiness={readiness} />
            {problems.length > 0 && <ul role="alert" className="list-disc space-y-1 rounded-[10px] bg-rose-50 py-2 pr-3 pl-7 text-[13px] text-rose-900">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            {readiness?.dryRun && <p className="text-[12.5px] text-muted">Test mode is on for this server: after launch, calls are still checked but not placed until Tacksharp switches live calling on.</p>}
            {canManage && form.status !== 'archived' && (
              <Button variant="primary" busy={saving} disabled={launchBlocking.length > 0} onClick={() => void lifecycle('publish')}><Rocket className="size-4" />{form.status === 'active' ? 'Re-publish' : 'Publish agent'}</Button>
            )}
            {form.status === 'active' && form.publishedAt && <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-dark"><Check className="size-4" />Active since {new Date(form.publishedAt).toLocaleString()}.</p>}
          </div>
        )}

        <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
          <Button disabled={step === 0} onClick={() => void go(step - 1)}><ChevronLeft className="size-4" />Back</Button>
          {canManage && step !== 3 && step < 6 && <Button disabled={!dirty || ro} busy={saving} onClick={() => void save()}>Save</Button>}
          <span className="flex-1" />
          {step < STEPS.length - 1 && <Button variant="primary" busy={saving} onClick={() => void go(step + 1)}>Next: {STEPS[step + 1]}<ChevronRight className="size-4" /></Button>}
        </div>
      </Card>
    </>
  );
}

function ReadinessList({ readiness, only, empty }: { readiness: Readiness | null; only?: string[]; empty?: string }) {
  if (!readiness) return <Skeleton className="h-24" />;
  const checks = only ? readiness.checks.filter((c) => only.includes(c.id)) : readiness.checks;
  if (!checks.length) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line rounded-[12px] border border-line" aria-label="Readiness checks">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-3 px-3 py-2.5" data-testid={`check-${c.id}`} data-ok={c.ok}>
          {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand" aria-label="Done" /> : c.required ? <XCircle className="mt-0.5 size-4 shrink-0 text-rose" aria-label="Missing" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-amber" aria-label="Note" />}
          <div className="min-w-0 flex-1"><p className="text-[13px] font-semibold text-ink">{c.label}</p><p className="text-[12.5px] text-body">{c.detail}</p></div>
          {!c.ok && c.action && <Link href={c.action.href} className="shrink-0 text-[12.5px] font-semibold text-brand-dark underline">{c.action.label}</Link>}
        </li>
      ))}
    </ul>
  );
}

type Customer = { id: string; name: string | null; phone: string | null; callingConsent: boolean };

/**
 * A real test call: never automatic. Shows the destination, explains it is real, needs explicit confirmation, and the
 * server applies every gate (consent, do-not-contact, hours, limits, dry run, idempotency).
 */
function TestCall({ agent, readiness }: { agent: Agent; readiness: Readiness | null }) {
  const { data } = useApi<{ rows?: Customer[] }>('/customers?consent=calling&pageSize=100', 0);
  const list = data?.rows ?? [];
  const [customerId, setCustomerId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; failureReason: string | null } | null>(null);
  const [key, setKey] = useState(() => `ui-test-${crypto.randomUUID()}`);
  const target = list.find((c) => c.id === customerId);
  const blockers = readiness?.checks.filter((c) => c.required && !c.ok && ['active', 'provider', 'sarvam_app', 'consent'].includes(c.id)) ?? [];
  return (
    <div className="rounded-[12px] border border-line p-3" aria-label="Real test call">
      <p className="font-semibold text-ink">Real test call</p>
      {blockers.length > 0 ? (
        <p className="mt-1 text-amber-900">Not possible yet: {blockers.map((b) => b.label.toLowerCase()).join(', ')}.</p>
      ) : (
        <div className="mt-2 grid gap-2">
          <select className={inputCls} value={customerId} onChange={(e) => { setCustomerId(e.target.value); setResult(null); setConfirm(false); setKey(`ui-test-${crypto.randomUUID()}`); }} aria-label="Who to call">
            <option value="">Choose a customer who agreed to calls…</option>
            {list.map((c) => <option key={c.id} value={c.id}>{c.name ?? 'Unnamed'}</option>)}
          </select>
          {target && <p className="text-ink">Destination: <span className="font-semibold tabular">+{target.phone}</span></p>}
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={confirm} disabled={!target} onChange={(e) => setConfirm(e.target.checked)} /><span>This places a <b>real phone call</b> to this number{agent.telephonyProvider === 'sarvam' ? ' through Sarvam' : ' through Plivo'} (charged), unless test mode is on.</span></label>
          <Button disabled={!target || !confirm || busy || Boolean(result)} busy={busy} onClick={async () => {
            setBusy(true);
            try { setResult(await api.post('/telephony/calls', { agentId: agent.id, customerId, confirm: true, idempotencyKey: key })); }
            catch (e) { toast(errMsg(e), 'error'); }
            finally { setBusy(false); }
          }}><Phone className="size-4" />Place test call</Button>
          {result && <p role="status" className={cx('rounded-[8px] px-2.5 py-1.5', result.status === 'dialing' ? 'bg-brand-soft text-brand-dark' : 'bg-amber-50 text-amber-900')}>{result.status === 'dialing' ? 'Calling now.' : `${result.status === 'dry_run' ? 'Checked in test mode, not placed' : 'Not placed'}: ${explainCallReason(result.failureReason)}`}</p>}
        </div>
      )}
    </div>
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
