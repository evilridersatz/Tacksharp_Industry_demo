import { describe, expect, it } from 'vitest';
import { DEFAULT_JARVIS, istClock, istDayStart, sanitizeJarvis } from './jarvis-config.js';
import { digestLines, evaluateMonitors, factSheet } from './jarvis-logic.js';
import { checkInstagram, checkOfficeMail, type ImapLike } from './jarvis-checks.js';
import type { Snapshot } from './jarvis-data.service.js';

const period = (o: Partial<Snapshot['today']> = {}): Snapshot['today'] => ({ orders: 0, revenue: 0, cancelled: 0, byChannel: {}, calls: 0, callMinutes: 0, failedCalls: 0, newCustomers: 0, ...o });
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  at: '2026-11-09T09:00:00.000Z', // 14:30 India time
  today: period(), yesterday: period(), last7: period(), sameTimeLastWeek: 0, topItems: [], topCustomers: [],
  stock: { tracked: 0, low: [] }, pendingOrders: [], unpaidToday: { count: 0, amount: 0 }, handoffs: [], instagramWaiting: [],
  failedCallsLastHour: 0, overdue: { count: 0, amount: 0 }, feedback: { rated: 0, average: null, complaintsOpen: 0 }, days: [], ...o,
});

describe('India time helpers', () => {
  it('starts the day at midnight IST (18:30 UTC the day before)', () => {
    expect(istDayStart(new Date('2026-11-09T09:00:00Z')).toISOString()).toBe('2026-11-08T18:30:00.000Z');
    expect(istDayStart(new Date('2026-11-08T19:00:00Z')).toISOString()).toBe('2026-11-08T18:30:00.000Z');
    expect(istDayStart(new Date('2026-11-09T09:00:00Z'), 1).toISOString()).toBe('2026-11-07T18:30:00.000Z');
  });
  it('reads the IST clock', () => {
    expect(istClock(new Date('2026-11-09T02:30:00Z'))).toEqual({ hour: 8, minute: 0, date: '2026-11-09' });
  });
});

describe('sanitizeJarvis', () => {
  it('clamps numbers, drops unknown keys and keeps the rest', () => {
    const c = sanitizeJarvis({ digest: { hour: 30, minute: '15' }, monitors: { low_stock: { on: false }, nope: { on: true } }, monitorEveryMin: 1, rates: { sarvamAgentPerMin: '2.5', evil: 9 }, extra: 1 });
    expect(c.digest).toEqual({ on: true, hour: 23, minute: 15 });
    expect(c.monitors.low_stock).toEqual({ on: false, threshold: 1 });
    expect(c.monitorEveryMin).toBe(5);
    expect(c.rates.sarvamAgentPerMin).toBe(2.5);
    expect(Object.keys(c)).toEqual(Object.keys(DEFAULT_JARVIS));
  });
});

describe('evaluateMonitors', () => {
  it('raises nothing on a quiet day', () => {
    expect(evaluateMonitors(snap(), DEFAULT_JARVIS)).toEqual([]);
  });
  it('raises stock, waiting, pending, missed-call and Instagram alerts with stable keys', () => {
    const s = snap({
      stock: { tracked: 3, low: [{ name: 'Broiler', qty: 0, unit: 'kg', level: 'out' }, { name: 'Wings', qty: 2, unit: 'kg', level: 'low' }] },
      handoffs: [{ minutes: 50, channel: 'whatsapp', reason: 'Asked for the owner' }],
      pendingOrders: [{ orderNumber: 'GR-1', minutes: 25, total: 440 }],
      failedCallsLastHour: 4,
      instagramWaiting: [{ minutes: 90, channel: 'instagram' }],
    });
    const a = evaluateMonitors(s, DEFAULT_JARVIS);
    expect(a.map((x) => x.monitor)).toEqual(['low_stock', 'handoff_waiting', 'pending_orders', 'missed_calls', 'instagram_waiting']);
    expect(a[0].severity).toBe('critical');
    expect(a[1].severity).toBe('critical'); // 50 min ≥ 3 × 15
    expect(evaluateMonitors(s, DEFAULT_JARVIS).map((x) => x.dedupeKey)).toEqual(a.map((x) => x.dedupeKey));
  });
  it('sales drop only from noon and with enough orders last week', () => {
    const cfg = DEFAULT_JARVIS;
    expect(evaluateMonitors(snap({ today: period({ orders: 2 }), sameTimeLastWeek: 10 }), cfg).map((x) => x.monitor)).toEqual(['sales_drop']);
    expect(evaluateMonitors(snap({ at: '2026-11-09T04:00:00.000Z', today: period({ orders: 2 }), sameTimeLastWeek: 10 }), cfg)).toEqual([]); // 9:30 IST
    expect(evaluateMonitors(snap({ today: period({ orders: 0 }), sameTimeLastWeek: 3 }), cfg)).toEqual([]);
  });
  it('mail and budget monitors only when switched on and data is there', () => {
    const cfg = sanitizeJarvis({ monitors: { mail_unread: { on: true, threshold: 5 }, usage_budget: { on: true, threshold: 80 } }, dailyBudget: 100 });
    expect(evaluateMonitors(snap(), cfg, { mailUnread: 7, spendToday: 90 }).map((x) => x.monitor)).toEqual(['mail_unread', 'usage_budget']);
    expect(evaluateMonitors(snap(), cfg, { mailUnread: null, spendToday: 10 })).toEqual([]);
  });
});

describe('digest and fact sheet', () => {
  it('writes short lines from the numbers', () => {
    const d = digestLines(snap({ yesterday: period({ orders: 3, revenue: 1320, byChannel: { voice: 2, whatsapp: 1 }, calls: 4, callMinutes: 6.5 }), last7: period({ orders: 14 }), topItems: [{ name: 'Broiler Chicken', qty: 6, unit: 'kg', revenue: 1320 }] }));
    expect(d.headline).toBe('Yesterday: ₹1,320 from 3 orders (+50% vs the 7-day average).');
    expect(d.lines).toContain('By channel: voice 2, whatsapp 1.');
    expect(d.lines.join(' ')).toContain('Top sellers this week: Broiler Chicken (6 kg)');
  });
  it('fact sheet carries no full phone numbers', () => {
    const f = factSheet(snap({ topCustomers: [{ name: 'Ravi', phone: '••••3210', orders: 2, spend: 900 }] }));
    expect(f).toContain('Ravi ••••3210');
    expect(f).not.toMatch(/\d{10}/);
  });
});

describe('office mail (read-only IMAP)', () => {
  const fake = (o: { fail?: string } = {}) => async (): Promise<ImapLike> => ({
    connect: async () => { if (o.fail) throw new Error(o.fail); },
    logout: async () => undefined,
    status: async () => ({ messages: 120, unseen: 7 }),
    getMailboxLock: async (_p, opts) => { expect(opts?.readOnly).toBe(true); return { release: () => undefined }; },
    search: async () => [1, 2, 3],
    fetchAll: async (_r, q) => { expect(q).toEqual({ envelope: true, flags: true }); return [{ envelope: { from: [{ name: 'Supplier' }], subject: 'Invoice 12', date: new Date('2026-11-09T05:00:00Z') }, flags: new Set<string>() }]; },
  });
  it('counts unread and lists senders and subjects only', async () => {
    const r = await checkOfficeMail({ email: 'office@grchicken.in' }, { appPassword: 'abcd efgh ijkl mnop' }, fake());
    expect(r).toMatchObject({ ok: true, unread: 7, total: 120, account: 'of•••@grchicken.in' });
    expect(r.recent[0]).toEqual({ from: 'Supplier', subject: 'Invoice 12', at: '2026-11-09T05:00:00.000Z', unread: true });
  });
  it('explains an app-password problem', async () => {
    const r = await checkOfficeMail({ email: 'office@grchicken.in' }, { appPassword: 'x' }, fake({ fail: 'Invalid credentials (Failure)' }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/app password/);
  });
  it('not connected without credentials', async () => {
    expect((await checkOfficeMail({}, {})).message).toMatch(/not connected/);
  });
});

describe('Instagram check', () => {
  it('reads account and recent posts, and never leaks the token in errors', async () => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const f = async (url: string) => (url.includes('/media') ? ok({ data: [{ caption: 'Fresh broiler today', like_count: 12, comments_count: 3, timestamp: '2026-11-08T10:00:00+0000' }] }) : ok({ username: 'grchicken', followers_count: 540, media_count: 41 }));
    const r = await checkInstagram(f as never, 'TOKEN123', '1784');
    expect(r).toMatchObject({ ok: true, username: 'grchicken', followers: 540, posts: 41 });
    expect(r.recent[0]).toMatchObject({ likes: 12, comments: 3 });
    const bad = async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token TOKEN123' } }), { status: 400 });
    const e = await checkInstagram(bad as never, 'TOKEN123', '1784');
    expect(e.ok).toBe(false);
    expect(e.message).not.toContain('TOKEN123');
  });
});
