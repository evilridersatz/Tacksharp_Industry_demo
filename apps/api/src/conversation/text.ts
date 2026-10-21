/**
 * Small text helpers shared by the deterministic conversation modules.
 * Everything here is pure (no I/O) so it can be unit-tested and runs in microseconds.
 */

const PUNCT = /[.,!?;:"`()\[\]{}<>«»…|\\/*_~^=+#@$%&]/g;

/** NFC + lowercase + punctuation to spaces + collapsed whitespace. Tamil script is preserved. */
export function norm(text: string): string {
  return (text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/['\u2019]/g, '') // don't -> dont, that's -> thats, o'clock -> oclock
    // "OMR-ல", "Porur-க்கு": the hyphen joins an English word to a Tamil suffix; they are two tokens.
    .replace(/[-\u2010-\u2015](?=[\u0B80-\u0BFF])/g, ' ')
    .replace(/(?<=[\u0B80-\u0BFF])[-\u2010-\u2015]/g, ' ')
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(text: string): string[] {
  const n = norm(text);
  return n ? n.split(' ') : [];
}

/** True when `phrase` (already normalized) occurs in `normalizedText` on token boundaries. */
export function hasPhrase(normalizedText: string, phrase: string): boolean {
  return ` ${normalizedText} `.includes(` ${phrase} `);
}

export function hasAnyPhrase(normalizedText: string, phrases: readonly string[]): string | undefined {
  for (const p of phrases) if (hasPhrase(normalizedText, p)) return p;
  return undefined;
}

/** Tamil honorific / politeness suffixes glued to words: சரிங்க -> சரி, ஆமாங்க -> ஆமா. */
export function stripHonorific(token: string): string {
  return token.replace(/(ங்கோ|ங்க|ங்களா|pa|ppa|da|di)$/u, (m) => (m === 'pa' || m === 'da' || m === 'di' ? m : ''));
}

const TAMIL = /[஀-௿]/u;
export const hasTamilScript = (s: string) => TAMIL.test(s);

/** Letters per script family, used by the transcript gate and the language detector. */
export function scriptCounts(text: string) {
  let tamil = 0, latin = 0, devanagari = 0, other = 0, digits = 0;
  for (const ch of text.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x0b80 && c <= 0x0bff) tamil++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    else if (c >= 0x0900 && c <= 0x097f) devanagari++;
    else if (c >= 0x30 && c <= 0x39) digits++;
    else if (/\p{L}/u.test(ch)) other++; // Gurmukhi, Gujarati, Bengali, Telugu, Kannada, Malayalam, Arabic, CJK ...
  }
  return { tamil, latin, devanagari, other, digits, letters: tamil + latin + devanagari + other };
}
