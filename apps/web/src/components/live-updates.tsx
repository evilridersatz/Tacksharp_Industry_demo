'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { onServerEvent, startLiveStream } from '@/lib/live';
import { CHANNEL_LABEL } from '@/lib/restaurant';
import { toast } from './toast';

function chime() {
  try {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const c = new C();
    for (const [f, at] of [[880, 0], [1320, 0.18]] as const) {
      const o = c.createOscillator(); const g = c.createGain();
      o.frequency.value = f; g.gain.setValueAtTime(0.0001, c.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.2, c.currentTime + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + 0.3);
      o.connect(g).connect(c.destination); o.start(c.currentTime + at); o.stop(c.currentTime + at + 0.32);
    }
  } catch { /* audio unavailable or not allowed yet */ }
}

/**
 * Signed-in dashboard: one live connection to the server. Every page reloads its data the moment an order, cart,
 * message or call changes on any channel (WhatsApp, phone, AI assistant), and a new order shows a notice with a chime
 * and a link to it, wherever staff are in the dashboard.
 */
export function LiveUpdates() {
  const pathname = usePathname();
  useEffect(() => startLiveStream(API_URL), []);
  useEffect(
    () =>
      onServerEvent((e) => {
        if (e.type === 'alert' && e.title) {
          toast(`Jarvis: ${e.title}`, e.status === 'critical' ? 'error' : 'ok', { href: '/jarvis/monitors', label: 'Open', ms: 12_000 });
          return;
        }
        // AI Office: only what needs a person (approvals, reviews, finished plans, breakers) becomes a notice.
        if (e.type === 'office.approval' && e.status === 'pending') {
          toast(`AI Office: ${e.title ?? 'an action needs your approval'}`, 'ok', { href: '/office/approvals', label: 'Review', ms: 15_000 });
          return;
        }
        if ((e.type === 'office.task' && (e.status === 'needs_review' || e.status === 'dead_letter')) || (e.type === 'office.agent' && (e.status === 'stopped' || e.status === 'constrained'))) {
          toast(`AI Office: ${e.title ?? 'needs a person'}`, 'error', { href: e.taskId ? `/office/tasks?task=${e.taskId}` : '/office', label: 'Open', ms: 12_000 });
          return;
        }
        if (e.type === 'office.plan' && (e.status === 'completed' || e.status === 'failed')) {
          if (!pathname.startsWith('/office')) toast(`AI Office: ${e.title ?? `plan ${e.status}`}`, e.status === 'completed' ? 'ok' : 'error', { href: e.planId ? `/office/command?plan=${e.planId}` : '/office/command', label: 'Open', ms: 12_000 });
          return;
        }
        if (e.type === 'order.created' && e.orderNumber) {
          const via = CHANNEL_LABEL[e.channel ?? ''] ?? e.channel ?? '';
          const total = typeof e.total === 'number' ? ` · ₹${e.total.toLocaleString('en-IN')}` : '';
          toast(`New order ${e.orderNumber}${via ? ` · ${via}` : ''}${total}${e.customer ? ` · ${e.customer}` : ''}`, 'ok', e.orderId ? { href: `/orders/${e.orderId}`, label: 'Open', ms: 15_000 } : undefined);
          if (pathname !== '/orders/board') chime(); // the board chimes by itself
        } else if (e.type === 'call.started' && e.channel === 'voice') {
          toast(`Phone call in progress${e.customer ? ` · ${e.customer}` : ''}`, 'ok', { href: '/activity', label: 'Live operations', ms: 6_000 });
        }
      }),
    [pathname],
  );
  return null;
}
