'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { Tone } from './format';

export type Me = { id: string; email: string; name: string | null; role: string; organizationId: string; organizationName: string; vertical: 'real_estate' | 'restaurant' };

let mePromise: Promise<Me> | null = null;

/** The logged-in user and their tenant's product (fetched once per page load and shared). */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let alive = true;
    mePromise ??= api.get<Me>('/auth/me').catch((e) => {
      mePromise = null;
      throw e;
    });
    mePromise.then((m) => alive && setMe(m)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return me;
}

export function forgetMe() {
  mePromise = null;
}

export type OrderStatus = 'pending' | 'confirmed' | 'preparing' | 'ready' | 'completed' | 'cancelled';

export type Order = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  channel: string;
  pickupAt: string;
  subtotal: number;
  discount: number;
  total: number;
  paymentMethod: 'cash_at_shop' | 'upi_at_shop' | 'paid_online';
  paymentStatus: 'paid' | 'unpaid' | 'customer_says_paid';
  posStatus: string;
  isDemo: boolean;
  language: string | null;
  readyNotice: string | null;
  readyNoticeAt: string | null;
  readyNoticeNote: string | null;
  readyCallId: string | null;
  collectedAt: string | null;
  feedbackRating: number | null;
  feedbackComment: string | null;
  feedbackAt: string | null;
  feedbackChannel: string | null;
  complaintStatus: 'open' | 'resolved' | null;
  complaintNote: string | null;
  followUpStatus: string | null;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerId: string;
  conversationId: string | null;
  outlet: { id: string; name: string; area: string | null; phone: string | null; address: string; isDemo: boolean };
  offer: { id: string; source: string; websiteOrderRef: string | null; amount: number } | null;
  items: Array<{ id: string; menuItemId: string; name: string; cut: string | null; unit: string; unitPrice: number; quantity: number; lineTotal: number }>;
  events: Array<{ id: string; type: string; fromStatus: string | null; toStatus: string | null; actor: string; note: string | null; createdAt: string }>;
  allowedNext: OrderStatus[];
  createdAt: string;
  updatedAt: string;
};

export type Overview = {
  days: number;
  offers: { total: number; sent: number; started: number; claimed: number; notSent: number; claimRate: number; bySource: Record<string, number>; byStatus: Record<string, number> };
  orders: { inRange: number; active: number; byStatus: Record<string, number>; pickupsToday: number };
  sales: { inRange: number; discountGiven: number };
  readyNotices: Record<string, number>;
  upcoming: Order[];
  handoffsOpen: number;
  recentConversations: Array<{
    id: string;
    channel: string;
    status: string;
    updatedAt: string;
    customer: { id: string; name: string | null; phone: string | null } | null;
    lastMessage: { role: string; content: string; createdAt: string } | null;
  }>;
  series: Array<{ day: string; orders: number; sales: number }>;
  demoData: boolean;
};

export type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  unit: 'kg' | 'piece';
  cutOptions: string[];
  minQty: number;
  maxQty: number;
  qtyStep: number;
  /** Can be sold now (switched on and not out of stock). */
  available: boolean;
  /** The staff on/off switch. */
  listed?: boolean;
  /** Stock on hand in kg / pieces; null = not tracked. */
  stockQty?: number | null;
  lowStockThreshold?: number | null;
  stockStatus?: 'unknown' | 'in_stock' | 'low' | 'out';
  stockIsDemo?: boolean;
  imageUrl: string | null;
  aliases: string[];
  isDemo: boolean;
  categoryId: string;
  categoryName: string;
};

export type Outlet = {
  id: string;
  name: string;
  address: string;
  area: string | null;
  phone: string | null;
  opensAt: string;
  closesAt: string;
  prepMinutes: number;
  minOrderValue: number;
  acceptOutsideHours: boolean;
  active: boolean;
  isDemo: boolean;
};

export type Catalog = { categories: Array<{ id: string; name: string }>; items: MenuItem[]; outlets: Outlet[] };

export type OfferClaim = {
  id: string;
  source: 'whatsapp_link' | 'website' | 'dashboard';
  status: string;
  sendError: string | null;
  websiteOrderRef: string | null;
  amount: number;
  expiresAt: string;
  createdAt: string;
  customer: { id: string; name: string | null; phone: string | null };
  order: { id: string; orderNumber: string; total: number; status: string } | null;
};

export type OffersData = {
  campaign: { id: string; name: string; code: string; amount: number; minOrderValue: number; validDays: number; templateName: string | null; active: boolean } | null;
  stats: Overview['offers'];
  claims: OfferClaim[];
  whatsappLink: string | null;
  whatsappLinkNote: string | null;
  website: { keyConfigured: boolean; endpoint: string };
};

export type RConversation = {
  id: string;
  channel: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; name: string | null; phone: string | null } | null;
  messageCount: number;
  orderCount: number;
  lastMessage: { role: string; content: string; createdAt: string } | null;
};

export type RConversationDetail = {
  id: string;
  channel: string;
  status: string;
  createdAt: string;
  customer: { id: string; name: string | null; phone: string | null; doNotContact: boolean } | null;
  messages: Array<{ id: string; role: string; content: string; createdAt: string; metadata: Record<string, unknown> | null; deliveryStatus?: string | null }>;
  orders: Order[];
};

export type RCustomer = {
  id: string;
  name: string | null;
  phone: string | null;
  source: string | null;
  doNotContact: boolean;
  createdAt: string;
  lastInboundAt: string | null;
  conversations: number;
  orders: number;
  totalSpend: number;
  lastOrderAt: string | null;
  messagingConsent: boolean;
  callingConsent: boolean;
  optedOutAt: string | null;
  isDemo: boolean;
};

export type FollowUpRow = {
  id: string;
  kind: 'order_confirmation' | 'status_update' | 'feedback_request' | 'feedback_call';
  channel: 'whatsapp' | 'voice';
  status: string;
  scheduledAt: string;
  attempts: number;
  maxAttempts: number;
  dryRun: boolean;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  providerMessageId: string | null;
  callId: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  order: { id: string; orderNumber: string; isDemo: boolean; status: string };
  customer: { id: string; name: string | null; phone: string | null; isDemo: boolean };
  call: { id: string; status: string; outcome: string | null; durationSec: number | null; summary: string | null; answeredAt: string | null; endedAt: string | null } | null;
};

export type FollowUpSummary = {
  mode: 'dry_run' | 'live';
  liveTestRecipients: number;
  liveAllowAll: boolean;
  settings: { feedbackDelayMinutes: number; callDelayMinutes: number; callMaxAttempts: number; callRetryMinutes: number; feedbackTemplateSet: boolean; confirmationTemplateSet: boolean };
  scheduled: number;
  whatsappSent: number;
  whatsappDelivered: number;
  callsAnswered: number;
  callsNoAnswer: number;
  failed: number;
  skipped: number;
  byKind: Record<string, number>;
  averageRating: number | null;
  ratings: number;
  complaintsOpen: number;
  complaintsResolved: number;
  demoOrders: Array<{ id: string; orderNumber: string; customerName: string | null; demoScenario: string | null }>;
  scenarios: string[];
};

export type FeedbackRow = {
  id: string;
  orderNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  customerId: string;
  conversationId: string | null;
  feedbackRating: number | null;
  feedbackComment: string | null;
  feedbackAt: string | null;
  feedbackChannel: string | null;
  complaintStatus: 'open' | 'resolved' | null;
  complaintNote: string | null;
  isDemo: boolean;
  total: number;
};

export const FOLLOWUP_KIND: Record<string, string> = {
  order_confirmation: 'Order confirmation',
  status_update: 'Status update',
  feedback_request: 'Feedback request',
  feedback_call: 'Feedback call',
};

export const FOLLOWUP_STATUS: Record<string, { label: string; tone: Tone }> = {
  scheduled: { label: 'Scheduled', tone: 'sky' },
  retrying: { label: 'Retrying', tone: 'amber' },
  processing: { label: 'Processing', tone: 'violet' },
  calling: { label: 'Calling…', tone: 'violet' },
  sent: { label: 'Sent', tone: 'sky' },
  delivered: { label: 'Delivered', tone: 'brand' },
  read: { label: 'Read', tone: 'brand' },
  completed: { label: 'Completed', tone: 'brand' },
  no_answer: { label: 'No answer', tone: 'amber' },
  failed: { label: 'Failed', tone: 'rose' },
  skipped: { label: 'Skipped', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

export const SCENARIO_LABEL: Record<string, string> = {
  whatsapp_5: 'Customer replies 5 on WhatsApp',
  whatsapp_complaint: 'Customer replies 2 + complaint on WhatsApp',
  call_happy: 'No WhatsApp reply → call: happy, 5/5',
  call_complaint: 'No WhatsApp reply → call: complaint, 2/5',
  no_answer: 'No WhatsApp reply → call not answered (retry)',
  stop: 'Customer replies STOP',
};

/** Exact rupees (orders need ₹390, not ₹0.4 K). */
export function inr(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** 2 kg, 1.5 kg, 500 g, 12 pcs */
export function qty(q: number, unit: string) {
  if (unit === 'piece') return `${q} pcs`;
  if (q < 1) return `${Math.round(q * 1000)} g`;
  return `${+q.toFixed(2)} kg`;
}

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  pending: { label: 'New · confirm', tone: 'amber' },
  confirmed: { label: 'Confirmed', tone: 'sky' },
  preparing: { label: 'Cutting & packing', tone: 'violet' },
  ready: { label: 'Ready to collect', tone: 'brand' },
  completed: { label: 'Collected', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'rose' },
};

export const ACTION_LABEL: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirm order',
  preparing: 'Start cutting',
  ready: 'Mark ready & call customer',
  completed: 'Collected',
  cancelled: 'Cancel order',
};

export const READY_NOTICE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Calling soon', tone: 'amber' },
  calling: { label: 'Calling…', tone: 'violet' },
  answered: { label: 'Call answered', tone: 'brand' },
  no_answer: { label: 'No answer', tone: 'amber' },
  failed: { label: 'Call failed', tone: 'rose' },
  whatsapp_sent: { label: 'Told on WhatsApp', tone: 'sky' },
  not_sent: { label: 'Not notified', tone: 'rose' },
};

export const CLAIM_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_send: { label: 'Not sent', tone: 'amber' },
  send_failed: { label: 'Send failed', tone: 'rose' },
  sent: { label: 'Sent', tone: 'sky' },
  started: { label: 'Chatting', tone: 'violet' },
  claimed: { label: 'Claimed', tone: 'brand' },
  expired: { label: 'Expired', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

export const SOURCE_LABEL: Record<string, string> = { whatsapp_link: 'WhatsApp link', website: 'Website', dashboard: 'Added by staff' };

export const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', voice: 'Phone call', test: 'Test chat', web: 'Website' };

export function paymentLabel(o: Pick<Order, 'paymentMethod' | 'paymentStatus'>) {
  const method = o.paymentMethod === 'cash_at_shop' ? 'Cash at shop' : o.paymentMethod === 'upi_at_shop' ? 'UPI at shop' : 'Paid online';
  const status = o.paymentStatus === 'paid' ? 'Paid' : o.paymentStatus === 'customer_says_paid' ? 'Customer says paid — verify' : 'Unpaid';
  return `${method} · ${status}`;
}

const IST: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kolkata' };
/** "Today 6:00 PM", "Tomorrow 10:00 AM", "Tue 13 Oct, 11:00 AM" */
export function pickupLabel(iso: string) {
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString('en-CA', IST);
  const time = d.toLocaleTimeString('en-IN', { ...IST, hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (day(d) === day(today)) return `Today ${time}`;
  if (day(d) === day(new Date(today.getTime() + 86_400_000))) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString('en-IN', { ...IST, weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

export function actorLabel(actor: string) {
  if (actor === 'ai') return 'AI assistant';
  if (actor === 'system') return 'System';
  return 'Staff';
}

/** Chat replies use WhatsApp-style *bold*; strip the markers where they are shown as plain text. */
export function plain(text: string) {
  return text.replace(/\*([^*\n]+)\*/g, '$1');
}

/** GET /restaurant/carts — carts customers are building now. */
export type ActiveCart = {
  key: string;
  channel: 'whatsapp' | 'voice' | 'test';
  customerName: string | null;
  phone: string;
  conversationId: string | null;
  step: 'collecting' | 'awaiting_confirmation';
  awaitingConfirmation: boolean;
  lines: Array<{ name: string; unit: 'kg' | 'piece'; quantity: number | null; cut: string | null; lineTotal: number | null; stockKnown: boolean }>;
  total: number;
  payment: string | null;
  pickupAt: string | null;
  language: string;
  updatedAt: string;
};

/** GET /restaurant/inventory-movements */
export type StockMovement = { id: string; createdAt: string; product: string; unit: 'kg' | 'piece'; delta: number; balanceAfter: number; reason: string; actor: string | null; orderId: string | null };

/** GET /restaurant/whatsapp-inbound */
export type InboundStatus = {
  counts: Record<string, number>;
  messages: Array<{ id: string; providerMessageId: string; fromPhone: string; messageType: string; status: string; attempts: number; replyStatus: string | null; replyProviderId: string | null; lastError: string | null; receivedAt: string; processedAt: string | null; conversationId: string | null }>;
};
