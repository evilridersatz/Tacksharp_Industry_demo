'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';
import { CheckCircle2, ClipboardCheck, Plus, Search, Trash2 } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Empty, ErrorBanner, Segmented, Skeleton, cx, type Tone } from '@/components/ui';
import { Dialog, IndustryOnly, Label, Notice, errorText, inputCls } from '@/components/textile';

type Inspection = {
  id: string; batchCode: string; productName: string; line: string | null; inspector: string | null; inspectedAt: string;
  inspectedQty: number; rejectedQty: number; defects: Array<{ category: string; count: number }>; defectCount: number; rejectionRate: number;
  status: 'open' | 'resolved'; severity: 'minor' | 'major' | 'critical'; notes: string | null; resolution: string | null; resolvedAt: string | null; isDemo: boolean;
};
type Stats = { inspections: number; unitsInspected: number; unitsRejected: number; defects: number; defectRate: number | null; rejectionRate: number | null; open: number; avgResolutionHours: number | null };

const SEVERITY: Record<string, Tone> = { minor: 'slate', major: 'amber', critical: 'rose' };
const CATEGORIES = ['stitching', 'dimension', 'surface finish', 'colour shade', 'packaging', 'material', 'assembly', 'contamination'];

export default function QualityPage() {
  return (
    <>
      <PageHeader title="Inspections & defects" crumb="Quality" />
      <IndustryOnly allow={['manufacturing']}>
        <Suspense>
          <Quality />
        </Suspense>
      </IndustryOnly>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'rose' | 'amber' }) {
  return (
    <Card className="p-4">
      <p className="text-[12.5px] text-muted">{label}</p>
      <p className={cx('mt-1 text-[22px] font-bold tabular', tone === 'rose' ? 'text-rose' : tone === 'amber' ? 'text-[#b45309]' : 'text-ink')}>{value}</p>
    </Card>
  );
}

function Quality() {
  const params = useSearchParams();
  const [status, setStatus] = useState<'all' | 'open' | 'resolved'>('all');
  const [q, setQ] = useState(params.get('q') ?? '');
  const query = new URLSearchParams({ ...(status !== 'all' ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const { data, error, reload } = useApi<Inspection[]>(`/quality/inspections${query ? `?${query}` : ''}`, 30_000);
  const { data: stats, reload: reloadStats } = useApi<Stats>('/quality/stats?days=30', 30_000);
  const [creating, setCreating] = useState(false);
  const [resolving, setResolving] = useState<Inspection | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const closeCreate = useCallback(() => setCreating(false), []);
  const closeResolve = useCallback(() => setResolving(null), []);
  const refresh = () => Promise.all([reload(), reloadStats()]);

  return (
    <>
      <Notice notice={notice} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {!stats && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[84px]" />)}
        {stats && (
          <>
            <Stat label="Inspections (30 days)" value={stats.inspections.toLocaleString('en-IN')} />
            <Stat label="Rejection rate" value={stats.rejectionRate === null ? '—' : `${stats.rejectionRate}%`} tone={(stats.rejectionRate ?? 0) > 5 ? 'rose' : undefined} />
            <Stat label="Defect rate" value={stats.defectRate === null ? '—' : `${stats.defectRate}%`} />
            <Stat label="Open issues" value={String(stats.open)} tone={stats.open ? 'amber' : undefined} />
          </>
        )}
      </div>
      <p className="mt-2 text-[12px] text-muted">Recorded by your team. No camera, sensor or vision model is connected; rates are calculated from the quantities entered.</p>

      <div className="mt-4 mb-3 flex flex-wrap items-center gap-2.5">
        <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }]} />
        <div className="relative min-w-0 flex-1 sm:max-w-[280px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Batch, product or line" aria-label="Search inspections" className={cx(inputCls, 'h-10 pl-9')} />
        </div>
        <Button variant="primary" onClick={() => setCreating(true)} className="ml-auto">
          <Plus className="size-4" /> Record inspection
        </Button>
      </div>

      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error && <Skeleton className="h-60" />}
      {data && !data.length && (
        <Card>
          <Empty icon={<ClipboardCheck className="size-5" />} title={q || status !== 'all' ? 'No matching inspections' : 'No inspections recorded yet'}>
            Record a batch inspection to start tracking defect and rejection rates.
          </Empty>
        </Card>
      )}
      {data && data.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {data.map((r) => (
            <li key={r.id}>
              <Card className="flex h-full flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-ink">{r.batchCode}</p>
                    <p className="truncate text-[12.5px] text-muted">{r.productName}{r.line ? ` · ${r.line}` : ''}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <Badge tone={SEVERITY[r.severity] ?? 'slate'}>{r.severity}</Badge>
                    <Badge tone={r.status === 'open' ? 'amber' : 'brand'} dot>{r.status}</Badge>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                  <div><dt className="text-muted">Inspected</dt><dd className="font-semibold text-ink tabular">{r.inspectedQty.toLocaleString('en-IN')}</dd></div>
                  <div><dt className="text-muted">Rejected</dt><dd className="font-semibold text-ink tabular">{r.rejectedQty.toLocaleString('en-IN')}</dd></div>
                  <div><dt className="text-muted">Rejection</dt><dd className={cx('font-semibold tabular', r.rejectionRate > 5 ? 'text-rose' : 'text-ink')}>{r.rejectionRate}%</dd></div>
                </dl>
                {r.defects.length > 0 && (
                  <p className="mt-2 flex flex-wrap gap-1">
                    {r.defects.map((d) => <Badge key={d.category} tone="slate">{d.category} · {d.count}</Badge>)}
                  </p>
                )}
                {r.resolution && <p className="mt-2 rounded-[10px] bg-brand-soft px-3 py-2 text-[12px] text-brand-dark"><b>Action:</b> {r.resolution}</p>}
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3 text-[11.5px] text-faint">
                  <span>{dateTime(r.inspectedAt)}{r.inspector ? ` · ${r.inspector}` : ''}{r.isDemo ? ' · demo' : ''}</span>
                  {r.status === 'open' && (
                    <Button onClick={() => setResolving(r)}>
                      <CheckCircle2 className="size-4" /> Resolve
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={creating} onClose={closeCreate} title="Record inspection" wide>
        <CreateForm
          onDone={async (text) => {
            setCreating(false);
            setNotice({ tone: 'ok', text });
            await refresh();
          }}
        />
      </Dialog>
      <Dialog open={!!resolving} onClose={closeResolve} title={resolving ? `Resolve ${resolving.batchCode}` : 'Resolve'}>
        {resolving && (
          <ResolveForm
            row={resolving}
            onDone={async (text) => {
              setResolving(null);
              setNotice({ tone: 'ok', text });
              await refresh();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function CreateForm({ onDone }: { onDone: (text: string) => void }) {
  const [f, setF] = useState({ batchCode: '', productName: '', line: '', inspector: '', inspectedQty: '', rejectedQty: '0', severity: 'minor', notes: '' });
  const [defects, setDefects] = useState<Array<{ category: string; count: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const inspected = Number(f.inspectedQty), rejected = Number(f.rejectedQty || 0);
    if (!f.batchCode.trim() || !f.productName.trim()) return setErr('Enter the batch code and product.');
    if (!(inspected > 0)) return setErr('Enter how many units were inspected.');
    if (rejected < 0 || rejected > inspected) return setErr('Rejected units must be between 0 and the units inspected.');
    setBusy(true);
    try {
      await api.post('/quality/inspections', {
        ...f, inspectedQty: inspected, rejectedQty: rejected,
        defects: defects.filter((d) => d.category.trim() && Number(d.count) > 0).map((d) => ({ category: d.category, count: Number(d.count) })),
      });
      onDone(`Batch ${f.batchCode.trim()} recorded.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {err && <p role="alert" className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Label text="Batch / lot code"><input required value={f.batchCode} onChange={set('batchCode')} className={inputCls} /></Label>
        <Label text="Product"><input required value={f.productName} onChange={set('productName')} className={inputCls} /></Label>
        <Label text="Production line"><input value={f.line} onChange={set('line')} placeholder="e.g. Line 2" className={inputCls} /></Label>
        <Label text="Inspector"><input value={f.inspector} onChange={set('inspector')} className={inputCls} /></Label>
        <Label text="Units inspected"><input required inputMode="numeric" type="number" min={1} value={f.inspectedQty} onChange={set('inspectedQty')} className={inputCls} /></Label>
        <Label text="Units rejected"><input inputMode="numeric" type="number" min={0} value={f.rejectedQty} onChange={set('rejectedQty')} className={inputCls} /></Label>
        <Label text="Severity">
          <select value={f.severity} onChange={set('severity')} className={inputCls}>
            <option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option>
          </select>
        </Label>
      </div>
      <fieldset>
        <legend className="text-[12.5px] font-semibold text-body">Defects found</legend>
        <datalist id="defect-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        <div className="mt-1 space-y-2">
          {defects.map((d, i) => (
            <div key={i} className="flex gap-2">
              <input aria-label="Defect category" list="defect-categories" value={d.category} onChange={(e) => setDefects((x) => x.map((y, j) => (j === i ? { ...y, category: e.target.value } : y)))} placeholder="Category" className={cx(inputCls, 'flex-1')} />
              <input aria-label="Defect count" type="number" min={1} value={d.count} onChange={(e) => setDefects((x) => x.map((y, j) => (j === i ? { ...y, count: e.target.value } : y)))} placeholder="Count" className={cx(inputCls, 'w-24')} />
              <button type="button" aria-label="Remove defect" onClick={() => setDefects((x) => x.filter((_, j) => j !== i))} className="grid size-9 shrink-0 place-items-center rounded-[10px] text-faint hover:text-rose"><Trash2 className="size-4" /></button>
            </div>
          ))}
          <Button type="button" onClick={() => setDefects((x) => [...x, { category: '', count: '' }])}><Plus className="size-4" /> Add defect</Button>
        </div>
      </fieldset>
      <Label text="Notes"><textarea value={f.notes} onChange={set('notes')} rows={2} className={cx(inputCls, 'h-auto py-2')} /></Label>
      <div className="flex justify-end"><Button variant="primary" type="submit" busy={busy}>Save inspection</Button></div>
    </form>
  );
}

function ResolveForm({ row, onDone }: { row: Inspection; onDone: (text: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return setErr('Describe the corrective action.');
    setBusy(true);
    try {
      await api.post(`/quality/inspections/${row.id}/resolve`, { resolution: text });
      onDone(`Batch ${row.batchCode} resolved.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-[12.5px] text-muted">Rejected {row.rejectedQty} of {row.inspectedQty} ({row.rejectionRate}%).</p>
      {err && <p role="alert" className="rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
      <Label text="Corrective action / resolution"><textarea required value={text} onChange={(e) => setText(e.target.value)} rows={3} className={cx(inputCls, 'h-auto py-2')} /></Label>
      <div className="flex justify-end"><Button variant="primary" type="submit" busy={busy}>Mark resolved</Button></div>
    </form>
  );
}
