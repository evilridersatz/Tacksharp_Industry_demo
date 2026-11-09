'use client';

import { useState } from 'react';
import { ChevronDown, Send, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, cx } from '@/components/ui';
import { toast } from '@/components/toast';
import { SpeakButton } from '@/components/jarvis';

type Answer = { answer: string | null; facts: string; source: 'ai' | 'facts'; note?: string };
type Turn = { q: string; a: Answer };

const EXAMPLES = ['How many orders came by phone yesterday?', 'Which product sold most this week?', 'Who are my top customers this month?', 'Is anything out of stock?', 'Indha vaaram sales eppadi irukku?'];

export default function JarvisAskPage() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const ask = async (question: string) => {
    const text = question.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    try {
      const a = await api.post<Answer>('/jarvis/ask', { question: text });
      setTurns((t) => [{ q: text, a }, ...t]);
      setQ('');
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Ask your data" crumb="Jarvis" />
      <Card className="mb-4 p-4">
        <form onSubmit={(e) => { e.preventDefault(); void ask(q); }} className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} placeholder="Ask about orders, sales, calls, stock, customers…" className="h-10 flex-1 rounded-[12px] border border-line bg-white px-3 text-[14px] text-ink outline-none focus:border-slate-400" aria-label="Your question" />
          <Button variant="primary" type="submit" busy={busy} disabled={q.trim().length < 3}><Send className="size-4" aria-hidden /> Ask</Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => <button key={e} type="button" onClick={() => void ask(e)} className="rounded-full border border-line bg-white px-2.5 py-1 text-[12px] text-body hover:bg-slate-50">{e}</button>)}
        </div>
        <p className="mt-3 text-[11.5px] text-faint">Jarvis answers only from this workspace’s numbers (today, yesterday, 7 and 30 days, stock, waiting customers, invoices, usage). Phone numbers are masked. If it cannot answer from them, it says what is missing.</p>
      </Card>
      <ul className="flex flex-col gap-3">
        {turns.map((t, i) => (
          <li key={i}>
            <Card className="p-4">
              <p className="text-[13px] font-semibold text-muted">{t.q}</p>
              {t.a.answer ? (
                <p className="mt-2 flex items-start gap-2 whitespace-pre-wrap text-[14px] text-ink"><Sparkles className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--industry-accent)' }} aria-hidden />{t.a.answer}</p>
              ) : <p className="mt-2 text-[13px] text-body">{t.a.note}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {t.a.answer && <SpeakButton lines={[t.a.answer]} />}
                <button type="button" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-muted hover:text-ink">Numbers used <ChevronDown className={cx('size-3.5 transition', open === i && 'rotate-180')} aria-hidden /></button>
              </div>
              {(open === i || !t.a.answer) && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-[10px] bg-slate-50 p-3 text-[11.5px] text-body">{t.a.facts}</pre>}
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
