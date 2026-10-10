'use client';

import Link from 'next/link';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { FlaskConical, Loader2, RotateCcw, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { qty } from '@/lib/restaurant';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, ErrorBanner, Field, cx } from '@/components/ui';

type Line = { role: 'user' | 'assistant'; text: string };
type Draft = { lines: Array<{ name: string; quantity?: number; unit: string; cut?: string }>; payment?: string; pickupAt?: string; outlet?: string; offer?: number };
type Reply = { reply: string; step: string; draft: Draft; order: { orderNumber: string; id: string; total: number; status: string } | null; path: string };

const PAYMENT: Record<string, string> = { cash_at_shop: 'Cash at shop', upi_at_shop: 'UPI at shop', paid_online: 'Paid online (verify)' };

/** WhatsApp-style *bold* → <b>. */
function rich(text: string): ReactNode {
  return text.split('\n').map((line, i, all) => (
    <Fragment key={i}>
      {line.split(/(\*[^*\n]+\*)/g).map((part, j) => (part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <b key={j}>{part.slice(1, -1)}</b> : part))}
      {i < all.length - 1 && <br />}
    </Fragment>
  ));
}

const SAMPLES = ['Hi', 'rendu kilo broiler curry cut', 'gpay', 'saayangaalam 6 mani varen', 'sari', 'ரெண்டு கிலோ நாட்டு கோழி கறி கட், cash, நாளைக்கு காலைல 10 மணி'];

/**
 * Chat with the assistant exactly as a WhatsApp customer would (same offer, same order flow, real
 * orders on the dashboard marked "Test chat"). Nothing is sent on WhatsApp.
 */
export default function TestChatPage() {
  const [phone, setPhone] = useState('9000000001');
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [order, setOrder] = useState<Reply['order']>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines]);

  async function send(m: string) {
    const message = m.trim();
    if (!message || busy) return;
    setText('');
    setError(null);
    setLines((l) => [...l, { role: 'user', text: message }]);
    setBusy(true);
    try {
      const r = await api.post<Reply>('/restaurant/test-chat', { phone, message, name: 'Test customer' });
      setLines((l) => [...l, { role: 'assistant', text: r.reply }]);
      setDraft(r.draft);
      if (r.order) setOrder(r.order);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Test chat" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="flex h-[calc(100dvh-180px)] min-h-[520px] flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <FlaskConical className="size-4 text-violet" />
            <span className="text-[13px] font-semibold text-ink">Chat as customer</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
              aria-label="Test customer mobile number"
              className="tabular h-8 w-[130px] rounded-[8px] border border-line px-2 text-[13px]"
            />
            <span className="text-[12px] text-muted">Each number is one customer (one ₹50 link offer per number).</span>
            <Button
              className="ml-auto h-8"
              onClick={() => {
                setPhone(`9${String(Date.now()).slice(-9)}`);
                setLines([]);
                setDraft(null);
                setOrder(null);
              }}
            >
              <RotateCcw className="size-3.5" /> New customer
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto bg-[#efeae2] px-3 py-4 pane-scroll" aria-live="polite">
            {!lines.length && <p className="mx-auto mt-6 max-w-sm rounded-[12px] bg-white p-4 text-center text-[13px] text-body shadow-sm">Say “Hi” as the customer — the assistant starts the ₹50 offer chat in Tanglish, or Tamil if you write in Tamil.</p>}
            <div className="flex flex-col gap-2">
              {lines.map((l, i) => (
                <div key={i} className={cx('flex', l.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <p className={cx('max-w-[85%] rounded-[12px] px-3 py-2 text-[13.5px] leading-relaxed shadow-sm', l.role === 'user' ? 'rounded-tr-[4px] bg-[#d9fdd3] text-ink' : 'rounded-tl-[4px] bg-white text-ink')}>{rich(l.text)}</p>
                </div>
              ))}
              {busy && (
                <p className="inline-flex w-fit items-center gap-2 rounded-[12px] bg-white px-3 py-2 text-[13px] text-muted shadow-sm">
                  <Loader2 className="size-3.5 animate-spin" /> typing…
                </p>
              )}
            </div>
            <div ref={end} />
          </div>
          {error && (
            <div className="px-3 pt-2">
              <ErrorBanner message={error} />
            </div>
          )}
          <div className="flex gap-1.5 overflow-x-auto px-3 pt-2 pane-scroll">
            {SAMPLES.map((s) => (
              <button key={s} onClick={() => send(s)} disabled={busy} className="shrink-0 rounded-full border border-line bg-white px-3 py-1 text-[12px] text-body hover:bg-slate-50 disabled:opacity-50">
                {s}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
            className="flex items-center gap-2 p-3"
          >
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="Type as the customer (Tanglish, Tamil or English)…" aria-label="Message" className="h-11 flex-1 rounded-full border border-line px-4 text-[14px] text-ink placeholder:text-faint" />
            <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="grid size-11 place-items-center rounded-full bg-brand text-white disabled:opacity-50">
              <Send className="size-4" />
            </button>
          </form>
        </Card>

        <Card className="self-start">
          <CardHeader title="What the assistant has collected" subtitle="Server-side state for this customer" />
          <div className="px-5 pb-5 text-[13px]">
            {draft?.offer ? <Badge tone="violet">₹{draft.offer} offer active</Badge> : <Badge tone="slate">No offer</Badge>}
            <ul className="mt-3 flex flex-col gap-1.5">
              {(draft?.lines ?? []).map((l, i) => (
                <li key={i} className="rounded-[8px] bg-slate-50 px-3 py-2">
                  <b>{l.quantity !== undefined ? qty(l.quantity, l.unit) : '? kg'}</b> {l.name}
                  <span className="text-muted"> · {l.cut ?? 'cut ?'}</span>
                </li>
              ))}
              {!draft?.lines.length && <li className="text-muted">No products yet</li>}
            </ul>
            <div className="mt-3">
              <Field label="Payment">{draft?.payment ? PAYMENT[draft.payment] : '—'}</Field>
              <Field label="Collect">{draft?.pickupAt ? new Date(draft.pickupAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—'}</Field>
              <Field label="Shop">{draft?.outlet ?? '—'}</Field>
            </div>
            {order && (
              <p className="mt-3 rounded-[10px] bg-brand-soft px-3 py-2 text-brand-dark">
                Order placed:{' '}
                <Link href={`/orders?id=${order.id}`} className="font-bold underline">
                  {order.orderNumber}
                </Link>{' '}
                — mark it Ready there to trigger the ready call.
              </p>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
