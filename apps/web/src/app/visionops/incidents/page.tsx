'use client';

import { useCallback, useEffect, useState } from 'react';
import { BellRing, CheckCircle2, ClipboardList, Download, Wrench } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Dialog, IndustryOnly, Label, Notice, errorText, inputCls } from '@/components/textile';
import { DataList, Pill, SearchBox, Section, SimulatedNote, SourceNote, Stat, Timeline, Toolbar, when } from '@/components/vertical-ui';
import { Pager, STATE_LABEL, ScopeFilters, SeverityMark, ago, downloadCsv, dur, minutes, qs, type IncidentRow } from '@/components/visionops';

type Detail = IncidentRow & {
  timeline: Array<{ id: string; at: string; type: string; actor: string; message: string }>;
  notifications: Array<{ id: string; recipientType: string; recipientName: string | null; recipientPhone: string | null; channel: string; purpose: string; body: string; status: string; simulated: boolean; scheduledFor: string; sentAt: string | null; lastError: string | null }>;
  troubleshooting: string[]; technicians: Array<{ id: string; name: string; role: string; onCall: boolean }>; durationMinutes: number;
  restorationEvidence: Array<{ at: string; check: string; ok: boolean; source?: string }> | null; resolutionNote: string | null; closedAt: string | null; inProgressAt: string | null; assignedAt: string | null; restorationCheckAt: string | null;
  resolution?: { resolved: boolean; checksStillNeeded: number };
};

export default function IncidentsPage() {
  return (
    <>
      <PageHeader title="Incidents" />
      <IndustryOnly allow={['cctv']}><Incidents /></IndustryOnly>
    </>
  );
}

function Incidents() {
  const [status, setStatus] = useState<'active' | 'resolved' | 'all'>('active');
  const [severity, setSeverity] = useState('');
  const [scope, setScope] = useState({ customerId: '', siteId: '' });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open');
    if (id) setOpen(id);
  }, []);
  const path = `/monitoring/incidents${qs({ status, severity, customerId: scope.customerId, siteId: scope.siteId, q: q.trim(), page, pageSize: 25 })}`;
  const { data, error, reload } = useApi<{ total: number; page: number; pageSize: number; rows: IncidentRow[] }>(path, 20_000);
  const { data: activeAll } = useApi<{ total: number; rows: IncidentRow[] }>('/monitoring/incidents?status=active&pageSize=100', 20_000);
  const close = useCallback(() => setOpen(null), []);
  const act = activeAll?.rows ?? [];

  async function exportCsv() {
    const all: IncidentRow[] = [];
    for (let p = 1; p <= 20; p++) {
      const r = await api.get<{ total: number; rows: IncidentRow[] }>(`/monitoring/incidents${qs({ status, severity, customerId: scope.customerId, siteId: scope.siteId, q: q.trim(), page: p, pageSize: 100 })}`);
      all.push(...r.rows);
      if (all.length >= r.total || !r.rows.length) break;
    }
    downloadCsv(`incidents-${status}.csv`, ['Incident', 'Site', 'Customer', 'Device', 'Fault', 'Severity', 'Status', 'Detected', 'Acknowledged', 'Resolved', 'Minutes', 'Technician', 'Root cause', 'Resolved by'], all.map((i) => [i.number, i.site.name, i.site.customer?.name, i.deviceCode, i.categoryLabel, i.severity, i.status, i.firstDetectedAt, i.acknowledgedAt, i.resolvedAt, minutes(i.firstDetectedAt, i.resolvedAt), i.assignedTechnician?.name, i.rootCause, i.resolvedBy]));
  }

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active incidents" value={act.length} tone={act.length ? 'amber' : 'green'} hint={`${act.filter((i) => i.severity === 'critical').length} critical`} />
        <Stat label="Not acknowledged" value={act.filter((i) => !i.acknowledgedAt).length} tone={act.some((i) => !i.acknowledgedAt) ? 'red' : undefined} hint="Escalate after the deadline" />
        <Stat label="Waiting for restoration proof" value={act.filter((i) => i.status === 'RESTORATION_CHECK').length} hint="Fresh successful checks needed" />
        <Stat label="Escalated" value={act.filter((i) => i.escalationLevel > 0).length} hint="Supervisor / manager alerted" />
      </div>
      <Toolbar>
        <Segmented label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: 'active', label: 'Active' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]} />
        <select aria-label="Severity" className={cx(inputCls.replace('w-full', 'w-auto min-w-[150px]'), 'h-10')} value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }}>
          <option value="">All severities</option>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <ScopeFilters value={scope} onChange={(v) => { setScope(v); setPage(1); }} />
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="INC number or device" />
        <Button onClick={exportCsv}><Download className="size-4" /> CSV</Button>
      </Toolbar>
      {error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data ? <Skeleton className="h-80" /> : (
        <>
          <DataList
            rows={data.rows} rowKey={(r) => r.id} onOpen={(r) => setOpen(r.id)}
            empty={status === 'active' ? 'No active incidents. Every monitored device is reporting normally.' : 'No incidents match these filters.'}
            columns={[
              { head: 'Incident', cell: (r) => <div><p className="font-semibold text-ink">{r.number}</p><p className="text-[11.5px] text-muted">{r.categoryLabel}</p></div> },
              { head: 'Site / device', cell: (r) => <div><p className="text-ink">{r.site.name}</p><p className="text-[11.5px] text-muted">{r.deviceCode ?? r.deviceType}{r.affectedCount > 1 ? ` · ${r.affectedCount} cameras` : ''}</p></div> },
              { head: 'Severity', cell: (r) => <SeverityMark s={r.severity} /> },
              { head: 'Detected', cell: (r) => <div><p>{when(r.firstDetectedAt)}</p><p className="text-[11.5px] text-muted">{dur(minutes(r.firstDetectedAt, r.resolvedAt))}{r.resolvedAt ? ' downtime' : ' so far'}</p></div> },
              { head: 'Technician', cell: (r) => r.assignedTechnician?.name ?? <span className="text-muted">—</span> },
              { head: 'Status', cell: (r) => <div className="flex flex-col items-start gap-1"><Pill status={r.status}>{STATE_LABEL[r.status] ?? r.status}</Pill>{r.escalationLevel > 0 && !r.resolvedAt && <span className="text-[11px] font-semibold text-rose-700">Escalated L{r.escalationLevel}</span>}{r.reopenCount > 0 && <span className="text-[11px] text-muted">Reopened ×{r.reopenCount}</span>}</div> },
            ]}
            card={(r) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="font-semibold text-ink">{r.number} · {r.categoryLabel}</p><p className="truncate text-[12px] text-muted">{r.site.name} · {r.deviceCode ?? r.deviceType} · {dur(minutes(r.firstDetectedAt, r.resolvedAt))}</p><div className="mt-1"><SeverityMark s={r.severity} /></div></div>
                <Pill status={r.status}>{STATE_LABEL[r.status] ?? r.status}</Pill>
              </div>
            )}
          />
          <Pager page={data.page} total={data.total} size={data.pageSize} onPage={setPage} />
        </>
      )}
      <SourceNote api="GET /monitoring/incidents · /monitoring/incidents/:id" />
      <Dialog open={!!open} onClose={close} title="Incident" wide>
        {open && <IncidentDetail id={open} onChanged={reload} />}
      </Dialog>
    </>
  );
}

function IncidentDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, reload } = useApi<Detail>(`/monitoring/incidents/${id}`, 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tech, setTech] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [note, setNote] = useState('');
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  const i = data;
  const active = !['RESOLVED', 'CLOSED'].includes(i.status);
  async function run(name: string, path: string, body: unknown, ok: (r: Detail) => string) {
    setBusy(name);
    setNotice(null);
    try {
      const r = await api.post<Detail>(path, body);
      setNotice({ tone: 'ok', text: ok(r) });
      await reload();
      onChanged();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  const evidence = Array.isArray(i.restorationEvidence) ? i.restorationEvidence : [];
  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[18px] font-bold text-ink">{i.number}</h2>
          <Pill status={i.status}>{STATE_LABEL[i.status]}</Pill>
          <SeverityMark s={i.severity} />
          {i.isDemo && <Pill tone="cyan">demo</Pill>}
        </div>
        <p className="text-[14px] font-semibold text-ink">{i.title}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
          <Fact k="Customer" v={i.site.customer?.name} />
          <Fact k="Site" v={`${i.site.code} · ${i.site.name}`} />
          <Fact k="Device" v={i.deviceCode ?? i.deviceType} />
          <Fact k="Affected" v={i.affectedCount > 1 ? `${i.affectedCount} cameras: ${(i.affectedDevices ?? []).slice(0, 12).join(', ')}${(i.affectedDevices ?? []).length > 12 ? '…' : ''}` : '1 device'} />
          <Fact k="First detected" v={when(i.firstDetectedAt)} />
          <Fact k="Last checked" v={`${when(i.lastCheckedAt)} (${ago(i.lastCheckedAt)})`} />
          <Fact k="Duration" v={dur(i.durationMinutes)} />
          <Fact k="Acknowledged" v={i.acknowledgedAt ? `${when(i.acknowledgedAt)} · ${dur(minutes(i.firstDetectedAt, i.acknowledgedAt))} after` : 'Not yet'} />
          <Fact k="Technician" v={i.assignedTechnician?.name ?? 'Unassigned'} />
          <Fact k="Escalation" v={i.escalationLevel ? `Level ${i.escalationLevel}` : 'None'} />
          {i.rootCause && <Fact k="Root cause" v={i.rootCause} wide />}
          {i.resolutionNote && <Fact k="Resolution note" v={i.resolutionNote} wide />}
        </dl>

        {active && (
          <Card className="mt-4 p-4">
            <p className="mb-2 text-[13px] font-semibold text-ink">Work this incident</p>
            <Notice notice={notice} />
            <div className="flex flex-wrap gap-2">
              {!i.acknowledgedAt && <Button variant="primary" busy={busy === 'ack'} onClick={() => run('ack', `/monitoring/incidents/${i.id}/acknowledge`, {}, (r) => `${r.number} acknowledged.`)}>Acknowledge</Button>}
              {['OPEN', 'ACKNOWLEDGED', 'ASSIGNED'].includes(i.status) && <Button busy={busy === 'start'} onClick={() => run('start', `/monitoring/incidents/${i.id}/start`, {}, (r) => `${r.number} is in progress.`)}><Wrench className="size-4" /> Start work</Button>}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Label text="Assign to">
                <select className={cx(inputCls, 'h-9 min-w-[200px]')} value={tech} onChange={(e) => setTech(e.target.value)}>
                  <option value="">Choose a person</option>
                  {i.technicians.map((t) => <option key={t.id} value={t.id}>{t.name}{t.onCall ? ' · on call' : ''}</option>)}
                </select>
              </Label>
              <Button disabled={!tech} busy={busy === 'assign'} onClick={() => run('assign', `/monitoring/incidents/${i.id}/assign`, { technicianId: tech }, (r) => `Assigned to ${r.assignedTechnician?.name}.`)}>Assign</Button>
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Label text="Root cause (what was fixed)"><input className={cx(inputCls, 'h-9 min-w-[240px]')} value={rootCause} onChange={(e) => setRootCause(e.target.value)} placeholder="e.g. Loose PoE cable at switch port 14" /></Label>
              <Button busy={busy === 'resolve'} onClick={() => run('resolve', `/monitoring/incidents/${i.id}/resolve`, { rootCause }, (r) => r.resolution?.resolved ? `${r.number} resolved: fresh checks confirm restoration.` : `Recorded. ${r.number} waits for ${r.resolution?.checksStillNeeded ?? 'more'} fresh successful check(s) before it is resolved.`)}><CheckCircle2 className="size-4" /> Mark fixed</Button>
            </div>
            <p className="mt-2 text-[11.5px] text-muted">"Mark fixed" never resolves on its own: the incident is resolved only when the monitoring checks pass again.</p>
          </Card>
        )}
        {i.status === 'RESOLVED' && <div className="mt-4"><Button busy={busy === 'close'} onClick={() => run('close', `/monitoring/incidents/${i.id}/close`, { note: 'Confirmed with the customer' }, (r) => `${r.number} closed.`)}>Close incident</Button></div>}

        <Section title="Restoration evidence">
          {evidence.length ? (
            <ul className="space-y-1 text-[12.5px]">{evidence.map((e, k) => <li key={k} className="flex items-center gap-2"><CheckCircle2 className="size-3.5 text-emerald-600" />{e.check} OK at {when(e.at)}{e.source ? ` · ${e.source}` : ''}</li>)}</ul>
          ) : <p className="text-[12.5px] text-muted">{active ? 'No fresh successful checks yet.' : i.resolvedBy === 'correlation' ? 'Merged into another incident (same root cause).' : '—'}</p>}
        </Section>
        <Section title="First checks for the technician">
          <ol className="list-decimal space-y-1 pl-5 text-[12.5px] text-body">{i.troubleshooting.map((s) => <li key={s}>{s}</li>)}</ol>
        </Section>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Label text="Add a note"><input className={cx(inputCls, 'h-9 min-w-[260px]')} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Called the site; guard confirmed power cut" /></Label>
          <Button disabled={!note.trim()} busy={busy === 'note'} onClick={() => run('note', `/monitoring/incidents/${i.id}/note`, { message: note }, () => { setNote(''); return 'Note added.'; })}><ClipboardList className="size-4" /> Add</Button>
        </div>
      </div>
      <div className="min-w-0">
        <Section title={`Timeline · ${i.timeline.length} events`}>
          <Timeline items={i.timeline.map((t) => ({ label: t.type, actor: t.actor === 'system' ? 'monitoring engine' : t.actor.replace(/^technician:/, ''), at: t.at, note: t.message }))} />
        </Section>
        <Section title={`WhatsApp & escalation messages · ${i.notifications.length}`}>
          {i.notifications.some((n) => n.simulated) && <div className="mb-2"><SimulatedNote>Simulated: DRY_RUN or demo. Nothing was sent to WhatsApp; this is exactly what would be sent.</SimulatedNote></div>}
          <ul className="space-y-2">
            {i.notifications.map((n) => (
              <li key={n.id} className="rounded-[12px] border border-line p-3">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-muted">
                  <span className="flex items-center gap-1.5"><BellRing className="size-3.5" /><b className="text-ink capitalize">{n.purpose.replace('_', ' ')}</b> → {n.recipientName ?? n.recipientType} ({n.recipientType}) · {n.recipientPhone}</span>
                  <Pill status={n.status} />
                </div>
                <p className="text-[12.5px] whitespace-pre-wrap text-body">{n.body}</p>
                <p className="mt-1 text-[11px] text-faint">{n.sentAt ? when(n.sentAt) : `due ${when(n.scheduledFor)}`}{n.status === 'deferred' ? ' · waiting for quiet hours to end' : ''}</p>
              </li>
            ))}
          </ul>
          {!i.notifications.length && <p className="text-[12.5px] text-muted">No messages yet.</p>}
        </Section>
      </div>
    </div>
  );
}

function Fact({ k, v, wide }: { k: string; v: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <dt className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">{k}</dt>
      <dd className="text-ink">{v ?? '—'}</dd>
    </div>
  );
}
