'use client';

import { useState } from 'react';
import { Phone, Radio, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { Button, Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Pill } from '@/components/vertical-ui';
import { Label, inputCls } from '@/components/textile';

type Probe = { status: 'connected' | 'not_configured' | 'auth_failed' | 'provider_unavailable' | 'not_checked'; detail?: string; checkedAt?: string };
type Status = {
  workspace: { organizationId: string; industry: string };
  mode: 'demo_simulated' | 'live';
  dryRun: boolean;
  strictRouting: boolean;
  sessionHours: number;
  whatsapp: Probe & { number: string | null; ownerOrganizationId: string; templateConfigured: boolean };
  voice: Probe & { number: string | null; ownerOrganizationId: string };
  approvedRecipients: Array<{ value: string; label: string }>;
};
type Session = { id: string; industry: string; phone: string; channels: string[]; customerId: string; status: 'active' | 'ended'; endedReason: string | null; expiresAt: string; lastActivityAt: string | null; createdAt: string };

const PROBE: Record<Probe['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  connected: { label: 'Connected', tone: 'green' },
  not_checked: { label: 'Configured · not checked', tone: 'slate' },
  not_configured: { label: 'Not configured', tone: 'red' },
  auth_failed: { label: 'Authentication failed', tone: 'red' },
  provider_unavailable: { label: 'Provider unavailable', tone: 'amber' },
};
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * Shared-number live demo for THIS workspace: bind an approved test phone so its WhatsApp messages and calls to the
 * shared business number reach this industry's agent. Status is reported as the server sees it (no invented "live").
 */
export function LiveDemoSession() {
  const status = useApi<Status>('/demo-sessions/status', 30_000);
  const sessions = useApi<Session[]>('/demo-sessions', 15_000);
  const [phone, setPhone] = useState('');
  const [wa, setWa] = useState(true);
  const [voice, setVoice] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const s = status.data;
  const active = sessions.data?.filter((x) => x.status === 'active') ?? [];

  async function probe() {
    setBusy('probe');
    try { await api.get<Status>('/demo-sessions/status?probe=1'); await status.reload(); /* the server keeps the probe result for a minute */ } catch (e) { setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(null); }
  }
  async function start(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!phone) { setMsg({ tone: 'error', text: 'Choose an approved test number.' }); return; }
    if (!confirm) { setMsg({ tone: 'error', text: 'Confirm that the tester agreed to receive demo messages and calls.' }); return; }
    setBusy('start');
    try {
      const r = await api.post<Session & { replaced: Array<{ organizationId: string }> }>('/demo-sessions', { phone, channels: [wa && 'whatsapp', voice && 'voice'].filter(Boolean), confirm: true });
      setMsg({ tone: 'ok', text: `Session started. Messages and calls from ${r.phone} to the shared number now reach this workspace until ${time(r.expiresAt)}.${r.replaced.length ? ' Their previous session in another workspace was ended.' : ''}` });
      setConfirm(false);
      await sessions.reload();
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally { setBusy(null); }
  }
  async function end(id: string) {
    setBusy(id);
    try { await api.post(`/demo-sessions/${id}/end`, {}); await sessions.reload(); } catch (err) { setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) }); } finally { setBusy(null); }
  }

  return (
    <Card className="mb-4 overflow-hidden" aria-labelledby="ld-title">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Radio className="size-4 text-brand" aria-hidden />
        <h2 id="ld-title" className="text-[14px] font-semibold text-ink">Live demo on the shared number</h2>
        {s && <Pill tone={s.dryRun ? 'amber' : 'green'}>{s.dryRun ? 'Demo mode · simulated (DRY_RUN)' : 'Live mode'}</Pill>}
        <Button className="ml-auto" busy={busy === 'probe'} onClick={probe}><RefreshCw className="size-4" /> Check connections</Button>
      </div>
      {status.error && !s ? <div className="p-4"><ErrorBanner message={status.error} onRetry={status.reload} /></div> : !s ? <Skeleton className="m-4 h-32" /> : (
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="grid content-start gap-2 text-[12.5px]">
            {([['WhatsApp Cloud API', s.whatsapp, s.whatsapp.number], ['Plivo voice', s.voice, s.voice.number]] as const).map(([name, p, num]) => (
              <div key={name} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2">
                {name.startsWith('Plivo') ? <Phone className="size-4 text-muted" aria-hidden /> : <Smartphone className="size-4 text-muted" aria-hidden />}
                <span className="font-semibold text-ink">{name}</span>
                <span className="text-muted">{num ?? 'no number'}</span>
                <Pill tone={PROBE[p.status].tone} className="ml-auto">{PROBE[p.status].label}</Pill>
                {p.detail && <span className="w-full text-[11.5px] text-muted">{p.detail}{p.checkedAt ? ` · checked ${time(p.checkedAt)}` : ''}</span>}
              </div>
            ))}
            <p className="text-muted">Approved WhatsApp template: <b className="text-ink">{s.whatsapp.templateConfigured ? 'configured' : 'not configured'}</b> (needed to start a chat outside the 24-hour window). Unbound senders on the shared number: <b className="text-ink">{s.strictRouting ? 'not answered (strict routing)' : `answered by the number's owner workspace`}</b>.</p>
            <p className="flex items-start gap-1.5 text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />Only numbers on the approved test-recipient list can be bound. “Check connections” makes read-only requests to Meta and Plivo; it sends nothing.</p>
          </div>

          <form onSubmit={start} noValidate className="grid content-start gap-3">
            <Label text="Approved test number">
              <select className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)}>
                <option value="">{s.approvedRecipients.length ? 'Choose…' : 'No approved test numbers (set LIVE_TEST_RECIPIENTS on the server)'}</option>
                {s.approvedRecipients.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Label>
            <fieldset className="flex flex-wrap gap-4 text-[13px]">
              <legend className="sr-only">Channels</legend>
              <label className="flex items-center gap-2"><input type="checkbox" checked={wa} onChange={(e) => setWa(e.target.checked)} /> WhatsApp</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Voice calls</label>
            </fieldset>
            <label className="flex items-start gap-2 text-[12.5px] text-body"><input type="checkbox" className="mt-0.5" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> This number belongs to an approved tester who agreed to receive demo messages and calls from this {s.workspace.industry.replace('_', ' ')} workspace.</label>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" busy={busy === 'start'} disabled={!s.approvedRecipients.length}>Start demo session</Button>
              <span className="text-[11.5px] text-muted">Ends automatically after {s.sessionHours} h. Starting it elsewhere ends this one.</span>
            </div>
            {msg && <p role={msg.tone === 'error' ? 'alert' : 'status'} className={cx('rounded-[10px] px-3 py-2 text-[12.5px]', msg.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800')}>{msg.text}</p>}
          </form>
        </div>
      )}
      <div className="border-t border-line px-4 py-3">
        <p className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Sessions in this workspace</p>
        {!sessions.data ? <Skeleton className="h-10" /> : sessions.data.length === 0 ? <p className="text-[12.5px] text-muted">No demo sessions yet.</p> : (
          <ul className="grid gap-1.5">
            {sessions.data.slice(0, 8).map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <Pill tone={x.status === 'active' ? 'green' : 'slate'}>{x.status === 'active' ? 'active' : x.endedReason ?? 'ended'}</Pill>
                <span className="font-semibold tabular-nums text-ink">{x.phone}</span>
                <span className="text-muted">{[x.channels.join(' + '), `started ${time(x.createdAt)}`, x.status === 'active' ? `until ${time(x.expiresAt)}` : null, x.lastActivityAt ? `last message/call ${time(x.lastActivityAt)}` : null].filter(Boolean).join(' · ')}</span>
                {x.status === 'active' && (
                  <span className="ml-auto flex gap-2">
                    <Button href={`/contacts?open=${x.customerId}`}>Send test / call</Button>
                    <Button busy={busy === x.id} onClick={() => end(x.id)}>End</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {active.length > 0 && <p className="mt-2 text-[11.5px] text-muted">“Send test / call” opens the tester's record, where WhatsApp tests and test calls need a confirmation and respect DRY_RUN and consent.</p>}
      </div>
    </Card>
  );
}
