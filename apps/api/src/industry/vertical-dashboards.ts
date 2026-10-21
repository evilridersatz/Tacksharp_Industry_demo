import type { PrismaService } from '../prisma/prisma.service.js';
import { addDays, dateOnly, istDay } from '../verticals/common.js';

/**
 * Dashboards for the food, hotel and hospital modules. Same contract as IndustryService.dashboard: every number is
 * computed from this organization's records only, and each chart names its source.
 */
type Kpi = { key: string; label: string; value: number | null; format: 'number' | 'inr' | 'pct' | 'hours'; hint?: string; tone?: 'brand' | 'sky' | 'violet' | 'amber' | 'rose' | 'slate' };
type Chart = { key: string; title: string; kind: 'line' | 'bar' | 'donut' | 'funnel'; unit: string; labels: string[]; series: Array<{ name: string; values: number[] }>; source: string; empty?: string };

const DAY = 86_400_000;
const IST = 330 * 60_000;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function buckets(days: number) {
  const today = Math.floor((Date.now() + IST) / DAY);
  const keys = Array.from({ length: days }, (_, i) => today - (days - 1 - i));
  return { labels: keys.map((k) => new Date(k * DAY).toISOString().slice(5, 10).split('-').reverse().join('/')), index: (d: Date) => keys.indexOf(Math.floor((d.getTime() + IST) / DAY)) };
}
function perDay(days: number, rows: Array<{ at: Date; value?: number }>) {
  const b = buckets(days);
  const values = new Array(days).fill(0);
  for (const r of rows) {
    const i = b.index(r.at);
    if (i >= 0) values[i] = r2(values[i] + (r.value ?? 1));
  }
  return { labels: b.labels, values };
}
function tally<T>(rows: T[], key: (r: T) => string | null | undefined, value: (r: T) => number = () => 1) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) || 'unknown';
    m.set(k, r2((m.get(k) ?? 0) + value(r)));
  }
  return m;
}
const top = (m: Map<string, number>, k = 8) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
const bar = (key: string, title: string, unit: string, entries: Array<[string, number]>, source: string, name = title): Chart => ({ key, title, kind: 'bar', unit, labels: entries.map((e) => e[0]), series: [{ name, values: entries.map((e) => e[1]) }], source, ...(entries.length ? {} : { empty: 'No records in this period.' }) });
const donut = (key: string, title: string, m: Map<string, number>, source: string): Chart => {
  const e = [...m.entries()].filter((x) => x[1] > 0);
  return { key, title, kind: 'donut', unit: 'count', labels: e.map((x) => x[0]), series: [{ name: title, values: e.map((x) => x[1]) }], source, ...(e.length ? {} : { empty: 'No records in this period.' }) };
};

export async function foodDashboard(prisma: PrismaService, org: string, days: number, since: Date) {
  const orders = await prisma.order.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true, total: true, createdAt: true, fulfilment: true, channel: true, feedbackRating: true, complaintStatus: true, customerId: true, items: { select: { name: true, quantity: true, lineTotal: true } } } });
  const valid = orders.filter((o) => o.status !== 'cancelled');
  const revenue = r2(valid.reduce((a, o) => a + n(o.total), 0));
  const rated = orders.filter((o) => o.feedbackRating !== null);
  const delivery = valid.filter((o) => o.fulfilment === 'delivery').length;
  const hours = new Array(24).fill(0);
  for (const o of valid) hours[new Date(o.createdAt.getTime() + IST).getUTCHours()]++;
  const first = hours.findIndex((h) => h > 0), last = 23 - [...hours].reverse().findIndex((h) => h > 0);
  const vol = perDay(days, valid.map((o) => ({ at: o.createdAt })));
  const rev = perDay(days, valid.map((o) => ({ at: o.createdAt, value: n(o.total) })));
  const items = tally(valid.flatMap((o) => o.items), (i) => i.name, (i) => n(i.quantity));
  const kpis: Kpi[] = [
    { key: 'orders', label: 'Orders', value: valid.length, format: 'number', tone: 'brand', hint: 'Not cancelled' },
    { key: 'revenue', label: 'Order value', value: revenue, format: 'inr', tone: 'sky', hint: 'Order totals incl. tax and fees; payment is collected at pickup / delivery' },
    { key: 'aov', label: 'Average order value', value: valid.length ? r2(revenue / valid.length) : null, format: 'inr' },
    { key: 'open', label: 'Open orders', value: orders.filter((o) => ['pending', 'confirmed', 'preparing', 'ready', 'dispatched', 'needs_attention'].includes(o.status)).length, format: 'number', tone: 'amber' },
    { key: 'delivery_share', label: 'Delivery share', value: valid.length ? r1((delivery / valid.length) * 100) : null, format: 'pct', hint: `${delivery} delivery · ${valid.length - delivery} pickup` },
    { key: 'cancelled', label: 'Cancelled', value: orders.length - valid.length, format: 'number', tone: 'rose' },
    { key: 'feedback', label: 'Feedback score', value: rated.length ? r1(rated.reduce((a, o) => a + n(o.feedbackRating), 0) / rated.length) : null, format: 'number', hint: `Average of ${rated.length} rating(s), 1–5` },
    { key: 'complaints', label: 'Open complaints', value: orders.filter((o) => o.complaintStatus === 'open').length, format: 'number', tone: 'rose' },
  ];
  const charts: Chart[] = [
    { key: 'volume', title: 'Orders per day', kind: 'line', unit: 'orders', labels: vol.labels, series: [{ name: 'Orders', values: vol.values }], source: 'Orders (not cancelled)', ...(valid.length ? {} : { empty: 'No orders in this period.' }) },
    { key: 'revenue', title: 'Order value per day', kind: 'line', unit: '₹', labels: rev.labels, series: [{ name: 'Order value', values: rev.values }], source: 'Order totals (not cancelled)', ...(valid.length ? {} : { empty: 'No orders in this period.' }) },
    bar('items', 'Top items (quantity)', 'items', top(items), 'Order items (not cancelled)', 'Quantity'),
    donut('fulfilment', 'Pickup vs delivery', tally(valid, (o) => o.fulfilment), 'Orders (not cancelled)'),
    donut('status', 'Orders by status', tally(orders, (o) => o.status), 'Orders'),
    bar('peak', 'Ordering hours (IST)', 'orders', first < 0 ? [] : hours.slice(first, last + 1).map((v, i) => [`${first + i}:00`, v] as [string, number]), 'Order time (IST)', 'Orders'),
    donut('channel', 'Orders by channel', tally(valid, (o) => o.channel), 'Orders (not cancelled)'),
  ];
  return { kpis, charts, notes: ['Prices, tax and fees are computed by the server from the menu and Settings; payments are collected at the counter / on delivery (no payment integration).'] };
}

export async function hotelDashboard(prisma: PrismaService, org: string, days: number, since: Date) {
  const today = istDay(new Date());
  const from = addDays(today, -(days - 1));
  const sellable = await prisma.room.count({ where: { organizationId: org, status: { not: 'out_of_service' } } });
  const [stays, created, upcoming] = await Promise.all([
    prisma.reservation.findMany({ where: { organizationId: org, status: { in: ['confirmed', 'checked_in', 'checked_out'] }, checkIn: { lte: dateOnly(addDays(today, 14)) }, checkOut: { gt: dateOnly(from) } }, select: { checkIn: true, checkOut: true, rooms: true, nights: true, subtotal: true, roomType: { select: { name: true } }, status: true } }),
    prisma.reservation.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { status: true, createdAt: true, channel: true, total: true, roomType: { select: { name: true } } } }),
    prisma.reservation.findMany({ where: { organizationId: org, OR: [{ checkIn: dateOnly(today) }, { checkOut: dateOnly(today) }, { status: 'pending_confirmation' }] }, select: { checkIn: true, checkOut: true, status: true, holdExpiresAt: true } }),
  ]);
  const nightRooms = (day: string) => {
    const t = dateOnly(day).getTime();
    return stays.filter((r) => r.checkIn.getTime() <= t && t < r.checkOut.getTime()).reduce((a, r) => a + r.rooms, 0);
  };
  const past = Array.from({ length: days }, (_, k) => addDays(from, k));
  const sold = past.map(nightRooms);
  const roomNights = sold.reduce((a, b) => a + b, 0);
  const capacity = sellable * days;
  // Room revenue earned on nights inside the period (pro-rated per night of each stay).
  let roomRevenue = 0;
  const byType = new Map<string, number>();
  for (const r of stays) {
    const perNight = r.nights ? n(r.subtotal) / r.nights : 0;
    for (const d of past) {
      const t = dateOnly(d).getTime();
      if (r.checkIn.getTime() <= t && t < r.checkOut.getTime()) {
        roomRevenue += perNight;
        byType.set(r.roomType.name, (byType.get(r.roomType.name) ?? 0) + r.rooms);
      }
    }
  }
  const ahead = Array.from({ length: 14 }, (_, k) => addDays(today, k));
  const now = Date.now();
  const kpis: Kpi[] = [
    { key: 'occupancy_tonight', label: 'Occupancy tonight', value: sellable ? r1((nightRooms(today) / sellable) * 100) : null, format: 'pct', tone: 'brand', hint: `${nightRooms(today)} of ${sellable} sellable rooms` },
    { key: 'occupancy', label: `Occupancy (last ${days} days)`, value: capacity ? r1((roomNights / capacity) * 100) : null, format: 'pct', tone: 'sky', hint: 'Room nights sold ÷ sellable room nights' },
    { key: 'adr', label: 'Average daily rate (ADR)', value: roomNights ? r2(roomRevenue / roomNights) : null, format: 'inr', hint: 'Room revenue ÷ room nights sold (before tax)' },
    { key: 'revpar', label: 'RevPAR', value: capacity ? r2(roomRevenue / capacity) : null, format: 'inr', hint: 'Room revenue ÷ sellable room nights' },
    { key: 'reservations', label: 'Reservations made', value: created.length, format: 'number', tone: 'violet', hint: 'Created in the period, any status' },
    { key: 'arrivals', label: 'Arrivals today', value: upcoming.filter((r) => r.checkIn.toISOString().slice(0, 10) === today && ['confirmed', 'pending_confirmation', 'checked_in'].includes(r.status)).length, format: 'number' },
    { key: 'pending', label: 'Awaiting confirmation', value: upcoming.filter((r) => r.status === 'pending_confirmation' && (!r.holdExpiresAt || r.holdExpiresAt.getTime() > now)).length, format: 'number', tone: 'amber' },
    { key: 'cancel_rate', label: 'Cancellations & no-shows', value: created.length ? r1((created.filter((r) => ['cancelled', 'no_show'].includes(r.status)).length / created.length) * 100) : null, format: 'pct', tone: 'rose' },
  ];
  const booked = perDay(days, created.map((r) => ({ at: r.createdAt })));
  const charts: Chart[] = [
    { key: 'occupancy_ahead', title: 'Occupancy — next 14 nights', kind: 'line', unit: '%', labels: ahead.map((d) => d.slice(5).split('-').reverse().join('/')), series: [{ name: 'Occupancy %', values: ahead.map((d) => (sellable ? r1((nightRooms(d) / sellable) * 100) : 0)) }], source: 'Confirmed and in-house reservations ÷ sellable rooms' },
    { key: 'occupancy_past', title: `Occupancy — last ${days} nights`, kind: 'line', unit: '%', labels: past.map((d) => d.slice(5).split('-').reverse().join('/')), series: [{ name: 'Occupancy %', values: sold.map((v) => (sellable ? r1((v / sellable) * 100) : 0)) }], source: 'Room nights sold ÷ sellable rooms', ...(roomNights ? {} : { empty: 'No stays in this period.' }) },
    { key: 'bookings', title: 'Reservations made per day', kind: 'line', unit: 'reservations', labels: booked.labels, series: [{ name: 'Reservations', values: booked.values }], source: 'Reservations created', ...(created.length ? {} : { empty: 'No reservations in this period.' }) },
    bar('room_mix', 'Room nights by room type', 'room nights', top(byType), 'Stays in the period', 'Room nights'),
    donut('status', 'Reservations by status', tally(created, (r) => r.status), 'Reservations created in the period'),
    donut('channel', 'Booking channel', tally(created, (r) => r.channel), 'Reservations created in the period'),
  ];
  return { kpis, charts, notes: ['Pending reservations hold rooms until their hold expires; occupancy counts only confirmed and in-house stays.', 'Deposits: there is no payment integration — statuses are recorded by staff or SIMULATED in demo.'] };
}

export async function hospitalDashboard(prisma: PrismaService, org: string, days: number, since: Date) {
  const today = istDay(new Date());
  const [appts, leads, cases, todayCount] = await Promise.all([
    prisma.appointment.findMany({ where: { organizationId: org, startAt: { gte: since, lte: new Date(Date.now() + 14 * DAY) } }, select: { status: true, startAt: true, createdAt: true, channel: true, feedbackRating: true, department: { select: { name: true } }, doctor: { select: { name: true } } } }),
    prisma.lead.findMany({ where: { organizationId: org, createdAt: { gte: since } }, select: { source: true, status: true, campaign: true } }),
    prisma.insuranceCase.findMany({ where: { organizationId: org }, select: { status: true, kind: true, requiredDocs: true, receivedDocs: true } }),
    prisma.appointment.count({ where: { organizationId: org, status: { notIn: ['cancelled'] }, startAt: { gte: new Date(dateOnly(today).getTime() - IST), lt: new Date(dateOnly(today).getTime() - IST + DAY) } } }),
  ]);
  const pastAppts = appts.filter((a) => a.startAt.getTime() <= Date.now());
  const noShow = pastAppts.filter((a) => a.status === 'no_show').length;
  const attendedOrNo = pastAppts.filter((a) => ['completed', 'no_show', 'checked_in'].includes(a.status)).length;
  const rated = appts.filter((a) => a.feedbackRating !== null);
  const open = cases.filter((c) => !['settled', 'closed', 'rejected'].includes(c.status));
  const docsPending = cases.filter((c) => c.status === 'documents_pending').length;
  const campaignLeads = leads.filter((l) => ['meta', 'facebook', 'instagram', 'google'].includes(String(l.source))).length;
  const kpis: Kpi[] = [
    { key: 'appointments', label: 'Appointments', value: pastAppts.filter((a) => a.status !== 'cancelled').length, format: 'number', tone: 'brand', hint: `Last ${days} days, not cancelled` },
    { key: 'today', label: "Today's appointments", value: todayCount, format: 'number', tone: 'sky' },
    { key: 'upcoming', label: 'Upcoming (14 days)', value: appts.filter((a) => a.startAt.getTime() > Date.now() && ['booked', 'confirmed'].includes(a.status)).length, format: 'number' },
    { key: 'no_show_rate', label: 'No-show rate', value: attendedOrNo ? r1((noShow / attendedOrNo) * 100) : null, format: 'pct', tone: 'rose', hint: 'No-shows ÷ (completed + checked-in + no-shows)' },
    { key: 'campaign_leads', label: 'Campaign leads', value: campaignLeads, format: 'number', tone: 'violet', hint: 'Meta / Google leads in the period' },
    { key: 'insurance_open', label: 'Open insurance cases', value: open.length, format: 'number', tone: 'amber' },
    { key: 'docs_pending', label: 'Documents pending', value: docsPending, format: 'number', tone: 'amber' },
    { key: 'feedback', label: 'Patient feedback', value: rated.length ? r1(rated.reduce((a, x) => a + n(x.feedbackRating), 0) / rated.length) : null, format: 'number', hint: `Average of ${rated.length} rating(s), 1–5` },
  ];
  const vol = perDay(days, pastAppts.filter((a) => a.status !== 'cancelled').map((a) => ({ at: a.startAt })));
  const charts: Chart[] = [
    { key: 'volume', title: 'Appointments per day', kind: 'line', unit: 'appointments', labels: vol.labels, series: [{ name: 'Appointments', values: vol.values }], source: 'Appointments (not cancelled)', ...(pastAppts.length ? {} : { empty: 'No appointments in this period.' }) },
    bar('departments', 'Appointments by department', 'appointments', top(tally(appts.filter((a) => a.status !== 'cancelled'), (a) => a.department.name)), 'Appointments (past and next 14 days)', 'Appointments'),
    bar('doctors', 'Appointments by doctor', 'appointments', top(tally(appts.filter((a) => a.status !== 'cancelled'), (a) => a.doctor.name)), 'Appointments (past and next 14 days)', 'Appointments'),
    donut('status', 'Appointments by status', tally(pastAppts, (a) => a.status), 'Appointments in the period'),
    { key: 'funnel', title: 'Lead to appointment', kind: 'funnel', unit: 'count', labels: ['Leads', 'Contacted', 'Booked (won)'], series: [{ name: 'Count', values: [leads.length, leads.filter((l) => !['new'].includes(l.status)).length, leads.filter((l) => l.status === 'won').length] }], source: 'Leads created in the period' },
    donut('insurance', 'Insurance cases by status', tally(cases, (c) => c.status), 'All insurance cases'),
    donut('channel', 'Booking channel', tally(appts, (a) => a.channel), 'Appointments (past and next 14 days)'),
  ];
  return { kpis, charts, notes: ['Administrative data only: no clinical information is stored or shown.', 'Insurance statuses are recorded by staff from the insurer / TPA; the assistant never decides them.'] };
}
