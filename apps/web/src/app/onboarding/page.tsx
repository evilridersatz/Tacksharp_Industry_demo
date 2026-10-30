'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, CircleDashed, Loader2 } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { INDUSTRIES, industryDef, type IndustryId } from '@/lib/industries';
import { forgetWorkspace, switchWorkspace, useWorkspace, type WorkspaceOption } from '@/lib/industry';
import { Button, Card, Skeleton, cx } from '@/components/ui';
import { IndustryPicker } from '@/components/industry-picker';

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
  const current = workspace?.industry === 'restaurant' ? 'chicken_shop' : workspace?.industry;
  const [choice, setChoice] = useState<string | undefined>(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!workspace) return null;
  async function next() {
    if (!choice || choice === current) return onNext();
    setBusy(true);
    setErr(null);
    try {
      // The server decides: a new workspace can become a chicken shop; other industries come from Settings.
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
          ? 'This sets your menu, dashboard, setup steps and AI assistant. No records are deleted or moved.'
          : 'This workspace runs the chicken-shop ordering assistant, so its industry is fixed.'}
      </p>
      {err && <p role="alert" className="mt-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="mt-4">
        {workspace.canChangeIndustry ? (
          <IndustryPicker value={choice ?? ''} onChange={setChoice} name="onboarding-industry" />
        ) : (
          <p className="flex items-center gap-2 rounded-[14px] border-2 p-3 text-[13.5px] font-semibold text-ink" style={{ borderColor: INDUSTRIES.restaurant.accent, background: INDUSTRIES.restaurant.accentSoft }}><Check className="size-4" />GR Chicken / Chicken Shop</p>
        )}
      </div>
      <Nav onBack={onBack} onNext={next} busy={busy} nextLabel={choice && choice !== current ? 'Save industry' : 'Continue'} />
    </>
  );
}

type Channel = { id: string; label: string; status: 'connected' | 'not_connected' | 'needs_attention' | 'incomplete'; detail: string; href: string };
const CHANNEL_LABEL: Record<Channel['status'], string> = { connected: 'Connected', not_connected: 'Not connected', needs_attention: 'Needs attention', incomplete: 'Configuration incomplete' };

function ConnectionsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { workspace } = useWorkspace();
  // Truthful status from the server: "connected" only after a passed test or a number routed to this workspace.
  const { data, error } = useApi<{ channels: Channel[]; mode: { dryRun: boolean } }>('/home?range=today', 0);
  if (!workspace) return null;
  return (
    <>
      <h1 className="text-[20px] font-bold text-ink">Connect your channels</h1>
      <p className="mt-1 text-[13px] text-muted">How customers reach your AI assistant. Each connection is tested before it is used.</p>
      {error && <p role="alert" className="mt-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{error}</p>}
      {!data && !error && <Skeleton className="mt-4 h-32" />}
      {data && (
        <ul className="mt-4 divide-y divide-line rounded-[14px] border border-line">
          {data.channels.map((c) => (
            <li key={c.id} className="flex items-start gap-3 px-4 py-3">
              {c.status === 'connected' ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden /> : <CircleDashed className="mt-0.5 size-5 shrink-0 text-amber" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-ink">{c.label} · <span className={c.status === 'connected' ? 'text-brand-dark' : 'text-amber-800'}>{CHANNEL_LABEL[c.status]}</span></p>
                <p className="text-[12.5px] text-muted">{c.detail}</p>
              </div>
              {c.status !== 'connected' && <Link href={c.href} className="shrink-0 text-[12.5px] font-semibold text-brand-dark underline">{c.status === 'needs_attention' ? 'Repair' : 'Set up'}</Link>}
            </li>
          ))}
          <li className="flex items-start gap-3 px-4 py-3">
            <CircleDashed className="mt-0.5 size-5 shrink-0 text-faint" aria-hidden />
            <div className="min-w-0"><p className="text-[13.5px] font-semibold text-ink">Sending mode · {data.mode.dryRun ? 'Test mode' : 'Live'}</p><p className="text-[12.5px] text-muted">{data.mode.dryRun ? 'Messages and calls are checked but not sent. Tacksharp switches live sending on for your account.' : 'Messages and calls reach customers who agreed to be contacted.'}</p></div>
          </li>
        </ul>
      )}
      {workspace.isDemo && <p className="mt-3 text-[12.5px] text-muted">This is a demo workspace: agents run on sample data and nothing is sent, whatever the connection status.</p>}
      <p className="mt-3 text-[12.5px]"><Link href="/settings/integrations" className="font-semibold text-brand">Open Integrations</Link></p>
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
      <p className="mt-4 rounded-[12px] bg-canvas px-3 py-2.5 text-[13px] text-body">Want an assistant with your own instructions and documents? <Link href="/voice-agents" className="font-semibold text-brand-dark underline">Create a custom AI agent</Link> (guided, with a test before launch).</p>
      <Nav onBack={onBack} onNext={finish} nextLabel="Go to Home" />
    </>
  );
}
