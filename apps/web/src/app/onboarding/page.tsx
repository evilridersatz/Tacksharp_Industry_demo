'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, CircleDashed, Loader2 } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { INDUSTRIES, industryDef, type IndustryId } from '@/lib/industries';
import { forgetWorkspace, switchWorkspace, useWorkspace, type WorkspaceOption } from '@/lib/industry';
import { Button, Card, Skeleton, cx } from '@/components/ui';

const STEPS = ['Workspace', 'Industry', 'Connections', 'AI agents'] as const;

/**
 * Setup guide. Every step reads or changes real state through the API (workspace membership, Settings → Industry,
 * integration status, the agent catalogue); nothing is pretended. It can be skipped at any time.
 */
export default function OnboardingPage() {
  const { workspace } = useWorkspace();
  const [step, setStep] = useState(0);
  useEffect(() => {
    try {
      const s = Number(sessionStorage.getItem('onboarding.step'));
      if (s > 0 && s < STEPS.length) setStep(s);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const go = (s: number) => {
    setStep(s);
    try {
      sessionStorage.setItem('onboarding.step', String(s));
    } catch {
      /* ignore */
    }
  };
  const def = industryDef(workspace?.industry);

  return (
    <div className="min-h-dvh bg-canvas px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-[760px]">
        <div className="mb-6 flex items-center justify-between gap-3">
          <p className="text-[16px] font-bold text-ink">Tacksharp.ai · Setup guide</p>
          <Link href="/" className="text-[13px] font-semibold text-muted hover:text-ink">Skip for now</Link>
        </div>
        <ol className="mb-6 grid grid-cols-4 gap-2" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? 'step' : undefined}>
              <span className="block h-1.5 rounded-full" style={{ background: i <= step ? def.accent : '#e2e8f0' }} />
              <span className={cx('mt-1.5 block truncate text-[11.5px] sm:text-[12.5px]', i === step ? 'font-semibold text-ink' : 'text-muted')}>{i + 1}. {s}</span>
            </li>
          ))}
        </ol>
        <Card className="p-5 sm:p-7">
          {!workspace ? <Skeleton className="h-60" /> : step === 0 ? <WorkspaceStep onNext={() => go(1)} /> : step === 1 ? <IndustryStep onBack={() => go(0)} onNext={() => go(2)} /> : step === 2 ? <ConnectionsStep onBack={() => go(1)} onNext={() => go(3)} /> : <AgentsStep onBack={() => go(2)} />}
        </Card>
      </div>
    </div>
  );
}

function Nav({ onBack, onNext, nextLabel = 'Continue', busy }: { onBack?: () => void; onNext: () => void; nextLabel?: string; busy?: boolean }) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
      {onBack ? <Button onClick={onBack}><ArrowLeft className="size-4" /> Back</Button> : <span />}
      <Button variant="primary" onClick={onNext} busy={busy}>{nextLabel} <ArrowRight className="size-4" /></Button>
    </div>
  );
}

function WorkspaceStep({ onNext }: { onNext: () => void }) {
  const { data, error } = useApi<WorkspaceOption[]>('/auth/workspaces', 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function pick(w: WorkspaceOption) {
    if (w.current) return onNext();
    setBusy(w.organizationId);
    try {
      sessionStorage.setItem('onboarding.step', '1');
    } catch {
      /* ignore */
    }
    try {
      await switchWorkspace(w.organizationId, '/onboarding');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }
  return (
    <>
      <h1 className="text-[20px] font-bold text-ink">Choose a workspace</h1>
      <p className="mt-1 text-[13px] text-muted">Each workspace is a separate business with its own data. Demo workspaces hold sample data only.</p>
      {(error || err) && <p role="alert" className="mt-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{error ?? err}</p>}
      <ul className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {!data && !error && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[72px]" />)}
        {data?.map((w) => {
          const d = INDUSTRIES[w.industry];
          const Icon = d.icon;
          return (
            <li key={w.organizationId}>
              <button
                type="button"
                onClick={() => pick(w)}
                disabled={busy !== null}
                className={cx('flex min-h-[72px] w-full items-center gap-3 rounded-[14px] border p-3 text-left transition hover:border-slate-300', w.current ? 'border-2' : 'border-line')}
                style={w.current ? { borderColor: d.accent, background: d.accentSoft } : undefined}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white" style={{ color: d.accent }}><Icon className="size-5" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-ink">{w.name}</span>
                  <span className="block truncate text-[12px] text-muted">{w.industryLabel}{w.isDemo ? ' · Demo' : ''}</span>
                </span>
                {busy === w.organizationId ? <Loader2 className="size-4 animate-spin text-muted" /> : w.current && <Check className="size-4" style={{ color: d.accent }} aria-label="Current workspace" />}
              </button>
            </li>
          );
        })}
      </ul>
      <Nav onNext={onNext} />
    </>
  );
}

function IndustryStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { workspace } = useWorkspace();
  const [choice, setChoice] = useState<IndustryId | undefined>(workspace?.industry);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!workspace) return null;
  const options: IndustryId[] = workspace.canChangeIndustry ? workspace.settableIndustries : [workspace.industry];
  async function next() {
    if (!choice || choice === workspace!.industry) return onNext();
    setBusy(true);
    setErr(null);
    try {
      await api.put('/settings', { industry: choice });
      forgetWorkspace();
      try {
        sessionStorage.setItem('onboarding.step', '2');
      } catch {
        /* ignore */
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <>
      <h1 className="text-[20px] font-bold text-ink">What kind of business is {workspace.name}?</h1>
      <p className="mt-1 text-[13px] text-muted">
        {workspace.canChangeIndustry
          ? 'This sets the menu, dashboard, pipeline stages and AI agents. No records are deleted or moved.'
          : 'This workspace runs the restaurant ordering assistant, so its industry is fixed.'}
      </p>
      {err && <p role="alert" className="mt-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div role="radiogroup" aria-label="Industry" className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {options.map((id) => {
          const d = INDUSTRIES[id];
          const Icon = d.icon;
          const on = choice === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!workspace.canChangeIndustry}
              onClick={() => setChoice(id)}
              className={cx('flex min-h-[72px] items-start gap-3 rounded-[14px] border p-3 text-left transition', on ? 'border-2' : 'border-line hover:border-slate-300')}
              style={on ? { borderColor: d.accent, background: d.accentSoft } : undefined}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white" style={{ color: d.accent }}><Icon className="size-5" aria-hidden /></span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-semibold text-ink">{d.label}</span>
                <span className="block text-[12px] text-muted">{d.tagline}</span>
              </span>
            </button>
          );
        })}
      </div>
      <Nav onBack={onBack} onNext={next} busy={busy} nextLabel={choice && choice !== workspace.industry ? 'Save industry' : 'Continue'} />
    </>
  );
}

function ConnectionsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { workspace } = useWorkspace();
  if (!workspace) return null;
  const i = workspace.integrations;
  const rows = [
    { label: 'WhatsApp Business', ok: i.whatsapp, hint: i.whatsapp ? 'Configured on the server.' : 'Not configured: WhatsApp agents cannot reply to customers yet.' },
    { label: 'Voice calls (Plivo)', ok: i.voice, hint: i.voice ? 'Configured on the server.' : 'Not configured: AI calls are off.' },
    { label: 'AI model', ok: i.ai, hint: i.ai ? 'Configured.' : 'Not configured: assistants use rules and templates only.' },
    { label: 'Safe mode (DRY_RUN)', ok: i.dryRun, hint: i.dryRun ? 'On: no real messages are sent and no calls are placed.' : 'Off: messages and calls are live.' },
  ];
  const settingsHref = workspace.industry === 'restaurant' ? '/integrations' : '/settings';
  return (
    <>
      <h1 className="text-[20px] font-bold text-ink">Connections</h1>
      <p className="mt-1 text-[13px] text-muted">The real status on this server. Credentials are set by your administrator on the server and never shown here.</p>
      <ul className="mt-4 divide-y divide-line rounded-[14px] border border-line">
        {rows.map((r) => (
          <li key={r.label} className="flex items-start gap-3 px-4 py-3">
            {r.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" aria-label="Yes" /> : <CircleDashed className="mt-0.5 size-5 shrink-0 text-faint" aria-label="No" />}
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold text-ink">{r.label}</p>
              <p className="text-[12.5px] text-muted">{r.hint}</p>
            </div>
          </li>
        ))}
      </ul>
      {workspace.isDemo && <p className="mt-3 text-[12.5px] text-muted">This is a demo workspace: agents run on sample data and nothing is sent, whatever the connection status.</p>}
      <p className="mt-3 text-[12.5px]"><Link href={settingsHref} className="font-semibold text-brand">Open {workspace.industry === 'restaurant' ? 'Settings & integrations' : 'Settings'}</Link></p>
      <Nav onBack={onBack} onNext={onNext} />
    </>
  );
}

function AgentsStep({ onBack }: { onBack: () => void }) {
  const { data } = useApi<{ agents: Array<{ id: string; name: string; status: string }> }>('/industry/agents', 0);
  const { workspace } = useWorkspace();
  const def = industryDef(workspace?.industry);
  const ready = data?.agents.filter((a) => a.status !== 'unavailable') ?? [];
  const planned = data?.agents.filter((a) => a.status === 'unavailable') ?? [];
  function finish() {
    try {
      sessionStorage.removeItem('onboarding.step');
    } catch {
      /* ignore */
    }
    window.location.href = '/';
  }
  return (
    <>
      <h1 className="text-[20px] font-bold text-ink">Your {def.short.toLowerCase()} AI agents</h1>
      <p className="mt-1 text-[13px] text-muted">Open AI agents from the menu to see each agent&apos;s rules and test it in a demo workspace.</p>
      {!data && <Skeleton className="mt-4 h-40" />}
      {data && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-[12px] font-semibold tracking-[0.04em] text-muted uppercase">Available ({ready.length})</p>
            <ul className="space-y-1 text-[13px] text-body">{ready.map((a) => <li key={a.id} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />{a.name}</li>)}</ul>
          </div>
          <div>
            <p className="mb-1.5 text-[12px] font-semibold tracking-[0.04em] text-muted uppercase">Planned ({planned.length})</p>
            <ul className="space-y-1 text-[13px] text-muted">{planned.map((a) => <li key={a.id} className="flex gap-2"><CircleDashed className="mt-0.5 size-4 shrink-0" aria-hidden />{a.name}</li>)}</ul>
          </div>
        </div>
      )}
      <Nav onBack={onBack} onNext={finish} nextLabel="Go to overview" />
    </>
  );
}
