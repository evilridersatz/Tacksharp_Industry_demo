'use client';

import { useState, type ReactNode } from 'react';
import { AlertTriangle, BellRing, FileSpreadsheet, HandCoins, Info, Plus, Scale, Upload } from 'lucide-react';
import { API_URL, api, useApi } from '@/lib/api';
import { dateOnly, inr, timeAgo } from '@/lib/format';
import { Badge, Button, Card, CardHeader, Empty, Skeleton, cx, type Tone } from '@/components/ui';
import { Dialog, Label, errorText, inputCls } from '@/components/textile';

type Notify = (n: { tone: 'ok' | 'error'; text: string }) => void;

type CollectionNote = {
  id: string; type: 'contact' | 'promise' | 'dispute' | 'outcome' | 'reminder'; note: string | null; promisedAmount: number | null; promisedDate: string | null;
  status: string; approvalId: string | null; createdBy: string; createdAt: string; resolvedAt: string | null;
};
const NOTE_TONE: Record<string, Tone> = { open: 'amber', kept: 'brand', broken: 'rose', resolved: 'brand', pending_approval: 'amber', queued: 'sky', sent: 'brand', skipped: 'slate', failed: 'rose', cancelled: 'slate', recorded: 'slate' };
const NOTE_LABEL: Record<string, string> = { contact: 'Contact', promise: 'Payment promise', dispute: 'Dispute', outcome: 'Outcome', reminder: 'Reminder' };
const by = (s: string) => (s.startsWith('agent:') ? 'Finance agent' : 'team member');

// ================================================================== invoice collections panel

export function CollectionsPanel({ invoiceId, open, notify, onChanged }: { invoiceId: string; open: boolean; notify: Notify; onChanged: () => void }) {
  const { data: notes, reload } = useApi<CollectionNote[]>(`/finance/invoices/${invoiceId}/collections`, 15_000);
  const { data: check, reload: reloadCheck } = useApi<{ eligible: boolean; blocker: string | null }>(open ? `/finance/invoices/${invoiceId}/reminder-check` : null, 15_000);
  const [adding, setAdding] = useState<null | 'contact' | 'promise' | 'dispute' | 'outcome'>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => { await Promise.all([reload(), reloadCheck()]); onChanged(); };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); notify({ tone: 'ok', text: ok }); await refresh(); } catch (e) { notify({ tone: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-ink">Collections</h3>
        {open && (
          <span className="flex flex-wrap gap-1.5">
            {(['contact', 'promise', 'dispute', 'outcome'] as const).map((t) => <Button key={t} className="h-7 px-2.5 text-[12px]" onClick={() => setAdding(t)}><Plus className="size-3.5" /> {NOTE_LABEL[t]}</Button>)}
            <Button className="h-7 px-2.5 text-[12px]" variant="primary" busy={busy} disabled={!check?.eligible} onClick={() => act(() => api.post(`/finance/invoices/${invoiceId}/reminder`), 'Reminder prepared. It is sent only after approval (finance.send_reminder).')}><BellRing className="size-3.5" /> Payment reminder</Button>
          </span>
        )}
      </div>
      {open && check && !check.eligible && <p className="mb-2 text-[12px] text-muted">No reminder now: {check.blocker}.</p>}
      {!notes ? <Skeleton className="h-16" /> : notes.length === 0 ? <p className="text-[12.5px] text-muted">No contact recorded yet.</p> : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-[10px] bg-slate-50 px-3 py-2 text-[12.5px]">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink">{NOTE_LABEL[n.type]}{n.type === 'promise' && n.promisedAmount !== null ? `: ${inr(n.promisedAmount)} by ${dateOnly(n.promisedDate)}` : ''}</span>
                <Badge tone={NOTE_TONE[n.status] ?? 'slate'}>{n.status.replace(/_/g, ' ')}</Badge>
              </span>
              {n.note && <span className="block whitespace-pre-wrap text-body">{n.note}</span>}
              <span className="text-muted">{by(n.createdBy)} · {timeAgo(n.createdAt)}</span>
              {n.status === 'open' && n.type === 'promise' && (
                <span className="mt-1 flex gap-2"><button className="text-[12px] font-semibold text-brand" onClick={() => act(() => api.post(`/finance/collections/${n.id}/status`, { status: 'kept' }), 'Promise marked kept.')}>Kept</button><button className="text-[12px] font-semibold text-rose" onClick={() => act(() => api.post(`/finance/collections/${n.id}/status`, { status: 'broken' }), 'Promise marked broken.')}>Broken</button></span>
              )}
              {n.status === 'open' && n.type === 'dispute' && (
                <button className="mt-1 text-[12px] font-semibold text-brand" onClick={() => { const note = window.prompt('How was the dispute resolved?'); if (note) void act(() => api.post(`/finance/collections/${n.id}/status`, { status: 'resolved', note }), 'Dispute resolved; reminders can resume.'); }}>Mark resolved</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={adding !== null} onClose={() => setAdding(null)} title={adding ? `Record ${NOTE_LABEL[adding].toLowerCase()}` : ''}>
        {adding && <NoteForm type={adding} onSave={(body) => act(() => api.post(`/finance/invoices/${invoiceId}/collections`, { type: adding, ...body }), 'Recorded.').then(() => setAdding(null))} />}
      </Dialog>
    </div>
  );
}

function NoteForm({ type, onSave }: { type: string; onSave: (b: { note?: string; promisedAmount?: number; promisedDate?: string }) => void }) {
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  return (
    <div className="space-y-3 text-[13px]">
      {type === 'promise' && (
        <div className="grid grid-cols-2 gap-3">
          <Label text="Amount promised (₹)"><input type="number" min={1} className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} /></Label>
          <Label text="Promised date"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Label>
        </div>
      )}
      <Label text={type === 'dispute' ? 'What the customer disputes (reminders pause until resolved)' : 'Note'}><textarea className={cx(inputCls, 'h-20 py-2')} value={note} onChange={(e) => setNote(e.target.value)} /></Label>
      <div className="flex justify-end"><Button variant="primary" onClick={() => onSave({ note, ...(type === 'promise' ? { promisedAmount: Number(amount), promisedDate: date } : {}) })}>Save</Button></div>
    </div>
  );
}

// ================================================================== profitability + expenses

type Profitability = {
  days: number; revenueInvoiced: number; cashCollectedVerified: number; expenses: { total: number; byCategory: Record<string, number> };
  grossMargin: { amount: number | null; costedRevenue: number; cost: number; coveragePct: number; marginPct: number | null }; operatingEstimate: number | null; notes: string[];
};
type Expense = { id: string; spentOn: string; category: string; amount: number; vendor: string | null; reference: string | null; notes: string | null; status: string; voidReason: string | null };
const CATEGORIES = ['purchase', 'freight', 'salaries', 'rent', 'utilities', 'marketing', 'other'];

function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: 'muted' }) {
  return (
    <div className="rounded-[12px] border border-line p-3">
      <p className="text-[12px] text-muted">{label}</p>
      <p className={cx('mt-0.5 text-[20px] font-bold', tone === 'muted' ? 'text-faint' : 'text-ink')}>{value}</p>
      {sub && <p className="text-[11.5px] text-muted">{sub}</p>}
    </div>
  );
}

export function ExpensesAndMargin({ notify }: { notify: Notify }) {
  const { data: p, reload: reloadP } = useApi<Profitability>('/finance/profitability?days=30', 30_000);
  const { data: list, reload } = useApi<Expense[]>('/finance/expenses', 30_000);
  const [adding, setAdding] = useState(false);
  const refresh = async () => { await Promise.all([reload(), reloadP()]); };
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Revenue, cash and margin (30 days)" subtitle="Three different numbers: what was invoiced, what was verified in the bank, and margin where product cost is known." />
        {!p ? <Skeleton className="m-5 h-24" /> : (
          <div className="px-5 pb-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Tile label="Revenue (invoiced)" value={inr(p.revenueInvoiced)} />
              <Tile label="Cash collected (verified)" value={inr(p.cashCollectedVerified)} />
              <Tile label="Expenses recorded" value={inr(p.expenses.total)} />
              <Tile label="Gross margin" value={p.grossMargin.amount === null ? 'Not available' : inr(p.grossMargin.amount)} sub={p.grossMargin.amount === null ? 'Add unit costs in the catalogue' : `${p.grossMargin.marginPct}% on ${p.grossMargin.coveragePct}% of invoiced value`} tone={p.grossMargin.amount === null ? 'muted' : undefined} />
              <Tile label="After expenses (estimate)" value={p.operatingEstimate === null ? 'Not shown' : inr(p.operatingEstimate)} sub={p.operatingEstimate === null ? 'Only when every invoiced line has a cost' : 'Not accounting profit'} tone={p.operatingEstimate === null ? 'muted' : undefined} />
            </div>
            {p.notes.map((n) => <p key={n} className="mt-2 flex items-start gap-1.5 text-[12px] text-muted"><Info className="mt-0.5 size-3.5 shrink-0" /> {n}</p>)}
          </div>
        )}
      </Card>
      <Card className="overflow-x-auto">
        <CardHeader title="Expenses" subtitle="Recorded by your team. Voided, never deleted." action={<Button variant="primary" className="h-8" onClick={() => setAdding(true)}><Plus className="size-4" /> Record expense</Button>} />
        {!list ? <Skeleton className="m-5 h-24" /> : list.length === 0 ? <Empty icon={<HandCoins className="size-5" />} title="No expenses recorded" /> : (
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-muted"><tr>{['Date', 'Category', 'Vendor', 'Reference', 'Amount', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {list.map((e) => (
                <tr key={e.id} className={e.status === 'void' ? 'text-faint line-through' : ''}>
                  <td className="px-4 py-2">{dateOnly(e.spentOn)}</td><td className="px-4 py-2 capitalize">{e.category}</td><td className="px-4 py-2">{e.vendor ?? '-'}</td><td className="px-4 py-2">{e.reference ?? '-'}</td>
                  <td className="px-4 py-2 font-semibold">{inr(e.amount)}</td>
                  <td className="px-4 py-2 text-right">{e.status === 'recorded' ? <button className="text-[12px] text-rose" onClick={async () => { const reason = window.prompt('Why void this expense?'); if (!reason) return; try { await api.post(`/finance/expenses/${e.id}/void`, { reason }); await refresh(); } catch (err) { notify({ tone: 'error', text: errorText(err) }); } }}>Void</button> : <span className="no-underline">void: {e.voidReason}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <UnitCosts notify={notify} onChanged={() => void reloadP()} />
      <Dialog open={adding} onClose={() => setAdding(false)} title="Record an expense">
        {adding && <ExpenseForm onDone={async () => { setAdding(false); notify({ tone: 'ok', text: 'Expense recorded.' }); await refresh(); }} notify={notify} />}
      </Dialog>
    </div>
  );
}

type CostRow = { id: string; sku: string; name: string; priceUnit: string; price: number | null; priceApproved: boolean; unitCost: number | null; active: boolean };

function UnitCosts({ notify, onChanged }: { notify: Notify; onChanged: () => void }) {
  const { data, reload } = useApi<CostRow[]>('/finance/unit-costs', 0);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const save = async (r: CostRow) => {
    try {
      const v = edits[r.id];
      await api.post(`/finance/unit-costs/${r.id}`, { unitCost: v === '' || v === undefined ? null : Number(v) });
      setEdits(({ [r.id]: _x, ...rest }) => rest);
      await reload();
      onChanged();
      notify({ tone: 'ok', text: `Cost saved for ${r.name}.` });
    } catch (e) { notify({ tone: 'error', text: errorText(e) }); }
  };
  return (
    <Card className="overflow-x-auto">
      <CardHeader title="Product unit costs" subtitle="Internal: purchase / production cost per unit. Only Finance sees these; gross margin uses them." />
      {!data ? <Skeleton className="m-5 h-24" /> : data.length === 0 ? <Empty title="No products in the catalogue" /> : (
        <table className="w-full text-[12.5px]">
          <thead className="text-left text-muted"><tr>{['Product', 'Price', 'Unit cost (₹)', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {data.map((r) => (
              <tr key={r.id} className={r.active ? '' : 'text-faint'}>
                <td className="px-4 py-2">{r.name} <span className="text-muted">{r.sku}</span></td>
                <td className="px-4 py-2">{r.price === null ? '-' : `${inr(r.price)}/${r.priceUnit}`}{r.price !== null && !r.priceApproved && <span className="text-muted"> (not approved)</span>}</td>
                <td className="px-4 py-2"><input type="number" min={0} className={cx(inputCls, 'h-8 w-28')} value={edits[r.id] ?? (r.unitCost === null ? '' : String(r.unitCost))} onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })} /></td>
                <td className="px-4 py-2 text-right">{edits[r.id] !== undefined && <Button className="h-8" onClick={() => save(r)}>Save</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ExpenseForm({ onDone, notify }: { onDone: () => void; notify: Notify }) {
  const [f, setF] = useState({ spentOn: new Date().toISOString().slice(0, 10), category: 'purchase', amount: '', vendor: '', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const save = async (confirmDuplicate = false) => {
    setBusy(true);
    try {
      await api.post('/finance/expenses', { ...f, amount: Number(f.amount), confirmDuplicate });
      onDone();
    } catch (e) {
      const msg = errorText(e);
      if (/already recorded/.test(msg) && window.confirm(`${msg}\n\nRecord it again anyway?`)) return save(true);
      notify({ tone: 'error', text: msg });
    } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 text-[13px]">
      <div className="grid grid-cols-3 gap-3">
        <Label text="Date"><input type="date" className={inputCls} value={f.spentOn} onChange={(e) => setF({ ...f, spentOn: e.target.value })} /></Label>
        <Label text="Category"><select className={inputCls} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Label>
        <Label text="Amount (₹)"><input type="number" min={1} className={inputCls} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Label text="Vendor"><input className={inputCls} value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} /></Label>
        <Label text="Bill / reference no."><input className={inputCls} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Label>
      </div>
      <Label text="Notes"><input className={inputCls} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Label>
      <div className="flex justify-end"><Button variant="primary" busy={busy} onClick={() => save()}>Save</Button></div>
    </div>
  );
}

// ================================================================== bank statement matching

type MatchRow = { row: number; amount: number; reference: string; paymentId?: string; recordedAmount?: number; paymentStatus?: string; invoice?: string | null };
type MatchResult = { lines: number; matched: MatchRow[]; mismatched: MatchRow[]; unmatchedStatementLines: MatchRow[]; recordedNotInStatement: Array<{ paymentId: string; amount: number; reference: string | null; status: string; invoice: string | null }>; note: string };

export function StatementMatch({ notify, onChanged }: { notify: Notify; onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<MatchResult | null>(null);
  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_URL}/finance/statement/match`, { method: 'POST', body: form, credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message ?? `Failed (${res.status})`);
      setR(body);
      onChanged();
    } catch (e) { notify({ tone: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };
  const Section = ({ title, rows, tone }: { title: string; rows: Array<{ amount: number; reference: string | null; invoice?: string | null; recordedAmount?: number; paymentStatus?: string; status?: string }>; tone: Tone }) => (
    <div>
      <p className="mb-1 flex items-center gap-2 text-[12.5px] font-semibold text-ink"><Badge tone={tone}>{rows.length}</Badge> {title}</p>
      {rows.slice(0, 20).map((m, i) => <p key={i} className="text-[12px] text-body">{inr(m.amount)}{m.recordedAmount !== undefined && m.recordedAmount !== m.amount ? ` (recorded ${inr(m.recordedAmount)})` : ''} · {m.reference ?? 'no reference'}{m.invoice ? ` · ${m.invoice}` : ''}{m.paymentStatus || m.status ? ` · ${(m.paymentStatus ?? m.status)!.replace(/_/g, ' ')}` : ''}</p>)}
    </div>
  );
  return (
    <Card>
      <CardHeader title="Match a bank statement" subtitle="Upload your bank's CSV / Excel export. Read-only: nothing is verified; differences become reconciliation exceptions." />
      <div className="space-y-3 px-5 pb-5 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".csv,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setR(null); }} />
          <Button variant="primary" busy={busy} disabled={!file} onClick={run}><Upload className="size-4" /> Match</Button>
        </div>
        {r && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Section title="Matched to a recorded payment" rows={r.matched} tone="brand" />
            <Section title="Amount differs from the recorded payment" rows={r.mismatched} tone="rose" />
            <Section title="Money in the bank with no payment recorded" rows={r.unmatchedStatementLines} tone="amber" />
            <Section title="Recorded payments not in this statement" rows={r.recordedNotInStatement} tone="rose" />
            <p className="col-span-full flex items-center gap-1.5 text-[12px] text-muted"><Scale className="size-3.5" /> {r.note}</p>
          </div>
        )}
        {!r && <p className="flex items-center gap-1.5 text-[12px] text-muted"><FileSpreadsheet className="size-3.5" /> Needs a date, an amount / credit column and a reference / narration column (UTR is found inside the narration).</p>}
      </div>
    </Card>
  );
}

export function FinanceLimits() {
  return <p className="flex items-center gap-1.5 text-[12px] text-muted"><AlertTriangle className="size-3.5" /> Refunds and transfers are never made by Tacksharp. No payment gateway, bank feed or accounting system is connected.</p>;
}
