/**
 * What the textile assistant says. Every price, stock level and specification comes from the catalogue row passed
 * in; when a price is not approved the reply says a salesperson will confirm it - never a guessed number.
 */
import { formatInr } from './textile-rules.js';

type Style = 'ta' | 'tl' | 'en';
const pick = (style: Style, v: Record<Style, string>) => v[style];

export type CatalogueRow = {
  id: string; name: string; sku: string; fabricCategory: string; composition?: string | null; gsm?: number | null; width?: string | null;
  colour?: string | null; moq?: number | null; priceUnit: string; currency: string; price?: unknown; priceApproved: boolean; stockStatus: string;
  catalogueUrl?: string | null; imageUrls?: unknown;
};

const unitLabel = (u: string, style: Style) => (style === 'en' ? u : u === 'metre' ? 'மீட்டர்' : u);

function priceText(p: CatalogueRow, style: Style): string {
  if (p.priceApproved && p.price !== null && p.price !== undefined) return `${formatInr(Number(p.price), p.currency)}/${unitLabel(p.priceUnit, style)}`;
  return pick(style, { en: 'price on request', ta: 'விலை team confirm பண்ணுவாங்க', tl: 'rate team confirm pannuvaanga' });
}

function stockText(p: CatalogueRow, style: Style): string {
  const m: Record<string, Record<Style, string>> = {
    in_stock: { en: 'in stock', ta: 'stock இருக்கு', tl: 'stock irukku' },
    low: { en: 'limited stock', ta: 'stock கம்மியா இருக்கு', tl: 'stock kammiya irukku' },
    out_of_stock: { en: 'out of stock now', ta: 'இப்போ stock இல்ல', tl: 'ippo stock illa' },
  };
  return m[p.stockStatus] ? pick(style, m[p.stockStatus]) : '';
}

function specs(p: CatalogueRow): string {
  return [p.composition, p.gsm ? `${p.gsm} GSM` : '', p.width ? `${p.width} width` : '', p.colour].filter(Boolean).join(', ');
}

export function askWhat(style: Style): string {
  return pick(style, {
    en: 'Which fabric or product are you looking for? For example cotton, silk sarees or shirting.',
    ta: 'எந்த fabric இல்ல product வேணும்? உதாரணமா cotton, silk saree, shirting.',
    tl: 'Endha fabric illa product venum? Example: cotton, silk saree, shirting.',
  });
}

export function askQuantity(style: Style, what: string): string {
  return pick(style, {
    en: `How much ${what} do you need (metres or pieces)?`,
    ta: `${what} எவ்வளவு வேணும் (மீட்டர் இல்ல pieces)?`,
    tl: `${what} evlo venum (metres illa pieces)?`,
  });
}

/**
 * Matching catalogue items. Chat: up to 2, ONE line each (name, SKU, price, specs, stock, MOQ) + one question - chat
 * replies are capped at 3 lines (shapeChatReply), so a header or a second line per item would cut the question off.
 * Voice: up to 2, name and price only.
 */
export function presentMatches(style: Style, rows: CatalogueRow[], voice: boolean, quantityKnown: boolean): string {
  const shown = rows.slice(0, 2);
  const lines = shown.map((p) => {
    if (voice) return `${p.name}, ${priceText(p, style)}`;
    const extra = [specs(p), stockText(p, style), p.moq ? `MOQ ${p.moq} ${p.priceUnit}` : ''].filter(Boolean).join(' · ');
    return `${p.name} (${p.sku}) - ${priceText(p, style)}${extra ? ` · ${extra}` : ''}`;
  });
  const ask = quantityKnown
    ? pick(style, { en: 'Shall I ask our team to prepare a quotation?', ta: 'Quotation ready பண்ண சொல்லட்டுமா?', tl: 'Quotation ready panna sollattumaa?' })
    : pick(style, { en: 'How much do you need?', ta: 'எவ்வளவு வேணும்?', tl: 'Evlo venum?' });
  if (voice) return `${lines.join('; ')}. ${ask}`;
  return `${lines.join('\n')}\n${ask}`;
}

export function notInCatalogue(style: Style, what: string, taskRecorded: boolean): string {
  return taskRecorded
    ? pick(style, {
        en: `${what} is not in our catalogue right now. I have asked a salesperson to check and get back to you.`,
        ta: `${what} இப்போ நம்ம catalogue-ல இல்லங்க. ஒரு salesperson check பண்ணி சொல்லுவாங்க.`,
        tl: `${what} ippo namma catalogue-la illanga. Oru salesperson check panni solluvaanga.`,
      })
    : pick(style, {
        en: `${what} is not in our catalogue right now. Could you tell me another fabric you would consider?`,
        ta: `${what} இப்போ நம்ம catalogue-ல இல்லங்க. வேற எந்த fabric ஓகே?`,
        tl: `${what} ippo namma catalogue-la illanga. Vera endha fabric okay?`,
      });
}

/** Catalogue links (approved images / PDF from the catalogue rows) - chat only. */
export function catalogueLinks(style: Style, rows: CatalogueRow[]): string | undefined {
  const links: string[] = [];
  for (const p of rows.slice(0, 3)) {
    const imgs = Array.isArray(p.imageUrls) ? (p.imageUrls as string[]).slice(0, 2) : [];
    if (p.catalogueUrl) links.push(`${p.name}: ${p.catalogueUrl}`);
    for (const u of imgs) links.push(`${p.name} photo: ${u}`);
  }
  if (!links.length) return undefined;
  return `${pick(style, { en: 'Here are the details:', ta: 'இதோ details:', tl: 'Idho details:' })}\n${links.join('\n')}`;
}

export function catalogueByTeam(style: Style): string {
  return pick(style, {
    en: 'I have asked our team to send you the catalogue and photos here shortly.',
    ta: 'Catalogue, photos இங்கயே அனுப்ப நம்ம team-கிட்ட சொல்லிட்டேன்.',
    tl: 'Catalogue, photos ingaye anuppa namma team-kitta sollitten.',
  });
}

export function confirmQuoteRequest(style: Style, summary: string): string {
  return pick(style, {
    en: `Shall I ask our team for a quotation for ${summary}?`,
    ta: `${summary} - இதுக்கு quotation கேக்கட்டுமா?`,
    tl: `${summary} - idhukku quotation kekkattumaa?`,
  });
}

export function quoteRequested(style: Style, number: string): string {
  return pick(style, {
    en: `Done. Quotation request ${number} is with our team; they will check stock and price and send the final quotation here.`,
    ta: `சரி. Quotation request ${number} நம்ம team-கிட்ட போயிடுச்சு; stock, விலை check பண்ணி final quotation இங்க அனுப்புவாங்க.`,
    tl: `Sari. Quotation request ${number} namma team-kitta poiduchu; stock, rate check panni final quotation inga anuppuvaanga.`,
  });
}

export function salespersonWillHelp(style: Style, recorded: boolean): string {
  if (!recorded) {
    return pick(style, {
      en: 'Sorry, I could not pass this to our team because of a technical problem. Please try again in a few minutes.',
      ta: 'Sorry, ஒரு technical problem-னால இதை team-க்கு அனுப்ப முடியல. கொஞ்ச நேரம் கழிச்சு திரும்ப சொல்லுங்க.',
      tl: 'Sorry, oru technical problem-naala idhai team-ku anuppa mudiyala. Konja neram kazhichu thirumba sollunga.',
    });
  }
  return pick(style, {
    en: 'Our salesperson handles that personally. I have asked them to contact you.',
    ta: 'அதை நம்ம salesperson தான் பாத்துப்பாங்க. உங்களை contact பண்ண சொல்லிட்டேன்.',
    tl: 'Adhai namma salesperson dhaan paathuppaanga. Ungalai contact panna sollitten.',
  });
}

export function confirmAcceptQuote(style: Style, number: string, total: string): string {
  return pick(style, {
    en: `Confirm quotation ${number}, total ${total}?`,
    ta: `Quotation ${number}, மொத்தம் ${total} - confirm பண்ணட்டுமா?`,
    tl: `Quotation ${number}, total ${total} - confirm pannattumaa?`,
  });
}

export function quoteAccepted(style: Style, number: string): string {
  return pick(style, {
    en: `Thank you! Quotation ${number} is confirmed. Our team will create the order and update you on dispatch.`,
    ta: `நன்றி! Quotation ${number} confirm ஆயிடுச்சு. Team order create பண்ணி dispatch update சொல்லுவாங்க.`,
    tl: `Nandri! Quotation ${number} confirm aayiduchu. Team order create panni dispatch update solluvaanga.`,
  });
}

export function feedbackThanks(style: Style, negative: boolean): string {
  return negative
    ? pick(style, {
        en: 'Sorry it was not good. I have asked our team to call you and sort it out.',
        ta: 'Sorry, சரியா இல்லாம போச்சு. நம்ம team உங்களுக்கு call பண்ணி சரி பண்ணுவாங்க.',
        tl: 'Sorry, sariya illaama pochu. Namma team ungalukku call panni sari pannuvaanga.',
      })
    : pick(style, { en: 'Thank you for the feedback!', ta: 'Feedback-க்கு நன்றி!', tl: 'Feedback-ku nandri!' });
}

export function textileWelcome(style: Style, name: string | undefined): string {
  const n = (name ?? '').split(/\s+/)[0];
  return pick(style, {
    en: `Hi${n ? ` ${n}` : ''}! Which fabric or product are you looking for?`,
    ta: `வணக்கம்${n ? ` ${n}` : ''}! எந்த fabric இல்ல product வேணும்?`,
    tl: `Vanakkam${n ? ` ${n}` : ''}! Endha fabric illa product venum?`,
  });
}
