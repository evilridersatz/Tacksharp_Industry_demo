'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { MessageCircle, Phone, Plus, ShieldAlert, ShieldCheck, Upload, UserPlus, Users } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { industryDef } from '@/lib/industries';
import { PageHeader } from '@/components/shell';
import { Button, Card, Empty, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { DataList, Pill, SearchBox, SourceNote, Timeline, Toolbar } from '@/components/vertical-ui';
import { Dialog, Label, inputCls } from '@/components/textile';
import { Pager } from '@/components/visionops';

type Customer = {
  id: string; name: string | null; phone: string | null; email: string | null; language: string | null; location: string | null; source: string | null;
  tags: string[] | null; messagingConsent: boolean; callingConsent: boolean; optedOutAt: string | null; doNotContact: boolean; isDemo: boolean;
  lastInboundAt: string | null; createdAt: string; updatedAt: string; contactable: { whatsapp: boolean; call: boolean };
  _count?: { leads: number; Conversation: number; calls: number };
};
type Readiness = { live: boolean; liveReason: string | null; whatsapp: { blockers: string[]; windowOpen: boolean; needsTemplate: boolean; templateConfigured: boolean }; call: { blockers: string[] } };
type Detail = {
  customer: Customer; contactReadiness: Readiness;
  leads: Array<{ id: string; status: string; source: string | null; createdAt: string }>;
  conversations: Array<{ id: string; channel: string; status: string; updatedAt: string; Message: Array<{ id: string; role: string; content: string; createdAt: string; deliveryStatus: string | null; deliveryError: string | null }> }>;
  calls: Array<{ id: string; direction: string; status: string; outcome: string | null; durationSec: number | null; createdAt: string }>;
  followUps: Array<{ id: string; channel: string; status: string; scheduledAt: string; lastError: string | null }>;
  orders: Array<{ id: string; orderNumber: string; status: string; total: string; createdAt: string }>;
  reservations: Array<{ id: string; reference: string; status: string; checkIn: string }>;
  appointments: Array<{ id: string; reference: string; status: string; startAt: string }>;
  salesOrders: Array<{ id: string; number: string; status: string; total: string; createdAt: string }>;
  audit: Array<{ id: string; action: string; actor: string; createdAt: string; data: Record<string, unknown> | null }>;
};

/** What this list is called in each industry (the records are the same tenant-scoped customers). */
const NOUN: Record<string, { many: string; one: string }> = {
  hotel: { many: 'Guests', one: 'guest' }, hospital: { many: 'Patient contacts', one: 'patient contact' }, agency: { many: 'Clients & contacts', one: 'contact' },
  real_estate: { many: 'Buyers & contacts', one: 'contact' }, manufacturing: { many: 'Customer contacts', one: 'contact' },
};
const LANGS = ['english', 'tamil', 'tanglish', 'hindi', 'malayalam', 'telugu', 'kannada'];
const CONSENT_SOURCES: Array<[string, string]> = [['customer_message', 'Customer asked us on WhatsApp / SMS'], ['website_form', 'Website or ad form with consent text'], ['in_person', 'In person (signed / verbal, noted)'], ['phone_call', 'On a phone call'], ['import_with_proof', 'Imported list with consent proof'], ['other', 'Other (describe in notes)']];
const ago = (iso: string | null) => {
  if (!iso) return '—';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};

function ContactsPage() {
  const { workspace } = useWorkspace();
  const def = industryDef(workspace?.industry);
  const noun = NOUN[workspace?.industry ?? ''] ?? { many: 'Customers', one: 'customer' };
  const [q, setQ] = useState('');
  const [consent, setConsent] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('open'); if (id) setOpen(id); }, []);
  const path = `/customers?${new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...(consent ? { consent } : {}), page: String(page), pageSize: '25' })}`;
  const { data, error, reload } = useApi<{ total: number; page: number; pageSize: number; rows: Customer[] }>(path, 20_000);
  const filtered = Boolean(q.trim() || consent);

  return (
    <>
      <PageHeader title={noun.many} actions={<Button variant="primary" onClick={() => setAdding(true)}><UserPlus className="size-4" /> Add {noun.one}</Button>} />
      <Toolbar>
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name, phone or email" />
        <select aria-label="Consent filter" className={cx(inputCls.replace('w-full', 'w-auto min-w-[190px]'), 'h-10')} value={consent} onChange={(e) => { setConsent(e.target.value); setPage(1); }}>
          <option value="">Everyone</option><option value="messaging">Can message on WhatsApp</option><option value="calling">Can be called</option><option value="none">No consent recorded</option><option value="opted_out">Opted out / do not contact</option>
        </select>
      </Toolbar>
      {error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data ? <Skeleton className="h-72" /> : data.total === 0 && !filtered ? (
        <Card>
          <Empty icon={<Users className="size-6" />} title={workspace?.isDemo ? `No ${noun.many.toLowerCase()} in this demo workspace` : `No ${noun.many.toLowerCase()} yet`}>
            <p className="mx-auto max-w-[460px]">{workspace?.isDemo ? 'Demo records appear here when the demo is seeded.' : `This is your live ${def.label.toLowerCase()} workspace. Add your first ${noun.one}, or import a list you have consent for. Customers who message your WhatsApp number are added automatically.`}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" /> Add {noun.one}</Button>
              <Button href="/marketing?tab=audience"><Upload className="size-4" /> Import a list</Button>
            </div>
          </Empty>
        </Card>
      ) : (
        <>
          <DataList
            rows={data.rows} rowKey={(r) => r.id} onOpen={(r) => setOpen(r.id)} empty={`No ${noun.many.toLowerCase()} match these filters.`}
            columns={[
              { head: 'Name', cell: (r) => <div><p className="font-semibold text-ink">{r.name ?? 'Unnamed'}{r.isDemo && <Pill tone="slate" className="ml-1.5">demo</Pill>}</p><p className="text-[11.5px] text-muted">{r.email ?? r.location ?? ''}</p></div> },
              { head: 'Phone', cell: (r) => <span className="tabular-nums">{r.phone ? `+${r.phone}` : '—'}</span> },
              { head: 'Consent', cell: (r) => <ConsentPills c={r} /> },
              { head: 'Source', cell: (r) => <span className="text-[12px]">{r.source ?? '—'}</span> },
              { head: 'Activity', cell: (r) => <span className="text-[12px] text-muted">{r._count ? `${r._count.Conversation} chats · ${r._count.calls} calls · ${r._count.leads} enquiries` : ''}</span> },
              { head: 'Updated', cell: (r) => <span className="text-[12px] text-muted">{ago(r.updatedAt)}</span> },
            ]}
            card={(r) => <div><p className="font-semibold text-ink">{r.name ?? 'Unnamed'}</p><p className="text-[12px] text-muted">{r.phone ? `+${r.phone}` : '—'} · {ago(r.updatedAt)}</p><div className="mt-1"><ConsentPills c={r} /></div></div>}
          />
          <Pager page={data.page} total={data.total} size={data.pageSize} onPage={setPage} />
        </>
      )}
      <SourceNote api="GET /customers · POST /customers · PATCH /customers/:id" />
      <AddCustomer open={adding} noun={noun.one} onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); void reload(); setOpen(id); }} />
      {open && <CustomerDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function ConsentPills({ c }: { c: Customer }) {
  // Plain consent labels. A number on a test list is never consent; only what the customer agreed to is shown.
  if (c.optedOutAt || c.doNotContact) return <Pill tone="red">{c.optedOutAt ? 'Contact opted out' : 'Do not contact'}</Pill>;
  return (
    <span className="flex flex-wrap gap-1">
      <Pill tone={c.messagingConsent ? 'green' : 'slate'}>{c.messagingConsent ? 'WhatsApp: consent recorded' : 'WhatsApp: consent not recorded'}</Pill>
      <Pill tone={c.callingConsent ? 'green' : 'slate'}>{c.callingConsent ? 'Calls: consent recorded' : 'Calls: consent not recorded'}</Pill>
    </span>
  );
}

type Form = { name: string; phone: string; email: string; language: string; location: string; tags: string; messagingConsent: boolean; callingConsent: boolean; consentSource: string };
const EMPTY: Form = { name: '', phone: '', email: '', language: '', location: '', tags: '', messagingConsent: false, callingConsent: false, consentSource: '' };
const fieldErrors = (e: unknown) => (e instanceof ApiError && e.body && typeof e.body === 'object' ? ((e.body as { errors?: Record<string, string> }).errors ?? {}) : {});

function CustomerForm({ f, set, errors }: { f: Form; set: (p: Partial<Form>) => void; errors: Record<string, string> }) {
  const err = (k: string) => errors[k] && <span role="alert" className="mt-1 block text-[12px] font-normal text-rose-700">{errors[k]}</span>;
  const consent = f.messagingConsent || f.callingConsent;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Label text="Name *"><input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} required aria-invalid={Boolean(errors.name)} autoComplete="name" />{err('name')}</Label>
      <Label text="Mobile number *"><input className={inputCls} value={f.phone} onChange={(e) => set({ phone: e.target.value })} required inputMode="tel" placeholder="98765 43210 or +91…" aria-invalid={Boolean(errors.phone)} autoComplete="tel" />{err('phone')}</Label>
      <Label text="Email"><input className={inputCls} value={f.email} onChange={(e) => set({ email: e.target.value })} type="email" aria-invalid={Boolean(errors.email)} autoComplete="email" />{err('email')}</Label>
      <Label text="Language"><select className={inputCls} value={f.language} onChange={(e) => set({ language: e.target.value })}><option value="">Not known</option>{LANGS.map((l) => <option key={l} value={l}>{l}</option>)}</select>{err('language')}</Label>
      <Label text="Area / city"><input className={inputCls} value={f.location} onChange={(e) => set({ location: e.target.value })} /></Label>
      <Label text="Tags (comma separated)"><input className={inputCls} value={f.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="wholesale, vip" />{err('tags')}</Label>
      <fieldset className="rounded-[10px] border border-line p-3 sm:col-span-2">
        <legend className="px-1 text-[12.5px] font-semibold text-body">Consent (only what the customer actually agreed to)</legend>
        <label className="flex min-h-9 items-center gap-2 text-[13px]"><input type="checkbox" checked={f.messagingConsent} onChange={(e) => set({ messagingConsent: e.target.checked })} /> May receive WhatsApp messages from us</label>
        <label className="flex min-h-9 items-center gap-2 text-[13px]"><input type="checkbox" checked={f.callingConsent} onChange={(e) => set({ callingConsent: e.target.checked })} /> May receive calls (including AI calls)</label>
        {consent && (
          <Label text="How did they give consent? *" className="mt-2">
            <select className={inputCls} value={f.consentSource} onChange={(e) => set({ consentSource: e.target.value })} aria-invalid={Boolean(errors.consentSource)}><option value="">Choose…</option>{CONSENT_SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>{err('consentSource')}
          </Label>
        )}
      </fieldset>
    </div>
  );
}

const toBody = (f: Form) => ({ name: f.name, phone: f.phone, email: f.email, language: f.language, location: f.location, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), messagingConsent: f.messagingConsent, callingConsent: f.callingConsent, consentSource: f.consentSource || undefined });

function AddCustomer({ open, noun, onClose, onSaved }: { open: boolean; noun: string; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setF(EMPTY); setErrors({}); setMsg(null); } }, [open]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (f.name.trim().length < 2) local.name = 'Enter the name.';
    if (f.phone.replace(/\D/g, '').length < 10) local.phone = 'Enter a 10-digit mobile number (with country code if not Indian).';
    if ((f.messagingConsent || f.callingConsent) && !f.consentSource) local.consentSource = 'Say how they gave consent.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    setMsg(null);
    try {
      const c = await api.post<Customer>('/customers', toBody(f));
      onSaved(c.id);
    } catch (err) {
      setErrors(fieldErrors(err));
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={`Add ${noun}`} wide>
      <form onSubmit={save} noValidate>
        <CustomerForm f={f} set={(p) => setF((x) => ({ ...x, ...p }))} errors={errors} />
        {msg && <p role="alert" className="mt-3 rounded-[10px] bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800">{msg}</p>}
        <div className="mt-4 flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save {noun}</Button></div>
      </form>
    </Dialog>
  );
}

function CustomerDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useApi<Detail>(`/customers/${id}`, 0);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'whatsapp' | 'call' | null>(null);
  const [tracked, setTracked] = useState<string | null>(null);
  const c = data?.customer;
  useEffect(() => {
    if (c) setF({ name: c.name ?? '', phone: c.phone ?? '', email: c.email ?? '', language: c.language ?? '', location: c.location ?? '', tags: (c.tags ?? []).join(', '), messagingConsent: c.messagingConsent, callingConsent: c.callingConsent, consentSource: '' });
  }, [c]);
  // Delivery status of a test message: only what the provider / receipts report.
  const track = useCallback(async (messageId: string) => {
    for (let k = 0; k < 20; k++) {
      await new Promise((r) => setTimeout(r, 4000));
      const m = await api.get<{ deliveryStatus: string | null; deliveryError: string | null }>(`/customers/${id}/messages/${messageId}`).catch(() => null);
      if (!m) return;
      setMsg({ tone: m.deliveryStatus === 'failed' ? 'error' : 'ok', text: `WhatsApp test: ${m.deliveryStatus ?? 'accepted'}${m.deliveryError ? ` — ${m.deliveryError}` : ''}${['delivered', 'read', 'failed'].includes(m.deliveryStatus ?? '') ? '' : ' (waiting for the delivery receipt…)'}` });
      if (['delivered', 'read', 'failed'].includes(m.deliveryStatus ?? '')) return;
    }
  }, [id]);
  useEffect(() => { if (tracked) void track(tracked); }, [tracked, track]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!c) return;
    const grants = (f.messagingConsent && !c.messagingConsent) || (f.callingConsent && !c.callingConsent);
    if (grants && !f.consentSource) { setErrors({ consentSource: 'Say how they gave consent.' }); return; }
    setBusy('save');
    try {
      // An opted-out customer is opted back in only together with freshly recorded consent (the API enforces this too).
      await api.patch(`/customers/${c.id}`, { ...toBody(f), ...(c.optedOutAt && grants ? { optedOut: false } : {}) });
      setEditing(false);
      setMsg({ tone: 'ok', text: 'Saved.' });
      await reload();
      onChanged();
    } catch (err) {
      setErrors(fieldErrors(err));
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }
  async function optOut(value: boolean) {
    if (!c) return;
    setBusy('optout');
    try {
      await api.patch(`/customers/${c.id}`, { optedOut: value, doNotContact: value ? c.doNotContact : false });
      await reload();
      onChanged();
    } catch (err) { setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) }); } finally { setBusy(null); }
  }
  async function contact(kind: 'whatsapp' | 'call') {
    if (!c) return;
    setConfirming(null);
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === 'whatsapp') {
        const r = await api.post<{ status: string; reason?: string; reasons?: string[]; messageId?: string; note?: string }>(`/customers/${c.id}/whatsapp-test`, { confirm: true });
        if (r.status === 'accepted') { setMsg({ tone: 'ok', text: `WhatsApp test accepted by Meta. ${r.note ?? ''}` }); if (r.messageId) setTracked(r.messageId); }
        else if (r.status === 'simulated') setMsg({ tone: 'warn', text: `Simulated, not sent: ${r.reason}. Nothing reached WhatsApp.` });
        else setMsg({ tone: 'error', text: `Not sent: ${(r.reasons ?? [r.reason]).join(' ')}` });
      } else {
        const r = await api.post<{ status: string; reason?: string; reasons?: string[]; callId?: string }>(`/customers/${c.id}/test-call`, { confirm: true });
        if (r.status === 'started') setMsg({ tone: 'ok', text: 'Test call started. Its live status is on the AI calls page.' });
        else setMsg({ tone: r.status === 'blocked' ? 'error' : 'warn', text: `No call placed: ${(r.reasons ?? [r.reason]).join(' ')}` });
      }
      await reload();
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const r = data?.contactReadiness;
  const history = data ? [
    ...data.audit.map((a) => ({ label: a.action.replace(/_/g, ' '), actor: a.actor, at: a.createdAt, note: null })),
    ...data.leads.map((l) => ({ label: `Enquiry · ${l.status.replace(/_/g, ' ')}`, actor: l.source, at: l.createdAt, note: null })),
    ...data.calls.map((x) => ({ label: `Call · ${x.status}${x.outcome ? ` · ${x.outcome.replace(/_/g, ' ')}` : ''}`, actor: x.direction, at: x.createdAt, note: x.durationSec ? `${x.durationSec}s` : null })),
    ...data.orders.map((o) => ({ label: `Order ${o.orderNumber} · ${o.status}`, actor: null, at: o.createdAt, note: `₹${o.total}` })),
    ...data.salesOrders.map((o) => ({ label: `Sales order ${o.number} · ${o.status.replace(/_/g, ' ')}`, actor: null, at: o.createdAt, note: `₹${o.total}` })),
    ...data.reservations.map((o) => ({ label: `Reservation ${o.reference} · ${o.status.replace(/_/g, ' ')}`, actor: null, at: o.checkIn, note: null })),
    ...data.appointments.map((o) => ({ label: `Appointment ${o.reference} · ${o.status.replace(/_/g, ' ')}`, actor: null, at: o.startAt, note: null })),
    ...data.followUps.map((o) => ({ label: `Follow-up (${o.channel}) · ${o.status}`, actor: null, at: o.scheduledAt, note: o.lastError })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40) : [];

  return (
    <Dialog open onClose={onClose} title={c?.name ?? 'Customer'} wide>
      {error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data || !c ? <Skeleton className="h-60" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="tabular-nums font-semibold text-ink">{c.phone ? `+${c.phone}` : 'No phone'}</span>
            <ConsentPills c={c} />
            {c.isDemo && <Pill tone="slate">demo record</Pill>}
            <span className="text-muted">Last message from them: {ago(c.lastInboundAt)}</span>
          </div>
          {msg && <p role="status" className={cx('rounded-[10px] px-3 py-2 text-[12.5px]', msg.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : msg.tone === 'warn' ? 'bg-amber-50 text-amber-900' : 'bg-rose-50 text-rose-800')}>{msg.text}</p>}

          {editing ? (
            <form onSubmit={save} noValidate>
              <CustomerForm f={f} set={(p) => setF((x) => ({ ...x, ...p }))} errors={errors} />
              <div className="mt-3 flex justify-end gap-2"><Button type="button" onClick={() => setEditing(false)}>Cancel</Button><Button type="submit" variant="primary" busy={busy === 'save'}>Save changes</Button></div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => { setErrors({}); setEditing(true); }}>Edit details & consent</Button>
              {c.optedOutAt ? <Button busy={busy === 'optout'} onClick={() => setEditing(true)}>Record new consent (opted out)</Button> : <Button busy={busy === 'optout'} onClick={() => { if (window.confirm('Mark this customer as opted out? Every WhatsApp follow-up and call to them stops.')) void optOut(true); }}>Mark opted out</Button>}
            </div>
          )}

          {r && (
            <Card className="p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">{r.live ? <ShieldAlert className="size-4 text-amber-600" /> : <ShieldCheck className="size-4 text-emerald-600" />} Contact test {r.live ? '— LIVE: a real message / call would go out' : `— not live (${r.liveReason})`}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Button disabled={busy !== null || r.whatsapp.blockers.length > 0} busy={busy === 'whatsapp'} onClick={() => setConfirming('whatsapp')}><MessageCircle className="size-4" /> Send WhatsApp test</Button>
                  <p className="mt-1 text-[11.5px] text-muted">{r.whatsapp.blockers.length ? r.whatsapp.blockers.join(' ') : r.whatsapp.needsTemplate ? `24-hour window closed: ${r.whatsapp.templateConfigured ? 'the approved template is used' : 'no approved template configured'}.` : 'Inside the 24-hour window: a short text is sent.'}</p>
                </div>
                <div>
                  <Button disabled={busy !== null || r.call.blockers.length > 0} busy={busy === 'call'} onClick={() => setConfirming('call')}><Phone className="size-4" /> Test call</Button>
                  <p className="mt-1 text-[11.5px] text-muted">{r.call.blockers.length ? r.call.blockers.join(' ') : 'Calling hours and the approved test-recipient list apply.'}</p>
                </div>
              </div>
            </Card>
          )}

          <Dialog open={confirming !== null} onClose={() => setConfirming(null)} title={confirming === 'call' ? 'Place a test call?' : 'Send a WhatsApp test?'}>
            <p className="text-[13px] text-body">
              {r?.live
                ? `This ${confirming === 'call' ? 'places a REAL call to' : 'sends a REAL WhatsApp message to'} +${c.phone}. Only continue if this number belongs to you or the customer expects it.`
                : `This workspace / number is not live (${r?.liveReason}). It will be recorded as simulated and nothing is ${confirming === 'call' ? 'dialled' : 'sent'}.`}
            </p>
            <div className="mt-4 flex justify-end gap-2"><Button onClick={() => setConfirming(null)}>Cancel</Button><Button variant={r?.live ? 'danger' : 'primary'} onClick={() => confirming && void contact(confirming)}>{r?.live ? 'Yes, send it' : 'Continue'}</Button></div>
          </Dialog>

          <div>
            <p className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">History</p>
            <Timeline items={history} />
          </div>
          {data.conversations[0] && (
            <div>
              <p className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Latest messages</p>
              <ul className="space-y-1.5">
                {data.conversations[0].Message.slice(0, 6).map((m) => (
                  <li key={m.id} className={cx('max-w-[90%] rounded-[10px] px-3 py-1.5 text-[12.5px]', m.role === 'user' ? 'bg-slate-100' : 'ml-auto bg-emerald-50')}>
                    {m.content}
                    <span className="block text-[10.5px] text-muted">{ago(m.createdAt)}{m.deliveryStatus ? ` · ${m.deliveryStatus}` : ''}{m.deliveryError ? ` · ${m.deliveryError}` : ''}</span>
                  </li>
                ))}
              </ul>
              <a className="mt-1 inline-block text-[12.5px] font-semibold text-brand" href={`/conversations?id=${data.conversations[0].id}`}>Open conversation</a>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ContactsPage />
    </Suspense>
  );
}
