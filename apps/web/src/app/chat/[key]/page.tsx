'use client';

import { useParams } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2, RotateCcw, Send, ShoppingBag } from 'lucide-react';
import { API_URL } from '@/lib/api';
import { cx } from '@/components/ui';

type Line = { role: 'user' | 'assistant'; text: string; at: number };
type CartLine = { name: string; quantity: number; unitPrice: number; lineTotal: number };

/** WhatsApp-style *bold* → <b>, keeping everything else as plain text. */
function rich(text: string): ReactNode {
  return text.split('\n').map((line, i, all) => (
    <Fragment key={i}>
      {line.split(/(\*[^*\n]+\*)/g).map((part, j) => (part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <b key={j}>{part.slice(1, -1)}</b> : part))}
      {i < all.length - 1 && <br />}
    </Fragment>
  ));
}

function newSessionId() {
  const raw = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web-${raw}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function storageKey(key: string) {
  return `tacksharp-chat:${key}`;
}

/** Public website chat for a restaurant (customers are not logged in). */
export default function PublicChatPage() {
  const { key } = useParams<{ key: string }>();
  const [info, setInfo] = useState<{ businessName: string; demo: boolean } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sessionId, setSessionId] = useState<string>('');
  const [lines, setLines] = useState<Line[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let id = '';
    let saved: Line[] = [];
    try {
      const raw = localStorage.getItem(storageKey(key));
      if (raw) ({ id, lines: saved } = JSON.parse(raw));
    } catch {
      /* private mode: start fresh */
    }
    setSessionId(id || newSessionId());
    setLines(saved ?? []);
    fetch(`${API_URL}/public/chat/${encodeURIComponent(key)}`)
      .then(async (r) => (r.ok ? setInfo(await r.json()) : setNotFound(true)))
      .catch(() => setError('Chat is unavailable right now. Please try again shortly.'));
  }, [key]);

  useEffect(() => {
    if (!sessionId) return;
    try {
      localStorage.setItem(storageKey(key), JSON.stringify({ id: sessionId, lines: lines.slice(-60) }));
    } catch {
      /* ignore */
    }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lines, sessionId, key]);

  async function send(message: string) {
    const m = message.trim();
    if (!m || sending || !sessionId) return;
    setText('');
    setError(null);
    setLines((l) => [...l, { role: 'user', text: m, at: Date.now() }]);
    setSending(true);
    try {
      const r = await fetch(`${API_URL}/public/chat/${encodeURIComponent(key)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: m }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.message ?? 'Message failed');
      setLines((l) => [...l, { role: 'assistant', text: body.reply, at: Date.now() }]);
      setCart(body.cart ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Message failed. Please try again.');
    } finally {
      setSending(false);
    }
  }

  function restart() {
    const id = newSessionId();
    setSessionId(id);
    setLines([]);
    setCart([]);
  }

  if (notFound) {
    return <main className="grid min-h-screen place-items-center p-6 text-center text-[14px] text-muted">This chat link is not valid.</main>;
  }

  const total = cart.reduce((s, l) => s + l.lineTotal, 0);
  const quick = ['Menu', 'My cart', 'Checkout', 'Order status', 'Talk to staff'];

  return (
    <main className="mx-auto flex h-[100dvh] max-w-[720px] flex-col bg-white sm:my-4 sm:h-[calc(100dvh-2rem)] sm:rounded-[18px] sm:border sm:border-line sm:shadow-[var(--shadow-card)]">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="grid size-10 place-items-center rounded-full bg-gradient-to-br from-amber to-rose text-[15px] font-black text-white">GR</span>
        <div className="flex-1 leading-tight">
          <p className="text-[15px] font-bold text-ink">{info?.businessName ?? '…'}</p>
          <p className="text-[12px] text-muted">AI ordering assistant · replies instantly</p>
        </div>
        <button onClick={restart} title="Start a new chat" aria-label="Start a new chat" className="text-muted hover:text-ink">
          <RotateCcw className="size-4" />
        </button>
      </header>
      {info?.demo && (
        <p className="flex items-center gap-2 bg-[#fffbeb] px-4 py-2 text-[12px] text-[#92400e]">
          <AlertTriangle className="size-3.5 shrink-0" /> Demo: sample menu and prices. Orders are not sent to a real restaurant.
        </p>
      )}

      <div className="flex-1 overflow-y-auto bg-[#f6f8fb] px-3 py-4 pane-scroll" aria-live="polite">
        {!lines.length && (
          <div className="mx-auto mt-6 max-w-sm rounded-[14px] bg-white p-4 text-center text-[13.5px] text-body shadow-sm">
            Hi! I can show you the menu and take your order. Try <b>“menu”</b> or <b>“2 chicken biryani”</b>.
          </div>
        )}
        <div className="flex flex-col gap-2">
          {lines.map((l, i) => (
            <div key={i} className={cx('flex', l.role === 'user' ? 'justify-end' : 'justify-start')}>
              <p
                className={cx(
                  'max-w-[85%] rounded-[16px] px-3.5 py-2 text-[13.5px] leading-relaxed',
                  l.role === 'user' ? 'rounded-br-[4px] bg-brand text-white' : 'rounded-bl-[4px] bg-white text-ink shadow-sm',
                )}
              >
                {rich(l.text)}
              </p>
            </div>
          ))}
          {sending && (
            <p className="inline-flex w-fit items-center gap-2 rounded-[16px] bg-white px-3.5 py-2 text-[13px] text-muted shadow-sm">
              <Loader2 className="size-3.5 animate-spin" /> typing…
            </p>
          )}
        </div>
        <div ref={endRef} />
      </div>

      {cart.length > 0 && (
        <button onClick={() => send('my cart')} className="flex items-center gap-2 border-t border-line bg-brand-soft px-4 py-2 text-left text-[12.5px] font-semibold text-brand-dark">
          <ShoppingBag className="size-4" /> {cart.reduce((s, l) => s + l.quantity, 0)} items · ₹{total.toLocaleString('en-IN')} — tap to view cart
        </button>
      )}
      {error && <p role="alert" className="border-t border-rose-soft bg-rose-soft px-4 py-2 text-[12.5px] text-rose">{error}</p>}

      <div className="flex gap-1.5 overflow-x-auto border-t border-line px-3 pt-2 pane-scroll">
        {quick.map((q) => (
          <button key={q} onClick={() => send(q)} disabled={sending} className="shrink-0 rounded-full border border-line px-3 py-1 text-[12.5px] font-semibold text-body hover:bg-slate-50 disabled:opacity-50">
            {q}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        className="flex items-center gap-2 px-3 py-3"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          placeholder="Type your order or question…"
          aria-label="Message"
          className="h-11 flex-1 rounded-full border border-line px-4 text-[14px] text-ink placeholder:text-faint"
        />
        <button type="submit" disabled={sending || !text.trim()} aria-label="Send" className="grid size-11 place-items-center rounded-full bg-brand text-white disabled:opacity-50">
          <Send className="size-4" />
        </button>
      </form>
    </main>
  );
}
