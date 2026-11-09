import type { PrismaService } from '../../prisma/prisma.service.js';
import type { LiveEvent } from '../../common/live-events.js';
import { errorMessage, log } from '../../common/logger.js';

/**
 * Versioned business events from other Tacksharp products. A product publishes; Office workflows subscribe by type
 * and version. Products never call Office code, and an event type never changes shape within a version (a new shape
 * is a new version), so either side can change without breaking the other.
 */
export const BUSINESS_EVENTS = {
  'order.created.v1': 'A new order (WhatsApp, phone, dashboard or website)',
  'order.updated.v1': 'An order changed status',
  'call.ended.v1': 'A voice call ended',
  'alert.raised.v1': 'Jarvis raised a monitor alert',
} as const;
export type BusinessEventType = keyof typeof BUSINESS_EVENTS;

export type BusinessEvent = { type: string; version: number; key: string; payload: Record<string, unknown> };

/** Record an event once (same organization + key = stored once). Never throws. */
export async function publishBusinessEvent(prisma: PrismaService, organizationId: string, e: BusinessEvent): Promise<void> {
  try {
    await prisma.officeEvent.create({ data: { organizationId, type: e.type.slice(0, 60), version: e.version, key: e.key.slice(0, 191), payload: e.payload as never } });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return;
    log.warn('office.event_failed', { organizationId, type: e.type, error: errorMessage(err) });
  }
}

/**
 * The existing products already announce changes on the live bus; this maps those announcements to versioned events
 * (only ids, numbers and statuses: no customer names or phones).
 */
export function fromLive(event: LiveEvent, now = new Date()): BusinessEvent | null {
  const at = event.at ?? now.toISOString();
  switch (event.type) {
    case 'order.created':
      return event.orderId ? { type: 'order.created', version: 1, key: `order.created:${event.orderId}`, payload: { orderId: event.orderId, orderNumber: event.orderNumber ?? null, channel: event.channel ?? null, total: event.total === undefined ? null : Number(event.total), status: event.status ?? null, at } } : null;
    case 'order.updated':
      return event.orderId ? { type: 'order.updated', version: 1, key: `order.updated:${event.orderId}:${event.status ?? ''}`, payload: { orderId: event.orderId, orderNumber: event.orderNumber ?? null, status: event.status ?? null, at } } : null;
    case 'call.ended':
      return { type: 'call.ended', version: 1, key: `call.ended:${event.channel ?? 'voice'}:${at}`, payload: { channel: event.channel ?? null, status: event.status ?? null, at } };
    case 'alert':
      return { type: 'alert.raised', version: 1, key: `alert:${event.title ?? ''}:${at.slice(0, 13)}`, payload: { title: event.title ?? null, severity: event.status ?? null, at } };
    default:
      return null;
  }
}

export const eventName = (type: string, version: number) => `${type}.v${version}`;
