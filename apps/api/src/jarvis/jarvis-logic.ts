import { istClock, type JarvisConfig, type MonitorId } from './jarvis-config.js';
import type { Snapshot } from './jarvis-data.service.js';

export type Alert = {
  id: string;
  monitor: MonitorId;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  /** Dashboard page where the team acts on it. */
  href: string;
  at: string;
  /** Same problem, same day -> same key: an alert is raised once, not every run. */
  dedupeKey: string;
};

const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const mins = (m: number) => (m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);

/** Which alerts the current numbers raise (pure: the scheduler stores and de-duplicates them). */
export function evaluateMonitors(s: Snapshot, cfg: JarvisConfig, extra: { mailUnread?: number | null; spendToday?: number } = {}): Alert[] {
  const m = cfg.monitors;
  const day = istClock(new Date(s.at)).date;
  const out: Alert[] = [];
  const add = (monitor: MonitorId, severity: Alert['severity'], title: string, detail: string, href: string, key: string) =>
    out.push({ id: `${monitor}:${day}:${key}`, monitor, severity, title, detail, href, at: s.at, dedupeKey: `${monitor}:${day}:${key}` });

  if (m.low_stock.on && s.stock.low.length >= Math.max(1, m.low_stock.threshold)) {
    const out_ = s.stock.low.filter((x) => x.level === 'out');
    add('low_stock', out_.length ? 'critical' : 'warning', out_.length ? `${plural(out_.length, 'product')} out of stock` : `${plural(s.stock.low.length, 'product')} running low`,
      s.stock.low.slice(0, 6).map((x) => `${x.name}: ${x.level === 'out' ? 'out' : `${x.qty} ${x.unit} left`}`).join(', '), '/menu', s.stock.low.map((x) => `${x.name}=${x.level}`).sort().join('|'));
  }
  if (m.handoff_waiting.on) {
    const late = s.handoffs.filter((h) => h.minutes >= m.handoff_waiting.threshold);
    if (late.length) add('handoff_waiting', late.some((h) => h.minutes >= m.handoff_waiting.threshold * 3) ? 'critical' : 'warning', `${plural(late.length, 'customer')} waiting for staff`, `Longest wait ${mins(Math.max(...late.map((h) => h.minutes)))}${late[0].reason ? ` · ${late[0].reason.slice(0, 80)}` : ''}`, '/inbox', String(late.length));
  }
  if (m.pending_orders.on && s.pendingOrders.length) {
    add('pending_orders', 'warning', `${plural(s.pendingOrders.length, 'order')} not confirmed`, s.pendingOrders.slice(0, 5).map((o) => `${o.orderNumber} (${mins(o.minutes)}, ${inr(o.total)})`).join(', '), '/orders', s.pendingOrders.map((o) => o.orderNumber).sort().join('|'));
  }
  if (m.missed_calls.on && s.failedCallsLastHour >= Math.max(1, m.missed_calls.threshold)) {
    add('missed_calls', 'warning', `${plural(s.failedCallsLastHour, 'call')} missed or failed in the last hour`, 'Check the voice agent and the phone line.', '/calls', s.at.slice(0, 13));
  }
  if (m.sales_drop.on && s.sameTimeLastWeek >= 5) {
    const hourIst = istClock(new Date(s.at)).hour;
    const drop = Math.round((1 - s.today.orders / s.sameTimeLastWeek) * 100);
    if (hourIst >= 12 && drop >= m.sales_drop.threshold) add('sales_drop', 'warning', `Orders ${drop}% lower than last week`, `${s.today.orders} so far today vs ${s.sameTimeLastWeek} by this time last week.`, '/analytics', 'drop');
  }
  if (m.instagram_waiting.on) {
    const late = s.instagramWaiting.filter((x) => x.minutes >= m.instagram_waiting.threshold);
    if (late.length) add('instagram_waiting', 'warning', `${plural(late.length, 'Instagram message')} waiting for a reply`, `Longest wait ${mins(Math.max(...late.map((x) => x.minutes)))}.`, '/inbox', String(late.length));
  }
  if (m.mail_unread.on && typeof extra.mailUnread === 'number' && extra.mailUnread >= Math.max(1, m.mail_unread.threshold)) {
    add('mail_unread', 'info', `${plural(extra.mailUnread, 'unread mail')} in the office inbox`, 'Open Jarvis → Office mail for the latest senders and subjects.', '/jarvis/checks', String(Math.floor(extra.mailUnread / 10)));
  }
  if (m.usage_budget.on && cfg.dailyBudget > 0 && typeof extra.spendToday === 'number') {
    const pct = Math.round((extra.spendToday / cfg.dailyBudget) * 100);
    if (pct >= m.usage_budget.threshold) add('usage_budget', pct >= 100 ? 'critical' : 'warning', `Today’s AI spend is ${pct}% of the budget`, `${inr(extra.spendToday)} of ${inr(cfg.dailyBudget)} (estimated from your rates).`, '/jarvis/usage', pct >= 100 ? 'over' : 'near');
  }
  return out;
}

/** The morning briefing as short sentences (shown, and read aloud with the agent's voice). */
export function digestLines(s: Snapshot, label = 'Yesterday'): { headline: string; lines: string[] } {
  const y = s.yesterday;
  const lines: string[] = [];
  lines.push(y.orders ? `${label}: ${plural(y.orders, 'order')} worth ${inr(y.revenue)}${y.cancelled ? `, ${y.cancelled} cancelled` : ''}.` : `${label}: no orders.`);
  const ch = Object.entries(y.byChannel).sort((a, b) => b[1] - a[1]);
  if (ch.length) lines.push(`By channel: ${ch.map(([c, k]) => `${c} ${k}`).join(', ')}.`);
  if (y.calls) lines.push(`${plural(y.calls, 'call')}, ${y.callMinutes} minutes${y.failedCalls ? `, ${y.failedCalls} missed or failed` : ''}.`);
  if (y.newCustomers) lines.push(`${plural(y.newCustomers, 'new customer')}.`);
  if (s.topItems.length) lines.push(`Top sellers this week: ${s.topItems.slice(0, 3).map((i) => `${i.name} (${i.qty} ${i.unit})`).join(', ')}.`);
  if (s.today.orders) lines.push(`Today so far: ${plural(s.today.orders, 'order')}, ${inr(s.today.revenue)}.`);
  if (s.stock.low.length) lines.push(`Stock: ${s.stock.low.slice(0, 4).map((x) => `${x.name} ${x.level === 'out' ? 'out' : 'low'}`).join(', ')}.`);
  if (s.handoffs.length) lines.push(`${plural(s.handoffs.length, 'customer')} waiting for staff.`);
  if (s.instagramWaiting.length) lines.push(`${plural(s.instagramWaiting.length, 'Instagram message')} waiting for a reply.`);
  if (s.pendingOrders.length) lines.push(`${plural(s.pendingOrders.length, 'order')} still pending.`);
  if (s.overdue.count) lines.push(`${plural(s.overdue.count, 'overdue invoice')}, ${inr(s.overdue.amount)} to collect.`);
  if (s.feedback.rated) lines.push(`Feedback this week: ${s.feedback.average} out of 5 from ${plural(s.feedback.rated, 'rating')}${s.feedback.complaintsOpen ? `, ${plural(s.feedback.complaintsOpen, 'open complaint')}` : ''}.`);
  const trend = s.last7.orders ? Math.round((y.orders / (s.last7.orders / 7)) * 100) - 100 : 0;
  const headline = y.orders
    ? `${label}: ${inr(y.revenue)} from ${plural(y.orders, 'order')}${s.last7.orders >= 7 ? ` (${trend >= 0 ? '+' : ''}${trend}% vs the 7-day average)` : ''}.`
    : `${label}: no orders.`;
  return { headline, lines };
}

/** A compact, numbers-only fact sheet for "Ask your business data" (the model may use only these). */
export function factSheet(s: Snapshot, usage?: { totals: Record<string, number>; ratesSet: boolean }): string {
  const p = (name: string, x: Snapshot['today']) => `${name}: orders ${x.orders}, revenue ${inr(x.revenue)}, cancelled ${x.cancelled}, by channel ${JSON.stringify(x.byChannel)}, calls ${x.calls} (${x.callMinutes} min, ${x.failedCalls} failed), new customers ${x.newCustomers}`;
  return [
    `As of ${s.at} (India time = UTC+5:30).`,
    p('Today so far', s.today),
    p('Yesterday', s.yesterday),
    p('Last 7 days', s.last7),
    `Orders by this time on the same day last week: ${s.sameTimeLastWeek}`,
    `Top items (7 days): ${s.topItems.map((i) => `${i.name} ${i.qty} ${i.unit} ${inr(i.revenue)}`).join('; ') || 'none'}`,
    `Top customers (30 days, phone masked): ${s.topCustomers.map((c) => `${c.name} ${c.phone} ${c.orders} orders ${inr(c.spend)}`).join('; ') || 'none'}`,
    `Stock tracked: ${s.stock.tracked}; low/out: ${s.stock.low.map((x) => `${x.name} ${x.level} ${x.qty} ${x.unit}`).join('; ') || 'none'}`,
    `Pending orders: ${s.pendingOrders.map((o) => `${o.orderNumber} ${o.minutes} min`).join('; ') || 'none'}`,
    `Unpaid orders today: ${s.unpaidToday.count} (${inr(s.unpaidToday.amount)})`,
    `Customers waiting for staff: ${s.handoffs.length}; Instagram waiting: ${s.instagramWaiting.length}`,
    `Missed/failed calls last hour: ${s.failedCallsLastHour}`,
    `Overdue invoices: ${s.overdue.count} (${inr(s.overdue.amount)})`,
    `Feedback 7 days: ${s.feedback.rated} ratings, average ${s.feedback.average ?? 'n/a'}, open complaints ${s.feedback.complaintsOpen}`,
    usage ? `AI usage (period shown on the usage page): ${JSON.stringify(usage.totals)}${usage.ratesSet ? '' : ' (no rates entered: cost unknown)'}` : '',
  ].filter(Boolean).join('\n');
}
