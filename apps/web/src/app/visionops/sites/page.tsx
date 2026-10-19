'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, HardDrive, MapPin, RadioTower, ShieldCheck, Wifi } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Card, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Dialog, IndustryOnly, inputCls } from '@/components/textile';
import { Pill, SearchBox, Section, SourceNote, Toolbar, when } from '@/components/vertical-ui';
import { Dot, INTERNET_LABEL, SeverityMark, ago, qs, type CameraRow, type Contract, type SiteRow } from '@/components/visionops';

type SiteDetail = Omit<SiteRow, 'recorders' | 'agents' | 'technicians' | 'customer' | 'cameras'> & {
  latitude: string | null; longitude: string | null;
  customer: { id: string; name: string; industry: string; contactName: string | null; contactPhone: string | null };
  recorders: Array<{ id: string; code: string; name: string; kind: string; manufacturer: string | null; model: string | null; status: string; storageStatus: string; storageDetail: string | null; recordingStatus: string; networkAddress: string | null; lastSeenAt: string | null }>;
  agents: Array<{ id: string; code: string; name: string; status: string; version: string | null; hostLabel: string | null; hasBackupLink: boolean; lastHeartbeatAt: string | null; queuedEvents: number }>;
  technicians: Array<{ id: string; name: string; role: string; phone: string; onCall: boolean }>;
  contracts: Contract[]; cameras: CameraRow[];
  incidents: Array<{ id: string; number: string; category: string; severity: 'critical' | 'high' | 'medium' | 'low'; status: string; firstDetectedAt: string; deviceCode: string | null }>;
};

export default function SitesPage() {
  return (
    <>
      <PageHeader title="Sites" />
      <IndustryOnly allow={['cctv']}><Sites /></IndustryOnly>
    </>
  );
}

function Sites() {
  const [customerId, setCustomerId] = useState('');
  const [health, setHealth] = useState<'all' | 'outage' | 'degraded' | 'unknown' | 'healthy'>('all');
  const [region, setRegion] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('site');
    if (id) setOpen(id);
  }, []);
  const { data: customers } = useApi<Array<{ id: string; name: string }>>('/monitoring/customers');
  const { data, error, reload } = useApi<SiteRow[]>(`/monitoring/sites${qs({ customerId, region, q: q.trim(), status: health === 'all' ? '' : health })}`, 30_000);
  const { data: allSites } = useApi<SiteRow[]>('/monitoring/sites', 60_000);
  const regions = useMemo(() => [...new Set((allSites ?? []).map((s) => s.region).filter(Boolean))] as string[], [allSites]);
  const close = useCallback(() => setOpen(null), []);
  const rows = (data ?? []).filter((s) => !s.code.startsWith('LAB-') || q);

  return (
    <>
      <Toolbar>
        <select aria-label="Customer" className={cx(inputCls.replace('w-full', 'w-auto min-w-[170px]'), 'h-10')} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">All customers</option>{(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select aria-label="Region" className={cx(inputCls.replace('w-full', 'w-auto min-w-[170px]'), 'h-10')} value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">All regions</option>{regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <Segmented label="Health" value={health} onChange={setHealth} options={[{ value: 'all', label: 'All' }, { value: 'outage', label: 'Outage' }, { value: 'degraded', label: 'Degraded' }, { value: 'unknown', label: 'Unknown' }, { value: 'healthy', label: 'Healthy' }]} />
        <SearchBox value={q} onChange={setQ} placeholder="Site, code or city" />
      </Toolbar>
      {error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data ? <Skeleton className="h-96" /> : (
        <>
          <SiteMap sites={rows} onOpen={setOpen} />
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => setOpen(s.id)} className="block h-full w-full text-left">
                  <Card className="h-full p-4 transition-shadow hover:shadow-md">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0"><p className="truncate font-semibold text-ink">{s.name}</p><p className="truncate text-[12px] text-muted">{s.code} · {s.customer.name}</p></div>
                      <Pill status={s.health} />
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                      {[['Online', s.online, 'text-emerald-700'], ['Offline', s.offline, 'text-rose-700'], ['Unknown', s.unknown, 'text-slate-500'], ['Incidents', s.activeIncidents, 'text-amber-700']].map(([l, v, c]) => (
                        <div key={l as string} className="rounded-[10px] bg-slate-50 py-1.5"><p className={cx('text-[18px] font-bold tabular', c as string)}>{v as number}</p><p className="text-[10.5px] text-muted">{l as string}</p></div>
                      ))}
                    </div>
                    <div className="mt-3 space-y-1 text-[12px] text-body">
                      <p className="flex items-center gap-1.5"><HardDrive className="size-3.5 text-muted" />{s.recorders.map((r) => `${r.code} ${r.status}`).join(', ') || 'No recorder'}</p>
                      <p className="flex items-center gap-1.5"><RadioTower className="size-3.5 text-muted" />{s.monitoringMode === 'cloud' ? 'Cloud checks' : s.agents.length ? s.agents.map((a) => `${a.code} ${a.status} (${ago(a.lastHeartbeatAt)})`).join(', ') : 'No agent registered'}</p>
                      <p className="flex items-center gap-1.5"><Wifi className="size-3.5 text-muted" />{INTERNET_LABEL[s.internetStatus] ?? s.internetStatus} · last healthy check {ago(s.lastHealthyCheckAt)}</p>
                      <p className="flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-muted" />{s.contract ? <>{s.contract.reference} · <Pill status={s.contract.status} className="ml-0.5">{s.contract.status === 'expiring' ? `expires in ${s.contract.daysLeft} d` : s.contract.status}</Pill></> : 'No contract'}</p>
                      <p className="truncate text-muted">Technician: {s.technicians.map((t) => t.name).join(', ') || '—'}</p>
                    </div>
                  </Card>
                </button>
              </li>
            ))}
          </ul>
          {!rows.length && <Card className="p-8 text-center text-[13px] text-muted">No sites match these filters.</Card>}
        </>
      )}
      <SourceNote api="GET /monitoring/sites · /monitoring/sites/:id" />
      <Dialog open={!!open} onClose={close} title="Site" wide>{open && <SiteDetailView id={open} />}</Dialog>
    </>
  );
}

/** Schematic map: sites placed by their GPS coordinates (no map tiles are loaded); colour = health. */
function SiteMap({ sites, onOpen }: { sites: SiteRow[]; onOpen: (id: string) => void }) {
  const pts = sites.map((s) => ({ s, lat: Number((s as unknown as { latitude: string | null }).latitude), lng: Number((s as unknown as { longitude: string | null }).longitude) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat !== 0);
  if (pts.length < 2) return null;
  const minLat = Math.min(...pts.map((p) => p.lat)), maxLat = Math.max(...pts.map((p) => p.lat));
  const minLng = Math.min(...pts.map((p) => p.lng)), maxLng = Math.max(...pts.map((p) => p.lng));
  const W = 1000, H = 280, pad = 48;
  const x = (lng: number) => pad + ((lng - minLng) / Math.max(1e-6, maxLng - minLng)) * (W - 2 * pad);
  const y = (lat: number) => H - pad - ((lat - minLat) / Math.max(1e-6, maxLat - minLat)) * (H - 2 * pad);
  // Points in the right half put their label on the left so it never runs off the edge.
  const flip = (lng: number) => x(lng) > W * 0.55;
  const color = (h: string) => (h === 'healthy' ? '#10b981' : h === 'outage' ? '#e11d48' : h === 'degraded' ? '#f59e0b' : '#94a3b8');
  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3"><p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink"><MapPin className="size-4 text-muted" />Site map</p><p className="text-[11px] text-muted">Schematic, from each site&apos;s GPS position</p></div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="block min-w-[520px]" role="img" aria-label="Sites by location and health">
          <rect x="0" y="0" width={W} height={H} fill="#f6f8fb" />
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="#e5e9f0" />)}
          {pts.map(({ s, lat, lng }) => (
            <g key={s.id} className="cursor-pointer" onClick={() => onOpen(s.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(s.id); }} aria-label={`${s.name}: ${s.health}`}>
              <circle cx={x(lng)} cy={y(lat)} r={14} fill={color(s.health)} opacity={0.18} />
              <circle cx={x(lng)} cy={y(lat)} r={7} fill={color(s.health)} stroke="#fff" strokeWidth={2} />
              <text x={flip(lng) ? x(lng) - 14 : x(lng) + 14} y={y(lat) - 9} textAnchor={flip(lng) ? 'end' : 'start'} fontSize={12} fontWeight={600} fill="#1f2937">{s.name}</text>
              <text x={flip(lng) ? x(lng) - 14 : x(lng) + 14} y={y(lat) + 6} textAnchor={flip(lng) ? 'end' : 'start'} fontSize={11} fill="#64748b">{s.online}/{s.cameras} online{s.activeIncidents ? ` · ${s.activeIncidents} incident${s.activeIncidents > 1 ? 's' : ''}` : ''}</text>
            </g>
          ))}
        </svg>
      </div>
    </Card>
  );
}

function SiteDetailView({ id }: { id: string }) {
  const { data: s, error, reload } = useApi<SiteDetail>(`/monitoring/sites/${id}`, 30_000);
  if (error && !s) return <ErrorBanner message={error} onRetry={reload} />;
  if (!s) return <Skeleton className="h-96" />;
  const lat = Number(s.latitude), lng = Number(s.longitude);
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
      <div>
        <h2 className="text-[18px] font-bold text-ink">{s.name}</h2>
        <p className="text-[13px] text-muted">{s.code} · {s.customer.name} ({s.customer.industry}) · {s.monitoringMode === 'cloud' ? 'cloud checks' : 'local agent'}</p>
        <p className="mt-1 text-[12.5px] text-body">{s.address}{Number.isFinite(lat) && lat ? <> · <a className="inline-flex items-center gap-0.5 font-semibold text-[#1e5bd8]" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`} target="_blank" rel="noreferrer">Map <ExternalLink className="size-3" /></a></> : null}</p>
        <p className="text-[12.5px] text-body">Contact: {s.customer.contactName ?? '—'} {s.customer.contactPhone ? `· ${s.customer.contactPhone}` : ''}</p>
        <Section title="Recorders">
          <ul className="space-y-2">{s.recorders.map((r) => (
            <li key={r.id} className="rounded-[12px] border border-line p-3 text-[12.5px]">
              <div className="flex items-center justify-between"><b className="text-ink">{r.code} · {r.manufacturer} {r.model}</b><Pill status={r.status} /></div>
              <p className="text-muted">{r.kind.toUpperCase()} · {r.networkAddress ?? '—'} · seen {ago(r.lastSeenAt)}</p>
              <p className="text-muted">Disk: {r.storageStatus}{r.storageDetail ? ` (${r.storageDetail})` : ''} · Recording: {r.recordingStatus === 'unsupported' ? 'not verifiable on this model' : r.recordingStatus}</p>
            </li>
          ))}</ul>
        </Section>
        <Section title="Monitoring agent">
          {s.agents.length ? s.agents.map((a) => (
            <div key={a.id} className="rounded-[12px] border border-line p-3 text-[12.5px]">
              <div className="flex items-center justify-between"><b className="text-ink">{a.code} · {a.hostLabel ?? a.name}</b><Pill status={a.status} /></div>
              <p className="text-muted">Last heartbeat {ago(a.lastHeartbeatAt)} · v{a.version ?? '—'} · {a.hasBackupLink ? '4G backup link' : 'no backup link'} · {a.queuedEvents} queued</p>
            </div>
          )) : <p className="text-[12.5px] text-muted">{s.monitoringMode === 'cloud' ? 'Cloud-checked site: no local agent.' : 'No agent registered yet (Technicians & agents page).'}</p>}
        </Section>
        <Section title="Contract & technicians">
          {s.contracts.map((c) => <p key={c.id} className="text-[12.5px]"><b>{c.reference}</b> · {c.kind.toUpperCase()} · plan {c.planCode} · SLA {c.slaHours} h · until {when(c.endDate).split(',')[0]} <Pill status={c.status} /></p>)}
          <ul className="mt-1 text-[12.5px] text-body">{s.technicians.map((t) => <li key={t.id}>{t.name} · {t.role}{t.onCall ? ' · on call' : ''} · {t.phone}</li>)}</ul>
          {!s.technicians.length && <p className="text-[12.5px] text-muted">Organization-wide technicians cover this site.</p>}
        </Section>
      </div>
      <div>
        <Section title={`Cameras · ${s.cameras.length}`}>
          <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {s.cameras.map((c) => (
              <li key={c.id}><Link href={`/visionops/cameras?q=${c.code}`} className="flex items-center gap-2 rounded-[10px] border border-line px-2.5 py-1.5 text-[12px] hover:bg-slate-50"><Dot status={c.status} /><span className="min-w-0"><b className="block text-ink">{c.code}</b><span className="block truncate text-muted">{c.name}</span></span></Link></li>
            ))}
          </ul>
        </Section>
        <Section title="Recent incidents">
          <ul className="space-y-1 text-[12.5px]">{s.incidents.map((i) => <li key={i.id}><Link href={`/visionops/incidents?open=${i.id}`} className="flex flex-wrap items-center gap-2 hover:underline"><SeverityMark s={i.severity} /><b>{i.number}</b>{i.category.replace(/_/g, ' ')}{i.deviceCode ? ` · ${i.deviceCode}` : ''} · {when(i.firstDetectedAt)}<Pill status={i.status} /></Link></li>)}</ul>
          {!s.incidents.length && <p className="text-[12.5px] text-muted">No incidents.</p>}
        </Section>
      </div>
    </div>
  );
}
