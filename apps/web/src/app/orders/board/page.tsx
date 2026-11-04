'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Check, Clock, ExternalLink } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { displayName } from '@/lib/format';
import { ACTION_LABEL, CHANNEL_LABEL, inr, pickupLabel, qty, type Order, type OrderStatus } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Badge, Button, ErrorBanner, Skeleton, cx } from '@/components/ui';

/**
 * Live order board for the shop counter: every open order in a column by stage (New → Confirmed → Cutting & packing
 * → Ready), refreshed every 5 s and at once when the AI assistant or a call places an order. New orders flash and
 * can chime. One tap moves an order to its next stage (same rules and audit as the order page).
 */
const COLUMNS: Array<{ status: OrderStatus; title: string; tone: string }> = [
  { status: 'pending', title: 'New', tone: 'border-amber-300 bg-amber-50' },
  { status: 'confirmed', title: 'Confirmed', tone: 'border-sky-300 bg-sky-50' },
  { status: 'preparing', title: 'Cutting & packing', tone: 'border-violet-300 bg-violet-50' },
  { status: 'ready', title: 'Ready to collect', tone: 'border-emerald-300 bg-emerald-50' },
];

function chime() {
  try {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const c = new C();
    for (const [f, at] of [[880, 0], [1320, 0.18]] as const) {
      const o = c.createOscillator(); const g = c.createGain();
      o.frequency.value = f; g.gain.setValueAtTime(0.0001, c.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.25, c.currentTime + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + 0.3);
      o.connect(g).connect(c.destination); o.start(c.currentTime + at); o.stop(c.currentTime + at + 0.32);
    }
  } catch { /* audio unavailable */ }
}

export default function OrderBoardPage() {
  const { data: orders, error, reload, loading } = useApi<Order[]>('/restaurant/orders?status=active', 5_000);
  const [sound, setSound] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => { try { setSound(localStorage.getItem('ts-board-sound') === '1'); } catch { /* ignore */ } }, []);
  // New orders since the board opened: highlighted for 20 s (and a chime when sound is on).
  useEffect(() => {
    if (!orders) return;
    const ids = new Set(orders.map((o) => o.id));
    if (!seen.current) { seen.current = ids; return; }
    const added = orders.filter((o) => !seen.current!.has(o.id)).map((o) => o.id);
    seen.current = ids;
    if (!added.length) return;
    if (sound) chime();
    setFresh((f) => new Set([...f, ...added]));
    const t = setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), 20_000);
    return () => clearTimeout(t);
  }, [orders, sound]);

  const advance = async (o: Order) => {
    const next = o.allowedNext.find((s) => s !== 'cancelled');
    if (!next) return;
    setBusy(o.id); setActionError(null);
    try { await api.patch(`/restaurant/orders/${o.id}`, { status: next }); await reload(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const toggleSound = () => { const v = !sound; setSound(v); try { localStorage.setItem('ts-board-sound', v ? '1' : '0'); } catch { /* ignore */ } if (v) chime(); };

  return (
    <>
      <PageHeader title="Live order board" crumb="Orders" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[13px] text-muted"><span className="size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse" />Live · updates by itself · {orders?.length ?? 0} open order{orders?.length === 1 ? '' : 's'}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={toggleSound} aria-pressed={sound}>{sound ? <Bell className="size-4" /> : <BellOff className="size-4" />}{sound ? 'Sound on' : 'Sound off'}</Button>
          <Link href="/orders" className="text-[13px] font-semibold text-brand hover:underline">All orders →</Link>
        </div>
      </div>
      {error && !orders && <ErrorBanner message={error} onRetry={reload} />}
      {actionError && <div className="mb-3"><ErrorBanner message={actionError} /></div>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4" data-testid="order-board">
        {COLUMNS.map((col) => {
          const list = (orders ?? []).filter((o) => o.status === col.status);
          return (
            <section key={col.status} className={cx('flex min-h-[220px] flex-col rounded-[16px] border-2 p-2.5', col.tone)} aria-label={col.title}>
              <h2 className="mb-2 flex items-center justify-between px-1 text-[14px] font-bold text-ink">{col.title}<span className="rounded-full bg-white px-2 py-0.5 text-[12px] ring-1 ring-black/10">{list.length}</span></h2>
              {loading && !orders ? <Skeleton className="h-24" /> : list.length === 0 ? <p className="px-1 py-6 text-center text-[12.5px] text-muted">Nothing here</p> : (
                <ul className="flex flex-col gap-2">
                  {list.map((o) => {
                    const next = o.allowedNext.find((s) => s !== 'cancelled');
                    return (
                      <li key={o.id} data-order={o.orderNumber} className={cx('rounded-[12px] bg-white p-3 shadow-sm ring-1 ring-black/5 transition-shadow', fresh.has(o.id) && 'ring-2 ring-emerald-500 motion-safe:animate-pulse')}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[15px] font-bold text-ink">{o.orderNumber}</p>
                            <p className="truncate text-[12.5px] text-body">{displayName({ name: o.customerName, phone: o.customerPhone })}</p>
                          </div>
                          <div className="text-right">
                            <p className="tabular text-[14px] font-bold text-ink">{inr(o.total)}</p>
                            <Badge tone={o.channel === 'voice' ? 'violet' : o.channel === 'assistant' ? 'sky' : 'brand'}>{CHANNEL_LABEL[o.channel] ?? o.channel}</Badge>
                          </div>
                        </div>
                        <p className="mt-1.5 text-[13px] text-ink">{o.items.map((i) => `${qty(i.quantity, i.unit)} ${i.name}${i.cut ? ` · ${i.cut}` : ''}`).join(', ')}</p>
                        <p className="mt-1 flex items-center gap-1 text-[12px] font-semibold text-[#075985]"><Clock className="size-3.5" />{pickupLabel(o.pickupAt)}</p>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          {next ? <Button variant="primary" busy={busy === o.id} onClick={() => void advance(o)}><Check className="size-4" />{ACTION_LABEL[next]}</Button> : <span />}
                          <Link href={`/orders/${o.id}`} className="inline-flex items-center gap-1 text-[12px] font-semibold text-muted hover:text-ink">Open <ExternalLink className="size-3" /></Link>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
