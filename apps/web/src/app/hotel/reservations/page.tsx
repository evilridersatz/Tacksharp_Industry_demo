'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { LogIn, LogOut, Plus } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { newClientKey } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Button, Card, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Dialog, IndustryOnly, Label, Notice, errorText, inputCls } from '@/components/textile';
import { DataList, Pill, SearchBox, Section, SimulatedNote, SourceNote, Stat, Timeline, Toolbar, dayLabel, money, plusDays, todayIst, when } from '@/components/vertical-ui';

type NightRate = { date: string; rate: number; source: string; label?: string };
type Reservation = {
  id: string; reference: string; status: string; statusLabel: string; roomType: { id: string; name: string; code: string }; room: { id: string; number: string } | null;
  checkIn: string; checkOut: string; nights: number; rooms: number; adults: number; children: number; holdExpiresAt: string | null;
  subtotal: number; taxAmount: number; total: number; depositAmount: number; rateBreakdown: NightRate[]; paymentStatus: string; paymentLabel: string; channel: string;
  guest: { id: string; name: string | null; phone: string | null }; specialRequests: string | null; cancellationReason: string | null; feedbackRating: number | null; feedbackComment: string | null;
  isDemo: boolean; createdAt: string; next: string[]; events?: Array<{ action: string; actor: string; data: unknown; at: string }>;
};
type Today = { date: string; arrivals: Reservation[]; departures: Reservation[]; inHouse: Reservation[] };
type RoomType = { id: string; name: string; code: string; maxOccupancy: number; maxAdults: number; baseRate: number };
type Quote = { ok: boolean; problems: string[]; nights: number; breakdown: NightRate[]; subtotal: number; tax: number; total: number; deposit: number; available: number };

const ACTIONS: Record<string, { label: string; path: string; variant?: 'primary' | 'danger' }> = {
  confirm: { label: 'Confirm booking', path: 'confirm', variant: 'primary' },
  check_in: { label: 'Check in', path: 'check-in', variant: 'primary' },
  check_out: { label: 'Check out', path: 'check-out', variant: 'primary' },
  no_show: { label: 'Mark no-show', path: 'no-show', variant: 'danger' },
  cancel: { label: 'Cancel reservation', path: 'cancel', variant: 'danger' },
};

export default function ReservationsPage() {
  return (
    <>
      <PageHeader title="Reservations" crumb="Front desk" />
      <IndustryOnly allow={['hotel']}>
        <Suspense>
          <Reservations />
        </Suspense>
      </IndustryOnly>
    </>
  );
}

function Reservations() {
  const params = useSearchParams();
  const [filter, setFilter] = useState<'upcoming' | 'in_house' | 'pending_confirmation' | 'all'>('upcoming');
  const [q, setQ] = useState(params.get('q') ?? '');
  const { data, error, reload } = useApi<Reservation[]>(`/hotel/reservations?${new URLSearchParams({ ...(filter !== 'all' ? { status: filter } : {}), ...(q.trim() ? { q: q.trim() } : {}) })}`, 20_000);
  const { data: today, reload: reloadToday } = useApi<Today>('/hotel/today', 30_000);
  const { data: pending, reload: reloadPending } = useApi<Reservation[]>('/hotel/reservations?status=pending_confirmation', 30_000);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const closeCreate = useCallback(() => setCreating(false), []);
  const refresh = async () => Promise.all([reload(), reloadToday(), reloadPending()]);
  return (
    <>
      <Notice notice={notice} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Arrivals today" value={today ? today.arrivals.length : '…'} hint={today ? `${today.arrivals.filter((r) => r.status === 'checked_in').length} checked in` : undefined} />
        <Stat label="Departures today" value={today ? today.departures.length : '…'} />
        <Stat label="In-house guests" value={today ? today.inHouse.length : '…'} />
        <Stat label="Awaiting confirmation" value={pending ? pending.length : '…'} hint="Pending bookings hold their room until the hold expires" tone={pending?.length ? 'amber' : undefined} />
      </div>
      {today && today.arrivals.length > 0 && (
        <Card className="mb-4 p-4">
          <p className="mb-2 text-[13px] font-semibold text-ink">Today's arrivals</p>
          <ul className="flex flex-wrap gap-2">
            {today.arrivals.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(r.id)} className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] hover:bg-slate-50">
                  {r.status === 'checked_in' ? <LogIn className="size-3.5 text-emerald-600" /> : <LogIn className="size-3.5 text-muted" />}
                  <span className="font-semibold text-ink">{r.guest.name ?? r.guest.phone}</span>
                  <span className="text-muted">{r.roomType.name}{r.room ? ` · ${r.room.number}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Toolbar>
        <Segmented label="Show reservations" value={filter} onChange={setFilter} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'pending_confirmation', label: 'To confirm' }, { value: 'in_house', label: 'In-house' }, { value: 'all', label: 'All' }]} />
        <SearchBox value={q} onChange={setQ} placeholder="Reference, guest or phone" />
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}><Plus className="size-4" /> New booking</Button>
      </Toolbar>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error && <Skeleton className="h-72" />}
      {data && (
        <DataList
          rows={data}
          rowKey={(r) => r.id}
          onOpen={(r) => setOpen(r.id)}
          empty="No reservations match."
          columns={[
            { head: 'Reference', cell: (r) => <div><p className="font-semibold text-ink">{r.reference}</p><p className="text-[11.5px] text-muted">{r.channel}</p></div> },
            { head: 'Guest', cell: (r) => <div><p className="text-ink">{r.guest.name ?? '—'}</p><p className="text-[11.5px] text-muted">{r.adults} adult{r.adults === 1 ? '' : 's'}{r.children ? ` + ${r.children}` : ''}</p></div> },
            { head: 'Stay', cell: (r) => <div><p className="text-ink">{dayLabel(r.checkIn)} → {dayLabel(r.checkOut)}</p><p className="text-[11.5px] text-muted">{r.nights} night{r.nights === 1 ? '' : 's'}</p></div> },
            { head: 'Room', cell: (r) => <span className="text-body">{r.roomType.name}{r.rooms > 1 ? ` × ${r.rooms}` : ''}{r.room ? ` · ${r.room.number}` : ''}</span> },
            { head: 'Total', align: 'right', cell: (r) => <span className="font-semibold text-ink">{money(r.total)}</span> },
            { head: 'Status', cell: (r) => <div className="flex flex-col items-start gap-1"><Pill status={r.status}>{r.statusLabel}</Pill>{r.paymentStatus !== 'not_required' && <Pill status={r.paymentStatus}>{r.paymentLabel}</Pill>}</div> },
          ]}
          card={(r) => (
            <div>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{r.guest.name ?? r.guest.phone} · {money(r.total)}</p>
                  <p className="truncate text-[12px] text-muted">{r.reference} · {r.roomType.name}</p>
                </div>
                <Pill status={r.status}>{r.statusLabel}</Pill>
              </div>
              <p className="mt-1.5 text-[12.5px] text-body">{dayLabel(r.checkIn)} → {dayLabel(r.checkOut)} · {r.nights} night{r.nights === 1 ? '' : 's'}</p>
            </div>
          )}
        />
      )}
      <SourceNote api="GET /hotel/reservations · /hotel/today" />
      <Dialog open={!!open} onClose={close} title="Reservation" wide>
        {open && <Detail id={open} onChanged={async (t) => { setNotice({ tone: 'ok', text: t }); await refresh(); }} />}
      </Dialog>
      <Dialog open={creating} onClose={closeCreate} title="New booking (front desk)" wide>
        {creating && <NewBooking onDone={async (t) => { setCreating(false); setNotice({ tone: 'ok', text: t }); await refresh(); }} />}
      </Dialog>
    </>
  );
}

function Detail({ id, onChanged }: { id: string; onChanged: (t: string) => void }) {
  const { data: r, reload } = useApi<Reservation>(`/hotel/reservations/${id}`, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [dates, setDates] = useState({ checkIn: '', checkOut: '' });
  if (!r) return <Skeleton className="h-60" />;
  async function act(path: string, body: Record<string, unknown> = {}, label = path) {
    setBusy(path);
    setErr(null);
    try {
      await api.post(`/hotel/reservations/${id}/${path}`, body);
      await reload();
      onChanged(`${r!.reference}: ${label}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_250px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <p className="text-[16px] font-bold text-ink">{r.reference}</p>
          <Pill status={r.status}>{r.statusLabel}</Pill>
          {r.paymentStatus !== 'not_required' && <Pill status={r.paymentStatus}>{r.paymentLabel}</Pill>}
          {r.isDemo && <Pill tone="amber">demo</Pill>}
        </div>
        {err && <p role="alert" className="mb-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
        {r.status === 'pending_confirmation' && r.holdExpiresAt && <p className="mb-3 rounded-[10px] bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">Room held until {when(r.holdExpiresAt)}. Confirm it, or it expires and the room goes back on sale.</p>}
        <Section title="Stay">
          <p className="text-[13px] text-ink">{r.roomType.name}{r.rooms > 1 ? ` × ${r.rooms}` : ''}{r.room ? ` · room ${r.room.number}` : ''}</p>
          <p className="text-[13px] text-body">{dayLabel(r.checkIn)} → {dayLabel(r.checkOut)} · {r.nights} night{r.nights === 1 ? '' : 's'} · {r.adults} adult{r.adults === 1 ? '' : 's'}{r.children ? `, ${r.children} child` : ''}</p>
          {r.specialRequests && <p className="mt-1 text-[12.5px] text-muted">Request: {r.specialRequests}</p>}
        </Section>
        <Section title="Rate (computed by the server)">
          <ul className="divide-y divide-line rounded-[12px] border border-line text-[13px]">
            {r.rateBreakdown.map((n) => (
              <li key={n.date} className="flex justify-between px-3 py-1.5">
                <span className="text-body">{dayLabel(n.date)} {n.source !== 'base' && <span className="text-[11.5px] text-muted">({n.label ?? n.source})</span>}</span>
                <span className="tabular">{money(n.rate)}{r.rooms > 1 ? ` × ${r.rooms}` : ''}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 text-[13px]">
            <div className="flex justify-between"><dt className="text-muted">Room charges</dt><dd className="tabular">{money(r.subtotal)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd className="tabular">{money(r.taxAmount)}</dd></div>
            <div className="flex justify-between border-t border-line pt-1 text-[14px] font-bold text-ink"><dt>Total</dt><dd className="tabular">{money(r.total)}</dd></div>
            {r.depositAmount > 0 && <div className="flex justify-between text-[12.5px]"><dt className="text-muted">Deposit</dt><dd className="tabular">{money(r.depositAmount)}</dd></div>}
          </dl>
        </Section>
        <Section title="Guest">
          <p className="text-[13px] text-ink">{r.guest.name ?? '—'} · {r.guest.phone}</p>
          <p className="text-[12px] text-muted">Booked via {r.channel} on {when(r.createdAt)}</p>
          {r.cancellationReason && <p className="mt-1 text-[12.5px] text-body">{r.cancellationReason}</p>}
          {r.feedbackRating !== null && <p className="mt-1 text-[13px] text-ink">{'★'.repeat(r.feedbackRating)}{'☆'.repeat(5 - r.feedbackRating)} {r.feedbackComment ? `“${r.feedbackComment}”` : ''}</p>}
        </Section>
        {moving && (
          <Section title="Change dates">
            <div className="flex flex-wrap items-end gap-2">
              <Label text="Check-in"><input type="date" value={dates.checkIn} onChange={(e) => setDates((d) => ({ ...d, checkIn: e.target.value }))} className={inputCls} /></Label>
              <Label text="Check-out"><input type="date" value={dates.checkOut} onChange={(e) => setDates((d) => ({ ...d, checkOut: e.target.value }))} className={inputCls} /></Label>
              <Button variant="primary" busy={busy === 'reschedule'} onClick={() => act('reschedule', { ...dates, adults: r.adults, children: r.children, rooms: r.rooms }, 'dates changed and re-priced')}>Re-check & save</Button>
            </div>
          </Section>
        )}
      </div>
      <div>
        <Section title="Actions">
          <div className="flex flex-col gap-2">
            {r.next.filter((a) => a !== 'reschedule').map((a) => (
              <Button key={a} variant={ACTIONS[a]?.variant ?? 'secondary'} busy={busy === ACTIONS[a]?.path} disabled={busy !== null} onClick={() => act(ACTIONS[a].path, a === 'cancel' ? { reason: 'Cancelled by the front desk' } : {}, ACTIONS[a].label.toLowerCase())} className="justify-start">
                {a === 'check_out' ? <LogOut className="size-4" /> : a === 'check_in' ? <LogIn className="size-4" /> : null}
                {ACTIONS[a]?.label ?? a}
              </Button>
            ))}
            {r.next.includes('reschedule') && <Button onClick={() => { setMoving(true); setDates({ checkIn: r.checkIn, checkOut: r.checkOut }); }} className="justify-start">Change dates</Button>}
            {r.paymentStatus === 'pending' && (
              <>
                <Button busy={busy === 'payment'} onClick={() => act('payment', { outcome: 'paid_verified' }, 'deposit recorded as received (verified by staff)')} className="justify-start">Deposit received (verified)</Button>
                <Button busy={busy === 'payment'} onClick={() => act('payment', { outcome: 'simulated_paid' }, 'deposit SIMULATED as paid')} className="justify-start">Simulate deposit (demo)</Button>
              </>
            )}
            {!r.next.length && r.paymentStatus !== 'pending' && <p className="text-[12.5px] text-muted">No further actions.</p>}
          </div>
          {r.paymentStatus !== 'not_required' && <div className="mt-2"><SimulatedNote>No payment gateway is connected: deposits are recorded by staff or simulated in demo / DRY_RUN.</SimulatedNote></div>}
        </Section>
        <Section title="History">
          <Timeline items={(r.events ?? []).map((e) => ({ label: e.action, actor: e.actor, at: e.at, note: (e.data as { outcome?: string } | null)?.outcome ? `Payment: ${(e.data as { outcome: string }).outcome.replace(/_/g, ' ')}` : null }))} />
        </Section>
      </div>
    </div>
  );
}

function NewBooking({ onDone }: { onDone: (t: string) => void }) {
  const { data: types } = useApi<RoomType[]>('/hotel/room-types', 0);
  const [f, setF] = useState({ phone: '', name: '', roomTypeId: '', checkIn: plusDays(todayIst(), 1), checkOut: plusDays(todayIst(), 2), adults: '2', children: '0', rooms: '1', specialRequests: '' });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => newClientKey());
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  useEffect(() => {
    if (!f.roomTypeId && types?.length) setF((x) => ({ ...x, roomTypeId: types[0].id }));
  }, [types, f.roomTypeId]);
  useEffect(() => {
    if (!f.roomTypeId) return;
    const t = setTimeout(() => {
      api.post<Quote>('/hotel/quote', { roomTypeId: f.roomTypeId, checkIn: f.checkIn, checkOut: f.checkOut, adults: Number(f.adults), children: Number(f.children), rooms: Number(f.rooms) }).then(setQuote).catch((e) => setErr(errorText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [f.roomTypeId, f.checkIn, f.checkOut, f.adults, f.children, f.rooms]);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ status: string; reservation: Reservation }>('/hotel/reservations', { ...f, adults: Number(f.adults), children: Number(f.children), rooms: Number(f.rooms), clientKey: key });
      onDone(`${r.reservation.reference} ${r.status === 'duplicate' ? 'already existed' : 'booked and confirmed'}: ${money(r.reservation.total)}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!types) return <Skeleton className="h-60" />;
  return (
    <div className="space-y-3">
      {err && <p role="alert" className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Label text="Guest phone"><input value={f.phone} onChange={set('phone')} inputMode="tel" className={inputCls} /></Label>
        <Label text="Guest name"><input value={f.name} onChange={set('name')} className={inputCls} /></Label>
        <Label text="Room type">
          <select value={f.roomTypeId} onChange={set('roomTypeId')} className={inputCls}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} (from {money(t.baseRate)}, up to {t.maxOccupancy})</option>)}
          </select>
        </Label>
        <div className="grid grid-cols-3 gap-2">
          <Label text="Adults"><input type="number" min={1} value={f.adults} onChange={set('adults')} className={inputCls} /></Label>
          <Label text="Children"><input type="number" min={0} value={f.children} onChange={set('children')} className={inputCls} /></Label>
          <Label text="Rooms"><input type="number" min={1} value={f.rooms} onChange={set('rooms')} className={inputCls} /></Label>
        </div>
        <Label text="Check-in"><input type="date" value={f.checkIn} onChange={set('checkIn')} className={inputCls} /></Label>
        <Label text="Check-out"><input type="date" value={f.checkOut} onChange={set('checkOut')} className={inputCls} /></Label>
      </div>
      <Label text="Special requests"><input value={f.specialRequests} onChange={set('specialRequests')} className={inputCls} /></Label>
      {quote && (
        <Card className={cx('p-3 text-[13px]', !quote.ok && 'border-rose-soft')}>
          {quote.ok ? (
            <>
              <p className="mb-1 text-[12px] text-muted">{quote.available} room(s) free for these dates</p>
              <div className="flex justify-between"><span className="text-muted">{quote.nights} night{quote.nights === 1 ? '' : 's'} room charges</span><span className="tabular">{money(quote.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Tax</span><span className="tabular">{money(quote.tax)}</span></div>
              <div className="mt-1 flex justify-between border-t border-line pt-1 font-bold text-ink"><span>Total</span><span className="tabular">{money(quote.total)}</span></div>
            </>
          ) : <p className="text-rose">{quote.problems.join(' ')}</p>}
        </Card>
      )}
      <div className="flex justify-end"><Button variant="primary" busy={busy} disabled={!quote?.ok || !f.phone.trim()} onClick={submit}>Book & confirm</Button></div>
      <p className="text-[11.5px] text-muted">Availability is re-checked inside a locked transaction when you book, so two people can never take the last room.</p>
    </div>
  );
}
