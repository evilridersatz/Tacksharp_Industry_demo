'use client';

import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Copy, Eye, EyeOff, KeyRound, Phone, Play, PlugZap, RefreshCw, ShieldCheck, Trash2, Upload, XCircle } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { Badge, Button, Card, CardHeader, ErrorBanner, Skeleton, cx } from './ui';
import { Dialog, inputCls } from './textile';
import { toast } from './toast';

export type ProviderId = 'sarvam' | 'openai' | 'whatsapp' | 'sarvam_telephony' | 'meta_capi' | 'meta_social' | 'office_mail';
type Field = { key: string; label: string; secret: boolean; required: boolean; help?: string; options?: string[] };
type Usage = {
  days: number; total: number; failed: number; costEstimate: number | null; costNote: string;
  byKind: Record<string, { count: number; failed: number; units: number; cost: number }>;
  recentErrors: Array<{ at: string; kind: string; code: string | null; message: string | null }>;
  recent: Array<{ at: string; kind: string; ok: boolean; latencyMs: number | null; code: string | null; message: string | null; units: number | null; unitType: string | null }>;
};
type Deployment = {
  publicBaseUrl: string;
  vault: { ready: boolean; problem: string | null; keyVersion: string | null };
  sarvamVoice?: { toolsUrl: string; webhookUrl: string; secretSet: boolean };
  whatsapp: { webhookUrl: string; verifyTokenSet: boolean; appSecretSet: boolean };
  mode: { dryRun: boolean; liveTestRecipients: number };
};
export type Integration = {
  provider: ProviderId; saved: boolean; enabled: boolean; status: 'not_configured' | 'untested' | 'ok' | 'failed';
  lastTestAt: string | null; lastSuccessAt: string | null; lastError: string | null; updatedAt: string | null;
  config: Record<string, string>; secrets: Record<string, string | null>; fields: Field[]; operations: string[];
  effective: { source: 'organization' | 'environment' | 'none'; reason: string | null };
  usage: Usage; deployment: Deployment;
  numbers?: Array<{ externalId: string; createdAt: string }>;
  routing?: Array<{ externalId: string; createdAt: string }>;
  delivery?: { days: number; counts: Record<string, number>; note: string };
};
type TestResult = { ok: boolean; latencyMs: number; errorCode?: string; message: string; details?: Record<string, unknown>; audioBase64?: string; transcript?: string; templates?: Array<{ name: string; status: string; language: string; category: string }>; inputTokens?: number; outputTokens?: number; costEstimate: number | null };

export const PROVIDER_META: Record<ProviderId, { name: string; group: 'Integrations' | 'AI providers'; href: string; blurb: string }> = {
  whatsapp: { name: 'WhatsApp Cloud API', group: 'Integrations', href: '/settings/integrations/whatsapp', blurb: 'Your WhatsApp Business number, templates and delivery receipts.' },
  sarvam: { name: 'Sarvam AI', group: 'AI providers', href: '/settings/ai-providers/sarvam', blurb: 'Speech recognition and Tamil / English voices for calls.' },
  openai: { name: 'OpenAI', group: 'AI providers', href: '/settings/ai-providers/openai', blurb: 'The language model behind conversations and drafts.' },
  sarvam_telephony: { name: 'Sarvam Voice Agents (telephony)', group: 'Integrations', href: '/settings/integrations/sarvam-telephony', blurb: 'Calls answered by an agent hosted on Sarvam: outbound calls and post-call results.' },
  meta_social: { name: 'Instagram & Messenger', group: 'Integrations', href: '/settings/integrations/meta-social', blurb: 'Instagram and Facebook Messenger messages in the team inbox; your team or a chosen AI agent replies.' },
  office_mail: { name: 'Office mail (Gmail)', group: 'Integrations', href: '/settings/integrations/office-mail', blurb: 'Jarvis checks the office inbox (read-only: senders and subjects) and alerts on unread mail.' },
  meta_capi: { name: 'Meta Conversions API', group: 'Integrations', href: '/settings/integrations/meta-capi', blurb: 'Report completed orders and new enquiries to your Meta ads dataset (hashed customer data only).' },
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const fieldErrors = (e: unknown) => (e instanceof ApiError ? ((e.body as { fields?: Record<string, string> } | null)?.fields ?? {}) : {});

export function StatusBadge({ status }: { status: Integration['status'] }) {
  if (status === 'ok') return <Badge tone="brand"><CheckCircle2 className="size-3.5" /> Connection verified</Badge>;
  if (status === 'failed') return <Badge tone="rose"><XCircle className="size-3.5" /> Test failed</Badge>;
  if (status === 'untested') return <Badge tone="amber"><AlertTriangle className="size-3.5" /> Saved, not tested</Badge>;
  return <Badge tone="slate"><CircleSlash className="size-3.5" /> Not configured</Badge>;
}

export function SourceBadge({ effective }: { effective: Integration['effective'] }) {
  if (effective.source === 'organization') return <Badge tone="brand">In use: your own account</Badge>;
  if (effective.source === 'environment') return <Badge tone="sky" className="max-w-full whitespace-normal">In use: Tacksharp platform account{effective.reason ? ' (not configured on this server)' : ''}</Badge>;
  return <Badge tone="slate" className="max-w-full whitespace-normal">Not in use{effective.reason ? `: ${effective.reason}` : ''}</Badge>;
}

function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-[12px] font-semibold text-body">{label}</span>
      <span className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-[8px] bg-slate-50 px-2 py-1.5 font-mono text-[12px] text-ink" title={value}>{value}</code>
        <button type="button" aria-label={`Copy ${label}`} className="grid size-9 shrink-0 place-items-center rounded-[8px] border border-line hover:bg-slate-50" onClick={() => navigator.clipboard.writeText(value).then(() => toast('Copied.'), () => toast('Copy failed: select the text instead.', 'error'))}>
          <Copy className="size-4" />
        </button>
      </span>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-2 text-[13px] last:border-0">
      <span className="text-muted">{k}</span>
      <span className="min-w-0 text-right font-medium break-words text-ink">{children}</span>
    </div>
  );
}

function ResultPanel({ r }: { r: TestResult }) {
  return (
    <div role="status" className={cx('rounded-[12px] border p-3 text-[13px]', r.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50/60')}>
      <p className="flex items-start gap-2 font-semibold text-ink">
        {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-rose-600" />}
        <span>{r.message}</span>
      </p>
      <p className="mt-1 text-[12px] text-muted">
        Live provider request · {r.latencyMs} ms{r.errorCode ? ` · code ${r.errorCode}` : ''}
        {r.inputTokens !== undefined ? ` · ${r.inputTokens} input + ${r.outputTokens ?? 0} output tokens` : ''}
        {r.costEstimate !== null && r.costEstimate !== undefined ? ` · ≈ ${r.costEstimate.toFixed(4)} (estimate)` : ''}
      </p>
      {r.details && Object.keys(r.details).length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
          {Object.entries(r.details).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="truncate text-ink">{String(v)}</dd></div>
          ))}
        </dl>
      )}
      {r.transcript !== undefined && <p className="mt-2 rounded-[8px] bg-white px-2 py-1.5 text-[13px]"><span className="text-muted">Heard: </span>{r.transcript || '(nothing)'}</p>}
      {r.audioBase64 && <audio className="mt-2 w-full" controls src={`data:audio/wav;base64,${r.audioBase64}`} aria-label="Generated speech" />}
      {r.templates && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-[8px] bg-white">
          <table className="w-full text-[12px]">
            <thead className="text-left text-muted"><tr><th className="px-2 py-1">Template</th><th className="px-2 py-1">Language</th><th className="px-2 py-1">Status</th></tr></thead>
            <tbody>
              {r.templates.map((t) => <tr key={`${t.name}-${t.language}`} className="border-t border-line"><td className="px-2 py-1 font-mono">{t.name}</td><td className="px-2 py-1">{t.language}</td><td className="px-2 py-1"><Badge tone={t.status === 'APPROVED' ? 'brand' : t.status === 'REJECTED' ? 'rose' : 'amber'}>{t.status}</Badge></td></tr>)}
              {!r.templates.length && <tr><td className="px-2 py-2 text-muted" colSpan={3}>No templates yet. Create and get them approved in WhatsApp Manager: messages outside the 24-hour window need an approved template.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Settings → Integrations / AI providers → one provider. Every control calls the real API; nothing is simulated. */
export function ProviderSettings({ provider }: { provider: ProviderId }) {
  const meta = PROVIDER_META[provider];
  const { workspace } = useWorkspace();
  const canManage = workspace?.role === 'admin';
  const { data, error, reload, loading } = useApi<Integration>(`/integrations/${provider}`, 20_000);
  const [form, setForm] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function act<T>(key: string, fn: () => Promise<T>, ok?: (r: T) => void) {
    setBusy(key);
    try {
      const r = await fn();
      ok?.(r);
      await reload();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast(errText(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) return <ErrorBanner message={/permission/.test(error) ? 'Only workspace admins and managers can see integrations.' : error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-[560px] rounded-[14px]" />;

  const value = (f: Field) => form[f.key] ?? (f.secret ? '' : data.config[f.key] ?? '');
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const body: Record<string, string> = {};
    for (const f of data.fields) {
      const v = form[f.key];
      if (v !== undefined) body[f.key] = v;
      else if (!f.secret && data.config[f.key] !== undefined) body[f.key] = data.config[f.key];
    }
    void act('save', () => api.put<Integration>(`/integrations/${provider}`, body), () => {
      setForm({});
      setResult(null);
      toast('Saved and encrypted. Run "Test connection" next: saving does not prove the credentials work.');
    });
  };
  const test = (op: string, body: Record<string, unknown> = {}) =>
    act(`test-${op}`, () => api.post<{ result: TestResult }>(`/integrations/${provider}/test/${op}`, body), (r) => {
      setResult(r.result);
      toast(r.result.ok ? 'Test passed.' : `Test failed: ${r.result.message}`, r.result.ok ? 'ok' : 'error');
    });

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader title={meta.name} subtitle={meta.blurb} action={<StatusBadge status={data.status} />} />
          <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
            <SourceBadge effective={data.effective} />
            <Badge tone={data.enabled ? 'brand' : 'slate'}>{data.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <span className="ml-auto flex flex-wrap gap-2">
              <Button busy={loading && busy === null} onClick={() => void reload()} title="Reload the saved status"><RefreshCw className="size-4" /> Refresh status</Button>
            </span>
          </div>
          {!data.deployment.vault.ready && (
            <p role="note" className="mx-5 mb-4 flex items-start gap-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{data.deployment.vault.problem}</p>
          )}
          {!canManage && <p role="note" className="mx-5 mb-4 rounded-[10px] bg-slate-50 px-3 py-2 text-[12.5px] text-body">Only a workspace admin can change or test these settings. You can see the status.</p>}
        </Card>

        <Card>
          <CardHeader title="Credentials" subtitle="Encrypted on the server. Saved secrets are never shown again: leave a field empty to keep it." action={<KeyRound className="size-4 text-muted" aria-hidden />} />
          <form onSubmit={save} noValidate className="grid gap-3 px-5 pb-5">
            {data.fields.map((f) => {
              const id = `f-${provider}-${f.key}`;
              const err = errors[f.key];
              const hint = f.secret ? data.secrets[f.key] : null;
              return (
                <div key={f.key} className="grid gap-1">
                  <label htmlFor={id} className="text-[12.5px] font-semibold text-body">{f.label}{f.required ? '' : ' (optional)'}</label>
                  {f.options ? (
                    <select id={id} className={inputCls} disabled={!canManage} value={value(f)} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} aria-invalid={Boolean(err)} aria-describedby={`${id}-h`}>
                      {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <span className="relative">
                      <input
                        id={id}
                        className={cx(inputCls, f.secret && 'pr-11 font-mono', err && 'border-rose-400')}
                        type={f.secret && !show[f.key] ? 'password' : 'text'}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!canManage}
                        placeholder={f.secret ? (hint ? `Saved ${hint} — type to replace` : 'Not set') : ''}
                        value={value(f)}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        aria-invalid={Boolean(err)}
                        aria-describedby={`${id}-h`}
                      />
                      {f.secret && (
                        <button type="button" onClick={() => setShow({ ...show, [f.key]: !show[f.key] })} aria-label={show[f.key] ? `Hide ${f.label}` : `Show ${f.label}`} className="absolute top-0 right-0 grid h-9 w-10 place-items-center text-muted">
                          {show[f.key] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      )}
                    </span>
                  )}
                  <span id={`${id}-h`} className={cx('text-[12px]', err ? 'text-rose-700' : 'text-muted')}>{err ?? f.help ?? ''}</span>
                </div>
              );
            })}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="submit" variant="primary" busy={busy === 'save'} disabled={!canManage || !data.deployment.vault.ready}>Save configuration</Button>
              {data.saved && <Button type="button" variant="danger" disabled={!canManage} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" /> Delete</Button>}
            </div>
          </form>
        </Card>

        {provider === 'whatsapp' && <WhatsAppExtras data={data} canManage={canManage} reload={reload} />}
      </div>

      <div className="grid content-start gap-4">
        <Card>
          <CardHeader title="Connection" subtitle="Tests use the SAVED credentials and make a real request to the provider." action={<PlugZap className="size-4 text-muted" aria-hidden />} />
          <div className="grid gap-3 px-5 pb-5">
            <div className="flex flex-wrap gap-2">
              {data.operations.includes('connection') ? (
                <Button variant="primary" busy={busy === 'test-connection'} disabled={!canManage || !data.saved} onClick={() => void test('connection')}>
                  <ShieldCheck className="size-4" /> Test connection
                </Button>
              ) : <p className="w-full text-[12.5px] text-muted">Sarvam documents no read-only credential check for Voice Agents: a successful test call (below) verifies these settings.</p>}
              {data.saved && (
                data.enabled
                  ? <Button busy={busy === 'enable'} disabled={!canManage} onClick={() => void act('enable', () => api.post(`/integrations/${provider}/enable`, { enabled: false }), () => toast('Disabled. This organization no longer uses these credentials.'))}>Disable integration</Button>
                  : <Button busy={busy === 'enable'} disabled={!canManage || data.status !== 'ok'} title={data.status !== 'ok' ? 'Pass a connection test first' : undefined} onClick={() => void act('enable', () => api.post(`/integrations/${provider}/enable`, { enabled: true }), () => toast('Enabled. This organization now uses its own account.'))}>Enable integration</Button>
              )}
            </div>
            {!data.saved && <p className="text-[12.5px] text-muted">Save the credentials first.</p>}
            {result && <ResultPanel r={result} />}
            <div>
              <Row k="Last test">{when(data.lastTestAt)}</Row>
              <Row k="Last successful test">{when(data.lastSuccessAt)}</Row>
              <Row k="Last error">{data.lastError ? <span className="text-rose-700">{data.lastError}</span> : 'none'}</Row>
            </div>
            {provider === 'sarvam' && <SarvamTests canManage={canManage && data.saved} busy={busy} test={test} />}
          </div>
        </Card>

        {provider === 'sarvam_telephony' && <SarvamTestCall data={data} canManage={canManage} busy={busy} test={test} />}
        {provider === 'meta_social' && <SocialSetup data={data} />}
        {provider === 'meta_capi' && <CapiPanel data={data} canManage={canManage} busy={busy} test={test} />}
        <UsageCard usage={data.usage} />
      </div>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${meta.name} credentials?`}>
        <p className="text-[13px] text-body">The saved credentials for this organization are deleted. {data.effective.source === 'organization' ? 'Anything using them stops working until new ones are saved and tested.' : ''}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" busy={busy === 'delete'} onClick={() => void act('delete', () => api.delete(`/integrations/${provider}?confirm=yes`), () => { setConfirmDelete(false); setResult(null); toast('Credentials deleted.'); })}>Delete credentials</Button>
        </div>
      </Dialog>
    </div>
  );
}

function SarvamTests({ canManage, busy, test }: { canManage: boolean; busy: string | null; test: (op: string, body?: Record<string, unknown>) => Promise<void> }) {
  const [text, setText] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  return (
    <div className="grid gap-3 border-t border-line pt-3">
      <div className="grid gap-1">
        <label htmlFor="tts-text" className="text-[12.5px] font-semibold text-body">Test speech generation</label>
        <textarea id="tts-text" rows={2} maxLength={300} className={cx(inputCls, 'h-auto py-2')} placeholder="Leave empty for a sample in the voice language (Tamil, English or Tanglish works)" value={text} onChange={(e) => setText(e.target.value)} />
        <Button busy={busy === 'test-tts'} disabled={!canManage} onClick={() => void test('tts', text.trim() ? { text: text.trim() } : {})}><Play className="size-4" /> Generate speech</Button>
      </div>
      <div className="grid gap-1">
        <span className="text-[12.5px] font-semibold text-body">Test speech recognition</span>
        <span className="text-[12px] text-muted">Upload a short WAV recording, or leave it empty to recognise the sample voice (a round trip).</span>
        <input ref={file} type="file" accept="audio/wav,.wav" className="sr-only" id="stt-file" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (f.size > 2_000_000) { toast('Keep the recording under 2 MB.', 'error'); return; }
          const b = new Uint8Array(await f.arrayBuffer());
          let s = '';
          for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
          setAudio(btoa(s));
          setFileName(f.name);
        }} />
        <span className="flex flex-wrap gap-2">
          <label htmlFor="stt-file" className={cx('inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-line bg-white px-3.5 text-[13px] font-semibold text-ink hover:bg-slate-50', !canManage && 'pointer-events-none opacity-50')}><Upload className="size-4" /> {fileName ?? 'Choose WAV'}</label>
          <Button busy={busy === 'test-stt'} disabled={!canManage} onClick={() => void test('stt', audio ? { audioBase64: audio } : {})}>Recognise speech</Button>
        </span>
      </div>
    </div>
  );
}


function SarvamTestCall({ data, canManage, busy, test }: { data: Integration; canManage: boolean; busy: string | null; test: (op: string, body?: Record<string, unknown>) => Promise<void> }) {
  const [to, setTo] = useState('');
  const [appId, setAppId] = useState('');
  const [appVersion, setAppVersion] = useState('1');
  const [confirm, setConfirm] = useState(false);
  const blocked = data.deployment.mode.dryRun ? 'This server is in dry-run mode: no real call can be placed.' : !data.saved ? 'Save the settings first.' : null;
  return (
    <Card>
      <CardHeader title="Test call through Sarvam" subtitle="Places one REAL call answered by your Sarvam agent (charged by Sarvam). Only to numbers on the approved test list." />
      <form className="grid gap-2 px-5 pb-5" onSubmit={(e) => { e.preventDefault(); void test('call', { to, confirm, appId, appVersion: Number(appVersion) }); }}>
        <label htmlFor="sv-to" className="text-[12.5px] font-semibold text-body">Approved test number</label>
        <input id="sv-to" className={inputCls} placeholder="e.g. 919800011122" value={to} onChange={(e) => setTo(e.target.value)} disabled={!canManage || Boolean(blocked)} />
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <label className="grid gap-1 text-[12.5px] font-semibold text-body">Sarvam agent (app) id<input className={inputCls} value={appId} onChange={(e) => setAppId(e.target.value)} disabled={!canManage || Boolean(blocked)} /></label>
          <label className="grid gap-1 text-[12.5px] font-semibold text-body">Version<input type="number" min={1} className={inputCls} value={appVersion} onChange={(e) => setAppVersion(e.target.value)} disabled={!canManage || Boolean(blocked)} /></label>
        </div>
        <label className="flex items-start gap-2 text-[12.5px] text-body"><input type="checkbox" className="mt-0.5" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} disabled={!canManage || Boolean(blocked)} /> I understand a real phone call will be placed.</label>
        <Button type="submit" busy={busy === 'test-call'} disabled={!canManage || Boolean(blocked) || !to.trim() || !appId.trim() || !confirm}><Phone className="size-4" /> Place test call</Button>
        {blocked && <p className="text-[12px] text-amber-800">{blocked}</p>}
        <p className="text-[12px] text-muted">A number rented from Sarvam must be KYC-approved and on this connection. Results of calls placed by agents arrive at the webhook shown on the Voice agents page.</p>
      </form>
    </Card>
  );
}

function WhatsAppExtras({ data, canManage, reload }: { data: Integration; canManage: boolean; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const d = data.delivery;
  const mapped = (data.routing ?? []).length > 0;
  return (
    <>
      <Card>
        <CardHeader title="Webhook" subtitle="Meta delivers messages and delivery receipts here." />
        <div className="grid gap-3 px-5 pb-5">
          <CopyLine label="Callback URL" value={data.deployment.whatsapp.webhookUrl} />
          <Row k="Verify token on this server">{data.deployment.whatsapp.verifyTokenSet ? 'Set (ask Tacksharp for it when subscribing)' : <span className="text-amber-800">Missing (WHATSAPP_VERIFY_TOKEN)</span>}</Row>
          <Row k="Signature check">{data.deployment.whatsapp.appSecretSet ? 'On (platform app)' : <span className="text-amber-800">Platform app secret not set</span>}{data.secrets.appSecret ? ' · your app secret saved' : ''}</Row>
          <Row k="Number routed to this organization">{mapped ? data.routing!.map((r) => `••••${r.externalId.slice(-4)}`).join(', ') : 'No'}</Row>
          {!mapped && (
            <Button disabled={!canManage || data.effective.source !== 'organization'} busy={busy} onClick={async () => {
              setBusy(true);
              try { await api.post('/integrations/whatsapp/route'); await reload(); toast('Your WhatsApp number now routes to this organization.'); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
            }}>Route this number here</Button>
          )}
        </div>
      </Card>
      {d && (
        <Card>
          <CardHeader title="Delivery (last 30 days)" subtitle={d.note} />
          <div className="grid grid-cols-3 gap-2 px-5 pb-5 sm:grid-cols-6">
            {['accepted', 'sent', 'delivered', 'read', 'failed', 'unknown'].map((k) => (
              <div key={k} className="rounded-[10px] bg-slate-50 p-2 text-center"><p className="text-[18px] font-bold text-ink">{d.counts[k] ?? 0}</p><p className="text-[11px] text-muted">{k}</p></div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

export function UsageCard({ usage }: { usage: Usage }) {
  return (
    <Card>
      <CardHeader title={`Usage and errors (last ${usage.days} days)`} subtitle={usage.costNote} />
      <div className="grid gap-3 px-5 pb-5">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-[10px] bg-slate-50 p-2"><p className="text-[18px] font-bold text-ink">{usage.total}</p><p className="text-[11px] text-muted">requests recorded</p></div>
          <div className="rounded-[10px] bg-slate-50 p-2"><p className={cx('text-[18px] font-bold', usage.failed ? 'text-rose-700' : 'text-ink')}>{usage.failed}</p><p className="text-[11px] text-muted">failed</p></div>
          <div className="rounded-[10px] bg-slate-50 p-2"><p className="text-[18px] font-bold text-ink">{usage.costEstimate === null ? '—' : usage.costEstimate.toFixed(2)}</p><p className="text-[11px] text-muted">estimated cost</p></div>
        </div>
        {Object.keys(usage.byKind).length > 0 && (
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-muted"><tr><th className="py-1">Kind</th><th className="py-1 text-right">Count</th><th className="py-1 text-right">Failed</th><th className="py-1 text-right">Units</th></tr></thead>
            <tbody>{Object.entries(usage.byKind).map(([k, v]) => <tr key={k} className="border-t border-line"><td className="py-1">{k}</td><td className="py-1 text-right">{v.count}</td><td className="py-1 text-right">{v.failed}</td><td className="py-1 text-right">{v.units}</td></tr>)}</tbody>
          </table>
        )}
        {usage.recent.length === 0 ? <p className="text-[12.5px] text-muted">Nothing recorded yet.</p> : (
          <ul className="grid max-h-64 gap-1.5 overflow-y-auto text-[12.5px]">
            {usage.recent.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                {r.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-600" />}
                <span className="min-w-0 flex-1"><b className="font-semibold">{r.kind}</b> · {when(r.at)}{r.latencyMs !== null ? ` · ${r.latencyMs} ms` : ''}{r.units ? ` · ${r.units} ${r.unitType ?? ''}` : ''}{r.message ? <span className="block text-muted">{r.code ? `${r.code}: ` : ''}{r.message}</span> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

type Business = { label: 'Connected' | 'Not connected' | 'Needs attention' | 'Configuration incomplete' | 'Provided by Tacksharp'; tone: 'brand' | 'slate' | 'rose' | 'amber' | 'sky'; detail: string; action: string };

/**
 * Plain-language status of one integration, from the server's real state: "Connected" only for this organization's
 * own tested and enabled account. The platform's account (pre-existing workspaces) is shown as provided by
 * Tacksharp, never as a verified connection of this workspace.
 */
export function businessStatus(i: Integration): Business {
  const missing = i.saved ? i.fields.filter((f) => f.required && (f.secret ? !i.secrets[f.key] : !i.config[f.key])).map((f) => f.label) : [];
  if (i.effective.source === 'organization') return { label: 'Connected', tone: 'brand', detail: `Working: last successful test ${when(i.lastSuccessAt)}.`, action: 'Manage' };
  if (i.status === 'failed') return { label: 'Needs attention', tone: 'rose', detail: 'The last connection test failed. Open it to see why, fix the details and test again.', action: 'Repair' };
  if (i.saved && missing.length) return { label: 'Configuration incomplete', tone: 'amber', detail: `Missing: ${missing.join(', ')}.`, action: 'Configure' };
  if (i.saved && i.status === 'untested') return { label: 'Configuration incomplete', tone: 'amber', detail: 'Saved, but not tested yet. A connection test proves it works.', action: 'Test' };
  if (i.saved && i.status === 'ok' && !i.enabled) return { label: 'Configuration incomplete', tone: 'amber', detail: 'Tested successfully but switched off. Enable it to use it.', action: 'Enable' };
  if (i.effective.source === 'environment' && !i.effective.reason) return { label: 'Provided by Tacksharp', tone: 'sky', detail: "Uses Tacksharp's account for your workspace. Connect your own account for your own number and billing.", action: 'Connect your own' };
  return { label: 'Not connected', tone: 'slate', detail: PROVIDER_META[i.provider].blurb, action: 'Connect' };
}

type ChannelState = { id: string; label: string; status: 'connected' | 'not_connected' | 'needs_attention' | 'incomplete'; detail: string; href: string };
const CHANNEL_STATUS: Record<ChannelState['status'], { label: string; tone: 'brand' | 'slate' | 'rose' | 'amber' }> = { connected: { label: 'Connected', tone: 'brand' }, not_connected: { label: 'Not connected', tone: 'slate' }, needs_attention: { label: 'Needs attention', tone: 'rose' }, incomplete: { label: 'Configuration incomplete', tone: 'amber' } };

/** What customers can use right now: one line per channel, from GET /home (the same truth as the Home checklist). */
export function ChannelSummary() {
  const { data } = useApi<{ channels: ChannelState[]; mode: { dryRun: boolean } }>('/home?range=today', 60_000);
  if (!data) return <Skeleton className="h-24 rounded-[14px]" />;
  return (
    <Card>
      <CardHeader title="What your customers can use" subtitle={data.mode.dryRun ? 'Test mode is on: messages and calls are checked, not sent.' : 'Live: customers who agreed can be contacted.'} />
      <ul className="grid gap-2 px-5 pb-5 sm:grid-cols-2" aria-label="Channels">
        {data.channels.map((c) => (
          <li key={c.id} className="flex items-start gap-3 rounded-[12px] border border-line p-3" data-testid={`channel-${c.id}`}>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">{c.label}<Badge tone={CHANNEL_STATUS[c.status].tone}>{CHANNEL_STATUS[c.status].label}</Badge></p>
              <p className="mt-0.5 text-[12.5px] text-body">{c.detail}</p>
            </div>
            {c.status !== 'connected' && <Link href={c.href} className="shrink-0 rounded-[8px] bg-ink px-2.5 py-1.5 text-[12.5px] font-semibold text-white">{c.status === 'needs_attention' ? 'Repair' : 'Complete setup'}</Link>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Settings → Integrations / AI providers overview: one card per provider with its real status. */
export function ProviderList({ group }: { group: 'Integrations' | 'AI providers' }) {
  const { data, error, reload } = useApi<{ items: Integration[]; deployment: Deployment }>('/integrations', 30_000);
  if (error && !data) return <ErrorBanner message={/permission/.test(error) ? 'Only workspace admins and managers can see integrations.' : error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-64 rounded-[14px]" />;
  const items = data.items.filter((i) => PROVIDER_META[i.provider].group === group);
  return (
    <div className="grid gap-4">
      {!data.deployment.vault.ready && <p role="note" className="flex items-start gap-2 rounded-[12px] bg-amber-50 px-4 py-3 text-[13px] text-amber-900"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{data.deployment.vault.problem}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((i) => {
          const b = businessStatus(i);
          return (
            <Link key={i.provider} href={PROVIDER_META[i.provider].href} className="group flex flex-col rounded-[var(--radius-card)] border border-line bg-white p-5 shadow-[var(--shadow-card)] transition-shadow hover:shadow-md focus-visible:outline-2" data-testid={`integration-${i.provider}`}>
              <div className="flex items-start justify-between gap-3">
                <div><h2 className="text-[15px] font-semibold text-ink">{PROVIDER_META[i.provider].name}</h2><p className="mt-0.5 text-[12.5px] text-muted">{PROVIDER_META[i.provider].blurb}</p></div>
                <Badge tone={b.tone}>{b.label}</Badge>
              </div>
              <p className="mt-3 text-[13px] text-body">{b.detail}</p>
              {i.lastError && i.status === 'failed' && <p className="mt-1 line-clamp-2 text-[12px] text-rose-700">{i.lastError}</p>}
              <p className="mt-2 text-[12px] text-muted">Last successful test: {when(i.lastSuccessAt)}</p>
              <span className="mt-auto pt-3 text-[13px] font-semibold text-brand group-hover:underline">{b.action} →</span>
            </Link>
          );
        })}
      </div>
      <p className="text-[12px] text-muted">Sending mode on this server: {data.deployment.mode.dryRun ? 'test mode (nothing is sent, no call is placed)' : `live (${data.deployment.mode.liveTestRecipients} approved test number(s))`}.</p>
    </div>
  );
}

type CapiEvent = { id: string; eventName: string; sourceType: string; customerId: string; orderRef: string | null; value: string | null; currency: string | null; actionSource: string; eventTime: string; status: string; attempts: number; lastError: string | null; testEvent: boolean; sentAt: string | null };
const CAPI_TONE: Record<string, string> = { sent: 'bg-emerald-50 text-emerald-800', simulated: 'bg-amber-50 text-amber-900', queued: 'bg-sky-50 text-sky-800', sending: 'bg-sky-50 text-sky-800', skipped: 'bg-slate-100 text-muted', failed: 'bg-rose-50 text-rose-700' };

/** Meta Conversions API: test event (Test events only) and the log of conversions recorded / sent. */
function CapiPanel({ data, canManage, busy, test }: { data: Integration; canManage: boolean; busy: string | null; test: (op: string, body?: Record<string, unknown>) => Promise<void> }) {
  const log = useApi<{ items: CapiEvent[]; counts: Record<string, number> }>('/meta-capi/events', 30_000);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [shown, setShown] = useState(20);
  const retry = async (id: string) => {
    setRetrying(id);
    try {
      await api.post(`/meta-capi/events/${id}/retry`, {});
      toast('Queued again. It is sent within a minute.');
      await log.reload();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setRetrying(null);
    }
  };
  return (
    <Card data-testid="capi-panel">
      <CardHeader title="Conversions sent to Meta" subtitle="Purchase = an order completed (collected / delivered). Lead = a new enquiry. Recorded every minute for the last 7 days; each is sent once." />
      <div className="px-5 pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button busy={busy === 'test-test_event'} disabled={!canManage || data.status !== 'ok' || !data.config.testEventCode} title={!data.config.testEventCode ? 'Set a test event code first' : undefined} onClick={() => void test('test_event')}>
          <Play className="size-4" /> Send test event
        </Button>
        <span className="text-[12px] text-muted">{data.config.testEventCode ? 'While a test event code is set, every event shows only under Test events in Events Manager (not used for ads).' : 'No test event code: events count as real conversions.'}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5" data-testid="capi-counts">
        {Object.entries(log.data?.counts ?? {}).filter(([, v]) => v > 0).map(([k, v]) => <span key={k} className={cx('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', CAPI_TONE[k])}>{v} {k}</span>)}
      </div>
      {log.error && <ErrorBanner message={log.error} onRetry={log.reload} />}
      {log.data && log.data.items.length === 0 && <p className="mt-3 text-[13px] text-muted">Nothing recorded yet. Events appear here once the integration is enabled and an order is completed or an enquiry arrives.</p>}
      {log.data && log.data.items.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[12.5px]" data-testid="capi-events">
            <thead className="text-muted"><tr><th className="py-1.5 pr-3">Event</th><th className="pr-3">Reference</th><th className="pr-3">Value</th><th className="pr-3">When</th><th className="pr-3">Status</th><th /></tr></thead>
            <tbody>
              {log.data.items.slice(0, shown).map((e) => (
                <tr key={e.id} className="border-t border-line align-top" data-testid="capi-event">
                  <td className="py-2 pr-3 font-semibold text-ink">{e.eventName}<div className="font-normal text-faint">{e.actionSource.replace('_', ' ')}</div></td>
                  <td className="pr-3">{e.orderRef ?? e.sourceType}</td>
                  <td className="pr-3">{e.value ? `${e.currency === 'INR' ? '₹' : `${e.currency} `}${e.value}` : '—'}</td>
                  <td className="pr-3">{when(e.eventTime)}</td>
                  <td className="pr-3"><span className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', CAPI_TONE[e.status])}>{e.status}{e.testEvent ? ' (test)' : ''}</span>{e.lastError && <div className="mt-0.5 max-w-[320px] text-muted">{e.lastError}</div>}</td>
                  <td>{canManage && ['failed', 'skipped'].includes(e.status) && <Button variant="ghost" busy={retrying === e.id} onClick={() => void retry(e.id)}>Retry</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {log.data.items.length > shown && <Button variant="ghost" className="mt-2" onClick={() => setShown((n) => n + 40)}>Show more ({log.data.items.length - shown} more of the latest 200)</Button>}
        </div>
      )}
      </div>
    </Card>
  );
}

/** Instagram & Messenger: the webhook Meta must call, and what works today. */
function SocialSetup({ data }: { data: Integration }) {
  const url = `${data.deployment.publicBaseUrl}/webhooks/meta-social`;
  return (
    <Card data-testid="social-setup">
      <CardHeader title="Connect the webhook" subtitle="In your Meta app → Webhooks: subscribe the Page's messages field and the Instagram messages field to this URL." />
      <div className="space-y-2 px-5 pb-5 text-[13px] text-body">
        <Row k="Callback URL"><code className="break-all text-[12px]">{url}</code></Row>
        <Row k="Verify token">the deployment's WhatsApp verify token (or META_SOCIAL_VERIFY_TOKEN)</Row>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px] text-muted">
          <li>Every delivery must be signed with the app secret saved here; unsigned or wrongly signed deliveries are refused.</li>
          <li>Enabling routes this Page and Instagram account to your workspace; disabling stops it.</li>
          <li>Messages appear in the Team inbox. Your team replies within 24 hours of the customer&apos;s last message (Meta&apos;s rule). STOP / START are honoured.</li>
          <li><b>Pending:</b> AI replies on Instagram / Messenger, images and files (shown as labels, not downloaded), delivery receipts.</li>
        </ul>
      </div>
    </Card>
  );
}
