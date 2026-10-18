'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Save } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import type { Property, TenantSettings } from '@/lib/types';
import { PageHeader } from '@/components/shell';
import { Button, Card, CardHeader, ErrorBanner, Skeleton } from '@/components/ui';
import { Dialog } from '@/components/textile';
import { INDUSTRIES, industryDef, type IndustryId } from '@/lib/industries';
import { forgetWorkspace, useWorkspace } from '@/lib/industry';

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
  const [confirmIndustry, setConfirmIndustry] = useState(false);
  const closeConfirm = useCallback(() => setConfirmIndustry(false), []);
  const { workspace } = useWorkspace();
  const canChange = workspace?.canChangeIndustry ?? false;

  useEffect(() => {
    if (data && !draft) {
      setDraft(data.settings);
      setPhones(data.settings.team.alertPhones.join(', '));
      setDays(data.settings.nurture.followUpDays.join(', '));
    }
  }, [data, draft]);

  const set = <K extends Exclude<keyof Draft, 'industry' | 'agents'>>(section: K, patch: Partial<Draft[K]>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, [section]: { ...d[section], ...patch } } : d));
  };
  const setSite = (propertyId: string, patch: { address?: string; mapUrl?: string }) =>
    set('visits', { sites: { ...(draft?.visits.sites ?? {}), [propertyId]: { ...(draft?.visits.sites[propertyId] ?? {}), ...patch } } });

  async function save(confirmed = false) {
    if (!draft) return;
    if (!confirmed && data && draft.industry !== data.settings.industry) {
      setConfirmIndustry(true);
      return;
    }
    setConfirmIndustry(false);
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
      // The menu and pipeline depend on the industry: reload so every page picks up the switch at once.
      if (data && result.settings.industry !== data.settings.industry) {
        forgetWorkspace();
        window.location.reload();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const d = draft;
  // Restaurant workspaces keep their own engine; everyone else previews sections for the selected industry.
  const def = industryDef(workspace?.industry === 'restaurant' ? 'restaurant' : d?.industry);
  const show = (section: (typeof def.settings)[number]) => def.settings.includes(section);
  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <Button variant="primary" busy={saving} disabled={!d} onClick={() => save()}>
            {saved ? <CheckCircle2 className="size-4" /> : <Save className="size-4" />}
            {saved ? 'Saved' : 'Save changes'}
          </Button>
        }
      />
      {(err || (error && !data)) && <div className="mb-4"><ErrorBanner message={err ?? error!} onRetry={reload} /></div>}
      {!d && <Skeleton className="h-96" />}
      {d && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card className="xl:col-span-2">
            <CardHeader title="Business type" subtitle="Decides which sales assistant, pipeline stages and pages you get" />
            <div className="px-5 pb-3">
              <Row label="Industry" hint={canChange ? def.tagline : 'This workspace runs the restaurant ordering assistant; its industry cannot be changed here.'}>
                <select
                  aria-label="Industry"
                  value={workspace?.industry === 'restaurant' ? 'restaurant' : d.industry}
                  disabled={!canChange}
                  onChange={(e) => { setSaved(false); setDraft((x) => (x ? { ...x, industry: e.target.value as Draft['industry'] } : x)); }}
                  className="h-9 rounded-[10px] border border-line bg-white px-2.5 text-[13px] font-semibold text-ink outline-none focus:border-brand disabled:bg-slate-50"
                >
                  {workspace?.industry === 'restaurant' && <option value="restaurant">{INDUSTRIES.restaurant.label}</option>}
                  {(workspace?.settableIndustries ?? (['real_estate', 'textile', 'retail', 'manufacturing', 'agency'] as IndustryId[])).map((id) => (
                    <option key={id} value={id}>{INDUSTRIES[id].label}</option>
                  ))}
                </select>
              </Row>
              {show('textile') && (
                <>
                  <Row label="Quotation reminder" hint="WhatsApp nudge if a sent quotation gets no answer; 0 = off">
                    <Num label="Quote reminder days" value={d.textile.quoteReminderDays} onChange={(v) => set('textile', { quoteReminderDays: v })} suffix="days after sending" max={30} />
                  </Row>
                  <Row label="Ask for feedback" hint="After the order is marked delivered">
                    <Num label="Feedback after hours" value={d.textile.feedbackAfterHours} onChange={(v) => set('textile', { feedbackAfterHours: v })} suffix="hours after delivery" max={720} />
                  </Row>
                  <Row label="Order updates on WhatsApp" hint="When an order is confirmed, dispatched and delivered">
                    <Toggle label="Order status WhatsApp" checked={d.textile.notifyOrderStatus} onChange={(v) => set('textile', { notifyOrderStatus: v })} />
                  </Row>
                  <Row label="Discount limit" hint="A quotation discount above this needs an approver (sales.approve_discount)">
                    <Num label="Max discount percent" value={d.textile.maxDiscountPct} onChange={(v) => set('textile', { maxDiscountPct: v })} suffix="% of subtotal" max={100} />
                  </Row>
                </>
              )}
              {show('finance') && (
                <>
                  <Row label="Invoice when an order is confirmed" hint="The Finance agent drafts it; a person approves and issues it">
                    <Toggle label="Auto-draft invoice" checked={d.finance.autoDraftInvoice} onChange={(v) => set('finance', { autoDraftInvoice: v })} />
                  </Row>
                  <Row label="Payment terms" hint="Due date = invoice date + these days (changeable per invoice)">
                    <Num label="Payment terms days" value={d.finance.paymentTermsDays} onChange={(v) => set('finance', { paymentTermsDays: v })} suffix="days" max={365} />
                  </Row>
                  <Row label="Before dispatch" hint="Checked on the server when an order moves to ready to dispatch / dispatched">
                    <select
                      aria-label="Dispatch payment rule"
                      value={d.finance.dispatchPaymentRule}
                      onChange={(e) => set('finance', { dispatchPaymentRule: e.target.value as Draft['finance']['dispatchPaymentRule'] })}
                      className="h-9 rounded-[10px] border border-line bg-white px-2.5 text-[13px] font-semibold text-ink outline-none focus:border-brand"
                    >
                      <option value="none">No payment check</option>
                      <option value="any_verified">At least one verified payment</option>
                      <option value="full">Invoice fully paid (verified)</option>
                    </select>
                  </Row>
                </>
              )}
            </div>
          </Card>

          {show('food') && d.food && <Card className="xl:col-span-2">
            <CardHeader title="Restaurant ordering" subtitle="Used by the ordering assistant and the phone-order screen to price every cart on the server" />
            <div className="px-5 pb-3">
              <Row label="Tax on food" hint="Applied to items without their own tax rate">
                <Num label="Food tax percent" value={d.food.taxPct} onChange={(v) => set('food', { taxPct: v })} suffix="%" max={28} step={0.5} />
              </Row>
              <Row label="Packing charge" hint="Per order">
                <Num label="Packing charge" value={d.food.packagingFee} onChange={(v) => set('food', { packagingFee: v })} suffix="₹" max={500} />
              </Row>
              <Row label="Pickup orders"><Toggle label="Pickup orders" checked={d.food.pickupEnabled} onChange={(v) => set('food', { pickupEnabled: v })} /></Row>
              <Row label="Delivery orders"><Toggle label="Delivery orders" checked={d.food.deliveryEnabled} onChange={(v) => set('food', { deliveryEnabled: v })} /></Row>
              <Row label="Delivery zones" hint="One per line: Zone name | area words (comma separated) | fee | minimum order | minutes">
                <textarea
                  aria-label="Delivery zones"
                  rows={Math.max(3, d.food.deliveryZones.length + 1)}
                  defaultValue={d.food.deliveryZones.map((z) => `${z.name} | ${z.keywords.join(', ')} | ${z.fee} | ${z.minOrder} | ${z.etaMinutes}`).join('\n')}
                  onBlur={(e) => set('food', { deliveryZones: e.target.value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0]).map(([name, kw, fee, min, eta]) => ({ name, keywords: (kw ?? name).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean), fee: Number(fee) || 0, minOrder: Number(min) || 0, etaMinutes: Number(eta) || 45 })) })}
                  className="w-full rounded-[10px] border border-line bg-white px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:border-brand sm:w-[460px]"
                />
              </Row>
            </div>
          </Card>}

          {show('hotel') && d.hotel && <Card className="xl:col-span-2">
            <CardHeader title="Hotel & booking rules" subtitle="Used by the booking assistant and the front desk" />
            <div className="px-5 pb-3">
              <Row label="Check-in / check-out (IST)">
                <Text label="Check-in time" value={d.hotel.checkInTime} onChange={(v) => set('hotel', { checkInTime: v })} placeholder="14:00" />
                <Text label="Check-out time" value={d.hotel.checkOutTime} onChange={(v) => set('hotel', { checkOutTime: v })} placeholder="11:00" />
              </Row>
              <Row label="Room tax"><Num label="Room tax percent" value={d.hotel.taxPct} onChange={(v) => set('hotel', { taxPct: v })} suffix="%" max={28} step={0.5} /></Row>
              <Row label="Confirm bookings automatically" hint="Off: assistant bookings wait for the front desk and hold the room meanwhile">
                <Toggle label="Auto-confirm bookings" checked={d.hotel.autoConfirm} onChange={(v) => set('hotel', { autoConfirm: v })} />
              </Row>
              <Row label="Hold a pending booking for"><Num label="Hold minutes" value={d.hotel.holdMinutes} onChange={(v) => set('hotel', { holdMinutes: v })} suffix="min" min={10} max={1440} /></Row>
              <Row label="Deposit" hint="No payment gateway is connected: recorded by staff or simulated in demo"><Num label="Deposit percent" value={d.hotel.depositPct} onChange={(v) => set('hotel', { depositPct: v })} suffix="% of total" max={100} /></Row>
              <Row label="Free cancellation until"><Num label="Free cancellation hours" value={d.hotel.freeCancellationHours} onChange={(v) => set('hotel', { freeCancellationHours: v })} suffix="hours before check-in" max={720} /></Row>
              <Row label="Cancellation policy (told to guests)"><Text wide label="Cancellation policy" value={d.hotel.cancellationPolicy} onChange={(v) => set('hotel', { cancellationPolicy: v })} /></Row>
            </div>
          </Card>}

          {show('hospital') && d.hospital && <Card className="xl:col-span-2">
            <CardHeader title="Hospital assistant" subtitle="Administrative assistant: it never gives medical advice or decides insurance" />
            <div className="px-5 pb-3">
              <Row label="Emergency number" hint="Shown at once when a message sounds like an emergency"><Text label="Emergency number" value={d.hospital.emergencyNumber} onChange={(v) => set('hospital', { emergencyNumber: v })} placeholder="108" /></Row>
              <Row label="Booking window"><Num label="Booking window days" value={d.hospital.bookingWindowDays} onChange={(v) => set('hospital', { bookingWindowDays: v })} suffix="days ahead" min={1} max={90} /></Row>
              <Row label="Appointment reminder" hint="0 = off"><Num label="Reminder hours before" value={d.hospital.reminderHoursBefore} onChange={(v) => set('hospital', { reminderHoursBefore: v })} suffix="hours before" max={72} /></Row>
            </div>
          </Card>}

          {show('speed') && <Card>
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
          </Card>}

          {show('visits') && <Card>
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
          </Card>}

          {show('team') && <Card>
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
          </Card>}

          {show('roi') && <Card>
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
          </Card>}

          {show('visits') && <Card className="xl:col-span-2">
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
          </Card>}
        </div>
      )}
      <Dialog open={confirmIndustry} onClose={closeConfirm} title="Change industry?">
        {d && data && (
          <div className="space-y-3 text-[13px] text-body">
            <p>
              Switch this workspace from <b>{INDUSTRIES[data.settings.industry as IndustryId]?.label ?? data.settings.industry}</b> to <b>{INDUSTRIES[d.industry as IndustryId]?.label ?? d.industry}</b>?
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>The menu, dashboard, pipeline stages and AI agents change to the new industry.</li>
              <li>No records are deleted, moved or created; your data stays in this workspace.</li>
              <li>The AI assistant for new WhatsApp conversations follows the new industry.</li>
            </ul>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button onClick={closeConfirm}>Cancel</Button>
              <Button variant="primary" busy={saving} onClick={() => save(true)}>Change industry</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
