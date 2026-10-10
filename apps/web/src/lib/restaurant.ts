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

export type OrderStatus = 'pending' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'completed' | 'cancelled';

export type Order = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  channel: string;
  fulfilment: 'pickup' | 'delivery';
  deliveryAddress: string | null;
  deliveryArea: string | null;
  subtotal: number;
  deliveryFee: number;
  total: number;
  paymentMethod: string;
  paymentStatus: 'paid' | 'unpaid';
  posStatus: string;
  isDemo: boolean;
  customerName: string | null;
  customerPhone: string | null;
  customerId: string;
  conversationId: string | null;
  outlet: { id: string; name: string; area: string | null; phone: string | null; isDemo: boolean };
  items: Array<{ id: string; menuItemId: string; name: string; unitPrice: number; quantity: number; lineTotal: number }>;
  events: Array<{ id: string; type: string; fromStatus: string | null; toStatus: string | null; actor: string; note: string | null; createdAt: string }>;
  allowedNext: OrderStatus[];
  createdAt: string;
  updatedAt: string;
};

export type Overview = {
  days: number;
  enquiries: { total: number; inRange: number };
  orders: { total: number; inRange: number; today: number; active: number; byStatus: Record<string, number>; conversionRate: number };
  sales: { today: number; inRange: number };
  channels: Array<{ channel: string; conversations: number; orders: number }>;
  handoffsOpen: number;
  recentOrders: Order[];
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
  isVeg: boolean;
  available: boolean;
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
  serviceAreas: string[];
  opensAt: string;
  closesAt: string;
  acceptsPickup: boolean;
  acceptsDelivery: boolean;
  deliveryFee: number;
  minOrderValue: number;
  acceptOutsideHours: boolean;
  active: boolean;
  isDemo: boolean;
};

export type Catalog = { categories: Array<{ id: string; name: string }>; items: MenuItem[]; outlets: Outlet[] };

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
  messages: Array<{ id: string; role: string; content: string; createdAt: string; metadata: Record<string, unknown> | null }>;
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
};

/** Exact rupees (orders need ₹605, not ₹0.6 K). */
export function inr(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  pending: { label: 'New · needs confirmation', tone: 'amber' },
  confirmed: { label: 'Confirmed', tone: 'sky' },
  preparing: { label: 'Preparing', tone: 'violet' },
  ready: { label: 'Ready', tone: 'brand' },
  out_for_delivery: { label: 'Out for delivery', tone: 'violet' },
  completed: { label: 'Completed', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'rose' },
};

export const ACTION_LABEL: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirm order',
  preparing: 'Start preparing',
  ready: 'Mark ready',
  out_for_delivery: 'Out for delivery',
  completed: 'Mark completed',
  cancelled: 'Cancel order',
};

export const CHANNEL_LABEL: Record<string, string> = { web: 'Website', whatsapp: 'WhatsApp', voice: 'Voice' };

export function paymentLabel(o: Pick<Order, 'paymentMethod' | 'paymentStatus'>) {
  const method = o.paymentMethod === 'cash_on_delivery' ? 'Cash on delivery' : o.paymentMethod === 'pay_at_outlet' ? 'Pay at outlet' : o.paymentMethod;
  return `${method} · ${o.paymentStatus === 'paid' ? 'Paid' : 'Unpaid'}`;
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
