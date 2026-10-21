/**
 * Transcript quality gate. Short or garbled STT output must never drive state, language or actions.
 *   ok     -> normal processing
 *   weak   -> may be answered, but must not be used to learn the customer's language
 *   reject -> ask the customer to repeat; nothing else happens this turn
 */
import { classifyIntent, isExplicitAffirmation } from './intent.js';
import { norm, scriptCounts, tokens } from './text.js';
import { mentionsWhen } from './when.js';

export type GateVerdict = { verdict: 'ok' | 'weak' | 'reject'; reasons: string[]; text: string };

/** Languages the product serves. Anything else from the STT is treated as an unreliable guess. */
export const SUPPORTED_STT_LANGUAGES = new Set(['ta-in', 'en-in', 'en-us', 'en-gb', 'ta', 'en', 'unknown', '']);

const MAX_CHARS = 400;

/**
 * `knownTerms`: inventory place / project names. A transcript that names one ("Green Valley") or carries a day / time
 * ("Tomorrow 11 AM") is meaningful even when the STT labels it te-IN: the words are what matter, never the label.
 */
export function assessTranscript(input: { transcript: string; sttLanguage?: string; durationMs?: number; knownTerms?: string[] }): GateVerdict {
  const text = (input.transcript ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  const reasons: string[] = [];
  if (!text) return { verdict: 'reject', reasons: ['empty'], text };

  const s = scriptCounts(text);
  if (s.letters === 0) {
    // "80", "2": legitimate answers to a slot question, but never enough to learn a language from.
    return { verdict: s.digits > 0 ? 'weak' : 'reject', reasons: [s.digits > 0 ? 'digits_only' : 'no_letters'], text };
  }

  const foreign = (s.other + s.devanagari) / s.letters;
  if (foreign > 0.5) return { verdict: 'reject', reasons: ['unsupported_script'], text };
  if (foreign > 0.2) reasons.push('mixed_foreign_script');

  const t = tokens(text);
  if (t.length >= 5) {
    const counts = new Map<string, number>();
    for (const x of t) counts.set(x, (counts.get(x) ?? 0) + 1);
    const top = Math.max(...counts.values());
    if (top / t.length > 0.6) return { verdict: 'reject', reasons: ['repetition_loop'], text };
  }

  // A recognised word (yes / bye / பேசலாம் ...) is meaningful even when it is one word.
  const n = norm(text);
  const recognised =
    classifyIntent(text).intent !== 'UNKNOWN' ||
    isExplicitAffirmation(text).yes ||
    mentionsWhen(text) ||
    (input.knownTerms ?? []).some((term) => term.length >= 4 && n.includes(norm(term)));
  if (t.length === 1 && !recognised && text.length < 3) return { verdict: 'weak', reasons: ['very_short'], text };

  const lang = (input.sttLanguage ?? '').toLowerCase();
  if (lang && !SUPPORTED_STT_LANGUAGES.has(lang)) {
    // e.g. pa-IN / gu-IN on a Tamil call: the words may still be right, the language label is not.
    reasons.push(`unreliable_stt_language:${lang}`);
    if (!recognised && t.length <= 2 && s.tamil === 0) return { verdict: 'reject', reasons, text };
  }
  if ((input.durationMs ?? 9999) < 900 && !recognised && t.length <= 2) reasons.push('very_short_audio');

  return { verdict: reasons.length ? 'weak' : 'ok', reasons, text };
}
