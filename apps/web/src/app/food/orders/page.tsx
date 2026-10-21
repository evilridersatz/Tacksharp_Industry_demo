'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Bike, Minus, Plus, Store, Trash2 } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { newClientKey } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Button, Card, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Dialog, IndustryOnly, Label, Notice, errorText, inputCls } from '@/components/textile';
import { DataList, Pill, SearchBox, Section, SourceNote, Stat, Timeline, Toolbar, money, time, when } from '@/components/vertical-ui';

type Priced = { name: string; price: number };
type Order = {
  id: string; orderNumber: string; status: string; statusLabel: string; next: string[]; channel: string; fulfilment: 'pickup' | 'delivery'; deliveryAddress: string | null; deliveryZone: string | null;
  subtotal: number; taxAmount: number; fees: number; total: number; paymentMethod: string; paymentStatus: string; readyBy: string; createdAt: string;
  customer: { id: string; name: string | null; phone: string | null }; outlet: { id: string; name: string } | null;
  items: Array<{ id: string; name: string; variant: string | null; addOns: Priced[]; unitPrice: number; quantity: number; lineTotal: number }>;
  events: Array<{ type: string; from: string | null; to: string | null; actor: string; note: string | null; at: string }>;
  feedbackRating: number | null; feedbackComment: string | null; complaintStatus: string | null; notes: string | null; isDemo: boolean;
};
type MenuItem = { id: string; name: string; category: string; price: number; variants: Priced[]; addOns: Priced[]; soldOut: boolean };
type Menu = { categories: Array<{ name: string; items: MenuItem[] }>; config: { deliveryEnabled: boolean; pickupEnabled: boolean; deliveryZones: Array<{ name: string }> } };

const ACTION_LABEL: Record<string, string> = { confirmed: 'Accept order', preparing: 'Start preparing', ready: 'Mark ready', dispatched: 'Out for delivery', completed: 'Mark delivered / collected', cancelled: 'Cancel', needs_attention: 'Flag for attention' };
const STATUS_LABEL: Record<string, string> = { pending: 'Order received', confirmed: 'Accepted', preparing: 'Preparing', ready: 'Ready for pickup', dispatched: 'Out for delivery', completed: 'Delivered / collected', cancelled: 'Cancelled', needs_attention: 'Needs attention' };

export default function FoodOrdersPage() {
  return (
    <>
      <PageHeader title="Orders & kitchen" crumb="Orders" />
      <IndustryOnly allow={['food']}>
        <Suspense>
          <Orders />
        </Suspense>
      </IndustryOnly>
    </>
  );
}

function Orders() {
  const params = useSearchParams();
  const [filter, setFilter] = useState<'open' | 'all' | 'completed' | 'cancelled'>('open');
  const [q, setQ] = useState(params.get('q') ?? '');
  const path = `/food/orders?${new URLSearchParams({ ...(filter !== 'all' ? { status: filter } : {}), ...(q.trim() ? { q: q.trim() } : {}) })}`;
  const { data, error, reload } = useApi<Order[]>(path, 15_000);
  const { data: all } = useApi<Order[]>('/food/orders', 30_000);
  const [open, setOpen] = useState<Order | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const closeCreate = useCallback(() => setCreating(false), []);
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const stats = useMemo(() => {
    const rows = all ?? [];
    const t = rows.filter((o) => new Date(new Date(o.createdAt).getTime() + 330 * 60_000).toISOString().slice(0, 10) === today && o.status !== 'cancelled');
    return {
      pending: rows.filter((o) => o.status === 'pending').length,
      kitchen: rows.filter((o) => ['confirmed', 'preparing'].includes(o.status)).length,
      out: rows.filter((o) => o.status === 'dispatched').length,
      attention: rows.filter((o) => o.status === 'needs_attention').length,
      todayCount: t.length,
      todayValue: t.reduce((a, o) => a + o.total, 0),
    };
  }, [all, today]);

  return (
    <>
      <Notice notice={notice} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Waiting to be accepted" value={all ? stats.pending : '…'} tone={stats.pending ? 'amber' : undefined} />
        <Stat label="In the kitchen" value={all ? stats.kitchen : '…'} />
        <Stat label="Out for delivery" value={all ? stats.out : '…'} />
        <Stat label="Need attention" value={all ? stats.attention : '…'} tone={stats.attention ? 'red' : undefined} />
        <Stat label="Today's orders" value={all ? stats.todayCount : '…'} hint={all ? `${money(stats.todayValue)} order value` : undefined} />
      </div>
      <Toolbar>
        <Segmented label="Show orders" value={filter} onChange={setFilter} options={[{ value: 'open', label: 'Open' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
        <SearchBox value={q} onChange={setQ} placeholder="Order no., name or phone" />
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}><Plus className="size-4" /> Phone order</Button>
      </Toolbar>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error && <Skeleton className="h-72" />}
      {data && (
        <DataList
          rows={data}
          rowKey={(o) => o.id}
          onOpen={setOpen}
          empty="No orders match."
          columns={[
            { head: 'Order', cell: (o) => <div><p className="font-semibold text-ink">{o.orderNumber}</p><p className="text-[11.5px] text-muted">{when(o.createdAt)} · {o.channel}</p></div> },
            { head: 'Customer', cell: (o) => <div><p className="text-ink">{o.customer.name ?? '—'}</p><p className="text-[11.5px] text-muted">{o.customer.phone}</p></div> },
            { head: 'Items', cell: (o) => <span className="text-body">{o.items.map((i) => `${i.quantity}× ${i.name}${i.variant ? ` (${i.variant})` : ''}`).join(', ').slice(0, 60)}</span> },
            { head: 'Type', cell: (o) => <span className="inline-flex items-center gap-1 text-body">{o.fulfilment === 'delivery' ? <Bike className="size-3.5" /> : <Store className="size-3.5" />}{o.fulfilment}{o.deliveryZone ? ` · ${o.deliveryZone}` : ''}</span> },
            { head: 'Total', align: 'right', cell: (o) => <span className="font-semibold text-ink">{money(o.total)}</span> },
            { head: 'Status', cell: (o) => <Pill status={o.status}>{o.statusLabel}</Pill> },
          ]}
          card={(o) => (
            <div>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{o.orderNumber} · {money(o.total)}</p>
                  <p className="truncate text-[12px] text-muted">{o.customer.name ?? o.customer.phone} · {o.fulfilment} · {time(o.createdAt)}</p>
                </div>
                <Pill status={o.status}>{o.statusLabel}</Pill>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[12.5px] text-body">{o.items.map((i) => `${i.quantity}× ${i.name}${i.variant ? ` (${i.variant})` : ''}`).join(', ')}</p>
            </div>
          )}
        />
      )}
      <SourceNote api="GET /food/orders" />
      <Dialog open={!!open} onClose={close} title={open ? `Order ${open.orderNumber}` : 'Order'} wide>
        {open && (
          <OrderDetail
            id={open.id}
            onChanged={async (text) => {
              setNotice({ tone: 'ok', text });
              await reload();
            }}
          />
        )}
      </Dialog>
      <Dialog open={creating} onClose={closeCreate} title="New phone order" wide>
        {creating && (
          <NewOrder
            onDone={async (text) => {
              setCreating(false);
              setNotice({ tone: 'ok', text });
              await reload();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function OrderDetail({ id, onChanged }: { id: string; onChanged: (text: string) => void }) {
  const { data: o, reload } = useApi<Order>(`/food/orders/${id}`, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!o) return <Skeleton className="h-60" />;
  async function move(status: string) {
    setBusy(status);
    setErr(null);
    try {
      await api.post(`/food/orders/${id}/status`, { status });
      await reload();
      onChanged(`${o!.orderNumber}: ${STATUS_LABEL[status] ?? status}. The customer's update is queued (simulated in DRY_RUN).`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_260px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Pill status={o.status}>{o.statusLabel}</Pill>
          <span className="text-[12px] text-muted">{o.channel} · placed {when(o.createdAt)} · {o.fulfilment === 'delivery' ? 'deliver' : 'ready'} by {time(o.readyBy)}</span>
          {o.isDemo && <Pill tone="amber">demo</Pill>}
        </div>
        {err && <p role="alert" className="mb-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
        <Section title="Items">
          <ul className="divide-y divide-line rounded-[12px] border border-line">
            {o.items.map((i) => (
              <li key={i.id} className="flex items-start justify-between gap-3 px-3 py-2 text-[13px]">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{i.quantity} × {i.name}{i.variant ? ` (${i.variant})` : ''}</p>
                  {i.addOns.length > 0 && <p className="text-[12px] text-muted">+ {i.addOns.map((a) => `${a.name} ${money(a.price)}`).join(', ')}</p>}
                  <p className="text-[11.5px] text-faint">{money(i.unitPrice)} each</p>
                </div>
                <span className="font-semibold text-ink tabular">{money(i.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 text-[13px]">
            <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{money(o.subtotal)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd className="tabular">{money(o.taxAmount)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Packing & delivery</dt><dd className="tabular">{money(o.fees)}</dd></div>
            <div className="flex justify-between border-t border-line pt-1 text-[14px] font-bold text-ink"><dt>Total</dt><dd className="tabular">{money(o.total)}</dd></div>
          </dl>
        </Section>
        <Section title="Customer & fulfilment">
          <p className="text-[13px] text-ink">{o.customer.name ?? '—'} · {o.customer.phone}</p>
          <p className="text-[13px] text-body">{o.fulfilment === 'delivery' ? `Delivery to ${o.deliveryAddress} (${o.deliveryZone})` : `Pickup at ${o.outlet?.name}`}</p>
          <p className="text-[12.5px] text-muted">Payment: {o.paymentMethod.replace(/_/g, ' ')} · {o.paymentStatus}</p>
          {o.notes && <p className="mt-1 rounded-[10px] bg-amber-50 px-3 py-1.5 text-[12.5px] text-amber-900">{o.notes}</p>}
        </Section>
        {(o.feedbackRating !== null || o.complaintStatus) && (
          <Section title="Feedback">
            <p className="text-[13px] text-ink">{o.feedbackRating !== null ? `${'★'.repeat(o.feedbackRating)}${'☆'.repeat(5 - o.feedbackRating)} (${o.feedbackRating}/5)` : ''} {o.complaintStatus && <Pill status={o.complaintStatus}>complaint {o.complaintStatus}</Pill>}</p>
            {o.feedbackComment && <p className="text-[12.5px] text-body">“{o.feedbackComment}”</p>}
          </Section>
        )}
      </div>
      <div>
        <Section title="Next step">
          {o.next.length ? (
            <div className="flex flex-col gap-2">
              {o.next.map((s) => (
                <Button key={s} variant={s === 'cancelled' || s === 'needs_attention' ? 'danger' : 'primary'} busy={busy === s} disabled={busy !== null} onClick={() => move(s)} className="justify-start">
                  {ACTION_LABEL[s] ?? s}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-muted">This order is closed.</p>
          )}
        </Section>
        <Section title="History">
          <Timeline items={o.events.map((e) => ({ label: e.type === 'created' ? 'Order received' : `${STATUS_LABEL[e.from ?? ''] ?? e.from} → ${STATUS_LABEL[e.to ?? ''] ?? e.to}`, actor: e.actor, at: e.at, note: e.note }))} />
        </Section>
      </div>
    </div>
  );
}

type Line = { key: string; itemId: string; quantity: number; variant: string; addOns: string[] };

function NewOrder({ onDone }: { onDone: (text: string) => void }) {
  const { data: menu } = useApi<Menu>('/food/menu', 0);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [fulfilment, setFulfilment] = useState<'pickup' | 'delivery'>('pickup');
  const [address, setAddress] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [quote, setQuote] = useState<{ ok: boolean; problems: string[]; subtotal: number; tax: number; packagingFee: number; deliveryFee: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => newClientKey());
  const items = useMemo(() => menu?.categories.flatMap((c) => c.items) ?? [], [menu]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  useEffect(() => {
    if (!lines.length) {
      setQuote(null);
      return;
    }
    const t = setTimeout(() => {
      api.post<typeof quote>('/food/quote', { lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, variant: l.variant || undefined, addOns: l.addOns })), fulfilment, address: fulfilment === 'delivery' ? address : undefined }).then(setQuote).catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [lines, fulfilment, address]);

  function add(itemId: string) {
    const it = byId.get(itemId);
    if (!it) return;
    setLines((x) => [...x, { key: Math.random().toString(36).slice(2), itemId, quantity: 1, variant: it.variants[0]?.name ?? '', addOns: [] }]);
  }
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ status: string; order: { orderNumber: string; total: number } }>('/food/orders', { phone, name, fulfilment, address, clientKey: key, lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, variant: l.variant || undefined, addOns: l.addOns })) });
      onDone(`${r.order.orderNumber} ${r.status === 'duplicate' ? 'already existed' : 'created'}: ${money(r.order.total)}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!menu) return <Skeleton className="h-60" />;
  return (
    <div className="space-y-4">
      {err && <p role="alert" className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Label text="Customer phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="98400 12345" className={inputCls} /></Label>
        <Label text="Customer name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Fulfilment" value={fulfilment} onChange={setFulfilment} options={[{ value: 'pickup', label: 'Pickup' }, ...(menu.config.deliveryEnabled ? [{ value: 'delivery' as const, label: 'Delivery' }] : [])]} />
        {fulfilment === 'delivery' && <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={`Address with area (${menu.config.deliveryZones.map((z) => z.name).join(', ')})`} aria-label="Delivery address" className={cx(inputCls, 'h-10 min-w-0 flex-1')} />}
      </div>
      <Label text="Add item">
        <select value="" onChange={(e) => add(e.target.value)} className={inputCls}>
          <option value="">Choose from the menu…</option>
          {menu.categories.map((c) => (
            <optgroup key={c.name} label={c.name}>
              {c.items.map((i) => <option key={i.id} value={i.id} disabled={i.soldOut}>{i.name} — {i.variants.length ? i.variants.map((v) => `${v.name} ${money(v.price)}`).join(' / ') : money(i.price)}{i.soldOut ? ' (sold out)' : ''}</option>)}
            </optgroup>
          ))}
        </select>
      </Label>
      {lines.length > 0 && (
        <ul className="divide-y divide-line rounded-[12px] border border-line">
          {lines.map((l) => {
            const it = byId.get(l.itemId)!;
            const set = (patch: Partial<Line>) => setLines((x) => x.map((y) => (y.key === l.key ? { ...y, ...patch } : y)));
            return (
              <li key={l.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
                <span className="min-w-[120px] flex-1 font-semibold text-ink">{it.name}</span>
                {it.variants.length > 0 && (
                  <select aria-label={`${it.name} size`} value={l.variant} onChange={(e) => set({ variant: e.target.value })} className={cx(inputCls, 'w-auto')}>
                    {it.variants.map((v) => <option key={v.name} value={v.name}>{v.name} {money(v.price)}</option>)}
                  </select>
                )}
                {it.addOns.map((a) => (
                  <label key={a.name} className="inline-flex items-center gap-1 text-[12px] text-body">
                    <input type="checkbox" checked={l.addOns.includes(a.name)} onChange={(e) => set({ addOns: e.target.checked ? [...l.addOns, a.name] : l.addOns.filter((x) => x !== a.name) })} /> {a.name} +{money(a.price)}
                  </label>
                ))}
                <span className="inline-flex items-center rounded-[10px] border border-line">
                  <button type="button" aria-label="Less" className="grid size-9 place-items-center" onClick={() => set({ quantity: Math.max(1, l.quantity - 1) })}><Minus className="size-3.5" /></button>
                  <span className="w-6 text-center tabular">{l.quantity}</span>
                  <button type="button" aria-label="More" className="grid size-9 place-items-center" onClick={() => set({ quantity: Math.min(20, l.quantity + 1) })}><Plus className="size-3.5" /></button>
                </span>
                <button type="button" aria-label={`Remove ${it.name}`} className="grid size-9 place-items-center text-faint hover:text-rose" onClick={() => setLines((x) => x.filter((y) => y.key !== l.key))}><Trash2 className="size-4" /></button>
              </li>
            );
          })}
        </ul>
      )}
      {quote && (
        <Card className="p-3 text-[13px]">
          <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="tabular">{money(quote.subtotal)}</span></div>
          <div className="flex justify-between"><span className="text-muted">Tax</span><span className="tabular">{money(quote.tax)}</span></div>
          <div className="flex justify-between"><span className="text-muted">Packing + delivery</span><span className="tabular">{money(quote.packagingFee + quote.deliveryFee)}</span></div>
          <div className="mt-1 flex justify-between border-t border-line pt-1 font-bold text-ink"><span>Total (server price)</span><span className="tabular">{money(quote.total)}</span></div>
          {quote.problems.length > 0 && <p className="mt-2 text-[12.5px] text-rose">{quote.problems.join(' ')}</p>}
        </Card>
      )}
      <div className="flex justify-end">
        <Button variant="primary" busy={busy} disabled={!quote?.ok || !phone.trim()} onClick={submit}>Create order</Button>
      </div>
    </div>
  );
}
