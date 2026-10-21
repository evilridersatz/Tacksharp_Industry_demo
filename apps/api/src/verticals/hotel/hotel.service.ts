import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { log } from '../../common/logger.js';
import { DEFAULT_SETTINGS, type TenantSettings } from '../../settings/tenant-settings.js';
import { DAY_MS, addDays, dateOnly, daysBetween, isDay, istDay, istInstant, money, n, reference } from '../common.js';

export const RESERVATION_STATUS_LABEL: Record<string, string> = {
  pending_confirmation: 'Pending confirmation',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  expired: 'Expired (hold lapsed)',
};
export const PAYMENT_LABEL: Record<string, string> = {
  not_required: 'No deposit required',
  pending: 'Deposit pending',
  simulated_paid: 'Deposit paid (SIMULATED)',
  simulated_failed: 'Deposit failed (SIMULATED)',
  paid_verified: 'Deposit received (verified by staff)',
};

export type StayRequest = { checkIn: string; checkOut: string; adults: number; children?: number; rooms?: number };
export type NightRate = { date: string; rate: number; source: 'seasonal' | 'weekend' | 'base'; label?: string };
export type HotelQuote = {
  ok: boolean;
  problems: string[];
  roomType: { id: string; code: string; name: string; maxOccupancy: number; maxAdults: number } | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  adults: number;
  children: number;
  breakdown: NightRate[];
  subtotal: number;
  tax: number;
  total: number;
  deposit: number;
  available: number;
};

/** Inventory-holding statuses: a pending reservation holds only until its hold expires. */
const HOLDING = ['pending_confirmation', 'confirmed', 'checked_in'];

/**
 * Hotel & room booking. Rates and availability are computed here from room types, rooms, seasonal rates and
 * reservations only; the assistant and the dashboard both call this service. Bookings run inside a transaction that
 * locks the room type, so two guests can never take the last room at the same time.
 */
@Injectable()
export class HotelService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async cfg(org: string): Promise<TenantSettings['hotel']> {
    return (await this.settings?.get(org))?.hotel ?? DEFAULT_SETTINGS.hotel;
  }

  // ------------------------------------------------------------------ catalogue

  async roomTypes(org: string) {
    const [types, rooms, rates] = await Promise.all([
      this.prisma.roomType.findMany({ where: { organizationId: org }, orderBy: [{ sortOrder: 'asc' }, { baseRate: 'asc' }] }),
      this.prisma.room.findMany({ where: { organizationId: org }, orderBy: { number: 'asc' } }),
      this.prisma.roomRate.findMany({ where: { organizationId: org }, orderBy: { startDate: 'asc' } }),
    ]);
    return types.map((t) => ({
      id: t.id, code: t.code, name: t.name, description: t.description, bedType: t.bedType, sizeSqft: t.sizeSqft,
      maxAdults: t.maxAdults, maxChildren: t.maxChildren, maxOccupancy: t.maxOccupancy, baseRate: n(t.baseRate), weekendRate: t.weekendRate === null ? null : n(t.weekendRate),
      amenities: Array.isArray(t.amenities) ? (t.amenities as string[]) : [], active: t.active, isDemo: t.isDemo,
      rooms: rooms.filter((r) => r.roomTypeId === t.id).map((r) => ({ id: r.id, number: r.number, floor: r.floor, status: r.status, housekeeping: r.housekeeping, notes: r.notes })),
      sellableRooms: rooms.filter((r) => r.roomTypeId === t.id && r.status !== 'out_of_service').length,
      seasonalRates: rates.filter((r) => r.roomTypeId === t.id).map((r) => ({ id: r.id, name: r.name, startDate: r.startDate.toISOString().slice(0, 10), endDate: r.endDate.toISOString().slice(0, 10), rate: n(r.rate) })),
    }));
  }

  /** Per-night rate: a seasonal rate covering the night wins, then the weekend rate (Fri / Sat nights), then the base rate. */
  nightly(t: { baseRate: Prisma.Decimal | number; weekendRate: Prisma.Decimal | number | null }, rates: Array<{ name: string; startDate: Date; endDate: Date; rate: Prisma.Decimal | number }>, checkIn: string, nights: number): NightRate[] {
    const out: NightRate[] = [];
    for (let k = 0; k < nights; k++) {
      const day = addDays(checkIn, k);
      const d = dateOnly(day);
      const seasonal = rates.filter((r) => r.startDate.getTime() <= d.getTime() && d.getTime() <= r.endDate.getTime()).sort((a, b) => b.startDate.getTime() - a.startDate.getTime())[0];
      const dow = d.getUTCDay();
      if (seasonal) out.push({ date: day, rate: n(seasonal.rate), source: 'seasonal', label: seasonal.name });
      else if ((dow === 5 || dow === 6) && t.weekendRate !== null) out.push({ date: day, rate: n(t.weekendRate), source: 'weekend' });
      else out.push({ date: day, rate: n(t.baseRate), source: 'base' });
    }
    return out;
  }

  /** Validation shared by availability, quotes and bookings. Returns problems (customer-facing English). */
  async validateStay(org: string, s: StayRequest, now = new Date()) {
    const cfg = await this.cfg(org);
    const problems: string[] = [];
    const today = istDay(now);
    if (!isDay(s.checkIn) || !isDay(s.checkOut)) problems.push('Please give check-in and check-out dates.');
    else {
      if (s.checkIn < today) problems.push('Check-in cannot be in the past.');
      const nights = daysBetween(s.checkIn, s.checkOut);
      if (nights < 1) problems.push('Check-out must be after check-in.');
      else if (nights > cfg.maxNights) problems.push(`Stays are limited to ${cfg.maxNights} nights online; our team can help with longer stays.`);
      if (daysBetween(today, s.checkIn) > 365) problems.push('Bookings open up to one year ahead.');
    }
    const adults = Math.round(Number(s.adults)), children = Math.round(Number(s.children ?? 0)), rooms = Math.round(Number(s.rooms ?? 1));
    if (!(adults >= 1 && adults <= 30)) problems.push('Please tell us how many adults (1 or more).');
    if (!(children >= 0 && children <= 20)) problems.push('Number of children is not valid.');
    if (!(rooms >= 1 && rooms <= 10)) problems.push('Rooms must be between 1 and 10.');
    return { problems, adults, children, rooms, nights: isDay(s.checkIn) && isDay(s.checkOut) ? daysBetween(s.checkIn, s.checkOut) : 0, cfg };
  }

  /** Rooms of a type booked on each night of [checkIn, checkOut), excluding one reservation (reschedule). */
  private async bookedByNight(db: Prisma.TransactionClient | PrismaService, roomTypeId: string, checkIn: string, checkOut: string, now: Date, exceptId?: string) {
    const rows = await db.reservation.findMany({
      where: {
        roomTypeId, status: { in: HOLDING }, checkIn: { lt: dateOnly(checkOut) }, checkOut: { gt: dateOnly(checkIn) },
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [{ status: { not: 'pending_confirmation' } }, { holdExpiresAt: null }, { holdExpiresAt: { gt: now } }],
      },
      select: { checkIn: true, checkOut: true, rooms: true },
    });
    const nights = daysBetween(checkIn, checkOut);
    const counts = new Array(Math.max(0, nights)).fill(0);
    for (let k = 0; k < nights; k++) {
      const t = dateOnly(addDays(checkIn, k)).getTime();
      for (const r of rows) if (r.checkIn.getTime() <= t && t < r.checkOut.getTime()) counts[k] += r.rooms;
    }
    return counts;
  }

  private async sellable(db: Prisma.TransactionClient | PrismaService, roomTypeId: string) {
    return db.room.count({ where: { roomTypeId, status: { not: 'out_of_service' } } });
  }

  /** Every active room type for a stay: rooms left, whether the party fits, and the server price. */
  async availability(org: string, s: StayRequest, now = new Date()) {
    const v = await this.validateStay(org, s, now);
    const types = await this.prisma.roomType.findMany({ where: { organizationId: org, active: true }, include: { rates: true }, orderBy: [{ sortOrder: 'asc' }, { baseRate: 'asc' }] });
    const results = [];
    for (const t of types) {
      const fit = this.fits(t, v.adults, v.children, v.rooms);
      let available = 0;
      let quote: HotelQuote | null = null;
      if (!v.problems.length) {
        const booked = await this.bookedByNight(this.prisma, t.id, s.checkIn, s.checkOut, now);
        available = Math.max(0, (await this.sellable(this.prisma, t.id)) - Math.max(0, ...booked));
        quote = this.price(t, s.checkIn, v.nights, v.rooms, v.adults, v.children, v.cfg, available, fit ? [] : [fitText(t)]);
      }
      results.push({
        roomTypeId: t.id, code: t.code, name: t.name, maxOccupancy: t.maxOccupancy, maxAdults: t.maxAdults, amenities: Array.isArray(t.amenities) ? (t.amenities as string[]) : [],
        fits: fit, available, bookable: !v.problems.length && fit && available >= v.rooms, quote,
      });
    }
    return { request: { checkIn: s.checkIn, checkOut: s.checkOut, nights: v.nights, adults: v.adults, children: v.children, rooms: v.rooms }, problems: v.problems, roomTypes: results };
  }

  private fits(t: { maxAdults: number; maxOccupancy: number; maxChildren: number }, adults: number, children: number, rooms: number) {
    return adults <= t.maxAdults * rooms && adults + children <= t.maxOccupancy * rooms && children <= t.maxChildren * rooms;
  }

  private price(t: { id: string; code: string; name: string; maxOccupancy: number; maxAdults: number; baseRate: Prisma.Decimal; weekendRate: Prisma.Decimal | null; rates: Array<{ name: string; startDate: Date; endDate: Date; rate: Prisma.Decimal }> }, checkIn: string, nights: number, rooms: number, adults: number, children: number, cfg: TenantSettings['hotel'], available: number, problems: string[]): HotelQuote {
    const breakdown = this.nightly(t, t.rates, checkIn, nights);
    const subtotal = money(breakdown.reduce((s, x) => s + x.rate, 0) * rooms);
    const tax = money((subtotal * cfg.taxPct) / 100);
    const total = money(subtotal + tax);
    const p = [...problems];
    if (available < rooms) p.push(available ? `Only ${available} ${t.name} room(s) left for those dates.` : `${t.name} is sold out for those dates.`);
    return {
      ok: p.length === 0, problems: p, roomType: { id: t.id, code: t.code, name: t.name, maxOccupancy: t.maxOccupancy, maxAdults: t.maxAdults },
      checkIn, checkOut: addDays(checkIn, nights), nights, rooms, adults, children, breakdown, subtotal, tax, total, deposit: money((total * cfg.depositPct) / 100), available,
    };
  }

  /** The authoritative price and availability for one room type. */
  async quote(org: string, roomTypeId: string, s: StayRequest, now = new Date()): Promise<HotelQuote> {
    const v = await this.validateStay(org, s, now);
    const t = await this.prisma.roomType.findFirst({ where: { id: roomTypeId, organizationId: org }, include: { rates: true } });
    if (!t) throw new NotFoundException('Room type not found');
    if (v.problems.length) return { ok: false, problems: v.problems, roomType: null, checkIn: s.checkIn, checkOut: s.checkOut, nights: v.nights, rooms: v.rooms, adults: v.adults, children: v.children, breakdown: [], subtotal: 0, tax: 0, total: 0, deposit: 0, available: 0 };
    if (!t.active) return { ...this.price(t, s.checkIn, v.nights, v.rooms, v.adults, v.children, v.cfg, 0, ['This room type is not available.']) };
    const booked = await this.bookedByNight(this.prisma, t.id, s.checkIn, s.checkOut, now);
    const available = Math.max(0, (await this.sellable(this.prisma, t.id)) - Math.max(0, ...booked));
    return this.price(t, s.checkIn, v.nights, v.rooms, v.adults, v.children, v.cfg, available, this.fits(t, v.adults, v.children, v.rooms) ? [] : [fitText(t)]);
  }

  // ------------------------------------------------------------------ bookings

  /**
   * Book exactly once. The same idempotency key returns the existing reservation (webhook retry, double "yes").
   * Availability and price are re-checked inside a transaction that locks the room type row.
   * `confirmNow` (staff) creates a confirmed booking; otherwise Settings → autoConfirm decides, and a pending booking
   * holds the room until its hold expires.
   */
  async book(org: string, input: StayRequest & {
    roomTypeId: string; customerId: string; leadId?: string | null; channel: string; idempotencyKey: string; guestName?: string | null; guestPhone?: string | null;
    specialRequests?: string | null; actor: string; confirmNow?: boolean; isDemo?: boolean; now?: Date;
  }) {
    const key = String(input.idempotencyKey ?? '').slice(0, 191);
    if (!key) throw new BadRequestException('idempotencyKey is required');
    const dup = await this.prisma.reservation.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org, idempotencyKey: key } } });
    if (dup) return { status: 'duplicate' as const, reservation: await this.get(org, dup.id) };
    const now = input.now ?? new Date();
    const v = await this.validateStay(org, input, now);
    if (v.problems.length) throw new BadRequestException(v.problems.join(' '));
    const confirmed = Boolean(input.confirmNow) || v.cfg.autoConfirm;
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM RoomType WHERE id = ${input.roomTypeId} FOR UPDATE`;
        const t = await tx.roomType.findFirst({ where: { id: input.roomTypeId, organizationId: org, active: true }, include: { rates: true } });
        if (!t) throw new NotFoundException('Room type not found');
        if (!this.fits(t, v.adults, v.children, v.rooms)) throw new BadRequestException(fitText(t));
        const booked = await this.bookedByNight(tx, t.id, input.checkIn, input.checkOut, now);
        const available = (await this.sellable(tx, t.id)) - Math.max(0, ...booked);
        if (available < v.rooms) throw new ConflictException(available > 0 ? `Only ${available} ${t.name} room(s) left for those dates.` : `${t.name} is sold out for those dates.`);
        const q = this.price(t, input.checkIn, v.nights, v.rooms, v.adults, v.children, v.cfg, available, []);
        const r = await tx.reservation.create({
          data: {
            organizationId: org, reference: reference('HB'), customerId: input.customerId, leadId: input.leadId ?? null, roomTypeId: t.id,
            checkIn: dateOnly(input.checkIn), checkOut: dateOnly(input.checkOut), nights: v.nights, rooms: v.rooms, adults: v.adults, children: v.children,
            status: confirmed ? 'confirmed' : 'pending_confirmation', holdExpiresAt: confirmed ? null : new Date(now.getTime() + v.cfg.holdMinutes * 60_000),
            subtotal: q.subtotal, taxAmount: q.tax, total: q.total, rateBreakdown: q.breakdown as never, depositAmount: q.deposit,
            paymentStatus: q.deposit > 0 ? 'pending' : 'not_required', channel: input.channel, guestName: input.guestName ?? null, guestPhone: input.guestPhone ?? null,
            specialRequests: input.specialRequests?.slice(0, 1000) ?? null, idempotencyKey: key, isDemo: input.isDemo ?? false, createdBy: input.actor,
          },
        });
        await tx.auditEvent.create({ data: { organizationId: org, actor: input.actor, entityType: 'reservation', entityId: r.id, action: 'created', data: { status: r.status, total: q.total, channel: input.channel } } });
        return r.id;
      });
      log.info('hotel.reservation_created', { organizationId: org, reservationId: id });
      return { status: 'created' as const, reservation: await this.get(org, id) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.prisma.reservation.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org, idempotencyKey: key } } });
        if (raced) return { status: 'duplicate' as const, reservation: await this.get(org, raced.id) };
      }
      throw e;
    }
  }

  view(r: Prisma.ReservationGetPayload<{ include: { roomType: true; room: true; customer: true } }>, now = new Date()) {
    const holdLapsed = r.status === 'pending_confirmation' && r.holdExpiresAt !== null && r.holdExpiresAt.getTime() <= now.getTime();
    return {
      id: r.id, reference: r.reference, status: holdLapsed ? 'expired' : r.status, statusLabel: RESERVATION_STATUS_LABEL[holdLapsed ? 'expired' : r.status] ?? r.status,
      roomType: { id: r.roomTypeId, name: r.roomType.name, code: r.roomType.code }, room: r.room ? { id: r.room.id, number: r.room.number } : null,
      checkIn: r.checkIn.toISOString().slice(0, 10), checkOut: r.checkOut.toISOString().slice(0, 10), nights: r.nights, rooms: r.rooms, adults: r.adults, children: r.children,
      holdExpiresAt: r.holdExpiresAt?.toISOString() ?? null, subtotal: n(r.subtotal), taxAmount: n(r.taxAmount), total: n(r.total), depositAmount: n(r.depositAmount),
      rateBreakdown: (r.rateBreakdown as NightRate[]) ?? [], paymentStatus: r.paymentStatus, paymentLabel: PAYMENT_LABEL[r.paymentStatus] ?? r.paymentStatus,
      channel: r.channel, guest: { id: r.customerId, name: r.guestName ?? r.customer.name, phone: r.guestPhone ?? r.customer.phone },
      specialRequests: r.specialRequests, cancellationReason: r.cancellationReason, cancelledAt: r.cancelledAt?.toISOString() ?? null,
      checkedInAt: r.checkedInAt?.toISOString() ?? null, checkedOutAt: r.checkedOutAt?.toISOString() ?? null, feedbackRating: r.feedbackRating, feedbackComment: r.feedbackComment,
      isDemo: r.isDemo, createdAt: r.createdAt.toISOString(), next: this.nextActions(holdLapsed ? 'expired' : r.status, r.checkIn, now),
    };
  }

  nextActions(status: string, checkIn: Date, now = new Date()) {
    const today = istDay(now), day = checkIn.toISOString().slice(0, 10);
    const out: string[] = [];
    if (status === 'pending_confirmation') out.push('confirm', 'cancel', 'reschedule');
    if (status === 'confirmed') {
      if (day <= today) out.push('check_in');
      if (day < today) out.push('no_show');
      out.push('cancel', 'reschedule');
    }
    if (status === 'checked_in') out.push('check_out');
    return out;
  }

  async get(org: string, id: string) {
    const r = await this.prisma.reservation.findFirst({ where: { id, organizationId: org }, include: { roomType: true, room: true, customer: true } });
    if (!r) throw new NotFoundException('Reservation not found');
    const events = await this.prisma.auditEvent.findMany({ where: { organizationId: org, entityType: 'reservation', entityId: id }, orderBy: { createdAt: 'asc' } });
    return { ...this.view(r), events: events.map((e) => ({ action: e.action, actor: e.actor, data: e.data, at: e.createdAt.toISOString() })) };
  }

  async byReference(org: string, ref: string) {
    const r = await this.prisma.reservation.findFirst({ where: { organizationId: org, reference: ref.toUpperCase() }, include: { roomType: true, room: true, customer: true } });
    return r ? this.view(r) : null;
  }

  async list(org: string, q: { status?: string; from?: string; to?: string; q?: string; take?: number } = {}) {
    const where: Prisma.ReservationWhereInput = { organizationId: org };
    if (q.status === 'upcoming') where.AND = [{ status: { in: ['pending_confirmation', 'confirmed'] } }, { checkIn: { gte: dateOnly(istDay(new Date())) } }];
    else if (q.status === 'in_house') where.status = 'checked_in';
    else if (q.status && RESERVATION_STATUS_LABEL[q.status]) where.status = q.status;
    if (isDay(q.from)) where.checkOut = { gt: dateOnly(q.from) };
    if (isDay(q.to)) where.checkIn = { lt: dateOnly(q.to) };
    if (q.q?.trim()) where.OR = [{ reference: { contains: q.q.trim() } }, { guestName: { contains: q.q.trim() } }, { guestPhone: { contains: q.q.replace(/\D/g, '') || '§' } }];
    const rows = await this.prisma.reservation.findMany({ where, include: { roomType: true, room: true, customer: true }, orderBy: { checkIn: 'asc' }, take: Math.min(q.take ?? 150, 500) });
    return rows.map((r) => this.view(r));
  }

  async customerReservations(org: string, customerId: string) {
    const rows = await this.prisma.reservation.findMany({ where: { organizationId: org, customerId }, include: { roomType: true, room: true, customer: true }, orderBy: { createdAt: 'desc' }, take: 5 });
    return rows.map((r) => this.view(r));
  }

  private async audit(org: string, id: string, action: string, actor: string, data: Record<string, unknown> = {}) {
    await this.prisma.auditEvent.create({ data: { organizationId: org, actor, entityType: 'reservation', entityId: id, action, data: data as never } });
  }

  private async load(org: string, id: string) {
    const r = await this.prisma.reservation.findFirst({ where: { id, organizationId: org } });
    if (!r) throw new NotFoundException('Reservation not found');
    return r;
  }

  /** Staff confirm a pending reservation. A lapsed hold is re-checked against availability first. */
  async confirm(org: string, id: string, actor: string, now = new Date()) {
    const r = await this.load(org, id);
    if (r.status !== 'pending_confirmation') throw new BadRequestException(`Only a pending reservation can be confirmed (this one is ${RESERVATION_STATUS_LABEL[r.status] ?? r.status}).`);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM RoomType WHERE id = ${r.roomTypeId} FOR UPDATE`;
      if (r.holdExpiresAt && r.holdExpiresAt <= now) {
        const ci = r.checkIn.toISOString().slice(0, 10), co = r.checkOut.toISOString().slice(0, 10);
        const booked = await this.bookedByNight(tx, r.roomTypeId, ci, co, now, r.id);
        if ((await this.sellable(tx, r.roomTypeId)) - Math.max(0, ...booked) < r.rooms) throw new ConflictException('The hold lapsed and the room is no longer available for those dates.');
      }
      const u = await tx.reservation.updateMany({ where: { id, status: 'pending_confirmation' }, data: { status: 'confirmed', holdExpiresAt: null } });
      if (!u.count) throw new ConflictException('The reservation changed meanwhile.');
    });
    await this.audit(org, id, 'confirmed', actor);
    return this.get(org, id);
  }

  /** Cancel. Within the free-cancellation window nothing is charged; otherwise the policy note is recorded (no payment integration). */
  async cancel(org: string, id: string, actor: string, reason?: string, now = new Date()) {
    const r = await this.load(org, id);
    if (!['pending_confirmation', 'confirmed'].includes(r.status)) throw new BadRequestException(`A ${RESERVATION_STATUS_LABEL[r.status] ?? r.status} reservation cannot be cancelled.`);
    const cfg = await this.cfg(org);
    const hoursBefore = (istInstant(r.checkIn.toISOString().slice(0, 10), cfg.checkInTime).getTime() - now.getTime()) / 3600_000;
    const free = hoursBefore >= cfg.freeCancellationHours || r.status === 'pending_confirmation';
    const note = free ? 'Free cancellation.' : `Cancelled inside ${cfg.freeCancellationHours} h of check-in: ${cfg.cancellationPolicy}`;
    const u = await this.prisma.reservation.updateMany({ where: { id, status: r.status }, data: { status: 'cancelled', cancelledAt: now, cancellationReason: `${reason ? `${reason.slice(0, 300)} — ` : ''}${note}`, holdExpiresAt: null } });
    if (!u.count) throw new ConflictException('The reservation changed meanwhile.');
    await this.audit(org, id, 'cancelled', actor, { free, reason: reason ?? null });
    return { ...(await this.get(org, id)), freeCancellation: free, policyNote: note };
  }

  /** Change dates (and optionally guests) with a fresh availability check and price; same reference. */
  async reschedule(org: string, id: string, s: StayRequest, actor: string, now = new Date()) {
    const r = await this.load(org, id);
    if (!['pending_confirmation', 'confirmed'].includes(r.status)) throw new BadRequestException('Only an upcoming reservation can be changed.');
    const v = await this.validateStay(org, { ...s, adults: s.adults ?? r.adults, children: s.children ?? r.children, rooms: s.rooms ?? r.rooms }, now);
    if (v.problems.length) throw new BadRequestException(v.problems.join(' '));
    const before = { checkIn: r.checkIn.toISOString().slice(0, 10), checkOut: r.checkOut.toISOString().slice(0, 10), total: n(r.total) };
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM RoomType WHERE id = ${r.roomTypeId} FOR UPDATE`;
      const t = await tx.roomType.findUniqueOrThrow({ where: { id: r.roomTypeId }, include: { rates: true } });
      if (!this.fits(t, v.adults, v.children, v.rooms)) throw new BadRequestException(fitText(t));
      const booked = await this.bookedByNight(tx, t.id, s.checkIn, s.checkOut, now, r.id);
      const available = (await this.sellable(tx, t.id)) - Math.max(0, ...booked);
      if (available < v.rooms) throw new ConflictException(`${t.name} is not available for the new dates.`);
      const q = this.price(t, s.checkIn, v.nights, v.rooms, v.adults, v.children, v.cfg, available, []);
      await tx.reservation.update({
        where: { id },
        data: { checkIn: dateOnly(s.checkIn), checkOut: dateOnly(s.checkOut), nights: v.nights, rooms: v.rooms, adults: v.adults, children: v.children, subtotal: q.subtotal, taxAmount: q.tax, total: q.total, rateBreakdown: q.breakdown as never, depositAmount: q.deposit, ...(r.status === 'pending_confirmation' ? { holdExpiresAt: new Date(now.getTime() + v.cfg.holdMinutes * 60_000) } : {}) },
      });
    });
    await this.audit(org, id, 'rescheduled', actor, { before, after: { checkIn: s.checkIn, checkOut: s.checkOut } });
    return this.get(org, id);
  }

  /** Check-in: on or after the check-in day; assigns a clean available room of the type. */
  async checkIn(org: string, id: string, actor: string, roomId?: string, now = new Date()) {
    const r = await this.load(org, id);
    if (r.status !== 'confirmed') throw new BadRequestException('Only a confirmed reservation can be checked in.');
    if (r.checkIn.toISOString().slice(0, 10) > istDay(now)) throw new BadRequestException('Check-in opens on the arrival date.');
    const room = roomId
      ? await this.prisma.room.findFirst({ where: { id: roomId, organizationId: org, roomTypeId: r.roomTypeId, status: 'available' } })
      : await this.prisma.room.findFirst({ where: { organizationId: org, roomTypeId: r.roomTypeId, status: 'available', housekeeping: 'clean' }, orderBy: { number: 'asc' } });
    if (!room) throw new ConflictException('No clean available room of this type right now. Ask housekeeping or choose a room.');
    await this.prisma.$transaction([
      this.prisma.reservation.update({ where: { id }, data: { status: 'checked_in', checkedInAt: now, roomId: room.id } }),
      this.prisma.room.update({ where: { id: room.id }, data: { status: 'occupied' } }),
    ]);
    await this.audit(org, id, 'checked_in', actor, { room: room.number });
    return this.get(org, id);
  }

  async checkOut(org: string, id: string, actor: string, now = new Date()) {
    const r = await this.load(org, id);
    if (r.status !== 'checked_in') throw new BadRequestException('Only a checked-in guest can be checked out.');
    await this.prisma.$transaction([
      this.prisma.reservation.update({ where: { id }, data: { status: 'checked_out', checkedOutAt: now } }),
      ...(r.roomId ? [this.prisma.room.update({ where: { id: r.roomId }, data: { status: 'available', housekeeping: 'dirty' } })] : []),
    ]);
    await this.audit(org, id, 'checked_out', actor);
    return this.get(org, id);
  }

  async noShow(org: string, id: string, actor: string, now = new Date()) {
    const r = await this.load(org, id);
    if (r.status !== 'confirmed' || r.checkIn.toISOString().slice(0, 10) >= istDay(now)) throw new BadRequestException('No-show can be recorded only after the arrival date for a confirmed reservation.');
    await this.prisma.reservation.update({ where: { id }, data: { status: 'no_show' } });
    await this.audit(org, id, 'no_show', actor);
    return this.get(org, id);
  }

  /**
   * There is no payment integration. In DRY_RUN / demo workspaces the deposit outcome can be SIMULATED (clearly
   * labelled); otherwise staff record a deposit they verified themselves.
   */
  async payment(org: string, id: string, outcome: 'simulated_paid' | 'simulated_failed' | 'paid_verified', actor: string) {
    const r = await this.load(org, id);
    if (r.paymentStatus === 'not_required') throw new BadRequestException('No deposit is required for this reservation.');
    if (outcome !== 'paid_verified') {
      const org_ = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } });
      if (process.env.DRY_RUN === 'false' && !org_?.isDemo) throw new BadRequestException('Simulated payments are allowed only in DRY_RUN or a demo workspace.');
    }
    await this.prisma.reservation.update({ where: { id }, data: { paymentStatus: outcome } });
    await this.audit(org, id, 'payment', actor, { outcome, simulated: outcome !== 'paid_verified' });
    return this.get(org, id);
  }

  /** Pending reservations whose hold lapsed become expired (frees the inventory explicitly; idempotent). */
  async expireHolds(org: string, now = new Date()) {
    const r = await this.prisma.reservation.updateMany({ where: { organizationId: org, status: 'pending_confirmation', holdExpiresAt: { lte: now } }, data: { status: 'expired' } });
    return { expired: r.count };
  }

  async recordFeedback(org: string, id: string, rating: number, comment: string | null, actor: string) {
    const v = Math.round(Number(rating));
    if (!(v >= 1 && v <= 5)) throw new BadRequestException('Rating must be 1-5.');
    const r = await this.load(org, id);
    if (r.status !== 'checked_out') throw new BadRequestException('Feedback is collected after check-out.');
    await this.prisma.reservation.update({ where: { id }, data: { feedbackRating: v, feedbackComment: comment?.slice(0, 1000) ?? null } });
    await this.audit(org, id, 'feedback', actor, { rating: v });
    return this.get(org, id);
  }

  /** Availability calendar: per room type and night, sellable / booked / available. */
  async calendar(org: string, from: string, days = 14, now = new Date()) {
    const start = isDay(from) ? from : istDay(now);
    const d = Math.min(31, Math.max(1, Math.round(days)));
    const end = addDays(start, d);
    const types = await this.prisma.roomType.findMany({ where: { organizationId: org, active: true }, orderBy: [{ sortOrder: 'asc' }, { baseRate: 'asc' }], include: { rates: true } });
    const out = [];
    for (const t of types) {
      const sellable = await this.sellable(this.prisma, t.id);
      const booked = await this.bookedByNight(this.prisma, t.id, start, end, now);
      const rates = this.nightly(t, t.rates, start, d);
      out.push({ roomTypeId: t.id, name: t.name, code: t.code, sellable, nights: booked.map((b, k) => ({ date: addDays(start, k), booked: b, available: Math.max(0, sellable - b), rate: rates[k].rate, rateSource: rates[k].source })) });
    }
    return { from: start, days: d, roomTypes: out };
  }

  async setRoom(org: string, id: string, patch: { status?: string; housekeeping?: string; notes?: string | null }) {
    const room = await this.prisma.room.findFirst({ where: { id, organizationId: org } });
    if (!room) throw new NotFoundException('Room not found');
    const data: Prisma.RoomUpdateInput = {};
    if (patch.status !== undefined) {
      if (!['available', 'occupied', 'out_of_service'].includes(patch.status)) throw new BadRequestException('Unknown room status');
      if (patch.status === 'out_of_service' && room.status === 'occupied') throw new BadRequestException('An occupied room cannot be taken out of service.');
      data.status = patch.status;
    }
    if (patch.housekeeping !== undefined) {
      if (!['clean', 'dirty', 'inspecting'].includes(patch.housekeeping)) throw new BadRequestException('Unknown housekeeping status');
      data.housekeeping = patch.housekeeping;
    }
    if (patch.notes !== undefined) data.notes = patch.notes?.slice(0, 500) ?? null;
    await this.prisma.room.update({ where: { id }, data });
    return this.prisma.room.findUnique({ where: { id } });
  }

  /** Arrivals / departures / in-house for one day (front desk). */
  async today(org: string, now = new Date()) {
    const day = dateOnly(istDay(now));
    const include = { roomType: true, room: true, customer: true } as const;
    const [arrivals, departures, inHouse] = await Promise.all([
      this.prisma.reservation.findMany({ where: { organizationId: org, checkIn: day, status: { in: ['confirmed', 'pending_confirmation', 'checked_in'] } }, include }),
      this.prisma.reservation.findMany({ where: { organizationId: org, checkOut: day, status: { in: ['checked_in', 'checked_out'] } }, include }),
      this.prisma.reservation.findMany({ where: { organizationId: org, status: 'checked_in' }, include }),
    ]);
    return { date: istDay(now), arrivals: arrivals.map((r) => this.view(r, now)), departures: departures.map((r) => this.view(r, now)), inHouse: inHouse.map((r) => this.view(r, now)) };
  }
}

function fitText(t: { name: string; maxAdults: number; maxOccupancy: number }) {
  return `${t.name} fits up to ${t.maxAdults} adults / ${t.maxOccupancy} guests per room; please add a room or choose a larger room type.`;
}

export { DAY_MS };
