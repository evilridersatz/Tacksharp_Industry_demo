import { formatRupeesShort } from '../common/parsers.js';
import { firstName } from '../whatsapp/message-templates.js';

/** "Sat 10 Oct, 11:00 AM" in IST, the format people read on WhatsApp. */
export function visitTimeLabel(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}, ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

type VisitCtx = {
  customerName: string | null;
  propertyName: string;
  scheduledAt: Date;
  address?: string;
  mapUrl?: string;
  hoursBefore?: number;
};

/** Customer WhatsApp texts for the visit follow-through (Tanglish, short, one ask each). */
export function visitMessage(kind: 'confirm' | 'reminder' | 'thank_you' | 'no_show', c: VisitCtx): string {
  const name = firstName(c.customerName);
  const hi = name ? `Hi ${name}` : 'Hi';
  const when = visitTimeLabel(c.scheduledAt);
  const where = [c.address ? `Address: ${c.address}` : '', c.mapUrl ? `Location: ${c.mapUrl}` : ''].filter(Boolean).join('\n');
  switch (kind) {
    case 'confirm':
      return `${hi}, naalaiku ${when} ${c.propertyName} site visit irukku. Varuveengala? Confirm panna "YES" nu reply pannunga, vera time venumna sollunga.`;
    case 'reminder':
      return [`${hi}, reminder: ${c.propertyName} site visit ${when}.`, where].filter(Boolean).join('\n');
    case 'thank_you':
      return `${hi}, ${c.propertyName} visit-ku vandhadhukku thanks! Edhavadhu doubt irundha inga kelunga, enga team help pannuvaanga.`;
    case 'no_show':
      return `${hi}, ${c.propertyName} visit-la ungala miss panninom. Vera naal / time arrange pannalaama? Inga reply pannunga.`;
  }
}

/** One variable for the approved alert template: what the team needs, on one line. */
export type TeamAlertCtx = {
  kind: 'booked' | 'visit_soon' | 'hot';
  customerName: string | null;
  phone: string | null;
  propertyName?: string;
  propertyArea?: string;
  scheduledAt?: Date;
  location?: string | null;
  bhk?: number | null;
  budget?: unknown;
  timeline?: string | null;
  bookedVia?: string;
  campaign?: string | null;
};

export function teamAlert(c: TeamAlertCtx): { text: string; oneLine: string } {
  const who = `${c.customerName ?? 'New customer'}${c.phone ? ` | +${c.phone}` : ''}`;
  const need = [c.location, c.bhk ? `${c.bhk} BHK` : '', c.budget ? `up to ${formatRupeesShort(Number(c.budget))}` : '', c.timeline ? `buying ${c.timeline}` : '']
    .filter(Boolean)
    .join(' · ');
  const visit = c.propertyName && c.scheduledAt ? `${c.propertyName}${c.propertyArea ? ` (${c.propertyArea})` : ''}, ${visitTimeLabel(c.scheduledAt)}` : '';
  const lines =
    c.kind === 'booked'
      ? ['New site visit booked by Tacksharp AI', `Lead: ${who}`, `Visit: ${visit}`, need && `Needs: ${need}`, c.bookedVia && `Booked on: ${c.bookedVia}`, c.campaign && `Campaign: ${c.campaign}`]
      : c.kind === 'visit_soon'
        ? ['Site visit soon', `Lead: ${who}`, `Visit: ${visit}`, need && `Needs: ${need}`]
        : ['Hot lead: call within 5 minutes', `Lead: ${who}`, need && `Needs: ${need}`, c.campaign && `Campaign: ${c.campaign}`];
  const kept = lines.filter((l): l is string => Boolean(l));
  return { text: kept.join('\n'), oneLine: kept.slice(1).join(' | ') };
}
