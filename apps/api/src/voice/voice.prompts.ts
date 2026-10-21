import { firstName } from '../whatsapp/message-templates.js';
import { formatRupeesShort } from '../common/parsers.js';

/**
 * Fixed phrases in spoken Chennai Tamil: Tamil words in Tamil script, the English words people really use in
 * English (what Bulbul pronounces most naturally). Static prompts are cached as audio.
 */
export const PROMPTS = {
  didntHear: 'ஹலோ? கேக்குதா? சொல்லுங்க.',
  unclear: 'Sorry, சரியா கேக்கல. இன்னொரு தடவை சொல்லுங்களேன்?',
  didntHearEn: 'Hello? Can you hear me? Please go ahead.',
  unclearEn: 'Sorry, I could not hear that clearly. Could you say it again?',
  noResponseGoodbye: 'சரிங்க, இப்போ பேச முடியல போல. அப்புறம் WhatsApp-ல message பண்றேன். Thank you!',
  technicalGoodbye: 'Sorry, ஒரு சின்ன technical problem. நம்ம team உங்களுக்கு திரும்ப call பண்ணுவாங்க. Thank you!',
  lineIssue: 'Sorry, line கொஞ்சம் clear-ஆ இல்ல. நீங்க சொன்னத இன்னொரு தடவை சொல்லுங்களேன்?',
  /** Real-time mode: first of the wait lines (see FILLERS); kept for the warm-up list. */
  filler: 'ம்ம்…',
  fillerEn: 'Hmm…',
  lineIssueEn: 'Sorry, the line is not clear. Could you say that again?',
  tooLongGoodbye: 'உங்க details எல்லாம் note பண்ணிட்டேன். நம்ம team உங்களுக்கு call பண்ணுவாங்க. Thank you!',
};

/**
 * Wait lines for a slow AI turn only (never for rule-answered turns), rotated so the same one is never said twice in
 * a row and never on two turns running. Short, the way a Chennai sales executive fills a pause on the phone.
 */
export const FILLERS = {
  ta: ['ம்ம்…', 'சரி, பாக்குறேன்…', 'ஒரு second…', 'சரி, check பண்றேன்…'],
  en: ['Hmm…', 'Okay, let me check…', 'Just a moment…'],
};

export const ENGLISH_FALLBACK = {
  didntHear: 'Hello? Can you hear me?',
  unclear: 'Sorry, I did not catch that. Could you please repeat?',
  goodbye: 'Thank you. Our team will contact you. Goodbye.',
  technical: 'Sorry, we have a technical issue. Our team will call you back. Goodbye.',
};

type CustomerLike = {
  name: string | null;
  location: string | null;
  bhk: number | null;
  propertyType: string | null;
  budget: unknown;
};

function requirementTamil(c: CustomerLike) {
  const parts = [
    c.location ? `${c.location}-ல` : '',
    c.bhk ? `${c.bhk} BHK` : '',
    c.propertyType ?? (c.bhk ? '' : 'property'),
  ].filter(Boolean);
  return parts.join(' ') || 'property';
}

/**
 * Outbound opening line: who is calling, why, and ONE question (may we talk). Two short sentences, so the
 * first audio is short and the customer is not talked over.
 * Example: "Hi Ravi, Tacksharp Realty-ல இருந்து AI assistant பேசுறேன். Porur-ல 2 BHK enquiry பண்ணிருந்தீங்க. பேசலாமா?"
 */
export function outboundOpening(c: CustomerLike, orgName: string, agentName: string) {
  const name = firstName(c.name);
  // Short: who, why, may we talk. The AI disclosure stays (one word, and callers must not be misled).
  const who = agentName ? `${orgName}-ல இருந்து ${agentName} பேசுறேன், AI assistant.` : `${orgName}-ல இருந்து AI assistant பேசுறேன்.`;
  return `Hi${name ? ` ${name}` : ''}, ${who} ${requirementTamil(c)} enquiry பண்ணிருந்தீங்க. பேசலாமா?`;
}

export function outboundOpeningEnglish(c: CustomerLike, orgName: string) {
  const name = firstName(c.name);
  return `Hello${name ? ` ${name}` : ''}, this is ${orgName} calling about your property enquiry. Is this a good time to talk?`;
}

export function inboundOpening(orgName: string, name?: string | null) {
  const first = firstName(name);
  return first
    ? `வணக்கம் ${first}, ${orgName}-ல இருந்து AI assistant பேசுறேன். சொல்லுங்க, என்ன help வேணும்?`
    : `வணக்கம், ${orgName}-ல இருந்து AI assistant பேசுறேன். சொல்லுங்க, என்ன help வேணும்?`;
}

/** Plain-language reason given to the agent so it knows why it called. */
export function callReason(c: CustomerLike, source: string | null | undefined) {
  const req = [c.bhk ? `${c.bhk} BHK` : '', c.propertyType ?? '', c.location ? `in ${c.location}` : '']
    .filter(Boolean)
    .join(' ');
  const budget = c.budget ? `, budget up to ${formatRupeesShort(Number(c.budget))}` : '';
  return `Follow-up on the customer's ${source ?? 'online'} property enquiry${req ? ` for ${req}` : ''}${budget}. They have not replied on WhatsApp yet.`;
}

/** Reason given to the agent when the CUSTOMER called us. */
export function inboundCallReason(c: CustomerLike, leadStatus?: string | null) {
  const req = [c.bhk ? `${c.bhk} BHK` : '', c.propertyType ?? '', c.location ? `in ${c.location}` : ''].filter(Boolean).join(' ');
  return req
    ? `The customer called the business number. They enquired earlier about ${req}${c.budget ? `, budget up to ${formatRupeesShort(Number(c.budget))}` : ''} (lead status: ${leadStatus ?? 'new'}). Ask how you can help; do not assume why they called.`
    : 'A new customer called the business number. Find out what they are looking for.';
}
