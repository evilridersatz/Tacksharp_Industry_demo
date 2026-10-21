'use client';

import { useState } from 'react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { ErrorBanner, Skeleton } from '@/components/ui';
import { IndustryOnly } from '@/components/textile';
import { DataList, Pill, SearchBox, SourceNote, Stat, Toolbar, when } from '@/components/vertical-ui';

type Patient = { id: string; name: string | null; phone: string | null; language: string | null; source: string | null; campaign: string | null; leadStatus: string | null; lastAppointment: { reference: string; startAt: string; status: string; doctor: string } | null; openInsuranceCases: number; optedOut: boolean; isDemo: boolean };

export default function PatientsPage() {
  return (
    <>
      <PageHeader title="Patients" crumb="Clinic" />
      <IndustryOnly allow={['hospital']}>
        <Patients />
      </IndustryOnly>
    </>
  );
}

function Patients() {
  const [q, setQ] = useState('');
  const { data, error, reload } = useApi<Patient[]>(`/hospital/patients${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`, 30_000);
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  const rows = data ?? [];
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Patients" value={data ? rows.length : '…'} />
        <Stat label="From campaigns" value={data ? rows.filter((p) => ['meta', 'google'].includes(p.source ?? '')).length : '…'} />
        <Stat label="With open insurance cases" value={data ? rows.filter((p) => p.openInsuranceCases).length : '…'} />
        <Stat label="Opted out (STOP)" value={data ? rows.filter((p) => p.optedOut).length : '…'} />
      </div>
      <Toolbar><SearchBox value={q} onChange={setQ} placeholder="Name or phone" /></Toolbar>
      {!data ? <Skeleton className="h-72" /> : (
        <DataList
          rows={rows}
          rowKey={(p) => p.id}
          empty="No patients match."
          columns={[
            { head: 'Patient', cell: (p) => <div><p className="font-semibold text-ink">{p.name ?? '—'}</p><p className="text-[11.5px] text-muted">{p.phone}</p></div> },
            { head: 'Source', cell: (p) => <div><p className="text-ink">{p.source ?? '—'}</p>{p.campaign && <p className="text-[11.5px] text-muted">{p.campaign}</p>}</div> },
            { head: 'Last appointment', cell: (p) => p.lastAppointment ? <div><p className="text-ink">{when(p.lastAppointment.startAt)}</p><p className="text-[11.5px] text-muted">{p.lastAppointment.doctor}</p></div> : <span className="text-muted">—</span> },
            { head: 'Status', cell: (p) => <div className="flex flex-wrap gap-1">{p.lastAppointment && <Pill status={p.lastAppointment.status} />}{p.openInsuranceCases > 0 && <Pill tone="amber">{p.openInsuranceCases} insurance</Pill>}{p.optedOut && <Pill tone="red">opted out</Pill>}</div> },
          ]}
          card={(p) => (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><p className="font-semibold text-ink">{p.name ?? p.phone}</p><p className="truncate text-[12px] text-muted">{p.source}{p.campaign ? ` · ${p.campaign}` : ''}</p></div>
              {p.lastAppointment && <Pill status={p.lastAppointment.status} />}
            </div>
          )}
        />
      )}
      <p className="mt-2 text-[12px] text-muted">Administrative records only — no clinical information is stored here.</p>
      <SourceNote api="GET /hospital/patients" />
    </>
  );
}
