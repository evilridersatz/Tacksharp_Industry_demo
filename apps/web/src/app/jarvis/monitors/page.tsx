'use client';

import { useEffect, useState } from 'react';
import { Play, Save } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, ErrorBanner, Segmented, Skeleton } from '@/components/ui';
import { toast } from '@/components/toast';
import { AlertList, FormField, SectionCard, type JarvisAlert, type JarvisSettings, type MonitorId, type Overview } from '@/components/jarvis';

const input = 'h-9 w-full rounded-[10px] border border-line bg-white px-3 text-[13.5px] text-ink outline-none focus:border-slate-400';

export default function JarvisMonitorsPage() {
  const overview = useApi<Overview>('/jarvis/overview', 0);
  const alerts = useApi<{ items: JarvisAlert[] }>('/jarvis/alerts', 30_000);
  const [form, setForm] = useState<JarvisSettings | null>(null);
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (overview.data && !form) setForm(overview.data.settings); }, [overview.data, form]);

  const run = async () => {
    setBusy('run');
    try {
      const r = await api.post<{ raised: JarvisAlert[]; checked: number }>('/jarvis/monitors/run');
      toast(r.raised.length ? `${r.raised.length} new alert(s).` : r.checked ? 'Nothing new: these alerts were already raised today.' : 'All clear.');
      alerts.reload();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(null); }
  };
  const save = async () => {
    if (!form) return;
    setBusy('save');
    try { setForm(await api.put<JarvisSettings>('/jarvis/settings', form)); toast('Jarvis settings saved.'); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(null); }
  };
  const setMon = (id: MonitorId, patch: Partial<{ on: boolean; threshold: number }>) => setForm((f) => (f ? { ...f, monitors: { ...f.monitors, [id]: { ...f.monitors[id], ...patch } } } : f));
  const items = (alerts.data?.items ?? []).filter((a) => show === 'all' || !a.resolved);
  const info = overview.data?.monitorInfo;

  return (
    <>
      <PageHeader title="Monitors & alerts" crumb="Jarvis" actions={<Button onClick={() => void run()} busy={busy === 'run'}><Play className="size-4" aria-hidden /> Check now</Button>} />
      {(overview.error || alerts.error) && !overview.data && <ErrorBanner message={overview.error ?? alerts.error ?? ''} onRetry={overview.reload} />}
      <SectionCard title="Alerts" subtitle="Shown here and as a notice on every open dashboard. Kept 30 days." action={<Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />}>
        {alerts.data ? <AlertList alerts={items} onResolved={alerts.reload} /> : <Skeleton className="m-4 h-24" />}
      </SectionCard>

      {!form || !info ? <Skeleton className="h-96" /> : (
        <SectionCard title="Settings" subtitle="Changing these needs the “manage agents” right." action={<Button variant="primary" onClick={() => void save()} busy={busy === 'save'}><Save className="size-4" aria-hidden /> Save</Button>}>
          <div className="grid gap-4 px-4 pb-4 md:grid-cols-3">
            <FormField label="Daily briefing">
              <select className={input} value={form.digest.on ? 'on' : 'off'} onChange={(e) => setForm({ ...form, digest: { ...form.digest, on: e.target.value === 'on' } })}><option value="on">On</option><option value="off">Off</option></select>
            </FormField>
            <FormField label="Briefing time (India)">
              <input type="time" className={input} value={`${String(form.digest.hour).padStart(2, '0')}:${String(form.digest.minute).padStart(2, '0')}`} onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); if (Number.isFinite(h) && Number.isFinite(m)) setForm({ ...form, digest: { ...form.digest, hour: h, minute: m } }); }} />
            </FormField>
            <FormField label="Check every (minutes)">
              <input type="number" min={5} max={240} className={input} value={form.monitorEveryMin} onChange={(e) => setForm({ ...form, monitorEveryMin: Number(e.target.value) })} />
            </FormField>
          </div>
          <ul className="divide-y divide-line border-t border-line">
            {(Object.keys(info) as MonitorId[]).map((id) => (
              <li key={id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <label className="flex min-w-[220px] flex-1 items-start gap-2.5">
                  <input type="checkbox" className="mt-1 size-4" checked={form.monitors[id].on} onChange={(e) => setMon(id, { on: e.target.checked })} />
                  <span><span className="block text-[13.5px] font-semibold text-ink">{info[id].label}</span><span className="block text-[12px] text-muted">{info[id].help}</span></span>
                </label>
                <label className="flex w-48 shrink-0 items-center gap-2 text-[12.5px] text-body">
                  <input type="number" min={0} className="h-9 w-24 rounded-[10px] border border-line bg-white px-3 text-[13.5px] text-ink outline-none focus:border-slate-400 disabled:bg-slate-50 disabled:text-muted" value={form.monitors[id].threshold} disabled={!form.monitors[id].on} onChange={(e) => setMon(id, { threshold: Number(e.target.value) })} aria-label={`${info[id].label} threshold`} />
                  <span className="whitespace-nowrap">{info[id].unit}</span>
                </label>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </>
  );
}
