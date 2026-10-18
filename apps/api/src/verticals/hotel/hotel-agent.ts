import { Injectable } from '@nestjs/common';
import { addDays, inr, istDay, prettyDay, prettyTime } from '../common.js';
import { findDates, findGuests, findNights, findReference, findRooms, isGreeting, isNo, isThanks, isYes, lower, pickIndex, wantsHuman } from '../parse.js';
import { resetState, t, type AgentCtx, type AgentOut } from '../agent-types.js';
import { HotelService, RESERVATION_STATUS_LABEL, type HotelQuote } from './hotel.service.js';
import { VerticalFollowUps } from '../vertical-followups.service.js';

export type HotelState = {
  v: 1;
  step: 'collecting' | 'choose_room' | 'confirm' | 'confirm_cancel' | 'reschedule' | 'handoff';
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  rooms?: number;
  roomTypeId?: string;
  offered?: string[];
  quotedTotal?: number;
  pendingId?: string;
  enquiryLogged?: boolean;
  lastReservationId?: string;
};
export const newHotelState = (): HotelState => ({ v: 1, step: 'collecting' });

const COMPLAINT = /\b(complain|complaint|dirty|not clean|noisy|broken|not working|doesn'?t work|no hot water|rude|refund|bad service|smell|leak(ing)?|cockroach|bed ?bugs?)\b/;
const STATUS = /\b(my (booking|reservation)|booking status|reservation status|is my (booking|room) confirmed|confirm aagiducha)\b/;
const CANCEL = /\b(cancel (my |the )?(booking|reservation|room)|cancel it|cancel pannunga|cancel booking)\b/;
const RESCHEDULE = /\b(change (my |the )?(dates?|booking)|reschedule|postpone|prepone|modify (my )?booking|different dates)\b/;
const BOOK = /\b(book|booking|reserve|room|rooms|stay|available|availability|vacancy|night|nights|check ?in|tariff|rate|rates)\b/;
const COMPARE = /\b(room types|what rooms|which rooms|compare|types of rooms|room options|difference)\b/;
const TIMES = /\b(check ?in time|check ?out time|checkin time|checkout time|what time)\b/;
const AMENITY = /\b(wifi|wi-fi|breakfast|parking|pool|ac|air condition|gym|restaurant|amenities|facilities|pet|pets)\b/;
const POLICY = /\b(cancellation policy|refund policy|policy)\b/;

/**
 * Hotel & room booking assistant. Dates, guests and room type are collected step by step; availability, rates and
 * the booking itself come from HotelService (never from the model). A booking made here waits for front-desk
 * confirmation unless the hotel turned on auto-confirm.
 */
@Injectable()
export class HotelAgent {
  constructor(
    private readonly hotel: HotelService,
    private readonly followUps: VerticalFollowUps,
  ) {}

  private quoteText(q: HotelQuote, style: 'en' | 'tl') {
    const nights = q.breakdown.map((b) => `${prettyDay(b.date)} ${inr(b.rate)}${b.source === 'seasonal' ? ` (${b.label})` : b.source === 'weekend' ? ' (weekend)' : ''}`).join(', ');
    return `*${q.roomType?.name}* · ${prettyDay(q.checkIn)} → ${prettyDay(q.checkOut)} (${q.nights} ${q.nights === 1 ? 'night' : 'nights'}) · ${q.rooms} ${q.rooms === 1 ? 'room' : 'rooms'} · ${q.adults} ${q.adults === 1 ? 'adult' : 'adults'}${q.children ? `, ${q.children} ${q.children === 1 ? 'child' : 'children'}` : ''}\n${t(style, 'Nightly', 'Nightly')}: ${nights}${q.rooms > 1 ? ` × ${q.rooms}` : ''}\n${t(style, 'Room charges', 'Room charges')} ${inr(q.subtotal)} + ${t(style, 'tax', 'tax')} ${inr(q.tax)} = *${inr(q.total)}*${q.deposit ? `\n${t(style, 'Deposit', 'Deposit')}: ${inr(q.deposit)}` : ''}`;
  }

  async turn(ctx: AgentCtx, state: HotelState): Promise<AgentOut<HotelState>> {
    const s: HotelState = { ...newHotelState(), ...state };
    const text = ctx.text;
    const lt = lower(text);
    const st = ctx.style;
    const cfg = await this.hotel.cfg(ctx.org);
    const out = (reply: string, intent: string, extra: Partial<AgentOut<HotelState>> = {}): AgentOut<HotelState> => ({ reply, state: s, intent, ...extra });

    if (COMPLAINT.test(lt) || wantsHuman(text)) {
      s.step = 'handoff';
      const complaint = COMPLAINT.test(lt);
      return out(
        complaint ? t(st, 'I am sorry about this. I have alerted our front desk; a team member will contact you right away.', 'Sorry. Front desk-ku alert pannitten; udane contact pannuvaanga.') : t(st, 'Sure — our front desk will reply to you here shortly.', 'Seri, front desk seekiram inga reply pannuvaanga.'),
        complaint ? 'guest_complaint' : 'human',
        { handoff: { reason: complaint ? `Guest service issue: "${text.slice(0, 200)}"` : 'Guest asked for a person', urgent: complaint }, outcome: 'human_requested' },
      );
    }
    if (s.step === 'handoff' && !BOOK.test(lt) && !isGreeting(text)) return out(t(st, 'Noted — the front desk has your message.', 'Noted, front desk-ku message pochu.'), 'handoff_waiting');
    if (s.step === 'handoff') s.step = 'collecting';

    // Status / cancel / reschedule of an existing reservation.
    const ref = findReference(text, 'HB');
    const mine = async () => {
      if (ref) {
        const r = await this.hotel.byReference(ctx.org, `HB-${ref}`);
        return r && r.guest.id === ctx.customer.id ? r : null;
      }
      return (await this.hotel.customerReservations(ctx.org, ctx.customer.id)).find((r) => ['pending_confirmation', 'confirmed', 'checked_in'].includes(r.status)) ?? null;
    };

    if (s.step === 'confirm_cancel' && s.pendingId) {
      const id = s.pendingId;
      s.step = 'collecting';
      s.pendingId = undefined;
      if (!isYes(text)) return out(t(st, 'Okay, your reservation stays as it is.', 'Seri, booking appadiye irukku.'), 'cancel_aborted');
      try {
        const r = await this.hotel.cancel(ctx.org, id, 'ai:guest_request', 'Guest cancelled on chat');
        await this.followUps.onReservation(ctx.org, { id, customerId: ctx.customer.id, status: 'cancelled', checkIn: r.checkIn, checkOut: r.checkOut });
        return out(`${t(st, 'Reservation', 'Reservation')} ${r.reference} ${t(st, 'is cancelled.', 'cancel aagiduchu.')} ${r.policyNote}`, 'reservation_cancelled', { outcome: 'cancelled', record: { type: 'reservation', id, reference: r.reference, status: 'cancelled', result: 'updated' } });
      } catch (e) {
        return out(e instanceof Error ? e.message : String(e), 'cancel_failed');
      }
    }
    if (s.step === 'reschedule' && s.pendingId) {
      const dates = findDates(text, ctx.now);
      const nights = findNights(text);
      const ci = dates[0];
      const co = dates[1] ?? (ci && nights ? addDays(ci, nights) : undefined);
      if (!ci || !co) return out(t(st, 'Please send the new check-in and check-out dates (e.g. "20 Nov to 22 Nov").', 'Pudhu check-in / check-out dates anuppunga (e.g. "20 Nov to 22 Nov").'), 'reschedule_dates');
      const id = s.pendingId;
      try {
        const current = await this.hotel.get(ctx.org, id);
        const r = await this.hotel.reschedule(ctx.org, id, { checkIn: ci, checkOut: co, adults: current.adults, children: current.children, rooms: current.rooms }, 'ai:guest_request');
        s.step = 'collecting';
        s.pendingId = undefined;
        return out(`${t(st, 'Done — reservation', 'Done — reservation')} ${r.reference}: ${prettyDay(r.checkIn)} → ${prettyDay(r.checkOut)}, ${t(st, 'new total', 'pudhu total')} ${inr(r.total)} (${RESERVATION_STATUS_LABEL[r.status]}).`, 'reservation_rescheduled', { record: { type: 'reservation', id, reference: r.reference, status: r.status, result: 'updated' } });
      } catch (e) {
        return out(`${e instanceof Error ? e.message : String(e)} ${t(st, 'Send other dates, or say KEEP to keep the current booking.', 'Vera dates anuppunga, illa KEEP nu sollunga.')}`, 'reschedule_failed');
      }
    }
    if (/\bkeep\b/.test(lt) && s.step === 'reschedule') {
      s.step = 'collecting';
      s.pendingId = undefined;
      return out(t(st, 'Okay, your booking stays as it is.', 'Seri, booking appadiye.'), 'reschedule_aborted');
    }

    if (CANCEL.test(lt) || RESCHEDULE.test(lt) || ref || STATUS.test(lt)) {
      const r = await mine();
      if (!r) return out(t(st, 'I could not find an upcoming reservation for this number. Please share your booking reference (HB-XXXXXX).', 'Indha number-ku upcoming booking kidaikkala. Booking reference (HB-XXXXXX) anuppunga.'), 'reservation_not_found');
      if (CANCEL.test(lt)) {
        if (!['pending_confirmation', 'confirmed'].includes(r.status)) return out(t(st, `Reservation ${r.reference} is ${r.statusLabel.toLowerCase()} and cannot be cancelled here.`, `Reservation ${r.reference} ${r.statusLabel.toLowerCase()}; inga cancel panna mudiyadhu.`), 'cancel_not_allowed');
        s.step = 'confirm_cancel';
        s.pendingId = r.id;
        return out(`${t(st, 'Cancel reservation', 'Reservation cancel pannanuma:')} ${r.reference} (${r.roomType.name}, ${prettyDay(r.checkIn)} → ${prettyDay(r.checkOut)})?\n${t(st, 'Policy', 'Policy')}: ${cfg.cancellationPolicy}\n${t(st, 'Reply YES to cancel.', 'Cancel panna YES nu reply pannunga.')}`, 'cancel_confirm');
      }
      if (RESCHEDULE.test(lt)) {
        if (!['pending_confirmation', 'confirmed'].includes(r.status)) return out(t(st, `Reservation ${r.reference} cannot be changed now.`, `Reservation ${r.reference} ippo maatha mudiyadhu.`), 'reschedule_not_allowed');
        s.step = 'reschedule';
        s.pendingId = r.id;
        return out(t(st, `Sure. What are the new dates for ${r.reference}?`, `Seri. ${r.reference}-ku pudhu dates enna?`), 'reschedule_dates');
      }
      const pay = r.paymentStatus !== 'not_required' ? ` · ${r.paymentLabel}` : '';
      const hold = r.status === 'pending_confirmation' && r.holdExpiresAt ? ` ${t(st, 'Room held until', 'Room hold')} ${prettyTime(new Date(r.holdExpiresAt))}.` : '';
      return out(`${r.reference}: *${r.statusLabel}* — ${r.roomType.name}, ${prettyDay(r.checkIn)} → ${prettyDay(r.checkOut)}, ${inr(r.total)}${pay}.${hold}`, 'reservation_status');
    }

    // Information.
    if (TIMES.test(lt)) return out(t(st, `Check-in is from ${cfg.checkInTime} and check-out is by ${cfg.checkOutTime}.`, `Check-in ${cfg.checkInTime} mudhal, check-out ${cfg.checkOutTime}-kulla.`), 'faq_times');
    if (POLICY.test(lt)) return out(cfg.cancellationPolicy, 'faq_policy');
    const types = await this.hotel.roomTypes(ctx.org);
    const activeTypes = types.filter((x) => x.active);
    if (COMPARE.test(lt) || (/\b(price|tariff|rates?)\b/.test(lt) && !findDates(text, ctx.now).length)) {
      return out(`${activeTypes.map((x) => `*${x.name}* — ${t(st, 'from', 'from')} ${inr(x.baseRate)}/night${x.weekendRate ? ` (${t(st, 'weekend', 'weekend')} ${inr(x.weekendRate)})` : ''} · ${t(st, 'up to', 'max')} ${x.maxOccupancy} ${t(st, 'guests', 'guests')}${x.amenities.length ? ` · ${x.amenities.slice(0, 4).join(', ')}` : ''}`).join('\n')}\n\n${t(st, 'Rates vary by date (seasonal rates apply). Send your dates and number of guests for an exact price.', 'Rate date-ku date maarum. Exact price-ku dates + guests anuppunga.')}`, 'room_types');
    }
    const faq = cfg.faqs.find((f) => lower(f.q).split(' ').filter((w) => w.length > 3).some((w) => lt.includes(` ${w} `)));
    if (faq && !BOOK.test(lt)) return out(faq.a, 'faq');
    if (AMENITY.test(lt) && !findDates(text, ctx.now).length) {
      const all = [...new Set(activeTypes.flatMap((x) => x.amenities))];
      return faq ? out(faq.a, 'faq') : out(t(st, `Our rooms include: ${all.join(', ')}. For anything else, our front desk will help.`, `Rooms-la: ${all.join(', ')}.`), 'faq_amenities');
    }

    // Booking flow: collect dates, guests, rooms.
    const dates = findDates(text, ctx.now);
    const nights = findNights(text);
    const g = findGuests(text);
    const rooms = findRooms(text);
    if (dates[0]) {
      s.checkIn = dates[0];
      s.checkOut = dates[1] && dates[1] > dates[0] ? dates[1] : nights ? addDays(dates[0], nights) : s.checkOut && s.checkOut > dates[0] ? s.checkOut : undefined;
    } else if (nights && s.checkIn) s.checkOut = addDays(s.checkIn, nights);
    if (g.adults !== undefined) s.adults = g.adults;
    if (g.children !== undefined) s.children = g.children;
    if (rooms !== undefined) s.rooms = rooms;
    const mentionedType = activeTypes.find((x) => lt.includes(` ${x.name.toLowerCase()} `) || lt.includes(` ${x.code.toLowerCase()} `) || lt.includes(` ${x.name.toLowerCase().split(' ')[0]} `));
    if (mentionedType) s.roomTypeId = mentionedType.id;
    const changed = Boolean(dates.length || nights || g.adults !== undefined || g.children !== undefined || rooms !== undefined || mentionedType);

    if (s.step === 'confirm') {
      if (isYes(text) && !changed) return this.book(ctx, s);
      if (isNo(text) && !changed) {
        s.step = 'collecting';
        return out(t(st, 'No problem. Tell me what to change — dates, guests or room type.', 'Seri. Enna maathanum — dates, guests, room type?'), 'confirm_declined');
      }
    }
    if (s.step === 'choose_room' && s.offered?.length && !mentionedType) {
      const k = pickIndex(text, s.offered.length);
      if (k !== undefined) s.roomTypeId = s.offered[k];
    }

    if (!s.checkIn && !changed && s.lastReservationId && isYes(text)) {
      const r = await this.hotel.get(ctx.org, s.lastReservationId);
      return out(t(st, `Your reservation ${r.reference} is already recorded (${r.statusLabel}). Ask "my booking" anytime for the status.`, `Ungal reservation ${r.reference} already record aagiduchu (${r.statusLabel}).`), 'already_booked');
    }
    if (!s.checkIn && !changed) {
      if (isThanks(text)) return out(t(st, `Thank you! We look forward to hosting you at ${ctx.orgName}.`, `Nandri! ${ctx.orgName}-la ungala varaverkka kaathirukkom.`), 'goodbye', { endCall: ctx.voice });
      if (isGreeting(text) || !BOOK.test(lt)) return out(t(st, `Welcome to ${ctx.orgName}! 😊 I can check room availability, share rates and make a booking. When would you like to stay, and for how many guests?`, `${ctx.orgName}-ku welcome! 😊 Room availability, rates, booking — help pannuven. Endha dates, ethana per?`), isGreeting(text) ? 'greeting' : 'unknown');
    }
    if (!s.checkIn) return out(t(st, 'Which dates? Send check-in and check-out, e.g. "15 Nov to 17 Nov" or "tomorrow for 2 nights".', 'Endha dates? e.g. "15 Nov to 17 Nov" illa "naalaikku 2 nights".'), 'ask_dates');
    if (!s.checkOut) return out(t(st, `Check-in ${prettyDay(s.checkIn)} — for how many nights?`, `Check-in ${prettyDay(s.checkIn)} — ethana nights?`), 'ask_nights');
    if (!s.adults) return out(t(st, 'How many guests (adults and children)?', 'Ethana per (adults, children)?'), 'ask_guests');

    const stay = { checkIn: s.checkIn, checkOut: s.checkOut, adults: s.adults, children: s.children ?? 0, rooms: s.rooms ?? 1 };
    if (s.roomTypeId) {
      const q = await this.hotel.quote(ctx.org, s.roomTypeId, stay, ctx.now);
      if (!q.ok) {
        s.roomTypeId = undefined;
        s.step = 'collecting';
        if (q.problems.some((p) => /past|after check-in|limited|year ahead|adults|children|Rooms must/.test(p))) {
          if (q.problems.some((p) => /past|after check-in/.test(p))) {
            s.checkIn = undefined;
            s.checkOut = undefined;
          }
          return out(q.problems.join(' '), 'stay_invalid');
        }
        const a = await this.hotel.availability(ctx.org, stay, ctx.now);
        const alt = a.roomTypes.filter((x) => x.bookable);
        s.offered = alt.map((x) => x.roomTypeId);
        s.step = alt.length ? 'choose_room' : 'collecting';
        return out(`${q.problems.join(' ')}${alt.length ? `\n${t(st, 'Available instead', 'Available')}:\n${alt.map((x, k) => `${k + 1}. ${x.name} — ${inr(x.quote!.total)} ${t(st, 'total', 'total')}`).join('\n')}\n${t(st, 'Reply with the number to choose.', 'Number reply pannunga.')}` : ` ${t(st, 'No rooms are free for those dates; try other dates.', 'Andha dates-ku room illa; vera dates try pannunga.')}`}`, 'room_unavailable');
      }
      s.step = 'confirm';
      s.quotedTotal = q.total;
      const confirmNote = cfg.autoConfirm ? t(st, 'Reply YES to book.', 'Book panna YES nu reply pannunga.') : t(st, 'Reply YES to request this booking; our front desk confirms it shortly and the room is held for you meanwhile.', 'YES nu reply pannunga; front desk seekiram confirm pannuvaanga, adhuvarai room hold-la irukkum.');
      return out(`${this.quoteText(q, st)}\n${t(st, 'Check-in', 'Check-in')} ${cfg.checkInTime} · ${t(st, 'check-out', 'check-out')} ${cfg.checkOutTime}\n${t(st, 'Cancellation', 'Cancellation')}: ${cfg.cancellationPolicy}\n\n${confirmNote}`, 'quote');
    }
    const a = await this.hotel.availability(ctx.org, stay, ctx.now);
    if (a.problems.length) {
      if (a.problems.some((p) => /past|after check-in/.test(p))) {
        s.checkIn = undefined;
        s.checkOut = undefined;
      }
      return out(a.problems.join(' '), 'stay_invalid');
    }
    const ok = a.roomTypes.filter((x) => x.bookable);
    if (!ok.length) {
      const tooBig = a.roomTypes.every((x) => !x.fits);
      return out(tooBig ? t(st, `For ${stay.adults + stay.children} guests you will need more rooms — how many rooms would you like?`, `${stay.adults + stay.children} per-ku innum rooms venum — ethana rooms?`) : t(st, `Sorry, we are fully booked for ${prettyDay(stay.checkIn)} → ${prettyDay(stay.checkOut)}. Would you like to try other dates?`, `Sorry, ${prettyDay(stay.checkIn)} → ${prettyDay(stay.checkOut)} full. Vera dates try pannalama?`), tooBig ? 'ask_rooms' : 'sold_out');
    }
    s.offered = ok.map((x) => x.roomTypeId);
    s.step = 'choose_room';
    if (!s.enquiryLogged) {
      s.enquiryLogged = true;
      await this.followUps.onAbandonedEnquiry(ctx.org, ctx.customer.id, `${stay.checkIn}`);
    }
    return out(`${t(st, 'Available for', 'Available:')} ${prettyDay(stay.checkIn)} → ${prettyDay(stay.checkOut)} (${a.request.nights} ${a.request.nights === 1 ? 'night' : 'nights'}), ${stay.adults} ${stay.adults === 1 ? 'adult' : 'adults'}${stay.children ? ` + ${stay.children}` : ''}:\n${ok.map((x, k) => `${k + 1}. *${x.name}* — ${inr(x.quote!.total)} ${t(st, 'incl. tax', 'tax-oda')} (${x.available} ${t(st, 'left', 'left')})`).join('\n')}\n\n${t(st, 'Reply with the number to choose a room.', 'Room choose panna number reply pannunga.')}`, 'availability');
  }

  private async book(ctx: AgentCtx, s: HotelState): Promise<AgentOut<HotelState>> {
    const st = ctx.style;
    try {
      const r = await this.hotel.book(ctx.org, {
        roomTypeId: s.roomTypeId!, checkIn: s.checkIn!, checkOut: s.checkOut!, adults: s.adults!, children: s.children ?? 0, rooms: s.rooms ?? 1,
        customerId: ctx.customer.id, leadId: ctx.leadId, channel: ctx.channel === 'web' ? 'test' : ctx.channel,
        idempotencyKey: `chat:${ctx.conversationId}:${s.roomTypeId}:${s.checkIn}:${s.checkOut}:${s.adults}:${s.children ?? 0}:${s.rooms ?? 1}`,
        guestName: ctx.customer.name, guestPhone: ctx.customer.phone, actor: 'ai', isDemo: ctx.isDemo || ctx.customer.isDemo, now: ctx.now,
      });
      const res = r.reservation;
      if (r.status === 'created') await this.followUps.onReservation(ctx.org, { id: res.id, customerId: ctx.customer.id, status: res.status, checkIn: res.checkIn, checkOut: res.checkOut });
      resetState(s, newHotelState(), { lastReservationId: res.id });
      const head = res.status === 'confirmed'
        ? `✅ ${t(st, 'Booking confirmed!', 'Booking confirm aagiduchu!')} *${res.reference}*`
        : `📝 ${t(st, 'Booking request received:', 'Booking request vandhuduchu:')} *${res.reference}* — ${t(st, 'our front desk will confirm it shortly. Your room is held until', 'front desk seekiram confirm pannuvaanga. Room hold')} ${prettyTime(new Date(res.holdExpiresAt!))}.`;
      const deposit = res.depositAmount ? `\n${t(st, 'A deposit of', 'Deposit')} ${inr(res.depositAmount)} ${t(st, 'is required; our team will share payment details (online payment is not connected).', 'venum; payment details team share pannuvaanga.')}` : '';
      return {
        reply: `${head}\n${res.roomType.name}, ${prettyDay(res.checkIn)} → ${prettyDay(res.checkOut)} · ${inr(res.total)}${deposit}\n${t(st, 'Ask "my booking" anytime for the status.', '"my booking" nu kettu status therinjukkalam.')}`,
        state: s, intent: 'booked', outcome: 'booked', record: { type: 'reservation', id: res.id, reference: res.reference, status: res.status, result: r.status },
      };
    } catch (e) {
      s.step = 'collecting';
      s.roomTypeId = undefined;
      return { reply: `${t(st, 'I could not complete the booking:', 'Booking mudikka mudiyala:')} ${e instanceof Error ? e.message : String(e)}`, state: s, intent: 'booking_failed' };
    }
  }
}

export { istDay };
