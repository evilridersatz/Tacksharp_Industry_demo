'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Bot, CalendarDays, CheckCircle2, Info, Megaphone, Pause, Play, Plus, Send, ShieldCheck, Sparkles, Upload, Users, XCircle } from 'lucide-react';
import { API_URL, api, useApi } from '@/lib/api';
import type { Approval } from '@/lib/types';
import { dateOnly, dateTime, inr, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Segmented, Skeleton, cx, type Tone } from '@/components/ui';
import { Dialog, Label, Notice, TextileOnly, errorText, inputCls } from '@/components/textile';

// ------------------------------------------------------------------ types (API: /marketing/*)

type Overview = {
  consentedCustomers: number; segments: number; campaigns: { drafts: number; pendingApproval: number; running: number }; content: { pendingApproval: number; upcoming: number };
  mode: 'simulation' | 'live' | 'live_test_numbers_only'; templates: { configured: boolean; count: number; reason: string | null };
  permissions: { manage: boolean; approveCampaign: boolean; approveContent: boolean } | null;
  occasions: string[]; contentChannels: string[]; contentFormats: string[]; blocked: Array<{ feature: string; reason: string }>;
  ai?: { configured: boolean; usage: { marketingDrafts: number; inputTokens: number; outputTokens: number; note: string } };
};
type Rules = { tags?: string[]; language?: string; leadStatuses?: string[]; leadSources?: string[]; activeWithinDays?: number };
type Audience = { rules: Rules; inSegment: number; eligible: number; excluded: { optedOut: number; noConsent: number }; sample: Array<{ name: string; isDemo: boolean }> };
type Segment = Audience & { id: string; name: string; description: string | null; updatedAt: string };
type Campaign = {
  id: string; name: string; objective: string | null; occasion: string | null; segmentId: string | null; segmentName: string | null; brief: Record<string, unknown> | null;
  templateName: string | null; templateLanguage: string | null; templateParams: string[]; headerImageUrl: string | null; previewText: string | null; status: string;
  scheduledAt: string | null; approvalId: string | null; estimatedRecipients: number | null; estimatedCost: number | null; simulated: boolean; createdBy: string | null; createdAt: string;
  counts: Record<string, number>;
};
type CampaignDetail = Campaign & {
  approval: { id: string; status: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; requestedBy: string } | null;
  recipients: Array<{ id: string; name: string | null; phone: string | null; isDemo: boolean; status: string; reason: string | null; leadId: string | null; sentAt: string | null; repliedAt: string | null }>;
};
type Estimate = { eligible: number; inSegment: number; excluded: { optedOut: number; noConsent: number }; mode: string; rate: number | null; estimatedCost: number | null; problems: string[]; warnings: string[]; ready: boolean };
type Preview = { templateFound: boolean; templateNote: string | null; header: string | null; headerImageUrl: string | null; text: string; variablesExpected: number | null; variablesGiven: number; sampleCustomer: string };
type Template = { name: string; language: string; category: string; body: string; variables: number; header: string | null };
type Report = {
  campaignId: string; name: string; status: string; simulated: boolean; recipients: number; sent: number; delivered: number; read: number; replied: number; simulatedCount: number;
  skipped: number; failed: number; leads: number; quotations: number; orders: number; recordedOrderValue: number; verifiedCollections?: number; messagingCost: number | null; notes: string[];
};
type Customers = { totals: { customers: number; marketingConsent: number; suppressed: number }; tags: Array<{ tag: string; count: number }>; items: Array<{ id: string; name: string | null; phone: string | null; tags: string[]; marketingConsent: boolean; suppressed: boolean; isDemo: boolean; source: string | null }> };
type Content = { id: string; title: string; channel: string; format: string; body: string; mediaUrl: string | null; plannedFor: string; status: string; publishedAt: string | null; publishedNote: string | null };

type Tab = 'campaigns' | 'audience' | 'content' | 'performance' | 'approvals';
type Notify = (n: { tone: 'ok' | 'error'; text: string }) => void;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'slate' }, rejected: { label: 'Rejected', tone: 'rose' }, pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  scheduled: { label: 'Scheduled', tone: 'sky' }, sending: { label: 'Sending', tone: 'sky' }, paused: { label: 'Paused', tone: 'amber' }, completed: { label: 'Completed', tone: 'brand' },
  cancelled: { label: 'Cancelled', tone: 'slate' }, idea: { label: 'Idea', tone: 'slate' }, approved: { label: 'Approved', tone: 'brand' }, published: { label: 'Published', tone: 'violet' },
};
const RECIPIENT_TONE: Record<string, Tone> = { sent: 'sky', delivered: 'brand', read: 'brand', replied: 'violet', simulated: 'slate', skipped: 'amber', failed: 'rose', queued: 'slate', cancelled: 'slate' };
const MODE: Record<string, { label: string; tone: Tone }> = { simulation: { label: 'DRY_RUN: simulated, nothing is sent', tone: 'amber' }, live_test_numbers_only: { label: 'Live: approved test numbers only', tone: 'sky' }, live: { label: 'Live sending', tone: 'rose' } };
const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const clientKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function upload<T>(path: string, form: FormData): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { method: 'POST', body: form, credentials: 'include' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message ?? `Upload failed (${r.status})`);
  return body as T;
}

export default function MarketingPage() {
  return (
    <>
      <PageHeader title="Marketing" crumb="AI agents / Marketing" />
      <TextileOnly allow={['textile', 'retail', 'agency']}>
        <Suspense>
          <Marketing />
        </Suspense>
      </TextileOnly>
    </>
  );
}

function Marketing() {
  const params = useSearchParams();
  const qTab = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(qTab ?? 'campaigns');
  // The menu links to ?tab=audience / ?tab=performance: follow the URL when it changes on the same page.
  useEffect(() => setTab(qTab ?? 'campaigns'), [qTab]);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const { data: ov, error, reload } = useApi<Overview>('/marketing/overview', 20_000);
  if (error && !ov) return <ErrorBanner message={error} onRetry={reload} />;
  if (!ov) return <Skeleton className="h-60" />;
  const mode = MODE[ov.mode];
  return (
    <>
      <Notice notice={notice} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Customers with consent" value={ov.consentedCustomers} />
        <Stat label="Segments" value={ov.segments} />
        <Stat label="Draft campaigns" value={ov.campaigns.drafts} />
        <Stat label="Waiting for approval" value={ov.campaigns.pendingApproval + ov.content.pendingApproval} tone={ov.campaigns.pendingApproval + ov.content.pendingApproval ? 'amber' : undefined} />
        <Stat label="Sending / scheduled" value={ov.campaigns.running} />
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Marketing section" value={tab} onChange={setTab} options={[
          { value: 'campaigns', label: 'Campaigns' },
          { value: 'audience', label: 'Customers & segments' },
          { value: 'content', label: 'Content calendar' },
          { value: 'approvals', label: `Approvals${ov.campaigns.pendingApproval + ov.content.pendingApproval ? ` (${ov.campaigns.pendingApproval + ov.content.pendingApproval})` : ''}` },
          { value: 'performance', label: 'Performance' },
        ]} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={mode.tone} dot>{mode.label}</Badge>
          {!ov.templates.configured && <Badge tone="slate">Templates: not connected</Badge>}
          <Badge tone={ov.ai?.configured ? 'violet' : 'slate'}>{ov.ai?.configured ? 'AI drafts on' : 'AI not configured: template drafts'}</Badge>
        </div>
      </div>
      {tab === 'campaigns' && <Campaigns ov={ov} notify={setNotice} onChanged={reload} />}
      {tab === 'audience' && <Audience ov={ov} notify={setNotice} onChanged={reload} />}
      {tab === 'content' && <ContentCalendar ov={ov} notify={setNotice} onChanged={reload} />}
      {tab === 'approvals' && <Approvals notify={setNotice} onChanged={reload} />}
      {tab === 'performance' && <Performance ov={ov} />}
    </>
  );
}

function Stat({ label: l, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[12px] text-muted">{l}</p>
      <p className={cx('mt-0.5 text-[22px] font-bold text-ink', tone === 'amber' && 'text-amber-600')}>{value}</p>
    </Card>
  );
}

// ================================================================== campaigns

function Campaigns({ ov, notify, onChanged }: { ov: Overview; notify: Notify; onChanged: () => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('campaign');
  const { data: list, reload } = useApi<Campaign[]>('/marketing/campaigns', 15_000);
  const { data: segments } = useApi<Segment[]>('/marketing/segments', 60_000);
  const [briefOpen, setBriefOpen] = useState(false);
  const select = (id: string | null) => router.replace(id ? `/marketing?campaign=${id}` : '/marketing');
  const changed = async () => {
    await reload();
    onChanged();
  };
  const create = async () => {
    try {
      const c = await api.post<Campaign>('/marketing/campaigns', { name: `New campaign ${new Date().toLocaleDateString()}` });
      await changed();
      select(c.id);
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    }
  };
  return (
    <div className={cx('grid grid-cols-1 gap-4', selected && 'xl:grid-cols-[minmax(0,1fr)_620px]')}>
      <Card>
        <CardHeader
          title="Campaigns"
          subtitle="Meta-approved WhatsApp templates only. Nothing is sent until the exact message and audience are approved."
          action={ov.permissions?.manage && (
            <div className="flex shrink-0 gap-2 whitespace-nowrap">
              <Button onClick={() => setBriefOpen(true)}><Bot className="size-4" /> Draft with agent</Button>
              <Button variant="primary" onClick={create}><Plus className="size-4" /> New</Button>
            </div>
          )}
        />
        {!list ? <Skeleton className="m-5 h-40" /> : list.length === 0 ? (
          <Empty icon={<Megaphone className="size-5" />} title="No campaigns yet">Let the Marketing agent draft one from your catalogue, or start a blank draft.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((c) => {
              const s = STATUS[c.status] ?? { label: c.status, tone: 'slate' as Tone };
              return (
                <li key={c.id}>
                  <button onClick={() => select(c.id)} className={cx('flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-slate-50', selected === c.id && 'bg-brand-soft/40')}>
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-semibold text-ink">{c.name}</p>
                      <p className="truncate text-[12px] text-muted">{c.segmentName ?? 'No segment'} · {c.templateName ?? 'no template'} · {timeAgo(c.createdAt)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {c.simulated && <Badge tone="slate">simulated</Badge>}
                      {Object.keys(c.counts).length > 0 && <span className="text-[12px] text-muted">{Object.values(c.counts).reduce((a, b) => a + b, 0)} recipients</span>}
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {selected && <CampaignEditor id={selected} ov={ov} segments={segments ?? []} onClose={() => select(null)} onChanged={changed} notify={notify} />}
      <AgentBrief open={briefOpen} onClose={() => setBriefOpen(false)} ov={ov} segments={segments ?? []} notify={notify} onDone={async (id) => { await changed(); if (id) select(id); }} />
    </div>
  );
}

function AgentBrief({ open, onClose, ov, segments, notify, onDone }: { open: boolean; onClose: () => void; ov: Overview; segments: Segment[]; notify: Notify; onDone: (id?: string) => void }) {
  const [occasion, setOccasion] = useState('new_arrivals');
  const [segmentId, setSegmentId] = useState('');
  const [offer, setOffer] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ task: { status: string; result: { campaignId?: string } | null; error: string | null } }>('/agents/tasks', { kind: 'marketing.campaign_brief', input: { occasion, segmentId: segmentId || undefined, offer }, clientKey: clientKey() });
      if (r.task.status !== 'COMPLETED') throw new Error(r.task.error ?? `Agent task ${r.task.status.toLowerCase()}`);
      notify({ tone: 'ok', text: 'The Marketing agent drafted a campaign. Pick an approved template, check the preview and ask for approval.' });
      onClose();
      onDone(r.task.result?.campaignId);
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Draft a campaign with the Marketing agent">
      <div className="space-y-3">
        <p className="text-[12.5px] text-muted">The agent picks in-stock products from your catalogue (prices only when approved) and writes the brief and draft. It never sends.</p>
        <Label text="Occasion"><select className={inputCls} value={occasion} onChange={(e) => setOccasion(e.target.value)}>{ov.occasions.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></Label>
        <Label text="Segment"><select className={inputCls} value={segmentId} onChange={(e) => setSegmentId(e.target.value)}><option value="">Choose later</option>{segments.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.eligible} with consent)</option>)}</select></Label>
        <Label text="Offer (optional, exactly as you want it said)"><input className={inputCls} value={offer} maxLength={200} onChange={(e) => setOffer(e.target.value)} placeholder="Free blouse stitching till Sunday" /></Label>
        <div className="flex justify-end gap-2 pt-1"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={run}><Bot className="size-4" /> Draft</Button></div>
      </div>
    </Dialog>
  );
}

function CampaignEditor({ id, ov, segments, onClose, onChanged, notify }: { id: string; ov: Overview; segments: Segment[]; onClose: () => void; onChanged: () => void; notify: Notify }) {
  const { data: c, reload } = useApi<CampaignDetail>(`/marketing/campaigns/${id}`, 10_000);
  const { data: preview, reload: reloadPreview } = useApi<Preview>(`/marketing/campaigns/${id}/preview`, 0);
  const { data: est, reload: reloadEst } = useApi<Estimate>(`/marketing/campaigns/${id}/estimate`, 0);
  const { data: tpl } = useApi<{ configured: boolean; reason?: string; templates: Template[] }>('/marketing/templates', 0);
  const { data: report } = useApi<Report>(c && !['draft', 'rejected', 'pending_approval'].includes(c.status) ? `/marketing/campaigns/${id}/report` : null, 15_000);
  const [form, setForm] = useState<Partial<Campaign> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (c) setForm({ name: c.name, occasion: c.occasion, segmentId: c.segmentId, templateName: c.templateName, templateLanguage: c.templateLanguage, templateParams: c.templateParams, headerImageUrl: c.headerImageUrl, scheduledAt: c.scheduledAt });
  }, [c?.id, c?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c || !form) return <Skeleton className="h-96" />;
  const editable = ['draft', 'rejected'].includes(c.status) && ov.permissions?.manage;
  const template = tpl?.templates.find((t) => t.name === form.templateName && (!form.templateLanguage || t.language === form.templateLanguage));
  const varCount = template?.variables ?? Math.max(form.templateParams?.length ?? 0, 1);
  const set = (k: keyof Campaign, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const act = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(name);
    try {
      await fn();
      notify({ tone: 'ok', text: ok });
      await Promise.all([reload(), reloadPreview(), reloadEst()]);
      onChanged();
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const save = () => act('save', () => api.patch(`/marketing/campaigns/${id}`, { ...form, scheduledAt: form.scheduledAt || null, templateParams: (form.templateParams ?? []).slice(0, varCount) }), 'Draft saved.');
  const s = STATUS[c.status] ?? { label: c.status, tone: 'slate' as Tone };
  const brief = c.brief as { products?: string[]; message?: string; notes?: string[] } | null;
  return (
    <Card>
      <CardHeader title={c.name} subtitle={<span className="flex flex-wrap items-center gap-2"><Badge tone={s.tone}>{s.label}</Badge>{c.simulated && <Badge tone="slate">simulated (DRY_RUN)</Badge>}</span>} action={<Button variant="ghost" onClick={onClose}>Close</Button>} />
      <div className="space-y-4 px-5 pb-5">
        {c.status === 'rejected' && c.approval?.decisionNote && <p className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">Rejected: {c.approval.decisionNote}. Edit and ask again.</p>}
        {c.status === 'pending_approval' && <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700">Waiting for someone with campaign approval permission (Approvals tab or Agent Centre). It cannot be edited while waiting.</p>}
        {brief?.products?.length ? (
          <div className="rounded-[10px] bg-slate-50 px-3 py-2 text-[12.5px] text-body">
            <p className="font-semibold text-ink">Agent brief</p>
            <ul className="ml-4 list-disc">{brief.products.map((p) => <li key={p}>{p}</li>)}</ul>
            {brief.notes?.map((n) => <p key={n} className="mt-1 text-muted">{n}</p>)}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_240px]">
          <fieldset disabled={!editable} className="space-y-3">
            <Label text="Name"><input className={inputCls} value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Label>
            <div className="grid grid-cols-2 gap-3">
              <Label text="Occasion"><select className={inputCls} value={form.occasion ?? ''} onChange={(e) => set('occasion', e.target.value || null)}><option value="">-</option>{ov.occasions.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></Label>
              <Label text="Segment"><select className={inputCls} value={form.segmentId ?? ''} onChange={(e) => set('segmentId', e.target.value || null)}><option value="">Choose…</option>{segments.map((sg) => <option key={sg.id} value={sg.id}>{sg.name} ({sg.eligible})</option>)}</select></Label>
            </div>
            {tpl?.configured && tpl.templates.length ? (
              <Label text="Approved WhatsApp template">
                <select className={inputCls} value={form.templateName ? `${form.templateName}|${form.templateLanguage ?? ''}` : ''} onChange={(e) => { const [n, l] = e.target.value.split('|'); set('templateName', n || null); set('templateLanguage', l || null); }}>
                  <option value="">Choose…</option>
                  {tpl.templates.map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language}, {t.category.toLowerCase()})</option>)}
                </select>
              </Label>
            ) : (
              <div className="grid grid-cols-[1fr_90px] gap-3">
                <Label text="Approved template name (as in Meta)"><input className={inputCls} value={form.templateName ?? ''} onChange={(e) => set('templateName', e.target.value || null)} placeholder="diwali_offer" /></Label>
                <Label text="Language"><input className={inputCls} value={form.templateLanguage ?? ''} onChange={(e) => set('templateLanguage', e.target.value || null)} placeholder="ta" /></Label>
                <p className="col-span-2 -mt-1 text-[11.5px] text-muted">{tpl?.reason ?? 'Templates are not loaded from Meta.'} Use the exact name of a template Meta has approved.</p>
              </div>
            )}
            {Array.from({ length: varCount }).map((_, i) => (
              <Label key={i} text={`Variable {{${i + 1}}}`}>
                <input className={inputCls} value={form.templateParams?.[i] ?? ''} onChange={(e) => { const p = [...(form.templateParams ?? [])]; p[i] = e.target.value; set('templateParams', p); }} placeholder={i === 0 ? '{{name}}' : ''} />
              </Label>
            ))}
            <p className="text-[11.5px] text-muted">Use <code>{'{{name}}'}</code> for the customer’s first name and <code>{'{{shop}}'}</code> for your business name.</p>
            <div className="grid grid-cols-2 gap-3">
              <Label text="Header image (https, if the template has one)"><input className={inputCls} value={form.headerImageUrl ?? ''} onChange={(e) => set('headerImageUrl', e.target.value || null)} /></Label>
              <Label text="Schedule (optional)"><input type="datetime-local" className={inputCls} value={form.scheduledAt ? form.scheduledAt.slice(0, 16) : ''} onChange={(e) => set('scheduledAt', e.target.value ? new Date(e.target.value).toISOString() : null)} /></Label>
            </div>
            {editable && <div className="flex gap-2"><Button busy={busy === 'save'} onClick={save}>Save draft</Button></div>}
          </fieldset>
          <PhonePreview preview={preview} />
        </div>

        {est && ['draft', 'rejected'].includes(c.status) && (
          <div className="rounded-[12px] border border-line p-3 text-[12.5px]">
            <p className="font-semibold text-ink">Who gets it</p>
            <p className="mt-1 text-body"><b>{est.eligible}</b> customer(s) with marketing consent · {est.excluded.optedOut} opted out and {est.excluded.noConsent} without consent are excluded{est.estimatedCost !== null ? ` · about ${inr(est.estimatedCost)}` : ''}</p>
            {est.problems.map((p) => <p key={p} className="mt-1 flex items-center gap-1.5 text-rose"><XCircle className="size-3.5" /> {p}</p>)}
            {est.warnings.map((w) => <p key={w} className="mt-1 flex items-center gap-1.5 text-amber-700"><AlertTriangle className="size-3.5" /> {w}</p>)}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {editable && <Button variant="primary" disabled={!est?.ready} onClick={() => setConfirm(true)}><Send className="size-4" /> Review & ask for approval</Button>}
          {c.status === 'pending_approval' && ov.permissions?.manage && <Button busy={busy === 'withdraw'} onClick={() => act('withdraw', () => api.post(`/marketing/campaigns/${id}/withdraw`), 'Request withdrawn; the campaign is a draft again.')}>Withdraw request</Button>}
          {['sending', 'scheduled'].includes(c.status) && <Button busy={busy === 'pause'} onClick={() => act('pause', () => api.post(`/marketing/campaigns/${id}/pause`), 'Paused.')}><Pause className="size-4" /> Pause</Button>}
          {c.status === 'paused' && ov.permissions?.approveCampaign && <Button busy={busy === 'resume'} onClick={() => act('resume', () => api.post(`/marketing/campaigns/${id}/resume`), 'Resumed.')}><Play className="size-4" /> Resume</Button>}
          {!['completed', 'cancelled'].includes(c.status) && ov.permissions?.manage && <Button variant="danger" busy={busy === 'cancel'} onClick={() => act('cancel', () => api.post(`/marketing/campaigns/${id}/cancel`), 'Campaign cancelled.')}>Cancel campaign</Button>}
        </div>

        {report && <ReportView r={report} />}
        {c.recipients.length > 0 && (
          <div>
            <p className="mb-1 text-[12.5px] font-semibold text-ink">Recipients ({c.recipients.length})</p>
            <div className="max-h-72 overflow-auto rounded-[10px] border border-line">
              <table className="w-full text-[12.5px]">
                <tbody className="divide-y divide-line">
                  {c.recipients.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-1.5">{r.name ?? 'Customer'}{r.isDemo && <Badge tone="slate" className="ml-1">demo</Badge>}</td>
                      <td className="px-3 py-1.5 text-muted">{r.phone}</td>
                      <td className="px-3 py-1.5"><Badge tone={RECIPIENT_TONE[r.status] ?? 'slate'}>{r.status}</Badge></td>
                      <td className="px-3 py-1.5 text-muted">{r.reason ?? (r.repliedAt ? `replied ${timeAgo(r.repliedAt)}` : r.sentAt ? dateTime(r.sentAt) : '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      <ConfirmSend open={confirm} onClose={() => setConfirm(false)} campaign={c} est={est} preview={preview} canApprove={Boolean(ov.permissions?.approveCampaign)}
        onConfirm={(expected) => act('send', () => api.post(`/marketing/campaigns/${id}/request-send`, { confirm: true, expectedRecipients: expected }), ov.permissions?.approveCampaign ? 'Approved and started.' : 'Sent for approval.').then(() => setConfirm(false))} busy={busy === 'send'} />
    </Card>
  );
}

function PhonePreview({ preview }: { preview: Preview | null }) {
  return (
    <div className="self-start rounded-[22px] border-4 border-slate-800 bg-[#e5ddd5] p-2" aria-label="WhatsApp preview">
      <p className="mb-2 text-center text-[10.5px] text-slate-600">WhatsApp preview</p>
      <div className="rounded-[10px] bg-white p-2 text-[12.5px] shadow-sm">
        {preview?.headerImageUrl && <img src={preview.headerImageUrl} alt="" className="mb-2 max-h-32 w-full rounded-[6px] object-cover" />}
        <p className="whitespace-pre-wrap text-ink">{preview?.text || <span className="text-faint">Choose a template and variables.</span>}</p>
        <p className="mt-1 text-right text-[10px] text-faint">for {preview?.sampleCustomer ?? '…'}</p>
      </div>
      {preview?.templateNote && <p className="mt-2 text-[10.5px] text-slate-700">{preview.templateNote}</p>}
      {preview && preview.variablesExpected !== null && preview.variablesExpected !== preview.variablesGiven && <p className="mt-1 text-[10.5px] text-rose">Template needs {preview.variablesExpected} variable(s), {preview.variablesGiven} given.</p>}
    </div>
  );
}

function ConfirmSend({ open, onClose, campaign, est, preview, canApprove, onConfirm, busy }: { open: boolean; onClose: () => void; campaign: CampaignDetail; est: Estimate | null; preview: Preview | null; canApprove: boolean; onConfirm: (expected: number) => void; busy: boolean }) {
  const [ok, setOk] = useState(false);
  if (!est) return null;
  return (
    <Dialog open={open} onClose={onClose} title={canApprove ? 'Approve and send' : 'Ask for approval'} wide>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_240px]">
        <div className="space-y-2 text-[13px]">
          <p><b>{campaign.name}</b> → segment <b>{campaign.segmentName}</b></p>
          <p><b>{est.eligible}</b> customer(s) with marketing consent will get template <b>{campaign.templateName}</b> ({campaign.templateLanguage ?? 'default language'}).</p>
          <p className="text-muted">Excluded: {est.excluded.optedOut} opted out (STOP / do not contact), {est.excluded.noConsent} without consent.</p>
          <p>Estimated messaging cost: {est.estimatedCost !== null ? inr(est.estimatedCost) : 'set your WhatsApp rate in Settings → ROI'}</p>
          <p>{campaign.scheduledAt ? `Scheduled for ${dateTime(campaign.scheduledAt)}` : 'Starts as soon as it is approved.'}</p>
          {est.warnings.map((w) => <p key={w} className="flex items-center gap-1.5 text-amber-700"><AlertTriangle className="size-3.5" /> {w}</p>)}
          <label className="flex items-start gap-2 pt-2"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="mt-0.5" /> I checked the message and the audience. {canApprove ? 'Approve and start this campaign.' : 'Send it to an approver.'}</label>
          <p className="flex items-center gap-1.5 text-[12px] text-muted"><ShieldCheck className="size-3.5" /> Only this exact message is approved: any later change needs a new approval, and the audience can only shrink.</p>
        </div>
        <PhonePreview preview={preview} />
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button onClick={onClose}>Back</Button><Button variant="primary" disabled={!ok} busy={busy} onClick={() => onConfirm(est.eligible)}>{canApprove ? 'Approve & send' : 'Ask for approval'}</Button></div>
    </Dialog>
  );
}

function ReportView({ r }: { r: Report }) {
  const cells: Array<[string, ReactNode]> = [
    ['Sent', r.sent], ['Delivered', r.delivered], ['Replied', r.replied], ['Leads', r.leads], ['Quotations', r.quotations], ['Orders', r.orders], ['Order value (recorded)', inr(r.recordedOrderValue)], ['Verified cash', inr(r.verifiedCollections ?? 0)],
  ];
  return (
    <div className="rounded-[12px] border border-line p-3">
      <p className="text-[12.5px] font-semibold text-ink">Results{r.simulated ? ' (simulated)' : ''}</p>
      <div className="mt-2 grid grid-cols-4 gap-2">{cells.map(([k, v]) => <div key={k}><p className="text-[11px] text-muted">{k}</p><p className="text-[15px] font-bold text-ink">{v}</p></div>)}</div>
      <p className="mt-2 text-[11.5px] text-muted">Simulated {r.simulatedCount} · skipped {r.skipped} · failed {r.failed}{r.messagingCost !== null ? ` · messaging cost ≈ ${inr(r.messagingCost)}` : ''}</p>
      {r.notes.map((n) => <p key={n} className="mt-1 flex items-start gap-1.5 text-[11.5px] text-muted"><Info className="mt-0.5 size-3 shrink-0" /> {n}</p>)}
    </div>
  );
}

// ================================================================== customers & segments

function Audience({ ov, notify, onChanged }: { ov: Overview; notify: Notify; onChanged: () => void }) {
  const [filter, setFilter] = useState<{ q: string; consent: string; tag: string }>({ q: '', consent: '', tag: '' });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const { data: cust, reload } = useApi<Customers>(`/marketing/customers${qs ? `?${qs}` : ''}`, 30_000);
  const { data: segments, reload: reloadSeg } = useApi<Segment[]>('/marketing/segments', 30_000);
  const [importOpen, setImportOpen] = useState<'customers' | 'suppression' | null>(null);
  const [segOpen, setSegOpen] = useState(false);
  const changed = async () => {
    await Promise.all([reload(), reloadSeg()]);
    onChanged();
  };
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Card>
        <CardHeader title="Customers" subtitle={cust ? `${cust.totals.customers} customers · ${cust.totals.marketingConsent} with marketing consent · ${cust.totals.suppressed} opted out` : undefined}
          action={ov.permissions?.manage && <div className="flex shrink-0 gap-2 whitespace-nowrap"><Button onClick={() => setImportOpen('suppression')}>Suppression list</Button><Button variant="primary" onClick={() => setImportOpen('customers')}><Upload className="size-4" /> Import</Button></div>} />
        <div className="flex flex-wrap gap-2 px-5 pb-3">
          <input className={cx(inputCls, 'max-w-56')} placeholder="Search name / phone" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          <select className={cx(inputCls, 'max-w-44')} value={filter.consent} onChange={(e) => setFilter({ ...filter, consent: e.target.value })}><option value="">All</option><option value="yes">Can be messaged</option><option value="no">No consent</option><option value="suppressed">Opted out</option></select>
          <select className={cx(inputCls, 'max-w-44')} value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })}><option value="">Any tag</option>{cust?.tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}</select>
        </div>
        {!cust ? <Skeleton className="m-5 h-40" /> : cust.items.length === 0 ? <Empty icon={<Users className="size-5" />} title="No customers match">Import a CSV / Excel list with a phone column.</Empty> : (
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-[12.5px]">
              <tbody className="divide-y divide-line">
                {cust.items.map((c) => (
                  <tr key={c.id}>
                    <td className="px-5 py-2 font-medium text-ink">{c.name ?? 'Customer'}{c.isDemo && <Badge tone="slate" className="ml-1">demo</Badge>}</td>
                    <td className="px-3 py-2 text-muted">{c.phone}</td>
                    <td className="px-3 py-2">{c.tags.map((t) => <Badge key={t} tone="sky" className="mr-1">{t}</Badge>)}</td>
                    <td className="px-3 py-2">{c.suppressed ? <Badge tone="rose">opted out</Badge> : c.marketingConsent ? <Badge tone="brand">consent</Badge> : <Badge tone="slate">no consent</Badge>}</td>
                    <td className="px-3 py-2 text-right">
                      {ov.permissions?.manage && !c.suppressed && (
                        <button className="text-[12px] font-semibold text-brand hover:underline" onClick={async () => {
                          try {
                            if (!c.marketingConsent && !window.confirm(`Record that ${c.name ?? 'this customer'} agreed to receive marketing messages? Only do this if they actually agreed.`)) return;
                            await api.patch(`/marketing/customers/${c.id}`, { marketingConsent: !c.marketingConsent });
                            await changed();
                          } catch (e) { notify({ tone: 'error', text: errorText(e) }); }
                        }}>{c.marketingConsent ? 'Remove consent' : 'Record consent'}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Segments" subtitle="Always limited to customers with marketing consent who did not opt out." action={ov.permissions?.manage && <Button onClick={() => setSegOpen(true)}><Plus className="size-4" /> New segment</Button>} />
        {!segments ? <Skeleton className="m-5 h-32" /> : segments.length === 0 ? <Empty title="No segments yet">Create one from tags, language, lead status or recent activity.</Empty> : (
          <ul className="divide-y divide-line">
            {segments.map((s) => (
              <li key={s.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2"><p className="text-[13.5px] font-semibold text-ink">{s.name}</p><Badge tone="brand">{s.eligible} can be messaged</Badge></div>
                <p className="mt-0.5 text-[12px] text-muted">{describeRules(s.rules)} · {s.inSegment} match, {s.excluded.optedOut} opted out, {s.excluded.noConsent} no consent</p>
                {ov.permissions?.manage && <button className="mt-1 text-[12px] text-rose hover:underline" onClick={async () => { try { if (!window.confirm(`Delete segment "${s.name}"?`)) return; await fetch(`${API_URL}/marketing/segments/${s.id}`, { method: 'DELETE', credentials: 'include' }).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message ?? 'Delete failed'); }); await changed(); } catch (e) { notify({ tone: 'error', text: errorText(e) }); } }}>Delete</button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ImportDialog kind={importOpen} onClose={() => setImportOpen(null)} notify={notify} onDone={changed} />
      <SegmentDialog open={segOpen} onClose={() => setSegOpen(false)} tags={cust?.tags ?? []} notify={notify} onDone={changed} />
    </div>
  );
}

function describeRules(r: Rules) {
  const parts = [r.tags?.length ? `tags: ${r.tags.join(', ')}` : null, r.language ? `language: ${r.language}` : null, r.leadStatuses?.length ? `lead status: ${r.leadStatuses.join(', ')}` : null, r.leadSources?.length ? `source: ${r.leadSources.join(', ')}` : null, r.activeWithinDays ? `active in ${r.activeWithinDays} days` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'everyone';
}

type ImportResult = { committed: boolean; total: number; valid: number; invalid: number; duplicatesInFile: number; consentColumn: boolean; consentNote: string; invalidRows: Array<{ row: number; errors: string[] }>; created?: number; updated?: number; consentRecorded?: number; suppressedKept?: number; suppressed?: number };

function ImportDialog({ kind, onClose, notify, onDone }: { kind: 'customers' | 'suppression' | null; onClose: () => void; notify: Notify; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState('');
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setFile(null); setCheck(null); setConsentConfirmed(false); setTags(''); }, [kind]);
  const send = async (commit: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (kind === 'suppression') {
        const r = await upload<ImportResult>('/marketing/customers/suppression', form);
        notify({ tone: 'ok', text: `${r.suppressed} number(s) opted out of marketing.` });
        onClose();
        onDone();
        return;
      }
      form.append('tags', tags);
      form.append('commit', String(commit));
      form.append('consentConfirmed', String(consentConfirmed));
      const r = await upload<ImportResult>('/marketing/customers/import', form);
      setCheck(r);
      if (r.committed) {
        notify({ tone: 'ok', text: `Imported: ${r.created} new, ${r.updated} updated, consent recorded for ${r.consentRecorded}.` });
        onClose();
        onDone();
      }
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={kind !== null} onClose={onClose} title={kind === 'suppression' ? 'Upload a suppression list' : 'Import customers'} wide>
      <div className="space-y-3 text-[13px]">
        <p className="text-muted">{kind === 'suppression' ? 'CSV or Excel with a phone column. These numbers will never receive marketing messages.' : 'CSV or Excel (.xlsx). Columns are matched by name: Name, Phone / Mobile / WhatsApp, Email, Language, Tags, and a WhatsApp / marketing consent column (yes / no).'}</p>
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setCheck(null); }} />
        {kind === 'customers' && (
          <>
            <Label text="Add these tags to everyone in the file (optional)"><input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="diwali_2026, walk_in" /></Label>
            <label className="flex items-start gap-2"><input type="checkbox" checked={consentConfirmed} onChange={(e) => setConsentConfirmed(e.target.checked)} className="mt-0.5" /> The consent column records real permission these customers gave us to send WhatsApp marketing.</label>
          </>
        )}
        {check && (
          <div className="rounded-[10px] border border-line p-3">
            <p><b>{check.valid}</b> valid · <b>{check.invalid}</b> with problems · {check.duplicatesInFile} duplicate(s) in the file</p>
            <p className="mt-1 text-muted">{check.consentNote}</p>
            {check.invalidRows.slice(0, 8).map((r) => <p key={r.row} className="text-rose">Row {r.row}: {r.errors.join('; ')}</p>)}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {kind === 'customers' && <Button disabled={!file} busy={busy && !check} onClick={() => send(false)}>Check file</Button>}
          <Button variant="primary" disabled={!file || (kind === 'customers' && !check)} busy={busy} onClick={() => send(true)}>{kind === 'suppression' ? 'Opt these numbers out' : `Import ${check?.valid ?? ''}`}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function SegmentDialog({ open, onClose, tags, notify, onDone }: { open: boolean; onClose: () => void; tags: Array<{ tag: string; count: number }>; notify: Notify; onDone: () => void }) {
  const [name, setName] = useState('');
  const [rules, setRules] = useState<Rules>({});
  const [aud, setAud] = useState<Audience | null>(null);
  const [busy, setBusy] = useState(false);
  const rulesKey = JSON.stringify(rules);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void api.post<Audience>('/marketing/segments/preview', { rules }).then(setAud).catch(() => setAud(null)), 300);
    return () => clearTimeout(t);
  }, [open, rulesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleTag = (t: string) => setRules((r) => ({ ...r, tags: r.tags?.includes(t) ? r.tags.filter((x) => x !== t) : [...(r.tags ?? []), t] }));
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/marketing/segments', { name, rules });
      notify({ tone: 'ok', text: `Segment "${name}" saved.` });
      setName(''); setRules({});
      onClose();
      onDone();
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New segment">
      <div className="space-y-3 text-[13px]">
        <Label text="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Saree buyers" /></Label>
        <div><p className="text-[12.5px] font-semibold text-body">Tags (any of)</p><div className="mt-1 flex flex-wrap gap-1.5">{tags.length ? tags.map((t) => <button key={t.tag} type="button" onClick={() => toggleTag(t.tag)} className={cx('rounded-full border px-2.5 py-0.5 text-[12px]', rules.tags?.includes(t.tag) ? 'border-brand bg-brand-soft text-brand-dark' : 'border-line text-muted')}>{t.tag} ({t.count})</button>) : <span className="text-muted">No tags yet - add them when importing.</span>}</div></div>
        <div className="grid grid-cols-2 gap-3">
          <Label text="Language"><select className={inputCls} value={rules.language ?? ''} onChange={(e) => setRules({ ...rules, language: e.target.value || undefined })}><option value="">Any</option><option value="tamil">Tamil</option><option value="tanglish">Tanglish</option><option value="english">English</option></select></Label>
          <Label text="Messaged us in the last (days)"><input type="number" min={1} className={inputCls} value={rules.activeWithinDays ?? ''} onChange={(e) => setRules({ ...rules, activeWithinDays: Number(e.target.value) || undefined })} /></Label>
        </div>
        <Label text="Lead status (comma separated, optional)"><input className={inputCls} value={(rules.leadStatuses ?? []).join(', ')} onChange={(e) => setRules({ ...rules, leadStatuses: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="new, qualified" /></Label>
        {aud && <p className="rounded-[10px] bg-slate-50 px-3 py-2"><b>{aud.eligible}</b> can be messaged · {aud.inSegment} match · {aud.excluded.optedOut} opted out · {aud.excluded.noConsent} without consent</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} busy={busy} onClick={save}>Save segment</Button></div>
      </div>
    </Dialog>
  );
}

// ================================================================== content calendar

function ContentCalendar({ ov, notify, onChanged }: { ov: Overview; notify: Notify; onChanged: () => void }) {
  const from = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 3); return d; }, []);
  const to = useMemo(() => new Date(from.getTime() + 35 * 86_400_000), [from]);
  const { data: items, reload } = useApi<Content[]>(`/marketing/content?from=${from.toISOString()}&to=${to.toISOString()}`, 20_000);
  const [edit, setEdit] = useState<Partial<Content> | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const days = Array.from({ length: 35 }, (_, i) => new Date(from.getTime() + i * 86_400_000));
  const byDay = (d: Date) => (items ?? []).filter((i) => new Date(i.plannedFor).toDateString() === d.toDateString());
  const changed = async () => { await reload(); onChanged(); };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); notify({ tone: 'ok', text: ok }); await changed(); setEdit(null); } catch (e) { notify({ tone: 'error', text: errorText(e) }); }
  };
  const plan = async () => {
    setPlanBusy(true);
    try {
      const r = await api.post<{ task: { status: string; error: string | null; result: { created?: unknown[] } | null } }>('/agents/tasks', { kind: 'marketing.content_plan', input: { days: 14, channels: ['whatsapp_status', 'instagram'] }, clientKey: clientKey() });
      if (r.task.status !== 'COMPLETED') throw new Error(r.task.error ?? 'Agent task did not complete');
      notify({ tone: 'ok', text: `The Marketing agent drafted ${r.task.result?.created?.length ?? 0} posts for the next 14 days. Review, edit and approve them.` });
      await changed();
    } catch (e) { notify({ tone: 'error', text: errorText(e) }); } finally { setPlanBusy(false); }
  };
  return (
    <Card>
      <CardHeader title="Content calendar" subtitle="No social account is connected: approved posts are published by your team and marked as published here."
        action={ov.permissions?.manage && <div className="flex shrink-0 gap-2 whitespace-nowrap"><Button busy={planBusy} onClick={plan}><Bot className="size-4" /> Plan 2 weeks</Button><Button onClick={() => setAiOpen(true)}><Sparkles className="size-4" /> AI draft</Button><Button variant="primary" onClick={() => setEdit({ channel: 'whatsapp_status', format: 'story', plannedFor: new Date(Date.now() + 86_400_000).toISOString(), title: '', body: '' })}><Plus className="size-4" /> New post</Button></div>} />
      {!items ? <Skeleton className="m-5 h-64" /> : (
        <div className="grid grid-cols-7 gap-px border-t border-line bg-line">
          {days.map((d) => (
            <div key={d.toISOString()} className={cx('min-h-24 bg-white p-1.5', d.toDateString() === new Date().toDateString() && 'bg-brand-soft/30')}>
              <p className="text-[10.5px] font-semibold text-muted">{d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
              {byDay(d).map((i) => {
                const s = STATUS[i.status] ?? { label: i.status, tone: 'slate' as Tone };
                return (
                  <button key={i.id} onClick={() => setEdit(i)} className="mt-1 block w-full rounded-[6px] border border-line px-1.5 py-1 text-left text-[11px] hover:bg-slate-50">
                    <span className="block truncate font-semibold text-ink">{i.title}</span>
                    <span className="flex items-center justify-between gap-1 text-muted"><span className="truncate">{label(i.channel)}</span><Badge tone={s.tone}>{s.label}</Badge></span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <Dialog open={aiOpen} onClose={() => setAiOpen(false)} title="Draft with AI from your catalogue">
        {aiOpen && <AiDraftForm notify={notify} onDone={async () => { setAiOpen(false); await changed(); }} />}
      </Dialog>
      <Dialog open={edit !== null} onClose={() => setEdit(null)} title={edit?.id ? edit.title || 'Post' : 'New post'} wide>
        {edit && <ContentForm item={edit} ov={ov} onSave={(body) => act(() => (edit.id ? api.patch(`/marketing/content/${edit.id}`, body) : api.post('/marketing/content', body)), 'Saved.')}
          onApprove={() => act(() => api.post(`/marketing/content/${edit.id}/request-approval`), ov.permissions?.approveContent ? 'Approved.' : 'Sent for approval.')}
          onPublished={(note) => act(() => api.post(`/marketing/content/${edit.id}/published`, { note }), 'Marked as published.')}
          onCancel={() => act(() => api.post(`/marketing/content/${edit.id}/cancel`), 'Cancelled.')}
          notify={notify} onRevised={async () => { setEdit(null); await changed(); }} />}
      </Dialog>
    </Card>
  );
}

function ContentForm({ item, ov, onSave, onApprove, onPublished, onCancel, notify, onRevised }: { item: Partial<Content>; ov: Overview; onSave: (b: Partial<Content>) => void; onApprove: () => void; onPublished: (note: string) => void; onCancel: () => void; notify: Notify; onRevised: () => void }) {
  const [f, setF] = useState(item);
  const [note, setNote] = useState('');
  const [rewrite, setRewrite] = useState(false);
  const editable = !item.id || ['idea', 'draft', 'approved'].includes(item.status ?? 'draft');
  return (
    <div className="space-y-3 text-[13px]">
      <fieldset disabled={!editable || !ov.permissions?.manage} className="space-y-3">
        <Label text="Title"><input className={inputCls} value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} /></Label>
        <div className="grid grid-cols-3 gap-3">
          <Label text="Channel"><select className={inputCls} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{ov.contentChannels.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Label>
          <Label text="Format"><select className={inputCls} value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>{ov.contentFormats.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Label>
          <Label text="Date"><input type="date" className={inputCls} value={(f.plannedFor ?? '').slice(0, 10)} onChange={(e) => setF({ ...f, plannedFor: new Date(`${e.target.value}T10:00:00`).toISOString() })} /></Label>
        </div>
        <Label text="Text"><textarea className={cx(inputCls, 'h-28 py-2')} value={f.body ?? ''} onChange={(e) => setF({ ...f, body: e.target.value })} /></Label>
        <Label text="Image / video link (https, optional)"><input className={inputCls} value={f.mediaUrl ?? ''} onChange={(e) => setF({ ...f, mediaUrl: e.target.value || null })} /></Label>
      </fieldset>
      {item.id && editable && ov.permissions?.manage && (
        <div className="rounded-[10px] border border-line p-2">
          <button type="button" className="flex items-center gap-1.5 text-[12.5px] font-semibold text-brand" onClick={() => setRewrite(!rewrite)}><Sparkles className="size-3.5" /> {rewrite ? 'Hide AI rewrite' : 'Rewrite with AI'}</button>
          {rewrite && <div className="mt-2"><AiDraftForm contentId={item.id} notify={notify} onDone={onRevised} /></div>}
        </div>
      )}
      {item.id && <Revisions id={item.id} canRestore={Boolean(editable && ov.permissions?.manage)} notify={notify} onRestored={onRevised} />}
      {item.status === 'published' && <p className="flex items-center gap-1.5 text-brand-dark"><CheckCircle2 className="size-4" /> Published {dateOnly(item.publishedAt)}{item.publishedNote ? ` - ${item.publishedNote}` : ''}</p>}
      {item.status === 'pending_approval' && <p className="text-amber-700">Waiting for approval (Approvals tab).</p>}
      {item.status === 'approved' && ov.permissions?.manage && (
        <div className="flex items-end gap-2 rounded-[10px] bg-slate-50 p-2">
          <Label text="Posted it? Link or note (optional)" className="flex-1"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Label>
          <Button onClick={() => onPublished(note)}><CalendarDays className="size-4" /> Mark published</Button>
        </div>
      )}
      {ov.permissions?.manage && (
        <div className="flex flex-wrap justify-end gap-2">
          {item.id && !['published', 'cancelled'].includes(item.status ?? '') && <Button variant="danger" onClick={onCancel}>Cancel post</Button>}
          {editable && <Button onClick={() => onSave({ title: f.title, channel: f.channel, format: f.format, body: f.body, mediaUrl: f.mediaUrl, plannedFor: f.plannedFor })}>{item.status === 'approved' ? 'Save (needs approval again)' : 'Save'}</Button>}
          {item.id && ['idea', 'draft'].includes(item.status ?? '') && <Button variant="primary" onClick={onApprove}>{ov.permissions.approveContent ? 'Approve' : 'Ask for approval'}</Button>}
        </div>
      )}
    </div>
  );
}

type Revision = { id: string; title: string; body: string; source: 'ai' | 'template' | 'manual'; model: string | null; language: string | null; inputTokens: number | null; outputTokens: number | null; removed: string[] | null; createdBy: string; createdAt: string };
type ProductLite = { id: string; name: string; priceApproved: boolean; active: boolean };

function AiDraftForm({ contentId, notify, onDone }: { contentId?: string; notify: Notify; onDone: () => void }) {
  const { data: products } = useApi<ProductLite[]>('/textile/products?active=true', 0);
  const [kind, setKind] = useState('caption');
  const [language, setLanguage] = useState('english');
  const [productIds, setProductIds] = useState<string[]>([]);
  const [offer, setOffer] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ source: string; note: string | null; removed: string[] }>('/marketing/content/ai-draft', { contentId, kind, language, productIds, offer: offer || undefined });
      notify({ tone: 'ok', text: `${r.source === 'ai' ? 'AI draft saved' : 'Template draft saved'}${r.note ? ` - ${r.note.replace(/\.$/, '')}` : ''}. Review it and ask for approval before posting.` });
      onDone();
    } catch (e) { notify({ tone: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 text-[13px]">
      <div className="grid grid-cols-2 gap-3">
        <Label text="Type"><select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}><option value="caption">Caption</option><option value="promo">Promotional message</option><option value="reel_script">Reels script</option><option value="broadcast">WhatsApp broadcast</option></select></Label>
        <Label text="Language"><select className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value)}><option value="english">English</option><option value="tamil">Tamil</option><option value="tanglish">Tanglish</option></select></Label>
      </div>
      <div>
        <p className="text-[12.5px] font-semibold text-body">Products (up to 6; prices only where approved)</p>
        <div className="mt-1 flex max-h-28 flex-wrap gap-1.5 overflow-auto">
          {(products ?? []).slice(0, 60).map((p) => (
            <button key={p.id} type="button" onClick={() => setProductIds((ids) => (ids.includes(p.id) ? ids.filter((x) => x !== p.id) : ids.length < 6 ? [...ids, p.id] : ids))} className={cx('rounded-full border px-2.5 py-0.5 text-[12px]', productIds.includes(p.id) ? 'border-brand bg-brand-soft text-brand-dark' : 'border-line text-muted')}>{p.name}{!p.priceApproved && ' (no price)'}</button>
          ))}
          {products && !products.length && <span className="text-muted">No active products in the catalogue.</span>}
        </div>
      </div>
      <Label text="Offer (optional, used word for word; leave empty for none)"><input className={inputCls} value={offer} maxLength={200} onChange={(e) => setOffer(e.target.value)} /></Label>
      <p className="text-[11.5px] text-muted">The model sees only these catalogue facts. Any price, discount, stock or delivery claim not in them is removed before you see the draft.</p>
      <div className="flex justify-end"><Button variant="primary" busy={busy} onClick={go}><Sparkles className="size-4" /> {contentId ? 'Rewrite' : 'Draft'}</Button></div>
    </div>
  );
}

function Revisions({ id, canRestore, notify, onRestored }: { id: string; canRestore: boolean; notify: Notify; onRestored: () => void }) {
  const { data } = useApi<Revision[]>(`/marketing/content/${id}/revisions`, 0);
  const [open, setOpen] = useState(false);
  if (!data?.length) return null;
  return (
    <div className="rounded-[10px] bg-slate-50 p-2 text-[12px]">
      <button type="button" className="font-semibold text-body" onClick={() => setOpen(!open)}>Revision history ({data.length})</button>
      {open && (
        <ul className="mt-1 space-y-1.5">
          {data.map((r, i) => (
            <li key={r.id} className="border-t border-line pt-1.5 first:border-t-0">
              <span className="flex items-center justify-between gap-2">
                <span><Badge tone={r.source === 'ai' ? 'violet' : r.source === 'template' ? 'sky' : 'slate'}>{r.source}</Badge> {timeAgo(r.createdAt)}{r.model ? ` · ${r.model}` : ''}{r.language ? ` · ${r.language}` : ''}</span>
                {canRestore && i > 0 && <button className="font-semibold text-brand" onClick={async () => { try { await api.post(`/marketing/content/${id}/revisions/${r.id}/restore`); notify({ tone: 'ok', text: 'Revision restored as a new draft.' }); onRestored(); } catch (e) { notify({ tone: 'error', text: errorText(e) }); } }}>Restore</button>}
              </span>
              <span className="block whitespace-pre-wrap text-body">{r.body.slice(0, 300)}</span>
              {r.removed?.length ? <span className="block text-amber-700">Removed (not in catalogue): {r.removed.join(' | ').slice(0, 300)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ================================================================== approvals (campaign sends + content)

function Approvals({ notify, onChanged }: { notify: Notify; onChanged: () => void }) {
  const { data, reload } = useApi<Approval[]>('/agents/approvals/list?status=pending', 15_000);
  const items = (data ?? []).filter((a) => a.action.startsWith('marketing.') || String(a.payload?.proposed ?? '').startsWith('marketing.'));
  const decide = async (a: Approval, decision: 'approve' | 'reject') => {
    const note = decision === 'reject' ? window.prompt('Reason for rejecting') : undefined;
    if (decision === 'reject' && !note) return;
    try {
      const r = await api.post<Approval>(`/agents/approvals/${a.id}/${decision}`, { note });
      notify({ tone: r.status === 'failed' ? 'error' : 'ok', text: r.status === 'failed' ? `Approved, but it could not run: ${String((r.executionResult as { error?: string } | null)?.error ?? 'error')}` : decision === 'approve' ? 'Approved.' : 'Rejected.' });
      await reload();
      onChanged();
    } catch (e) {
      notify({ tone: 'error', text: errorText(e) });
    }
  };
  return (
    <Card>
      <CardHeader title="Waiting for approval" subtitle="Campaign sends need marketing.approve_campaign; posts need marketing.approve_content. Approving a campaign starts it with exactly the content shown." />
      {!data ? <Skeleton className="m-5 h-32" /> : items.length === 0 ? <Empty icon={<ShieldCheck className="size-5" />} title="Nothing waiting" /> : (
        <ul className="divide-y divide-line">
          {items.map((a) => (
            <li key={a.id} className="px-5 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-ink">{a.reason}</p>
                  <p className="text-[12px] text-muted">{a.requestedBy.startsWith('agent:') ? 'Marketing agent' : 'Team member'} · {timeAgo(a.createdAt)} · needs {a.requiredPermission}</p>
                  {typeof a.payload?.preview === 'string' && a.payload.preview && <p className="mt-1 whitespace-pre-wrap rounded-[8px] bg-[#e5ddd5] p-2 text-[12px] text-ink">{a.payload.preview}</p>}
                  {typeof a.payload?.body === 'string' && <p className="mt-1 whitespace-pre-wrap rounded-[8px] bg-slate-50 p-2 text-[12px] text-ink">{a.payload.body}</p>}
                </div>
                <div className="flex shrink-0 gap-2"><Button variant="danger" onClick={() => decide(a, 'reject')}>Reject</Button><Button variant="primary" onClick={() => decide(a, 'approve')}>Approve</Button></div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ================================================================== performance

function Performance({ ov }: { ov: Overview }) {
  const { data } = useApi<{ days: number; totals: Record<string, number>; campaigns: Report[]; adSpend: { available: boolean; reason: string } }>('/marketing/performance?days=90', 30_000);
  if (!data) return <Skeleton className="h-64" />;
  const t = data.totals;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {(['campaigns', 'sent', 'delivered', 'replied', 'leads', 'quotations', 'orders'] as const).map((k) => <Stat key={k} label={label(k)} value={t[k] ?? 0} />)}
        <Stat label="Verified cash" value={inr(t.verifiedCollections ?? 0)} />
      </div>
      <Card>
        <CardHeader title="Campaign results (last 90 days)" subtitle="Credited by replies to delivered campaign messages. Simulated campaigns show no deliveries." />
        {data.campaigns.length === 0 ? <Empty title="No campaigns have run yet" /> : (
          <div className="overflow-auto">
            <table className="w-full text-[12.5px]">
              <thead className="text-left text-muted"><tr>{['Campaign', 'Status', 'Sent', 'Delivered', 'Replied', 'Leads', 'Quotations', 'Orders', 'Order value', 'Verified cash', 'Messaging cost'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {data.campaigns.map((r) => (
                  <tr key={r.campaignId}>
                    <td className="px-3 py-2 font-medium text-ink">{r.name}{r.simulated && <Badge tone="slate" className="ml-1">simulated</Badge>}</td>
                    <td className="px-3 py-2">{STATUS[r.status]?.label ?? r.status}</td>
                    <td className="px-3 py-2">{r.sent}</td><td className="px-3 py-2">{r.delivered}</td><td className="px-3 py-2">{r.replied}</td>
                    <td className="px-3 py-2">{r.leads}</td><td className="px-3 py-2">{r.quotations}</td><td className="px-3 py-2">{r.orders}</td>
                    <td className="px-3 py-2">{inr(r.recordedOrderValue)}</td><td className="px-3 py-2">{inr(r.verifiedCollections ?? 0)}</td><td className="px-3 py-2">{r.messagingCost === null ? '-' : inr(r.messagingCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card className="p-4">
        <p className="text-[13px] font-semibold text-ink">Not available yet</p>
        {ov.blocked.map((b) => <p key={b.feature} className="mt-1 flex items-start gap-1.5 text-[12.5px] text-muted"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" /> <b className="text-body">{b.feature}:</b> {b.reason}</p>)}
        <p className="mt-2 text-[12px] text-muted">For enquiries by lead source / campaign across all channels, run “Enquiries by source” in the Agent Centre.</p>
      </Card>
    </div>
  );
}
