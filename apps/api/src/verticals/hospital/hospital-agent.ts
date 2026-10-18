import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { inr, istDay, istInstant } from '../common.js';
import { findDates, findReference, findTime, isGreeting, isNo, isThanks, isYes, lower, partOfDay, pickIndex, wantsHuman } from '../parse.js';
import { resetState, t, type AgentCtx, type AgentOut } from '../agent-types.js';
import { APPOINTMENT_STATUS_LABEL, HospitalService } from './hospital.service.js';
import { VerticalFollowUps } from '../vertical-followups.service.js';

type Offer = { doctorId: string; doctor: string; startAt: string; label: string };
export type HospitalState = {
  v: 1;
  step: 'idle' | 'choose_slot' | 'ask_name' | 'confirm' | 'confirm_cancel' | 'reschedule_slot' | 'handoff';
  departmentId?: string;
  doctorId?: string;
  offers?: Offer[];
  chosen?: Offer;
  patientName?: string;
  reason?: string;
  pendingId?: string;
};
export const newHospitalState = (): HospitalState => ({ v: 1, step: 'idle' });

/** Red flags: the assistant stops and points to emergency care at once (and alerts staff). */
const EMERGENCY = /\b(emergency|chest pain|heart attack|can'?t breathe|cannot breathe|breathing (problem|difficulty)|unconscious|fainted|severe bleeding|bleeding heavily|accident|stroke|seizure|fits|poison|overdose|suicid|kill myself|high fever (in|for) (baby|infant)|not breathing)\b/;
/** Clinical advice requests: never answered; offered a consultation instead. */
const CLINICAL = /\b(what (medicine|tablet|drug)|which (medicine|tablet)|dosage|dose|prescri|diagnos|is it (serious|cancer|dangerous)|should i take|can i take|side effect|treatment for|cure for|what is wrong with me|test results mean|report (normal|means))\b/;
const INSURANCE = /\b(insurance|insurer|claim|cashless|pre-?auth|preauthori[sz]ation|tpa|reimburse|policy)\b/;
const MY_APPT = /\b(my appointment|appointment status|booking status|when is my appointment)\b/;
const CANCEL = /\b(cancel (my |the )?appointment|cancel it|cancel pannunga|cancel)\b/;
const RESCHEDULE = /\b(reschedule|change (the |my )?(time|appointment|slot)|postpone|prepone|another time|different time)\b/;
const BOOK = /\b(book|appointment|consult|consultation|see (a |the )?doctor|meet (the )?doctor|doctor|dr\.?|slot|available|opd|checkup|check-up|visit)\b/;
const DEPTS = /\b(departments?|specialit(y|ies)|which doctors|list of doctors|doctors available)\b/;
const FEE = /\b(fee|fees|charges|consultation (fee|charge)|cost)\b/;
const TIMINGS = /\b(timing|timings|opd hours|hours|open|when (is|are) (dr|the doctor))\b/;
const WHERE = /\b(where|location|address|directions|parking)\b/;

/** Common words patients use for departments (routing only, never a diagnosis). */
const DEPT_WORDS: Array<[RegExp, RegExp]> = [
  [/\b(child|baby|kid|infant|paediatric\w*|pediatric\w*|kuzhandhai)\b/, /paediatric|pediatric|child/i],
  [/\b(heart|cardiac|cardio\w*|bp|blood pressure)\b/, /cardio/i],
  [/\b(bone|knee|joint|back pain|fracture|ortho\w*|shoulder|spine)\b/, /ortho/i],
  [/\b(skin|rash|hair fall|derma\w*|acne|allergy)\b/, /derma|skin/i],
  [/\b(pregnan|gynae|gyne|period|women|obstet)\b/, /gyn|obstet/i],
  [/\b(ear|nose|throat|ent|sinus)\b/, /ent|ear/i],
  [/\b(eye|vision|ophthal)\b/, /ophthal|eye/i],
  [/\b(fever|cold|cough|general|sugar|diabetes|thyroid|physician)\b/, /general medicine|internal medicine|general/i],
  [/\b(teeth|tooth|dental)\b/, /dental/i],
];

/**
 * Hospital & healthcare assistant (administrative). Books, moves and cancels appointments on the doctors' real OPD
 * slots, reports insurance case status as recorded by staff, and chases missing documents. It never diagnoses,
 * prescribes, interprets reports or decides insurance; emergencies are pointed to emergency care immediately.
 */
@Injectable()
export class HospitalAgent {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hospital: HospitalService,
    private readonly followUps: VerticalFollowUps,
  ) {}

  async turn(ctx: AgentCtx, state: HospitalState): Promise<AgentOut<HospitalState>> {
    const s: HospitalState = { ...newHospitalState(), ...state };
    const text = ctx.text;
    const lt = lower(text);
    const st = ctx.style;
    const cfg = await this.hospital.cfg(ctx.org);
    const out = (reply: string, intent: string, extra: Partial<AgentOut<HospitalState>> = {}): AgentOut<HospitalState> => ({ reply, state: s, intent, ...extra });

    // 1. Safety first.
    if (EMERGENCY.test(lt)) {
      s.step = 'handoff';
      return out(
        t(st, `⚠️ If this is an emergency, please call ${cfg.emergencyNumber} or come to our Emergency department immediately. I have alerted our team to call you back now.`, `⚠️ Emergency-na udane ${cfg.emergencyNumber} call pannunga illa engal Emergency-ku vaanga. Team-a udane call panna sonnen.`),
        'emergency',
        { handoff: { reason: `URGENT — possible emergency: "${text.slice(0, 200)}"`, urgent: true }, outcome: 'human_requested' },
      );
    }
    if (CLINICAL.test(lt)) {
      return out(t(st, 'I am not able to give medical advice, medicines or interpret reports — a doctor will guide you. I can book a consultation for you: which doctor or department would you like, and when?', 'Medical advice, medicine, report vilakkam — idhu ellaam doctor dhaan sollanum. Consultation book pannalama? Endha doctor / department, eppo?'), 'clinical_declined');
    }
    if (wantsHuman(text) || /\b(complain|complaint|rude|waiting too long|bad experience)\b/.test(lt)) {
      s.step = 'handoff';
      const complaint = /\b(complain|complaint|rude|waiting too long|bad experience)\b/.test(lt);
      return out(complaint ? t(st, 'I am sorry about your experience. I have passed this to our patient-care team; they will contact you shortly.', 'Sorry. Patient-care team-ku anuppiten; seekiram contact pannuvaanga.') : t(st, 'Sure — our front desk will reply to you here shortly.', 'Seri, front desk seekiram inga reply pannuvaanga.'), complaint ? 'complaint' : 'human', { handoff: { reason: complaint ? `Patient complaint: "${text.slice(0, 200)}"` : 'Patient asked for a person' }, outcome: 'human_requested' });
    }
    if (s.step === 'handoff' && !BOOK.test(lt) && !isGreeting(text)) return out(t(st, 'Noted — our team has your message.', 'Noted, team-ku message pochu.'), 'handoff_waiting');
    if (s.step === 'handoff') s.step = 'idle';

    // 2. Feedback rating after a completed consultation.
    const rating = lt.trim().match(/^\s*([1-5])\s*(?:\/\s*5)?\s*(?:stars?)?\s*$/);
    if (rating && s.step === 'idle') {
      const last = (await this.hospital.customerAppointments(ctx.org, ctx.customer.id)).find((a) => a.status === 'completed' && a.feedbackRating === null);
      if (last) {
        await this.hospital.recordFeedback(ctx.org, last.id, Number(rating[1]), null, `ai:${ctx.channel}`);
        if (Number(rating[1]) <= 2) {
          s.step = 'handoff';
          return out(t(st, 'Thank you for telling us. I am sorry — our patient-care team will contact you.', 'Sollunadhuku nandri. Patient-care team contact pannuvaanga.'), 'feedback_low', { handoff: { reason: `Low rating ${rating[1]}/5 after ${last.reference}` } });
        }
        return out(t(st, 'Thank you for your feedback! 🙏', 'Feedback-ku nandri! 🙏'), 'feedback');
      }
    }

    // 3. Insurance: status as recorded by staff, missing documents.
    const insRef = findReference(text, 'IN');
    if (INSURANCE.test(lt) || insRef) {
      const cases = await this.hospital.customerInsurance(ctx.org, ctx.customer.id);
      const c = insRef ? cases.find((x) => x.reference === `IN-${insRef}`) : cases[0];
      if (!c) return out(t(st, 'I could not find an insurance case for this number. Our insurance desk can help — shall I ask them to contact you? (Reply "staff")', 'Indha number-ku insurance case illa. Insurance desk contact panna "staff" nu reply pannunga.'), 'insurance_not_found');
      const missing = c.missingDocs.length ? `\n${t(st, 'Still needed', 'Innum venum')}: ${c.missingDocs.join(', ')}. ${t(st, 'Share them at the insurance desk or send clear photos here; our team will verify.', 'Insurance desk-la kudunga illa inga clear photos anuppunga; team verify pannuvaanga.')}` : '';
      const amount = c.amountApproved !== null ? ` · ${t(st, 'approved amount', 'approved amount')} ${inr(c.amountApproved)}` : '';
      return out(`${c.reference} — ${c.kindLabel} (${c.insurer}): *${c.statusLabel}*${amount}${c.insurerReference ? ` · ${t(st, 'insurer ref', 'insurer ref')} ${c.insurerReference}` : ''}.${missing}\n${t(st, 'Status as recorded by our insurance desk; decisions are made by your insurer / TPA.', 'Idhu insurance desk record panna status; mudivu insurer / TPA dhaan edupaanga.')}`, 'insurance_status');
    }

    // 4. Existing appointments.
    const ref = findReference(text, 'AP');
    const myNext = async () => {
      if (ref) {
        const a = await this.hospital.byReference(ctx.org, `AP-${ref}`);
        return a && a.patient.id === ctx.customer.id ? a : null;
      }
      return (await this.hospital.customerAppointments(ctx.org, ctx.customer.id)).filter((a) => ['booked', 'confirmed'].includes(a.status) && new Date(a.startAt) > ctx.now).sort((a, b) => a.startAt.localeCompare(b.startAt))[0] ?? null;
    };
    if (s.step === 'confirm_cancel' && s.pendingId) {
      const id = s.pendingId;
      s.step = 'idle';
      s.pendingId = undefined;
      if (!isYes(text)) return out(t(st, 'Okay, your appointment stays as it is.', 'Seri, appointment appadiye.'), 'cancel_aborted');
      const a = await this.hospital.setStatus(ctx.org, id, 'cancelled', 'ai:patient_request', 'Patient cancelled on chat');
      await this.followUps.onAppointment(ctx.org, { id, customerId: ctx.customer.id, status: 'cancelled', startAt: new Date(a.startAt) });
      return out(t(st, `Appointment ${a.reference} is cancelled. Reply "book" anytime to choose a new slot.`, `Appointment ${a.reference} cancel aagiduchu. Pudhu slot-ku "book" nu reply pannunga.`), 'appointment_cancelled', { outcome: 'cancelled', record: { type: 'appointment', id, reference: a.reference, status: 'cancelled', result: 'updated' } });
    }
    if (s.step === 'reschedule_slot' && s.pendingId && s.offers?.length) {
      const k = pickIndex(text, s.offers.length) ?? this.byTime(s.offers, text);
      if (k !== undefined) {
        const o = s.offers[k];
        try {
          const a = await this.hospital.reschedule(ctx.org, s.pendingId, o.startAt, 'ai:patient_request', ctx.now);
          await this.followUps.onAppointment(ctx.org, { id: a.id, customerId: ctx.customer.id, status: a.status, startAt: new Date(a.startAt) });
          resetState(s, newHospitalState());
          return out(t(st, `Done — ${a.reference} is now on ${a.label} with ${a.doctor.name}.`, `Done — ${a.reference} ippo ${a.label}, ${a.doctor.name}.`), 'appointment_rescheduled', { record: { type: 'appointment', id: a.id, reference: a.reference, status: a.status, result: 'updated' } });
        } catch (e) {
          return out(`${e instanceof Error ? e.message : String(e)} ${t(st, 'Please choose another option.', 'Vera option choose pannunga.')}`, 'reschedule_failed');
        }
      }
    }
    if (MY_APPT.test(lt) || ref || (CANCEL.test(lt) && !BOOK.test(lt.replace(/appointment/g, ''))) || RESCHEDULE.test(lt)) {
      const a = await myNext();
      if (!a) {
        if (CANCEL.test(lt) || RESCHEDULE.test(lt) || MY_APPT.test(lt) || ref) return out(t(st, 'I could not find an upcoming appointment for this number. Please share the reference (AP-XXXXXX), or say "book" to make a new one.', 'Upcoming appointment kidaikkala. Reference (AP-XXXXXX) anuppunga, illa "book" nu sollunga.'), 'appointment_not_found');
      } else if (CANCEL.test(lt)) {
        s.step = 'confirm_cancel';
        s.pendingId = a.id;
        return out(t(st, `Cancel ${a.reference} with ${a.doctor.name} on ${a.label}? Reply YES to cancel.`, `${a.reference} (${a.doctor.name}, ${a.label}) cancel pannanuma? YES nu reply pannunga.`), 'cancel_confirm');
      } else if (RESCHEDULE.test(lt)) {
        const offers = await this.hospital.nextSlots(ctx.org, { doctorId: a.doctor.id, fromDay: findDates(text, ctx.now)[0], part: partOfDay(text), limit: 3 }, ctx.now);
        if (!offers.length) return out(t(st, `${a.doctor.name} has no free slots in the next ${cfg.bookingWindowDays} days. Our front desk will help — reply "staff".`, `${a.doctor.name}-ku slot illa. "staff" nu reply pannunga.`), 'no_slots');
        s.step = 'reschedule_slot';
        s.pendingId = a.id;
        s.offers = offers.map((o) => ({ doctorId: o.doctorId, doctor: o.doctor, startAt: o.startAt, label: o.label }));
        return out(`${t(st, 'Available times with', 'Available times:')} ${a.doctor.name}:\n${s.offers.map((o, k) => `${k + 1}. ${o.label}`).join('\n')}\n${t(st, 'Reply with the number.', 'Number reply pannunga.')}`, 'reschedule_offer');
      } else {
        return out(`${a.reference}: *${APPOINTMENT_STATUS_LABEL[a.status]}* — ${a.doctor.name} (${a.department.name}), ${a.label}. ${t(st, 'Please arrive 15 minutes early.', '15 nimisham munnadi vaanga.')}`, 'appointment_status');
      }
    }

    // 5. Information from the directory.
    const directory = await this.hospital.directory(ctx.org);
    const doctors = directory.flatMap((d) => d.doctors.filter((x) => x.active).map((x) => ({ ...x, department: d.name })));
    if (DEPTS.test(lt)) {
      return out(`${directory.filter((d) => d.active).map((d) => `*${d.name}*: ${d.doctors.filter((x) => x.active).map((x) => x.name).join(', ') || '—'}`).join('\n')}\n\n${t(st, 'Say a doctor or department to see available slots.', 'Doctor / department sollunga, slots kaattuven.')}`, 'departments');
    }

    // 6. Booking: doctor / department / date / time.
    const docMatch = doctors.find((x) => {
      const nm = x.name.toLowerCase().replace(/^dr\.?\s*/, '');
      return nm.split(/\s+/).some((p) => p.length >= 4 && lt.includes(` ${p} `));
    });
    const deptByName = directory.find((d) => {
      const nm = d.name.toLowerCase();
      return lt.includes(` ${nm} `) || lt.includes(` ${nm.split(' ')[0]} `) || (nm.length >= 7 && lt.includes(` ${nm.slice(0, 7)}`));
    });
    const deptByWord = DEPT_WORDS.find(([w]) => w.test(lt));
    const dept = deptByName ?? (deptByWord ? directory.find((d) => deptByWord[1].test(d.name)) : undefined);
    if (docMatch) {
      s.doctorId = docMatch.id;
      s.departmentId = docMatch.departmentId;
    } else if (dept) {
      s.departmentId = dept.id;
      s.doctorId = undefined;
    }

    if (FEE.test(lt) && (docMatch || dept)) {
      const list = docMatch ? [docMatch] : doctors.filter((x) => x.departmentId === dept!.id);
      return out(list.map((x) => `${x.name} (${x.department}) — ${t(st, 'consultation', 'consultation')} ${inr(x.consultationFee)}`).join('\n'), 'faq_fee');
    }
    if (TIMINGS.test(lt) && docMatch && !BOOK.test(lt.replace(/doctor|dr/g, ''))) {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return out(`${docMatch.name} OPD: ${docMatch.schedule.map((b) => `${days[b.day]} ${b.start}–${b.end}`).join(', ')}.`, 'faq_timings');
    }
    const faq = cfg.faqs.find((f) => lower(f.q).split(' ').filter((w) => w.length > 3).some((w) => lt.includes(` ${w} `)));
    if (faq && !BOOK.test(lt)) return out(faq.a, 'faq');
    if (WHERE.test(lt) && faq) return out(faq.a, 'faq');

    if (s.step === 'confirm') {
      if (isYes(text)) return this.book(ctx, s);
      if (isNo(text)) {
        s.step = 'idle';
        s.chosen = undefined;
        return out(t(st, 'No problem. Would you like a different time or doctor?', 'Seri. Vera time / doctor venuma?'), 'confirm_declined');
      }
    }
    if (s.step === 'ask_name') {
      const name = text.replace(/^(my name is|name is|i am|i'm|this is|naan|en peru)\s*/i, '').trim();
      if (name.length >= 2 && name.length <= 60 && !/\d{4,}/.test(name)) {
        s.patientName = name.replace(/\b\w/g, (c) => c.toUpperCase());
        await this.prisma.customer.update({ where: { id: ctx.customer.id }, data: { name: s.patientName } }).catch(() => undefined);
        return this.toConfirm(ctx, s);
      }
      return out(t(st, 'Please tell me the patient\'s full name.', 'Patient full name sollunga.'), 'ask_name');
    }
    if (s.step === 'choose_slot' && s.offers?.length && !docMatch && !dept) {
      const k = pickIndex(text, s.offers.length) ?? this.byTime(s.offers, text);
      if (k !== undefined) {
        s.chosen = s.offers[k];
        if (!ctx.customer.name && !s.patientName) {
          s.step = 'ask_name';
          return out(t(st, `${s.chosen.label} with ${s.chosen.doctor}. May I have the patient's full name?`, `${s.chosen.label}, ${s.chosen.doctor}. Patient full name sollunga?`), 'ask_name');
        }
        return this.toConfirm(ctx, s);
      }
    }

    const wantsBooking = BOOK.test(lt) || Boolean(docMatch || dept) || (s.step === 'choose_slot' && (findDates(text, ctx.now).length > 0 || Boolean(partOfDay(text)) || Boolean(findTime(text))));
    if (wantsBooking) {
      if (!s.doctorId && !s.departmentId) {
        return out(`${t(st, 'Which doctor or department would you like?', 'Endha doctor / department?')}\n${directory.filter((d) => d.active).map((d) => `• ${d.name}`).join('\n')}`, 'ask_department');
      }
      const day = findDates(text, ctx.now)[0];
      const time = findTime(text);
      let offers = await this.hospital.nextSlots(ctx.org, { doctorId: s.doctorId, departmentId: s.doctorId ? undefined : s.departmentId, fromDay: day, part: partOfDay(text), limit: time ? 10 : 3 }, ctx.now);
      if (time && day) {
        const exact = offers.find((o) => o.day === day && o.time === time);
        offers = exact ? [exact] : offers.filter((o) => o.day === day).slice(0, 3);
      }
      if (!offers.length) {
        return out(t(st, `No free slots${day ? ` on that day` : ''} in the next ${cfg.bookingWindowDays} days for this ${s.doctorId ? 'doctor' : 'department'}. Try another day, or reply "staff" and our front desk will help.`, `Indha ${s.doctorId ? 'doctor' : 'department'}-ku slot illa. Vera naal try pannunga, illa "staff" nu reply pannunga.`), 'no_slots');
      }
      s.offers = offers.map((o) => ({ doctorId: o.doctorId, doctor: o.doctor, startAt: o.startAt, label: o.label }));
      if (offers.length === 1 && time) {
        s.chosen = s.offers[0];
        if (!ctx.customer.name && !s.patientName) {
          s.step = 'ask_name';
          return out(t(st, `${s.chosen.label} with ${s.chosen.doctor} is free. May I have the patient's full name?`, `${s.chosen.label}, ${s.chosen.doctor} free. Patient full name?`), 'ask_name');
        }
        return this.toConfirm(ctx, s);
      }
      s.step = 'choose_slot';
      return out(`${t(st, 'Next available', 'Next available')}:\n${s.offers.map((o, k) => `${k + 1}. ${o.doctor} — ${o.label}`).join('\n')}\n${t(st, 'Reply with the number, or ask for another day / time.', 'Number reply pannunga, illa vera naal / time kelunga.')}`, 'offer_slots');
    }

    if (isThanks(text)) return out(t(st, `Thank you for contacting ${ctx.orgName}. Take care!`, `${ctx.orgName}-a contact pannadhuku nandri. Take care!`), 'goodbye', { endCall: ctx.voice });
    return out(t(st, `Welcome to ${ctx.orgName}. I can book, reschedule or cancel doctor appointments, share OPD timings and fees, and update you on insurance paperwork. How can I help? (For emergencies call ${cfg.emergencyNumber}.)`, `${ctx.orgName}-ku welcome. Doctor appointment book / reschedule / cancel, OPD timings, fees, insurance update — help pannuven. (Emergency-na ${cfg.emergencyNumber} call pannunga.)`), isGreeting(text) ? 'greeting' : 'unknown');
  }

  private byTime(offers: Offer[], text: string) {
    const time = findTime(text);
    if (!time) return undefined;
    const k = offers.findIndex((o) => new Date(new Date(o.startAt).getTime() + 330 * 60_000).toISOString().slice(11, 16) === time);
    return k >= 0 ? k : undefined;
  }

  private async toConfirm(ctx: AgentCtx, s: HospitalState): Promise<AgentOut<HospitalState>> {
    const st = ctx.style;
    const d = await this.prisma.doctor.findFirst({ where: { id: s.chosen!.doctorId, organizationId: ctx.org }, include: { department: true } });
    s.step = 'confirm';
    const who = s.patientName ?? ctx.customer.name ?? '';
    return {
      reply: `${t(st, 'Please confirm', 'Confirm pannunga')}:\n${d?.name} (${d?.department.name})\n${s.chosen!.label}\n${t(st, 'Patient', 'Patient')}: ${who}\n${t(st, 'Consultation fee', 'Consultation fee')}: ${inr(Number(d?.consultationFee ?? 0))} (${t(st, 'pay at the hospital', 'hospital-la pay')})\n\n${t(st, 'Reply YES to book.', 'Book panna YES nu reply pannunga.')}`,
      state: s, intent: 'confirm_appointment',
    };
  }

  private async book(ctx: AgentCtx, s: HospitalState): Promise<AgentOut<HospitalState>> {
    const st = ctx.style;
    const c = s.chosen!;
    try {
      const r = await this.hospital.book(ctx.org, {
        doctorId: c.doctorId, startAt: c.startAt, customerId: ctx.customer.id, leadId: ctx.leadId, channel: ctx.channel === 'web' ? 'test' : ctx.channel,
        idempotencyKey: `chat:${ctx.conversationId}:${c.doctorId}:${c.startAt}`, patientName: s.patientName ?? ctx.customer.name, patientPhone: ctx.customer.phone,
        actor: 'ai', isDemo: ctx.isDemo || ctx.customer.isDemo, now: ctx.now,
      });
      const a = r.appointment;
      if (r.status === 'created') await this.followUps.onAppointment(ctx.org, { id: a.id, customerId: ctx.customer.id, status: a.status, startAt: new Date(a.startAt) });
      resetState(s, newHospitalState());
      return {
        reply: `✅ ${t(st, 'Appointment booked', 'Appointment book aagiduchu')}: *${a.reference}*\n${a.doctor.name} (${a.department.name}) — ${a.label}\n${t(st, 'Please arrive 15 minutes early with any previous reports and your ID / insurance card. We will send a reminder.', '15 nimisham munnadi, previous reports + ID / insurance card-oda vaanga. Reminder anuppuvom.')}`,
        state: s, intent: 'booked', outcome: 'booked', record: { type: 'appointment', id: a.id, reference: a.reference, status: a.status, result: r.status },
      };
    } catch (e) {
      s.step = 'idle';
      s.chosen = undefined;
      return { reply: `${e instanceof Error ? e.message : String(e)} ${t(st, 'Shall I show other times?', 'Vera time kaattalama?')}`, state: s, intent: 'booking_failed' };
    }
  }
}

export { istDay, istInstant };
