import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, can, requirePermission } from '../governance/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { FoodService, type FoodCartLine } from './food/food.service.js';
import { HotelService, type StayRequest } from './hotel/hotel.service.js';
import { HospitalService } from './hospital/hospital.service.js';
import { VerticalFollowUps } from './vertical-followups.service.js';

const actor = (u: SessionClaims) => `user:${u.sub}`;

/** Restaurant & food ordering: menu, quotes, orders and their lifecycle. Organization always from the session. */
@Controller('food')
export class FoodController {
  constructor(
    private readonly food: FoodService,
    private readonly followUps: VerticalFollowUps,
    private readonly conversations: ConversationsService,
  ) {}

  @Get('menu')
  menu(@Org() org: string) {
    return this.food.menu(org);
  }

  @Patch('menu/:id')
  updateItem(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: Parameters<FoodService['updateItem']>[2]) {
    requirePermission(u, PERMISSIONS.manageMenu);
    return this.food.updateItem(org, id, body ?? {});
  }

  /** Authoritative price for a cart (the same function the assistant uses). */
  @Post('quote')
  quote(@Org() org: string, @Body() body: { lines?: FoodCartLine[]; fulfilment?: 'pickup' | 'delivery'; address?: string }) {
    return this.food.quote(org, { lines: body?.lines ?? [], fulfilment: body?.fulfilment, address: body?.fulfilment === 'delivery' ? body?.address ?? '' : undefined });
  }

  @Get('orders')
  orders(@Org() org: string, @Query('status') status?: string, @Query('q') q?: string) {
    return this.food.list(org, { status, q });
  }

  @Get('orders/:id')
  order(@Org() org: string, @Param('id') id: string) {
    return this.food.get(org, id);
  }

  /** Staff phone order: same validation and idempotency as the assistant. */
  @Post('orders')
  async create(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { phone?: string; name?: string; lines?: FoodCartLine[]; fulfilment?: 'pickup' | 'delivery'; address?: string; notes?: string; clientKey?: string }) {
    requirePermission(u, PERMISSIONS.manageFoodOrders);
    if (!body?.phone) throw new BadRequestException('Customer phone is required');
    const c = await this.conversations.getOrCreateCustomerByPhone(org, body.phone, { name: body.name, source: 'phone_order' });
    const r = await this.food.placeOrder(org, { customerId: c.id, channel: 'dashboard', lines: body.lines ?? [], fulfilment: body.fulfilment ?? 'pickup', address: body.address, notes: body.notes, idempotencyKey: `dash:${body.clientKey || randomUUID()}`, customerName: body.name ?? c.name, customerPhone: c.phone, actor: actor(u) });
    return r;
  }

  @Post('orders/:id/status')
  async status(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; note?: string }) {
    requirePermission(u, PERMISSIONS.manageFoodOrders);
    const o = await this.food.setStatus(org, id, String(body?.status ?? ''), actor(u), body?.note);
    await this.followUps.onFoodStatus(org, { id: o.id, customerId: o.customer.id, status: o.status });
    return o;
  }

  @Post('orders/:id/feedback')
  feedback(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { rating?: number; comment?: string }) {
    requirePermission(u, PERMISSIONS.manageFoodOrders);
    return this.food.recordFeedback(org, id, Number(body?.rating), body?.comment ?? null, 'dashboard');
  }
}

/** Hotel & room booking. */
@Controller('hotel')
export class HotelController {
  constructor(
    private readonly hotel: HotelService,
    private readonly followUps: VerticalFollowUps,
    private readonly conversations: ConversationsService,
  ) {}

  @Get('room-types')
  roomTypes(@Org() org: string) {
    return this.hotel.roomTypes(org);
  }

  @Get('availability')
  availability(@Org() org: string, @Query() q: { checkIn?: string; checkOut?: string; adults?: string; children?: string; rooms?: string }) {
    return this.hotel.availability(org, stay(q));
  }

  @Post('quote')
  quote(@Org() org: string, @Body() body: StayRequest & { roomTypeId?: string }) {
    if (!body?.roomTypeId) throw new BadRequestException('roomTypeId is required');
    return this.hotel.quote(org, body.roomTypeId, stay(body));
  }

  @Get('calendar')
  calendar(@Org() org: string, @Query('from') from?: string, @Query('days') days?: string) {
    return this.hotel.calendar(org, from ?? '', Number(days) || 14);
  }

  @Get('today')
  today(@Org() org: string) {
    return this.hotel.today(org);
  }

  @Get('reservations')
  list(@Org() org: string, @Query() q: { status?: string; from?: string; to?: string; q?: string }) {
    return this.hotel.list(org, q);
  }

  @Get('reservations/:id')
  get(@Org() org: string, @Param('id') id: string) {
    return this.hotel.get(org, id);
  }

  /** Front-desk booking (phone / walk-in): confirmed immediately, same availability checks and idempotency. */
  @Post('reservations')
  async create(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: StayRequest & { roomTypeId?: string; phone?: string; name?: string; specialRequests?: string; clientKey?: string }) {
    requirePermission(u, PERMISSIONS.manageBookings);
    if (!body?.phone || !body.roomTypeId) throw new BadRequestException('Guest phone and room type are required');
    const c = await this.conversations.getOrCreateCustomerByPhone(org, body.phone, { name: body.name, source: 'front_desk' });
    const r = await this.hotel.book(org, { ...stay(body), roomTypeId: body.roomTypeId, customerId: c.id, channel: 'dashboard', idempotencyKey: `dash:${body.clientKey || randomUUID()}`, guestName: body.name ?? c.name, guestPhone: c.phone, specialRequests: body.specialRequests, actor: actor(u), confirmNow: true });
    if (r.status === 'created') await this.followUps.onReservation(org, { id: r.reservation.id, customerId: c.id, status: r.reservation.status, checkIn: r.reservation.checkIn, checkOut: r.reservation.checkOut });
    return r;
  }

  @Post('reservations/:id/:action')
  async act(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Param('action') action: string, @Body() body: StayRequest & { reason?: string; roomId?: string; outcome?: string; rating?: number; comment?: string }) {
    requirePermission(u, PERMISSIONS.manageBookings);
    let r;
    if (action === 'confirm') r = await this.hotel.confirm(org, id, actor(u));
    else if (action === 'cancel') r = await this.hotel.cancel(org, id, actor(u), body?.reason);
    else if (action === 'reschedule') r = await this.hotel.reschedule(org, id, stay(body), actor(u));
    else if (action === 'check-in') r = await this.hotel.checkIn(org, id, actor(u), body?.roomId);
    else if (action === 'check-out') r = await this.hotel.checkOut(org, id, actor(u));
    else if (action === 'no-show') r = await this.hotel.noShow(org, id, actor(u));
    else if (action === 'payment') r = await this.hotel.payment(org, id, body?.outcome as never, actor(u));
    else if (action === 'feedback') r = await this.hotel.recordFeedback(org, id, Number(body?.rating), body?.comment ?? null, actor(u));
    else throw new NotFoundException('Unknown action');
    await this.followUps.onReservation(org, { id: r.id, customerId: r.guest.id, status: r.status, checkIn: r.checkIn, checkOut: r.checkOut });
    return r;
  }

  @Patch('rooms/:id')
  room(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; housekeeping?: string; notes?: string }) {
    requirePermission(u, PERMISSIONS.manageBookings);
    return this.hotel.setRoom(org, id, body ?? {});
  }

  @Post('expire-holds')
  expire(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.manageBookings);
    return this.hotel.expireHolds(org);
  }
}

/** Hospital & healthcare administration. */
@Controller('hospital')
export class HospitalController {
  constructor(
    private readonly hospital: HospitalService,
    private readonly followUps: VerticalFollowUps,
    private readonly conversations: ConversationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('directory')
  directory(@Org() org: string) {
    return this.hospital.directory(org);
  }

  @Get('doctors/:id/slots')
  slots(@Org() org: string, @Param('id') id: string, @Query('day') day: string) {
    return this.hospital.slots(org, id, day);
  }

  @Get('slots')
  next(@Org() org: string, @Query() q: { doctorId?: string; departmentId?: string; from?: string; part?: 'morning' | 'afternoon' | 'evening'; limit?: string }) {
    return this.hospital.nextSlots(org, { doctorId: q.doctorId, departmentId: q.departmentId, fromDay: q.from, part: q.part, limit: Number(q.limit) || 6 });
  }

  @Get('appointments')
  list(@Org() org: string, @Query() q: { day?: string; status?: string; doctorId?: string; q?: string }) {
    return this.hospital.list(org, q);
  }

  @Get('appointments/:id')
  get(@Org() org: string, @Param('id') id: string) {
    return this.hospital.get(org, id);
  }

  @Post('appointments')
  async book(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { phone?: string; name?: string; doctorId?: string; startAt?: string; reasonNote?: string; visitType?: string; clientKey?: string }) {
    requirePermission(u, PERMISSIONS.manageClinic);
    if (!body?.phone || !body.doctorId || !body.startAt) throw new BadRequestException('Patient phone, doctor and time are required');
    const c = await this.conversations.getOrCreateCustomerByPhone(org, body.phone, { name: body.name, source: 'front_desk' });
    const r = await this.hospital.book(org, { doctorId: body.doctorId, startAt: body.startAt, customerId: c.id, channel: 'dashboard', idempotencyKey: `dash:${body.clientKey || randomUUID()}`, patientName: body.name ?? c.name, patientPhone: c.phone, reasonNote: body.reasonNote, visitType: body.visitType, actor: actor(u) });
    if (r.status === 'created') await this.followUps.onAppointment(org, { id: r.appointment.id, customerId: c.id, status: r.appointment.status, startAt: new Date(r.appointment.startAt) });
    return r;
  }

  @Post('appointments/:id/status')
  async status(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; note?: string }) {
    requirePermission(u, PERMISSIONS.manageClinic);
    const a = await this.hospital.setStatus(org, id, String(body?.status ?? ''), actor(u), body?.note);
    await this.followUps.onAppointment(org, { id: a.id, customerId: a.patient.id, status: a.status, startAt: new Date(a.startAt) });
    return a;
  }

  @Post('appointments/:id/reschedule')
  async reschedule(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { startAt?: string }) {
    requirePermission(u, PERMISSIONS.manageClinic);
    const a = await this.hospital.reschedule(org, id, String(body?.startAt ?? ''), actor(u));
    await this.followUps.onAppointment(org, { id: a.id, customerId: a.patient.id, status: a.status, startAt: new Date(a.startAt) });
    return a;
  }

  @Get('patients')
  patients(@Org() org: string, @Query('q') q?: string) {
    return this.hospital.patients(org, q);
  }

  @Get('insurance')
  insurance(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: { status?: string; kind?: string; q?: string }) {
    requirePermission(u, PERMISSIONS.viewInsurance);
    return this.hospital.insuranceList(org, q);
  }

  @Get('insurance/:id')
  insuranceOne(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.viewInsurance);
    return this.hospital.insuranceGet(org, id);
  }

  @Post('insurance')
  async insuranceCreate(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: Parameters<HospitalService['insuranceCreate']>[1]) {
    requirePermission(u, PERMISSIONS.manageInsurance);
    const c = await this.hospital.insuranceCreate(org, body, actor(u));
    if (c.status === 'documents_pending') await this.followUps.onInsuranceDocsPending(org, { id: c.id, customerId: c.patient.id });
    return c;
  }

  @Post('insurance/:id/document')
  insuranceDoc(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { doc?: string; received?: boolean }) {
    requirePermission(u, PERMISSIONS.manageInsurance);
    return this.hospital.insuranceDocument(org, id, String(body?.doc ?? ''), body?.received !== false, actor(u));
  }

  @Post('insurance/:id/status')
  async insuranceStatus(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; insurerReference?: string; amountApproved?: number; note?: string }) {
    requirePermission(u, PERMISSIONS.manageInsurance);
    const c = await this.hospital.insuranceTransition(org, id, String(body?.status ?? ''), body ?? {}, actor(u), can(u.role, PERMISSIONS.recordInsuranceDecision));
    await this.followUps.onInsuranceStatus(org, { id: c.id, customerId: c.patient.id, status: c.status });
    return c;
  }
}

function stay(q: { checkIn?: string; checkOut?: string; adults?: string | number; children?: string | number; rooms?: string | number }): StayRequest {
  return { checkIn: String(q.checkIn ?? ''), checkOut: String(q.checkOut ?? ''), adults: Number(q.adults ?? 2), children: Number(q.children ?? 0), rooms: Number(q.rooms ?? 1) };
}
