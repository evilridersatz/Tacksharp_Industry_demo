/**
 * Deterministic replies. Every control turn (consent, confirmation, goodbye, handoff, callback,
 * unclear audio, booking result) is worded here - no model call, so it is fast, always correct,
 * and can never claim an action that did not happen.
 *
 * styles: 'ta' spoken Chennai Tamil in Tamil script, with the English words Chennai people actually use left in
 * English (what Bulbul speaks most naturally), 'tl' the same in Roman letters (WhatsApp), 'en' English.
 * Write how a Chennai sales executive talks on the phone, not written Tamil: பாக்குறீங்க not பார்க்கிறீர்கள்,
 * எவ்ளோ not எவ்வளவு, "correct-ஆ?", "problem இல்லங்க", "-ங்க" for respect. No மற்றும் / விருப்பமா / இனிதாகட்டும்.
 */
import { formatRupeesShort } from '../common/parsers.js';
import type { PresentedProperty } from './session.js';
import type { SlotName, Slots } from './slots.js';
import { describeWhen, istParts, spokenWhen, type WhenDraft } from './when.js';

export type Style = 'ta' | 'tl' | 'en';
const pick = <T extends Record<Style, string>>(style: Style, v: T) => v[style];

// "சூப்பர்." only for a booking: it was said after "Hello." and "ஆமா" (real call 2026-10-10), which sounds wrong.
const ACKS: Record<Style, string[]> = { ta: ['சரிங்க.', 'ஓகே.'], tl: ['Seri.', 'Okay.'], en: ['Okay.', 'Alright.'] };
export const ack = (style: Style, turn: number) => ACKS[style][turn % ACKS[style].length];
/** Spoken acknowledgements (pre-synthesized at startup; played first). Index 2 is the booking one. */
export const ACK_LINES = { ta: [...ACKS.ta, 'சூப்பர்.'], en: [...ACKS.en, 'Great.'] };

export function askSlot(style: Style, slot: SlotName | 'bhk', known?: Slots): string {
  switch (slot) {
    case 'location':
      return pick(style, { ta: 'எந்த area-ல பாக்குறீங்க?', tl: 'Endha area-la paakureenga?', en: 'Which area are you looking in?' });
    case 'budget':
      return pick(style, { ta: 'Budget எவ்ளோ வரைக்கும் பாக்குறீங்க?', tl: 'Budget evlo varaikkum paakureenga?', en: 'What is your budget range?' });
    case 'bhk':
    case 'propertyType':
      return pick(style, { ta: 'எத்தனை BHK பாக்குறீங்க?', tl: 'Ethana BHK paakureenga?', en: 'How many BHK do you need?' });
    default:
      return pick(style, { ta: 'எப்போ வாங்குற plan-ல இருக்கீங்க?', tl: 'Eppo vaangura plan-la irukeenga?', en: 'When are you planning to buy?' });
  }
}

/** Details already on file (from the enquiry form): read them back as ONE question before searching. */
export function confirmRequirement(style: Style, known: Slots): string {
  const parts: string[] = [];
  if (known.location) parts.push(known.location);
  if (known.bhk) parts.push(`${known.bhk} BHK`);
  else if (known.propertyType) parts.push(known.propertyType);
  if (known.budget) parts.push(`${formatRupeesShort(known.budget)} budget`);
  const what = parts.join(', ');
  // Spoken order in Tamil: "Porur-ல 2 BHK, 1 crore budget-ல பாக்குறீங்க, correct-ஆ?"
  const taWhat = [known.location ? `${known.location}-ல` : '', known.bhk ? `${known.bhk} BHK` : known.propertyType ?? '']
    .filter(Boolean)
    .join(' ');
  const taBudget = known.budget ? `${formatRupeesShort(known.budget)} budget-ல ` : '';
  const tlWhat = [known.location ? `${known.location}-la` : '', known.bhk ? `${known.bhk} BHK` : known.propertyType ?? ''].filter(Boolean).join(' ');
  const tlBudget = known.budget ? `${formatRupeesShort(known.budget)} budget-la ` : '';
  // Details on file came from the enquiry form, not from this call: say where they came from and ASK. The budget
  // is not read back (form budgets are often wrong, e.g. "3 crore" for a 2 BHK); it is asked or corrected later.
  void taBudget;
  void tlBudget;
  const enWhat = [known.location, known.bhk ? `${known.bhk} BHK` : known.propertyType].filter(Boolean).join(', ') || what;
  return pick(style, {
    ta: `நீங்க ${taWhat} enquiry பண்ணிருந்தீங்க. இப்பவும் அதே தானா?`,
    tl: `Neenga ${tlWhat} enquiry pannirundheenga. Ippavum adhe dhaana?`,
    en: `Your enquiry was for ${enWhat}. Is that still right?`,
  });
}

/** A cancellation request is acknowledged without falsely claiming the visit was cancelled. */
export function cancellationRequested(style: Style): string {
  return pick(style, {
    ta: 'Appointment cancel பண்ணணும்னு புரியுது. இன்னும் cancel ஆகல; நம்ம team-க்கு request அனுப்பியிருக்கேன். அவங்க confirm பண்ணுவாங்க.',
    tl: 'Appointment cancel pannanumnu puriyudhu. Innum cancel aagala; namma team-ku request anuppiyirukken. Avanga confirm pannuvaanga.',
    en: 'I understand you want to cancel your appointment. It has not been cancelled yet; I have sent your request to our team for confirmation.',
  });
}

/** The customer said the details on file are wrong: start over with one question. */
export function startOver(style: Style): string {
  return pick(style, {
    ta: 'பரவாயில்ல, புதுசா பாக்கலாம். எந்த area-ல பாக்குறீங்க?',
    tl: 'Paravaayilla, pudhusa paakalam. Endha area-la paakureenga?',
    en: 'No problem, let us start fresh. Which area are you looking in?',
  });
}

export function noted(style: Style, turn: number, got: Slots): string {
  const parts: string[] = [];
  if (got.location) parts.push(got.location);
  if (got.bhk) parts.push(`${got.bhk} BHK`);
  if (got.propertyType && !got.bhk) parts.push(got.propertyType);
  if (got.budget) parts.push(`${formatRupeesShort(got.budget)} budget`);
  if (parts.length === 0) return ack(style, turn);
  return `${ack(style, turn)} ${parts.join(', ')}.`;
}

const join = (style: Style, items: string[]) => items.join(pick(style, { ta: ', அப்புறம் ', tl: ', apram ', en: ' and ' }));

/**
 * Spoken property name: the generic last word goes ("Green Valley Apartments" -> "Green Valley") when what is left
 * is still two words and no other option shortens to the same name. Matching still works on the distinctive words.
 */
// Only "Apartments" / "Homes" / "Flats" are dropped: "Anna Nagar Residency" -> "Anna Nagar" would sound like the area.
const GENERIC_TAIL = /\s+(?:apartments?|homes|flats)$/i;
export function shortName(name: string, all: readonly { name: string }[] = []): string {
  const short = name.replace(GENERIC_TAIL, '').trim();
  if (short === name || short.split(/\s+/).length < 2) return name;
  const clash = all.some((p) => p.name !== name && p.name.replace(GENERIC_TAIL, '').trim().toLowerCase() === short.toLowerCase());
  return clash ? name : short;
}

/**
 * Voice list of options: names and prices, one question, no location (they just told us / confirmed it) and no
 * "இருக்கு ... அப்புறம்" filler. `withPrice: false` when the customer has just given the budget: every option is
 * within it, so the prices would only repeat their own words back at them.
 */
export function presentProperties(style: Style, props: PresentedProperty[], max = 2, options: { withPrice?: boolean; withArea?: boolean } = {}): string {
  const shown = props.slice(0, max);
  const withPrice = options.withPrice ?? true;
  // The area is said when the customer did not say it in this turn (it came from the enquiry form / memory):
  // real call 2026-10-10, "Green Valley 80 lakhs இருக்கு." -> "எந்த location?" cost a 3 s model turn.
  const areas = [...new Set(shown.map((p) => areaOf(p)))];
  const prefix = options.withArea && areas.length === 1 ? pick(style, { ta: `${areas[0]}-ல `, tl: `${areas[0]}-la `, en: `In ${areas[0]}, ` }) : '';
  const items = shown.map((p) => (withPrice ? `${shortName(p.name, shown)} ${p.priceText}` : shortName(p.name, shown)));
  if (prefix) items[0] = `${prefix}${items[0]}`;
  if (shown.length === 1) {
    return pick(style, {
      ta: `${items[0]} இருக்கு. பாக்கலாமா?`,
      tl: `${items[0]} irukku. Paakalaamaa?`,
      en: `There is ${items[0]}. Would you like to see it?`,
    });
  }
  if (!withPrice) {
    return pick(style, {
      ta: `${items.join(', ')} இருக்கு. எதை பாக்கலாம்?`,
      tl: `${items.join(', ')} irukku. Edha paakalam?`,
      en: `We have ${join(style, items)}. Which one would you like to see?`,
    });
  }
  return pick(style, {
    ta: `${items.join(', ')}. எதை பாக்கலாம்?`,
    tl: `${items.join(', ')}. Edha paakalam?`,
    en: `${items.join(', ')}. Which one would you like to see?`,
  });
}

const areaOf = (p: { location: string }) => p.location.split(',')[0].trim();

/** "எந்த location?": where the options on the table are, from inventory, with one question. */
export function locationAnswer(style: Style, props: PresentedProperty[], focusId?: string): string {
  const focus = props.find((p) => p.id === focusId);
  const shown = focus ? [focus] : props.slice(0, 2);
  const areas = [...new Set(shown.map(areaOf))];
  if (shown.length === 1) {
    const p = shown[0];
    return pick(style, { ta: `${shortName(p.name)} ${areaOf(p)}-ல இருக்கு.`, tl: `${shortName(p.name)} ${areaOf(p)}-la irukku.`, en: `${shortName(p.name)} is in ${areaOf(p)}.` });
  }
  if (areas.length === 1) return pick(style, { ta: `ரெண்டுமே ${areas[0]}-ல தான்.`, tl: `Rendume ${areas[0]}-la dhaan.`, en: `Both are in ${areas[0]}.` });
  const parts = shown.map((p) => pick(style, { ta: `${shortName(p.name, shown)} ${areaOf(p)}-ல`, tl: `${shortName(p.name, shown)} ${areaOf(p)}-la`, en: `${shortName(p.name, shown)} in ${areaOf(p)}` }));
  return pick(style, { ta: `${parts.join(', ')} இருக்கு.`, tl: `${parts.join(', ')} irukku.`, en: `${parts.join(', ')}.` });
}

/**
 * Chat greeting from a customer who already has visits booked: every upcoming visit, never the old options again.
 * `visits[0]` is the one to lead with (the engine puts a booking made in the last 30 minutes first, else the
 * earliest). Three lines at most (shapeChatReply caps chat replies at 3 lines: a line per visit used to cut the list
 * off - WhatsApp 2026-10-10, "3 site visits booked" followed by only 2, the newest one missing).
 */
export function upcomingVisits(style: Style, visits: Array<{ propertyName: string; at: Date }>): string {
  const [first, ...rest] = visits;
  const when = (v: { at: Date }) => describeWhen(v.at, style);
  const head = pick(style, {
    ta: `வணக்கம்! உங்க ${first.propertyName} site visit ${when(first)}க்கு book ஆகியிருக்கு.`,
    tl: `Vanakkam! Unga ${first.propertyName} site visit ${when(first)}-ku book aagirukku.`,
    en: `Hi! Your site visit at ${first.propertyName} is booked for ${when(first)}.`,
  });
  const close = pick(style, { ta: 'வேற ஏதாவது help வேணுமா?', tl: 'Vera edhavadhu help venumaa?', en: 'Anything else I can help with?' });
  if (!rest.length) return `${head}\n${close}`;
  const shown = rest.slice(0, 4).map((v) => `${v.propertyName} (${when(v)})`);
  const more = rest.length > 4 ? pick(style, { ta: ` + இன்னும் ${rest.length - 4}`, tl: ` + innum ${rest.length - 4}`, en: ` + ${rest.length - 4} more` }) : '';
  const also = pick(style, { ta: `இதுவும் book ஆகியிருக்கு: ${shown.join('; ')}${more}.`, tl: `Idhuvum book aagirukku: ${shown.join('; ')}${more}.`, en: `Also booked: ${shown.join('; ')}${more}.` });
  return `${head}\n${also}\n${close}`;
}

/** Voice confirmation question: short name, short day/time. A booking still needs an explicit yes to THIS question. */
export function confirmQuestionSpoken(style: Style, propertyName: string, at: Date, now?: Date): string {
  const when = spokenWhen(at, style, now);
  const name = shortName(propertyName);
  return pick(style, {
    ta: `${name}, ${when}. Confirm பண்ணட்டுமா?`,
    tl: `${name}, ${when}. Confirm pannattumaa?`,
    en: `${name}, ${when}. Shall I confirm?`,
  });
}

/** Second wording of the voice confirmation question. */
export function confirmQuestionSpokenShort(style: Style, propertyName: string, at: Date, now?: Date): string {
  const when = spokenWhen(at, style, now);
  return pick(style, {
    ta: `${when}, ${shortName(propertyName)}. Book பண்ணிடட்டுமா?`,
    tl: `${when}, ${shortName(propertyName)}. Book pannattumaa?`,
    en: `${shortName(propertyName)}, ${when}. Should I book it?`,
  });
}

/** Voice: booked. The WhatsApp confirmation that follows carries the full date and address. */
export function bookedSpoken(style: Style, propertyName: string, at: Date, now?: Date): string {
  // Spoken after a cached "சூப்பர்." (engine): "நாளைக்கு சாயங்காலம் 3 மணிக்கு Green Valley visit book பண்ணிட்டேன்."
  const when = spokenWhen(at, style, now);
  return pick(style, {
    ta: `${when}க்கு ${shortName(propertyName)} book பண்ணிட்டேன். Thank you!`,
    tl: `${when}-ku ${shortName(propertyName)} book pannitten. Thank you!`,
    en: `Your visit to ${shortName(propertyName)} is booked for ${when}. Thank you!`,
  });
}

let STATIC_LINES: Set<string> | undefined;
/** True for a fixed line (no customer data) that is synthesized once and played from the audio cache. */
export function isStaticVoiceLine(text: string): boolean {
  STATIC_LINES ??= new Set(staticVoiceLines().map((l) => l.replace(/\s+/g, ' ').trim()));
  return STATIC_LINES.has(text.replace(/\s+/g, ' ').trim());
}

/** A day / time the customer gave before any property was chosen: "சரிங்க. நாளைக்கு 11 மணி." (kept for the visit). */
export function whenNoted(style: Style, draft: WhenDraft, now: Date = new Date()): string {
  const parts: string[] = [];
  if (draft.date) parts.push(dayLabel(style, draft.date, now));
  if (draft.hour !== undefined && !draft.fromPartOfDay) {
    const h12 = draft.hour % 12 === 0 ? 12 : draft.hour % 12;
    const time = draft.minute ? `${h12}:${String(draft.minute).padStart(2, '0')}` : `${h12}`;
    const part = draft.hour < 12 ? '' : draft.hour < 15 ? pick(style, { ta: 'மதியம் ', tl: 'madhiyam ', en: '' }) : pick(style, { ta: 'சாயங்காலம் ', tl: 'saayangaalam ', en: '' });
    parts.push(pick(style, { ta: `${part}${time} மணி`, tl: `${part}${time} mani`, en: `at ${time} ${draft.hour < 12 ? 'AM' : 'PM'}` }));
  } else if (draft.ambiguousHour !== undefined) {
    parts.push(pick(style, { ta: `${draft.ambiguousHour} மணி`, tl: `${draft.ambiguousHour} mani`, en: `at ${draft.ambiguousHour}` }));
  }
  const head = ACKS[style][0];
  return parts.length ? `${head} ${parts.join(' ')}.` : head;
}

/** Common questions answered by rules (no model): are you an AI, will someone come along. */
export function commonAnswer(style: Style, kind: 'ai' | 'accompany'): string {
  if (kind === 'ai') return pick(style, { ta: 'ஆமாங்க, நான் AI assistant தான்.', tl: 'Aamanga, naan AI assistant dhaan.', en: 'Yes, I am an AI assistant.' });
  return pick(style, {
    ta: 'Site visit அப்போ நம்ம team-ல இருந்து ஒருத்தர் உங்க கூட இருப்பாங்க.',
    tl: 'Site visit appo namma team-la irundhu oruthar unga kooda iruppaanga.',
    en: 'Someone from our team will be with you at the site visit.',
  });
}

/** "Shall we see X?" for a single option on the table. */
export function shallWeSee(style: Style, propertyName: string): string {
  return pick(style, { ta: `${shortName(propertyName)} பாக்கலாமா?`, tl: `${shortName(propertyName)} paakalaamaa?`, en: `Would you like to see ${shortName(propertyName)}?` });
}

/** "பாக்கலாமா?" after saying where the single option is. */
export function shallWeSeeShort(style: Style): string {
  return pick(style, { ta: 'பாக்கலாமா?', tl: 'Paakalaamaa?', en: 'Would you like to see it?' });
}

/** Line check ("Hello?", "கேக்குதா?", "sound இல்லையா?"): we are here; the pending question follows. */
export function lineCheck(style: Style): string {
  return pick(style, { ta: 'கேக்குதுங்க, சொல்லுங்க.', tl: 'Kekkudhunga, sollunga.', en: 'Yes, I can hear you.' });
}

/** Line check before the customer has answered the opening: who we are, and the opening question again. */
export function lineCheckOpening(style: Style, org: string): string {
  return pick(style, {
    ta: `ஹலோ, ${org}-ல இருந்து பேசுறேன். இப்போ பேசலாமா?`,
    tl: `Hello, ${org}-la irundhu pesuren. Ippo pesalaamaa?`,
    en: `Hello, this is ${org}. Is now a good time to talk?`,
  });
}

/** A property the customer named: name, size, price (from inventory), area only when the name does not carry it. */
export function propertyIntro(style: Style, p: PresentedProperty): string {
  const area = areaOf(p);
  const inName = p.name.toLowerCase().includes(area.toLowerCase());
  const size = p.bhk ? `${p.bhk} BHK` : p.type;
  return pick(style, {
    ta: inName ? `${p.name}, ${size}, ${p.priceText}.` : `${p.name} ${area}-ல இருக்கு, ${size}, ${p.priceText}.`,
    tl: inName ? `${p.name}, ${size}, ${p.priceText}.` : `${p.name} ${area}-la irukku, ${size}, ${p.priceText}.`,
    en: inName ? `${p.name}: ${size}, ${p.priceText}.` : `${p.name} in ${area}: ${size}, ${p.priceText}.`,
  });
}

/** Nothing in the inventory fits at all: one question about what to change. */
export function adjustQuestion(style: Style): string {
  return pick(style, { ta: 'வேற area இல்ல budget சொல்லுங்க?', tl: 'Vera area illa budget sollunga?', en: 'Shall I try another area or budget?' });
}

/**
 * No exact match, but a REAL nearest option: above the budget, the same area in another size, or the same size and
 * budget in another area. Says why it differs, in a few words, and asks one question.
 */
export function noMatchOffer(style: Style, slots: Slots, alt: PresentedProperty, kind: 'above_budget' | 'same_area' | 'other_area'): string {
  const budget = slots.budget ? formatRupeesShort(slots.budget) : '';
  const want = [slots.bhk ? `${slots.bhk} BHK` : '', budget ? pick(style, { ta: `${budget}-க்குள்ள`, tl: `${budget}-kulla`, en: `within ${budget}` }) : ''].filter(Boolean).join(' ');
  const where = slots.location ?? areaOf(alt);
  const size = alt.bhk ? `${alt.bhk} BHK ` : '';
  if (kind === 'above_budget') {
    return pick(style, {
      ta: `${budget ? `${budget}-க்குள்ள` : `${where}-ல`} இல்லங்க. ${shortName(alt.name)} ${alt.priceText} இருக்கு. பாக்கலாமா?`,
      tl: `${budget ? `${budget}-kulla` : `${where}-la`} illanga. ${shortName(alt.name)} ${alt.priceText} irukku. Paakalaamaa?`,
      en: `Nothing ${budget ? `within ${budget}` : `in ${where}`}. ${alt.name} is ${alt.priceText}. Would you like to see it?`,
    });
  }
  if (kind === 'same_area') {
    return pick(style, {
      ta: `${where}-ல ${want} இல்லங்க. ${shortName(alt.name)} ${size}${alt.priceText} இருக்கு. பாக்கலாமா?`,
      tl: `${where}-la ${want} illanga. ${shortName(alt.name)} ${size}${alt.priceText} irukku. Paakalaamaa?`,
      en: `Nothing ${want} in ${where}. ${alt.name} is ${size}${alt.priceText}. Would you like to see it?`,
    });
  }
  return pick(style, {
    ta: `${where}-ல இப்போ இல்லங்க. ${areaOf(alt)}-ல ${shortName(alt.name)} ${size}${alt.priceText} இருக்கு. பாக்கலாமா?`,
    tl: `${where}-la ippo illanga. ${areaOf(alt)}-la ${shortName(alt.name)} ${size}${alt.priceText} irukku. Paakalaamaa?`,
    en: `Nothing in ${where} right now. In ${areaOf(alt)}, ${alt.name} is ${size}${alt.priceText}. Would you like to see it?`,
  });
}

/** Re-asked after a side question in the greeting step. */
export function canWeTalk(style: Style): string {
  return pick(style, { ta: 'இப்போ பேசலாமா?', tl: 'Ippo pesalaamaa?', en: 'Is now a good time to talk?' });
}

/**
 * No match within the budget. Voice-short, but the budget is said: it may come from the enquiry form, not from this
 * call (real call 2026-10-10: "அந்த budget-க்கு" when the customer had not mentioned one), and the option offered is
 * above it. "80 lakhs-க்குள்ள இல்லங்க. Porur Premium 1.2 crore இருக்கு. பாக்கலாமா?"
 */
export function noMatch(style: Style, loc: string | undefined, alt?: PresentedProperty, slots: Slots = {}): string {
  const where = loc ?? '';
  const budget = slots.budget ? formatRupeesShort(slots.budget) : '';
  const ta = budget ? `${budget}-க்குள்ள இல்லங்க.` : `${where}-ல இப்போ இல்லங்க.`;
  const tl = budget ? `${budget}-kulla illanga.` : `${where}-la ippo illanga.`;
  const en = budget ? `Nothing within ${budget} in ${where} right now.` : `Nothing in ${where} right now.`;
  if (alt) {
    return pick(style, {
      ta: `${ta} ${shortName(alt.name)} ${alt.priceText} இருக்கு. பாக்கலாமா?`,
      tl: `${tl} ${shortName(alt.name)} ${alt.priceText} irukku. Paakalaamaa?`,
      en: `${en} ${alt.name} is ${alt.priceText}. Would you like to see it?`,
    });
  }
  return pick(style, {
    ta: `${where}-ல ${budget ? `${budget}-க்குள்ள ` : ''}இப்போ இல்லங்க. Budget இல்ல area மாத்தலாமா?`,
    tl: `${where}-la ${budget ? `${budget}-kulla ` : ''}ippo illanga. Budget illa area maathalaamaa?`,
    en: `${en} Shall we adjust the budget or area?`,
  });
}

export function unknownArea(style: Style, wanted: string, areas: string[]): string {
  const list = areas.slice(0, 4).join(', ');
  return pick(style, {
    ta: `${wanted}-ல இப்போ நம்ம கிட்ட property இல்லங்க. ${list} - இதுல எது ஓகே?`,
    tl: `${wanted}-la ippo namma kitta property illanga. ${list} - idhula edhu okay?`,
    en: `We do not have anything in ${wanted} right now. We have ${list}. Which would you like?`,
  });
}

export function askWhichProperty(style: Style, props: PresentedProperty[]): string {
  const two = props.slice(0, 2).map((p) => shortName(p.name, props));
  return pick(style, {
    ta: `${two.join(' இல்ல ')} - எதை பாக்கணும்?`,
    tl: `${two.join(' illa ')} - edha paakanum?`,
    en: `Which one would you like to see? ${join(style, two)}?`,
  });
}

export function askVisitWhen(style: Style, missing: 'date' | 'time' | 'both' | 'ampm', ambiguousHour?: number): string {
  if (missing === 'time') return pick(style, { ta: 'எத்தனை மணிக்கு வர முடியும்?', tl: 'Ethana manikku vara mudiyum?', en: 'What time suits you?' });
  if (missing === 'date') return pick(style, { ta: 'எந்த நாள் வர முடியும்?', tl: 'Endha naal vara mudiyum?', en: 'Which day suits you?' });
  if (missing === 'ampm') {
    const h = ambiguousHour ?? 8;
    return pick(style, { ta: `${h} மணி காலைலயா, சாயங்காலமா?`, tl: `${h} mani kaalailaya, saayangaalamaa?`, en: `${h} in the morning or evening?` });
  }
  return pick(style, { ta: 'எந்த நாள், எத்தனை மணிக்கு வர முடியும்?', tl: 'Endha naal, ethana manikku vara mudiyum?', en: 'Which day and time suit you?' });
}

export function confirmQuestion(style: Style, propertyName: string, at: Date): string {
  const when = describeWhen(at, style);
  return pick(style, {
    ta: `${propertyName} site visit, ${when}. Confirm பண்ணட்டுமா?`,
    tl: `${propertyName} site visit, ${when}. Confirm pannattumaa?`,
    en: `Site visit at ${propertyName}, ${when}. Shall I confirm it?`,
  });
}

export function reAskConfirm(style: Style): string {
  return pick(style, { ta: 'Visit confirm பண்ணட்டுமா? ஆமா, இல்ல வேண்டாம்னு சொல்லுங்க.', tl: 'Visit-ah confirm pannattumaa? Aama, illa vendaam-nu sollunga.', en: 'Shall I confirm the visit? Please say yes or no.' });
}

/** Reply to our day-before confirmation message: the visit (already booked) is now confirmed. */
export function visitConfirmedByCustomer(style: Style, propertyName: string, at: Date, site?: { address?: string; mapUrl?: string }): string {
  const when = describeWhen(at, style);
  const where = [site?.address, site?.mapUrl].filter(Boolean).join('\n');
  const head = pick(style, {
    ta: `Thanks! ${propertyName} site visit, ${when} confirm ஆயிடுச்சு.`,
    tl: `Thanks! ${propertyName} site visit, ${when} confirm aayiduchu.`,
    en: `Thanks! Your visit to ${propertyName}, ${when}, is confirmed.`,
  });
  return where ? `${head}\n${where}` : head;
}

export function visitChangeAsk(style: Style, propertyName: string): string {
  return pick(style, {
    ta: `சரிங்க, problem இல்ல. ${propertyName} visit-க்கு எந்த நாள், எத்தனை மணிக்கு வர முடியும்?`,
    tl: `Saringa, problem illa. ${propertyName} visit-ku endha naal, ethana manikku vara mudiyum?`,
    en: `No problem. Which day and time would suit you for ${propertyName}?`,
  });
}

export function booked(style: Style, propertyName: string, at: Date): string {
  const when = describeWhen(at, style);
  return pick(style, {
    ta: `Done! ${propertyName} site visit, ${when}க்கு book பண்ணிட்டேன். Thank you!`,
    tl: `Done! ${propertyName} site visit, ${when}-ku book pannitten. Thank you!`,
    en: `Your site visit at ${propertyName} is booked for ${when}. Thank you!`,
  });
}

export function alreadyBooked(style: Style, propertyName: string, at: Date): string {
  const when = describeWhen(at, style);
  return pick(style, {
    ta: `${propertyName} site visit already ${when}க்கு book ஆயிடுச்சுங்க. Thank you!`,
    tl: `${propertyName} site visit already ${when}-ku book aayiduchu. Thank you!`,
    en: `Your site visit at ${propertyName} is already booked for ${when}. Thank you!`,
  });
}

export function declinedVisit(style: Style): string {
  return pick(style, {
    ta: 'சரிங்க, problem இல்ல. வேற நாள் இல்ல time வேணும்னா சொல்லுங்க.',
    tl: 'Saringa, problem illa. Vera naal illa time venumna sollunga.',
    en: 'No problem. Tell me if you would like a different day or time.',
  });
}

export function visitInvalid(style: Style, code: string): string {
  const m: Record<string, Record<Style, string>> = {
    past: { ta: 'அந்த time already போயிடுச்சுங்க. வேற நாள் சொல்லுங்க.', tl: 'Antha time already poiduchunga. Vera naal sollunga.', en: 'That time has already passed. Please give another day.' },
    too_soon: { ta: 'அது ரொம்ப சீக்கிரம்ங்க. கொஞ்சம் late-ஆ ஒரு time சொல்லுங்க.', tl: 'Adhu romba seekiram-nga. Konjam late-aa oru time sollunga.', en: 'We need a little more notice. Please give a later time.' },
    outside_hours: { ta: 'Visit காலைல 9 மணில இருந்து நைட் 8 மணி வரைக்கும் தான். அதுக்குள்ள ஒரு time சொல்லுங்க.', tl: 'Visit kaalaila 9-la irundhu night 8 mani varaikkum dhaan. Adhukkulla oru time sollunga.', en: 'Visits are between 9 AM and 8 PM. Please pick a time in that range.' },
    too_far: { ta: 'அடுத்த 60 நாளுக்குள்ள ஒரு நாள் சொல்லுங்க.', tl: 'Adutha 60 naalukkulla oru naal sollunga.', en: 'Please pick a day within the next 60 days.' },
    invalid: { ta: 'எந்த நாள், எத்தனை மணின்னு சொல்லுங்க.', tl: 'Endha naal, ethana mani-nu sollunga.', en: 'Please tell me the day and time.' },
    unavailable: { ta: 'அந்த property இப்போ available இல்லங்க. வேற ஒண்ணு பாக்கலாமா?', tl: 'Antha property ippo available illanga. Vera onnu paakalaamaa?', en: 'That property is not available right now. Shall I show another?' },
  };
  return (m[code] ?? m.invalid)[style];
}

export function bookingFailed(style: Style): string {
  return pick(style, {
    ta: 'Sorry, இப்போ book பண்ண முடியல. நம்ம team உங்களுக்கு call பண்ணுவாங்க. Thank you!',
    tl: 'Sorry, ippo book panna mudiyala. Namma team ungalukku call pannuvaanga. Thank you!',
    en: 'Sorry, I could not complete the booking. Our team will contact you. Thank you!',
  });
}

export function notInterested(style: Style, wrongNumber: boolean): string {
  if (wrongNumber) {
    return pick(style, {
      ta: 'ஓ, sorry, தப்பான number-க்கு call பண்ணிட்டேன். Thank you!',
      tl: 'Oh, sorry, thappana number-ku call pannitten. Thank you!',
      en: 'Sorry about that, I will not trouble you again. Thank you!',
    });
  }
  return pick(style, {
    ta: 'சரிங்க, புரியுது. Disturb பண்ணதுக்கு sorry. Thank you!',
    tl: 'Saringa, puriyudhu. Disturb pannadhukku sorry. Thank you!',
    en: 'Understood, sorry to bother you. Thank you!',
  });
}

export function handoff(style: Style): string {
  return pick(style, {
    ta: 'சரிங்க, நம்ம sales team உங்களுக்கு call பண்ணுவாங்க. Thank you!',
    tl: 'Saringa, namma sales team ungalukku call pannuvaanga. Thank you!',
    en: 'Sure, our sales team will call you. Thank you!',
  });
}

export function callback(style: Style, at?: Date): string {
  if (at) {
    const when = describeWhen(at, style);
    return pick(style, {
      ta: `சரிங்க, ${when}க்கு call பண்றேன். Thank you!`,
      tl: `Saringa, ${when}-ku call panren. Thank you!`,
      en: `Sure, I will call you on ${when}. Thank you!`,
    });
  }
  return pick(style, {
    ta: 'சரிங்க, அப்புறம் call பண்றேன். Thank you!',
    tl: 'Saringa, apram call panren. Thank you!',
    en: 'Sure, I will call you back later. Thank you!',
  });
}

export function goodbye(style: Style): string {
  return pick(style, { ta: 'சரிங்க, Thank you! Bye.', tl: 'Saringa, Thank you! Bye.', en: 'Thank you, have a great day!' });
}

export function unclear(style: Style): string {
  return pick(style, { ta: 'Sorry, சரியா கேக்கல. இன்னொரு தடவை சொல்லுங்களேன்?', tl: 'Sorry, sariya kekkala. Innoru thadava sollungalen?', en: 'Sorry, I did not catch that. Could you repeat?' });
}

/** The model must never claim an action; if it does, this replaces its sentence. */
export function noClaim(style: Style): string {
  return pick(style, { ta: 'எந்த நாள், எத்தனை மணிக்கு வர முடியும்?', tl: 'Endha naal, ethana manikku vara mudiyum?', en: 'Which day and time would suit you?' });
}

/** WhatsApp: one property per line (name - area - BHK - price), then one question. */
export function presentPropertyLines(style: Style, props: PresentedProperty[], max = 3): string {
  const lines = props.slice(0, max).map((p) => `${p.name} - ${p.location.split(',')[0]}${p.bhk ? ` - ${p.bhk} BHK` : ''} - ${p.priceText}`);
  const q = lines.length === 1
    ? pick(style, { ta: 'Site visit போய் பாக்கலாமா?', tl: 'Site visit poi paakalaamaa?', en: 'Would you like to visit it?' })
    : pick(style, { ta: 'எதை site visit போய் பாக்கலாம்?', tl: 'Edha site visit poi paakalam?', en: 'Which one would you like to visit?' });
  return `${lines.join('\n')}\n${q}`;
}

/** Speak the exact thing we are about to do when the model's own sentence claimed something unbacked. */
export function repeatOrAsk(style: Style, last?: string): string {
  return last && last.length > 2 ? last : unclear(style);
}

/**
 * Every voice line that contains no customer-specific data. These are synthesized once, cached on disk
 * and played instantly (no TTS call) on later calls. Returned for the two voice styles.
 */
export function staticVoiceLines(): string[] {
  const lines = new Set<string>();
  const slots: Array<SlotName | 'bhk'> = ['location', 'budget', 'bhk', 'timeline' as SlotName];
  for (const style of ['ta', 'en'] as Style[]) {
    for (let t = 0; t < ACKS[style].length; t++) {
      lines.add(ack(style, t));
      for (const slot of slots) lines.add(`${ack(style, t)} ${askSlot(style, slot)}`);
    }
    for (const slot of slots) lines.add(askSlot(style, slot));
    for (const missing of ['date', 'time', 'both'] as const) lines.add(askVisitWhen(style, missing));
    for (const code of ['past', 'too_soon', 'outside_hours', 'too_far', 'invalid', 'unavailable']) lines.add(visitInvalid(style, code));
    lines.add(reAskConfirm(style));
    lines.add(declinedVisit(style));
    lines.add(bookingFailed(style));
    lines.add(notInterested(style, false));
    lines.add(notInterested(style, true));
    lines.add(handoff(style));
    lines.add(callback(style));
    lines.add(goodbye(style));
    lines.add(unclear(style));
    lines.add(noClaim(style));
    for (const slot of slots) lines.add(askSlotAgain(style, slot));
    lines.add(anythingElse(style));
    lines.add(whenToCall(style));
    lines.add(startOver(style));
  }
  return [...lines];
}

// ---------------------------------------------------------------------------------------------
// Second wordings, used instead of repeating the exact previous sentence (no repeated answers).
// ---------------------------------------------------------------------------------------------

/** The same slot question in other words. */
export function askSlotAgain(style: Style, slot: SlotName | 'bhk'): string {
  switch (slot) {
    case 'location':
      return pick(style, { ta: 'எந்த area பக்கம் வீடு பாக்குறீங்க?', tl: 'Endha area pakkam veedu paakureenga?', en: 'Which locality would you prefer?' });
    case 'budget':
      return pick(style, { ta: 'Budget சுமாரா எவ்ளோ வெச்சிருக்கீங்க?', tl: 'Budget sumaara evlo vechirukeenga?', en: 'Roughly how much is your budget?' });
    case 'bhk':
    case 'propertyType':
      return pick(style, { ta: '1, 2 இல்ல 3 BHK - எது வேணும்?', tl: '1, 2 illa 3 BHK - edhu venum?', en: 'Is it 1, 2 or 3 BHK?' });
    default:
      return pick(style, { ta: 'வீடு எப்போ வாங்குற மாதிரி இருக்கீங்க?', tl: 'Veedu eppo vaangura maadhiri irukeenga?', en: 'When do you plan to buy?' });
  }
}

export function anythingElse(style: Style): string {
  return pick(style, { ta: 'சரிங்க. வேற ஏதாவது தெரிஞ்சுக்கணுமா?', tl: 'Saringa. Vera edhavadhu therinjukkanumaa?', en: 'Alright. Is there anything else you would like to know?' });
}

/** After options were read out: move forward instead of reading them again. */
export function nextStepAfterOptions(style: Style, propertyName: string): string {
  return pick(style, {
    ta: `${propertyName} போய் பாக்க ஒரு நாள் fix பண்ணலாமா, இல்ல வேற area பாக்கலாமா?`,
    tl: `${propertyName} poi paakka oru naal fix pannalaamaa, illa vera area paakalaamaa?`,
    en: `Shall we fix a day to see ${propertyName}, or should I check another area?`,
  });
}

/** Confirmation question, shorter second wording (still the system's own explicit question). */
export function confirmQuestionShort(style: Style, propertyName: string, at: Date): string {
  const when = describeWhen(at, style);
  return pick(style, {
    ta: `${when}, ${propertyName}. Book பண்ணிடட்டுமா?`,
    tl: `${when}, ${propertyName}. Book pannattumaa?`,
    en: `${propertyName}, ${when}. Should I book it?`,
  });
}

/** The customer picked one of the options we read out: ask for the day and time. */
export function pickedProperty(style: Style, propertyName: string): string {
  return pick(style, {
    ta: `சரிங்க, ${propertyName}. Site visit-க்கு எந்த நாள், எத்தனை மணிக்கு வர முடியும்?`,
    tl: `Saringa, ${propertyName}. Site visit-ku endha naal, ethana manikku vara mudiyum?`,
    en: `Sure, ${propertyName}. Which day and time suit you for a site visit?`,
  });
}

/** Price from verified inventory only. */
export function priceOf(style: Style, p: PresentedProperty): string {
  const what = [p.bhk ? `${p.bhk} BHK` : p.type, p.priceText].filter(Boolean).join(', ');
  return pick(style, {
    ta: `${shortName(p.name)} ${areaOf(p)}-ல இருக்கு, ${what}.`,
    tl: `${p.name} ${p.location}-la irukku, ${what}.`,
    en: `${p.name} in ${p.location} is ${what}.`,
  });
}

/** "No" when we asked if they can talk now: ask when to call instead of treating it as "not interested". */
export function whenToCall(style: Style): string {
  return pick(style, { ta: 'சரிங்க, problem இல்ல. எப்போ call பண்ணா ஓகே?', tl: 'Saringa, problem illa. Eppo call panna okay?', en: 'No problem. When would be a good time to call you?' });
}

/** The customer repeated a requirement we already have: confirm it and move forward. */
export function stillLooking(style: Style, slots: Slots, first?: PresentedProperty): string {
  const parts = [slots.location, slots.bhk ? `${slots.bhk} BHK` : slots.propertyType, slots.budget ? formatRupeesShort(slots.budget) : ''].filter(Boolean).join(', ');
  if (first) {
    return pick(style, {
      ta: `சரிங்க, ${parts}. ${first.name} பாக்கலாமா, இல்ல வேற area check பண்ணட்டுமா?`,
      tl: `Saringa, ${parts}. ${first.name} paakalaamaa, illa vera area check pannattumaa?`,
      en: `Got it, ${parts}. Would you like to see ${first.name}, or should I check another area?`,
    });
  }
  return pick(style, { ta: `சரிங்க, ${parts}. வேற area இல்ல budget-ல பாக்கலாமா?`, tl: `Saringa, ${parts}. Vera area illa budget-la paakalaamaa?`, en: `Got it, ${parts}. Shall I check another area or budget?` });
}

// ---------------------------------------------------------------------------------------------
// Area changes and turned-down properties
// ---------------------------------------------------------------------------------------------

/** "Porur வேண்டாம்" is understood; prefixed to the search result for the new area. */
export function areaDropped(style: Style, from: string): string {
  return pick(style, { ta: `சரிங்க, ${from} வேண்டாம்.`, tl: `Saringa, ${from} vendaam.`, en: `Sure, not ${from}.` });
}

/** New area taken, but we still need another detail before searching. */
export function areaSwitched(style: Style, from: string | undefined, to: string): string {
  return pick(style, {
    ta: from ? `சரிங்க, ${from} வேண்டாம், ${to}-ல பாக்கலாம்.` : `சரிங்க, ${to}-ல பாக்கலாம்.`,
    tl: from ? `Saringa, ${from} vendaam, ${to}-la paakalam.` : `Saringa, ${to}-la paakalam.`,
    en: from ? `Sure, ${to} instead of ${from}.` : `Sure, ${to}.`,
  });
}

/** Area turned down / "vera area" with nothing named yet: offer the areas we really have. */
export function askOtherArea(style: Style, from: string | undefined, options: string[]): string {
  const list = options.join(', ');
  const head = pick(style, { ta: from ? `சரிங்க, ${from} வேண்டாம்.` : 'சரிங்க.', tl: from ? `Saringa, ${from} vendaam.` : 'Saringa.', en: from ? `Sure, not ${from}.` : 'Sure.' });
  const ask = options.length
    ? pick(style, { ta: `${list} - இதுல எந்த area பாக்கலாம்?`, tl: `${list} - idhula endha area paakalam?`, en: `We have ${list}. Which area would you like?` })
    : pick(style, { ta: 'எந்த area பாக்கலாம்?', tl: 'Endha area paakalam?', en: 'Which area would you like?' });
  return `${head} ${ask}`;
}

/** "அது வேண்டாம்": the next real option, or ask about another area / budget. */
export function propertyDeclined(style: Style, next?: PresentedProperty): string {
  if (next) {
    return pick(style, {
      ta: `சரிங்க, அது வேண்டாம். ${next.name}, ${next.priceText} இருக்கு. அதை பாக்கலாமா?`,
      tl: `Saringa, adhu vendaam. ${next.name}, ${next.priceText} irukku. Adha paakalaamaa?`,
      en: `Sure, not that one. There is ${next.name} at ${next.priceText}. Would you like to see it?`,
    });
  }
  return pick(style, {
    ta: 'சரிங்க. இப்போதைக்கு வேற option இல்லங்க. வேற area இல்ல budget பாக்கலாமா?',
    tl: 'Saringa. Ippodhaikku vera option illanga. Vera area illa budget paakalaamaa?',
    en: 'Okay. I have no other option there right now. Shall I check another area or budget?',
  });
}

/** Property chosen: ask only for the part of the visit time that is still missing. */
export function pickedAsk(style: Style, propertyName: string, missing: 'date' | 'time' | 'both' | 'ampm', ambiguousHour?: number): string {
  if (missing === 'both') return pickedProperty(style, propertyName);
  const head = pick(style, { ta: `சரிங்க, ${propertyName}.`, tl: `Saringa, ${propertyName}.`, en: `Sure, ${propertyName}.` });
  return `${head} ${askVisitWhen(style, missing, ambiguousHour)}`;
}

/** "நாளைக்கு" / "tomorrow" / "18 October" for a day the customer gave (IST). */
export function dayLabel(style: Style, date: NonNullable<WhenDraft['date']>, now: Date = new Date()): string {
  const today = istParts(now);
  const t = Date.UTC(date.year, date.month - 1, date.day);
  const diff = Math.round((t - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
  if (diff === 0) return pick(style, { ta: 'இன்னைக்கு', tl: 'innaikku', en: 'today' });
  if (diff === 1) return pick(style, { ta: 'நாளைக்கு', tl: 'naalaikku', en: 'tomorrow' });
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][date.month - 1];
  return `${date.day} ${month}`;
}

/** Day understood, property not chosen yet: acknowledge the day, ask which one (never a "which day?" again). */
export function whichPropertyForDay(style: Style, props: PresentedProperty[], day: string): string {
  const two = props.slice(0, 2).map((p) => shortName(p.name, props));
  return pick(style, {
    ta: `சரிங்க, ${day} எதை பாக்கணும் - ${two.join(' இல்ல ')}?`,
    tl: `Saringa, ${day} edha paakanum - ${two.join(' illa ')}?`,
    en: `Sure, which one would you like to see ${day} - ${two.join(' or ')}?`,
  });
}

/** Second wording of "which property?" */
export function askWhichPropertyAgain(style: Style, props: PresentedProperty[]): string {
  const [a, b] = props.slice(0, 2).map((p) => shortName(p.name, props));
  return pick(style, { ta: `${a}-ஆ, ${b}-ஆ?`, tl: `${a}-aa, ${b}-aa?`, en: `${a}, or ${b}?` });
}

/** The staff handoff could not be recorded: never promise a call we could not record (from Phase 3 audit fixes). */
export function handoffFailed(style: Style): string {
  return pick(style, {
    ta: 'Sorry, ஒரு technical problem-னால உங்க request-ஐ இப்போ save பண்ண முடியல. கொஞ்ச நேரம் கழிச்சு திரும்ப சொல்லுங்க.',
    tl: 'Sorry, oru technical problem-naala unga request-ah ippo save panna mudiyala. Konja neram kazhichu thirumba sollunga.',
    en: 'Sorry, I could not record your request because of a technical problem. Please try again in a few minutes.',
  });
}
