'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Search, ShieldCheck, ShieldOff, Users, X } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { dateTime, displayName, formatPhone, timeAgo } from '@/lib/format';
import { CHANNEL_LABEL, ORDER_STATUS, inr, plain, useMe, type Order, type RCustomer } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Button, Card, Empty, ErrorBanner, Field, Skeleton, cx } from '@/components/ui';

type CustomerDetail = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  doNotContact: boolean;
  messagingConsent: boolean;
  callingConsent: boolean;
  optedOutAt: string | null;
  isDemo: boolean;
  createdAt: string;
  lastInboundAt: string | null;
  orders: Order[];
  conversations: Array<{ id: string; channel: string; status: string; updatedAt: string; messageCount: number; lastMessage: string | null }>;
};

export default function CustomersPage() {
  return (
    <Suspense>
      <Customers />
    </Suspense>
  );
}

function Customers() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data: customers, error, reload } = useApi<RCustomer[]>(`/restaurant/customers${debounced.trim() ? `?q=${encodeURIComponent(debounced.trim())}` : ''}`, 20_000);
  const selected = params.get('id');
  const select = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('id', id);
    else next.delete('id');
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  return (
    <>
      <PageHeader title="Customers" />
      {error && !customers && <ErrorBanner message={error} onRetry={reload} />}
      <div className="mb-3 flex justify-end">
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or phone"
            aria-label="Search customers"
            className="h-9 w-full rounded-[10px] border border-line bg-white pr-3 pl-9 text-[13px] text-ink placeholder:text-faint sm:w-[260px]"
          />
        </div>
      </div>
      <div className={cx('grid grid-cols-1 gap-4', selected && 'xl:grid-cols-[minmax(0,1fr)_440px]')}>
        <Card className={cx('overflow-x-auto', selected && 'hidden xl:block')}>
          {!customers ? (
            <Skeleton className="m-4 h-64" />
          ) : !customers.length ? (
            <Empty icon={<Users className="size-6" />} title="No customers yet">
              Customers are added when they share their number in the chat or message on WhatsApp.
            </Empty>
          ) : (
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="border-b border-line bg-slate-50/60 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase">
                  <th className="px-5 py-2">Customer</th>
                  <th className="px-3 py-2 text-right">Orders</th>
                  <th className="px-3 py-2 text-right">Spend</th>
                  <th className="px-3 py-2">Last order</th>
                  <th className="px-5 py-2">Consent</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} onClick={() => select(c.id)} className={cx('cursor-pointer border-b border-line last:border-0 hover:bg-slate-50/60', selected === c.id && 'bg-brand-soft/40')}>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar person={c} size={30} />
                        <div>
                          <p className="flex items-center gap-1.5 font-semibold text-ink">{displayName(c)}{c.isDemo && <Badge tone="amber">Demo</Badge>}</p>
                          <p className="text-[11.5px] text-faint">{formatPhone(c.phone)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="tabular px-3 py-2.5 text-right font-semibold text-ink">{c.orders}</td>
                    <td className="tabular px-3 py-2.5 text-right">{inr(c.totalSpend)}</td>
                    <td className="px-3 py-2.5 text-muted">{c.lastOrderAt ? `${timeAgo(c.lastOrderAt)} ago` : '—'}</td>
                    <td className="px-5 py-2.5">
                      {c.optedOutAt || c.doNotContact ? (
                        <Badge tone="rose">{c.optedOutAt ? 'Replied STOP' : 'Do not contact'}</Badge>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={c.messagingConsent ? 'brand' : 'slate'}>{c.messagingConsent ? 'WhatsApp ✓' : 'No WhatsApp consent'}</Badge>
                          <Badge tone={c.callingConsent ? 'brand' : 'slate'}>{c.callingConsent ? 'Calls ✓' : 'No call consent'}</Badge>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {selected && <CustomerPanel id={selected} onClose={() => select(null)} onChanged={reload} />}
      </div>
    </>
  );
}

function CustomerPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const me = useMe();
  const { data: c, error, reload } = useApi<CustomerDetail>(`/restaurant/customers/${id}`, 0);
  const [busy, setBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  if (error && !c) return <ErrorBanner message={error} onRetry={reload} />;
  if (!c) return <Skeleton className="h-[420px] rounded-[14px]" />;
  const spend = c.orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);

  async function patch(body: Record<string, boolean>) {
    setBusy(true);
    setConsentError(null);
    try {
      await api.patch(`/restaurant/customers/${id}`, body);
      await reload();
      onChanged();
    } catch (e) {
      setConsentError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="self-start xl:sticky xl:top-5">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <Avatar person={c} size={44} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[16px] font-bold text-ink">
            {displayName(c)} {c.isDemo && <Badge tone="amber">Demo · synthetic number</Badge>}
          </p>
          <p className="text-[12.5px] text-muted">{formatPhone(c.phone)}</p>
        </div>
        <button onClick={onClose} aria-label="Close customer" className="text-muted hover:text-ink">
          <X className="size-5" />
        </button>
      </div>
      <div className="px-5 py-3 text-[13px]">
        <Field label="Customer since">{dateTime(c.createdAt)}</Field>
        <Field label="First channel">{CHANNEL_LABEL[c.source ?? ''] ?? c.source ?? '—'}</Field>
        <Field label="Orders">{c.orders.length}</Field>
        <Field label="Spend (excl. cancelled)">{inr(spend)}</Field>
        {c.optedOutAt && <p className="my-2 rounded-[8px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">Replied STOP on {dateTime(c.optedOutAt)}. No messages or calls until the customer replies START.</p>}
        <div className="mt-2 flex flex-col gap-2">
          {([
            ['messagingConsent', 'WhatsApp messages (confirmation, updates, feedback)'],
            ['callingConsent', 'Follow-up calls'],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between gap-3 rounded-[10px] border border-line px-3 py-2">
              <span className="text-body">{label}</span>
              <input
                type="checkbox"
                checked={c[key]}
                disabled={busy || !me || me.role === 'viewer' || (Boolean(c.optedOutAt) && !c[key])}
                onChange={(e) => patch({ [key]: e.target.checked })}
                className="size-4 accent-[var(--color-brand)]"
                aria-label={label}
              />
            </label>
          ))}
          {me && me.role !== 'viewer' && (
            <Button className="w-full" busy={busy} onClick={() => patch({ doNotContact: !c.doNotContact })}>
              {c.doNotContact ? <ShieldCheck className="size-4" /> : <ShieldOff className="size-4" />}
              {c.doNotContact ? 'Remove do-not-contact' : 'Mark do-not-contact'}
            </Button>
          )}
          {consentError && <p className="text-[12px] text-rose">{consentError}</p>}
        </div>
      </div>
      <div className="border-t border-line px-5 py-3">
        <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Orders</h3>
        {!c.orders.length ? (
          <p className="text-[13px] text-muted">No orders.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {c.orders.map((o) => (
              <li key={o.id}>
                <Link href={`/orders?id=${o.id}`} className="flex items-center justify-between gap-2 rounded-[10px] border border-line p-2.5 text-[13px] hover:bg-slate-50">
                  <span>
                    <b className="text-ink">{o.orderNumber}</b>
                    <span className="block text-[12px] text-muted">{dateTime(o.createdAt)}</span>
                  </span>
                  <span className="text-right">
                    <span className="tabular block font-semibold text-ink">{inr(o.total)}</span>
                    <Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line px-5 py-3">
        <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Conversations</h3>
        <ul className="flex flex-col gap-2">
          {c.conversations.map((cv) => (
            <li key={cv.id}>
              <Link href={`/conversations?id=${cv.id}`} className="block rounded-[10px] border border-line p-2.5 text-[13px] hover:bg-slate-50">
                <span className="flex items-center justify-between">
                  <b className="text-ink">{CHANNEL_LABEL[cv.channel] ?? cv.channel}</b>
                  <span className="text-[11.5px] text-faint">{dateTime(cv.updatedAt)}</span>
                </span>
                <span className="block truncate text-[12px] text-muted">{cv.lastMessage ? plain(cv.lastMessage) : '—'}</span>
              </Link>
            </li>
          ))}
          {!c.conversations.length && <p className="text-[13px] text-muted">No conversations.</p>}
        </ul>
      </div>
    </Card>
  );
}
