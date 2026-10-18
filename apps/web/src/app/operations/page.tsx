'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useIndustry } from '@/lib/industry';
import { AlertTriangle, Boxes, PackageCheck, PackagePlus, Pencil, Truck } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { FulfilmentRow, OperationsOverview, StockMovement, StockRow, WorkTask } from '@/lib/types';
import { ORDER_STATUS, PAYMENT_STATUS, dateTime, newClientKey, timeAgo } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, IconTile, Segmented, Skeleton, cx, type Tone } from '@/components/ui';
import { Dialog, Label, Notice, TextileOnly, errorText, inputCls } from '@/components/textile';
import { WorkTaskList } from '@/components/agents';

type Tab = 'inventory' | 'fulfilment' | 'tasks' | 'movements';
type Action = { kind: 'track' | 'receive' | 'adjust'; row: StockRow } | null;

export default function OperationsPage() {
  const { industry } = useIndustry();
  return (
    <>
      <PageHeader title={industry === 'manufacturing' ? 'Corrective actions' : 'Inventory & operations'} crumb="Operations" />
      <TextileOnly allow={['textile', 'retail', 'manufacturing']}>
        <Suspense>
          <Operations />
        </Suspense>
      </TextileOnly>
    </>
  );
}

function Kpi({ icon, tone, label, value, sub }: { icon: React.ReactNode; tone: Tone; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Card className="flex items-start gap-3 p-4">
      <IconTile tone={tone}>{icon}</IconTile>
      <div>
        <p className="text-[12.5px] text-muted">{label}</p>
        <p className="text-[22px] leading-tight font-bold text-ink tabular">{value}</p>
        {sub && <p className="text-[12px] text-muted">{sub}</p>}
      </div>
    </Card>
  );
}

function Operations() {
  const params = useSearchParams();
  const { industry } = useIndustry();
  // Manufacturing has no stock or fulfilment here: only corrective-action tasks apply.
  const mfg = industry === 'manufacturing';
  const qTab = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(qTab ?? 'inventory');
  useEffect(() => {
    if (qTab) setTab(qTab);
  }, [qTab]);
  useEffect(() => {
    if (mfg) setTab('tasks');
  }, [mfg]);
  const { data: ov, reload: reloadOv } = useApi<OperationsOverview>(mfg ? null : '/operations/overview', 15_000);
  const { data: stock, error, reload: reloadStock } = useApi<StockRow[]>(mfg ? null : '/operations/inventory', 15_000);
  const { data: orders, reload: reloadOrders } = useApi<FulfilmentRow[]>(tab === 'fulfilment' ? '/operations/fulfilment' : null, 15_000);
  const { data: tasks, reload: reloadTasks } = useApi<WorkTask[]>(tab === 'tasks' ? '/operations/tasks' : null, 15_000);
  const { data: moves } = useApi<StockMovement[]>(tab === 'movements' ? '/operations/movements' : null, 15_000);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [reserving, setReserving] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState<FulfilmentRow | null>(null);
  const [deciding, setDeciding] = useState<FulfilmentRow | null>(null);
  const focus = params.get('product');
  const closeAction = useCallback(() => setAction(null), []);
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadOv(), reloadStock(), reloadOrders(), reloadTasks()]);
  }, [reloadOv, reloadStock, reloadOrders, reloadTasks]);

  async function reserve(o: FulfilmentRow) {
    setReserving(o.id);
    try {
      const r = await api.post<{ task: { status: string; result: { outcome?: string } | null; error: string | null } }>(`/operations/orders/${o.id}/reserve`, { clientKey: newClientKey() });
      const outcome = r.task.result?.outcome;
      setNotice({
        tone: outcome === 'reserved' ? 'ok' : 'error',
        text: outcome === 'reserved' ? `${o.number}: stock reserved.` : outcome === 'shortage' ? `${o.number}: still short - see Team tasks.` : outcome === 'not_tracked' ? `${o.number}: no stock-tracked items.` : r.task.error ?? `${o.number}: ${r.task.status}`,
      });
      await reloadAll();
    } catch (e) {
      setNotice({ tone: 'error', text: errorText(e) });
    } finally {
      setReserving(null);
    }
  }

  return (
    <>
      <Notice notice={notice} />
      {error && !stock && <ErrorBanner message={error} onRetry={reloadStock} />}
      {mfg ? (
        <p className="mb-3 text-[12.5px] text-muted">Corrective actions raised by the quality alert scan and by your team. Record the fix on the inspection in <Link className="font-semibold text-ink underline" href="/quality">Inspections & defects</Link>.</p>
      ) : (
      <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {!ov && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
        {ov && (
          <>
            <Kpi icon={<Boxes className="size-4" />} tone="sky" label="Stock-tracked products" value={ov.products.tracked} sub={`${ov.products.untracked} not tracked`} />
            <Kpi icon={<AlertTriangle className="size-4" />} tone={ov.products.low || ov.products.outOfStock ? 'rose' : 'brand'} label="Low / out of stock" value={`${ov.products.low} / ${ov.products.outOfStock}`} />
            <Kpi icon={<PackageCheck className="size-4" />} tone="violet" label="Orders awaiting fulfilment" value={ov.orders.awaitingFulfilment} sub={`${ov.orders.delayed} past expected delivery`} />
            <Kpi icon={<Truck className="size-4" />} tone="amber" label="Open operations tasks" value={Object.values(ov.openTasks).reduce((a, b) => a + b, 0)} sub={Object.entries(ov.openTasks).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none'} />
          </>
        )}
      </div>
      <p className="mt-3 text-[12.5px] text-muted">{ov?.note ?? ''} The Operations agent reserves stock when an order is confirmed, releases it on cancellation and deducts it on dispatch.</p>

      <div className="mt-4 mb-3">
        <Segmented
          label="Operations section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'inventory', label: 'Inventory' },
            { value: 'fulfilment', label: 'Fulfilment' },
            { value: 'tasks', label: 'Team tasks' },
            { value: 'movements', label: 'Stock movements' },
          ]}
        />
      </div>
      </>
      )}

      {tab === 'inventory' && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="border-b border-line text-left text-[12px] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">Product</th>
                <th className="px-3 py-3 text-right font-medium">On hand</th>
                <th className="px-3 py-3 text-right font-medium">Reserved</th>
                <th className="px-3 py-3 text-right font-medium">Available</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!stock && <tr><td colSpan={6} className="p-5"><Skeleton className="h-20" /></td></tr>}
              {stock?.map((r) => (
                <tr key={r.productId} className={cx('border-t border-line', focus === r.productId && 'bg-brand-soft/40')}>
                  <td className="px-5 py-2.5">
                    <p className="font-semibold text-ink">{r.name}</p>
                    <p className="text-[12px] text-muted">{r.sku} · per {r.unit}</p>
                  </td>
                  {r.tracked ? (
                    <>
                      <td className="px-3 text-right tabular">{r.onHand}</td>
                      <td className="px-3 text-right tabular">{r.reserved}</td>
                      <td className="px-3 text-right font-semibold text-ink tabular">{r.available}</td>
                      <td className="px-3">
                        {r.available <= 0 ? <Badge tone="rose">Out of stock</Badge> : r.low ? <Badge tone="amber">Low (≤ {r.lowStockAt})</Badge> : <Badge tone="brand">OK</Badge>}
                      </td>
                    </>
                  ) : (
                    <td colSpan={4} className="px-3 text-muted">Not tracked - availability is not confirmed by Operations</td>
                  )}
                  <td className="px-5 text-right whitespace-nowrap">
                    {r.tracked ? (
                      <>
                        <Button className="mr-2 h-8" onClick={() => setAction({ kind: 'receive', row: r })}><PackagePlus className="size-4" /> Receive</Button>
                        <Button className="h-8" onClick={() => setAction({ kind: 'adjust', row: r })}><Pencil className="size-4" /> Correct</Button>
                      </>
                    ) : (
                      <Button className="h-8" onClick={() => setAction({ kind: 'track', row: r })}>Start tracking</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {stock && stock.length === 0 && <Empty icon={<Boxes className="size-6" />} title="No catalogue products">Add products in the Catalogue first.</Empty>}
        </Card>
      )}

      {tab === 'fulfilment' && (
        <div className="flex flex-col gap-3">
          {!orders && <Skeleton className="h-40" />}
          {orders?.length === 0 && <Card><Empty title="No open orders">Confirmed orders waiting for dispatch appear here.</Empty></Card>}
          {orders?.map((o) => {
            const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'slate' as const };
            const tracked = o.stock.lines.filter((l) => l.tracked);
            return (
              <Card key={o.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Link href={`/sales-orders?id=${o.id}`} className="text-[14px] font-semibold text-ink hover:underline">{o.number}</Link>
                    <p className="text-[12px] text-muted">{o.customer?.name ?? '—'}{o.expectedDelivery ? ` · expected ${dateTime(o.expectedDelivery)}` : ''}</p>
                  </div>
                  <span className="flex flex-wrap gap-1.5">
                    {o.delayed && <Badge tone="rose">Delayed</Badge>}
                    <Badge tone={st.tone}>{st.label}</Badge>
                    <Badge tone={PAYMENT_STATUS[o.paymentStatus]?.tone ?? 'slate'}>{PAYMENT_STATUS[o.paymentStatus]?.label ?? o.paymentStatus} (recorded)</Badge>
                    {tracked.length > 0 && (o.stock.fullyReserved ? <Badge tone="brand">Stock reserved</Badge> : <Badge tone="amber">Stock not reserved</Badge>)}
                  </span>
                </div>
                <ul className="mt-2 text-[12.5px]">
                  {o.stock.lines.map((l) => (
                    <li key={l.productId} className="flex justify-between gap-2 border-t border-line py-1.5 first:border-t-0">
                      <span className="text-body">{l.name}</span>
                      <span className="text-muted tabular">
                        {!l.tracked ? 'not tracked' : l.unitMismatch ? 'unit differs from stock unit' : l.dispatched >= l.needed ? `${l.dispatched}/${l.needed} ${l.unit} dispatched` : `${l.reserved + l.dispatched}/${l.needed} ${l.unit} reserved · ${l.available} free`}
                      </span>
                    </li>
                  ))}
                  {o.stock.untrackedItems > 0 && <li className="border-t border-line py-1.5 text-muted">{o.stock.untrackedItems} custom item(s) - not stock-tracked</li>}
                </ul>
                <span className="mt-2 flex flex-wrap gap-2">
                  {tracked.length > 0 && !o.stock.fullyReserved && o.status !== 'dispatched' && (
                    <>
                      <Button variant="primary" className="h-8" busy={reserving === o.id} onClick={() => reserve(o)}>Reserve stock now</Button>
                      <Button className="h-8" onClick={() => setDeciding(o)}>Decide on shortage</Button>
                    </>
                  )}
                  {o.status === 'ready_to_dispatch' && <Button variant="primary" className="h-8" onClick={() => setDispatching(o)}><Truck className="size-4" /> Dispatch</Button>}
                </span>
              </Card>
            );
          })}
        </div>
      )}

      {tab === 'tasks' && (tasks ? <WorkTaskList items={tasks} onChanged={reloadAll} notify={setNotice} /> : <Skeleton className="h-40" />)}

      {tab === 'movements' && (
        <Card className="overflow-x-auto">
          <CardHeader title="Stock movements" subtitle="Every change, newest first. Nothing is ever edited or deleted." />
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="border-y border-line text-left text-[12px] text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">When</th>
                <th className="px-3 py-2.5 font-medium">Product</th>
                <th className="px-3 py-2.5 font-medium">Type</th>
                <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                <th className="px-3 py-2.5 text-right font-medium">On hand / reserved after</th>
                <th className="px-5 py-2.5 font-medium">Reference / reason</th>
              </tr>
            </thead>
            <tbody>
              {moves?.map((m) => (
                <tr key={m.id} className="border-t border-line">
                  <td className="px-5 py-2 text-muted" title={dateTime(m.createdAt)}>{timeAgo(m.createdAt)}</td>
                  <td className="px-3">{m.product.name}</td>
                  <td className="px-3"><Badge tone={m.type === 'receive' ? 'brand' : m.type === 'dispatch' ? 'sky' : m.type === 'adjust' ? 'amber' : 'violet'}>{m.type}</Badge></td>
                  <td className="px-3 text-right tabular">{Number(m.quantity)} {m.product.priceUnit}</td>
                  <td className="px-3 text-right tabular">{Number(m.onHandAfter)} / {Number(m.reservedAfter)}</td>
                  <td className="px-5 text-muted">{[m.reference, m.lot && `lot ${m.lot}`, m.reason].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {moves?.length === 0 && <Empty title="No stock movements yet" />}
        </Card>
      )}

      <Dialog open={dispatching !== null} onClose={() => setDispatching(null)} title={dispatching ? `Dispatch ${dispatching.number}` : ''}>
        {dispatching && <DispatchForm order={dispatching} onDone={async (msg, tone = 'ok') => { if (tone === 'ok') setDispatching(null); setNotice({ tone, text: msg }); await reloadAll(); }} />}
      </Dialog>
      <Dialog open={deciding !== null} onClose={() => setDeciding(null)} title={deciding ? `Stock shortage on ${deciding.number}` : ''}>
        {deciding && <ShortageForm order={deciding} onDone={async (msg, tone = 'ok') => { if (tone === 'ok') setDeciding(null); setNotice({ tone, text: msg }); await reloadAll(); }} />}
      </Dialog>
      <Dialog open={action !== null} onClose={closeAction} title={action ? `${action.kind === 'track' ? 'Start tracking' : action.kind === 'receive' ? 'Receive stock' : 'Correct stock'}: ${action.row.name}` : ''}>
        {action && (
          <StockForm
            action={action}
            onDone={async (msg, tone = 'ok') => {
              setAction(null);
              setNotice({ tone, text: msg });
              await reloadAll();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function DispatchForm({ order, onDone }: { order: FulfilmentRow; onDone: (msg: string, tone?: 'ok' | 'error') => void }) {
  const [courier, setCourier] = useState('');
  const [trackingRef, setTrackingRef] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 text-[13px]">
      <Label text="Courier / transporter"><input className={inputCls} value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="ST Courier, own vehicle, customer pickup" /></Label>
      <Label text="Tracking / LR number (optional)"><input className={inputCls} value={trackingRef} onChange={(e) => setTrackingRef(e.target.value)} /></Label>
      <p className="text-[12px] text-muted">The order moves to dispatched only if its stock is reserved. The customer update includes the tracking number (opt-out and DRY_RUN apply).</p>
      <div className="flex justify-end"><Button variant="primary" busy={busy} disabled={!courier.trim()} onClick={async () => { setBusy(true); try { await api.post(`/operations/orders/${order.id}/dispatch`, { courier, trackingRef }); onDone(`${order.number} dispatched.`); } catch (e) { onDone(errorText(e), 'error'); } finally { setBusy(false); } }}>Dispatch</Button></div>
    </div>
  );
}

function ShortageForm({ order, onDone }: { order: FulfilmentRow; onDone: (msg: string, tone?: 'ok' | 'error') => void }) {
  const [decision, setDecision] = useState('revised_date');
  const [newDate, setNewDate] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 text-[13px]">
      <Label text="Decision">
        <select className={inputCls} value={decision} onChange={(e) => setDecision(e.target.value)}>
          <option value="revised_date">Wait for stock - revised delivery date</option>
          <option value="alternative">Offer an alternative product</option>
          <option value="partial">Partial order now, rest later</option>
          <option value="cancel">Cancel the order</option>
        </select>
      </Label>
      {decision === 'revised_date' && <Label text="Revised delivery date"><input type="date" className={inputCls} value={newDate} onChange={(e) => setNewDate(e.target.value)} /></Label>}
      <Label text="Message to the customer (sent exactly as approved)"><textarea className={cx(inputCls, 'h-24 py-2')} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="The maroon silk arrives next week; we can deliver on 28 Oct." /></Label>
      <p className="text-[12px] text-muted">Needs sales.decide_shortage (owner / manager). Others send it for approval. Nothing is promised to the customer before approval.</p>
      <div className="flex justify-end"><Button variant="primary" busy={busy} onClick={async () => { setBusy(true); try { const r = await api.post<{ applied: boolean }>(`/operations/orders/${order.id}/shortage-decision`, { decision, newDate: newDate ? new Date(`${newDate}T12:00:00`).toISOString() : undefined, customerMessage: message }); onDone(r.applied ? `${order.number}: decision applied and customer message queued.` : `${order.number}: decision sent for approval.`); } catch (e) { onDone(errorText(e), 'error'); } finally { setBusy(false); } }}>{'Save decision'}</Button></div>
    </div>
  );
}

function StockForm({ action, onDone }: { action: NonNullable<Action>; onDone: (msg: string, tone?: 'ok' | 'error') => void }) {
  const [clientKey] = useState(newClientKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { kind, row } = action;
  async function submit(form: FormData) {
    setBusy(true);
    setErr(null);
    const v = (k: string) => String(form.get(k) ?? '').trim();
    try {
      if (kind === 'track') {
        await api.post(`/operations/inventory/${row.productId}/track`, { lowStockAt: v('lowStockAt') === '' ? null : Number(v('lowStockAt')) });
        onDone(`${row.name} is now stock-tracked (0 on hand). Receive the stock you have to start.`);
      } else if (kind === 'receive') {
        await api.post(`/operations/inventory/${row.productId}/receive`, { quantity: Number(v('quantity')), reference: v('reference'), lot: v('lot'), clientKey });
        onDone(`Received ${v('quantity')} ${row.unit} of ${row.name}.`);
      } else {
        const r = await api.post<{ applied: boolean }>(`/operations/inventory/${row.productId}/adjust`, { delta: Number(v('delta')), reason: v('reason'), clientKey });
        onDone(r.applied ? `Correction applied to ${row.name} (recorded as approved by you).` : `Correction for ${row.name} sent for approval. Nothing changes until it is approved.`);
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(new FormData(e.currentTarget));
      }}
      className="flex flex-col gap-3"
    >
      {kind === 'track' && (
        <Label text={`Low-stock alert at (${row.unit})`}><input name="lowStockAt" type="number" min={0} step="0.01" placeholder="e.g. 200" className={inputCls} /></Label>
      )}
      {kind === 'receive' && (
        <>
          <Label text={`Quantity received (${row.unit}) *`}><input name="quantity" type="number" min={0} step="0.01" required className={inputCls} /></Label>
          <Label text="Reference (GRN / supplier invoice / challan) *"><input name="reference" required className={inputCls} /></Label>
          <Label text="Lot / batch"><input name="lot" className={inputCls} /></Label>
        </>
      )}
      {kind === 'adjust' && (
        <>
          <p className="text-[12.5px] text-muted">Now: {row.onHand} on hand, {row.reserved} reserved. A correction needs the stock-correction permission; otherwise it goes to the approval queue.</p>
          <Label text={`Change (+ or −, ${row.unit}) *`}><input name="delta" type="number" step="0.01" required className={inputCls} placeholder="-5" /></Label>
          <Label text="Reason *"><input name="reason" required className={inputCls} placeholder="Physical count difference, damaged roll…" /></Label>
        </>
      )}
      {err && <p className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" busy={busy}>{kind === 'track' ? 'Start tracking' : kind === 'receive' ? 'Record receipt' : 'Submit correction'}</Button>
      </div>
    </form>
  );
}
