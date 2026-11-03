import { nextAllowedCallTime } from '../common/time.js';

export type DripChannel = 'whatsapp' | 'voice';
export interface DripStep {
  /** Days after enrolment (0 = at once, inside the sending hours). */
  day: number;
  channel: DripChannel;
  /** WhatsApp text (used while the customer's 24 h window is open). {name} and {business} are filled in. */
  text?: string;
  /** Approved WhatsApp template used when the 24 h window is closed (body variables: {{1}} name, {{2}} business). */
  templateName?: string;
  templateLanguage?: string;
}

export const MAX_STEPS = 10;
export const MAX_DAY = 90;
export const STOP_REASONS = ['opted_out', 'do_not_contact', 'converted', 'ordered', 'human_owner', 'customer_replied', 'sequence_paused', 'stopped_by_user', 'customer_missing', 'lost'] as const;

/** Validates and normalises a step list. Returns field errors (empty = valid). */
export function validateSteps(input: unknown): { steps: DripStep[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!Array.isArray(input) || input.length === 0) return { steps: [], errors: { steps: 'Add at least one step' } };
  if (input.length > MAX_STEPS) return { steps: [], errors: { steps: `At most ${MAX_STEPS} steps` } };
  const steps: DripStep[] = [];
  let prevDay = -1;
  input.forEach((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const day = Number(s.day);
    if (!Number.isInteger(day) || day < 0 || day > MAX_DAY) errors[`steps.${i}.day`] = `Day must be a whole number 0-${MAX_DAY}`;
    else if (day < prevDay) errors[`steps.${i}.day`] = 'Steps must be in day order';
    prevDay = Number.isInteger(day) ? day : prevDay;
    const channel = s.channel === 'voice' ? 'voice' : s.channel === 'whatsapp' ? 'whatsapp' : null;
    if (!channel) errors[`steps.${i}.channel`] = 'Channel must be whatsapp or voice';
    const text = typeof s.text === 'string' ? s.text.trim().slice(0, 1000) : '';
    const templateName = typeof s.templateName === 'string' ? s.templateName.trim() : '';
    if (templateName && !/^[a-z0-9_]{1,512}$/.test(templateName)) errors[`steps.${i}.templateName`] = 'Template names are lower-case letters, digits and _';
    if (channel === 'whatsapp' && !text && !templateName) errors[`steps.${i}.text`] = 'A WhatsApp step needs a message or an approved template';
    const templateLanguage = typeof s.templateLanguage === 'string' && /^[a-z]{2}(_[A-Z]{2})?$/.test(s.templateLanguage) ? s.templateLanguage : undefined;
    steps.push({
      day: Number.isInteger(day) ? day : 0,
      channel: channel ?? 'whatsapp',
      ...(channel === 'whatsapp' && text ? { text } : {}),
      ...(channel === 'whatsapp' && templateName ? { templateName, templateLanguage: templateLanguage ?? 'en' } : {}),
    });
  });
  return { steps, errors };
}

export function validateHours(start: unknown, end: unknown): { start: number; end: number } | null {
  const s = Number(start ?? 9), e = Number(end ?? 20);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 24 || e <= s) return null;
  return { start: s, end: e };
}

/** When step `index` is due: enrolment + its day offset (scaled for tests), moved into the sending hours. */
export function dueAt(enrolledAt: Date, step: DripStep, hours: { start: number; end: number }, timeScale = 1, now = new Date()): Date {
  const raw = new Date(enrolledAt.getTime() + step.day * 86_400_000 * timeScale);
  const at = raw < now ? now : raw;
  return nextAllowedCallTime(at, hours.start, hours.end);
}

export function fill(text: string, v: { name: string; business: string }) {
  return text.replace(/\{name\}/g, v.name).replace(/\{business\}/g, v.business);
}

/** Starting points per industry (Day 0 / 1 / 3 / 5 AI call / 7). The business edits them before activating. */
const BASE: Record<string, { name: string; texts: [string, string, string, string] }> = {
  restaurant: {
    name: 'Order reminder',
    texts: [
      'Hi {name}, thanks for contacting {business}! Reply with what you would like and we will check today\'s menu and prices for you.',
      'Hi {name}, fresh stock is in at {business} today. Shall we keep your order ready? Reply here to order.',
      'Hi {name}, weekend orders at {business} fill up fast. Reply with your order and pickup time.',
      'Hi {name}, we miss you at {business}! Reply ORDER any time. Reply STOP to stop these messages.',
    ],
  },
  real_estate: {
    name: 'New lead nurture',
    texts: [
      'Hi {name}, thanks for your interest in {business}. Could you share your preferred location and budget?',
      'Hi {name}, we have shortlisted homes that may fit your needs. Would you like details or a site visit?',
      'Hi {name}, site visits are open this week. Reply with a day that suits you.',
      'Hi {name}, just checking in from {business}. Reply any time if you are still looking. Reply STOP to stop these messages.',
    ],
  },
  textile: {
    name: 'Enquiry follow-up',
    texts: [
      'Hi {name}, thanks for contacting {business}! Tell us the fabric, occasion or budget and we will share options.',
      'Hi {name}, new arrivals are in at {business}. Would you like photos and prices?',
      'Hi {name}, your enquiry is still open with us. Reply here and we will prepare a quotation.',
      'Hi {name}, we are here whenever you are ready. Reply STOP to stop these messages.',
    ],
  },
  hospital: {
    name: 'Appointment follow-up',
    texts: [
      'Hello {name}, thank you for contacting {business}. Reply with the department and a preferred day to book an appointment.',
      'Hello {name}, would you like us to book your consultation? Reply with a convenient day.',
      'Hello {name}, OPD slots are available this week. Reply here to book.',
      'Hello {name}, we are here if you need us. Reply STOP to stop these messages.',
    ],
  },
  hotel: {
    name: 'Booking follow-up',
    texts: [
      'Hi {name}, thanks for contacting {business}. Share your dates and number of guests and we will check availability.',
      'Hi {name}, rooms for your dates are still available. Shall we hold one for you?',
      'Hi {name}, availability is filling up for the coming weekend. Reply to book.',
      'Hi {name}, we would love to host you at {business}. Reply STOP to stop these messages.',
    ],
  },
  generic: {
    name: 'Lead follow-up',
    texts: [
      'Hi {name}, thanks for contacting {business}! How can we help you today?',
      'Hi {name}, just following up on your enquiry. Reply here with any questions.',
      'Hi {name}, we are still holding your enquiry open. Shall we take it forward?',
      'Hi {name}, we are here whenever you are ready. Reply STOP to stop these messages.',
    ],
  },
};
const ALIAS: Record<string, string> = { food: 'restaurant', retail: 'textile' };

export function presetFor(vertical: string | null | undefined): { name: string; steps: DripStep[] } {
  const key = ALIAS[vertical ?? ''] ?? vertical ?? 'generic';
  const p = BASE[key] ?? BASE.generic;
  return {
    name: p.name,
    steps: [
      { day: 0, channel: 'whatsapp', text: p.texts[0] },
      { day: 1, channel: 'whatsapp', text: p.texts[1] },
      { day: 3, channel: 'whatsapp', text: p.texts[2] },
      { day: 5, channel: 'voice' },
      { day: 7, channel: 'whatsapp', text: p.texts[3] },
    ],
  };
}
