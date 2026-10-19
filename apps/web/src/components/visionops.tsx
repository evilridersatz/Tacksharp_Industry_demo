'use client';

import type { ReactNode } from 'react';
import { useApi } from '@/lib/api';
import { Button, cx } from './ui';
import { inputCls } from './textile';

/** Shared types and helpers for the VisionOps (CCTV monitoring) pages. All data comes from /monitoring/*. */

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentRow = {
  id: string; number: string; title: string; category: string; categoryLabel: string; severity: Severity; status: string; deviceType: string; deviceCode: string | null;
  affectedCount: number; affectedDevices: string[] | null; firstDetectedAt: string; lastCheckedAt: string; acknowledgedAt: string | null; resolvedAt: string | null; resolvedBy: string | null;
  rootCause: string | null; reopenCount: number; escalationLevel: number; isDemo: boolean;
  site: { id: string; name: string; code: string; customer?: { id: string; name: string; contactName?: string | null } };
  assignedTechnician: { id: string; name: string; role?: string } | null;
};
export type SiteRow = {
  id: string; code: string; name: string; address: string | null; city: string | null; region: string | null; monitoringMode: string; internetStatus: string; lastHealthyCheckAt: string | null;
  customer: { id: string; name: string; industry: string }; cameras: number; online: number; offline: number; unknown: number; degraded: number;
  recorders: Array<{ code: string; status: string; storageStatus: string }>; agents: Array<{ code: string; status: string; lastHeartbeatAt: string | null; hasBackupLink: boolean; queuedEvents: number }>;
  activeIncidents: number; worstSeverity: Severity | null; health: 'healthy' | 'degraded' | 'outage' | 'unknown';
  technicians: Array<{ id: string; name: string; onCall: boolean }>; contract: Contract | null; isDemo: boolean;
};
export type Contract = { id: string; reference: string; kind: string; planCode: string; startDate: string; endDate: string; slaHours: number; responseMinutes: number; cameraLimit: number | null; monthlyFee: number | null; status: 'active' | 'expiring' | 'expired'; daysLeft: number };
export type CameraRow = {
  id: string; code: string; name: string; location: string | null; site: { id: string; name: string; code: string }; recorder: { id: string; code: string; status: string } | null; channelNo: number | null;
  networkAddress: string | null; manufacturer: string | null; model: string | null; monitoringMethod: string; capabilities: Record<string, boolean>; critical: boolean;
  status: string; streamStatus: string; recordingStatus: string; lastSeenAt: string | null; lastCheckAt: string | null; lastRecordingVerifiedAt: string | null;
  incident: { id: string; number: string; category: string; severity: Severity; status: string; technician: string | null } | null; isDemo: boolean;
};

export const METHOD_LABEL: Record<string, string> = { agent_tcp: 'Agent · TCP', agent_onvif: 'Agent · ONVIF', agent_rtsp: 'Agent · RTSP', vendor_api: 'Agent · vendor API', cloud_tcp: 'Cloud · TCP' };
export const STATE_LABEL: Record<string, string> = { OPEN: 'Open', ACKNOWLEDGED: 'Acknowledged', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', RESTORATION_CHECK: 'Restoration check', RESOLVED: 'Resolved', CLOSED: 'Closed' };
export const INTERNET_LABEL: Record<string, string> = { online: 'Internet OK', backup_link: 'On 4G backup', suspected_outage: 'Outage suspected', unknown: 'Unknown' };

export function minutes(from: string, to?: string | null) {
  return Math.max(0, Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 60_000));
}
export function dur(min: number | null | undefined) {
  if (min === null || min === undefined) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
export function ago(iso: string | null | undefined) {
  if (!iso) return 'never';
  const m = minutes(iso);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
}

export function SeverityMark({ s }: { s: Severity | null | undefined }) {
  if (!s) return null;
  const c = { critical: 'bg-rose-600', high: 'bg-amber-500', medium: 'bg-sky-500', low: 'bg-slate-400' }[s];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink capitalize">
      <span className={cx('h-3.5 w-1.5 rounded-full', c)} aria-hidden />
      {s}
    </span>
  );
}

/** Small health dot for status strips (shape + colour, with a text label for screen readers). */
export function Dot({ status, label }: { status: string; label?: string }) {
  const c = status === 'online' || status === 'healthy' || status === 'ok' ? 'bg-emerald-500' : status === 'offline' || status === 'outage' ? 'bg-rose-500' : status === 'degraded' ? 'bg-amber-400' : 'bg-slate-300';
  return <span className={cx('inline-block size-2.5 shrink-0 rounded-full', c)} role="img" aria-label={label ?? status} title={label ?? status} />;
}

/** Customer / site / region filters shared by the list pages (values are ids; options from the API). */
export function ScopeFilters({ value, onChange, extra }: { value: { customerId: string; siteId: string }; onChange: (v: { customerId: string; siteId: string }) => void; extra?: ReactNode }) {
  const { data: customers } = useApi<Array<{ id: string; name: string }>>('/monitoring/customers');
  const { data: sites } = useApi<SiteRow[]>(`/monitoring/sites${value.customerId ? `?customerId=${value.customerId}` : ''}`);
  return (
    <>
      <select aria-label="Customer" className={cx(inputCls.replace('w-full', 'w-auto'), 'h-10 min-w-0 flex-[0_1_200px]')} value={value.customerId} onChange={(e) => onChange({ customerId: e.target.value, siteId: '' })}>
        <option value="">All customers</option>
        {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select aria-label="Site" className={cx(inputCls.replace('w-full', 'w-auto'), 'h-10 min-w-0 flex-[0_1_200px]')} value={value.siteId} onChange={(e) => onChange({ ...value, siteId: e.target.value })}>
        <option value="">All sites</option>
        {(sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
      </select>
      {extra}
    </>
  );
}

export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};

/** CSV download built in the browser from rows already authorised by the API (no secrets are in these rows). */
export function downloadCsv(name: string, header: string[], rows: Array<Array<string | number | null | undefined>>) {
  const cell = (v: string | number | null | undefined) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const blob = new Blob([[header, ...rows].map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Page controls for server-paginated lists. */
export function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return <p className="mt-2 text-[12px] text-muted">{total} record{total === 1 ? '' : 's'}</p>;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
      <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="tabular">Page {page} of {pages} · {total} records</span>
      <Button disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}

