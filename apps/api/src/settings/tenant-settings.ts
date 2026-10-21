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
  /** Which sales assistant this business uses. real_estate (default) is unchanged; textile switches the AI agent,
   *  dashboard pages and follow-ups to the textile catalogue / quotation / order flow. */
  industry: 'real_estate' | 'textile' | 'retail' | 'manufacturing' | 'agency' | 'food' | 'hotel' | 'hospital' | 'cctv';
  /** Restaurant & food ordering (cafes, cloud kitchens, takeaway). GR Chicken keeps its own engine and settings. */
  food: {
    /** Tax % applied to items without their own tax rate (GST on restaurant food is usually 5%). */
    taxPct: number;
    packagingFee: number;
    pickupEnabled: boolean;
    deliveryEnabled: boolean;
    /** Delivery zones: area keywords the customer may say, a fee, a minimum order and an ETA. */
    deliveryZones: Array<{ name: string; keywords: string[]; fee: number; minOrder: number; etaMinutes: number }>;
    faqs: Array<{ q: string; a: string }>;
  };
  /** Hotel & room booking. Rates and availability always come from room types / rates / reservations. */
  hotel: {
    checkInTime: string;
    checkOutTime: string;
    taxPct: number;
    /** false = a reservation made by the assistant waits for staff confirmation (it holds the room meanwhile). */
    autoConfirm: boolean;
    /** Minutes a pending reservation holds inventory before it expires. */
    holdMinutes: number;
    /** Deposit % of the total. There is no payment integration: deposits are recorded manually or simulated. */
    depositPct: number;
    freeCancellationHours: number;
    cancellationPolicy: string;
    maxNights: number;
    faqs: Array<{ q: string; a: string }>;
  };
  /** Hospital & healthcare (administrative assistant only). */
  hospital: {
    emergencyNumber: string;
    bookingWindowDays: number;
    reminderHoursBefore: number;
    faqs: Array<{ q: string; a: string }>;
  };
  /** CCTV camera health & downtime monitoring (Tacksharp VisionOps). Status is decided by code from health checks. */
  /** Demo workspaces only: simulated live activity (chats, calls, follow-ups, orders, bookings) every minute. Never real customers. */
  demoLive: { enabled: boolean; since: string | null };
  monitoring: {
    /** Consecutive failed checks before a fault is confirmed (and one incident opened). */
    failureThreshold: number;
    /** ...and the device must have been failing at least this long (debounce against blips). */
    debounceSeconds: number;
    /** Consecutive successful fresh checks required before an incident is resolved by verification. */
    restoreSuccesses: number;
    /** No heartbeat from a site agent for this long: its devices become "unknown" (never "offline"). */
    staleAfterMinutes: number;
    /** The same fault on the same device within this window after resolution reopens the incident. */
    correlationWindowMinutes: number;
    /** No acknowledgment within this many minutes: escalate to the supervisor. */
    ackDeadlineMinutes: number;
    /** Further escalation (supervisor -> manager) this many minutes after the previous level. */
    escalationStepMinutes: number;
    /** Non-critical alerts inside quiet hours wait until the end; critical ones go to on-call people. */
    quietHours: { enabled: boolean; start: string; end: string };
    /** Send the customer a resolution summary (only for customers that opted in). */
    notifyCustomerOnResolution: boolean;
    /** Voice escalation calls. Off by default; demo / DRY_RUN never call. */
    voiceEscalation: boolean;
    /** Approved WhatsApp template (one body variable) for alerts when the 24-hour window is closed. */
    alertTemplate: string;
    /** Estimated cost per WhatsApp message (INR) for cost tracking; 0 = not set. */
    whatsappCostInr: number;
    /** Sellable plans; prices are configurable and subject to cost validation. */
    plans: Array<{ code: string; name: string; pricePerCameraInr: number; features: string[] }>;
    /** Raw health checks and heartbeats older than this are deleted (incidents, timelines and uptime are kept). */
    retentionDays: number;
    /** Demo workspaces only: a simulated site agent sends live checks through the real pipeline. Never real devices. */
    liveDemo: { enabled: boolean; since: string | null };
  };
  textile: {
    /** Days after a quotation is sent before the customer gets one reminder (0 = no reminder). */
    quoteReminderDays: number;
    /** Hours after an order is marked delivered before the feedback request goes out (0 = no request). */
    feedbackAfterHours: number;
    /** Tell the customer on WhatsApp when a salesperson moves their order to dispatched / delivered. */
    notifyOrderStatus: boolean;
    /** A quotation discount above this % of the subtotal needs an approver with sales.approve_discount. */
    maxDiscountPct: number;
  };
  /** Finance (textile). Tax is never assumed: an invoice takes the tax % agreed on the quotation, or one entered. */
  finance: {
    /** Due date = invoice date + this many days (shown on the invoice; editable per invoice). */
    paymentTermsDays: number;
    /** Before an order may be marked ready to dispatch: none | any_verified (some verified payment) | full (invoice paid). */
    dispatchPaymentRule: 'none' | 'any_verified' | 'full';
    /** Finance agent drafts an invoice when an order is confirmed (a person still approves and issues it). */
    autoDraftInvoice: boolean;
  };
  /** AI agents: a paused agent takes no new work (its tasks wait as PENDING until resumed). */
  agents: { paused: Array<'marketing' | 'sales' | 'finance' | 'operations'> };
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
  industry: 'real_estate',
  food: { taxPct: 5, packagingFee: 0, pickupEnabled: true, deliveryEnabled: false, deliveryZones: [], faqs: [] },
  hotel: {
    checkInTime: '14:00', checkOutTime: '11:00', taxPct: 12, autoConfirm: false, holdMinutes: 120, depositPct: 0, freeCancellationHours: 24,
    cancellationPolicy: 'Free cancellation up to 24 hours before check-in; after that the first night is charged.', maxNights: 30, faqs: [],
  },
  hospital: { emergencyNumber: '108', bookingWindowDays: 14, reminderHoursBefore: 24, faqs: [] },
  demoLive: { enabled: false, since: null },
  monitoring: {
    failureThreshold: 3, debounceSeconds: 180, restoreSuccesses: 3, staleAfterMinutes: 10, correlationWindowMinutes: 30,
    ackDeadlineMinutes: 15, escalationStepMinutes: 30, quietHours: { enabled: true, start: '22:00', end: '07:00' },
    notifyCustomerOnResolution: true, voiceEscalation: false, alertTemplate: '', whatsappCostInr: 0, retentionDays: 90, liveDemo: { enabled: false, since: null },
    plans: [
      { code: 'basic', name: 'Basic monitoring', pricePerCameraInr: 30, features: ['Health checks', 'Offline alerts', 'Camera status dashboard', 'Basic uptime report', 'Incident history'] },
      { code: 'pro', name: 'Service desk', pricePerCameraInr: 45, features: ['Everything in Basic', 'WhatsApp follow-ups & acknowledgment', 'Escalation workflow', 'Multi-site analytics', 'Local agent management'] },
      { code: 'sla', name: 'SLA & AMC', pricePerCameraInr: 60, features: ['Everything in Service desk', 'SLA & AMC reports', 'Customer resolution reports', 'Voice escalation (when verified)'] },
    ],
  },
  textile: { quoteReminderDays: 2, feedbackAfterHours: 24, notifyOrderStatus: true, maxDiscountPct: 10 },
  agents: { paused: [] },
  finance: { paymentTermsDays: 15, dispatchPaymentRule: 'none', autoDraftInvoice: true },
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
const hhmm = (v: unknown, fallback: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : fallback);
const faqs = (v: unknown, fallback: Array<{ q: string; a: string }>) =>
  Array.isArray(v) ? v.slice(0, 30).map((f) => ({ q: str(obj(f).q, '', 200), a: str(obj(f).a, '', 600) })).filter((f) => f.q && f.a) : fallback;

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
  const tx = obj(i.textile);
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

  const fd = obj(i.food), ht = obj(i.hotel), hp = obj(i.hospital);
  const bf = base.food ?? DEFAULT_SETTINGS.food, bh = base.hotel ?? DEFAULT_SETTINGS.hotel, bp = base.hospital ?? DEFAULT_SETTINGS.hospital;
  const zones = Array.isArray(fd.deliveryZones)
    ? fd.deliveryZones.slice(0, 20).map((z) => {
        const o = obj(z);
        const name = str(o.name, '', 60);
        const keywords = (Array.isArray(o.keywords) ? o.keywords : String(o.keywords ?? '').split(','))
          .map((k) => String(k).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 15);
        return { name, keywords: keywords.length ? keywords : name ? [name.toLowerCase()] : [], fee: num(o.fee, 0, 0, 2000, false), minOrder: num(o.minOrder, 0, 0, 100_000, false), etaMinutes: num(o.etaMinutes, 45, 5, 240) };
      }).filter((z) => z.name)
    : bf.deliveryZones;

  return {
    industry: (['real_estate', 'textile', 'retail', 'manufacturing', 'agency', 'food', 'hotel', 'hospital', 'cctv'] as const).includes(i.industry as never) ? (i.industry as TenantSettings['industry']) : base.industry,
    food: {
      taxPct: num(fd.taxPct, bf.taxPct, 0, 28, false),
      packagingFee: num(fd.packagingFee, bf.packagingFee, 0, 500, false),
      pickupEnabled: bool(fd.pickupEnabled, bf.pickupEnabled),
      deliveryEnabled: bool(fd.deliveryEnabled, bf.deliveryEnabled),
      deliveryZones: zones,
      faqs: faqs(fd.faqs, bf.faqs),
    },
    hotel: {
      checkInTime: hhmm(ht.checkInTime, bh.checkInTime),
      checkOutTime: hhmm(ht.checkOutTime, bh.checkOutTime),
      taxPct: num(ht.taxPct, bh.taxPct, 0, 28, false),
      autoConfirm: bool(ht.autoConfirm, bh.autoConfirm),
      holdMinutes: num(ht.holdMinutes, bh.holdMinutes, 10, 24 * 60),
      depositPct: num(ht.depositPct, bh.depositPct, 0, 100),
      freeCancellationHours: num(ht.freeCancellationHours, bh.freeCancellationHours, 0, 24 * 30),
      cancellationPolicy: str(ht.cancellationPolicy, bh.cancellationPolicy, 600),
      maxNights: num(ht.maxNights, bh.maxNights, 1, 90),
      faqs: faqs(ht.faqs, bh.faqs),
    },
    hospital: {
      emergencyNumber: /^[0-9+ -]{3,20}$/.test(str(hp.emergencyNumber, bp.emergencyNumber, 20)) ? str(hp.emergencyNumber, bp.emergencyNumber, 20) : bp.emergencyNumber,
      bookingWindowDays: num(hp.bookingWindowDays, bp.bookingWindowDays, 1, 90),
      reminderHoursBefore: num(hp.reminderHoursBefore, bp.reminderHoursBefore, 0, 72),
      faqs: faqs(hp.faqs, bp.faqs),
    },
    monitoring: sanitizeMonitoring(obj(i.monitoring), base.monitoring ?? DEFAULT_SETTINGS.monitoring),
    demoLive: sanitizeLiveDemo(obj(i.demoLive), base.demoLive ?? { enabled: false, since: null }),
    textile: {
      quoteReminderDays: num(tx.quoteReminderDays, base.textile.quoteReminderDays, 0, 30),
      feedbackAfterHours: num(tx.feedbackAfterHours, base.textile.feedbackAfterHours, 0, 24 * 14),
      notifyOrderStatus: bool(tx.notifyOrderStatus, base.textile.notifyOrderStatus),
      maxDiscountPct: num(tx.maxDiscountPct, base.textile.maxDiscountPct ?? 10, 0, 100),
    },
    finance: {
      paymentTermsDays: num(obj(i.finance).paymentTermsDays, base.finance?.paymentTermsDays ?? 15, 0, 365),
      dispatchPaymentRule: ['none', 'any_verified', 'full'].includes(obj(i.finance).dispatchPaymentRule as string)
        ? (obj(i.finance).dispatchPaymentRule as TenantSettings['finance']['dispatchPaymentRule'])
        : (base.finance?.dispatchPaymentRule ?? 'none'),
      autoDraftInvoice: bool(obj(i.finance).autoDraftInvoice, base.finance?.autoDraftInvoice ?? true),
    },
    agents: {
      paused: Array.isArray(obj(i.agents).paused)
        ? ([...new Set((obj(i.agents).paused as unknown[]).filter((a) => typeof a === 'string' && ['marketing', 'sales', 'finance', 'operations'].includes(a)))] as TenantSettings['agents']['paused'])
        : (base.agents?.paused ?? []),
    },
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

function sanitizeMonitoring(m: Record<string, unknown>, b: TenantSettings['monitoring']): TenantSettings['monitoring'] {
  const q = obj(m.quietHours);
  const plans = Array.isArray(m.plans)
    ? m.plans.slice(0, 6).map((p) => {
        const o = obj(p);
        const code = str(o.code, '', 30).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        return { code, name: str(o.name, code, 60), pricePerCameraInr: num(o.pricePerCameraInr, 0, 0, 10_000, false), features: (Array.isArray(o.features) ? o.features : []).map((f) => str(f, '', 80)).filter(Boolean).slice(0, 12) };
      }).filter((p) => p.code)
    : b.plans;
  return {
    failureThreshold: num(m.failureThreshold, b.failureThreshold, 1, 20),
    debounceSeconds: num(m.debounceSeconds, b.debounceSeconds, 0, 3600),
    restoreSuccesses: num(m.restoreSuccesses, b.restoreSuccesses, 1, 20),
    staleAfterMinutes: num(m.staleAfterMinutes, b.staleAfterMinutes, 2, 24 * 60),
    correlationWindowMinutes: num(m.correlationWindowMinutes, b.correlationWindowMinutes, 0, 24 * 60),
    ackDeadlineMinutes: num(m.ackDeadlineMinutes, b.ackDeadlineMinutes, 1, 24 * 60),
    escalationStepMinutes: num(m.escalationStepMinutes, b.escalationStepMinutes, 1, 24 * 60),
    quietHours: { enabled: bool(q.enabled, b.quietHours.enabled), start: hhmm(q.start, b.quietHours.start), end: hhmm(q.end, b.quietHours.end) },
    notifyCustomerOnResolution: bool(m.notifyCustomerOnResolution, b.notifyCustomerOnResolution),
    voiceEscalation: bool(m.voiceEscalation, b.voiceEscalation),
    alertTemplate: /^[a-z0-9_]*$/.test(str(m.alertTemplate, b.alertTemplate, 100)) ? str(m.alertTemplate, b.alertTemplate, 100) : b.alertTemplate,
    whatsappCostInr: num(m.whatsappCostInr, b.whatsappCostInr, 0, 100, false),
    plans: plans.length ? plans : b.plans,
    retentionDays: num(m.retentionDays, b.retentionDays ?? 90, 2, 730),
    liveDemo: sanitizeLiveDemo(obj(m.liveDemo), b.liveDemo ?? { enabled: false, since: null }),
  };
}

function sanitizeLiveDemo(l: Record<string, unknown>, b: { enabled: boolean; since: string | null }) {
  const since = typeof l.since === 'string' && !Number.isNaN(Date.parse(l.since)) ? new Date(l.since).toISOString() : l.since === null ? null : b.since;
  return { enabled: bool(l.enabled, b.enabled), since };
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
