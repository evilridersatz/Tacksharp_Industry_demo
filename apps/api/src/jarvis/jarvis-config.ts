/**
 * Jarvis settings, one block per organization inside OrganizationSettings.data.jarvis (no new table). Everything has a
 * safe default: digest on at 8:00 IST, monitors on with conservative thresholds, no cost rates (usage is shown in
 * units until the business enters its own prices; none are invented here).
 */
export const MONITOR_IDS = ['low_stock', 'handoff_waiting', 'pending_orders', 'missed_calls', 'sales_drop', 'instagram_waiting', 'mail_unread', 'usage_budget'] as const;
export type MonitorId = (typeof MONITOR_IDS)[number];

export type MonitorSetting = { on: boolean; threshold: number };
export type JarvisRates = {
  /** ₹ per minute of Sarvam voice agent (phone and dashboard calls). */
  sarvamAgentPerMin: number;
  /** ₹ per minute of the video presenter (Simli). */
  simliPerMin: number;
  /** ₹ per 1,000 OpenAI tokens (input and output together, as recorded). */
  openaiPer1kTokens: number;
  /** ₹ per WhatsApp message the business sent. */
  whatsappPerMsg: number;
};
export type JarvisConfig = {
  digest: { on: boolean; hour: number; minute: number };
  monitors: Record<MonitorId, MonitorSetting>;
  /** Minutes between monitor runs. */
  monitorEveryMin: number;
  rates: JarvisRates;
  /** Daily spend budget in ₹ for the usage_budget monitor (0 = off). */
  dailyBudget: number;
};

/** What each monitor checks, and what its threshold means (shown on the settings page). */
export const MONITOR_INFO: Record<MonitorId, { label: string; unit: string; help: string }> = {
  low_stock: { label: 'Low or out of stock', unit: 'items', help: 'Alert when at least this many products are at or below their low-stock level (or out).' },
  handoff_waiting: { label: 'Customers waiting for staff', unit: 'minutes', help: 'Alert when a conversation handed to staff has waited longer than this.' },
  pending_orders: { label: 'Orders not confirmed', unit: 'minutes', help: 'Alert when an order is still pending after this many minutes.' },
  missed_calls: { label: 'Missed or failed calls', unit: 'calls / hour', help: 'Alert when this many calls failed or went unanswered in the last hour.' },
  sales_drop: { label: 'Sales drop', unit: '% lower', help: 'Alert when today’s orders so far are this much lower than the same time last week (from noon, with at least 5 orders last week).' },
  instagram_waiting: { label: 'Instagram waiting', unit: 'minutes', help: 'Alert when an Instagram message or comment has waited longer than this for a reply.' },
  mail_unread: { label: 'Unread office mail', unit: 'mails', help: 'Alert when the office inbox has at least this many unread mails (Gmail connected under Integrations).' },
  usage_budget: { label: 'Daily spend budget', unit: '% of budget', help: 'Alert when today’s estimated spend reaches this share of the daily budget (needs rates and a budget).' },
};

export const DEFAULT_JARVIS: JarvisConfig = {
  digest: { on: true, hour: 8, minute: 0 },
  monitors: {
    low_stock: { on: true, threshold: 1 },
    handoff_waiting: { on: true, threshold: 15 },
    pending_orders: { on: true, threshold: 20 },
    missed_calls: { on: true, threshold: 3 },
    sales_drop: { on: true, threshold: 40 },
    instagram_waiting: { on: true, threshold: 60 },
    mail_unread: { on: false, threshold: 20 },
    usage_budget: { on: false, threshold: 80 },
  },
  monitorEveryMin: 10,
  rates: { sarvamAgentPerMin: 0, simliPerMin: 0, openaiPer1kTokens: 0, whatsappPerMsg: 0 },
  dailyBudget: 0,
};

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Merge a (partial, untrusted) patch over the current settings; unknown keys are dropped, numbers clamped. */
export function sanitizeJarvis(patch: unknown, current: JarvisConfig = DEFAULT_JARVIS): JarvisConfig {
  const p = obj(patch);
  const d = obj(p.digest);
  const m = obj(p.monitors);
  const r = obj(p.rates);
  const monitors = {} as Record<MonitorId, MonitorSetting>;
  for (const id of MONITOR_IDS) {
    const x = obj(m[id]);
    monitors[id] = { on: bool(x.on, current.monitors[id].on), threshold: num(x.threshold, 0, 100_000, current.monitors[id].threshold) };
  }
  return {
    digest: { on: bool(d.on, current.digest.on), hour: Math.round(num(d.hour, 0, 23, current.digest.hour)), minute: Math.round(num(d.minute, 0, 59, current.digest.minute)) },
    monitors,
    monitorEveryMin: Math.round(num(p.monitorEveryMin, 5, 240, current.monitorEveryMin)),
    rates: {
      sarvamAgentPerMin: num(r.sarvamAgentPerMin, 0, 1000, current.rates.sarvamAgentPerMin),
      simliPerMin: num(r.simliPerMin, 0, 1000, current.rates.simliPerMin),
      openaiPer1kTokens: num(r.openaiPer1kTokens, 0, 1000, current.rates.openaiPer1kTokens),
      whatsappPerMsg: num(r.whatsappPerMsg, 0, 100, current.rates.whatsappPerMsg),
    },
    dailyBudget: num(p.dailyBudget, 0, 10_000_000, current.dailyBudget),
  };
}

/** India time (UTC+05:30, no daylight saving): the start of a day, `daysAgo` days back, as a UTC Date. */
export const IST_OFFSET_MS = 330 * 60_000;
export function istDayStart(now: Date, daysAgo = 0): Date {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - daysAgo * 86_400_000;
  return new Date(midnightLocal - IST_OFFSET_MS);
}
/** Hour and minute in India time. */
export function istClock(now: Date): { hour: number; minute: number; date: string } {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  return { hour: local.getUTCHours(), minute: local.getUTCMinutes(), date: local.toISOString().slice(0, 10) };
}
