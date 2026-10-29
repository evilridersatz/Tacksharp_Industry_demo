'use client';

import { useState } from 'react';
import { Building2, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Empty, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { Dialog, inputCls } from '@/components/textile';
import { toast } from '@/components/toast';

type Row = { id: string; name: string; location: string; type: string; bhk: number; price: number; status: string; siteVisits: number; updatedAt: string };
type Page = { total: number; page: number; pageSize: number; byStatus: Record<string, number>; rows: Row[] };
const STATUSES = ['available', 'reserved', 'sold', 'on_hold'];
const TYPES = ['apartment', 'villa', 'plot', 'independent_house', 'commercial'];
const inr = (n: number) => (n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : `₹${n.toLocaleString('en-IN')}`);
const EMPTY = { name: '', location: '', type: 'apartment', bhk: '2', price: '' };

/** Real estate property inventory: the same records the WhatsApp and voice assistants quote from. */
export default function PropertiesPage() {
  const { workspace } = useWorkspace();
  const canEdit = workspace?.role && !['viewer', 'operations', 'technician'].includes(workspace.role);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), ...(status ? { status } : {}), ...(search ? { q: search } : {}) });
  const { data, error, reload } = useApi<Page>(`/properties?${qs}`, 30_000);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy('create'); setErrs({});
    try {
      await api.post('/properties', { ...form, bhk: Number(form.bhk), price: Number(form.price) });
      toast('Property added. The assistants can offer it now.');
      setOpen(false); setForm(EMPTY); await reload();
    } catch (x) {
      setErrs(x instanceof ApiError ? ((x.body as { fields?: Record<string, string> })?.fields ?? {}) : {});
      toast(x instanceof Error ? x.message : String(x), 'error');
    } finally { setBusy(null); }
  }
  async function setRowStatus(r: Row, s: string) {
    setBusy(r.id);
    try { await api.patch(`/properties/${r.id}`, { status: s }); toast(`${r.name} marked ${s.replace('_', ' ')}.`); await reload(); } catch (x) { toast(x instanceof Error ? x.message : String(x), 'error'); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="Properties" crumb="Inventory" actions={canEdit ? <Button variant="primary" onClick={() => setOpen(true)}><Plus className="size-4" /> Add property</Button> : undefined} />
      {error && !data ? <ErrorBanner message={error} onRetry={reload} /> : !data ? <Skeleton className="h-96" /> : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {[['', 'All', data.total], ...STATUSES.map((s) => [s, s.replace('_', ' '), data.byStatus[s] ?? 0])].map(([v, l, n]) => (
              <button key={String(v)} onClick={() => { setStatus(String(v)); setPage(1); }} aria-pressed={status === v} className={cx('rounded-full px-3 py-1.5 text-[12.5px] font-semibold capitalize', status === v ? 'bg-ink text-white' : 'bg-white text-body ring-1 ring-line')}>{l} {v ? <span className="tabular opacity-70">{n}</span> : null}</button>
            ))}
          </div>
          <Card className="overflow-hidden">
            <form className="flex gap-2 border-b border-line p-3" role="search" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); setPage(1); }}>
              <label htmlFor="p-q" className="sr-only">Search properties</label>
              <input id="p-q" className={inputCls} placeholder="Name or location" value={q} onChange={(e) => setQ(e.target.value)} />
              <Button type="submit">Search</Button>
            </form>
            {data.rows.length === 0 ? (
              <Empty icon={<Building2 className="size-5" />} title={search || status ? 'No properties match' : 'No properties yet'}>{canEdit ? 'Add the properties you sell; the assistants answer enquiries from this list.' : 'An admin or manager adds properties.'}</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="bg-slate-50 text-left text-[12px] text-muted"><tr><th className="px-4 py-2">Property</th><th className="px-4 py-2">Type</th><th className="px-4 py-2 text-right">BHK</th><th className="px-4 py-2 text-right">Price</th><th className="px-4 py-2 text-right">Site visits</th><th className="px-4 py-2">Status</th></tr></thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} className="border-t border-line">
                        <td className="px-4 py-2.5"><p className="font-semibold text-ink">{r.name}</p><p className="text-[12px] text-muted">{r.location}</p></td>
                        <td className="px-4 py-2.5 capitalize">{r.type.replace('_', ' ')}</td>
                        <td className="px-4 py-2.5 text-right tabular">{r.bhk}</td>
                        <td className="px-4 py-2.5 text-right tabular">{inr(r.price)}</td>
                        <td className="px-4 py-2.5 text-right tabular">{r.siteVisits}</td>
                        <td className="px-4 py-2.5">
                          {canEdit ? (
                            <select aria-label={`Status of ${r.name}`} disabled={busy === r.id} className={cx(inputCls, 'h-8 w-auto py-0 capitalize')} value={r.status} onChange={(e) => void setRowStatus(r, e.target.value)}>
                              {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                            </select>
                          ) : <Badge tone={r.status === 'available' ? 'brand' : r.status === 'sold' ? 'slate' : 'amber'}>{r.status.replace('_', ' ')}</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12.5px] text-muted">
              <span>{data.total} propert{data.total === 1 ? 'y' : 'ies'}</span>
              <span className="flex items-center gap-1"><Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>Page {page} of {pages}<Button variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button></span>
            </div>
          </Card>
        </>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Add a property">
        <form onSubmit={create} noValidate className="grid gap-3 text-[13px]">
          {([['name', 'Name', 'text'], ['location', 'Location', 'text'], ['price', 'Price (₹)', 'number']] as const).map(([k, l, t]) => (
            <label key={k} className="grid gap-1"><span className="font-semibold">{l}</span><input type={t} className={cx(inputCls, errs[k] && 'border-rose-400')} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} aria-invalid={Boolean(errs[k])} />{errs[k] && <span className="text-[12px] text-rose-700">{errs[k]}</span>}</label>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1"><span className="font-semibold">Type</span><select className={cx(inputCls, 'capitalize')} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></label>
            <label className="grid gap-1"><span className="font-semibold">BHK</span><input type="number" min={0} max={10} className={inputCls} value={form.bhk} onChange={(e) => setForm({ ...form, bhk: e.target.value })} /></label>
          </div>
          <div className="flex justify-end gap-2 pt-1"><Button type="button" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" busy={busy === 'create'}>Add property</Button></div>
        </form>
      </Dialog>
    </>
  );
}
