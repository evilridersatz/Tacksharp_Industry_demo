'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Check, Copy, Gift, Globe, KeyRound, MessageCircle, Send, UserPlus } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { dateTime, displayName, formatPhone } from '@/lib/format';
import { CLAIM_STATUS, SOURCE_LABEL, inr, useMe, type OffersData } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Field, Segmented, Skeleton, cx } from '@/components/ui';

type Filter = 'all' | 'claimed' | 'started' | 'sent' | 'pending_send';

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      className="h-8"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is visible to copy by hand */
        }
      }}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />} {done ? 'Copied' : 'Copy'}
    </Button>
  );
}

export default function OffersPage() {
  const me = useMe();
  const [filter, setFilter] = useState<Filter>('all');
  const { data: d, error, reload } = useApi<OffersData>(`/restaurant/offers${filter === 'all' ? '' : `?status=${filter}`}`, 10_000);
  const canEdit = !!me && me.role !== 'viewer';
  const isAdmin = me?.role === 'admin';

  return (
    <>
      <PageHeader title="₹50 website offer" crumb="Offer" />
      {error && !d && <ErrorBanner message={error} onRetry={reload} />}
      {!d ? (
        <Skeleton className="h-[520px] rounded-[14px]" />
      ) : (
        <>
          <Card className="mb-4 p-5">
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-3">
                <span className="grid size-11 place-items-center rounded-full bg-violet-soft text-violet">
                  <Gift className="size-5" />
                </span>
                <div>
                  <p className="text-[16px] font-bold text-ink">{d.campaign ? `${inr(d.campaign.amount)} off · code ${d.campaign.code}` : 'No offer set up'}</p>
                  <p className="text-[12.5px] text-muted">
                    Customers who ordered on the website claim it on WhatsApp; the assistant collects their chicken order and applies the discount once.
                  </p>
                </div>
              </div>
              <div className="ml-auto flex gap-6 text-center">
                {[
                  ['Created', d.stats.total],
                  ['Sent', d.stats.sent],
                  ['Chatting', d.stats.started],
                  ['Claimed', d.stats.claimed],
                ].map(([label, v]) => (
                  <div key={label}>
                    <p className="tabular text-[22px] font-bold text-ink">{v}</p>
                    <p className="text-[11.5px] text-muted">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader title="1 · WhatsApp link" subtitle="Put it on the website order page, the bill or an SMS. The customer taps it and says hi." />
              <div className="px-5 pb-5 text-[13px]">
                {d.whatsappLink ? (
                  <>
                    <p className="break-all rounded-[8px] bg-slate-50 px-3 py-2 font-mono text-[11.5px] text-ink">{d.whatsappLink}</p>
                    <div className="mt-2 flex gap-2">
                      <CopyButton text={d.whatsappLink} />
                      <Button href={d.whatsappLink} className="h-8">
                        <MessageCircle className="size-4" /> Open
                      </Button>
                    </div>
                    <p className="mt-2 text-[12px] text-muted">One link offer per customer number, so it cannot be claimed twice. Link claims are marked “not linked to a website order”.</p>
                  </>
                ) : (
                  <p className="text-muted">{d.whatsappLinkNote}</p>
                )}
              </div>
            </Card>

            <WebsiteApi endpoint={d.website.endpoint} configured={d.website.keyConfigured} isAdmin={isAdmin} />

            {canEdit ? <AddCustomers onDone={reload} /> : <Card />}
          </div>

          {d.campaign && isAdmin && <CampaignSettings campaign={d.campaign} onSaved={reload} />}

          <Card className="mt-4">
            <CardHeader
              title="Offers"
              action={
                <Segmented<Filter>
                  label="Offer filter"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'claimed', label: 'Claimed' },
                    { value: 'started', label: 'Chatting' },
                    { value: 'sent', label: 'Sent' },
                    { value: 'pending_send', label: 'Not sent' },
                  ]}
                />
              }
            />
            {!d.claims.length ? (
              <Empty icon={<Gift className="size-6" />} title="No offers here yet" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-[13px]">
                  <thead>
                    <tr className="border-y border-line bg-slate-50/60 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase">
                      <th className="px-5 py-2">Customer</th>
                      <th className="px-3 py-2">From</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Order</th>
                      <th className="px-3 py-2">Created</th>
                      <th className="px-5 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {d.claims.map((c) => {
                      const st = CLAIM_STATUS[c.status] ?? { label: c.status, tone: 'slate' as const };
                      return (
                        <tr key={c.id} className="border-b border-line last:border-0">
                          <td className="px-5 py-2.5">
                            <Link href={`/customers?id=${c.customer.id}`} className="font-semibold text-ink hover:text-brand">
                              {displayName(c.customer)}
                            </Link>
                            <p className="text-[11.5px] text-faint">{formatPhone(c.customer.phone)}</p>
                          </td>
                          <td className="px-3 py-2.5 text-body">
                            {SOURCE_LABEL[c.source] ?? c.source}
                            {c.websiteOrderRef && <p className="text-[11.5px] text-faint">Web order {c.websiteOrderRef}</p>}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge tone={st.tone}>{st.label}</Badge>
                            {c.sendError && <p className="mt-1 max-w-[260px] text-[11.5px] text-[#b45309]">{c.sendError}</p>}
                          </td>
                          <td className="px-3 py-2.5">
                            {c.order ? (
                              <Link href={`/orders?id=${c.order.id}`} className="font-semibold text-brand">
                                {c.order.orderNumber} · {inr(c.order.total)}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-muted">{dateTime(c.createdAt)}</td>
                          <td className="px-5 py-2.5 text-right">
                            {canEdit && ['pending_send', 'send_failed'].includes(c.status) && <ResendButton id={c.id} onDone={reload} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function ResendButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className="h-8"
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.post(`/restaurant/offers/${id}/resend`);
          onDone();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Send className="size-3.5" /> Retry
    </Button>
  );
}

function WebsiteApi({ endpoint, configured, isAdmin }: { endpoint: string; configured: boolean; isAdmin: boolean }) {
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const example = `curl -X POST ${endpoint} \\\n  -H "x-api-key: ${key ?? '<website key>'}" \\\n  -H "content-type: application/json" \\\n  -d '{"phone":"9876543210","name":"Priya","websiteOrderId":"WEB-1042"}'`;
  return (
    <Card>
      <CardHeader title="2 · From the website" subtitle="After each website order, the site sends us the customer; the assistant sends the Tamil offer message." action={<Badge tone={configured ? 'brand' : 'slate'}>{configured ? 'Key set' : 'No key'}</Badge>} />
      <div className="px-5 pb-5 text-[13px]">
        <pre className="overflow-x-auto rounded-[8px] bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">{example}</pre>
        {key && (
          <p className="mt-2 rounded-[8px] bg-amber-soft px-3 py-2 text-[12px] text-[#92400e]">
            <b>Copy this key now — it will not be shown again:</b>
            <br />
            <span className="break-all font-mono">{key}</span>
          </p>
        )}
        {isAdmin && (
          <Button
            className="mt-2 h-8"
            busy={busy}
            onClick={async () => {
              if (configured && !window.confirm('Create a new key? The website must switch to it; the old key stops working.')) return;
              setBusy(true);
              try {
                setKey((await api.post<{ key: string }>('/restaurant/offers/website-key')).key);
              } finally {
                setBusy(false);
              }
            }}
          >
            <KeyRound className="size-4" /> {configured ? 'New key' : 'Create key'}
          </Button>
        )}
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
          <Globe className="size-3.5" /> Same websiteOrderId twice = same offer (safe to retry).
        </p>
      </div>
    </Card>
  );
}

function AddCustomers({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ input: string; ok: boolean; status?: string; error?: string; duplicate?: boolean; note?: string | null }> | null>(null);
  return (
    <Card>
      <CardHeader title="3 · Add customers" subtitle="Website customers' numbers, one per line (name optional)." />
      <form
        className="px-5 pb-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            setResults((await api.post<{ results: NonNullable<typeof results> }>('/restaurant/offers/send', { entries: text })).results);
            setText('');
            onDone();
          } catch (err) {
            setResults([{ input: '', ok: false, error: err instanceof Error ? err.message : String(err) }]);
          } finally {
            setBusy(false);
          }
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={'9876543210, Priya\n9123456780'}
          aria-label="Phone numbers"
          className="w-full rounded-[10px] border border-line p-3 font-mono text-[12.5px] text-ink placeholder:text-faint"
        />
        <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()} className="mt-2">
          <UserPlus className="size-4" /> Send offer
        </Button>
        {results && (
          <ul className="mt-3 flex flex-col gap-1 text-[12px]">
            {results.map((r, i) => (
              <li key={i} className={cx(r.ok ? 'text-body' : 'text-rose')}>
                {r.input && <b>{r.input}: </b>}
                {r.ok ? (r.duplicate ? 'already has an open offer' : CLAIM_STATUS[r.status ?? '']?.label ?? r.status) : r.error}
                {r.note && <span className="text-[#b45309]"> — {r.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </form>
    </Card>
  );
}

function CampaignSettings({ campaign, onSaved }: { campaign: NonNullable<OffersData['campaign']>; onSaved: () => void }) {
  const [form, setForm] = useState({ amount: String(campaign.amount), minOrderValue: String(campaign.minOrderValue), validDays: String(campaign.validDays), templateName: campaign.templateName ?? '', active: campaign.active });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const input = 'h-9 w-full rounded-[10px] border border-line bg-white px-3 text-[13px] text-ink';
  return (
    <Card className="mt-4">
      <CardHeader title="Offer settings" subtitle="Changes apply to new offers; offers already given keep their amount." />
      <form
        className="grid grid-cols-1 gap-3 px-5 pb-5 md:grid-cols-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMsg(null);
          try {
            await api.patch(`/restaurant/offers/campaign/${campaign.id}`, { ...form, amount: Number(form.amount), minOrderValue: Number(form.minOrderValue), validDays: Number(form.validDays) });
            setMsg('Saved');
            onSaved();
          } catch (err) {
            setMsg(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="text-[12px] text-muted">
          Discount (₹)
          <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={input} />
        </label>
        <label className="text-[12px] text-muted">
          Minimum order (₹)
          <input inputMode="decimal" value={form.minOrderValue} onChange={(e) => setForm({ ...form, minOrderValue: e.target.value })} className={input} />
        </label>
        <label className="text-[12px] text-muted">
          Valid for (days)
          <input inputMode="numeric" value={form.validDays} onChange={(e) => setForm({ ...form, validDays: e.target.value })} className={input} />
        </label>
        <label className="text-[12px] text-muted">
          Approved WhatsApp template
          <input value={form.templateName} onChange={(e) => setForm({ ...form, templateName: e.target.value })} placeholder="e.g. gr_offer_ta_v1" className={input} />
        </label>
        <div className="flex items-end gap-3">
          <label className="inline-flex h-9 items-center gap-2 text-[13px] text-body">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="size-4" /> Active
          </label>
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
        </div>
        {msg && <p className="text-[12.5px] text-muted md:col-span-5">{msg}</p>}
        <div className="text-[12px] text-muted md:col-span-5">
          <Field label="Why a template?">WhatsApp only allows a business to start a chat with an approved template. Without one, the offer reaches customers who messaged in the last 24h or who use the link.</Field>
        </div>
      </form>
    </Card>
  );
}
