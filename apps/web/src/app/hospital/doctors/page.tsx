'use client';

import { Stethoscope } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Card, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { IndustryOnly } from '@/components/textile';
import { Pill, SourceNote, Stat, money } from '@/components/vertical-ui';

type Dir = Array<{ id: string; name: string; description: string | null; active: boolean; doctors: Array<{ id: string; name: string; qualification: string | null; specialty: string | null; languages: string | null; consultationFee: number; slotMinutes: number; schedule: Array<{ day: number; start: string; end: string }>; leaveDates: string[]; active: boolean }> }>;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function DoctorsPage() {
  return (
    <>
      <PageHeader title="Doctors & OPD hours" crumb="Clinic" />
      <IndustryOnly allow={['hospital']}>
        <Doctors />
      </IndustryOnly>
    </>
  );
}

function Doctors() {
  const { data, error, reload } = useApi<Dir>('/hospital/directory', 60_000);
  if (error && !data) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-96" />;
  const docs = data.flatMap((d) => d.doctors);
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Departments" value={data.length} />
        <Stat label="Doctors" value={docs.filter((d) => d.active).length} />
        <Stat label="OPD hours / week" value={Math.round(docs.reduce((a, d) => a + d.schedule.reduce((x, b) => x + (Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3)) - Number(b.start.slice(0, 2)) * 60 - Number(b.start.slice(3))) / 60, 0), 0))} />
        <Stat label="On leave (upcoming)" value={docs.filter((d) => d.leaveDates.length).length} />
      </div>
      {data.map((dept) => (
        <section key={dept.id} className="mb-5">
          <h2 className="mb-2 text-[15px] font-bold text-ink">{dept.name}</h2>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {dept.doctors.map((d) => (
              <li key={d.id}>
                <Card className="flex h-full flex-col p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-full" style={{ background: 'var(--industry-soft)', color: 'var(--industry-accent)' }}><Stethoscope className="size-5" aria-hidden /></span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink">{d.name}</p>
                      <p className="text-[12px] text-muted">{d.specialty} · {d.qualification}</p>
                      <p className="text-[12px] text-muted">{d.languages}</p>
                    </div>
                    <Pill tone={d.active ? 'green' : 'slate'}>{d.active ? 'active' : 'inactive'}</Pill>
                  </div>
                  <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10.5px]">
                    {DAYS.map((name, i) => {
                      const blocks = d.schedule.filter((b) => b.day === i);
                      return (
                        <div key={name} className={cx('rounded-[8px] px-0.5 py-1.5', blocks.length ? 'bg-[var(--industry-soft)] text-ink' : 'bg-slate-50 text-faint')}>
                          <p className="font-semibold">{name}</p>
                          {blocks.map((b) => <p key={b.start} className="leading-tight tabular">{b.start}<br />{b.end}</p>)}
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-3 text-[12.5px] text-body">Fee {money(d.consultationFee)} · {d.slotMinutes}-minute slots</p>
                  {d.leaveDates.length > 0 && <p className="text-[12px] text-amber-700">On leave: {d.leaveDates.join(', ')}</p>}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <SourceNote api="GET /hospital/directory" />
    </>
  );
}
