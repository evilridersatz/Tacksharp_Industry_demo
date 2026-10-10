'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Save } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Property, TenantSettings } from '@/lib/types';
import { PageHeader } from '@/components/shell';
import { Button, Card, CardHeader, ErrorBanner, Skeleton } from '@/components/ui';

type Draft = TenantSettings;

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-t-0">
      <div className="min-w-[220px] flex-1">
        <p className="text-[13px] font-semibold text-ink">{label}</p>
        {hint && <p className="text-[12px] text-muted">{hint}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-brand' : 'bg-slate-300'}`}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

function Num({ value, onChange, label, suffix, min = 0, max = 100000, step = 1 }: { value: number; onChange: (v: number) => void; label: string; suffix?: string; min?: number; max?: number; step?: number }) {
  return (
    <label className="inline-flex items-center gap-2 text-[13px] text-muted">
      <input
        type="number"
        aria-label={label}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className="h-9 w-24 rounded-[10px] border border-line bg-white px-2.5 text-right font-semibold text-ink tabular outline-none focus:border-brand"
      />
      {suffix}
    </label>
  );
}

function Text({ value, onChange, label, placeholder, wide }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string; wide?: boolean }) {
  return (
    <input
      type="text"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`h-9 rounded-[10px] border border-line bg-white px-2.5 text-[13px] text-ink outline-none focus:border-brand ${wide ? 'w-full sm:w-[360px]' : 'w-[220px]'}`}
    />
  );
}

export default function SettingsPage() {
  const { data, error, reload } = useApi<{ settings: TenantSettings }>('/settings', 0);
  const { data: properties } = useApi<Property[]>('/properties/search', 0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [phones, setPhones] = useState('');
  const [days, setDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (data && !draft) {
      setDraft(data.settings);
      setPhones(data.settings.team.alertPhones.join(', '));
      setDays(data.settings.nurture.followUpDays.join(', '));
    }
  }, [data, draft]);

  const set = <K extends keyof Draft>(section: K, patch: Partial<Draft[K]>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, [section]: { ...d[section], ...patch } } : d));
  };
  const setSite = (propertyId: string, patch: { address?: string; mapUrl?: string }) =>
    set('visits', { sites: { ...(draft?.visits.sites ?? {}), [propertyId]: { ...(draft?.visits.sites[propertyId] ?? {}), ...patch } } });

  async function save() {
    if (!draft) return;
    setSaving(true);
    setErr(null);
    try {
      const body = {
        ...draft,
        team: { ...draft.team, alertPhones: phones.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean) },
        nurture: { ...draft.nurture, followUpDays: days.split(/[,\s]+/).filter(Boolean).map(Number) },
      };
      const result = await api.put<{ settings: TenantSettings }>('/settings', body);
      setDraft(result.settings);
      setPhones(result.settings.team.alertPhones.join(', '));
      setDays(result.settings.nurture.followUpDays.join(', '));
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const d = draft;
  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <Button variant="primary" busy={saving} disabled={!d} onClick={save}>
            {saved ? <CheckCircle2 className="size-4" /> : <Save className="size-4" />}
            {saved ? 'Saved' : 'Save changes'}
          </Button>
        }
      />
      {(err || (error && !data)) && <div className="mb-4"><ErrorBanner message={err ?? error!} onRetry={reload} /></div>}
      {!d && <Skeleton className="h-96" />}
      {d && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Speed to lead" subtitle="How fast the AI reaches a new Meta lead" />
            <div className="px-5 pb-3">
              <Row label="Call new leads instantly" hint="WhatsApp intro at once, then the AI calls (inside calling hours)">
                <Toggle label="Call new leads instantly" checked={d.speedToLead.instantCall} onChange={(v) => set('speedToLead', { instantCall: v })} />
              </Row>
              <Row label="Call after" hint="Minutes after the lead arrives">
                <Num label="Call after minutes" value={d.speedToLead.callDelayMinutes} onChange={(v) => set('speedToLead', { callDelayMinutes: v })} suffix="min" max={120} />
              </Row>
              <Row label="Calling hours (IST)" hint="Never wider than the legal window set on the server">
                <Num label="Calling starts" value={d.calling.windowStartHour} onChange={(v) => set('calling', { windowStartHour: v })} max={23} />
                <span className="text-muted">to</span>
                <Num label="Calling ends" value={d.calling.windowEndHour} onChange={(v) => set('calling', { windowEndHour: v })} max={24} />
              </Row>
              <Row label="Call attempts per lead" hint="Then WhatsApp only">
                <Num label="Call attempts" value={d.calling.maxAttempts} onChange={(v) => set('calling', { maxAttempts: v })} min={1} max={6} />
              </Row>
              <Row label="Second call after" hint="Third call: next day at the hour below">
                <Num label="Second call after minutes" value={d.calling.retryAfterMinutes} onChange={(v) => set('calling', { retryAfterMinutes: v })} suffix="min" min={5} max={1440} />
                <Num label="Next-day call hour" value={d.calling.nextDayRetryHour} onChange={(v) => set('calling', { nextDayRetryHour: v })} suffix=":00" max={23} />
              </Row>
              <Row label='"Sorry we missed you" WhatsApp' hint="2 minutes after the first unanswered call">
                <Toggle label="Missed-call WhatsApp" checked={d.nurture.missedCallWhatsApp} onChange={(v) => set('nurture', { missedCallWhatsApp: v })} />
              </Row>
              <Row label="WhatsApp nurture on days" hint="For leads never reached, e.g. 3, 7">
                <Text label="Nurture days" value={days} onChange={(v) => { setDays(v); setSaved(false); }} placeholder="3, 7" />
              </Row>
            </div>
          </Card>

          <Card>
            <CardHeader title="Site visit follow-through" subtitle="Get booked visits to actually happen" />
            <div className="px-5 pb-3">
              <Row label="Ask to confirm the day before" hint='WhatsApp; a "YES" reply marks the visit confirmed'>
                <Toggle label="Confirm the day before" checked={d.visits.confirmDayBefore} onChange={(v) => set('visits', { confirmDayBefore: v })} />
              </Row>
              <Row label="Reminder with location" hint="0 = off">
                <Num label="Reminder hours before" value={d.visits.reminderHoursBefore} onChange={(v) => set('visits', { reminderHoursBefore: v })} suffix="hours before" max={12} />
              </Row>
              <Row label="Alert the team before the visit" hint="0 = off">
                <Num label="Team alert minutes before" value={d.visits.teamAlertMinutesBefore} onChange={(v) => set('visits', { teamAlertMinutesBefore: v })} suffix="min before" max={240} />
              </Row>
              <Row label="After the visit" hint="Thank-you if visited, reschedule offer if no-show">
                <Toggle label="After-visit messages" checked={d.visits.afterVisit} onChange={(v) => set('visits', { afterVisit: v })} />
              </Row>
            </div>
          </Card>

          <Card>
            <CardHeader title="Sales team alerts" subtitle="WhatsApp to your team the moment something needs them" />
            <div className="px-5 pb-3">
              <Row label="Team WhatsApp numbers" hint="With country code, comma separated">
                <Text wide label="Team numbers" value={phones} onChange={(v) => { setPhones(v); setSaved(false); }} placeholder="919884012345, 919840012345" />
              </Row>
              <Row label="Alert when a visit is booked">
                <Toggle label="Alert on booking" checked={d.team.alertOnBooking} onChange={(v) => set('team', { alertOnBooking: v })} />
              </Row>
              <Row label="Alert on hot leads" hint="Buying soon + a matching property was shown">
                <Toggle label="Alert on hot lead" checked={d.team.alertOnHotLead} onChange={(v) => set('team', { alertOnHotLead: v })} />
                <Num label="Hot if buying within days" value={d.hotLead.maxTimelineDays} onChange={(v) => set('hotLead', { maxTimelineDays: v })} suffix="days" min={1} max={365} />
              </Row>
              <Row label="Approved alert template" hint="Needed unless each team phone messaged your number in the last 24 h">
                <Text label="Alert template" value={d.team.alertTemplate} onChange={(v) => set('team', { alertTemplate: v })} placeholder="site_visit_alert" />
              </Row>
            </div>
          </Card>

          <Card>
            <CardHeader title="ROI inputs" subtitle="Used for cost per attended visit on Performance" />
            <div className="px-5 pb-3">
              <Row label="Ad cost per lead">
                <Num label="Ad cost per lead" value={d.roi.costPerLeadInr} onChange={(v) => set('roi', { costPerLeadInr: v })} suffix="₹" />
              </Row>
              <Row label="Voice cost per connected minute" hint="Plivo + Sarvam + OpenAI">
                <Num label="Voice cost per minute" value={d.roi.voiceCostPerMinuteInr} onChange={(v) => set('roi', { voiceCostPerMinuteInr: v })} suffix="₹" step={0.1} />
              </Row>
              <Row label="WhatsApp cost per message">
                <Num label="WhatsApp cost per message" value={d.roi.whatsappCostPerMessageInr} onChange={(v) => set('roi', { whatsappCostPerMessageInr: v })} suffix="₹" step={0.1} />
              </Row>
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader title="Site address and map link per project" subtitle="Sent in the visit reminder" />
            <div className="px-5 pb-3">
              {!properties && <Skeleton className="h-20" />}
              {properties?.map((p) => (
                <Row key={p.id} label={p.name} hint={p.location}>
                  <Text label={`${p.name} address`} value={d.visits.sites[p.id]?.address ?? ''} onChange={(v) => setSite(p.id, { address: v })} placeholder="Site address" />
                  <Text label={`${p.name} map link`} value={d.visits.sites[p.id]?.mapUrl ?? ''} onChange={(v) => setSite(p.id, { mapUrl: v })} placeholder="https://maps.google.com/…" />
                </Row>
              ))}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
