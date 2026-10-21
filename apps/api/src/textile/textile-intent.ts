/**
 * Deterministic understanding of textile enquiries (English / Tamil / Tanglish). No model: what the customer said is
 * matched against fixed vocabularies and the business's own catalogue.
 */

export type TextileFacts = {
  fabric?: string;
  product?: string;
  colour?: string;
  quantity?: number;
  unit?: string;
  targetPrice?: number;
  destination?: string;
  buyerType?: string;
};

const FABRICS: Array<[string, RegExp]> = [
  ['cotton', /\b(cotton|kaatan|katan)\b|காட்டன்|பருத்தி/iu],
  ['silk', /\b(silk|pattu)\b|சில்க்|பட்டு/iu],
  ['polyester', /\b(polyester|poly)\b|பாலியஸ்டர்/iu],
  ['rayon', /\brayon\b|ரேயான்/iu],
  ['linen', /\b(linen|lenin)\b|லினன்/iu],
  ['georgette', /\bgeorgette\b|ஜார்ஜெட்/iu],
  ['chiffon', /\bchiffon\b|ஷிஃபான்/iu],
  ['crepe', /\bcrepe\b/iu],
  ['denim', /\bdenim\b|டெனிம்/iu],
  ['khadi', /\bkhadi\b|காதி/iu],
  ['viscose', /\bviscose\b/iu],
  ['satin', /\bsatin\b|சாட்டின்/iu],
  ['velvet', /\bvelvet\b/iu],
  ['lycra', /\b(lycra|spandex)\b/iu],
  ['organza', /\borganza\b/iu],
  ['net', /\bnet\s*(fabric|cloth)?\b/iu],
  ['jacquard', /\bjacquard\b/iu],
  ['muslin', /\bmuslin\b/iu],
];

const PRODUCTS: Array<[string, RegExp]> = [
  ['saree', /\b(sarees?|sari|saris)\b|புடவை|சேலை|சாரி/iu],
  ['dress material', /\b(dress\s*materials?|chudi(dar)?|churidar|salwar)\b|சுடிதார்/iu],
  ['shirting', /\bshirting\b|\bshirt\s*(fabric|cloth|material)/iu],
  ['suiting', /\bsuiting\b/iu],
  ['kurti', /\bkurtis?\b/iu],
  ['dhoti', /\b(dhotis?|veshtis?|vesti)\b|வேட்டி/iu],
  ['towel', /\btowels?\b|துண்டு/iu],
  ['bedsheet', /\bbed\s*sheets?\b/iu],
  ['fabric', /\b(fabric|cloth|material|rolls?|thaan)\b|துணி/iu],
];

const COLOURS: Array<[string, RegExp]> = [
  ['red', /\bred\b|சிவப்பு/iu], ['maroon', /\bmaroon\b/iu], ['blue', /\bblue\b|நீலம்|நீல/iu], ['navy', /\bnavy\b/iu],
  ['green', /\bgreen\b|பச்சை/iu], ['yellow', /\byellow\b|மஞ்சள்/iu], ['white', /\bwhite\b|வெள்ளை/iu], ['black', /\bblack\b|கருப்பு/iu],
  ['pink', /\bpink\b/iu], ['cream', /\bcream\b/iu], ['beige', /\bbeige\b/iu], ['gold', /\bgold(en)?\b/iu], ['orange', /\borange\b/iu],
  ['purple', /\bpurple\b/iu], ['grey', /\b(grey|gray)\b/iu],
];

const UNIT_WORDS: Array<[string, RegExp]> = [
  ['metre', /^(m|mtr|mtrs|metre|metres|meter|meters|மீட்டர்)$/iu],
  ['piece', /^(pc|pcs|piece|pieces|nos|no|numbers|பீஸ்)$/iu],
  ['kg', /^(kg|kgs|kilo|kilos|கிலோ)$/iu],
  ['roll', /^(roll|rolls|thaan|than)$/iu],
  ['set', /^(set|sets)$/iu],
  ['piece', /^(sarees?|saris?|kurtis?|towels?|dhotis?)$/iu],
];

export function extractTextileFacts(text: string): TextileFacts {
  const t = (text ?? '').replace(/,(?=\d{3})/g, '');
  const f: TextileFacts = {};
  for (const [name, re] of FABRICS) if (re.test(t)) { f.fabric = name; break; }
  for (const [name, re] of PRODUCTS) if (re.test(t)) { f.product = name; break; }
  for (const [name, re] of COLOURS) if (re.test(t)) { f.colour = name; break; }

  // Price first ("₹250 per metre", "250/m", "rate 300"), so its number is not read as a quantity.
  const price = t.match(/(?:₹|rs\.?|inr|rate|price|budget|target)\s*:?\s*(\d+(?:\.\d+)?)(?:\s*(?:\/|per)\s*(\w+))?/i) ?? t.match(/(\d+(?:\.\d+)?)\s*(?:\/|per)\s*(m|mtr|metre|meter|pc|piece|kg)\b/i);
  let priceSpan = '';
  if (price) {
    f.targetPrice = Number(price[1]);
    priceSpan = price[0];
  }
  const rest = priceSpan ? t.replace(priceSpan, ' ') : t;
  const q = rest.match(/(\d+(?:\.\d+)?)\s*(k|thousand|ஆயிரம்)?\s*([a-zA-Z஀-௿]+)?/g) ?? [];
  for (const m of q) {
    const parts = m.match(/(\d+(?:\.\d+)?)\s*(k|thousand|ஆயிரம்)?\s*([a-zA-Z஀-௿]+)?/);
    if (!parts) continue;
    const unitWord = parts[3] ?? '';
    const unit = UNIT_WORDS.find(([, re]) => re.test(unitWord))?.[0];
    if (!unit) continue;
    let n = Number(parts[1]);
    if (parts[2]) n *= 1000;
    if (n > 0 && n < 10_000_000) {
      f.quantity = n;
      f.unit = unit;
      break;
    }
  }
  const dest = t.match(/\b(?:deliver(?:y)?\s+(?:to|at)|ship(?:ping)?\s+to|send\s+(?:it\s+)?to|to)\s+([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})?)/) ?? t.match(/([A-Za-z஀-௿]{3,})-?க்கு\s*(?:delivery|டெலிவரி|அனுப்ப)/u);
  if (dest && !/^(the|you|me|us|whatsapp)$/i.test(dest[1])) f.destination = dest[1];
  const buyer = t.match(/\b(wholesal(?:e|er)s?|retail(?:er)?s?|boutiques?|exporters?|export|garment\s*(?:manufacturer|unit|factory)s?)\b/i);
  if (buyer) f.buyerType = /wholesal/i.test(buyer[1]) ? 'wholesaler' : /retail/i.test(buyer[1]) ? 'retailer' : /boutique/i.test(buyer[1]) ? 'boutique' : /export/i.test(buyer[1]) ? 'exporter' : 'garment_manufacturer';
  return f;
}

export const wantsCatalogue = (t: string) => /(catalog(?:ue)?|photos?|pics?|pictures?|images?|designs?|collection|samples?\s*photos?|pdf|show\s+me|kaatunga|anuppunga|காட்டுங்க|அனுப்புங்க|போட்டோ|டிசைன்)/iu.test(t ?? '');
export const asksPrice = (t: string) => /(price|rate|cost|how\s+much|evlo|evvalavu|விலை|ரேட்|எவ்ளோ|எவ்வளவு)/iu.test(t ?? '');
export const wantsQuotation = (t: string) => /(quot(?:e|ation)|final\s+(?:rate|price)|best\s+(?:rate|price)|send\s+(?:the\s+)?(?:rate|price)|kotation|கொட்டேஷன்|quotation\s+venum)/iu.test(t ?? '');
/** Needs a person: bulk discount, credit, custom production, samples by courier, returns. */
export const needsSalesperson = (t: string) =>
  /(discount|less\s+(?:price|rate)|reduce|negotiat|credit|credit\s+days|payment\s+terms|custom(?:ise|ize|ized)?|own\s+design|our\s+design|print\s+(?:our|my)|private\s+label|sample\s+courier|send\s+samples?|return|refund|exchange|கம்மி|குறைச்சு|தள்ளுபடி|கடன்)/iu.test(t ?? '');
export const confirmsOrder = (t: string) => /\b(confirm(?:ed)?|go\s+ahead|place\s+(?:the\s+)?order|order\s+(?:it|now|panrom|pannunga)|ok\s+order|finalise|finalize)\b|ஆர்டர்\s*பண்ணுங்க|கன்ஃபார்ம்/iu.test(t ?? '');
