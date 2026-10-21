export function displayName(c: { name?: string | null; phone?: string | null } | null | undefined) {
  return c?.name?.trim() || formatPhone(c?.phone) || 'Unknown';
}

export function initials(c: { name?: string | null; phone?: string | null } | null | undefined) {
  const name = c?.name?.trim();
  if (!name) return '#';
  const parts = name.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** 919876543210 -> +91 98765 43210 */
export function formatPhone(phone?: string | null) {
  if (!phone) return '';
  if (phone.length === 12 && phone.startsWith('91')) return `+91 ${phone.slice(2, 7)} ${phone.slice(7)}`;
  return `+${phone}`;
}

export function rupees(value?: string | number | null) {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 10_000_000) return `₹${+(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `₹${+(n / 100_000).toFixed(1)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

export function requirement(x: { bhk?: number | null; propertyType?: string | null; location?: string | null } | null | undefined) {
  if (!x) return '';
  return [x.bhk ? `${x.bhk} BHK` : '', x.propertyType ?? '', x.location ? `in ${x.location}` : ''].filter(Boolean).join(' ');
}

export function timeAgo(iso?: string | null) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.abs(diff) / 1000;
  if (s < 60) return 'now';
  const v = s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return diff < 0 ? `in ${v}` : v;
}

const IST: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kolkata' };

export function dateTime(iso?: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function timeOnly(iso?: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-IN', { ...IST, hour: 'numeric', minute: '2-digit' });
}

export function dayKey(iso: string | Date) {
  return new Date(iso).toLocaleDateString('en-CA', IST);
}

export function dayLabel(iso: string) {
  const today = new Date();
  const k = dayKey(iso);
  if (k === dayKey(today)) return 'Today';
  if (k === dayKey(new Date(today.getTime() + 86400000))) return 'Tomorrow';
  if (k === dayKey(new Date(today.getTime() - 86400000))) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-IN', { ...IST, weekday: 'short', day: 'numeric', month: 'short' });
}

export function duration(sec?: number | null) {
  if (!sec) return '00:00';
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

export function minutesSeconds(sec?: number | null) {
  if (!sec) return '0s';
  const m = Math.floor(sec / 60);
  return m ? `${m}m ${sec % 60}s` : `${sec}s`;
}

export function pct(part: number, whole: number) {
  return whole ? Math.round((part / whole) * 100) : 0;
}

export type Tone = 'brand' | 'violet' | 'amber' | 'sky' | 'rose' | 'slate';

/** Lead status labels shown to staff. Mirrors LEAD_STATUSES in the API. */
export const LEAD_STATUS: Record<string, { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'slate' },
  contacted: { label: 'Contacted', tone: 'sky' },
  qualified: { label: 'Interested', tone: 'violet' },
  property_interested: { label: 'Interested', tone: 'violet' },
  site_visit: { label: 'Site visit', tone: 'sky' },
  callback: { label: 'Call back', tone: 'amber' },
  human_handoff: { label: 'Needs a human', tone: 'rose' },
  not_interested: { label: 'Not interested', tone: 'slate' },
  won: { label: 'Converted', tone: 'brand' },
  lost: { label: 'Not interested', tone: 'slate' },
  // textile funnel
  catalogue_shared: { label: 'Catalogue shared', tone: 'sky' },
  quotation_requested: { label: 'Quote requested', tone: 'amber' },
  quotation_sent: { label: 'Quote sent', tone: 'violet' },
  negotiation: { label: 'Negotiation', tone: 'amber' },
  order_confirmed: { label: 'Order confirmed', tone: 'brand' },
  repeat_customer: { label: 'Repeat customer', tone: 'brand' },
};

const COMMON_STATUSES = ['new', 'contacted', 'qualified', 'callback', 'human_handoff', 'not_interested']; // 'lost' shares the label; kept only if current
const REAL_ESTATE_STATUSES = ['property_interested', 'site_visit', 'won'];
const TEXTILE_STATUSES = ['catalogue_shared', 'quotation_requested', 'quotation_sent', 'negotiation', 'order_confirmed', 'repeat_customer'];

/** Lead statuses that make sense for the business's industry (the current status is always kept). */
const RETAIL_STATUSES = ['catalogue_shared', 'order_confirmed', 'repeat_customer'];
const GENERIC_STATUSES = ['won'];

export function leadStatusesFor(industry: string | undefined, current?: string) {
  const extra =
    industry === 'textile' ? TEXTILE_STATUSES : industry === 'retail' ? RETAIL_STATUSES : industry === 'real_estate' || !industry ? REAL_ESTATE_STATUSES : GENERIC_STATUSES;
  const keys = [...COMMON_STATUSES, ...extra];
  if (current && !keys.includes(current)) keys.push(current);
  return keys.map((k) => [k, LEAD_STATUS[k] ?? { label: k, tone: 'slate' as Tone }] as const);
}

export const QUOTE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'slate' },
  pending_approval: { label: 'Needs pricing / approval', tone: 'amber' },
  approved: { label: 'Approved', tone: 'sky' },
  sent: { label: 'Sent', tone: 'violet' },
  accepted: { label: 'Accepted', tone: 'brand' },
  rejected: { label: 'Rejected', tone: 'rose' },
  expired: { label: 'Expired', tone: 'slate' },
};

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_confirmation: { label: 'Pending confirmation', tone: 'amber' },
  confirmed: { label: 'Confirmed', tone: 'sky' },
  processing: { label: 'Processing', tone: 'violet' },
  ready_to_dispatch: { label: 'Ready to dispatch', tone: 'violet' },
  dispatched: { label: 'Dispatched', tone: 'sky' },
  delivered: { label: 'Delivered', tone: 'brand' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

/** Same tables as the API (textile-rules.ts) - the server re-checks every move. */
export const QUOTE_NEXT: Record<string, string[]> = {
  draft: ['pending_approval', 'approved', 'rejected'],
  pending_approval: ['approved', 'draft', 'rejected'],
  approved: ['draft'],
  sent: ['accepted', 'rejected', 'expired'],
  accepted: [],
  rejected: [],
  expired: ['draft'],
};
export const ORDER_NEXT: Record<string, string[]> = {
  pending_confirmation: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['ready_to_dispatch', 'cancelled'],
  ready_to_dispatch: ['dispatched', 'cancelled'],
  dispatched: ['delivered'],
  delivered: [],
  cancelled: [],
};

export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'rose' },
  partial: { label: 'Part paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'brand' },
};

export const STOCK_STATUS: Record<string, { label: string; tone: Tone }> = {
  in_stock: { label: 'In stock', tone: 'brand' },
  low: { label: 'Limited', tone: 'amber' },
  out_of_stock: { label: 'Out of stock', tone: 'rose' },
  unknown: { label: 'Not set', tone: 'slate' },
};

export const FEEDBACK_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: 'Asked', tone: 'slate' },
  received: { label: 'Received', tone: 'sky' },
  needs_action: { label: 'Needs action', tone: 'rose' },
  resolved: { label: 'Resolved', tone: 'brand' },
};

/** Exact amount with Indian grouping: 125000.5 -> ₹1,25,000.50 (no rounding into lakhs - these are invoice values). */
export function inr(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function auditActor(actor: string) {
  if (actor.startsWith('user:')) return 'Team member';
  if (actor === 'customer') return 'Customer (WhatsApp)';
  if (actor === 'ai' || actor.startsWith('ai')) return 'AI assistant';
  if (actor.startsWith('system') || actor.startsWith('worker')) return 'Automation';
  return actor;
}

export const CALL_OUTCOME: Record<string, { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'sky' },
  interested: { label: 'Interested', tone: 'brand' },
  qualified: { label: 'Qualified', tone: 'violet' },
  site_visit_requested: { label: 'Wants a visit', tone: 'sky' },
  site_visit_booked: { label: 'Visit booked', tone: 'brand' },
  callback_requested: { label: 'Call back', tone: 'amber' },
  human_requested: { label: 'Sent to staff', tone: 'rose' },
  not_interested: { label: 'Not interested', tone: 'slate' },
  wrong_number: { label: 'Wrong number', tone: 'slate' },
  no_answer: { label: 'No answer', tone: 'rose' },
  busy: { label: 'Busy', tone: 'amber' },
  failed: { label: 'Failed', tone: 'rose' },
  requested_catalogue: { label: 'Wants catalogue', tone: 'sky' },
  requested_quotation: { label: 'Wants a quote', tone: 'amber' },
  order_discussion: { label: 'Order discussion', tone: 'brand' },
  invalid_number: { label: 'Invalid number', tone: 'rose' },
  in_progress: { label: 'Live', tone: 'violet' },
  ringing: { label: 'Ringing', tone: 'violet' },
  queued: { label: 'Dialing', tone: 'violet' },
};

export function callBadge(call: { status: string; outcome: string | null }) {
  if (['in_progress', 'ringing', 'queued'].includes(call.status)) return CALL_OUTCOME[call.status];
  return CALL_OUTCOME[call.outcome ?? call.status] ?? { label: call.outcome ?? call.status, tone: 'slate' as Tone };
}

export function followUpLabel(f: { channel: string; message: string | null; source: string }) {
  if (f.channel === 'human') return 'Task for your team';
  if (f.channel === 'voice') {
    if (f.source === 'callback') return 'Callback they asked for';
    if (f.source === 'retry') return 'Retry call';
    return 'AI call';
  }
  const kind = (f.message ?? '').split(':').slice(0, 2).join(':');
  const step: Record<string, string> = {
    first_contact: 'First WhatsApp message',
    reminder: 'WhatsApp reminder',
    final: 'Last WhatsApp follow-up',
    missed_call: 'WhatsApp: sorry we missed you',
    'visit:confirm': 'Visit: confirm the day before',
    'visit:reminder': 'Visit: reminder with location',
    'visit:after': 'Visit: thank-you / no-show follow-up',
    'alert:booked': 'Team alert: visit booked',
    'alert:visit_soon': 'Team alert: visit soon',
    'alert:hot': 'Team alert: hot lead',
  };
  if (/^nurture_day\d+$/.test(f.message ?? '')) return `WhatsApp nurture (day ${(f.message ?? '').replace('nurture_day', '')})`;
  return step[kind] ?? step[f.message ?? ''] ?? 'WhatsApp follow-up';
}

export function stopReason(f: { status: string; cancellationReason: string | null; lastError: string | null }) {
  const map: Record<string, string> = {
    customer_replied: 'Customer replied',
    'Customer replied on WhatsApp': 'Customer replied',
    do_not_contact: 'Customer opted out',
    'Customer not interested': 'Not interested',
    'Human handoff requested': 'Handed to your team',
    'Customer requested a callback': 'Replaced by a callback',
    'Site visit booked': 'Visit booked',
    site_visit_booked: 'Visit booked',
    already_spoke_on_call: 'Already spoke on a call',
    max_call_attempts: 'Call attempts used up',
    'Visit cancelled or moved': 'Visit cancelled or moved',
    visit_cancelled: 'Visit cancelled',
    visit_not_marked: 'Asked your team to mark the visit',
    no_team_phones: 'No team phone set',
    lead_not_interested: 'Not interested',
    lead_human_handoff: 'Handed to your team',
    lead_won: 'Lead won',
    lead_lost: 'Lead lost',
    'Invalid phone number': 'Invalid number',
  };
  if (f.status === 'skipped' && f.lastError?.includes('template')) return 'Needs an approved WhatsApp template';
  if (f.status === 'failed') return f.lastError ?? 'Failed';
  const reason = f.cancellationReason ?? '';
  if (reason.startsWith('Call connected')) return 'Spoke on a call';
  return map[reason] ?? reason;
}

export function languageLabel(code?: string | null) {
  if (!code) return '—';
  if (code.startsWith('ta')) return 'Tamil';
  if (code.startsWith('en')) return 'English';
  return code.charAt(0).toUpperCase() + code.slice(1);
}

export function sourceLabel(source?: string | null) {
  const map: Record<string, string> = {
    meta_lead_ads: 'Meta lead ad',
    whatsapp: 'WhatsApp',
    voice: 'Phone call',
    voice_inbound: 'Inbound call',
    manual: 'Added manually',
  };
  return source ? (map[source] ?? source) : 'Unknown';
}

export function waLink(phone?: string | null) {
  return phone ? `https://wa.me/${phone}` : undefined;
}

export function telLink(phone?: string | null) {
  return phone ? `tel:+${phone}` : undefined;
}

export const VISIT_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: 'Requested', tone: 'amber' },
  scheduled: { label: 'Booked', tone: 'sky' },
  confirmed: { label: 'Confirmed', tone: 'brand' },
  completed: { label: 'Visited', tone: 'brand' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
  no_show: { label: 'No-show', tone: 'rose' },
};

export const TASK_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'slate' },
  RUNNING: { label: 'Running', tone: 'violet' },
  NEEDS_APPROVAL: { label: 'Needs approval', tone: 'amber' },
  COMPLETED: { label: 'Completed', tone: 'brand' },
  FAILED: { label: 'Failed', tone: 'rose' },
  CANCELLED: { label: 'Cancelled', tone: 'slate' },
};

export const APPROVAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'amber' },
  approved: { label: 'Approved', tone: 'sky' },
  executed: { label: 'Approved · done', tone: 'brand' },
  failed: { label: 'Approved · failed', tone: 'rose' },
  rejected: { label: 'Rejected', tone: 'rose' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
  expired: { label: 'Expired', tone: 'slate' },
};

export const AGENT_LABEL: Record<string, string> = { marketing: 'Marketing', sales: 'Sales', finance: 'Finance', operations: 'Operations' };

export const WORK_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'amber' },
  in_progress: { label: 'In progress', tone: 'sky' },
  done: { label: 'Done', tone: 'brand' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

export const APPROVAL_ACTION: Record<string, string> = {
  'quotation.discount': 'Exceptional discount',
  'inventory.adjust': 'Stock correction',
  'agent.task': 'Agent action',
  'payment.reverse': 'Payment reversal',
};

/** Where a record lives in the dashboard. */
export function recordLink(type?: string | null, id?: string | null) {
  if (!type || !id) return null;
  if (type === 'order') return `/orders?id=${id}`;
  if (type === 'quotation') return `/quotations?id=${id}`;
  if (type === 'product') return `/operations?product=${id}`;
  if (type === 'lead') return `/leads/${id}`;
  if (type === 'invoice') return `/finance?invoice=${id}`;
  if (type === 'payment') return `/finance?tab=verify`;
  return null;
}

export function newClientKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const INVOICE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'slate' },
  approved: { label: 'Approved', tone: 'sky' },
  issued: { label: 'Issued', tone: 'violet' },
  partially_paid: { label: 'Part paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'brand' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

export const PAYMENT_RECORD_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_verification: { label: 'Awaiting verification', tone: 'amber' },
  verified: { label: 'Verified', tone: 'brand' },
  rejected: { label: 'Rejected', tone: 'rose' },
  reversed: { label: 'Reversed', tone: 'slate' },
};

export const PAYMENT_METHODS: Record<string, string> = { upi: 'UPI', bank_transfer: 'Bank transfer (NEFT/RTGS/IMPS)', cash: 'Cash', cheque: 'Cheque', card: 'Card', gateway: 'Payment gateway', other: 'Other' };

export function dateOnly(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
