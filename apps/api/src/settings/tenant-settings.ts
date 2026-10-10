import { config } from '../common/config.js';
import { normalizePhone } from '../common/phone.js';
import { nextAllowedCallTime } from '../common/time.js';

/**
 * Per-business (tenant) automation settings, edited from the dashboard Settings page.
 * Stored as one JSON document per organization; anything missing falls back to DEFAULT_SETTINGS.
 * The deployment's .env stays the hard outer limit (e.g. the legal calling window): a tenant can
 * only make it narrower, never wider.
 */
export type TenantSettings = {
  speedToLead: {
    /** Call a new Meta lead almost immediately (inside calling hours) instead of after the WhatsApp steps. */
    instantCall: boolean;
    /** Minutes between the lead arriving and the AI call (the WhatsApp intro goes out at once). */
    callDelayMinutes: number;
  };
  calling: {
    /** IST hours; clamped inside VOICE_CALL_WINDOW_START / _END from .env. */
    windowStartHour: number;
    windowEndHour: number;
    /** Automatic call attempts per lead, first call included. */
    maxAttempts: number;
    /** Attempt 2 runs this many minutes after an unanswered attempt 1. */
    retryAfterMinutes: number;
    /** Attempt 3 and later run the next day at this IST hour. */
    nextDayRetryHour: number;
  };
  nurture: {
    /** WhatsApp "sorry we missed you" a couple of minutes after the first unanswered call. */
    missedCallWhatsApp: boolean;
    /** WhatsApp-only touches N days after the lead, for leads never reached. */
    followUpDays: number[];
  };
  visits: {
    /** WhatsApp the customer the day before asking them to confirm (a "yes" reply confirms the visit). */
    confirmDayBefore: boolean;
    /** WhatsApp reminder with the location this many hours before (0 = off). */
    reminderHoursBefore: number;
    /** Alert the sales team this many minutes before (0 = off). */
    teamAlertMinutesBefore: number;
    /** After the visit time: thank-you if visited, reschedule offer if no-show, else ask the team to mark it. */
    afterVisit: boolean;
    /** Site address and map link per property id, sent in reminders. */
    sites: Record<string, { address?: string; mapUrl?: string }>;
  };
  team: {
    /** Sales team WhatsApp numbers (digits with country code). Alerts go to every number. */
    alertPhones: string[];
    alertOnBooking: boolean;
    alertOnHotLead: boolean;
    /**
     * Approved WhatsApp template for team alerts (one body variable). Needed because WhatsApp only
     * allows free text to a number that messaged the business in the last 24 hours.
     */
    alertTemplate: string;
  };
  hotLead: {
    enabled: boolean;
    /** A lead is hot when they plan to buy within this many days and we showed a matching property. */
    maxTimelineDays: number;
  };
  roi: {
    /** Average ad cost per lead, for "cost per attended visit". */
    costPerLeadInr: number;
    /** Voice cost per connected minute (Plivo + Sarvam + OpenAI); 0 = not counted. */
    voiceCostPerMinuteInr: number;
    /** WhatsApp cost per message sent; 0 = not counted. */
    whatsappCostPerMessageInr: number;
  };
};

export const DEFAULT_SETTINGS: TenantSettings = {
  speedToLead: { instantCall: true, callDelayMinutes: 1 },
  calling: { windowStartHour: 9, windowEndHour: 20, maxAttempts: 3, retryAfterMinutes: 30, nextDayRetryHour: 11 },
  nurture: { missedCallWhatsApp: true, followUpDays: [3, 7] },
  visits: { confirmDayBefore: true, reminderHoursBefore: 2, teamAlertMinutesBefore: 30, afterVisit: true, sites: {} },
  team: { alertPhones: [], alertOnBooking: true, alertOnHotLead: true, alertTemplate: '' },
  hotLead: { enabled: true, maxTimelineDays: 30 },
  roi: { costPerLeadInr: 400, voiceCostPerMinuteInr: 0, whatsappCostPerMessageInr: 0 },
};

const num = (v: unknown, fallback: number, min: number, max: number, integer = true) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const str = (v: unknown, fallback: string, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Only http(s) links are stored, so a reminder can never carry a javascript: or data: URL. */
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge user input over a base (stored settings or defaults), dropping unknown keys and clamping every
 * value to a safe range. Never throws: bad values fall back to the base value.
 */
export function sanitizeSettings(input: unknown, base: TenantSettings = DEFAULT_SETTINGS): TenantSettings {
  const i = obj(input);
  const s = obj(i.speedToLead), c = obj(i.calling), n = obj(i.nurture), v = obj(i.visits), t = obj(i.team), h = obj(i.hotLead), r = obj(i.roi);

  // Stored inside the deployment's legal window, so what the Settings page shows is what really applies.
  const legalStart = config.voice.callWindowStartHour, legalEnd = config.voice.callWindowEndHour;
  let windowStartHour = num(c.windowStartHour, base.calling.windowStartHour, legalStart, legalEnd - 1);
  let windowEndHour = num(c.windowEndHour, base.calling.windowEndHour, legalStart + 1, legalEnd);
  if (windowEndHour <= windowStartHour) {
    windowStartHour = base.calling.windowStartHour;
    windowEndHour = base.calling.windowEndHour;
  }

  const days = Array.isArray(n.followUpDays)
    ? [...new Set(n.followUpDays.map((d) => num(d, -1, 1, 60)).filter((d) => d > 0))].sort((a, b) => a - b).slice(0, 5)
    : base.nurture.followUpDays;

  const sitesIn = v.sites === undefined ? base.visits.sites : obj(v.sites);
  const sites: TenantSettings['visits']['sites'] = {};
  for (const [propertyId, raw] of Object.entries(sitesIn).slice(0, 500)) {
    if (!/^[\w-]{1,64}$/.test(propertyId)) continue;
    const site = obj(raw);
    const address = str(site.address, '', 300) || undefined;
    const mapUrl = safeUrl(site.mapUrl);
    if (address || mapUrl) sites[propertyId] = { ...(address ? { address } : {}), ...(mapUrl ? { mapUrl } : {}) };
  }

  const phones = Array.isArray(t.alertPhones)
    ? [...new Set(t.alertPhones.map((p) => normalizePhone(String(p ?? ''))).filter((p): p is string => Boolean(p) && p!.length >= 10))].slice(0, 10)
    : base.team.alertPhones;

  return {
    speedToLead: {
      instantCall: bool(s.instantCall, base.speedToLead.instantCall),
      callDelayMinutes: num(s.callDelayMinutes, base.speedToLead.callDelayMinutes, 0, 120),
    },
    calling: {
      windowStartHour,
      windowEndHour,
      maxAttempts: num(c.maxAttempts, base.calling.maxAttempts, 1, 6),
      retryAfterMinutes: num(c.retryAfterMinutes, base.calling.retryAfterMinutes, 5, 24 * 60),
      nextDayRetryHour: num(c.nextDayRetryHour, base.calling.nextDayRetryHour, 0, 23),
    },
    nurture: {
      missedCallWhatsApp: bool(n.missedCallWhatsApp, base.nurture.missedCallWhatsApp),
      followUpDays: days,
    },
    visits: {
      confirmDayBefore: bool(v.confirmDayBefore, base.visits.confirmDayBefore),
      reminderHoursBefore: num(v.reminderHoursBefore, base.visits.reminderHoursBefore, 0, 12),
      teamAlertMinutesBefore: num(v.teamAlertMinutesBefore, base.visits.teamAlertMinutesBefore, 0, 240),
      afterVisit: bool(v.afterVisit, base.visits.afterVisit),
      sites,
    },
    team: {
      alertPhones: phones,
      alertOnBooking: bool(t.alertOnBooking, base.team.alertOnBooking),
      alertOnHotLead: bool(t.alertOnHotLead, base.team.alertOnHotLead),
      alertTemplate: /^[a-z0-9_]*$/.test(str(t.alertTemplate, base.team.alertTemplate, 100)) ? str(t.alertTemplate, base.team.alertTemplate, 100) : base.team.alertTemplate,
    },
    hotLead: {
      enabled: bool(h.enabled, base.hotLead.enabled),
      maxTimelineDays: num(h.maxTimelineDays, base.hotLead.maxTimelineDays, 1, 365),
    },
    roi: {
      costPerLeadInr: num(r.costPerLeadInr, base.roi.costPerLeadInr, 0, 100_000, false),
      voiceCostPerMinuteInr: num(r.voiceCostPerMinuteInr, base.roi.voiceCostPerMinuteInr, 0, 1000, false),
      whatsappCostPerMessageInr: num(r.whatsappCostPerMessageInr, base.roi.whatsappCostPerMessageInr, 0, 1000, false),
    },
  };
}

/** The tenant's calling window, never wider than the deployment's legal window from .env. */
export function effectiveCallWindow(s: TenantSettings): { start: number; end: number } {
  const start = Math.max(s.calling.windowStartHour, config.voice.callWindowStartHour);
  const end = Math.min(s.calling.windowEndHour, config.voice.callWindowEndHour);
  return end > start ? { start, end } : { start: config.voice.callWindowStartHour, end: config.voice.callWindowEndHour };
}

const IST_MS = 330 * 60_000;

/**
 * When to try again after unanswered call number `attempt` (1-based). undefined = no more automatic calls.
 *   attempt 1 -> +retryAfterMinutes;  attempt 2+ -> next day at nextDayRetryHour IST;  always inside the window.
 */
export function nextRetryAt(attempt: number, now: Date, s: TenantSettings, timeScale = 1): Date | undefined {
  if (attempt >= s.calling.maxAttempts) return undefined;
  const w = effectiveCallWindow(s);
  if (attempt <= 1) return nextAllowedCallTime(new Date(now.getTime() + s.calling.retryAfterMinutes * 60_000 * timeScale), w.start, w.end);
  if (timeScale !== 1) return nextAllowedCallTime(new Date(now.getTime() + 24 * 60 * 60_000 * timeScale), w.start, w.end);
  const ist = new Date(now.getTime() + IST_MS);
  const hour = Math.min(Math.max(s.calling.nextDayRetryHour, w.start), w.end - 1);
  const target = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, hour, 0, 0) - IST_MS;
  return new Date(target);
}

/**
 * Days until purchase from the customer's own words, when they can be read ("immediately", "this month",
 * "within 2 weeks", "3 months"). undefined = unknown, which is never treated as hot.
 */
export function timelineDays(timeline: string | null | undefined): number | undefined {
  const t = (timeline ?? '').toLowerCase();
  if (!t) return undefined;
  if (/immediate|urgent|asap|right away|this week|உடனே|udane|udanae/.test(t)) return 7;
  if (/this month|next month/.test(t)) return 30;
  const m = t.match(/(\d+|one|two|three|four|six)\s*(day|week|month|year)/);
  if (!m) return undefined;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, six: 6 };
  const n = Number(m[1]) || words[m[1]] || 0;
  const unit = m[2] === 'day' ? 1 : m[2] === 'week' ? 7 : m[2] === 'month' ? 30 : 365;
  return n * unit;
}

export function isHotLead(s: TenantSettings, lead: { timeline?: string | null; matchingPropertyShown: boolean }): boolean {
  if (!s.hotLead.enabled || !lead.matchingPropertyShown) return false;
  const days = timelineDays(lead.timeline);
  return days !== undefined && days <= s.hotLead.maxTimelineDays;
}
