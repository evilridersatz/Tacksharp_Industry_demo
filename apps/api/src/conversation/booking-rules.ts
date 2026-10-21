/**
 * Pure time rules for a site visit. The database checks (property exists/available, lead belongs
 * to the customer, duplicates) live in SiteVisitsService.validateSiteVisitBooking and call this.
 */
import { istParts } from './when.js';

export const VISIT_RULES = {
  minLeadMinutes: 30,
  maxDaysAhead: 60,
  /** Visits start between 09:00 and 19:59 IST. */
  startHour: Number(process.env.SITE_VISIT_START_HOUR ?? 9),
  endHourExclusive: Number(process.env.SITE_VISIT_END_HOUR ?? 20),
};

export type TimeCheck =
  | { ok: true; at: Date }
  | { ok: false; code: 'invalid' | 'past' | 'too_soon' | 'too_far' | 'outside_hours'; message: string };

export function checkVisitTime(value: string | Date | undefined | null, now: Date = new Date(), rules = VISIT_RULES): TimeCheck {
  if (value === undefined || value === null || value === '') return { ok: false, code: 'invalid', message: 'No date/time was given.' };
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return { ok: false, code: 'invalid', message: 'Invalid date/time.' };
  if (at.getTime() <= now.getTime()) return { ok: false, code: 'past', message: 'That time has already passed.' };
  if (at.getTime() < now.getTime() + rules.minLeadMinutes * 60_000) return { ok: false, code: 'too_soon', message: `Visits need at least ${rules.minLeadMinutes} minutes notice.` };
  if (at.getTime() > now.getTime() + rules.maxDaysAhead * 86_400_000) return { ok: false, code: 'too_far', message: `Visits can be booked up to ${rules.maxDaysAhead} days ahead.` };
  const p = istParts(at);
  if (p.hour < rules.startHour || p.hour >= rules.endHourExclusive) return { ok: false, code: 'outside_hours', message: `Visits run ${rules.startHour}:00 to ${rules.endHourExclusive}:00 IST.` };
  return { ok: true, at };
}
