'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AudioLines, ExternalLink, Loader2, Phone, Plus, ShieldCheck } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Dialog, inputCls } from '@/components/textile';
import { toast } from '@/components/toast';
import { explainCallReason } from '@/lib/call-reasons';

export type Agent = {
  id: string; name: string; description: string | null; industry: string; useCase: string | null; templateKey: string | null; instructions: string;
  languages: string[]; voice: { speaker: string; pace: number } | null; inbound: { enabled: boolean; phoneNumber: string | null } | null;
  outbound: { enabled: boolean; purpose: string } | null; greeting: string; fallbackMessage: string; knowledgeBaseId: string | null;
  knowledgeBase: { id: string; name: string } | null;
  businessHours: { days: number[]; start: string; end: string; timezone: string; afterHoursMessage: string } | null;
  escalation: { keywords: string[]; handoffMessage: string; phone: string | null } | null;
  callLimits: { maxCallSeconds: number; maxConcurrent: number; dailyLimit: number } | null;
  status: 'draft' | 'active' | 'archived'; telephonyProvider: 'plivo' | 'sarvam'; sarvamAppId: string | null; sarvamAppVersion: number | null;
  lastTestedAt: string | null; publishedAt: string | null; updatedAt: string;
};
type Caps = { provider: string; configured: boolean; outbound: boolean; inbound: boolean; conversation: string; instructionsSource: string; knowledgeSource: string; webhookAuth: string; realtimeAudio: string; numberProvisioning: string; pricing: string; limits: string; verifiedFrom: string[]; notes: string[] };
type Overview = { defaultProvider: 'plivo' | 'sarvam'; dryRun: boolean; providers: { plivo: Caps; sarvam: Caps }; sarvamInboundWebhooks: Array<{ agentId: string; agentName: string; url: string | null }> };
type CallRow = { requestId: string; agentId: string | null; to: string; provider: string; status: string; failureReason: string | null; durationSec: number | null; createdAt: string };

const STATUS_TONE = { draft: 'amber', active: 'brand', archived: 'slate' } as const;
const CALL_TONE: Record<string, 'brand' | 'amber' | 'rose' | 'slate' | 'sky'> = { completed: 'brand', dialing: 'sky', accepted: 'sky', dry_run: 'amber', rejected: 'rose', failed: 'rose', no_answer: 'slate', busy: 'slate' };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Custom voice agents: list, telephony provider, outbound calls with every safety gate on the server. */
export default function VoiceAgentsPage() {
  const router = useRouter();
  const { workspace } = useWorkspace();
  const canManage = !workspace?.role || ['admin', 'manager'].includes(workspace.role);
  const { data: agents, error, reload } = useApi<Agent[]>('/voice-agents', 15_000);
  const { data: tel, reload: reloadTel } = useApi<Overview>('/telephony', 60_000);
  const { data: calls, reload: reloadCalls } = useApi<CallRow[]>('/telephony/calls', 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [callFor, setCallFor] = useState<Agent | null>(null);

  async function blank() {
    setBusy('new');
    try {
      const a = await api.post<Agent>('/voice-agents', { name: 'New agent', industry: 'other', instructions: 'Describe what this agent does, what it must never do, and how it should speak.', greeting: 'Vanakkam! How can I help you today?', fallbackMessage: 'Let me check with the team and get back to you.' });
      router.push(`/voice-agents/${a.id}`);
    } catch (e) { toast(errMsg(e), 'error'); setBusy(null); }
  }
  async function setProvider(p: 'plivo' | 'sarvam') {
    setBusy('prov');
    try { await api.put('/telephony/settings', { provider: p }); toast(`Default telephony provider: ${p === 'sarvam' ? 'Sarvam' : 'Plivo'}.`); await reloadTel(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="Voice agents" crumb="AI agents" actions={canManage ? (
        <div className="flex gap-2">
          <Link href="/voice-demos" className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-white px-3 text-[13px] font-semibold text-ink hover:bg-canvas">Start from a template <ExternalLink className="size-3.5" /></Link>
          <Button variant="primary" busy={busy === 'new'} onClick={() => void blank()}><Plus className="size-4" />New agent</Button>
        </div>
      ) : undefined} />
      {tel?.dryRun && <p className="mb-4 rounded-[12px] bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900 ring-1 ring-amber-200">Dry run is on for this server: calls are checked end to end but not placed, and nothing is billed.</p>}
      {error && !agents ? <ErrorBanner message={error} onRetry={reload} /> : !agents ? <Skeleton className="h-60" /> : agents.length === 0 ? (
        <Card><Empty icon={<AudioLines className="size-8" />} title="No voice agents yet">Start from one of the ten industry templates, or a blank agent. Agents are drafts until you test and publish them.</Empty></Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Agents">
          {agents.map((a) => (
            <li key={a.id} className="flex flex-col rounded-[var(--radius-card)] border border-line bg-white p-4 shadow-[var(--shadow-card)]">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/voice-agents/${a.id}`} className="block truncate text-[15px] font-semibold text-ink hover:underline">{a.name}</Link>
                  <p className="mt-0.5 truncate text-[12.5px] text-muted">{a.useCase || a.industry.replace('_', ' ')}</p>
                </div>
                <Badge tone={STATUS_TONE[a.status]} dot>{a.status}</Badge>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
                <dt className="text-muted">Knowledge</dt><dd className="truncate text-ink">{a.knowledgeBase?.name ?? 'None'}</dd>
                <dt className="text-muted">Calls via</dt><dd className="text-ink">{a.telephonyProvider === 'sarvam' ? 'Sarvam' : 'Plivo'}</dd>
                <dt className="text-muted">Inbound</dt><dd className="text-ink">{a.inbound?.enabled ? `+${a.inbound.phoneNumber}` : 'Off'}</dd>
                <dt className="text-muted">Outbound</dt><dd className="text-ink">{a.outbound?.enabled ? 'On' : 'Off'}</dd>
              </dl>
              {a.status === 'active' && !a.lastTestedAt && <p className="mt-2 text-[12px] text-amber-800">Changed since the last test.</p>}
              <div className="mt-auto flex gap-2 pt-3">
                <Link href={`/voice-agents/${a.id}`} className="inline-flex h-8 flex-1 items-center justify-center rounded-[8px] border border-line text-[12.5px] font-semibold text-ink hover:bg-canvas">{a.status === 'draft' ? 'Continue setup' : 'Open'}</Link>
                {a.status === 'active' && a.outbound?.enabled && canManage && <Button className="h-8" onClick={() => setCallFor(a)}><Phone className="size-3.5" />Call</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Telephony provider" subtitle="Which provider places and answers calls. Each agent can override it." />
          {!tel ? <Skeleton className="h-40" /> : (
            <div className="space-y-3">
              <div className="flex gap-2" role="radiogroup" aria-label="Default telephony provider">
                {(['plivo', 'sarvam'] as const).map((p) => (
                  <button key={p} role="radio" aria-checked={tel.defaultProvider === p} disabled={!canManage || busy === 'prov'} onClick={() => void setProvider(p)} className={cx('flex-1 rounded-[10px] border px-3 py-2 text-left text-[13px]', tel.defaultProvider === p ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink hover:bg-canvas')}>
                    <span className="block font-semibold">{p === 'plivo' ? 'Plivo' : 'Sarvam Voice Agents'}</span>
                    <span className={cx('text-[12px]', tel.defaultProvider === p ? 'text-white/70' : 'text-muted')}>{tel.providers[p].configured ? 'Configured' : 'Not configured'}</span>
                  </button>
                ))}
              </div>
              {(['plivo', 'sarvam'] as const).map((p) => {
                const c = tel.providers[p];
                return (
                  <details key={p} className="rounded-[10px] border border-line px-3 py-2 text-[12.5px]">
                    <summary className="cursor-pointer font-semibold text-ink">{p === 'plivo' ? 'Plivo' : 'Sarvam'}: what works (verified)</summary>
                    <ul className="mt-2 space-y-1 text-body">
                      <li>Conversation: {c.conversation === 'our_engine' ? 'our engine (your instructions and knowledge base, live)' : 'agent hosted by Sarvam (configure it in Sarvam)'}</li>
                      <li>Audio: {c.realtimeAudio}</li>
                      <li>Numbers: {c.numberProvisioning}</li>
                      <li>Pricing: {c.pricing}</li>
                      <li>Limits: {c.limits}</li>
                      <li>Webhooks: {c.webhookAuth === 'provider_signature' ? 'provider signature verified' : 'HMAC token in our webhook URL (the provider does not sign)'}</li>
                      {c.notes.map((n) => <li key={n} className="text-amber-900">{n}</li>)}
                      {c.verifiedFrom.filter((u) => u.startsWith('http')).map((u) => <li key={u}><a href={u} target="_blank" rel="noreferrer" className="text-brand-dark underline">{u.replace('https://', '')}</a></li>)}
                    </ul>
                  </details>
                );
              })}
              {tel.sarvamInboundWebhooks.length > 0 && (
                <div className="rounded-[10px] bg-canvas p-3 text-[12px]">
                  <p className="font-semibold text-ink">Sarvam inbound deployments: result webhook per agent</p>
                  {tel.sarvamInboundWebhooks.map((w) => <p key={w.agentId} className="mt-1 break-all text-body"><span className="font-semibold">{w.agentName}:</span> {w.url ?? 'Set TELEPHONY_WEBHOOK_SECRET on the server first.'}</p>)}
                </div>
              )}
              <p className="text-[12px] text-muted">Credentials: <Link className="font-semibold text-brand-dark underline" href="/settings/integrations/plivo">Plivo</Link> · <Link className="font-semibold text-brand-dark underline" href="/settings/integrations/sarvam-telephony">Sarvam Voice Agents</Link></p>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent call requests" subtitle="Every request with its outcome or the exact reason it was not placed." />
          {!calls ? <Skeleton className="h-40" /> : calls.length === 0 ? <Empty title="No calls yet" /> : (
            <ul className="divide-y divide-line text-[12.5px]">
              {calls.slice(0, 12).map((c) => (
                <li key={c.requestId} className="flex items-center gap-2 py-2">
                  <Badge tone={CALL_TONE[c.status] ?? 'slate'}>{c.status.replace('_', ' ')}</Badge>
                  <span className="tabular text-ink">{c.to}</span>
                  <span className="text-muted">{c.provider}</span>
                  <span className="min-w-0 flex-1 truncate text-muted" title={c.failureReason ?? ''}>{c.failureReason ? explainCallReason(c.failureReason) : c.durationSec !== null ? `${c.durationSec} s` : ''}</span>
                  <time className="text-faint">{new Date(c.createdAt).toLocaleTimeString()}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {callFor && <CallDialog agent={callFor} onClose={() => { setCallFor(null); void reloadCalls(); }} />}
    </>
  );
}

type Customer = { id: string; name: string | null; phone: string | null; callingConsent: boolean };

/** One outbound call. The server checks consent, DND, hours, limits, dry run and idempotency; this only asks. */
function CallDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  // Only customers who agreed to calls are offered (the server checks again, with opt-out and do-not-contact).
  const { data: customers } = useApi<{ rows?: Customer[] } | Customer[]>('/customers?consent=calling&pageSize=100', 0);
  const list: Customer[] = Array.isArray(customers) ? customers : (customers?.rows ?? []);
  const [customerId, setCustomerId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CallRow | null>(null);
  // One key per intended call: a double click or a retry never places a second call.
  const [key] = useState(() => `ui-${crypto.randomUUID()}`);
  async function place() {
    setBusy(true);
    try { setResult(await api.post<CallRow>('/telephony/calls', { agentId: agent.id, customerId, confirm: true, idempotencyKey: key })); }
    catch (e) { toast(e instanceof ApiError ? e.message : errMsg(e), 'error'); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={`Call with ${agent.name}`}>
      <div className="space-y-3 text-[13px]">
        <label className="block"><span className="mb-1 block font-semibold text-ink">Customer</span>
          <select className={inputCls} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">{list.length ? 'Choose a customer…' : 'No customer has agreed to calls yet'}</option>
            {list.map((c) => <option key={c.id} value={c.id}>{c.name ?? 'Unnamed'} · ••••{(c.phone ?? '').slice(-4)}{c.callingConsent ? '' : ' (no calling consent)'}</option>)}
          </select>
        </label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" /><span>Place a real phone call now (charged by {agent.telephonyProvider === 'sarvam' ? 'Sarvam' : 'Plivo'} unless the server is in dry run). The customer has agreed to be called.</span></label>
        <p className="flex items-center gap-1.5 text-[12px] text-muted"><ShieldCheck className="size-3.5" />Checked on the server: consent, do-not-contact, calling hours, limits, duplicates. No automatic redial.</p>
        {result && (
          <p role="status" className={cx('rounded-[10px] px-3 py-2', result.status === 'dialing' ? 'bg-brand-soft text-brand-dark' : 'bg-amber-50 text-amber-900')}>
            {result.status === 'dialing' ? 'Calling now. The outcome appears in Recent call requests.' : <>{result.status === 'dry_run' ? 'Test mode: ' : 'Not placed: '}{explainCallReason(result.failureReason)}<span className="sr-only"> ({result.status.replace('_', ' ')}: {result.failureReason})</span></>}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!customerId || !confirm || Boolean(result)} busy={busy} onClick={() => void place()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Phone className="size-4" />}Place call</Button>
        </div>
      </div>
    </Dialog>
  );
}
