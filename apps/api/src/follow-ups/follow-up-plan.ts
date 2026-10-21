import type { TenantSettings } from '../settings/tenant-settings.js';

/**
 * Speed-to-lead sequence (default): the WhatsApp intro goes out at once and the AI calls about a minute
 * later (inside calling hours). Unanswered calls are retried by the call's own outcome handling
 * (+30 min, then next day); WhatsApp-only nurture touches follow on the configured days.
 * Every step re-checks state before running, so a reply, a booking or an opt-out stops the rest.
 */
export function speedToLeadSequence(s: TenantSettings): Array<{ afterMinutes: number; channel: 'whatsapp' | 'voice'; step: string }> {
  return [
    { afterMinutes: 0, channel: 'whatsapp', step: 'first_contact' },
    { afterMinutes: s.speedToLead.callDelayMinutes, channel: 'voice', step: 'call' },
    ...s.nurture.followUpDays.map((d) => ({ afterMinutes: d * 24 * 60, channel: 'whatsapp' as const, step: `nurture_day${d}` })),
  ];
}

/** "visit:reminder:<siteVisitId>" / "alert:booked:<siteVisitId>" -> the visit id (hot-lead alerts carry a lead id). */
export function visitIdOf(message: string | null | undefined): string | undefined {
  const m = (message ?? '').match(/^(?:visit:(?:confirm|reminder|after)|alert:(?:booked|visit_soon)):(.+)$/);
  return m?.[1];
}
