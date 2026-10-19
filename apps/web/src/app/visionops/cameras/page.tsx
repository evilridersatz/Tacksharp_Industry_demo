'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Download, HardDrive, Info, XCircle } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Dialog, IndustryOnly, Notice, errorText, inputCls } from '@/components/textile';
import { DataList, Pill, SearchBox, Section, SourceNote, Toolbar, when } from '@/components/vertical-ui';
import { METHOD_LABEL, Pager, ScopeFilters, SeverityMark, ago, downloadCsv, qs, type CameraRow, type SiteRow } from '@/components/visionops';

type CameraDetail = CameraRow & {
  site: { id: string; name: string; code: string }; recorder: { id: string; code: string; name: string; status: string } | null;
  events: Array<{ id: string; check: string; ok: boolean; observedAt: string; receivedAt: string; latencyMs: number | null; detail: string | null; source: string; replayed: boolean }>;
  incidents: Array<{ id: string; number: string; category: string; status: string; severity: 'critical' | 'high' | 'medium' | 'low'; firstDetectedAt: string; resolvedAt: string | null }>;
  limitations: string[];
};

export default function CamerasPage() {
  return (
    <>
      <PageHeader title="Cameras & recorders" />
      <IndustryOnly allow={['cctv']}><Cameras /></IndustryOnly>
    </>
  );
}

function Cameras() {
  const [scope, setScope] = useState({ customerId: '', siteId: '' });
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('q')) setQ(p.get('q')!);
    if (p.get('open')) setOpen(p.get('open'));
  }, []);
  const path = `/monitoring/cameras${qs({ ...scope, status, q: q.trim(), sort, page, pageSize: 25 })}`;
  const { data, error, reload } = useApi<{ total: number; page: number; pageSize: number; rows: CameraRow[] }>(path, 30_000);
  const { data: sites } = useApi<SiteRow[]>(`/monitoring/sites${qs({ customerId: scope.customerId })}`, 30_000);
  const close = useCallback(() => setOpen(null), []);
  const recorders = (sites ?? []).filter((s) => !scope.siteId || s.id === scope.siteId).flatMap((s) => s.recorders.map((r) => ({ ...r, site: s.name })));

  async function exportCsv() {
    const all: CameraRow[] = [];
    for (let p = 1; p <= 50; p++) {
      const r = await api.get<{ total: number; rows: CameraRow[] }>(`/monitoring/cameras${qs({ ...scope, status, q: q.trim(), sort, page: p, pageSize: 200 })}`);
      all.push(...r.rows);
      if (all.length >= r.total || !r.rows.length) break;
    }
    downloadCsv('camera-inventory.csv', ['Camera', 'Name', 'Site', 'Recorder', 'Channel', 'Address (masked)', 'Manufacturer', 'Model', 'Monitoring', 'Status', 'Stream', 'Recording', 'Last successful check', 'Last checked', 'Recording verified', 'Incident', 'Technician'],
      all.map((c) => [c.code, c.name, c.site.name, c.recorder?.code, c.channelNo, c.networkAddress, c.manufacturer, c.model, METHOD_LABEL[c.monitoringMethod] ?? c.monitoringMethod, c.status, c.streamStatus, c.recordingStatus, c.lastSeenAt, c.lastCheckAt, c.lastRecordingVerifiedAt, c.incident?.number, c.incident?.technician]));
  }

  return (
    <>
      <Section title={`Recorders · ${recorders.length}`}>
        <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          {recorders.map((r) => (
            <li key={r.code}><Card className="p-3"><div className="flex items-center justify-between gap-2"><p className="flex items-center gap-1.5 font-semibold text-ink"><HardDrive className="size-4 text-muted" />{r.code}</p><Pill status={r.status} /></div><p className="truncate text-[11.5px] text-muted">{r.site}</p><p className="text-[11.5px] text-muted">Disk: <Pill status={r.storageStatus} className="ml-0.5" /></p></Card></li>
          ))}
        </ul>
      </Section>
      <Toolbar>
        <ScopeFilters value={scope} onChange={(v) => { setScope(v); setPage(1); }} />
        <select aria-label="Status" className={cx(inputCls.replace('w-full', 'w-auto min-w-[170px]'), 'h-10')} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">Any status</option>{['online', 'degraded', 'offline', 'unknown', 'maintenance'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Sort" className={cx(inputCls.replace('w-full', 'w-auto min-w-[170px]'), 'h-10')} value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
          <option value="">Sort: site, camera</option><option value="status">Sort: most failed checks first</option><option value="lastSeen">Sort: longest without a successful check</option><option value="code">Sort: camera code</option>
        </select>
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Code, name, location or model" />
        <Button onClick={exportCsv}><Download className="size-4" /> CSV</Button>
      </Toolbar>
      {error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data ? <Skeleton className="h-96" /> : (
        <>
          <DataList
            rows={data.rows} rowKey={(r) => r.id} onOpen={(r) => setOpen(r.id)} empty="No cameras match these filters."
            columns={[
              { head: 'Camera', cell: (r) => <div><p className="whitespace-nowrap font-semibold text-ink">{r.code}{r.critical && <span className="ml-1.5 rounded bg-rose-50 px-1 text-[10px] font-bold text-rose-700 uppercase">critical</span>}</p><p className="text-[11.5px] text-muted">{r.name}</p></div> },
              { head: 'Site', cell: (r) => <div><p>{r.site.name}</p><p className="text-[11.5px] text-muted">{r.recorder ? `${r.recorder.code} · ch ${r.channelNo ?? '—'}` : 'No recorder'}</p></div> },
              { head: 'Address', cell: (r) => <code className="text-[12px] text-muted">{r.networkAddress ?? '—'}</code> },
              { head: 'Device', cell: (r) => <div><p>{r.manufacturer ?? '—'}</p><p className="text-[11.5px] text-muted">{r.model ?? ''}</p></div> },
              { head: 'Monitoring', cell: (r) => <span className="text-[12px]">{METHOD_LABEL[r.monitoringMethod] ?? r.monitoringMethod}</span> },
              { head: 'Status', cell: (r) => <Pill status={r.status} /> },
              { head: 'Last OK check', cell: (r) => <div className="whitespace-nowrap text-[12px]"><p>{ago(r.lastSeenAt)}</p><p className="text-[11px] text-muted">checked {ago(r.lastCheckAt)}</p></div> },
              { head: 'Recording', cell: (r) => <Pill status={r.recordingStatus}>{r.recordingStatus === 'unsupported' ? 'not verifiable' : r.recordingStatus.replace('_', ' ')}</Pill> },
              { head: 'Incident', cell: (r) => r.incident ? <div><p className="font-semibold text-ink">{r.incident.number}</p><p className="text-[11.5px] text-muted">{r.incident.technician ?? 'unassigned'}</p></div> : <span className="text-muted">—</span> },
            ]}
            card={(r) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="font-semibold text-ink">{r.code} · {r.name}</p><p className="truncate text-[12px] text-muted">{r.site.name} · seen {ago(r.lastSeenAt)}{r.incident ? ` · ${r.incident.number}` : ''}</p></div>
                <Pill status={r.status} />
              </div>
            )}
          />
          <Pager page={data.page} total={data.total} size={data.pageSize} onPage={setPage} />
        </>
      )}
      <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-muted"><Info className="mt-0.5 size-3.5 shrink-0" />Addresses are masked. Camera usernames, passwords and RTSP URLs are never stored in the cloud: they stay on the site agent.</p>
      <SourceNote api="GET /monitoring/cameras · /monitoring/cameras/:id" />
      <Dialog open={!!open} onClose={close} title="Camera" wide>{open && <CameraDetailView id={open} onChanged={reload} />}</Dialog>
    </>
  );
}

function CameraDetailView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, reload } = useApi<CameraDetail>(`/monitoring/cameras/${id}`);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-80" />;
  const c = data;
  async function maintenance(on: boolean) {
    setBusy(true);
    try {
      await api.post(`/monitoring/cameras/${c.id}/maintenance`, { on });
      setNotice({ tone: 'ok', text: on ? 'Maintenance mode on: failures will not open incidents.' : 'Maintenance mode off: status returns with the next check.' });
      await reload();
      onChanged();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2"><h2 className="text-[18px] font-bold text-ink">{c.code}</h2><Pill status={c.status} />{c.critical && <Pill tone="red">critical camera</Pill>}</div>
        <p className="text-[13px] text-body">{c.name}{c.location ? ` · ${c.location}` : ''} · <Link className="font-semibold text-[#1e5bd8]" href={`/visionops/sites?site=${c.site.id}`}>{c.site.name}</Link></p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-[12.5px]">
          <div><dt className="text-[11px] text-muted uppercase">Recorder</dt><dd>{c.recorder ? `${c.recorder.code} (${c.recorder.status}) · ch ${c.channelNo ?? '—'}` : '—'}</dd></div>
          <div><dt className="text-[11px] text-muted uppercase">Address</dt><dd><code>{c.networkAddress ?? '—'}</code></dd></div>
          <div><dt className="text-[11px] text-muted uppercase">Device</dt><dd>{[c.manufacturer, c.model].filter(Boolean).join(' ') || '—'}</dd></div>
          <div><dt className="text-[11px] text-muted uppercase">Monitoring</dt><dd>{METHOD_LABEL[c.monitoringMethod] ?? c.monitoringMethod}</dd></div>
          <div><dt className="text-[11px] text-muted uppercase">Last seen</dt><dd>{c.lastSeenAt ? when(c.lastSeenAt) : 'never'}</dd></div>
          <div><dt className="text-[11px] text-muted uppercase">Recording verified</dt><dd>{c.lastRecordingVerifiedAt ? when(c.lastRecordingVerifiedAt) : 'not verifiable'}</dd></div>
        </dl>
        <Section title="What this monitoring can prove">
          <ul className="space-y-1 text-[12.5px] text-body">{c.limitations.map((l) => <li key={l} className="flex gap-1.5"><Info className="mt-0.5 size-3.5 shrink-0 text-muted" />{l}</li>)}</ul>
          <div className="mt-2 flex flex-wrap gap-1.5">{Object.entries(c.capabilities).map(([k, v]) => <Pill key={k} tone={v ? 'green' : 'slate'}>{k}: {v ? 'checked' : 'not supported'}</Pill>)}</div>
        </Section>
        <Notice notice={notice} />
        <Button busy={busy} onClick={() => maintenance(c.status !== 'maintenance')}>{c.status === 'maintenance' ? 'End maintenance' : 'Put in maintenance'}</Button>
        <Section title="Incidents">
          {c.incidents.length ? <ul className="space-y-1 text-[12.5px]">{c.incidents.map((i) => <li key={i.id}><Link href={`/visionops/incidents?open=${i.id}`} className="flex items-center gap-2 hover:underline"><SeverityMark s={i.severity} /><b>{i.number}</b> {i.category.replace(/_/g, ' ')} · {when(i.firstDetectedAt)} <Pill status={i.status} /></Link></li>)}</ul> : <p className="text-[12.5px] text-muted">No incidents recorded.</p>}
        </Section>
      </div>
      <Section title={`Latest health checks · ${c.events.length}`}>
        {c.events.length ? (
          <ul className="max-h-[480px] space-y-1 overflow-y-auto pr-1 text-[12.5px]">
            {c.events.map((e) => (
              <li key={e.id} className="flex items-start gap-2 border-b border-line pb-1">
                {e.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-label="ok" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-600" aria-label="failed" />}
                <div className="min-w-0"><p className="text-ink">{e.check} · {when(e.observedAt)}{e.latencyMs !== null ? ` · ${e.latencyMs} ms` : ''}</p><p className="text-[11px] text-muted">{e.source}{e.replayed ? ' · sent late from the agent queue' : ''}{e.detail ? ` · ${e.detail}` : ''}</p></div>
              </li>
            ))}
          </ul>
        ) : <p className="text-[12.5px] text-muted">No checks received yet.</p>}
      </Section>
    </div>
  );
}
