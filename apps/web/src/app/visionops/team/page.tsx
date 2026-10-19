'use client';

import { useState } from 'react';
import { Copy, KeyRound, Plus, RotateCw, ShieldOff } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { IndustryOnly, Label, Notice, errorText, inputCls } from '@/components/textile';
import { DataList, Pill, SourceNote, when } from '@/components/vertical-ui';
import { ago, type Contract, type SiteRow } from '@/components/visionops';

type Tech = { id: string; name: string; phone: string; role: string; onCall: boolean; active: boolean; whatsappConsent: boolean; siteId: string | null; site: { name: string; code: string } | null; shift: { days?: number[]; start?: string; end?: string } | null };
type Agent = { id: string; code: string; name: string; status: string; version: string | null; hostLabel: string | null; hasBackupLink: boolean; lastHeartbeatAt: string | null; queuedEvents: number; tokenPrefix: string; staleAfterMinutes: number; isDemo: boolean; site: { name: string; code: string } };
type Customer = { id: string; name: string; industry: string; region: string | null; contactName: string | null; contactPhone: string | null; notifyOnResolution: boolean; sites: number; contract: Contract | null };

export default function TeamPage() {
  const [tab, setTab] = useState<'technicians' | 'agents' | 'setup' | 'contracts'>('technicians');
  return (
    <>
      <PageHeader title="Technicians & agents" />
      <IndustryOnly allow={['cctv']}>
        <div className="mb-4"><Segmented label="Section" value={tab} onChange={setTab} options={[{ value: 'technicians', label: 'Technicians' }, { value: 'agents', label: 'Local agents' }, { value: 'setup', label: 'Customers, sites & devices' }, { value: 'contracts', label: 'Contracts' }]} /></div>
        {tab === 'technicians' && <Technicians />}
        {tab === 'agents' && <Agents />}
        {tab === 'setup' && <Setup />}
        {tab === 'contracts' && <Contracts />}
      </IndustryOnly>
    </>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Technicians() {
  const { data, error, reload } = useApi<Tech[]>('/monitoring/technicians');
  const { data: sites } = useApi<SiteRow[]>('/monitoring/sites');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', role: 'technician', siteId: '', onCall: false });
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    try {
      await api.post('/monitoring/technicians', { ...form, siteId: form.siteId || null, shift: { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00' } });
      setNotice({ tone: 'ok', text: `${form.name} added. Alerts go to them on WhatsApp (simulated under DRY_RUN).` });
      setForm({ name: '', phone: '', role: 'technician', siteId: '', onCall: false });
      await reload();
    } catch (e) { setNotice({ tone: 'error', text: errorText(e) }); } finally { setBusy(false); }
  }
  async function toggle(t: Tech, patch: Partial<Tech>) {
    try { await api.patch(`/monitoring/technicians/${t.id}`, patch); await reload(); } catch (e) { setNotice({ tone: 'error', text: errorText(e) }); }
  }
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-80" />;
  return (
    <>
      <p className="mb-3 text-[12.5px] text-muted">Alerts go to the site&apos;s technician on shift (on-call people outside shifts). Unacknowledged incidents escalate to the supervisor, then the manager.</p>
      <Notice notice={notice} />
      <DataList rows={data} rowKey={(t) => t.id}
        columns={[
          { head: 'Name', cell: (t) => <div><p className="font-semibold text-ink">{t.name}</p><p className="text-[11.5px] text-muted">{t.phone}</p></div> },
          { head: 'Role', cell: (t) => <Pill tone={t.role === 'manager' ? 'violet' : t.role === 'supervisor' ? 'blue' : 'slate'}>{t.role}</Pill> },
          { head: 'Covers', cell: (t) => t.site ? `${t.site.code} · ${t.site.name}` : 'All sites' },
          { head: 'Shift (IST)', cell: (t) => t.shift?.start ? `${(t.shift.days ?? []).map((d) => DAYS[d]).join(' ')} ${t.shift.start}–${t.shift.end}` : 'Always' },
          { head: 'On call', cell: (t) => <button type="button" onClick={() => toggle(t, { onCall: !t.onCall })} className={cx('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', t.onCall ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600')}>{t.onCall ? 'On call' : 'Off'}</button> },
          { head: 'WhatsApp', cell: (t) => t.whatsappConsent ? <Pill tone="green">consented</Pill> : <Pill tone="slate">no consent</Pill> },
          { head: 'Active', cell: (t) => <button type="button" onClick={() => toggle(t, { active: !t.active })} className="text-[12px] font-semibold text-[#1e5bd8]">{t.active ? 'Deactivate' : 'Activate'}</button> },
        ]}
        card={(t) => <div className="flex items-center justify-between gap-2"><div><p className="font-semibold text-ink">{t.name}</p><p className="text-[12px] text-muted">{t.role} · {t.site?.name ?? 'All sites'}</p></div>{t.onCall && <Pill tone="green">on call</Pill>}</div>}
      />
      <Card className="mt-4 p-4">
        <p className="mb-2 text-[13px] font-semibold text-ink">Add a person</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Label text="Name"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Label>
          <Label text="WhatsApp number"><input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91 98…" inputMode="tel" /></Label>
          <Label text="Role"><select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="technician">Technician</option><option value="supervisor">Supervisor (escalation L1)</option><option value="manager">Manager (escalation L2)</option></select></Label>
          <Label text="Site"><select className={inputCls} value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">All sites</option>{(sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></Label>
          <div className="flex items-end gap-3"><label className="flex items-center gap-2 pb-2 text-[12.5px]"><input type="checkbox" checked={form.onCall} onChange={(e) => setForm({ ...form, onCall: e.target.checked })} /> On call</label><Button variant="primary" busy={busy} disabled={!form.name || !form.phone} onClick={add}><Plus className="size-4" /> Add</Button></div>
        </div>
      </Card>
      <SourceNote api="GET/POST /monitoring/technicians · PATCH /monitoring/technicians/:id" />
    </>
  );
}

function Agents() {
  const { data, error, reload } = useApi<Agent[]>('/monitoring/agents', 30_000);
  const { data: sites } = useApi<SiteRow[]>('/monitoring/sites');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [token, setToken] = useState<{ token: string; for: string } | null>(null);
  const [form, setForm] = useState({ siteId: '', code: '', hasBackupLink: false });
  const [busy, setBusy] = useState<string | null>(null);
  async function call(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try { await fn(); await reload(); } catch (e) { setNotice({ tone: 'error', text: errorText(e) }); } finally { setBusy(null); }
  }
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-80" />;
  const configJson = token ? JSON.stringify({ cloudUrl: typeof window !== 'undefined' ? window.location.origin.replace('platform.', 'platform-api.') : '', token: token.token, intervalSeconds: 60, queueFile: './visionops-queue.jsonl', devices: [{ code: 'NVR-01', type: 'recorder', host: '192.168.1.10', port: 80 }, { code: 'CAM-001', type: 'camera', host: '192.168.1.21', port: 80, rtspPort: 554, checks: ['stream'] }] }, null, 2) : '';
  return (
    <>
      <p className="mb-3 text-[12.5px] text-muted">A local agent runs on a PC or gateway at the site, checks only the devices you list, keeps results while the internet is down and syncs them later. Camera passwords stay in its local config; footage never leaves the site.</p>
      <Notice notice={notice} />
      {token && (
        <Card className="mb-4 border-amber-300 bg-amber-50 p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-900"><KeyRound className="size-4" /> Token for {token.for}: shown only now</p>
          <div className="mt-2 flex flex-wrap items-center gap-2"><code className="max-w-full overflow-x-auto rounded bg-white px-2 py-1 text-[12px]">{token.token}</code><Button onClick={() => { void navigator.clipboard?.writeText(token.token).catch(() => undefined); }}><Copy className="size-4" /> Copy</Button></div>
          <details className="mt-2 text-[12px]"><summary className="cursor-pointer font-semibold">Agent config (agent.config.json)</summary><pre className="mt-1 max-h-60 overflow-auto rounded bg-white p-2 text-[11.5px]">{configJson}</pre></details>
          <p className="mt-1 text-[11.5px] text-amber-900">Run: <code>node agent.mjs --config agent.config.json</code> (apps/monitoring-agent). The cloud stores only a hash of this token.</p>
        </Card>
      )}
      <DataList rows={data} rowKey={(a) => a.id}
        columns={[
          { head: 'Agent', cell: (a) => <div><p className="font-semibold text-ink">{a.code}{a.isDemo && <span className="ml-1 text-[10.5px] font-semibold text-cyan-700">demo</span>}</p><p className="text-[11.5px] text-muted">{a.hostLabel ?? a.name}</p></div> },
          { head: 'Site', cell: (a) => `${a.site.code} · ${a.site.name}` },
          { head: 'Status', cell: (a) => <Pill status={a.status}>{a.status.replace('_', ' ')}</Pill> },
          { head: 'Last heartbeat', cell: (a) => <span className={cx(a.lastHeartbeatAt && Date.now() - new Date(a.lastHeartbeatAt).getTime() > a.staleAfterMinutes * 60_000 && 'font-semibold text-rose-700')}>{ago(a.lastHeartbeatAt)}</span> },
          { head: 'Backup link', cell: (a) => (a.hasBackupLink ? '4G' : '—') },
          { head: 'Queued', cell: (a) => a.queuedEvents, align: 'right' },
          { head: 'Token', cell: (a) => <code className="text-[11.5px] text-muted">{a.tokenPrefix}.••••</code> },
          { head: '', cell: (a) => a.isDemo ? <span className="text-[11.5px] text-muted">simulated</span> : (
            <div className="flex gap-1.5">
              <Button busy={busy === `r${a.id}`} onClick={() => call(`r${a.id}`, async () => { const r = await api.post<{ token: string }>(`/monitoring/agents/${a.id}/rotate`, {}); setToken({ token: r.token, for: a.code }); })}><RotateCw className="size-3.5" /> Rotate</Button>
              {a.status !== 'revoked' && <Button busy={busy === `v${a.id}`} onClick={() => call(`v${a.id}`, async () => { await api.post(`/monitoring/agents/${a.id}/revoke`, {}); setNotice({ tone: 'ok', text: `${a.code} revoked: its token stops working now.` }); })}><ShieldOff className="size-3.5" /> Revoke</Button>}
            </div>
          ) },
        ]}
        card={(a) => <div className="flex items-center justify-between gap-2"><div><p className="font-semibold text-ink">{a.code}</p><p className="text-[12px] text-muted">{a.site.name} · {ago(a.lastHeartbeatAt)}</p></div><Pill status={a.status} /></div>}
      />
      <Card className="mt-4 p-4">
        <p className="mb-2 text-[13px] font-semibold text-ink">Register an agent</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Label text="Site"><select className={inputCls} value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">Choose a site</option>{(sites ?? []).filter((s) => s.monitoringMode !== 'cloud').map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></Label>
          <Label text="Agent code (optional)"><input className={inputCls} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="AGT-SITE" /></Label>
          <label className="flex items-end gap-2 pb-2 text-[12.5px]"><input type="checkbox" checked={form.hasBackupLink} onChange={(e) => setForm({ ...form, hasBackupLink: e.target.checked })} /> Has a 4G backup link</label>
          <div className="flex items-end"><Button variant="primary" disabled={!form.siteId} busy={busy === 'reg'} onClick={() => call('reg', async () => { const r = await api.post<{ token: string; agent: { code: string } }>('/monitoring/agents', form); setToken({ token: r.token, for: r.agent.code }); setForm({ siteId: '', code: '', hasBackupLink: false }); })}><Plus className="size-4" /> Register</Button></div>
        </div>
      </Card>
      <SourceNote api="GET/POST /monitoring/agents · agents call POST /monitoring/agent/heartbeat and /monitoring/agent/events with their token" />
    </>
  );
}

function Setup() {
  const { data: customers, reload: rc } = useApi<Customer[]>('/monitoring/customers');
  const { data: sites, reload: rs } = useApi<SiteRow[]>('/monitoring/sites');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [c, setC] = useState({ name: '', industry: 'retail', contactName: '', contactPhone: '', notifyOnResolution: true });
  const [s, setS] = useState({ customerId: '', code: '', name: '', city: '', region: '', monitoringMode: 'local_agent' });
  const [d, setD] = useState({ kind: 'camera', siteId: '', code: '', name: '', networkAddress: '', manufacturer: '', model: '', recorderCode: '', stream: false, recording: false, critical: false });
  const [busy, setBusy] = useState<string | null>(null);
  const site = (sites ?? []).find((x) => x.id === d.siteId);
  async function go(name: string, fn: () => Promise<string>) {
    setBusy(name);
    try { setNotice({ tone: 'ok', text: await fn() }); await Promise.all([rc(), rs()]); } catch (e) { setNotice({ tone: 'error', text: errorText(e) }); } finally { setBusy(null); }
  }
  return (
    <>
      <Notice notice={notice} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-4">
          <p className="mb-2 text-[13px] font-semibold text-ink">Customers · {customers?.length ?? 0}</p>
          <ul className="mb-3 space-y-1 text-[12.5px]">{(customers ?? []).map((x) => <li key={x.id} className="flex justify-between gap-2"><span>{x.name} <span className="text-muted">· {x.industry}</span></span><span className="text-muted">{x.sites} site{x.sites === 1 ? '' : 's'}</span></li>)}</ul>
          <div className="space-y-2">
            <Label text="Name"><input className={inputCls} value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Label>
            <Label text="Industry"><select className={inputCls} value={c.industry} onChange={(e) => setC({ ...c, industry: e.target.value })}>{['retail', 'warehouse', 'hospital', 'factory', 'school', 'apartment', 'hotel', 'office', 'other'].map((x) => <option key={x}>{x}</option>)}</select></Label>
            <Label text="Contact name"><input className={inputCls} value={c.contactName} onChange={(e) => setC({ ...c, contactName: e.target.value })} /></Label>
            <Label text="Contact WhatsApp"><input className={inputCls} value={c.contactPhone} onChange={(e) => setC({ ...c, contactPhone: e.target.value })} inputMode="tel" /></Label>
            <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={c.notifyOnResolution} onChange={(e) => setC({ ...c, notifyOnResolution: e.target.checked })} /> Send resolution reports</label>
            <Button variant="primary" disabled={!c.name} busy={busy === 'c'} onClick={() => go('c', async () => { await api.post('/monitoring/customers', c); setC({ ...c, name: '', contactName: '', contactPhone: '' }); return 'Customer added.'; })}><Plus className="size-4" /> Add customer</Button>
          </div>
        </Card>
        <Card className="p-4">
          <p className="mb-2 text-[13px] font-semibold text-ink">Add a site</p>
          <div className="space-y-2">
            <Label text="Customer"><select className={inputCls} value={s.customerId} onChange={(e) => setS({ ...s, customerId: e.target.value })}><option value="">Choose</option>{(customers ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Label>
            <div className="grid grid-cols-2 gap-2"><Label text="Code"><input className={inputCls} value={s.code} onChange={(e) => setS({ ...s, code: e.target.value })} placeholder="CHN-WH-03" /></Label><Label text="City"><input className={inputCls} value={s.city} onChange={(e) => setS({ ...s, city: e.target.value })} /></Label></div>
            <Label text="Site name"><input className={inputCls} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Label>
            <Label text="Region"><input className={inputCls} value={s.region} onChange={(e) => setS({ ...s, region: e.target.value })} /></Label>
            <Label text="Monitoring"><select className={inputCls} value={s.monitoringMode} onChange={(e) => setS({ ...s, monitoringMode: e.target.value })}><option value="local_agent">Local agent (recommended)</option><option value="cloud">Cloud checks of public endpoints</option></select></Label>
            <Button variant="primary" disabled={!s.customerId || !s.code || !s.name} busy={busy === 's'} onClick={() => go('s', async () => { await api.post('/monitoring/sites', s); setS({ ...s, code: '', name: '' }); return 'Site added. Register an agent for it on the Local agents tab.'; })}><Plus className="size-4" /> Add site</Button>
          </div>
        </Card>
        <Card className="p-4">
          <p className="mb-2 text-[13px] font-semibold text-ink">Add a camera or recorder</p>
          <div className="space-y-2">
            <Segmented label="Device" value={d.kind as 'camera' | 'recorder'} onChange={(v) => setD({ ...d, kind: v })} options={[{ value: 'camera', label: 'Camera' }, { value: 'recorder', label: 'NVR / DVR' }]} />
            <Label text="Site"><select className={inputCls} value={d.siteId} onChange={(e) => setD({ ...d, siteId: e.target.value })}><option value="">Choose</option>{(sites ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></Label>
            <div className="grid grid-cols-2 gap-2"><Label text="Code"><input className={inputCls} value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} placeholder={d.kind === 'camera' ? 'CAM-051' : 'NVR-06'} /></Label><Label text="IP / host[:port]"><input className={inputCls} value={d.networkAddress} onChange={(e) => setD({ ...d, networkAddress: e.target.value })} placeholder="192.168.1.40" /></Label></div>
            <Label text="Name / location"><input className={inputCls} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Label>
            <div className="grid grid-cols-2 gap-2"><Label text="Manufacturer"><input className={inputCls} value={d.manufacturer} onChange={(e) => setD({ ...d, manufacturer: e.target.value })} /></Label><Label text="Model"><input className={inputCls} value={d.model} onChange={(e) => setD({ ...d, model: e.target.value })} /></Label></div>
            {d.kind === 'camera' && site && <Label text="Recorder"><select className={inputCls} value={d.recorderCode} onChange={(e) => setD({ ...d, recorderCode: e.target.value })}><option value="">None</option>{site.recorders.map((r) => <option key={r.code} value={r.code}>{r.code}</option>)}</select></Label>}
            <div className="flex flex-wrap gap-3 text-[12.5px]">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={d.stream} onChange={(e) => setD({ ...d, stream: e.target.checked })} /> Stream check</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={d.recording} onChange={(e) => setD({ ...d, recording: e.target.checked })} /> Recorder reports recording</label>
              {d.kind === 'camera' && <label className="flex items-center gap-1.5"><input type="checkbox" checked={d.critical} onChange={(e) => setD({ ...d, critical: e.target.checked })} /> Critical camera</label>}
            </div>
            <p className="text-[11.5px] text-muted">Only the address: usernames, passwords and RTSP URLs stay on the site agent and are refused here.</p>
            <Button variant="primary" disabled={!d.siteId || !d.code} busy={busy === 'd'} onClick={() => go('d', async () => {
              const recorderId = d.recorderCode ? (await api.get<{ recorders: Array<{ id: string; code: string }> }>(`/monitoring/sites/${d.siteId}`)).recorders.find((r) => r.code === d.recorderCode)?.id : undefined;
              await api.post(d.kind === 'camera' ? '/monitoring/cameras' : '/monitoring/recorders', { siteId: d.siteId, code: d.code, name: d.name, networkAddress: d.networkAddress, manufacturer: d.manufacturer, model: d.model, recorderId, critical: d.critical, capabilities: { stream: d.stream, recording: d.recording, storage: d.kind === 'recorder' } });
              setD({ ...d, code: '', name: '', networkAddress: '' });
              return `${d.kind === 'camera' ? 'Camera' : 'Recorder'} added. Its status is "unknown" until the first health check arrives.`;
            })}><Plus className="size-4" /> Add device</Button>
          </div>
        </Card>
      </div>
    </>
  );
}

function Contracts() {
  const { data, error, reload } = useApi<Array<Contract & { customer: string; site: string }>>('/monitoring/contracts');
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-60" />;
  return (
    <>
      <DataList rows={data} rowKey={(c) => c.id} empty="No contracts recorded."
        columns={[
          { head: 'Contract', cell: (c) => <div><p className="font-semibold text-ink">{c.reference}</p><p className="text-[11.5px] text-muted">{c.kind.replace('_', ' ')} · plan {c.planCode}</p></div> },
          { head: 'Customer', cell: (c) => <div><p>{c.customer}</p><p className="text-[11.5px] text-muted">{c.site}</p></div> },
          { head: 'Period', cell: (c) => `${when(c.startDate).split(',')[0]} → ${when(c.endDate).split(',')[0]}` },
          { head: 'SLA', cell: (c) => `Restore ≤ ${c.slaHours} h · respond ≤ ${c.responseMinutes} min` },
          { head: 'Cameras', cell: (c) => c.cameraLimit ?? '—', align: 'right' },
          { head: 'Monthly', cell: (c) => (c.monthlyFee === null ? '—' : `₹${c.monthlyFee.toLocaleString('en-IN')}`), align: 'right' },
          { head: 'Status', cell: (c) => <Pill status={c.status}>{c.status === 'expiring' ? `expires in ${c.daysLeft} d` : c.status}</Pill> },
        ]}
        card={(c) => <div className="flex justify-between gap-2"><div><p className="font-semibold text-ink">{c.reference}</p><p className="text-[12px] text-muted">{c.customer} · SLA {c.slaHours} h</p></div><Pill status={c.status} /></div>}
      />
      <SourceNote api="GET /monitoring/contracts" />
    </>
  );
}
