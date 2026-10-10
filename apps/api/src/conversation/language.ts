/**
 * Language detection from the TRANSCRIPT itself, plus a consistency tracker.
 *
 * The STT's own language_code is only supporting evidence: on short phone audio it happily
 * returns pa-IN / gu-IN / hi-IN for Tamil speech. We never save a language from one utterance and
 * we never save a language the product does not serve.
 */
import { norm, scriptCounts, tokens } from './text.js';

export type Lang = 'tamil' | 'tanglish' | 'english';
export type Detection = { lang: Lang | 'other' | 'unknown'; confidence: number; words: number };

const TANGLISH = new Set([
  'venum', 'vendum', 'venam', 'vendam', 'irukku', 'iruku', 'irukkum', 'pannunga', 'panunga', 'pannalam', 'panren', 'pannren', 'pannanum', 'sollunga',
  'solunga', 'sollren', 'illa', 'illai', 'enna', 'epdi', 'eppadi', 'eppo', 'epo', 'evlo', 'evvalavu', 'naan', 'nan', 'nanga', 'naanga', 'unga', 'ungalukku',
  'enakku', 'enaku', 'theriyala', 'theriyum', 'paakalam', 'paakanum', 'pakkalam', 'vanthu', 'vandhu', 'aama', 'aamam', 'seri', 'sari', 'apram', 'aprom',
  'kudu', 'kudunga', 'mudiyum', 'mudiyathu', 'pesalam', 'pesanum', 'kelunga', 'nalla', 'romba', 'konjam', 'thirumba', 'kulla', 'kullaa', 'la', 'ku', 'kku',
  'oru', 'rendu', 'moonu', 'naalu', 'anju', 'pa', 'da', 'sir', 'ah', 'aa', 'dhaan', 'thaan', 'iruka', 'irukka', 'enga', 'inga', 'anga', 'ennanga', 'ippo',
  'ippa', 'naalaikku', 'innaikku', 'sayangalam', 'kaalai', 'madhiyam', 'poganum', 'varuven', 'varen', 'vareen', 'paarkalam', 'solren', 'sollunga',
  'paakalaam', 'pakkalaam', 'paarkalaam', 'pogalam', 'pogalaam', 'poyi', 'vaanga', 'vanga', 'pannalama', 'pannalaama', 'paakalama', 'irukkaa', 'irukaa',
  'irukkuma', 'venuma', 'vendama', 'theriyuma', 'mudiyuma', 'kaatunga', 'paarunga', 'aagum', 'aagathu', 'aaguma', 'yaaru', 'yen', 'enna', 'ennoda',
  'enoda', 'unga', 'nammala', 'kitta', 'vachu', 'vechu', 'pottu', 'sollu', 'solla', 'pannu', 'pannuven', 'pannidunga', 'podunga', 'aamanga', 'seringa',
  'saringa', 'okayanga', 'sollungalen', 'pakka', 'paaka', 'vaanganum', 'vangalam', 'vaangalam', 'veedu', 'idam', 'manai', 'kammi', 'jaasthi', 'adhigam',
  'koncham', 'naalai', 'nalaiku', 'naalaiku', 'sayangalam', 'saayangalam', 'kaalaila', 'maalai', 'raathiri', 'pesalaam', 'pesunga', 'aamaa', 'aamam',
]);
const ENGLISH_COMMON = new Set([
  'the', 'is', 'are', 'i', 'you', 'we', 'it', 'and', 'or', 'to', 'for', 'in', 'on', 'at', 'with', 'my', 'me', 'your', 'what', 'when', 'where', 'how', 'can',
  'could', 'would', 'please', 'want', 'need', 'looking', 'budget', 'bedroom', 'flat', 'apartment', 'villa', 'visit', 'site', 'yes', 'no', 'ok', 'okay',
  'thank', 'thanks', 'hello', 'hi', 'tomorrow', 'today', 'morning', 'evening', 'saturday', 'sunday', 'price', 'location', 'near', 'under', 'around', 'about',
  'this', 'that', 'have', 'has', 'do', 'does', 'not', 'interested', 'call', 'later', 'now', 'right', 'good', 'time', 'lakhs', 'lakh', 'crore', 'bhk',
]);

export function detectLanguage(text: string): Detection {
  const s = scriptCounts(text);
  const toks = tokens(text).filter((t) => /[\p{L}]/u.test(t));
  const words = toks.length;
  if (s.letters === 0 || words === 0) return { lang: 'unknown', confidence: 0, words };

  const foreign = (s.other + s.devanagari) / s.letters;
  if (foreign > 0.5) return { lang: 'other', confidence: 0.8, words };

  const conf = words >= 6 ? 0.9 : words >= 3 ? 0.65 : 0.3;
  const tamilShare = s.tamil / s.letters;

  if (tamilShare > 0.5) {
    const latinWords = toks.filter((t) => /^[a-z]/.test(t)).length;
    return { lang: latinWords >= 2 ? 'tanglish' : 'tamil', confidence: conf, words };
  }
  if (tamilShare > 0.15) return { lang: 'tanglish', confidence: conf, words }; // Tamil words + English words

  const latin = toks.filter((t) => /^[a-z']+$/.test(t));
  const tl = latin.filter((t) => TANGLISH.has(t) && !ENGLISH_COMMON.has(t)).length;
  const en = latin.filter((t) => ENGLISH_COMMON.has(t)).length;
  if (tl >= 1 && tl / Math.max(1, latin.length) >= 0.2) return { lang: 'tanglish', confidence: conf, words };
  if (en >= 1 || latin.length >= 2) return { lang: 'english', confidence: en >= 2 ? conf : Math.min(conf, 0.5), words };
  return { lang: 'unknown', confidence: 0.2, words };
}

/**
 * Words that say nothing about the speaker's language: numbers, units, property words, dates, yes/ok.
 * "60 lakhs", "2 BHK", "Porur", "ok", "Saturday morning" keep the current reply language.
 */
const NEUTRAL = new Set([
  'budget', 'bhk', 'lakh', 'lakhs', 'lac', 'lacs', 'crore', 'crores', 'cr', 'l', 'k', 'site', 'visit', 'ok', 'okay', 'okk', 'flat', 'villa', 'plot',
  'apartment', 'house', 'property', 'price', 'location', 'parking', 'morning', 'evening', 'afternoon', 'night', 'tomorrow', 'today', 'am', 'pm',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'sir', 'madam', 'hello', 'hi', 'one', 'two', 'three', 'first', 'second', 'side', 'road', 'nagar', 'yes', 'no',
]);
/** Extra English words common on calls that ENGLISH_COMMON does not cover. */
const ENGLISH_MORE = new Set([
  'book', 'arrange', 'show', 'details', 'detail', 'possible', 'available', 'need', 'looking', 'something', 'much', 'there', 'any', 'some', 'like',
  'will', 'be', 'am', 'was', 'were', 'should', 'did', 'just', 'only', 'more', 'also', 'sure', 'great', 'fine', 'correct', 'tell', 'know', 'see', 'buy',
  'which', 'who', 'why', 'there', 'here', 'they', 'them', 'our', 'us', 'from', 'of', 'by', 'a', 'an', 'if', 'so', 'but', 'than', 'cost', 'costs', 'confirm',
  'please', 'sorry', 'speak', 'english', 'talk', 'go', 'ahead', 'okay', 'thats', "that's", 'its', "it's", 'im', "i'm", 'dont', "don't", 'cant', "can't",
]);
/** Strong Tanglish words (Tamil written in English letters); short particles count only next to other evidence. */
const TANGLISH_PARTICLES = new Set(['la', 'ku', 'kku', 'pa', 'da', 'ah', 'aa', 'dhaan', 'thaan']);

export type TurnLanguage = {
  /** What THIS utterance is written in; 'neutral' = no evidence either way. */
  current: Lang | 'neutral';
  /** The language the reply will use (current when it has evidence, else the previous one). */
  reply: Lang;
  previous: Lang;
  changed: boolean;
  reason: string;
};

/**
 * Per-turn reply language. The CURRENT utterance decides when it carries real evidence; neutral utterances
 * ("60 lakhs", "Porur", "ok") keep the previous language, and one stray word never flips it.
 *   Tamil script anywhere            -> tamil (mostly Tamil) / tanglish (mixed with English words)
 *   Tanglish words (venum, pannunga) -> tanglish
 *   2+ real English words, no Tamil  -> english
 * The STT language label is never used. Business state is unaffected by language.
 */
export function turnLanguage(text: string, previous: Lang, quality: 'ok' | 'weak' = 'ok'): TurnLanguage {
  const keep = (reason: string): TurnLanguage => ({ current: 'neutral', reply: previous, previous, changed: false, reason });
  if (quality !== 'ok') return keep('weak_transcript');
  const s = scriptCounts(text);
  if (s.letters === 0) return keep('no_words');
  if ((s.other + s.devanagari) / s.letters > 0.5) return keep('foreign_script');

  // "possible-aa", "Porur-la": the suffix after a hyphen is a Tamil particle; split it off.
  const toks = tokens(text.replace(/([a-z])-([a-z])/gi, '$1 $2')).filter((t) => /[\p{L}]/u.test(t));
  const latin = toks.filter((t) => /^[a-z']+$/.test(t));
  const decide = (current: Lang, reason: string): TurnLanguage => ({ current, reply: current, previous, changed: current !== previous, reason });

  if (s.tamil > 0) {
    const tamilShare = s.tamil / s.letters;
    const englishWords = latin.filter((t) => (ENGLISH_COMMON.has(t) || ENGLISH_MORE.has(t)) && !NEUTRAL.has(t)).length;
    const lang: Lang = tamilShare >= 0.6 && englishWords === 0 ? 'tamil' : 'tanglish';
    // A short line inside the Tamil family ("Done. Okay. பார்க்கலாம்.", "சாயங்காலம் நாலு மணிக்கு.") keeps the
    // caller's current Tamil / Tanglish: flipping between them on every short turn was only churn (real call
    // 2026-10-10). A longer sentence, or coming from English, still switches.
    if ((previous === 'tamil' || previous === 'tanglish') && lang !== previous && toks.length <= 5) {
      return { current: lang, reply: previous, previous, changed: false, reason: 'same_family_short' };
    }
    return decide(lang, 'tamil_script');
  }
  const strongTl = latin.filter((t) => TANGLISH.has(t) && !ENGLISH_COMMON.has(t) && !TANGLISH_PARTICLES.has(t) && !NEUTRAL.has(t)).length;
  const particles = latin.filter((t) => TANGLISH_PARTICLES.has(t)).length;
  const english = latin.filter((t) => (ENGLISH_COMMON.has(t) || ENGLISH_MORE.has(t)) && !NEUTRAL.has(t)).length;
  // A question ending in the Tamil "-aa / -ah" ("possible-aa?", "irukka ah?") is Tanglish even beside English words.
  const tamilQuestion = /\b[a-z]+[- ](aa|ah|a)\s*[?？]?\s*$/i.test(text.trim()) && latin.length >= 2;
  // One Tanglish word in a two-word reply ("seri okay") is not enough to switch: hysteresis against stray words.
  if (strongTl >= 2 || (strongTl >= 1 && latin.length >= 3) || tamilQuestion || (particles >= 1 && strongTl >= 1)) return decide('tanglish', 'tanglish_words');
  if (english >= 2 || (english >= 1 && latin.length >= 3 && latin.every((t) => ENGLISH_COMMON.has(t) || ENGLISH_MORE.has(t) || NEUTRAL.has(t) || /^[a-z]{3,}$/.test(t)) && english / latin.length >= 0.34)) {
    return decide('english', 'english_words');
  }
  return keep('neutral');
}

export type LanguageState = {
  /** Language replies are written in right now (hysteresis: flips only on consistent evidence). */
  effective: Lang;
  /** Recent qualified votes (newest last). */
  votes: Array<{ lang: Lang; weight: number }>;
  /** Language already saved on the customer record (null when unknown). */
  stored?: Lang | null;
};

export function initialLanguage(stored: string | null | undefined, channel: 'voice' | 'whatsapp' | 'web'): LanguageState {
  const known = toLang(stored);
  return { effective: known ?? (channel === 'voice' ? 'tanglish' : 'english'), votes: [], stored: known ?? null };
}

export function toLang(value: string | null | undefined): Lang | undefined {
  const v = (value ?? '').toLowerCase();
  if (v === 'tamil' || v.startsWith('ta')) return 'tamil';
  if (v === 'tanglish') return 'tanglish';
  if (v === 'english' || v.startsWith('en')) return 'english';
  return undefined;
}

/** Tamil and Tanglish are one voice style (Tamil script with English loanwords); English is the other. */
const family = (l: Lang) => (l === 'english' ? 'english' : 'tamil-family');

export type LanguageUpdate = { state: LanguageState; persist?: Lang; changed: boolean };

/**
 * Feed one transcript. `quality` comes from the transcript gate: only 'ok' transcripts vote.
 * Persist rules (saving to customer.language):
 *   - at least 4 points of consistent evidence (two long utterances, or three medium ones),
 *   - never from 'other' / 'unknown', never from a weak transcript,
 *   - replacing an already-stored language needs 6 points.
 */
export function updateLanguage(state: LanguageState, detection: Detection, quality: 'ok' | 'weak'): LanguageUpdate {
  const next: LanguageState = { ...state, votes: [...state.votes] };
  const usable = quality === 'ok' && (detection.lang === 'tamil' || detection.lang === 'tanglish' || detection.lang === 'english') && detection.confidence >= 0.6;
  if (!usable) return { state: next, changed: false };

  const lang = detection.lang as Lang;
  next.votes.push({ lang, weight: detection.words >= 6 ? 2 : 1 });
  if (next.votes.length > 6) next.votes.shift();

  // Effective reply language: flip only when the last two qualified votes agree on another family.
  let changed = false;
  const last2 = next.votes.slice(-2);
  if (detection.confidence >= 0.9 && family(lang) !== family(next.effective)) {
    // A long, unmistakable sentence in the other language (6+ words, one script): reply in it right away.
    // Nothing is saved from this alone - persisting needs more evidence below.
    next.effective = lang;
    changed = true;
  } else if (last2.length === 2 && last2.every((v) => family(v.lang) === family(last2[0].lang)) && family(last2[0].lang) !== family(next.effective)) {
    next.effective = last2[1].lang;
    changed = true;
  } else if (family(lang) === family(next.effective) && lang !== next.effective && next.votes.length >= 2) {
    // tamil <-> tanglish inside the same family: follow the majority of recent votes
    const tally = next.votes.filter((v) => family(v.lang) === family(next.effective)).reduce<Record<string, number>>((a, v) => ({ ...a, [v.lang]: (a[v.lang] ?? 0) + v.weight }), {});
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] as Lang | undefined;
    if (top && top !== next.effective) { next.effective = top; changed = true; }
  }

  // Persistence needs consistent evidence for the SAME language.
  const evidence = next.votes.filter((v) => v.lang === lang).reduce((a, v) => a + v.weight, 0);
  const needed = next.stored && next.stored !== lang ? 6 : 4;
  let persist: Lang | undefined;
  if (evidence >= needed && next.stored !== lang) {
    persist = lang;
    next.stored = lang;
  }
  return { state: next, persist, changed };
}

/** Voice/TTS code for the Call record (compatible with the existing ta-IN / en-IN values). */
export const callLanguageCode = (l: Lang) => (l === 'english' ? 'en-IN' : 'ta-IN');

/** Which template set to speak/write in. Voice always uses Tamil script for tamil+tanglish. */
export function replyStyle(l: Lang, channel: 'voice' | 'whatsapp' | 'web'): 'ta' | 'tl' | 'en' {
  if (l === 'english') return 'en';
  if (channel === 'voice') return 'ta';
  return l === 'tanglish' ? 'tl' : 'ta';
}

export { norm };
