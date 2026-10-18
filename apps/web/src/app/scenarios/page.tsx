'use client';

import { useState } from 'react';
import { CheckCircle2, CircleAlert, CircleDashed, FlaskConical, Play, PlugZap, XCircle } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { industryDef } from '@/lib/industries';
import { PageHeader } from '@/components/shell';
import { Button, Card, Empty, Skeleton, cx } from '@/components/ui';
import { errorText } from '@/components/textile';
import { Pill } from '@/components/vertical-ui';

type Scenario = { id: string; title: string; description: string };
type Step = { name: string; kind: string; input?: string; output?: string; status: 'passed' | 'failed' | 'blocked' | 'simulated' | 'provider_required'; detail?: string; ms?: number };
type Run = { scenario: Scenario; phone: string; ms: number; ok: boolean; summary: Partial<Record<Step['status'], number>>; steps: Step[] };

const ICON = { passed: CheckCircle2, failed: XCircle, blocked: CircleAlert, simulated: FlaskConical, provider_required: PlugZap } as const;
const COLOR = { passed: 'text-emerald-600', failed: 'text-rose-600', blocked: 'text-amber-600', simulated: 'text-cyan-600', provider_required: 'text-violet-600' } as const;
const LABEL = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked by missing configuration', simulated: 'Simulated successfully', provider_required: 'Needs real-provider verification' } as const;

export default function ScenariosPage() {
  const { workspace } = useWorkspace();
  const def = industryDef(workspace?.industry);
  const { data } = useApi<{ industry: string; demo: boolean; scenarios: Scenario[] }>('/industry/scenarios', 0);
  const [runs, setRuns] = useState<Record<string, Run | { error: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  async function run(id: string) {
    setBusy(id);
    try {
      const r = await api.post<Run>('/industry/scenarios/run', { scenarioId: id });
      setRuns((x) => ({ ...x, [id]: r }));
    } catch (e) {
      setRuns((x) => ({ ...x, [id]: { error: errorText(e) } }));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <PageHeader title="Scenario runner" crumb="Setup" />
      <Card className="mb-4 p-4">
        <p className="text-[13.5px] font-semibold text-ink">Test {def.label} end to end — safely</p>
        <p className="mt-1 text-[12.5px] text-muted">Each scenario drives the real assistants and services with a synthetic customer in this demo workspace. Nothing is sent to WhatsApp, no call is placed, nothing is charged. Every step reports one of:</p>
        <div className="mt-2 flex flex-wrap gap-2">{(Object.keys(LABEL) as Array<keyof typeof LABEL>).map((k) => { const I = ICON[k]; return <span key={k} className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2.5 py-1 text-[12px] text-body ring-1 ring-line"><I className={cx('size-3.5', COLOR[k])} aria-hidden /> {LABEL[k]}</span>; })}</div>
      </Card>
      {!data && <Skeleton className="h-40" />}
      {data && !data.demo && (
        <Card><Empty icon={<CircleDashed className="size-6" />} title="Scenarios run only in demo workspaces">Switch to a demo workspace from the menu, so a test can never message a real customer or change live records.</Empty></Card>
      )}
      {data?.demo && data.scenarios.map((s) => {
        const r = runs[s.id];
        return (
          <Card key={s.id} className="mb-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 max-w-2xl">
                <p className="text-[15px] font-bold text-ink">{s.title}</p>
                <p className="mt-1 text-[12.5px] text-muted">{s.description}</p>
              </div>
              <Button variant="primary" busy={busy === s.id} onClick={() => run(s.id)}><Play className="size-4" /> {r ? 'Run again' : 'Run scenario'}</Button>
            </div>
            {r && 'error' in r && <p role="alert" className="mt-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{r.error}</p>}
            {r && 'steps' in r && (
              <div className="mt-4">
                <div className="mb-3 flex flex-wrap items-center gap-2" role="status">
                  <Pill tone={r.ok ? 'green' : 'red'}>{r.ok ? 'all checks passed' : 'some steps failed'}</Pill>
                  {(Object.entries(r.summary) as Array<[keyof typeof LABEL, number]>).map(([k, n]) => <Pill key={k} status={k}>{n} {LABEL[k].toLowerCase()}</Pill>)}
                  <span className="text-[12px] text-muted">{(r.ms / 1000).toFixed(1)} s · synthetic customer {r.phone}</span>
                </div>
                <ol className="divide-y divide-line rounded-[12px] border border-line">
                  {r.steps.map((st, i) => {
                    const I = ICON[st.status];
                    return (
                      <li key={i} className="flex gap-3 px-3 py-2.5">
                        <I className={cx('mt-0.5 size-4 shrink-0', COLOR[st.status])} aria-label={LABEL[st.status]} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold text-ink">{st.name} <span className="text-[11px] font-normal text-muted">· {st.kind}{st.ms ? ` · ${st.ms} ms` : ''}</span></p>
                          {st.input && <p className="mt-0.5 text-[12.5px] text-body"><span className="font-semibold">Customer:</span> {st.input}</p>}
                          {st.output && <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-[12.5px] text-body"><span className="font-semibold">{st.kind === 'chat' || st.kind === 'voice' ? 'Assistant' : 'Result'}:</span> {st.output}</p>}
                          {st.detail && <p className="mt-0.5 text-[12px] text-muted">{st.detail}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}
