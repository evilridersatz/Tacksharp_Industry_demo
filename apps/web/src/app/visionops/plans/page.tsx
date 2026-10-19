'use client';

import { useMemo, useState } from 'react';
import { Check, Info } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { IndustryOnly, Label, inputCls } from '@/components/textile';
import { Pill, SourceNote } from '@/components/vertical-ui';
import type { TenantSettings } from '@/lib/types';

type Overview = { days: number; kpis: { cameras: number; sites: number }; charts: { byRootCause: Array<{ count: number }> } };

export default function PlansPage() {
  return (
    <>
      <PageHeader title="Plans & cost" />
      <IndustryOnly allow={['cctv']}><Plans /></IndustryOnly>
    </>
  );
}

/** Every number below is an editable assumption or a measured figure from this workspace; nothing is a quote. */
function Plans() {
  const { data: settings, error, reload } = useApi<TenantSettings>('/settings');
  const { data: ov } = useApi<Overview>('/monitoring/overview?days=30');
  const measuredIncidents = ov && ov.kpis.cameras ? (ov.charts.byRootCause.reduce((a, c) => a + c.count, 0) / ov.kpis.cameras) * (30 / ov.days) : null;
  const [a, setA] = useState<Record<string, number>>({});
  const v = (k: string, d: number) => a[k] ?? d;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setA({ ...a, [k]: Number(e.target.value) });

  const cameras = v('cameras', ov?.kpis.cameras || 50);
  const sites = v('sites', ov?.kpis.sites || 5);
  const interval = v('interval', 60);
  const checksPer = v('checksPer', 2);
  const infra = v('infra', 3000);
  const perMillion = v('perMillion', 40);
  const incidents = v('incidents', measuredIncidents !== null ? Math.round(measuredIncidents * 100) / 100 : 0.5);
  const msgsPerIncident = v('msgs', 4);
  const waRate = v('waRate', settings?.monitoring?.whatsappCostInr ?? 0);
  const supportHours = v('supportHours', 0.5);
  const hourly = v('hourly', 400);
  const onboarding = v('onboarding', 150);

  const r = useMemo(() => {
    const eventsMonth = cameras * checksPer * ((30 * 86_400) / interval);
    const processing = (eventsMonth / 1_000_000) * perMillion;
    const whatsapp = cameras * incidents * msgsPerIncident * waRate;
    const support = sites * supportHours * hourly;
    const onboard = (cameras * onboarding) / 12;
    const total = infra + processing + whatsapp + support + onboard;
    return { eventsMonth, processing, whatsapp, support, onboard, total, perCamera: cameras ? total / cameras : 0 };
  }, [cameras, sites, interval, checksPer, infra, perMillion, incidents, msgsPerIncident, waRate, supportHours, hourly, onboarding]);

  if (error && !settings) return <ErrorBanner message={error} onRetry={reload} />;
  if (!settings) return <Skeleton className="h-96" />;
  const plans = settings.monitoring?.plans ?? [];
  const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: n < 10 ? 2 : 0 })}`;
  return (
    <>
      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        {plans.map((p) => {
          const margin = p.pricePerCameraInr - r.perCamera;
          return (
            <Card key={p.code} className="flex flex-col p-5">
              <p className="text-[12px] font-semibold tracking-wide text-muted uppercase">{p.code}</p>
              <p className="text-[16px] font-bold text-ink">{p.name}</p>
              <p className="mt-1 text-[26px] font-bold text-ink tabular">{inr(p.pricePerCameraInr)}<span className="text-[13px] font-medium text-muted"> / camera / month</span></p>
              <ul className="mt-3 flex-1 space-y-1 text-[12.5px] text-body">{p.features.map((f) => <li key={f} className="flex gap-1.5"><Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />{f}</li>)}</ul>
              <p className={cx('mt-3 rounded-[10px] px-3 py-2 text-[12px]', margin >= 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800')}>Estimated margin at these assumptions: <b>{inr(margin)}</b> per camera ({p.pricePerCameraInr ? Math.round((margin / p.pricePerCameraInr) * 100) : 0}%)</p>
            </Card>
          );
        })}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <Card className="p-5">
          <p className="mb-1 text-[14px] font-semibold text-ink">Operating cost estimate</p>
          <p className="mb-4 flex items-start gap-1.5 text-[12px] text-muted"><Info className="mt-0.5 size-3.5 shrink-0" />Assumptions you can change. Fill in your own measured hosting bill, WhatsApp rate and support time; the ₹30 basic price is not assumed to be profitable until these are measured.</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Num label="Cameras" value={cameras} onChange={set('cameras')} hint={ov ? `this workspace: ${ov.kpis.cameras}` : undefined} />
            <Num label="Sites" value={sites} onChange={set('sites')} />
            <Num label="Check interval (s)" value={interval} onChange={set('interval')} />
            <Num label="Checks per camera per interval" value={checksPer} onChange={set('checksPer')} hint="reachability + stream" />
            <Num label="Hosting: server + DB + Redis (₹/month)" value={infra} onChange={set('infra')} hint="your actual bill" />
            <Num label="Event processing & storage (₹ per million events)" value={perMillion} onChange={set('perMillion')} />
            <Num label="Incidents per camera per month" value={incidents} onChange={set('incidents')} step="0.01" hint={measuredIncidents !== null ? `measured here: ${measuredIncidents.toFixed(2)}` : undefined} />
            <Num label="WhatsApp messages per incident" value={msgsPerIncident} onChange={set('msgs')} hint="alert, reply, restored, report" />
            <Num label="WhatsApp rate (₹/message)" value={waRate} onChange={set('waRate')} step="0.01" hint={waRate ? 'from Settings or edited' : 'set your Meta rate'} />
            <Num label="Support hours per site per month" value={supportHours} onChange={set('supportHours')} step="0.1" />
            <Num label="Support cost (₹/hour)" value={hourly} onChange={set('hourly')} />
            <Num label="Onboarding per camera (₹, over 12 months)" value={onboarding} onChange={set('onboarding')} />
          </div>
        </Card>
        <Card className="p-5">
          <p className="text-[12.5px] font-semibold text-muted">Estimated monthly cost</p>
          <p className="mt-1 text-[30px] font-bold text-ink tabular">{inr(r.total)}</p>
          <p className="text-[13px] text-body">{inr(r.perCamera)} per camera per month</p>
          <dl className="mt-4 space-y-1.5 text-[12.5px]">
            {[['Hosting', infra], ['Event processing', r.processing], ['WhatsApp', r.whatsapp], ['Support', r.support], ['Onboarding (amortised)', r.onboard]].map(([k, n]) => (
              <div key={k as string} className="flex justify-between gap-2"><dt className="text-muted">{k}</dt><dd className="font-semibold text-ink tabular">{inr(n as number)}</dd></div>
            ))}
          </dl>
          <p className="mt-3 text-[11.5px] text-muted">{Math.round(r.eventsMonth / 1000).toLocaleString('en-IN')}k health events per month at these settings.</p>
          <div className="mt-3"><Pill tone="amber">estimate · validate with measured usage</Pill></div>
        </Card>
      </div>
      <SourceNote api="GET /settings (monitoring.plans) · /monitoring/overview" />
    </>
  );
}

function Num({ label, value, onChange, hint, step }: { label: string; value: number; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; hint?: string; step?: string }) {
  return (
    <Label text={label}>
      <input type="number" min={0} step={step ?? '1'} className={inputCls} value={Number.isFinite(value) ? value : 0} onChange={onChange} />
      {hint && <span className="mt-0.5 block text-[11px] font-normal text-faint">{hint}</span>}
    </Label>
  );
}
