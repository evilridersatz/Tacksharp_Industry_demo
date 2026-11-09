/**
 * Live dashboard updates: when something changes here (an order placed by the AI assistant by chat, voice or video),
 * every open dashboard view reloads its data at once instead of waiting for its next poll. Works across tabs of the
 * same browser (BroadcastChannel) and within the tab (a window event). Carries no data, only "reload now".
 */
const EVENT = 'tacksharp:data-changed';
let channel: BroadcastChannel | null = null;
const getChannel = () => {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  try { return (channel ??= new BroadcastChannel('tacksharp-live')); } catch { return null; }
};

export function announceChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(EVENT));
  getChannel()?.postMessage(EVENT);
}

/** Calls `fn` whenever any tab announces a change. Returns the unsubscribe function. */
export function onChange(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT, fn);
  const ch = getChannel();
  const onMsg = (e: MessageEvent) => { if (e.data === EVENT) fn(); };
  ch?.addEventListener('message', onMsg);
  return () => { window.removeEventListener(EVENT, fn); ch?.removeEventListener('message', onMsg); };
}

/**
 * Server events (GET /live/events): every order, status change, cart, message and call of this organization, from
 * any channel (WhatsApp, phone calls, the AI assistant), from any device. Each event makes the open views of this tab
 * reload (coalesced), and is handed to `onServerEvent` listeners (new-order notice). One stream per tab; the browser
 * reconnects by itself, and pages keep polling as a backstop.
 */
export type ServerEvent = {
  type: 'hello' | 'order.created' | 'order.updated' | 'cart.updated' | 'message' | 'call.started' | 'call.ended' | 'change' | 'alert' | 'office.plan' | 'office.task' | 'office.agent' | 'office.approval';
  /** Jarvis alert / AI Office headline. */
  title?: string;
  planId?: string;
  taskId?: string;
  role?: string;
  orderId?: string;
  orderNumber?: string;
  channel?: string;
  status?: string;
  total?: number;
  customer?: string;
  at?: string;
};
const SERVER_EVENT = 'tacksharp:server-event';
let source: EventSource | null = null;
let users = 0;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

export function startLiveStream(apiUrl: string): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return () => undefined;
  users += 1;
  if (!source) {
    source = new EventSource(`${apiUrl}/live/events`, { withCredentials: true });
    source.onmessage = (m) => {
      let e: ServerEvent;
      try { e = JSON.parse(m.data) as ServerEvent; } catch { return; }
      if (e.type === 'hello') return;
      window.dispatchEvent(new CustomEvent<ServerEvent>(SERVER_EVENT, { detail: e }));
      // Several events at once (an order = message + cart + order) reload once.
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadTimer = null; window.dispatchEvent(new Event(EVENT)); }, 250);
    };
  }
  return () => {
    users -= 1;
    if (users <= 0 && source) { source.close(); source = null; users = 0; }
  };
}

export function onServerEvent(fn: (e: ServerEvent) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const h = (e: Event) => fn((e as CustomEvent<ServerEvent>).detail);
  window.addEventListener(SERVER_EVENT, h);
  return () => window.removeEventListener(SERVER_EVENT, h);
}
