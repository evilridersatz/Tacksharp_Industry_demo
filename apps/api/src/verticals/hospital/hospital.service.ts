import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { log } from '../../common/logger.js';
import { DEFAULT_SETTINGS, type TenantSettings } from '../../settings/tenant-settings.js';
import { addDays, dateOnly, isDay, istDay, istInstant, istTime, money, n, prettyDay, prettyTime, reference } from '../common.js';

export const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Consultation done',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};
const ACTIVE = ['booked', 'confirmed', 'checked_in'];
const APPT_NEXT: Record<string, string[]> = {
  booked: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export const INSURANCE_KIND_LABEL: Record<string, string> = {
  eligibility: 'Eligibility check',
  pre_authorisation: 'Pre-authorisation',
  claim: 'Cashless claim',
  reimbursement: 'Reimbursement claim',
};
export const INSURANCE_STATUS_LABEL: Record<string, string> = {
  documents_pending: 'Documents pending',
  ready_to_submit: 'Ready to submit',
  submitted: 'Submitted to insurer / TPA',
  query_raised: 'Query raised by insurer',
  approved: 'Approved by insurer',
  partially_approved: 'Partially approved by insurer',
  rejected: 'Rejected by insurer',
  settled: 'Settled',
  closed: 'Closed',
};
/** Statuses that record the INSURER's decision: only staff with insurance.record_decision, with the insurer's reference. */
export const INSURER_DECISIONS = ['approved', 'partially_approved', 'rejected', 'settled'];
const INS_NEXT: Record<string, string[]> = {
  documents_pending: ['ready_to_submit', 'closed'],
  ready_to_submit: ['submitted', 'documents_pending', 'closed'],
  submitted: ['query_raised', 'approved', 'partially_approved', 'rejected'],
  query_raised: ['submitted', 'documents_pending', 'closed'],
  approved: ['settled', 'closed'],
  partially_approved: ['settled', 'closed'],
  rejected: ['closed'],
  settled: ['closed'],
  closed: [],
};

export type ScheduleBlock = { day: number; start: string; end: string };
const schedule = (raw: unknown): ScheduleBlock[] =>
  (Array.isArray(raw) ? raw : []).map((b) => b as ScheduleBlock).filter((b) => Number.isInteger(b?.day) && /^\d\d:\d\d$/.test(b?.start) && /^\d\d:\d\d$/.test(b?.end) && b.start < b.end);
const docs = (raw: unknown): string[] => (Array.isArray(raw) ? raw.map((d) => String(d).trim()).filter(Boolean) : []);

/**
 * Hospital & healthcare administration: departments, doctors' OPD hours, appointment slots and bookings, and insurance
 * case tracking. Nothing here diagnoses, prescribes or decides insurance: insurer decisions are recorded by staff.
 */
@Injectable()
export class HospitalService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async cfg(org: string): Promise<TenantSettings['hospital']> {
    return (await this.settings?.get(org))?.hospital ?? DEFAULT_SETTINGS.hospital;
  }

  async directory(org: string) {
    const [departments, doctors] = await Promise.all([
      this.prisma.department.findMany({ where: { organizationId: org }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.doctor.findMany({ where: { organizationId: org }, orderBy: { name: 'asc' } }),
    ]);
    return departments.map((d) => ({
      id: d.id, name: d.name, description: d.description, active: d.active,
      doctors: doctors.filter((x) => x.departmentId === d.id).map((x) => this.doctorView(x, d.name)),
    }));
  }

  doctorView(x: Prisma.DoctorGetPayload<object>, department?: string) {
    return {
      id: x.id, name: x.name, departmentId: x.departmentId, department: department ?? null, qualification: x.qualification, specialty: x.specialty, languages: x.languages,
      consultationFee: n(x.consultationFee), slotMinutes: x.slotMinutes, schedule: schedule(x.schedule), leaveDates: docs(x.leaveDates), active: x.active, isDemo: x.isDemo,
    };
  }

  /** Free slots for one doctor on one IST day (past slots and booked slots removed). */
  async slots(org: string, doctorId: string, day: string, now = new Date()) {
    const d = await this.prisma.doctor.findFirst({ where: { id: doctorId, organizationId: org } });
    if (!d) throw new NotFoundException('Doctor not found');
    return this.freeSlots(this.prisma, d, day, now);
  }

  private async freeSlots(db: Prisma.TransactionClient | PrismaService, d: Prisma.DoctorGetPayload<object>, day: string, now: Date) {
    if (!isDay(day) || !d.active || docs(d.leaveDates).includes(day)) return [];
    const dow = dateOnly(day).getUTCDay();
    const blocks = schedule(d.schedule).filter((b) => b.day === dow);
    if (!blocks.length) return [];
    const taken = await db.appointment.findMany({
      where: { doctorId: d.id, status: { in: ACTIVE }, startAt: { gte: istInstant(day, '00:00'), lt: istInstant(addDays(day, 1), '00:00') } },
      select: { startAt: true, endAt: true },
    });
    const earliest = now.getTime() + 30 * 60_000;
    const out: Array<{ startAt: string; endAt: string; time: string; label: string }> = [];
    for (const b of blocks) {
      for (let t = istInstant(day, b.start).getTime(); t + d.slotMinutes * 60_000 <= istInstant(day, b.end).getTime(); t += d.slotMinutes * 60_000) {
        const end = t + d.slotMinutes * 60_000;
        if (t < earliest) continue;
        if (taken.some((a) => a.startAt.getTime() < end && t < a.endAt.getTime())) continue;
        out.push({ startAt: new Date(t).toISOString(), endAt: new Date(end).toISOString(), time: istTime(new Date(t)), label: `${prettyDay(day)}, ${prettyTime(new Date(t))}` });
      }
    }
    return out;
  }

  /** Earliest free slots for a doctor (or any doctor of a department) within the booking window. */
  async nextSlots(org: string, q: { doctorId?: string; departmentId?: string; fromDay?: string; part?: 'morning' | 'afternoon' | 'evening'; limit?: number }, now = new Date()) {
    const cfg = await this.cfg(org);
    const doctors = await this.prisma.doctor.findMany({ where: { organizationId: org, active: true, ...(q.doctorId ? { id: q.doctorId } : {}), ...(q.departmentId ? { departmentId: q.departmentId } : {}) }, orderBy: { name: 'asc' } });
    const start = isDay(q.fromDay) && q.fromDay >= istDay(now) ? q.fromDay : istDay(now);
    const out: Array<{ doctorId: string; doctor: string; startAt: string; time: string; label: string; day: string }> = [];
    const limit = Math.min(10, q.limit ?? 3);
    for (let k = 0; k < cfg.bookingWindowDays && out.length < limit; k++) {
      const day = addDays(start, k);
      if (day > addDays(istDay(now), cfg.bookingWindowDays)) break;
      for (const d of doctors) {
        for (const s of await this.freeSlots(this.prisma, d, day, now)) {
          const h = Number(s.time.slice(0, 2));
          if (q.part === 'morning' && h >= 12) continue;
          if (q.part === 'afternoon' && (h < 12 || h >= 16)) continue;
          if (q.part === 'evening' && h < 16) continue;
          out.push({ doctorId: d.id, doctor: d.name, startAt: s.startAt, time: s.time, label: s.label, day });
          if (out.filter((o) => o.doctorId === d.id && o.day === day).length >= 2) break;
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
    }
    return out.slice(0, limit);
  }

  /**
   * Book exactly once (idempotency key). Inside a transaction that locks the doctor row: the slot must be on the
   * doctor's OPD grid, in the future, inside the booking window and still free; the patient may not hold another
   * active appointment with the same doctor on the same day.
   */
  async book(org: string, input: {
    doctorId: string; startAt: string; customerId: string; leadId?: string | null; channel: string; idempotencyKey: string; patientName?: string | null;
    patientPhone?: string | null; reasonNote?: string | null; visitType?: string; actor: string; isDemo?: boolean; now?: Date;
  }) {
    const key = String(input.idempotencyKey ?? '').slice(0, 191);
    if (!key) throw new BadRequestException('idempotencyKey is required');
    const dup = await this.prisma.appointment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org, idempotencyKey: key } } });
    if (dup) return { status: 'duplicate' as const, appointment: await this.get(org, dup.id) };
    const now = input.now ?? new Date();
    const cfg = await this.cfg(org);
    const start = new Date(input.startAt);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Choose an appointment time.');
    const day = istDay(start);
    if (day > addDays(istDay(now), cfg.bookingWindowDays)) throw new BadRequestException(`Appointments open ${cfg.bookingWindowDays} days ahead.`);
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM Doctor WHERE id = ${input.doctorId} FOR UPDATE`;
        const d = await tx.doctor.findFirst({ where: { id: input.doctorId, organizationId: org } });
        if (!d || !d.active) throw new NotFoundException('Doctor not available');
        const free = await this.freeSlots(tx, d, day, now);
        const slot = free.find((s) => s.startAt === start.toISOString());
        if (!slot) throw new ConflictException('That slot is no longer available. Please pick another time.');
        const same = await tx.appointment.findFirst({ where: { doctorId: d.id, customerId: input.customerId, status: { in: ACTIVE }, startAt: { gte: istInstant(day, '00:00'), lt: istInstant(addDays(day, 1), '00:00') } } });
        if (same) throw new ConflictException(`You already have an appointment with ${d.name} that day (${same.reference}).`);
        const a = await tx.appointment.create({
          data: {
            organizationId: org, reference: reference('AP'), customerId: input.customerId, leadId: input.leadId ?? null, doctorId: d.id, departmentId: d.departmentId,
            startAt: start, endAt: new Date(slot.endAt), status: 'booked', visitType: input.visitType === 'follow_up' ? 'follow_up' : 'new',
            reasonNote: input.reasonNote?.slice(0, 500) ?? null, channel: input.channel, patientName: input.patientName ?? null, patientPhone: input.patientPhone ?? null,
            idempotencyKey: key, isDemo: input.isDemo ?? false, createdBy: input.actor,
          },
        });
        await tx.auditEvent.create({ data: { organizationId: org, actor: input.actor, entityType: 'appointment', entityId: a.id, action: 'booked', data: { startAt: a.startAt.toISOString(), doctor: d.name, channel: input.channel } } });
        return a.id;
      });
      log.info('hospital.appointment_booked', { organizationId: org, appointmentId: id });
      return { status: 'created' as const, appointment: await this.get(org, id) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.prisma.appointment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org, idempotencyKey: key } } });
        if (raced) return { status: 'duplicate' as const, appointment: await this.get(org, raced.id) };
      }
      throw e;
    }
  }

  view(a: Prisma.AppointmentGetPayload<{ include: { doctor: true; department: true; customer: true } }>) {
    return {
      id: a.id, reference: a.reference, status: a.status, statusLabel: APPOINTMENT_STATUS_LABEL[a.status] ?? a.status, next: APPT_NEXT[a.status] ?? [],
      startAt: a.startAt.toISOString(), endAt: a.endAt.toISOString(), day: istDay(a.startAt), time: istTime(a.startAt), label: `${prettyDay(istDay(a.startAt))}, ${prettyTime(a.startAt)}`,
      doctor: { id: a.doctorId, name: a.doctor.name, fee: n(a.doctor.consultationFee) }, department: { id: a.departmentId, name: a.department.name },
      patient: { id: a.customerId, name: a.patientName ?? a.customer.name, phone: a.patientPhone ?? a.customer.phone },
      visitType: a.visitType, reasonNote: a.reasonNote, channel: a.channel, cancellationReason: a.cancellationReason, feedbackRating: a.feedbackRating, feedbackComment: a.feedbackComment,
      isDemo: a.isDemo, createdAt: a.createdAt.toISOString(),
    };
  }

  async get(org: string, id: string) {
    const a = await this.prisma.appointment.findFirst({ where: { id, organizationId: org }, include: { doctor: true, department: true, customer: true } });
    if (!a) throw new NotFoundException('Appointment not found');
    const events = await this.prisma.auditEvent.findMany({ where: { organizationId: org, entityType: 'appointment', entityId: id }, orderBy: { createdAt: 'asc' } });
    return { ...this.view(a), events: events.map((e) => ({ action: e.action, actor: e.actor, data: e.data, at: e.createdAt.toISOString() })) };
  }

  async byReference(org: string, ref: string) {
    const a = await this.prisma.appointment.findFirst({ where: { organizationId: org, reference: ref.toUpperCase() }, include: { doctor: true, department: true, customer: true } });
    return a ? this.view(a) : null;
  }

  async list(org: string, q: { day?: string; status?: string; doctorId?: string; q?: string; take?: number } = {}) {
    const where: Prisma.AppointmentWhereInput = { organizationId: org };
    if (isDay(q.day)) where.startAt = { gte: istInstant(q.day, '00:00'), lt: istInstant(addDays(q.day, 1), '00:00') };
    if (q.status === 'upcoming') {
      where.status = { in: ['booked', 'confirmed'] };
      where.startAt = { gte: new Date() };
    } else if (q.status && APPOINTMENT_STATUS_LABEL[q.status]) where.status = q.status;
    if (q.doctorId) where.doctorId = q.doctorId;
    if (q.q?.trim()) where.OR = [{ reference: { contains: q.q.trim() } }, { patientName: { contains: q.q.trim() } }, { patientPhone: { contains: q.q.replace(/\D/g, '') || '§' } }];
    const rows = await this.prisma.appointment.findMany({ where, include: { doctor: true, department: true, customer: true }, // A day / upcoming: in clinic order. "All": the most recent first, so a long history never hides today's visits.
      orderBy: { startAt: q.status === 'upcoming' || isDay(q.day) ? 'asc' : 'desc' }, take: Math.min(q.take ?? 200, 500) });
    return rows.map((a) => this.view(a));
  }

  async customerAppointments(org: string, customerId: string) {
    const rows = await this.prisma.appointment.findMany({ where: { organizationId: org, customerId }, include: { doctor: true, department: true, customer: true }, orderBy: { startAt: 'desc' }, take: 5 });
    return rows.map((a) => this.view(a));
  }

  private async audit(org: string, entityType: string, id: string, action: string, actor: string, data: Record<string, unknown> = {}) {
    await this.prisma.auditEvent.create({ data: { organizationId: org, actor, entityType, entityId: id, action, data: data as never } });
  }

  /** Front desk / system moves an appointment along (confirm, check-in, done, cancel, no-show). */
  async setStatus(org: string, id: string, to: string, actor: string, note?: string, now = new Date()) {
    const a = await this.prisma.appointment.findFirst({ where: { id, organizationId: org } });
    if (!a) throw new NotFoundException('Appointment not found');
    if (!(APPT_NEXT[a.status] ?? []).includes(to)) throw new BadRequestException(`Cannot move an appointment from "${APPOINTMENT_STATUS_LABEL[a.status]}" to "${APPOINTMENT_STATUS_LABEL[to] ?? to}".`);
    if (to === 'no_show' && a.startAt.getTime() > now.getTime()) throw new BadRequestException('No-show can be recorded only after the appointment time.');
    if (to === 'checked_in' && istDay(a.startAt) !== istDay(now)) throw new BadRequestException('Check-in is on the appointment day.');
    const u = await this.prisma.appointment.updateMany({ where: { id, status: a.status }, data: { status: to, ...(to === 'cancelled' ? { cancellationReason: note?.slice(0, 500) ?? 'Cancelled' } : {}) } });
    if (!u.count) throw new ConflictException('The appointment changed meanwhile.');
    await this.audit(org, 'appointment', id, to, actor, note ? { note } : {});
    return this.get(org, id);
  }

  /** Move to another free slot (same reference), re-validated like a new booking. */
  async reschedule(org: string, id: string, startAt: string, actor: string, now = new Date()) {
    const a = await this.prisma.appointment.findFirst({ where: { id, organizationId: org } });
    if (!a) throw new NotFoundException('Appointment not found');
    if (!['booked', 'confirmed'].includes(a.status)) throw new BadRequestException('Only an upcoming appointment can be rescheduled.');
    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Choose a new time.');
    const cfg = await this.cfg(org);
    if (istDay(start) > addDays(istDay(now), cfg.bookingWindowDays)) throw new BadRequestException(`Appointments open ${cfg.bookingWindowDays} days ahead.`);
    const before = a.startAt.toISOString();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Doctor WHERE id = ${a.doctorId} FOR UPDATE`;
      const d = await tx.doctor.findUniqueOrThrow({ where: { id: a.doctorId } });
      // Free the current slot for the check (this appointment is moving out of it).
      const free = (await this.freeSlots(tx, d, istDay(start), now)).concat(istDay(start) === istDay(a.startAt) ? [{ startAt: a.startAt.toISOString(), endAt: a.endAt.toISOString(), time: '', label: '' }] : []);
      const slot = free.find((s) => s.startAt === start.toISOString());
      if (!slot) throw new ConflictException('That slot is not available.');
      await tx.appointment.update({ where: { id }, data: { startAt: start, endAt: new Date(start.getTime() + d.slotMinutes * 60_000), status: 'booked' } });
    });
    await this.audit(org, 'appointment', id, 'rescheduled', actor, { before, after: start.toISOString() });
    return this.get(org, id);
  }

  async recordFeedback(org: string, id: string, rating: number, comment: string | null, actor: string) {
    const v = Math.round(Number(rating));
    if (!(v >= 1 && v <= 5)) throw new BadRequestException('Rating must be 1-5.');
    const a = await this.prisma.appointment.findFirst({ where: { id, organizationId: org } });
    if (!a) throw new NotFoundException('Appointment not found');
    if (a.status !== 'completed') throw new BadRequestException('Feedback is collected after the consultation.');
    await this.prisma.appointment.update({ where: { id }, data: { feedbackRating: v, feedbackComment: comment?.slice(0, 1000) ?? null } });
    await this.audit(org, 'appointment', id, 'feedback', actor, { rating: v, complaint: v <= 2 });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ insurance (administration only)

  insuranceView(c: Prisma.InsuranceCaseGetPayload<{ include: { customer: true } }>) {
    const required = docs(c.requiredDocs), received = docs(c.receivedDocs);
    return {
      id: c.id, reference: c.reference, kind: c.kind, kindLabel: INSURANCE_KIND_LABEL[c.kind] ?? c.kind, insurer: c.insurer, tpa: c.tpa, policyRef: c.policyRef,
      status: c.status, statusLabel: INSURANCE_STATUS_LABEL[c.status] ?? c.status, next: INS_NEXT[c.status] ?? [],
      requiredDocs: required, receivedDocs: received, missingDocs: required.filter((d) => !received.includes(d)),
      amountRequested: c.amountRequested === null ? null : n(c.amountRequested), amountApproved: c.amountApproved === null ? null : n(c.amountApproved),
      insurerReference: c.insurerReference, decisionNote: c.decisionNote, decidedBy: c.decidedBy, appointmentId: c.appointmentId,
      patient: { id: c.customerId, name: c.customer.name, phone: c.customer.phone }, lastFollowUpAt: c.lastFollowUpAt?.toISOString() ?? null,
      isDemo: c.isDemo, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
    };
  }

  async insuranceList(org: string, q: { status?: string; kind?: string; q?: string } = {}) {
    const where: Prisma.InsuranceCaseWhereInput = { organizationId: org };
    if (q.status === 'open') where.status = { notIn: ['settled', 'closed', 'rejected'] };
    else if (q.status && INSURANCE_STATUS_LABEL[q.status]) where.status = q.status;
    if (q.kind && INSURANCE_KIND_LABEL[q.kind]) where.kind = q.kind;
    if (q.q?.trim()) where.OR = [{ reference: { contains: q.q.trim() } }, { insurer: { contains: q.q.trim() } }, { customer: { name: { contains: q.q.trim() } } }];
    const rows = await this.prisma.insuranceCase.findMany({ where, include: { customer: true }, orderBy: { updatedAt: 'desc' }, take: 300 });
    return rows.map((c) => this.insuranceView(c));
  }

  async insuranceGet(org: string, id: string) {
    const c = await this.prisma.insuranceCase.findFirst({ where: { id, organizationId: org }, include: { customer: true } });
    if (!c) throw new NotFoundException('Insurance case not found');
    const events = await this.prisma.auditEvent.findMany({ where: { organizationId: org, entityType: 'insurance_case', entityId: id }, orderBy: { createdAt: 'asc' } });
    return { ...this.insuranceView(c), events: events.map((e) => ({ action: e.action, actor: e.actor, data: e.data, at: e.createdAt.toISOString() })) };
  }

  async customerInsurance(org: string, customerId: string) {
    const rows = await this.prisma.insuranceCase.findMany({ where: { organizationId: org, customerId }, include: { customer: true }, orderBy: { updatedAt: 'desc' }, take: 5 });
    return rows.map((c) => this.insuranceView(c));
  }

  async insuranceCreate(org: string, input: { customerId: string; kind: string; insurer: string; tpa?: string; policyNumber: string; requiredDocs?: string[]; amountRequested?: number; appointmentId?: string; isDemo?: boolean }, actor: string) {
    if (!INSURANCE_KIND_LABEL[input.kind]) throw new BadRequestException('Unknown insurance case type');
    if (!input.insurer?.trim()) throw new BadRequestException('Enter the insurer');
    const digits = String(input.policyNumber ?? '').replace(/\s/g, '');
    if (digits.length < 4) throw new BadRequestException('Enter the policy number (only the last 4 characters are stored)');
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customerId, organizationId: org } });
    if (!customer) throw new NotFoundException('Patient not found');
    const required = docs(input.requiredDocs).length ? docs(input.requiredDocs) : defaultDocs(input.kind);
    const c = await this.prisma.insuranceCase.create({
      data: {
        organizationId: org, reference: reference('IN'), customerId: customer.id, appointmentId: input.appointmentId ?? null, kind: input.kind, insurer: input.insurer.trim().slice(0, 120),
        tpa: input.tpa?.trim().slice(0, 120) || null, policyRef: `••••${digits.slice(-4)}`, requiredDocs: required as never, receivedDocs: [] as never,
        amountRequested: input.amountRequested === undefined ? null : money(Number(input.amountRequested)), isDemo: input.isDemo ?? false, createdBy: actor,
      },
    });
    await this.audit(org, 'insurance_case', c.id, 'created', actor, { kind: c.kind });
    return this.insuranceGet(org, c.id);
  }

  /** Mark a document as received; all required documents in -> ready to submit. */
  async insuranceDocument(org: string, id: string, doc: string, received: boolean, actor: string) {
    const c = await this.prisma.insuranceCase.findFirst({ where: { id, organizationId: org } });
    if (!c) throw new NotFoundException('Insurance case not found');
    const required = docs(c.requiredDocs);
    if (!required.includes(doc)) throw new BadRequestException('That document is not on this case\'s checklist.');
    const set = new Set(docs(c.receivedDocs));
    if (received) set.add(doc);
    else set.delete(doc);
    const allIn = required.every((d) => set.has(d));
    const status = c.status === 'documents_pending' && allIn ? 'ready_to_submit' : c.status === 'ready_to_submit' && !allIn ? 'documents_pending' : c.status;
    await this.prisma.insuranceCase.update({ where: { id }, data: { receivedDocs: [...set] as never, status } });
    await this.audit(org, 'insurance_case', id, received ? 'document_received' : 'document_removed', actor, { doc, status });
    return this.insuranceGet(org, id);
  }

  /**
   * Staff record the next step. Insurer decisions (approved / partially approved / rejected / settled) need the
   * insurer's reference and, for an approval, the approved amount; `canDecide` comes from the insurance.record_decision
   * permission. The assistant never calls this.
   */
  async insuranceTransition(org: string, id: string, to: string, input: { insurerReference?: string; amountApproved?: number; note?: string }, actor: string, canDecide: boolean) {
    const c = await this.prisma.insuranceCase.findFirst({ where: { id, organizationId: org } });
    if (!c) throw new NotFoundException('Insurance case not found');
    if (!(INS_NEXT[c.status] ?? []).includes(to)) throw new BadRequestException(`Cannot move from "${INSURANCE_STATUS_LABEL[c.status]}" to "${INSURANCE_STATUS_LABEL[to] ?? to}".`);
    const data: Prisma.InsuranceCaseUpdateInput = { status: to };
    if (INSURER_DECISIONS.includes(to)) {
      if (!canDecide) throw new BadRequestException('Recording an insurer decision needs the insurance.record_decision permission.');
      const ref = input.insurerReference?.trim() || c.insurerReference;
      if (!ref) throw new BadRequestException('Enter the insurer / TPA reference for this decision.');
      data.insurerReference = ref.slice(0, 120);
      data.decidedBy = actor;
      if (to === 'approved' || to === 'partially_approved') {
        const amt = Number(input.amountApproved);
        if (!Number.isFinite(amt) || amt <= 0) throw new BadRequestException('Enter the amount the insurer approved.');
        if (c.amountRequested !== null && amt > n(c.amountRequested)) throw new BadRequestException('Approved amount cannot exceed the amount requested.');
        data.amountApproved = money(amt);
      }
    }
    if (to === 'submitted' && docs(c.requiredDocs).some((d) => !docs(c.receivedDocs).includes(d))) throw new BadRequestException('All required documents must be received before submitting.');
    if (input.note) data.decisionNote = input.note.slice(0, 1000);
    await this.prisma.insuranceCase.update({ where: { id }, data });
    await this.audit(org, 'insurance_case', id, to, actor, { insurerReference: data.insurerReference ?? null, amountApproved: data.amountApproved ?? null });
    return this.insuranceGet(org, id);
  }

  async patients(org: string, q?: string) {
    const where: Prisma.CustomerWhereInput = { organizationId: org, ...(q?.trim() ? { OR: [{ name: { contains: q.trim() } }, { phone: { contains: q.replace(/\D/g, '') || '§' } }] } : {}) };
    const rows = await this.prisma.customer.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200, include: { appointments: { orderBy: { startAt: 'desc' }, take: 1, include: { doctor: true } }, insuranceCases: { select: { status: true } }, leads: { orderBy: { createdAt: 'desc' }, take: 1, select: { source: true, campaign: true, status: true } } } });
    return rows.map((c) => ({
      id: c.id, name: c.name, phone: c.phone, language: c.language, source: c.leads[0]?.source ?? c.source, campaign: c.leads[0]?.campaign ?? null, leadStatus: c.leads[0]?.status ?? null,
      lastAppointment: c.appointments[0] ? { reference: c.appointments[0].reference, startAt: c.appointments[0].startAt.toISOString(), status: c.appointments[0].status, doctor: c.appointments[0].doctor.name } : null,
      openInsuranceCases: c.insuranceCases.filter((x) => !['settled', 'closed', 'rejected'].includes(x.status)).length, optedOut: Boolean(c.optedOutAt), isDemo: c.isDemo,
    }));
  }
}

export function defaultDocs(kind: string): string[] {
  if (kind === 'eligibility') return ['Insurance card', 'Photo ID'];
  if (kind === 'pre_authorisation') return ['Insurance card', 'Photo ID', 'Doctor\'s pre-authorisation form', 'Investigation reports'];
  if (kind === 'claim') return ['Insurance card', 'Photo ID', 'Discharge summary', 'Final bill', 'Investigation reports'];
  return ['Claim form', 'Photo ID', 'Discharge summary', 'Original bills', 'Payment receipts', 'Cancelled cheque'];
}
