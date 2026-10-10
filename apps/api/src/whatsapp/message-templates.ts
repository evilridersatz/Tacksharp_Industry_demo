import { formatRupeesShort } from '../common/parsers.js';

type CustomerLike = {
  name: string | null;
  location: string | null;
  bhk: number | null;
  propertyType: string | null;
  budget: unknown;
};

/** "2 BHK Apartment in Porur" / "property" */
export function describeRequirement(c: CustomerLike | null | undefined): string {
  if (!c) return 'property';
  const parts = [
    c.bhk ? `${c.bhk} BHK` : '',
    c.propertyType ?? (c.bhk ? '' : 'property'),
    c.location ? `in ${c.location}` : '',
  ].filter(Boolean);
  return parts.join(' ').trim() || 'property';
}

export function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] || '';
}

/** Short, non-spammy follow-up texts (used only inside the 24h window). */
export function sequenceMessage(
  step: string,
  c: CustomerLike | null | undefined,
  orgName: string,
  opts: { callingNow?: boolean; callingMorning?: boolean } = {},
): string {
  const name = firstName(c?.name);
  const hi = name ? `Hi ${name}` : 'Hi';
  const req = describeRequirement(c);
  const budget = c?.budget ? ` around ${formatRupeesShort(Number(c.budget))}` : '';

  if (step.startsWith('nurture_day')) {
    return `${hi}, ${orgName} la irundhu. Unga ${req} search-ku innum help venuma? Site visit arrange pannalaam — inga reply pannunga.`;
  }
  switch (step) {
    case 'first_contact':
      if (opts.callingNow) return `${hi}! 👋 ${orgName} la irundhu. Unga ${req} enquiry-ku thanks. Enga assistant innum oru nimishathula ungalukku call pannuvaanga.`;
      if (opts.callingMorning) return `${hi}! 👋 ${orgName} la irundhu. Unga ${req} enquiry-ku thanks. Kaalaila enga assistant ungalukku call pannuvaanga, illa inga reply pannunga.`;
      return `${hi}! 👋 ${orgName} la irundhu. Unga ${req} enquiry-ku thanks.${budget ? ` Budget${budget} nu note pannirukom.` : ''} Ungalukku suitable options share pannalaama?`;
    case 'reminder':
      return `${hi}, unga ${req} search innum continue pannreengala? Location / budget sollunga, best options shortlist panni tharen.`;
    case 'missed_call':
      return `${hi}, ${orgName} la irundhu ippo call panninom, connect aagala. Endha time call panna vasadhiya irukkum? Inga reply pannunga.`;
    case 'final':
      return `${hi}, last follow-up 🙂 Innum property paathutu irundha, inga reply pannunga — site visit kooda arrange pannalaam.`;
    default:
      return `${hi}, ${orgName} la irundhu follow-up. Ungalukku help venumna reply pannunga.`;
  }
}

/**
 * WhatsApp / chat replies are 1-3 short lines: no markdown, at most three non-empty lines, bounded length.
 * Applied to every outgoing AI reply as the last step, whatever produced it.
 */
export function shapeChatReply(text: string, maxLines = 3, maxChars = 480): string {
  const cleaned = text
    .replace(/\*\*/g, '')
    .replace(/[`#>]/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[ \t]+/g, ' ');
  const lines = cleaned
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  let out = lines.slice(0, maxLines).join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, '');
  return out;
}
