/**
 * Deterministic intent detection for Tamil / Tanglish / English customer utterances.
 *
 * This module is the safety boundary for business actions. The language model never decides
 * whether the customer confirmed a booking, refused contact, asked for a human or wants a call
 * back: those come from here, from the CURRENT utterance only.
 */
import { hasAnyPhrase as hasAnyRaw, norm, tokens } from './text.js';

/** Lexicon phrases are written naturally ("that's all"); compare them in normalized form. */
const hasAnyPhrase = (n: string, phrases: readonly string[]) => {
  const key = phrases as unknown as { __n?: string[] };
  key.__n ??= phrases.map((p) => norm(p));
  return hasAnyRaw(n, key.__n);
};
import { hasWhenCue, parseWhen, resolveWhen, istParts, istDate, addIstDays } from './when.js';

export type Intent =
  | 'GREETING_ACK'
  | 'TALK_CONSENT'
  | 'NOT_INTERESTED'
  | 'WRONG_NUMBER'
  | 'HUMAN_REQUEST'
  | 'CALLBACK_REQUEST'
  | 'CANCELLATION_REQUEST'
  | 'GOODBYE'
  | 'VISIT_INTEREST'
  | 'REPEAT_REQUEST'
  | 'ACK'
  | 'UNKNOWN';

export type IntentResult = { intent: Intent; evidence?: string };

// ---------------------------------------------------------------------------------------------
// Lexicons. Phrases are normalized (lowercase, no punctuation) and matched on token boundaries.
// ---------------------------------------------------------------------------------------------

const WRONG_NUMBER = [
  'wrong number', 'wrong person', 'wrong no', 'thappana number', 'thappa number', 'தப்பான நம்பர்', 'தவறான நம்பர்', 'தவறான எண்',
  'தப்பான number', 'wrong நம்பர்', 'never enquired', 'did not enquire', 'didnt enquire', 'i did not enquire', 'not enquired',
  'enquiry pannala', 'enquiry panala', 'enquiry பண்ணல', 'enquiry பண்ணவே இல்ல', 'நான் enquiry பண்ணல', 'naan enquiry pannala',
  'naan enquiry panala', 'naan edhuvum enquiry pannala', 'i never enquired',
];

const STRONG_NOT_INTERESTED = [
  'not interested', 'no interest', 'not interest', 'am not interested', 'i am not interested', 'dont want', 'do not want',
  'dont call', 'do not call', 'dont call me', 'stop calling', 'stop call', 'dont disturb', 'do not disturb', 'do not contact',
  'dont contact', 'remove my number', 'remove me', 'unsubscribe', 'no need', 'already bought', 'already purchased',
  'already booked elsewhere', 'interest illa', 'interest illai', 'interest இல்ல', 'ஆர்வம் இல்ல', 'ஆர்வம் இல்லை', 'இன்ட்ரஸ்ட் இல்ல',
  'இன்டிரெஸ்ட் இல்ல', 'எனக்கு வேண்டாம்', 'enakku vendam', 'enaku vendam', 'call pannathinga', 'call பண்ணாதீங்க',
  'call பண்ணாதிங்க', 'கால் பண்ணாதீங்க', 'disturb pannathinga', 'தொந்தரவு பண்ணாதீங்க', 'already vaangiten', 'already vangiten',
  'already வாங்கிட்டேன்', 'வாங்கிட்டேன்', 'வாங்கிட்டோம்', 'vaangitten', 'vaangiten', 'வேண்டாம் call பண்ணாதீங்க', 'no thanks',
  'no thank you',
];

/** Weak "no" words: only NOT_INTERESTED when they are essentially the whole utterance. */
// A bare "no" / "illa" is NOT here: it answers whatever we just asked ("Porur, 80 lakhs - correct?" -> "No").
// Only "வேண்டாம் / vendam" (I don't want it) counts as a refusal when it is essentially the whole utterance.
const WEAK_NO = ['வேண்டாம்', 'வேணாம்', 'வேண்டாங்க', 'வேணாங்க', 'vendam', 'venam', 'venaam', 'vendaam', 'வேண்டாம்ங்க'];
const BARE_NO = ['no', 'nope', 'nah', 'nahi', 'illa', 'illai', 'illaye', 'இல்ல', 'இல்லை', 'இல்லங்க', 'இல்லைங்க', 'illanga', 'not now', 'no no', 'illa illa'];
const NO_FILLER = ['sir', 'madam', 'maam', 'thanks', 'thank', 'you', 'please', 'pls', 'சார்', 'மேடம்', 'நன்றி', 'thankyou', 'ங்க', 'pa', 'da', 'ji', 'sorry', 'ok', 'okay', 'சரி', 'இல்லை', 'ya', 'yes'];

const HUMAN = [
  'human', 'real person', 'a person', 'live person', 'agent', 'executive', 'salesperson', 'sales person', 'sales team', 'manager',
  'supervisor', 'senior', 'someone from your team', 'team member', 'talk to someone', 'speak to someone', 'speak to a person',
  'talk to a person', 'agent kitta', 'agent kita', 'agent கிட்ட', 'ஏஜென்ட் கிட்ட', 'ஏஜெண்ட்', 'ஏஜென்ட்', 'human person', 'manusha',
  'மனுஷன்', 'மனிதர்', 'ஆள் கிட்ட', 'aal kitta', 'நேரடியா பேசணும்', 'neradiya pesanum', 'yaaraavathu pesanum', 'யாராவது பேசணும்',
  'வேற யாராவது', 'vera yaaravathu', 'sales person kitta', 'sales team kitta', 'ஆபீஸ்ல இருந்து', 'owner kitta', 'ஓனர் கிட்ட',
  'person kitta', 'person kita', 'person கிட்ட', 'பர்சன் கிட்ட', 'ஒருத்தர் கிட்ட', 'ஒருத்தர்கிட்ட', 'oruthar kitta', 'oruththar kitta', 'oruthar kita',
  'representative', 'customer care', 'customer support', 'call centre', 'call center', 'staff kitta', 'staff கிட்ட', 'ஸ்டாப் கிட்ட', 'real human',
];

/** "call me" on its own asks for a person; "call me tomorrow / later" is a callback (checked separately). */
const CALL_ME_ALONE = /^(?:please |pls |can |could )?(?:someone |somebody |a person |your team )?call me(?: please| pls| back)?$/;

/** The customer turns down the property we offered, not the whole conversation. */
const PROPERTY_REJECTION = [
  'not this one', 'not that one', 'not this', 'not that property', 'not this property', 'dont like this', "don't like this", 'dont like it', "don't like it",
  'something else', 'another property', 'another one', 'different property', 'some other property', 'other property', 'other options', 'other option',
  'vera property', 'vera option', 'vera options', 'vera edhavadhu', 'vera ethavathu', 'vera onnu', 'vera ondru',
  'adhu venda', 'adhu vendam', 'adhu venam', 'athu venda', 'athu vendam', 'athu venam', 'adhu pidikkala', 'athu pidikkala', 'pidikkala',
  'idhu venda', 'idhu vendam', 'idhu venam', 'ithu venda', 'ithu vendam', 'indha property venda', 'intha property venda', 'antha property venda',
  'அது வேண்டாம்', 'அது வேணாம்', 'இது வேண்டாம்', 'இது வேணாம்', 'இந்த property வேண்டாம்', 'அந்த property வேண்டாம்', 'இந்த property வேணாம்',
  'பிடிக்கல', 'வேற property', 'வேற option', 'வேற ஏதாவது', 'வேற ஒண்ணு', 'வேற ஒன்னு',
];

export function isPropertyRejection(text: string): boolean {
  const n = norm(text);
  return Boolean(n) && hasAnyPhrase(n, PROPERTY_REJECTION) !== undefined;
}

const CALLBACK = [
  'call me later', 'call later', 'call back', 'callback', 'call me back', 'later', 'busy', 'i am busy', 'im busy', 'driving',
  'in a meeting', 'in meeting', 'meeting la', 'meeting ல', 'not now', 'not a good time', 'bad time', 'after some time', 'call me tomorrow',
  'call tomorrow', 'call me in the evening', 'ippo busy', 'ippo mudiyathu', 'ippo time illa', 'ippo vendam', 'இப்போ busy', 'இப்ப busy',
  'இப்ப முடியாது', 'இப்போ முடியாது', 'இப்ப வேண்டாம்', 'இப்போ வேண்டாம்', 'இப்ப time இல்ல', 'இப்போ time இல்ல', 'time illa', 'அப்புறம்', 'அப்புறமா',
  'அப்பறம்', 'அப்பறமா', 'apram', 'aprom', 'apuram', 'appuram', 'apparam', 'அப்புறம் call', 'அப்புறம் கூப்பிடுங்க', 'கூப்பிடுங்க',
  'koopidunga', 'koopudunga', 'call pannunga', 'call பண்ணுங்க', 'கால் பண்ணுங்க', 'konjam neram kazhichu', 'கொஞ்ச நேரம் கழிச்சு',
  'naalaikku call', 'நாளைக்கு call', 'நாளைக்கு கால்', 'sayangalam call', 'evening call', 'morning call', 'busy ah irukken', 'busy-ah irukken',
  'வேலையா இருக்கேன்', 'velaiya irukken', 'drive pannitu irukken', 'driving la', 'driving ல',
];

const CANCEL_APPOINTMENT = [
  'cancel all appointments', 'cancel all bookings', 'cancel all visits',
  'cancel my appointment', 'cancel my appointments', 'cancel appointment',
  'cancel appointments', 'cancel my booking', 'cancel booking', 'cancel bookings',
  'cancel site visit', 'cancel the visit', 'cancel my visit',
  'appointment cancel', 'appointments cancel', 'booking cancel',
  'cancel appointment please', 'please cancel my appointment',
  'appointment cancel pannunga', 'booking cancel pannunga',
  'visit cancel pannunga', 'cancel pannidunga', 'cancel pannunga',
  'எல்லா appointment cancel', 'appointment cancel பண்ணுங்க',
  'booking cancel பண்ணுங்க', 'எல்லா booking-யும் cancel பண்ணுங்க',
];

const GOODBYE = [
  'bye', 'bye bye', 'goodbye', 'good bye', 'thats all', "that's all", 'that is all', 'nothing else', 'no more', 'no more questions',
  'nothing more', 'see you', 'take care', 'போதும்', 'பை', 'பை பை', 'போயிட்டு வரேன்', 'சரி bye', 'சரி பை', 'ok bye', 'okay bye',
  'thanks bye', 'thank you bye', 'seri bye', 'sari bye', 'bye sir', 'bye madam',
  // "End the call" requests. Real call 2026-10-09: "Okay, cut the call" went to the model three times and the call
  // stayed open. Only phone/call-anchored forms: a bare "வச்சிருங்க" also means "keep it (noted)".
  'cut the call', 'cut call', 'call cut', 'cut the phone', 'cut it', 'please cut', 'cut pannunga', 'cut panunga', 'cut pannidunga',
  'call cut pannunga', 'call ah cut pannunga', 'call-ah cut pannunga', 'kat pannunga', 'hang up', 'hangup', 'disconnect', 'disconnect the call',
  'end the call', 'end call', 'stop the call', 'keep the phone', 'put the phone down', 'phone vainga', 'phone vaiynga', 'phone vachidunga',
  'phone vachirunga', 'phone vechidunga', 'phone vechirunga', 'call vachidunga', 'call vachirunga', 'call vechirunga', 'phone ah vainga',
  'கட் பண்ணுங்க', 'கட் பண்ணிடுங்க', 'கால் கட்', 'கால கட் பண்ணுங்க', 'கால் கட் பண்ணுங்க', 'போனை வைங்க', 'போன் வைங்க', 'ஃபோனை வைங்க', 'போனை வச்சிடுங்க',
  'போனை வச்சிருங்க', 'போன வைங்க', 'கால வச்சிருங்க', 'கால் வச்சிருங்க', 'கால வச்சிடுங்க', 'கால் வச்சிடுங்க',
];
/** "thanks" alone counts as goodbye only once the call is already wrapping up. */
const THANKS = ['thanks', 'thank you', 'thankyou', 'thanks a lot', 'நன்றி', 'நன்றிங்க', 'தேங்க்ஸ்', 'thanks sir', 'thank you sir'];

const TALK_CONSENT = [
  'பேசலாம்', 'பேசலாம்ங்க', 'பேசலாமே', 'பேசுங்க', 'பேசுங்கோ', 'சொல்லுங்க', 'சொல்லுங்கோ', 'சொல்லு', 'pesalam', 'pesalaam', 'pesunga', 'sollunga',
  'sollungal', 'solunga', 'go ahead', 'yes tell me', 'tell me', 'yes speaking', 'speaking', 'ya sollunga', 'ok sollunga', 'okay sollunga',
  'yes sollunga', 'aama sollunga', 'ஆமா சொல்லுங்க', 'ஆமா பேசலாம்', 'ஹலோ சொல்லுங்க', 'yes go ahead', 'sure go ahead', 'free dhaan', 'free thaan',
  'free தான்', 'free ஆ இருக்கேன்', 'பேச முடியும்', 'pesa mudiyum', 'ok pesalam', 'சரி பேசலாம்', 'seri pesalam', 'sari pesalam', 'i can talk', 'can talk',
  'yes i can talk', 'yes you can talk', 'talk', 'ok go ahead', 'okay go ahead',
];

const GREETING = [
  'hello', 'hi', 'hey', 'hallo', 'helo', 'vanakkam', 'வணக்கம்', 'ஹலோ', 'ஹாய்', 'namaste', 'good morning', 'good afternoon', 'good evening',
  'yes', 'yeah', 'ya', 'yep', 'ok', 'okay', 'ஆமா', 'ஆம்', 'ஆமாம்', 'சரி', 'aama', 'aamam', 'seri', 'sari', 'ஓகே', 'ஆமாங்க', 'சரிங்க', 'hello hello', 'ஹலோ ஹலோ',
  'who is this', 'who are you', 'யாரு', 'நீங்க யாரு', 'yaaru', 'yaaru pesaradhu', 'யாரு பேசறது', 'ஹலோ யாரு',
];

/** Said alone, these ask us to repeat; inside a sentence ("what is the price") they are a question. */
const REPEAT_ALONE = ['what', 'sorry', 'pardon', 'enna', 'ennanga', 'என்ன', 'என்னங்க', 'huh', 'hmm what', 'again'];
const REPEAT = [
  'pardon', 'say again', 'repeat', 'repeat please', 'can you repeat', 'could you repeat', 'cannot hear', 'cant hear',
  'not clear', 'திரும்ப சொல்லுங்க', 'thirumba sollunga', 'thirumba solunga', 'மறுபடியும் சொல்லுங்க', 'marubadiyum sollunga',
  'கேக்கல', 'kekkala', 'sariya kekkala', 'சரியா கேக்கல', 'கேட்கல', 'purila', 'புரில', 'puriyala', 'புரியல', 'sollunga again', 'one more time', 'once more',
  'enna sonneenga', 'என்ன சொன்னீங்க', 'enna solreenga', 'என்ன சொல்றீங்க',
];

const VISIT = [
  'site visit', 'visit', 'visit pannalam', 'visit பண்ணலாம்', 'visit பண்ணனும்', 'visit pananum', 'visit pannanum', 'see the property', 'see property',
  'see the flat', 'see the house', 'see the villa', 'come and see', 'come and visit', 'come to see', 'want to see', 'wanna see', 'could see', 'can i see',
  'பாக்கணும்', 'paakanum', 'pakkanum', 'பாக்கலாம்', 'paakalam', 'pakkalam', 'பார்க்கணும்', 'பார்க்கலாம்', 'நேர்ல பாக்கணும்', 'nerla paakanum', 'நேரில் பார்க்கணும்',
  'வந்து பாக்கறேன்', 'vanthu paakren', 'vanthu pakkuren', 'வந்து பாக்கணும்', 'eppo paakalam', 'எப்போ பாக்கலாம்', 'site paakanum', 'site பாக்கணும்', 'சைட் விசிட்',
  'விசிட்', 'saturday visit', 'sunday visit', 'book a visit', 'book visit', 'visit book', 'paakalaam', 'pakkalaam', 'paarkalaam', 'paakalama',
  'pogalam', 'pogalaam', 'போகலாம்', 'போய் பாக்கலாம்', 'poyi paakalam', 'poi paakalam', 'arrange a visit', 'arrange visit', 'visit arrange',
  'see it', 'show me the property', 'show the property', 'visit possible', 'visit pannalama', 'visit pannalaama', 'பாக்கலாமா', 'பார்க்கலாமா',
];

/** Everything that can legitimately be part of a "yes, book it" answer. Anything else is not a clean yes. */
const AFFIRM = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'yea', 'ok', 'okay', 'okk', 'sure', 'correct', 'right', 'fine', 'done', 'confirm', 'confirmed',
  'ஆமா', 'ஆம்', 'ஆமாம்', 'ஆமாங்க', 'சரி', 'சரிங்க', 'ஓகே', 'ஒகே', 'ஓகேங்க', 'யெஸ்', 'கண்டிப்பா', 'நிச்சயமா', 'aama', 'aamam', 'amam', 'aamaa',
  'sari', 'seri', 'saringa', 'seringa', 'kandippa', 'kandipa', 'nichayama', 'haan', 'haa', 'ha', 'bilkul', 'perfect', 'great', 'good', 'nice', 'super',
  'நல்லது', 'நல்லா', 'நல்லாருக்கு', 'நல்லா இருக்கு', 'சூப்பர்', 'nalladhu', 'nalla', 'நல்ல', 'aamanga', 'aamaanga', 'okayanga', 'okanga', 'எஸ்',
  'யெஸ்ஸ்', 'absolutely', 'definitely', 'please',
]);
const ACTION_WORDS = new Set([
  'book', 'booking', 'visit', 'site', 'slot', 'it', 'that', 'this', 'the', 'do', 'go', 'ahead', 'kindly', 'schedule', 'fix', 'please', 'pls', 'plz',
  'sir', 'madam', 'maam', 'ji', 'then', 'also', 'now', 'only', 'thanks', 'thank', 'you', 'and', 'time', 'okay',
  'பண்ணுங்க', 'பண்ணிடுங்க', 'பண்ணுங்கோ', 'பண்ணு', 'பண்ணலாம்', 'பண்ணிக்கோங்க', 'போடுங்க', 'போடு', 'வைங்க', 'வச்சுக்கோங்க', 'புக்', 'கன்பார்ம்',
  // Spoken Chennai forms of "do it": real call 2026-10-10, "சரி பண்ணிருங்க." to "Confirm பண்ணட்டுமா?" went to the model.
  'பண்ணிருங்க', 'பண்ணிருங்கோ', 'பண்ணிடு', 'பண்ணிரு', 'பண்ணிடலாம்', 'செஞ்சிடுங்க', 'செஞ்சிருங்க', 'போட்டுடுங்க', 'போட்டுருங்க',
  'கன்ஃபார்ம்', 'விசிட்', 'சைட்', 'சார்', 'மேடம்', 'தான்', 'நன்றி', 'நன்றிங்க',
  'pannunga', 'panunga', 'pannidunga', 'pannu', 'pannalam', 'panlam', 'podunga', 'podu', 'vainga', 'vaichukonga', 'pannikonga', 'dhaan', 'thaan',
  'pannirunga', 'panirunga', 'panidunga', 'pannidu', 'panniru', 'pannidalam', 'senjidunga', 'senjirunga', 'pottudunga', 'potturunga',
]);
/** Words that turn a "yes" into something else: refusal, hedge, change, deferral. */
const BLOCKERS = new Set([
  'no', 'nope', 'not', 'dont', 'never', 'illa', 'illai', 'இல்ல', 'இல்லை', 'vendam', 'venam', 'வேண்டாம்', 'வேணாம்', 'வேணாங்க', 'வேண்டாங்க',
  'but', 'however', 'aana', 'aanaal', 'ஆனா', 'ஆனால்', 'later', 'apram', 'aprom', 'apuram', 'அப்புறம்', 'அப்பறம்', 'maybe', 'perhaps', 'theriyala',
  'தெரியல', 'தெரியாது', 'think', 'yosikkiren', 'yosikaren', 'யோசிக்கிறேன்', 'யோசிக்கணும்', 'wait', 'hold', 'cancel', 'change', 'maathu', 'மாத்து',
  'மாத்தணும்', 'another', 'different', 'vera', 'வேற', 'sure?', 'confirm?', 'எப்போ', 'when', 'where', 'what', 'which', 'how', 'why', 'enna', 'என்ன',
]);

const NEGATIVE_ANSWER = [
  'no', 'nope', 'not now', 'no thanks', 'illa', 'illai', 'இல்ல', 'இல்லை', 'vendam', 'வேண்டாம்', 'வேணாம்', 'venam', 'cancel', 'dont book', 'do not book',
  'வேண்டாம் visit', 'visit வேண்டாம்', 'visit vendam', 'visit venam', 'site visit வேண்டாம்', 'site visit vendam', 'cancel pannunga', 'cancel பண்ணுங்க',
  'வேற நாள்', 'vera naal', 'வேற time', 'vera time', 'வேற நேரம்', 'change pannunga', 'change பண்ணுங்க', 'மாத்துங்க', 'maathunga', 'another day', 'different time',
  'different day', 'some other time', 'not that day', 'not that time', 'time suit aagala', 'suit aagathu', 'ஒத்துவராது', 'othuvarathu',
];

// ---------------------------------------------------------------------------------------------

export type AffirmResult = { yes: boolean; reason: string };

/**
 * Strict "explicit yes". Every token must be a recognised yes-word, a booking filler or politeness;
 * any other word (a different date, a question, a refusal, "பேசலாம்") makes it NOT a confirmation.
 */
export function isExplicitAffirmation(text: string, now: Date = new Date()): AffirmResult {
  const raw = (text ?? '').trim();
  if (!raw) return { yes: false, reason: 'empty' };
  if (/[?？]/.test(raw)) return { yes: false, reason: 'question' };
  const t = tokens(raw);
  if (t.length === 0) return { yes: false, reason: 'empty' };
  if (t.length > 8) return { yes: false, reason: 'too_long' };
  if (hasWhenCue(raw, now)) return { yes: false, reason: 'contains_new_date_or_time' };
  let affirm = 0;
  for (const token of t) {
    const base = token.replace(/(ங்கோ|ங்க)$/u, '');
    if (BLOCKERS.has(token) || BLOCKERS.has(base)) return { yes: false, reason: `blocker:${token}` };
    if (AFFIRM.has(token) || AFFIRM.has(base)) { affirm++; continue; }
    if (ACTION_WORDS.has(token) || ACTION_WORDS.has(base)) continue;
    return { yes: false, reason: `unknown_token:${token}` };
  }
  // A "yes" needs an actual yes-word, or the clear imperative "book/confirm ... pannunga".
  const joined = ` ${t.join(' ')} `;
  const imperative = /\b(book|confirm|schedule|fix)\b/.test(joined) || /(பண்ணுங்க|பண்ணிடுங்க|பண்ணிருங்க|செஞ்சிடுங்க|செஞ்சிருங்க|pannunga|pannidunga|pannirunga|panirunga|senjidunga|senjirunga|podunga|போடுங்க)/u.test(joined);
  if (affirm === 0 && !imperative) return { yes: false, reason: 'no_yes_word' };
  return { yes: true, reason: 'explicit_yes' };
}

/**
 * "சரி correct. <noise>": the first sentence is a clean yes and nothing after it refuses or hedges. For answering
 * a details check only, never for booking (a booking needs the whole utterance to be a clean yes).
 */
export function leadingAffirmation(text: string, now: Date = new Date()): boolean {
  const raw = (text ?? '').trim();
  const first = raw.split(/[.!?？।,]/u)[0]?.trim() ?? '';
  if (!first || first === raw) return false;
  if (!isExplicitAffirmation(first, now).yes) return false;
  const rest = norm(raw.slice(raw.indexOf(first) + first.length));
  if (!rest) return true;
  if (hasAnyPhrase(rest, NEGATIVE_ANSWER) || hasAnyPhrase(rest, STRONG_NOT_INTERESTED) || hasAnyPhrase(rest, CALLBACK) || hasAnyPhrase(rest, GOODBYE)) return false;
  return !rest.split(' ').some((t) => BLOCKERS.has(t) && !['what', 'which', 'when', 'where', 'how', 'why', 'enna', 'என்ன', 'எப்போ'].includes(t));
}

/** Clear refusal of the PROPOSED visit (not a refusal of all contact). */
export function isExplicitNegation(text: string): boolean {
  const n = norm(text);
  if (!n) return false;
  if (hasAnyPhrase(n, NEGATIVE_ANSWER)) return true;
  return false;
}

function onlyWeakNo(n: string): boolean {
  const t = n.split(' ').filter(Boolean);
  if (t.length === 0 || t.length > 4) return false;
  let weak = 0;
  for (const token of t) {
    const base = token.replace(/(ங்கோ|ங்க)$/u, '');
    if (WEAK_NO.includes(token) || WEAK_NO.includes(base)) weak++;
    else if (!NO_FILLER.includes(token) && !NO_FILLER.includes(base)) return false;
  }
  return weak > 0 && !t.some((x) => x === 'yes' || x === 'ya');
}

export type ClassifyContext = {
  /** The call is already wrapping up (booking done / callback agreed): "thanks" means goodbye. */
  closing?: boolean;
  /** The agent is waiting for an answer to a visit confirmation (so a bare "வேண்டாம்" refuses the visit only). */
  awaitingVisitConfirmation?: boolean;
};

export function classifyIntent(text: string, ctx: ClassifyContext = {}): IntentResult {
  const n = norm(text);
  if (!n) return { intent: 'UNKNOWN' };

  let hit: string | undefined;

  if ((hit = hasAnyPhrase(n, WRONG_NUMBER))) return { intent: 'WRONG_NUMBER', evidence: hit };

  // Callback ("இப்ப வேண்டாம், அப்புறம் கூப்பிடுங்க") is checked before the weak "வேண்டாம்".
  const callback = hasAnyPhrase(n, CALLBACK);
  const strongNo = hasAnyPhrase(n, STRONG_NOT_INTERESTED);

  if (strongNo && !callback) {
    // "no need to visit" style refusals of just the visit are handled by the confirmation state.
    if (!(ctx.awaitingVisitConfirmation && /visit|site|விசிட்|சைட்/.test(n))) {
      return { intent: 'NOT_INTERESTED', evidence: strongNo };
    }
  }
  if (!callback && !ctx.awaitingVisitConfirmation && onlyWeakNo(n)) return { intent: 'NOT_INTERESTED', evidence: n };

  if ((hit = hasAnyPhrase(n, HUMAN))) return { intent: 'HUMAN_REQUEST', evidence: hit };
  if (CALL_ME_ALONE.test(n)) return { intent: 'HUMAN_REQUEST', evidence: 'call me' };
  if (callback) return { intent: 'CALLBACK_REQUEST', evidence: callback };
  if ((hit = hasAnyPhrase(n, CANCEL_APPOINTMENT))) return { intent: 'CANCELLATION_REQUEST', evidence: hit };

  if ((hit = hasAnyPhrase(n, GOODBYE))) return { intent: 'GOODBYE', evidence: hit };
  if (ctx.closing && (hit = hasAnyPhrase(n, THANKS))) return { intent: 'GOODBYE', evidence: hit };

  if ((hit = hasAnyPhrase(n, VISIT))) return { intent: 'VISIT_INTEREST', evidence: hit };
  // "திரும்ப சொல்லுங்க" (say that again) must win over "சொல்லுங்க" (go ahead).
  if (REPEAT_ALONE.map(norm).includes(n)) return { intent: 'REPEAT_REQUEST', evidence: n };
  if ((hit = hasAnyPhrase(n, REPEAT)) && n.split(' ').length <= 5) return { intent: 'REPEAT_REQUEST', evidence: hit };
  // "tell me ..." / "சொல்லுங்க" are consent only as a short answer; inside a longer question they are just words.
  const consent = hasAnyPhrase(n, TALK_CONSENT);
  if (consent) {
    const words = n.split(' ').length;
    if (words <= 3 || consent.split(' ').length * 2 >= words) return { intent: 'TALK_CONSENT', evidence: consent };
  }

  const t = n.split(' ');
  if (t.length <= 4 && t.every((x) => GREETING.includes(x) || GREETING.includes(x.replace(/(ங்கோ|ங்க)$/u, '')) || ['ங்க', 'sir', 'madam', 'சார்', 'மேடம்'].includes(x)) ) {
    return { intent: 'GREETING_ACK', evidence: n };
  }
  if (hasAnyPhrase(n, GREETING.filter((g) => g.includes(' ') && /who|யாரு|yaaru/.test(g)))) return { intent: 'GREETING_ACK', evidence: n };

  return { intent: 'UNKNOWN' };
}

/**
 * When did the customer ask to be called back? Returns undefined when no usable time was said
 * ("call me later"), in which case the sales team follows up without an exact time.
 */
export function parseCallbackTime(text: string, now: Date = new Date()): Date | undefined {
  const when = parseWhen(text, now);
  const resolved = resolveWhen(when);
  if ('at' in resolved) {
    return resolved.at.getTime() > now.getTime() + 5 * 60_000 ? resolved.at : undefined;
  }
  const nowIst = istParts(now);
  if (when.date && when.hour === undefined) {
    return istDate(when.date.year, when.date.month, when.date.day, 11, 0);
  }
  if (when.hour !== undefined && !when.date) {
    const today = istDate(nowIst.year, nowIst.month, nowIst.day, when.hour, when.minute ?? 0);
    if (today.getTime() > now.getTime() + 5 * 60_000) return today;
    const t = addIstDays(now, 1);
    return istDate(t.year, t.month, t.day, when.hour, when.minute ?? 0);
  }
  return undefined;
}


/** A bare "no" / "illa" (nothing else): an answer to our last question, never an opt-out by itself. */
export function isBareNo(text: string): boolean {
  const n = norm(text);
  if (!n) return false;
  const t = n.split(' ').filter((x) => !NO_FILLER.includes(x) || x === 'இல்லை');
  return t.length > 0 && t.length <= 3 && BARE_NO.map(norm).includes(t.join(' '));
}

const PRICE = ['price', 'cost', 'rate', 'how much', 'evlo', 'evvalavu', 'evalavu', 'vilai', 'விலை', 'எவ்வளவு', 'rate enna', 'price enna', 'amount'];
/** "What is the price?", "evlo?", "விலை என்ன?" - answered from verified inventory, never by the model. */
export function asksPrice(text: string): boolean {
  const n = norm(text);
  if (!n || n.split(' ').length > 10) return false;
  if (/(budget|lakh|lakhs|crore|லட்சம்|கோடி)/u.test(n)) return false; // the customer telling us their budget
  return Boolean(hasAnyPhrase(n, PRICE));
}

const DEMONSTRATIVE = ['that one', 'this one', 'that property', 'this property', 'same property', 'same one', 'the same', 'andha property', 'andha onnu',
  'adhu', 'adhuve', 'idhu', 'அந்த property', 'அந்த ஒன்னு', 'அதுவே', 'அது', 'இது', 'athu', 'athuve', 'that flat', 'that place', 'the first one'];
/** "That one" / "same property" / "அந்த property": the customer means a property we already read out. */
export function refersToShownProperty(text: string): boolean {
  const n = norm(text);
  return Boolean(n) && n.split(" ").length <= 8 && Boolean(hasAnyPhrase(n, DEMONSTRATIVE));
}

/**
 * Everyday side questions answered by rules on the phone (no model call, no 2-3 s wait):
 *   'ai'             "நீங்க AI-ஆ?", "are you a robot?", "neenga machine-aa?"
 *   'accompany'      "நீங்க போறீங்களா?", "நீங்க கூட வருவீங்களா?", "யாரு வருவாங்க?", "will you come with me?"
 *   'whatProperties' "என்ன properties இருக்கு?", "what options do you have?"
 */
export type CommonQuestion = 'ai' | 'accompany' | 'whatProperties';
const YOU = /(?:நீங்க|நீங்கள்|neenga|ninga|\byou\b|\bu\b|இது|idhu|\bthis\b)/iu;
const AI_WORD = /(?:\bai\b|a\.i\.|robot|ரோபோ|\bbot\b|machine|மெஷின்|computer|கம்ப்யூட்டர்|recording|recorded|ரெக்கார்டிங்|மனுஷ|human|real person)/iu;
const ACCOMPANY = /(?:(?:நீங்க|neenga|ninga)\s*(?:\S+\s+)?(?:போறீங்களா|போவீங்களா|போறீங்க\?|வருவீங்களா|வர்றீங்களா|வரீங்களா|வருவீங்க\?|poreengala|poveengala|varuveengala|vareengala|varreengala))|(?:யாரு?\s*(?:கூட\s*)?(?:வருவாங்க|வருவா|கூட்டிட்டு போவாங்க|காட்டுவாங்க))|(?:yaaru?\s*(?:kooda\s*)?(?:varuvaanga|kootittu povaanga|kaatuvaanga))|(?:\b(?:will|are)\s+you\s+(?:come|coming|be there|go|going)\b)|(?:\bwho\s+will\s+(?:come|be there|show)\b)/iu;
const WHAT_PROPS = /(?:என்ன|enna|\bwhat\b|\bwhich\b|எந்த|endha)\s*(?:\S+\s+){0,2}?(?:properties|property|projects?|options?|flats?|வீடு|veedu|ப்ராபர்ட்டி)/iu;

export function commonQuestion(text: string): CommonQuestion | undefined {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  if (ACCOMPANY.test(t)) return 'accompany';
  const asking = /[?？]/.test(t) || /(?:ஆ|ஆ\?|ஆங்க|தானா|ஆ\s*$|aa\b|thaana|dhaana)/iu.test(t) || /\b(?:are|r)\s+(?:you|u)\b/i.test(t);
  if (AI_WORD.test(t) && YOU.test(t) && asking) return 'ai';
  if (WHAT_PROPS.test(t) && (/[?？]/.test(t) || /(?:இருக்கு|iruku|irukku|have|available|kaatunga|காட்டுங்க)/iu.test(t))) return 'whatProperties';
  return undefined;
}

/** "எந்த location?", "எங்க இருக்கு?", "where is it?": the area of the options on the table (answered from inventory). */
export function asksLocation(text: string): boolean {
  const t = (text ?? '').trim();
  return /(?:எந்த|endha|entha|\bwhich\b)\s*(?:location|area|இடம்|ஏரியா|ஊர்|place)|(?:எங்க|எங்கே|enga|engey)\s*(?:இருக்கு|இருக்கு\?|iruku|irukku|irukkudhu)|\bwhere\s+(?:is|exactly|is\s+it|is\s+that|is\s+this)\b|(?:location|area|address|லொகேஷன்)\s*(?:என்ன|enna|\?)|(?:என்ன|enna)\s*(?:location|area|address)/iu.test(t);
}

/**
 * The caller is checking the line: "Hello?", "ஹலோ ஹலோ", "கேக்குதா?", "sound இல்லையா?", "பேசவே மாட்டேங்குது",
 * "can you hear me?" (real call 2026-10-10 - the caller could not hear us and the model answered 3.4 s later).
 */
export function isLineCheck(text: string): boolean {
  const t = (text ?? '').toLowerCase().replace(/[.,!?？]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/^(?:(?:hello|helo|hallo|halo|ஹலோ|ஹல்லோ)(?:ங்க)?\s*){1,3}$/u.test(t)) return true;
  return /(?:கேக்குதா|கேட்குதா|கேக்குதுங்களா|கேக்கலையா|sound\s*(?:இல்லையா|இல்லை|வரல|illaya|illa|varala)|சவுண்ட்\s*(?:இல்லையா|வரல)|சத்தம்\s*(?:வரல|இல்லை)|voice\s*(?:வரல|varala|illa)|பேசவே\s*மாட்டேங்குது|பேச\s*மாட்டேங்குது|ஒண்ணும்\s*கேக்கல|kekkudha|kekudha|kekkuthaa|can\s+you\s+hear|are\s+you\s+there|hello\s+are\s+you|line-?ல\s*இருக்கீங்களா|யாரும்\s*இல்லையா)/u.test(t);
}
