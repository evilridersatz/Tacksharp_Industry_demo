'use client';

import { useCallback, useState } from 'react';
import { CheckSquare, ShieldCheck, Square } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, ErrorBanner, Segmented, Skeleton } from '@/components/ui';
import { Dialog, IndustryOnly, Label, Notice, errorText, inputCls } from '@/components/textile';
import { DataList, Pill, SearchBox, Section, SourceNote, Stat, Timeline, Toolbar, money, when } from '@/components/vertical-ui';

type Case = {
  id: string; reference: string; kind: string; kindLabel: string; insurer: string; tpa: string | null; policyRef: string; status: string; statusLabel: string; next: string[];
  requiredDocs: string[]; receivedDocs: string[]; missingDocs: string[]; amountRequested: number | null; amountApproved: number | null; insurerReference: string | null; decisionNote: string | null; decidedBy: string | null;
  patient: { id: string; name: string | null; phone: string | null }; lastFollowUpAt: string | null; isDemo: boolean; createdAt: string; updatedAt: string;
  events?: Array<{ action: string; actor: string; at: string; data: unknown }>;
};
const DECISIONS = ['approved', 'partially_approved', 'rejected', 'settled'];
const LABEL: Record<string, string> = { ready_to_submit: 'Mark ready to submit', submitted: 'Mark submitted to insurer / TPA', query_raised: 'Record insurer query', approved: 'Record approval', partially_approved: 'Record partial approval', rejected: 'Record rejection', settled: 'Record settlement', closed: 'Close case', documents_pending: 'Back to documents pending' };

export default function InsurancePage() {
  return (
    <>
      <PageHeader title="Insurance & claims" crumb="Patient care" />
      <IndustryOnly allow={['hospital']}>
        <Insurance />
      </IndustryOnly>
    </>
  );
}

function Insurance() {
  const [filter, setFilter] = useState<'open' | 'documents_pending' | 'all'>('open');
  const [q, setQ] = useState('');
  const { data, error, reload } = useApi<Case[]>(`/hospital/insurance?${new URLSearchParams({ ...(filter !== 'all' ? { status: filter } : {}), ...(q.trim() ? { q: q.trim() } : {}) })}`, 30_000);
  const { data: all } = useApi<Case[]>('/hospital/insurance', 60_000);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const rows = all ?? [];
  return (
    <>
      <Notice notice={notice} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Open cases" value={all ? rows.filter((c) => !['settled', 'closed', 'rejected'].includes(c.status)).length : '…'} />
        <Stat label="Documents pending" value={all ? rows.filter((c) => c.status === 'documents_pending').length : '…'} tone="amber" />
        <Stat label="With insurer / TPA" value={all ? rows.filter((c) => ['submitted', 'query_raised'].includes(c.status)).length : '…'} />
        <Stat label="Approved amount (recorded)" value={all ? money(rows.reduce((a, c) => a + (c.amountApproved ?? 0), 0)) : '…'} tone="green" />
      </div>
      <p className="mb-3 flex items-start gap-2 rounded-[12px] border border-line bg-white px-3 py-2 text-[12.5px] text-body">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
        Decisions come from the insurer / TPA and are recorded here by the insurance desk with the insurer's reference. The AI assistant only reports these statuses to patients and chases missing documents.
      </p>
      <Toolbar>
        <Segmented label="Show cases" value={filter} onChange={setFilter} options={[{ value: 'open', label: 'Open' }, { value: 'documents_pending', label: 'Documents pending' }, { value: 'all', label: 'All' }]} />
        <SearchBox value={q} onChange={setQ} placeholder="Reference, insurer or patient" />
      </Toolbar>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-72" /> : (
        <DataList
          rows={data}
          rowKey={(c) => c.id}
          onOpen={(c) => setOpen(c.id)}
          empty="No insurance cases match."
          columns={[
            { head: 'Case', cell: (c) => <div><p className="font-semibold text-ink">{c.reference}</p><p className="text-[11.5px] text-muted">{c.kindLabel}</p></div> },
            { head: 'Patient', cell: (c) => <span className="text-ink">{c.patient.name ?? c.patient.phone}</span> },
            { head: 'Insurer', cell: (c) => <div><p className="text-ink">{c.insurer}</p><p className="text-[11.5px] text-muted">{c.tpa ?? 'Direct'} · {c.policyRef}</p></div> },
            { head: 'Documents', cell: (c) => <span className={c.missingDocs.length ? 'text-amber-700' : 'text-emerald-700'}>{c.receivedDocs.length}/{c.requiredDocs.length}</span> },
            { head: 'Amount', align: 'right', cell: (c) => <div><p className="text-ink">{c.amountApproved !== null ? money(c.amountApproved) : money(c.amountRequested)}</p><p className="text-[11px] text-muted">{c.amountApproved !== null ? 'approved' : c.amountRequested !== null ? 'requested' : ''}</p></div> },
            { head: 'Status', cell: (c) => <Pill status={c.status}>{c.statusLabel}</Pill> },
          ]}
          card={(c) => (
            <div>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><p className="font-semibold text-ink">{c.reference} · {c.insurer}</p><p className="truncate text-[12px] text-muted">{c.patient.name} · {c.kindLabel}</p></div>
                <Pill status={c.status}>{c.statusLabel}</Pill>
              </div>
              {c.missingDocs.length > 0 && <p className="mt-1 text-[12px] text-amber-700">Missing: {c.missingDocs.join(', ')}</p>}
            </div>
          )}
        />
      )}
      <SourceNote api="GET /hospital/insurance" />
      <Dialog open={!!open} onClose={close} title="Insurance case" wide>
        {open && <Detail id={open} onChanged={async (t) => { setNotice({ tone: 'ok', text: t }); await reload(); }} />}
      </Dialog>
    </>
  );
}

function Detail({ id, onChanged }: { id: string; onChanged: (t: string) => void }) {
  const { data: c, reload } = useApi<Case>(`/hospital/insurance/${id}`, 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [form, setForm] = useState({ insurerReference: '', amountApproved: '', note: '' });
  if (!c) return <Skeleton className="h-60" />;
  async function doc(d: string, received: boolean) {
    setBusy(d);
    setErr(null);
    try {
      await api.post(`/hospital/insurance/${id}/document`, { doc: d, received });
      await reload();
      onChanged(`${c!.reference}: ${d} ${received ? 'received' : 'removed'}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  async function move(status: string, extra: Record<string, unknown> = {}) {
    setBusy(status);
    setErr(null);
    try {
      await api.post(`/hospital/insurance/${id}/status`, { status, ...extra });
      setDeciding(null);
      await reload();
      onChanged(`${c!.reference}: ${LABEL[status] ?? status}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_250px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <p className="text-[16px] font-bold text-ink">{c.reference}</p>
          <Pill status={c.status}>{c.statusLabel}</Pill>
          {c.isDemo && <Pill tone="amber">demo · synthetic</Pill>}
        </div>
        {err && <p role="alert" className="mb-3 rounded-[10px] bg-rose-soft px-3 py-2 text-[12.5px] text-rose">{err}</p>}
        <Section title="Case">
          <p className="text-[13px] text-ink">{c.kindLabel} · {c.insurer}{c.tpa ? ` via ${c.tpa}` : ''} · policy {c.policyRef}</p>
          <p className="text-[13px] text-body">Patient: {c.patient.name} · {c.patient.phone}</p>
          <p className="text-[12.5px] text-muted">Requested {money(c.amountRequested)}{c.amountApproved !== null ? ` · approved ${money(c.amountApproved)}` : ''}{c.insurerReference ? ` · insurer ref ${c.insurerReference}` : ''}</p>
          {c.decisionNote && <p className="mt-1 rounded-[10px] bg-slate-50 px-3 py-1.5 text-[12.5px] text-body">{c.decisionNote}</p>}
          {c.decidedBy && <p className="text-[11.5px] text-muted">Decision recorded by {c.decidedBy.replace('user:', '')}</p>}
        </Section>
        <Section title={`Documents ${c.receivedDocs.length}/${c.requiredDocs.length}`}>
          <ul className="divide-y divide-line rounded-[12px] border border-line">
            {c.requiredDocs.map((d) => {
              const got = c.receivedDocs.includes(d);
              return (
                <li key={d}>
                  <button type="button" disabled={busy !== null || !['documents_pending', 'ready_to_submit', 'query_raised'].includes(c.status)} onClick={() => doc(d, !got)} className="flex min-h-11 w-full items-center gap-2.5 px-3 text-left text-[13px] disabled:cursor-default">
                    {got ? <CheckSquare className="size-4 text-emerald-600" /> : <Square className="size-4 text-faint" />}
                    <span className={got ? 'text-ink' : 'text-body'}>{d}</span>
                    {!got && <span className="ml-auto text-[11.5px] text-amber-700">missing</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {c.lastFollowUpAt && <p className="mt-1 text-[11.5px] text-muted">Last document reminder {when(c.lastFollowUpAt)} (simulated in DRY_RUN)</p>}
        </Section>
        {deciding && (
          <Section title={LABEL[deciding]}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Label text="Insurer / TPA reference"><input value={form.insurerReference} onChange={(e) => setForm({ ...form, insurerReference: e.target.value })} className={inputCls} /></Label>
              {['approved', 'partially_approved'].includes(deciding) && <Label text="Approved amount (₹)"><input type="number" min={0} value={form.amountApproved} onChange={(e) => setForm({ ...form, amountApproved: e.target.value })} className={inputCls} /></Label>}
            </div>
            <Label text="Note from the insurer's letter" className="mt-2"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={inputCls} /></Label>
            <div className="mt-2 flex gap-2"><Button variant="primary" busy={busy === deciding} onClick={() => move(deciding, { insurerReference: form.insurerReference, amountApproved: form.amountApproved ? Number(form.amountApproved) : undefined, note: form.note || undefined })}>Record</Button><Button onClick={() => setDeciding(null)}>Cancel</Button></div>
          </Section>
        )}
      </div>
      <div>
        <Section title="Next step">
          <div className="flex flex-col gap-2">
            {c.next.map((s) => (
              <Button key={s} variant={s === 'rejected' ? 'danger' : DECISIONS.includes(s) ? 'primary' : 'secondary'} busy={busy === s} disabled={busy !== null} onClick={() => (DECISIONS.includes(s) || s === 'query_raised' ? setDeciding(s) : move(s))} className="justify-start">
                {LABEL[s] ?? s}
              </Button>
            ))}
            {!c.next.length && <p className="text-[12.5px] text-muted">This case is closed.</p>}
          </div>
          <p className="mt-2 text-[11.5px] text-muted">Recording an insurer decision needs the insurance.record_decision permission.</p>
        </Section>
        <Section title="History">
          <Timeline items={(c.events ?? []).map((e) => ({ label: e.action, actor: e.actor, at: e.at, note: (e.data as { doc?: string } | null)?.doc ?? null }))} />
        </Section>
      </div>
    </div>
  );
}
