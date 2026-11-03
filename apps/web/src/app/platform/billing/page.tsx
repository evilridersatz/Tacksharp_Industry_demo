'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApiError, api, useApi } from '@/lib/api';
import { Button, Card, CardHeader, Skeleton } from '@/components/ui';
import { inputCls } from '@/components/textile';
import { PlatformFrame } from '@/components/platform';
import { StatusBadge, day, inr, type Invoice, type Limits, type Sub } from '@/components/billing';
import { toast } from '@/components/toast';

type Overview = {
  subscriptions: Array<Sub & { organizationName: string }>;
  renewalsDue: Array<{ organizationId: string; organizationName: string; currentPeriodEnd: string; autoRenew: boolean }>;
  overdueInvoices: Array<Invoice & { organizationName: string; organizationId?: string }>;
  outstanding: { count: number; total: number };
  contracts: Array<{ id: string; name: string; billingEmail: string | null; gstin: string | null; organizations: number }>;
  plans: Array<{ code: string; name: string; limits: Limits }>;
};
const orgHref = (id: string) => `/platform/organizations/${encodeURIComponent(id)}`;

export default function PlatformBilling() {
  const { data: o, error, reload } = useApi<Overview>('/platform/billing', 60_000);
  const [c, setC] = useState({ name: '', billingEmail: '', gstin: '', billingAddress: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function addContract() {
    setBusy(true);
    try { await api.post('/platform/billing/contracts', c); toast('Contract added.'); setC({ name: '', billingEmail: '', gstin: '', billingAddress: '' }); setErrs({}); await reload(); }
    catch (e) { setErrs(e instanceof ApiError ? ((e.body as { errors?: Record<string, string> })?.errors ?? {}) : {}); toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <PlatformFrame title="Subscriptions & billing" error={error} reload={reload}>
      {!o ? <Skeleton className="h-96" /> : (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-5"><p className="text-[12.5px] text-muted">Subscriptions</p><p className="text-[22px] font-semibold tabular" data-testid="kpi-subs">{o.subscriptions.length}</p></Card>
            <Card className="p-5"><p className="text-[12.5px] text-muted">Unpaid invoices</p><p className="text-[22px] font-semibold tabular" data-testid="kpi-outstanding">{o.outstanding.count} · {inr(o.outstanding.total)}</p></Card>
            <Card className="p-5"><p className="text-[12.5px] text-muted">Renewals due (7 days)</p><p className="text-[22px] font-semibold tabular">{o.renewalsDue.length}</p></Card>
          </div>
          <p className="text-[12.5px] text-muted">No payment gateway is connected. Invoices are issued here and paid by bank transfer or UPI; staff record each payment with its reference. Organizations without a plan have no limits.</p>

          {(o.overdueInvoices.length > 0 || o.renewalsDue.length > 0) && (
            <Card data-testid="attention">
              <CardHeader title="Needs attention" />
              <ul className="grid gap-1.5 px-5 pb-4 text-[13px]">
                {o.overdueInvoices.map((i) => <li key={i.id}><StatusBadge status="issued" overdue /> {i.number} · {i.organizationName} · {inr(i.total)} · due {day(i.dueAt)}</li>)}
                {o.renewalsDue.map((r) => <li key={r.organizationId}><Link className="font-semibold text-brand underline" href={orgHref(r.organizationId)}>{r.organizationName}</Link>: period ends {day(r.currentPeriodEnd)}{r.autoRenew ? '' : ' (does not auto-renew)'}</li>)}
              </ul>
            </Card>
          )}

          <Card className="overflow-hidden">
            <CardHeader title="Subscriptions" />
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" aria-label="Subscriptions">
                <thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">Organization</th><th className="px-4 py-2">Plan</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Price</th><th className="px-4 py-2">Period ends</th><th className="px-4 py-2">Contract</th></tr></thead>
                <tbody>
                  {o.subscriptions.map((s) => (
                    <tr key={s.id} className="border-t border-line" data-testid="sub-row">
                      <td className="px-4 py-2.5"><Link className="font-semibold text-ink underline-offset-2 hover:underline" href={orgHref(s.organizationId)}>{s.organizationName}</Link></td>
                      <td className="px-4 py-2.5">{s.planName} · {s.billingCycle}</td>
                      <td className="px-4 py-2.5"><StatusBadge status={s.status} /></td>
                      <td className="px-4 py-2.5 text-right tabular">{inr(s.price)}</td>
                      <td className="px-4 py-2.5">{day(s.currentPeriodEnd)}</td>
                      <td className="px-4 py-2.5 text-muted">{s.contractName ?? '—'}</td>
                    </tr>
                  ))}
                  {!o.subscriptions.length && <tr><td colSpan={6} className="px-4 py-3 text-muted">No plans assigned yet. Assign one from an organization’s page.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title="Plans" subtitle="Default limits; each organization can be given overrides." />
              <ul className="grid gap-2 px-5 pb-4 text-[13px]">
                {o.plans.map((p) => <li key={p.code}><span className="font-semibold">{p.name}</span>: <span className="text-muted">{Object.entries(p.limits).map(([k, v]) => `${v ?? '∞'} ${k}`).join(' · ')}</span></li>)}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Enterprise contracts" subtitle="Groups organizations billed under one agreement." />
              <ul className="grid gap-1 px-5 text-[13px]">
                {o.contracts.map((c) => <li key={c.id} data-testid="contract-row"><span className="font-semibold">{c.name}</span> <span className="text-muted">· {c.organizations} organization{c.organizations === 1 ? '' : 's'}{c.gstin ? ` · GSTIN ${c.gstin}` : ''}{c.billingEmail ? ` · ${c.billingEmail}` : ''}</span></li>)}
                {!o.contracts.length && <li className="text-muted">None yet.</li>}
              </ul>
              <form className="grid gap-2 p-5 text-[13px] sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void addContract(); }}>
                <label className="grid gap-1"><span className="font-semibold">Contract name</span><input className={inputCls} value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />{errs.name && <span className="text-[12px] text-rose-700">{errs.name}</span>}</label>
                <label className="grid gap-1"><span className="font-semibold">Billing email</span><input className={inputCls} value={c.billingEmail} onChange={(e) => setC({ ...c, billingEmail: e.target.value })} />{errs.billingEmail && <span className="text-[12px] text-rose-700">{errs.billingEmail}</span>}</label>
                <label className="grid gap-1"><span className="font-semibold">GSTIN</span><input className={inputCls} value={c.gstin} onChange={(e) => setC({ ...c, gstin: e.target.value })} />{errs.gstin && <span className="text-[12px] text-rose-700">{errs.gstin}</span>}</label>
                <label className="grid gap-1"><span className="font-semibold">Billing address</span><input className={inputCls} value={c.billingAddress} onChange={(e) => setC({ ...c, billingAddress: e.target.value })} /></label>
                <div className="sm:col-span-2"><Button type="submit" variant="primary" busy={busy} disabled={!c.name.trim()}>Add contract</Button></div>
              </form>
            </Card>
          </div>
        </div>
      )}
    </PlatformFrame>
  );
}
