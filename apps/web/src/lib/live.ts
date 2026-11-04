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
