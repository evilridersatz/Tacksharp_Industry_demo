import { formatRupeesShort } from '../common/parsers.js';

const OUTCOME_TEXT: Record<string, string> = {
  connected: 'Spoke with the customer; no clear decision yet.',
  interested: 'Customer is interested.',
  qualified: 'Requirements collected; lead qualified.',
  site_visit_requested: 'Customer wants a site visit.',
  site_visit_booked: 'Site visit booked.',
  callback_requested: 'Customer asked to be called back.',
  human_requested: 'Customer asked to speak to a person.',
  not_interested: 'Customer is not interested.',
  wrong_number: 'Wrong number.',
  no_answer: 'Not answered.',
  busy: 'Line was busy.',
  failed: 'Call could not be connected.',
  invalid_number: 'Phone number is invalid.',
};

const IST: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };

/**
 * Plain-language call summary built only from saved facts (no extra AI call,
 * so it can never invent anything and costs nothing).
 */
export function buildCallSummary(input: {
  direction: string;
  outcome: string;
  durationSec?: number | null;
  turns?: number;
  language?: string | null;
  customer: { location?: string | null; bhk?: number | null; propertyType?: string | null; budget?: unknown; callbackAt?: Date | null };
  siteVisit?: { propertyName: string; scheduledAt: Date } | null;
}): string {
  const parts: string[] = [];
  parts.push(`${input.direction === 'inbound' ? 'Customer called in.' : 'AI called the customer.'} ${OUTCOME_TEXT[input.outcome] ?? input.outcome}`);

  const c = input.customer;
  const wants = [c.bhk ? `${c.bhk} BHK` : '', c.propertyType ?? '', c.location ? `in ${c.location}` : ''].filter(Boolean).join(' ');
  const budget = c.budget ? formatRupeesShort(Number(c.budget)) : '';
  if (wants || budget) parts.push(`Looking for ${wants || 'a property'}${budget ? `, budget up to ${budget}` : ''}.`);

  if (input.siteVisit) parts.push(`Visit: ${input.siteVisit.propertyName} on ${input.siteVisit.scheduledAt.toLocaleString('en-IN', IST)}.`);
  if (input.outcome === 'callback_requested' && c.callbackAt) parts.push(`Call back on ${c.callbackAt.toLocaleString('en-IN', IST)}.`);
  if (input.language) parts.push(`Spoke ${input.language.startsWith('ta') ? 'Tamil / Tanglish' : input.language.startsWith('en') ? 'English' : input.language}.`);
  return parts.join(' ');
}
