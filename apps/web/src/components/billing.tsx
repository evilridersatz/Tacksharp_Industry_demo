'use client';

import { useState } from 'react';
import { ApiError, api, useApi } from '@/lib/api';
import { Badge, Button, Card, CardHeader, Skeleton, cx } from './ui';
import { Dialog, inputCls } from './textile';
import { toast } from './toast';

export type Limits = Record<'users' | 'voiceAgents' | 'workflows' | 'dripSequences' | 'mcpKeys', number | null>;
export type Sub = {
  id: string; organizationId: string; planCode: string; planName: string; status: string; billingCycle: string; price: number; taxRatePct: number; limitsOverride: Partial<Limits> | null;
  trialEndsAt: string | null; currentPeriodStart: string; currentPeriodEnd: string; autoRenew: boolean; contractId: string | null; contractName: string | null; notes: string | null;
};
export type Invoice = {
  id: string; number: string; description: string; periodStart: string; periodEnd: string; subtotal: number; taxRatePct: number; tax: number; total: number; status: string;
  issuedAt: string; dueAt: string; paidAt: string | null; paymentReference: string | null; voidReason: string | null; overdue: boolean;
};
export type Summary = { subscription: Sub | null; limits: Limits | null; usage: Record<keyof Limits, number>; invoices: Invoice[]; note: string };
type OrgBilling = Summary & { organization: { id: string; name: string }; plans: Array<{ code: string; name: string; limits: Limits }>; contracts: Array<{ id: string; name: string }> };

export const RESOURCE_LABEL: Record<keyof Limits, string> = { users: 'Team members', voiceAgents: 'Voice agents', workflows: 'Workflows', dripSequences: 'Drip sequences', mcpKeys: 'MCP access keys' };
export const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const STATUS_TONE: Record<string, 'brand' | 'amber' | 'rose' | 'slate'> = { active: 'brand', trial: 'amber', past_due: 'rose', cancelled: 'slate', issued: 'amber', paid: 'brand', void: 'slate' };
export const StatusBadge = ({ status, overdue }: { status: string; overdue?: boolean }) => <Badge tone={overdue ? 'rose' : STATUS_TONE[status] ?? 'slate'}>{overdue ? 'overdue' : status.replace('_', ' ')}</Badge>;

/** Usage against the plan: one bar per limited resource. */
export function UsageBars({ limits, usage }: { limits: Limits | null; usage: Summary['usage'] }) {
  return (
    <ul className="grid gap-3" aria-label="Plan usage">
      {(Object.keys(RESOURCE_LABEL) as Array<keyof Limits>).map((k) => {
        const limit = limits ? limits[k] : null;
        const used = usage[k];
        const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
        const full = limit !== null && used >= limit;
        return (
          <li key={k} data-testid="usage-row" className="grid gap-1 text-[13px]">
            <span className="flex justify-between gap-2"><span className="font-semibold text-ink">{RESOURCE_LABEL[k]}</span><span className={cx('tabular', full && limit !== 0 ? 'font-semibold text-rose-700' : 'text-muted')}>{used} of {limit === null ? 'unlimited' : limit}{limit === 0 ? ' (not included)' : full ? ' (limit reached)' : ''}</span></span>
            {limit !== null && <span className="h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`${RESOURCE_LABEL[k]} used`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)}><span className={cx('block h-full rounded-full', limit === 0 ? 'bg-slate-300' : full ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand')} style={{ width: `${pct}%` }} /></span>}
          </li>
        );
      })}
    </ul>
  );
}

export function InvoiceTable({ invoices, actions }: { invoices: Invoice[]; actions?: (i: Invoice) => React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]" aria-label="Invoices">
        <thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">Invoice</th><th className="px-4 py-2">Period</th><th className="px-4 py-2 text-right">Amount (incl. GST)</th><th className="px-4 py-2">Status</th>{actions && <th className="px-4 py-2"><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id} data-testid="invoice-row" className="border-t border-line align-top">
              <td className="px-4 py-2.5"><p className="font-semibold text-ink">{i.number}</p><p className="text-[12px] text-muted">Issued {day(i.issuedAt)} · due {day(i.dueAt)}</p></td>
              <td className="px-4 py-2.5">{day(i.periodStart)} – {day(i.periodEnd)}</td>
              <td className="px-4 py-2.5 text-right tabular"><p className="font-semibold">{inr(i.total)}</p><p className="text-[12px] text-muted">{inr(i.subtotal)} + {i.taxRatePct}% GST {inr(i.tax)}</p></td>
              <td className="px-4 py-2.5"><StatusBadge status={i.status} overdue={i.overdue} />{i.status === 'paid' && <p className="mt-1 text-[12px] text-muted">{day(i.paidAt)} · ref {i.paymentReference}</p>}{i.status === 'void' && <p className="mt-1 text-[12px] text-muted">{i.voidReason}</p>}</td>
              {actions && <td className="px-4 py-2.5"><span className="flex justify-end gap-1.5">{actions(i)}</span></td>}
            </tr>
          ))}
          {!invoices.length && <tr><td colSpan={actions ? 5 : 4} className="px-4 py-3 text-muted">No invoices yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const toDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/** Platform console: an organization's plan, limits, billing period and Tacksharp invoices. */
export function SubscriptionAdmin({ orgId }: { orgId: string }) {
  const path = `/platform/billing/organizations/${encodeURIComponent(orgId)}`;
  const { data: b, error, reload } = useApi<OrgBilling>(path, 60_000);
  const [form, setForm] = useState<Record<string, string | boolean> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pay, setPay] = useState<Invoice | null>(null);
  const [voiding, setVoiding] = useState<Invoice | null>(null);
  const [text, setText] = useState('');

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast(ok); await reload(); return true; } catch (e) {
      const errs = e instanceof ApiError ? ((e.body as { errors?: Record<string, string> } | undefined)?.errors ?? {}) : {};
      setErrors(errs); toast(msg(e), 'error'); return false;
    } finally { setBusy(null); }
  }
  if (error) return <Card><CardHeader title="Subscription & invoices" /><p className="px-5 pb-4 text-[13px] text-rose-700">{error}</p></Card>;
  if (!b) return <Skeleton className="h-64" />;
  const s = b.subscription;
  const f = form ?? {
    planCode: s?.planCode ?? 'pilot', status: s?.status ?? 'active', billingCycle: s?.billingCycle ?? 'monthly', price: String(s?.price ?? ''), taxRatePct: String(s?.taxRatePct ?? 18),
    currentPeriodStart: '', trialEndsAt: toDate(s?.trialEndsAt), autoRenew: s?.autoRenew ?? true, contractId: s?.contractId ?? '', notes: s?.notes ?? '',
    ...Object.fromEntries((Object.keys(RESOURCE_LABEL) as Array<keyof Limits>).map((k) => [`ov_${k}`, s?.limitsOverride && k in s.limitsOverride ? (s.limitsOverride[k] === null ? 'unlimited' : String(s.limitsOverride[k])) : ''])),
  };
  const set = (k: string, v: string | boolean) => setForm({ ...f, [k]: v });
  const plan = b.plans.find((p) => p.code === f.planCode);
  const fieldErr = (k: string) => errors[k] && <span className="text-[12px] text-rose-700">{errors[k]}</span>;

  function save() {
    const override: Record<string, number | null> = {};
    for (const k of Object.keys(RESOURCE_LABEL)) { const v = String(f[`ov_${k}`] ?? '').trim(); if (v) override[k] = v === 'unlimited' ? null : Number(v); }
    const body: Record<string, unknown> = { planCode: f.planCode, status: f.status, billingCycle: f.billingCycle, price: Number(f.price || 0), taxRatePct: Number(f.taxRatePct), autoRenew: f.autoRenew, contractId: f.contractId || null, notes: f.notes, trialEndsAt: f.trialEndsAt || null, limitsOverride: Object.keys(override).length ? override : null };
    if (f.currentPeriodStart) body.currentPeriodStart = `${f.currentPeriodStart}T00:00:00Z`;
    void run('save', () => api.put(`${path}/subscription`, body), s ? 'Subscription updated.' : 'Plan assigned.').then((ok) => { if (ok) { setForm(null); setErrors({}); } });
  }

  return (
    <Card data-testid="subscription-admin">
      <CardHeader title="Subscription & invoices" subtitle={s ? `${s.planName} · ${s.billingCycle} · period ${day(s.currentPeriodStart)} – ${day(s.currentPeriodEnd)}${s.contractName ? ` · contract ${s.contractName}` : ''}` : 'No plan assigned: this organization has no limits.'} action={s && <StatusBadge status={s.status} />} />
      <form className="grid gap-3 px-5 pb-4 text-[13px] sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="grid gap-1"><span className="font-semibold">Plan</span><select className={inputCls} value={String(f.planCode)} onChange={(e) => set('planCode', e.target.value)}>{b.plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>{fieldErr('planCode')}</label>
        <label className="grid gap-1"><span className="font-semibold">Status</span><select className={inputCls} value={String(f.status)} onChange={(e) => set('status', e.target.value)}>{['trial', 'active', 'past_due', 'cancelled'].map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}</select>{fieldErr('status')}</label>
        <label className="grid gap-1"><span className="font-semibold">Billing cycle</span><select className={inputCls} value={String(f.billingCycle)} onChange={(e) => set('billingCycle', e.target.value)}>{['monthly', 'quarterly', 'yearly'].map((x) => <option key={x}>{x}</option>)}</select>{fieldErr('billingCycle')}</label>
        <label className="grid gap-1"><span className="font-semibold">Price per cycle (₹, before GST)</span><input className={inputCls} inputMode="decimal" value={String(f.price)} onChange={(e) => set('price', e.target.value)} />{fieldErr('price')}</label>
        <label className="grid gap-1"><span className="font-semibold">GST rate (%)</span><input className={inputCls} inputMode="decimal" value={String(f.taxRatePct)} onChange={(e) => set('taxRatePct', e.target.value)} />{fieldErr('taxRatePct')}</label>
        <label className="grid gap-1"><span className="font-semibold">{s ? 'Restart period on (optional)' : 'Period starts (default today)'}</span><input type="date" className={inputCls} value={String(f.currentPeriodStart)} onChange={(e) => set('currentPeriodStart', e.target.value)} />{fieldErr('currentPeriodStart')}</label>
        <label className="grid gap-1"><span className="font-semibold">Trial ends</span><input type="date" className={inputCls} value={String(f.trialEndsAt)} onChange={(e) => set('trialEndsAt', e.target.value)} />{fieldErr('trialEndsAt')}</label>
        <label className="grid gap-1"><span className="font-semibold">Enterprise contract</span><select className={inputCls} value={String(f.contractId)} onChange={(e) => set('contractId', e.target.value)}><option value="">None</option>{b.contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>{fieldErr('contractId')}</label>
        <fieldset className="grid gap-2 sm:col-span-2">
          <legend className="mb-1 font-semibold">Limit overrides <span className="font-normal text-muted">(blank = plan default; a number or “unlimited”)</span></legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(RESOURCE_LABEL) as Array<keyof Limits>).map((k) => (
              <label key={k} className="grid gap-1"><span className="text-[12px] text-muted">{RESOURCE_LABEL[k]} (plan: {plan ? plan.limits[k] ?? 'unlimited' : '—'})</span><input aria-label={`Override ${RESOURCE_LABEL[k]}`} className={inputCls} value={String(f[`ov_${k}`] ?? '')} onChange={(e) => set(`ov_${k}`, e.target.value)} /></label>
            ))}
          </div>
          {fieldErr('limitsOverride')}
        </fieldset>
        <label className="grid gap-1 sm:col-span-2"><span className="font-semibold">Internal notes</span><input className={inputCls} value={String(f.notes)} onChange={(e) => set('notes', e.target.value)} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(f.autoRenew)} onChange={(e) => set('autoRenew', e.target.checked)} /> Renews automatically (period rolls forward; nothing is charged)</label>
        <div className="flex flex-wrap justify-end gap-2 sm:col-span-1">
          <Button type="submit" variant="primary" busy={busy === 'save'}>{s ? 'Save subscription' : 'Assign plan'}</Button>
        </div>
      </form>
      {s && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
            <Button busy={busy === 'issue'} onClick={() => void run('issue', () => api.post(`${path}/invoices`), 'Invoice issued.')}>Issue invoice for this period</Button>
            <Button busy={busy === 'renew'} onClick={() => void run('renew', () => api.post(`${path}/renew`), 'Renewed: the period moved forward.')}>Renew period</Button>
            <span className="text-[12px] text-muted">Usage: {(Object.keys(RESOURCE_LABEL) as Array<keyof Limits>).map((k) => `${RESOURCE_LABEL[k].toLowerCase()} ${b.usage[k]}/${b.limits?.[k] ?? '∞'}`).join(' · ')}</span>
          </div>
          <InvoiceTable invoices={b.invoices} actions={(i) => i.status === 'issued' ? (<><Button onClick={() => { setPay(i); setText(''); }}>Mark paid</Button><Button variant="danger" onClick={() => { setVoiding(i); setText(''); }}>Void</Button></>) : null} />
        </>
      )}
      <Dialog open={pay !== null} onClose={() => setPay(null)} title={`Record payment for ${pay?.number ?? ''}`}>
        <form className="grid gap-3 text-[13px]" onSubmit={(e) => { e.preventDefault(); void run('pay', () => api.post(`/platform/billing/invoices/${pay!.id}/paid`, { reference: text }), 'Payment recorded.').then((ok) => ok && setPay(null)); }}>
          <p>{pay && inr(pay.total)} received. Record the bank / UPI transaction reference exactly as on the statement.</p>
          <label className="grid gap-1"><span className="font-semibold">Payment reference</span><input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" /></label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setPay(null)}>Cancel</Button><Button type="submit" variant="primary" busy={busy === 'pay'} disabled={text.trim().length < 3}>Record payment</Button></div>
        </form>
      </Dialog>
      <Dialog open={voiding !== null} onClose={() => setVoiding(null)} title={`Void ${voiding?.number ?? ''}?`}>
        <form className="grid gap-3 text-[13px]" onSubmit={(e) => { e.preventDefault(); void run('void', () => api.post(`/platform/billing/invoices/${voiding!.id}/void`, { reason: text }), 'Invoice voided.').then((ok) => ok && setVoiding(null)); }}>
          <p>The invoice stays on record as void; its number is never reused.</p>
          <label className="grid gap-1"><span className="font-semibold">Reason</span><input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} /></label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setVoiding(null)}>Cancel</Button><Button type="submit" variant="danger" busy={busy === 'void'} disabled={text.trim().length < 3}>Void invoice</Button></div>
        </form>
      </Dialog>
    </Card>
  );
}
