'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { newClientKey } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Button, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Dialog, IndustryOnly, Label, Notice, errorText, inputCls } from '@/components/textile';
import { DataList, Pill, SearchBox, Section, SourceNote, Stat, Timeline, Toolbar, dayLabel, money, plusDays, time, todayIst, when } from '@/components/vertical-ui';

type Appt = {
  id: string; reference: string; status: string; statusLabel: string; next: string[]; startAt: string; endAt: string; day: string; time: string; label: string;
  doctor: { id: string; name: string; fee: number }; department: { id: string; name: string }; patient: { id: string; name: string | null; phone: string | null };
  visitType: string; reasonNote: string | null; channel: string; cancellationReason: string | null; feedbackRating: number | null; isDemo: boolean;
  events?: Array<{ action: string; actor: string; at: string; data: unknown }>;
};
type Directory = Array<{ id: string; name: string; doctors: Array<{ id: string; name: string; specialty: string | null; consultationFee: number; active: boolean }> }>;
type Slot = { startAt: string; time: string; label: string };

const ACTION: Record<string, { label: string; variant?: 'primary' | 'danger' }> = {
  confirmed: { label: 'Confirm', variant: 'primary' }, checked_in: { label: 'Check in', variant: 'primary' }, completed: { label: 'Consultation done', variant: 'primary' },
  cancelled: { label: 'Cancel', variant: 'danger' }, no_show: { label: 'Mark no-show', variant: 'danger' },
};

export default function AppointmentsPage() {
  return (
    <>
      <PageHeader title="Appointments" crumb="Clinic" />
      <IndustryOnly allow={['hospital']}>
        <Suspense>
          <Appointments />
        </Suspense>
      </IndustryOnly>
    </>
  );
}

function Appointments() {
  const params = useSearchParams();
  const [view, setView] = useState<'day' | 'upcoming' | 'all'>('day');
  const [day, setDay] = useState(todayIst());
  const [q, setQ] = useState(params.get('q') ?? '');
  const query = new URLSearchParams({ ...(view === 'day' ? { day } : view === 'upcoming' ? { status: 'upcoming' } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
  const { data, error, reload } = useApi<Appt[]>(`/hospital/appointments?${query}`, 20_000);
  const { data: todayRows } = useApi<Appt[]>(`/hospital/appointments?day=${todayIst()}`, 30_000);
  const [open, setOpen] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const closeBook = useCallback(() => setBooking(false), []);
  const t = todayRows ?? [];
  return (
    <>
      <Notice notice={notice} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Today" value={todayRows ? t.filter((a) => a.status !== 'cancelled').length : '…'} />
        <Stat label="Checked in / done" value={todayRows ? t.filter((a) => ['checked_in', 'completed'].includes(a.status)).length : '…'} />
        <Stat label="Still to come today" value={todayRows ? t.filter((a) => ['booked', 'confirmed'].includes(a.status)).length : '…'} />
        <Stat label="No-shows today" value={todayRows ? t.filter((a) => a.status === 'no_show').length : '…'} tone={t.some((a) => a.status === 'no_show') ? 'red' : undefined} />
      </div>
      <Toolbar>
        <Segmented label="View" value={view} onChange={setView} options={[{ value: 'day', label: 'Day' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'all', label: 'All' }]} />
        {view === 'day' && (
          <div className="flex items-center gap-1.5">
            <Button aria-label="Previous day" onClick={() => setDay(plusDays(day, -1))}><ChevronLeft className="size-4" /></Button>
            <span className="min-w-[110px] text-center text-[13px] font-semibold text-ink">{day === todayIst() ? 'Today' : dayLabel(day)}</span>
            <Button aria-label="Next day" onClick={() => setDay(plusDays(day, 1))}><ChevronRight className="size-4" /></Button>
          </div>
        )}
        <SearchBox value={q} onChange={setQ} placeholder="Reference, patient or phone" />
        <Button variant="primary" className="ml-auto" onClick={() => setBooking(true)}><Plus className="size-4" /> Book appointment</Button>
      </Toolbar>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error && <Skeleton className="h-72" />}
      {data && (
        <DataList
          rows={data}
          rowKey={(a) => a.id}
          onOpen={(a) => setOpen(a.id)}
          empty={view === 'day' ? 'No appointments on this day.' : 'No appointments match.'}
          columns={[
            { head: 'Time', cell: (a) => <div><p className="font-semibold text-ink">{view === 'day' ? time(a.startAt) : a.label}</p><p className="text-[11.5px] text-muted">{a.reference}</p></div> },
            { head: 'Patient', cell: (a) => <div><p className="text-ink">{a.patient.name ?? '—'}</p><p className="text-[11.5px] text-muted">{a.patient.phone}</p></div> },
            { head: 'Doctor', cell: (a) => <div><p className="text-ink">{a.doctor.name}</p><p className="text-[11.5px] text-muted">{a.department.name}</p></div> },
            { head: 'Visit', cell: (a) => <span className="text-body">{a.visitType === 'follow_up' ? 'Follow-up' : 'New'} · {a.channel}</span> },
            { head: 'Status', cell: (a) => <Pill status={a.status}>{a.statusLabel}</Pill> },
          ]}
          card={(a) => (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-ink">{view === 'day' ? time(a.startAt) : a.label} · {a.patient.name ?? a.patient.phone}</p>
                <p className="truncate text-[12px] text-muted">{a.doctor.name} · {a.department.name}</p>
              </div>
              <Pill status={a.status}>{a.statusLabel}</Pill>
            </div>
          )}
        />
      )}
      <SourceNote api="GET /hospital/appointments" />
      <Dialog open={!!open} onClose={close} title="Appointment" wide>
        {open && <Detail id={open} onChanged={async (t2) => { setNotice({ tone: 'ok', text: t2 }); await reload(); }} />}
      </Dialog>
      <Dialog open={booking} onClose={closeBook} title="Book an appointment" wide>
        {booking && <Book onDone={async (t2) => { setBooking(false); setNotice({ tone: 'ok', text: t2 }); await reload(); }} />}
      </Dialog>
    </>
  );
}

function Detail({ id, onChanged }: { id: string; onChanged: (t: string) => void }) {
  const { data: a, reload } = useApi<Appt>(`/hospital/appointments/${id}`, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [day, setDay] = useState(todayIst());
  useEffect(() => {
    if (!moving || !a) return;
    api.get<Slot[]>(`/hospital/doctors/${a.doctor.id}/slots?day=${day}`).then(setSlots).catch((e) => setErr(errorText(e)));
  }, [moving, day, a]);
  if (!a) return <Skeleton className="h-60" />;
  async function move(status: string) {
    setBusy(status);
    setErr(null);
    try {
      await api.post(`/hospital/appointments/${id}/status`, { status, note: status === 'cancelled' ? 'Cancelled by reception' : undefined });
      await reload();
      onChanged(`${a!.reference}: ${ACTION[status]?.label ?? status}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  async function reschedule(s: Slot) {
    setBusy('move');
    setErr(null);
    try {
      await api.post(`/hospital/appointments/${id}/reschedule`, { startAt: s.startAt });
      setMoving(false);
      await reload();
      onChanged(`${a!.reference} moved to ${s.label}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_240px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <p className="text-[16px] font-bold text-ink">{a.reference}</p>
          <Pill status={a.status}>{a.statusLabel}</Pill>
          {a.isDemo && <Pill tone="amber">demo</Pill>}
        </div>
        {err && <p role="alert" className="mb-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
        <Section title="Visit">
          <p className="text-[14px] font-semibold text-ink">{a.label}</p>
          <p className="text-[13px] text-body">{a.doctor.name} · {a.department.name} · fee {money(a.doctor.fee)}</p>
          <p className="text-[12.5px] text-muted">{a.visitType === 'follow_up' ? 'Follow-up visit' : 'New visit'} · booked via {a.channel}</p>
          {a.reasonNote && <p className="mt-1 text-[12.5px] text-body">Patient note: {a.reasonNote}</p>}
          {a.cancellationReason && <p className="mt-1 text-[12.5px] text-muted">{a.cancellationReason}</p>}
        </Section>
        <Section title="Patient">
          <p className="text-[13px] text-ink">{a.patient.name ?? '—'} · {a.patient.phone}</p>
          {a.feedbackRating !== null && <p className="text-[13px] text-ink">{'★'.repeat(a.feedbackRating)}{'☆'.repeat(5 - a.feedbackRating)}</p>}
        </Section>
        {moving && (
          <Section title="Move to another slot" action={<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" className={cx(inputCls, 'h-9 w-auto')} />}>
            {!slots ? <Skeleton className="h-16" /> : slots.length ? (
              <div className="flex flex-wrap gap-2">{slots.map((s) => <Button key={s.startAt} busy={busy === 'move'} onClick={() => reschedule(s)}>{s.time}</Button>)}</div>
            ) : <p className="text-[12.5px] text-muted">No free slots for {a.doctor.name} on this day.</p>}
          </Section>
        )}
      </div>
      <div>
        <Section title="Actions">
          <div className="flex flex-col gap-2">
            {a.next.map((s) => <Button key={s} variant={ACTION[s]?.variant ?? 'secondary'} busy={busy === s} disabled={busy !== null} onClick={() => move(s)} className="justify-start">{ACTION[s]?.label ?? s}</Button>)}
            {['booked', 'confirmed'].includes(a.status) && <Button onClick={() => { setMoving(true); setDay(a.day); }} className="justify-start">Reschedule</Button>}
            {!a.next.length && <p className="text-[12.5px] text-muted">No further actions.</p>}
          </div>
        </Section>
        <Section title="History">
          <Timeline items={(a.events ?? []).map((e) => ({ label: e.action, actor: e.actor, at: e.at }))} />
        </Section>
      </div>
    </div>
  );
}

function Book({ onDone }: { onDone: (t: string) => void }) {
  const { data: dir } = useApi<Directory>('/hospital/directory', 0);
  const [doctorId, setDoctorId] = useState('');
  const [day, setDay] = useState(todayIst());
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [f, setF] = useState({ phone: '', name: '', reasonNote: '', visitType: 'new' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => newClientKey());
  const doctors = dir?.flatMap((d) => d.doctors.filter((x) => x.active).map((x) => ({ ...x, dept: d.name }))) ?? [];
  useEffect(() => {
    if (!doctorId && doctors.length) setDoctorId(doctors[0].id);
  }, [doctors, doctorId]);
  useEffect(() => {
    if (!doctorId) return;
    setSlots(null);
    setSlot(null);
    api.get<Slot[]>(`/hospital/doctors/${doctorId}/slots?day=${day}`).then(setSlots).catch((e) => setErr(errorText(e)));
  }, [doctorId, day]);
  async function submit() {
    if (!slot) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ status: string; appointment: Appt }>('/hospital/appointments', { ...f, doctorId, startAt: slot.startAt, clientKey: key });
      onDone(`${r.appointment.reference} ${r.status === 'duplicate' ? 'already existed' : 'booked'}: ${r.appointment.label} with ${r.appointment.doctor.name}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!dir) return <Skeleton className="h-60" />;
  const doc = doctors.find((d) => d.id === doctorId);
  return (
    <div className="space-y-3">
      {err && <p role="alert" className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Label text="Doctor">
          <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className={inputCls}>
            {dir.map((d) => <optgroup key={d.id} label={d.name}>{d.doctors.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} — {money(x.consultationFee)}</option>)}</optgroup>)}
          </select>
        </Label>
        <Label text="Day"><input type="date" value={day} min={todayIst()} onChange={(e) => setDay(e.target.value)} className={inputCls} /></Label>
      </div>
      <div>
        <p className="mb-1 text-[12.5px] font-semibold text-body">Free slots {doc ? `· ${doc.name}` : ''}</p>
        {!slots ? <Skeleton className="h-12" /> : slots.length ? (
          <div className="flex flex-wrap gap-2">
            {slots.map((s) => (
              <button key={s.startAt} type="button" onClick={() => setSlot(s)} aria-pressed={slot?.startAt === s.startAt} className={cx('h-9 rounded-[10px] border px-3 text-[13px] font-semibold tabular', slot?.startAt === s.startAt ? 'border-transparent bg-[var(--industry-accent)] text-white' : 'border-line bg-white text-ink hover:bg-slate-50')}>
                {s.time}
              </button>
            ))}
          </div>
        ) : <p className="text-[12.5px] text-muted">No OPD slots that day (not a working day, on leave, or fully booked).</p>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Label text="Patient phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" className={inputCls} /></Label>
        <Label text="Patient name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} /></Label>
        <Label text="Visit type">
          <select value={f.visitType} onChange={(e) => setF({ ...f, visitType: e.target.value })} className={inputCls}><option value="new">New</option><option value="follow_up">Follow-up</option></select>
        </Label>
        <Label text="Note (administrative)"><input value={f.reasonNote} onChange={(e) => setF({ ...f, reasonNote: e.target.value })} placeholder="e.g. routine check-up" className={inputCls} /></Label>
      </div>
      <div className="flex justify-end"><Button variant="primary" busy={busy} disabled={!slot || !f.phone.trim()} onClick={submit}>Book {slot ? `${slot.time}` : ''}</Button></div>
      <p className="text-[11.5px] text-muted">The slot is re-checked inside a locked transaction when you book, so it can never be double-booked.</p>
    </div>
  );
}
