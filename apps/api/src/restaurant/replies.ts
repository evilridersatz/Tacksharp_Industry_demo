/**
 * Everything GR Chicken's assistant says, in three styles:
 *   tl = Tanglish (Tamil in English letters, how most customers type on WhatsApp)
 *   ta = Tamil script
 *   en = English
 * Product and cut names stay as the shop writes them ("Broiler Chicken", "Curry cut").
 * Amounts are always passed in, never written here.
 */
import { describeWhen, spokenWhen } from '../conversation/when.js';
import { formatQty } from './chicken-parse.js';
import { stockText } from './inventory.js';

/** A product as replies need it: catalogue price and, when tracked, stock on hand. */
export type StockLine = { name: string; price: number; unit: string; stockQty: number | null; stockIsDemo: boolean };

export type Style = 'tl' | 'ta' | 'en';

const rs = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
const pick = (s: Style, v: Record<Style, string>) => v[s];

export type SummaryLine = { name: string; quantity: number; unit: string; cut: string | null; lineTotal: number; unitPrice: number };

export const say = {
  /** Offer welcome. The cut question and the example come from the catalogue (`hint`), never a fixed product list. */
  offerGreeting: (s: Style, p: { name?: string; business: string; amount: number; menu: string; hint?: OrderHint }) => {
    const h = p.hint ?? NO_HINT;
    const steps = [
      pick(s, { tl: 'Enna venum?', ta: 'என்ன வேணும்?', en: 'Which product?' }),
      pick(s, { tl: 'Ethana kg / ethana piece?', ta: 'எத்தனை கிலோ / எத்தனை?', en: 'How much (kg or pieces)?' }),
      ...(h.cuts.length ? [pick(s, { tl: `Eppadi cut pannanum? (${h.cuts.join(' / ')})`, ta: `எப்படி cut பண்ணணும்? (${h.cuts.join(' / ')})`, en: `Which cut? (${h.cuts.join(' / ')})` })] : []),
      pick(s, { tl: 'Payment eppadi? (cash / UPI / already online-la paid)', ta: 'Payment எப்படி? (cash / UPI / ஏற்கனவே online-ல paid)', en: 'Payment? (cash / UPI / already paid online)' }),
      pick(s, { tl: 'Eppo vandhu collect pannuveenga?', ta: 'எப்போ வந்து collect பண்ணுவீங்க?', en: 'When will you come to collect?' }),
    ].map((t, n) => `${n + 1}. ${t}`);
    const example = h.example
      ? pick(s, { tl: `Ellam ore message-la kooda sollalaam, e.g. "${h.example}, GPay, saayangaalam 6 mani".`, ta: `எல்லாம் ஒரே message-ல கூட சொல்லலாம், e.g. "${h.example}, GPay, சாயங்காலம் 6 மணி".`, en: `You can send it all in one message, e.g. "${h.example}, GPay, 6 pm today".` })
      : '';
    return [
      pick(s, {
        tl: `Vanakkam${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business} vaangiyatharku romba nandri.\nUngalukku *${rs(p.amount)} offer* irukku 🎉\n\nOffer claim panna munnadi konjam sollunga:`,
        ta: `வணக்கம்${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business}-ல வாங்கியதற்கு ரொம்ப நன்றி.\nஉங்களுக்கு *${rs(p.amount)} offer* இருக்கு 🎉\n\nOffer claim பண்றதுக்கு முன்னாடி கொஞ்சம் சொல்லுங்க:`,
        en: `Hello${p.name ? ` ${p.name}` : ''}! 🙏 Thank you for buying from ${p.business}.\nYou have a *${rs(p.amount)} offer* 🎉\n\nTo claim it, please tell me:`,
      }),
      steps.join('\n'),
      example,
      p.menu,
    ].filter(Boolean).join('\n\n');
  },

  plainGreeting: (s: Style, p: { name?: string; business: string; menu: string; hint?: OrderHint }) => {
    const cut = (p.hint ?? NO_HINT).cuts.length;
    return pick(s, {
      tl: `Vanakkam${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business}. Enna venum, ethana kg${cut ? ', eppadi cut' : ''}, payment eppadi, eppo collect pannuveenga nu sollunga, naan order ready pannidren.\n\n${p.menu}`,
      ta: `வணக்கம்${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business}. என்ன வேணும், எத்தனை கிலோ${cut ? ', எப்படி cut' : ''}, payment எப்படி, எப்போ collect பண்ணுவீங்கன்னு சொல்லுங்க, நான் order ready பண்ணிடுறேன்.\n\n${p.menu}`,
      en: `Hello${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business}. Tell me what you'd like, how much${cut ? ', which cut' : ''}, how you'll pay and when you'll collect, and I'll get your order ready.\n\n${p.menu}`,
    }).trim();
  },

  offerAlreadyUsed: (s: Style) =>
    pick(s, {
      tl: 'Ungaloda offer already use panniteenga 🙏 Aanaa normal-ah order pannalaam.',
      ta: 'உங்க offer ஏற்கனவே use பண்ணிட்டீங்க 🙏 ஆனா normal-ஆ order பண்ணலாம்.',
      en: 'Your offer has already been used 🙏 You can still place a normal order.',
    }),

  menuTitle: (s: Style) => pick(s, { tl: '*Inniku rate* (per kg):', ta: '*இன்னைக்கு rate* (கிலோவுக்கு):', en: "*Today's prices* (per kg):" }),
  demoNote: (s: Style) => pick(s, { tl: '(Demo rate — sample prices)', ta: '(Demo rate — மாதிரி விலை)', en: '(Demo prices — sample data)' }),

  /** An amount was said without a product: ask which, from what can be sold now. */
  whichProductFor: (s: Style, amount: string, names: string[]) =>
    names.length
      ? pick(s, { tl: `${amount} — edhu venum? ${names.join(' / ')}`, ta: `${amount} — எது வேணும்? ${names.join(' / ')}`, en: `${amount} of which one? ${names.join(' / ')}` })
      : say.nothingToday(s),
  /** "Ethana manikku varanum?": the shop's hours and the earliest time this order can be ready, then one question. */
  whenToCome: (s: Style, shop: string, hours: string, earliest: string) =>
    pick(s, {
      tl: `${shop} ${hours} open. Ungal order ${earliest}-la irundhu ready-ah irukkum. Eppo varuveenga? (Seekiram-na "seekiram" nu sollunga)`,
      ta: `${shop} ${hours} திறந்திருக்கும். உங்க order ${earliest}-ல இருந்து ready-ஆ இருக்கும். எப்போ வருவீங்க? (சீக்கிரம்னா "சீக்கிரம்"-னு சொல்லுங்க)`,
      en: `${shop} is open ${hours}. Your order can be ready from ${earliest}. What time will you come? (Say "as soon as possible" for the earliest.)`,
    }),
  /** "Pickup-ku varren" without a time: one focused question, with the earliest-time option. */
  askPickupTimeOnly: (s: Style, earliest: string) =>
    pick(s, {
      tl: `Sari 👍 Ethana manikku varuveenga? ${earliest}-la irundhu ready. Seekiram-na "seekiram" nu sollunga.`,
      ta: `சரி 👍 எத்தனை மணிக்கு வருவீங்க? ${earliest}-ல இருந்து ready. சீக்கிரம்னா "சீக்கிரம்"-னு சொல்லுங்க.`,
      en: `Sure 👍 What time will you come? It can be ready from ${earliest}; say "as soon as possible" for that.`,
    }),
  whichToRemove: (s: Style, names: string[]) =>
    pick(s, { tl: `Edhu eduthudanum? ${names.join(' / ')}`, ta: `எதை எடுக்கணும்? ${names.join(' / ')}`, en: `Which one should I remove? ${names.join(' / ')}` }),
  cartEmpty: (s: Style) => pick(s, { tl: 'Ungal cart-la ippo edhuvum illa.', ta: 'உங்க cart-ல இப்போ எதுவும் இல்ல.', en: 'Your cart is empty right now.' }),
  askProduct: (s: Style) => pick(s, { tl: 'Enna chicken venum?', ta: 'என்ன chicken வேணும்?', en: 'Which chicken would you like?' }),
  askQty: (s: Style, product: string, unit: string) =>
    unit === 'piece'
      ? pick(s, { tl: `${product} ethana venum?`, ta: `${product} எத்தனை வேணும்?`, en: `How many ${product}?` })
      : pick(s, { tl: `${product} ethana kg venum?`, ta: `${product} எத்தனை கிலோ வேணும்?`, en: `How many kg of ${product}?` }),
  askCut: (s: Style, product: string, cuts: string[]) =>
    pick(s, {
      tl: `${product} eppadi cut pannanum? ${cuts.join(' / ')}`,
      ta: `${product} எப்படி cut பண்ணணும்? ${cuts.join(' / ')}`,
      en: `Which cut for ${product}? ${cuts.join(' / ')}`,
    }),
  askPayment: (s: Style) =>
    pick(s, {
      tl: 'Payment eppadi pannuveenga? *Cash* / *UPI* (kadaila) / already *online-la paid*?',
      ta: 'Payment எப்படி பண்ணுவீங்க? *Cash* / *UPI* (கடையில) / ஏற்கனவே *online-ல paid*?',
      en: 'How will you pay? *Cash* / *UPI* at the shop / *already paid online*?',
    }),
  askPickup: (s: Style, shop: string, hours: string) =>
    pick(s, {
      tl: `Eppo vandhu collect pannuveenga? (${shop}, ${hours}) e.g. "saayangaalam 6 mani" / "1 mani nerathula"`,
      ta: `எப்போ வந்து collect பண்ணுவீங்க? (${shop}, ${hours}) e.g. "சாயங்காலம் 6 மணி" / "1 மணி நேரத்துல"`,
      en: `When will you come to collect? (${shop}, ${hours}) e.g. "6 pm today" / "in 1 hour"`,
    }),
  readyBy: (s: Style, minutes: number) =>
    pick(s, {
      tl: `Cut panni pack panna ${minutes} nimisham aagum — appo ready-ah irukkum.`,
      ta: `Cut பண்ணி pack பண்ண ${minutes} நிமிஷம் ஆகும் — அப்போ ready-ஆ இருக்கும்.`,
      en: `It takes about ${minutes} minutes to cut and pack — it will be ready by then.`,
    }),
  /** A pickup time the shop cannot serve (closed then): say why, never "got it" first. */
  outsideHours: (s: Style, shop: string, hours: string, when: string) =>
    pick(s, {
      tl: `${when}-ku ${shop} close-ah irukkum (${hours} thaan open). ${hours} kulla oru time sollunga.`,
      ta: `${when}-க்கு ${shop} மூடியிருக்கும் (${hours} தான் திறந்திருக்கும்). ${hours}-க்குள்ள ஒரு நேரம் சொல்லுங்க.`,
      en: `${shop} is closed at ${when} (open ${hours}). Please choose a time between ${hours}.`,
    }),
  /** At the review (or while ordering): "change பண்ணனும்" — what to change, one question. */
  whatToChange: (s: Style) =>
    pick(s, {
      tl: 'Sari, enna maathanum? Items / alavu, payment, illa collect time — sollunga.',
      ta: 'சரி, என்ன மாத்தணும்? Items / அளவு, payment, இல்ல collect நேரம் — சொல்லுங்க.',
      en: 'Sure, what would you like to change? Items / quantity, payment or pickup time — just tell me.',
    }),
  /**
   * "nattukozhi muttai": eggs of a kind the catalogue does not list separately. Say which eggs the shop has and ask —
   * never "Country Chicken not available" (that is the meat), and never claim the other kind is in stock.
   */
  eggKindNotListed: (s: Style, kind: string, eggs: string, price: string) =>
    pick(s, {
      tl: `${kind} muttai thaniya list-la illa — engakitta irukkuradhu ${eggs} (${price}). ${eggs} ok-ah? Ok-na ethana venum-nu sollunga.`,
      ta: `${kind} முட்டை தனியா list-ல இல்ல — எங்ககிட்ட இருக்கிறது ${eggs} (${price}). ${eggs} ok-ஆ? Ok-னா எத்தனை வேணும்-னு சொல்லுங்க.`,
      en: `We don't list ${kind} eggs separately — the eggs we have are ${eggs} (${price}). Would ${eggs} be OK? If yes, tell me how many.`,
    }),
  /** An unplaced order from WhatsApp / an earlier call: offered, never applied silently. */
  heldOffer: (s: Style, items: string) =>
    pick(s, {
      tl: `Munnadi sonna order (${items}) innum place aagala. Adhaiye continue pannalaama? "Sari" nu sollunga — illa pudhu order sollunga.`,
      ta: `முன்னாடி சொன்ன order (${items}) இன்னும் place ஆகல. அதையே continue பண்ணலாமா? "சரி"-னு சொல்லுங்க — இல்ல புது order சொல்லுங்க.`,
      en: `You have an earlier order that was not placed (${items}). Shall I continue with it? Say "yes" — or tell me your new order.`,
    }),
  heldResumed: (s: Style) => pick(s, { tl: 'Sari, munnadi order-aiye continue panrom.', ta: 'சரி, முன்னாடி order-ஐயே continue பண்றோம்.', en: 'OK, continuing your earlier order.' }),
  heldSetAside: (s: Style) =>
    pick(s, { tl: 'Munnadi place aagadha order-ai thaniya vechutten.', ta: 'முன்னாடி place ஆகாத order-ஐ தனியா வெச்சுட்டேன்.', en: 'I have set your earlier unplaced order aside.' }),
  /** Only unavailable products were asked for: what is still in the cart, without re-arming the review. */
  cartStill: (s: Style, items: string) =>
    pick(s, { tl: `Ungal cart-la ippo: ${items}.`, ta: `உங்க cart-ல இப்போ: ${items}.`, en: `Your cart still has: ${items}.` }),
  /** "Broiler curry cut" while Broiler is off: the cut product is offered, not substituted. */
  offerInstead: (s: Style, product: string, price: string) =>
    pick(s, {
      tl: `${product} (${price}) irukku — adhu ok-ah? Ok-na "sari" sollunga.`,
      ta: `${product} (${price}) இருக்கு — அது ok-ஆ? Ok-னா "சரி"-னு சொல்லுங்க.`,
      en: `We have ${product} (${price}) — would that be OK? Say "yes" if so.`,
    }),
  /** "8" for the pickup time when both 8 AM and 8 PM are possible today. */
  askAmPm: (s: Style, h: number) =>
    pick(s, { tl: `${h} mani kaalaiyaa (AM) illa saayangaalamaa (PM)?`, ta: `${h} மணி காலையா (AM) இல்ல சாயங்காலமா (PM)?`, en: `${h} AM or ${h} PM?` }),
  /** "4" for the pickup time when no 4 o'clock today works (passed, or the shop is closed). */
  hourNotToday: (s: Style, h: number, shop: string, hours: string) =>
    pick(s, {
      tl: `Inniku ${h} mani ${shop}-la mudiyaadhu (${hours} open). Inniku vera time-aa, illa naalaikku-aa? e.g. "naalaikku ${h} mani"`,
      ta: `இன்னைக்கு ${h} மணிக்கு ${shop}-ல முடியாது (${hours} திறந்திருக்கும்). இன்னைக்கு வேற நேரமா, இல்ல நாளைக்கா? e.g. "நாளைக்கு ${h} மணி"`,
      en: `${h} o'clock today won't work at ${shop} (open ${hours}). Another time today, or tomorrow? e.g. "tomorrow ${h} pm"`,
    }),
  askPickupTime: (s: Style) =>
    pick(s, { tl: 'Ethana manikku varuveenga?', ta: 'எத்தனை மணிக்கு வருவீங்க?', en: 'What time will you come?' }),
  askOutlet: (s: Style, list: string) =>
    pick(s, {
      tl: `Entha kadaila collect pannuveenga?\n${list}\nNumber reply pannunga.`,
      ta: `எந்த கடையில collect பண்ணுவீங்க?\n${list}\nNumber reply பண்ணுங்க.`,
      en: `Which shop will you collect from?\n${list}\nReply with the number.`,
    }),

  noted: (s: Style, parts: string[]) =>
    parts.length ? pick(s, { tl: `Sari ✅ ${parts.join(', ')}.`, ta: `சரி ✅ ${parts.join(', ')}.`, en: `Got it ✅ ${parts.join(', ')}.` }) : '',

  unavailable: (s: Style, names: string[]) =>
    pick(s, {
      tl: `Sorry, ${names.join(', ')} inniku illa.`,
      ta: `Sorry, ${names.join(', ')} இன்னைக்கு இல்ல.`,
      en: `Sorry, ${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} not available today.`,
    }),
  cutNotOffered: (s: Style, product: string, cuts: string[]) =>
    pick(s, {
      tl: `${product}-ku ${cuts.join(' / ')} mattum thaan.`,
      ta: `${product}-க்கு ${cuts.join(' / ')} மட்டும் தான்.`,
      en: `${product} comes as ${cuts.join(' / ')} only.`,
    }),
  /** Asked to drop something that is not in the cart: say so — never "removed" (and never add it). */
  notInCart: (s: Style, names: string[]) =>
    pick(s, { tl: `Sari, ${names.join(', ')} podala.`, ta: `சரி, ${names.join(', ')} போடல.`, en: `OK, no ${names.join(', ')}.` }),
  /** "No chicken" with no chicken in the cart. */
  noChicken: (s: Style) => pick(s, { tl: 'Sari, chicken illa.', ta: 'சரி, chicken இல்ல.', en: 'OK, no chicken.' }),
  /** "That's all" / "order place pannunga": finished choosing; the next missing detail (or the summary) follows. */
  doneChoosing: (s: Style) => pick(s, { tl: 'Sari 👍', ta: 'சரி 👍', en: 'Sure 👍' }),
  removed: (s: Style, names: string[]) => pick(s, { tl: `${names.join(', ')} eduthutten.`, ta: `${names.join(', ')} எடுத்துட்டேன்.`, en: `Removed ${names.join(', ')}.` }),
  cleared: (s: Style) => pick(s, { tl: 'Sari, order clear pannitten. Pudhusa sollunga.', ta: 'சரி, order clear பண்ணிட்டேன். புதுசா சொல்லுங்க.', en: 'OK, cleared. Tell me what you need.' }),

  problems: (s: Style, problems: string[]) =>
    `${pick(s, { tl: 'Konjam check pannunga:', ta: 'கொஞ்சம் check பண்ணுங்க:', en: 'Please check:' })}\n• ${problems.join('\n• ')}`,

  summary: (
    s: Style,
    p: { lines: SummaryLine[]; subtotal: number; discount: number; total: number; payment: string; pickupAt: Date; shop: string; offerNote?: string; unconfirmed?: string[] },
  ) => {
    const rows = p.lines.map((l) => `• ${formatQty(l.quantity, l.unit)} ${l.name}${l.cut ? ` — ${l.cut}` : ''} — ${rs(l.lineTotal)}`);
    const head = pick(s, { tl: '*Ungal order*', ta: '*உங்க order*', en: '*Your order*' });
    const offer = p.discount ? `${pick(s, { tl: 'Offer', ta: 'Offer', en: 'Offer' })}: −${rs(p.discount)} 🎉` : '';
    const when = describeWhen(p.pickupAt, s);
    const tail = pick(s, {
      tl: 'Ellam correct-ah? Confirm panna *Sari* / *Yes* nu reply pannunga. Maathanum-na sollunga.',
      ta: 'எல்லாம் correct-ஆ? Confirm பண்ண *சரி* / *Yes*-னு reply பண்ணுங்க. மாத்தணும்னா சொல்லுங்க.',
      en: 'Is everything correct? Reply *Yes* to confirm, or tell me what to change.',
    });
    return [
      head,
      ...rows,
      `${pick(s, { tl: 'Total', ta: 'மொத்தம்', en: 'Subtotal' })}: ${rs(p.subtotal)}`,
      offer,
      `*${pick(s, { tl: 'Kattavendiyadhu', ta: 'கட்ட வேண்டியது', en: 'To pay' })}: ${rs(p.total)}*`,
      `${pick(s, { tl: 'Payment', ta: 'Payment', en: 'Payment' })}: ${p.payment}`,
      `${pick(s, { tl: 'Collect', ta: 'Collect', en: 'Collect' })}: ${when}, ${p.shop}`,
      p.offerNote ?? '',
      p.unconfirmed?.length ? pick(s, { tl: `(${p.unconfirmed.join(', ')} stock kadai confirm pannuvaanga.)`, ta: `(${p.unconfirmed.join(', ')} stock-ஐ கடையில confirm பண்ணுவாங்க.)`, en: `(Stock for ${p.unconfirmed.join(', ')} will be confirmed by the shop.)` }) : '',
      '',
      tail,
    ]
      .filter((x, i, a) => x !== '' || (i > 0 && a[i - 1] !== ''))
      .join('\n');
  },

  offerNotApplied: (s: Style, reason: string) => {
    if (reason.startsWith('offer_min:')) {
      const min = Number(reason.split(':')[1]);
      return pick(s, {
        tl: `(Offer ${rs(min)}-ku mela order-ku thaan. Konjam add pannina offer kidaikkum.)`,
        ta: `(Offer ${rs(min)}-க்கு மேல order-க்கு தான். கொஞ்சம் add பண்ணா offer கிடைக்கும்.)`,
        en: `(The offer needs an order above ${rs(min)}.)`,
      });
    }
    const why: Record<string, Record<Style, string>> = {
      offer_already_used: { tl: 'Offer already use aagiduchu.', ta: 'Offer ஏற்கனவே use ஆகிடுச்சு.', en: 'The offer was already used.' },
      offer_expired: { tl: 'Offer expire aagiduchu.', ta: 'Offer expire ஆகிடுச்சு.', en: 'The offer has expired.' },
      offer_ended: { tl: 'Indha offer mudinjiduchu.', ta: 'இந்த offer முடிஞ்சிடுச்சு.', en: 'This offer has ended.' },
      offer_not_found: { tl: 'Offer kidaikala.', ta: 'Offer கிடைக்கல.', en: 'No offer found.' },
    };
    return `(${(why[reason] ?? why.offer_not_found)[s]})`;
  },

  paymentLabel: (s: Style, m: 'cash_at_shop' | 'upi_at_shop' | 'paid_online') =>
    ({
      cash_at_shop: pick(s, { tl: 'Cash (kadaila)', ta: 'Cash (கடையில)', en: 'Cash at the shop' }),
      upi_at_shop: pick(s, { tl: 'UPI (kadaila)', ta: 'UPI (கடையில)', en: 'UPI at the shop' }),
      paid_online: pick(s, { tl: 'Already online-la paid (staff check pannuvaanga)', ta: 'ஏற்கனவே online-ல paid (staff check பண்ணுவாங்க)', en: 'Already paid online (staff will verify)' }),
    })[m],

  placed: (s: Style, p: { orderNumber: string; total: number; pickupAt: Date; shop: string; demo: boolean }) => {
    const when = describeWhen(p.pickupAt, s);
    const body = pick(s, {
      tl: `✅ Order *${p.orderNumber}* confirm aachu — ${rs(p.total)}.\n${when}-ku ${p.shop}-la ready pannidrom. Ready aanadhum ungalukku solluvom.\nNandri! 🙏`,
      ta: `✅ Order *${p.orderNumber}* confirm ஆச்சு — ${rs(p.total)}.\n${when}-க்கு ${p.shop}-ல ready பண்ணிடுறோம். Ready ஆனதும் உங்களுக்கு சொல்லுவோம்.\nநன்றி! 🙏`,
      en: `✅ Order *${p.orderNumber}* confirmed — ${rs(p.total)}.\nWe'll have it ready at ${p.shop} for ${when}. We'll let you know when it's ready.\nThank you! 🙏`,
    });
    const demo = p.demo ? `\n\n⚠️ ${pick(s, { tl: 'Demo order — real kadaiku anuppala.', ta: 'Demo order — உண்மையான கடைக்கு அனுப்பல.', en: 'Demo order — not sent to a real shop.' })}` : '';
    return body + demo;
  },

  alreadyPlaced: (s: Style, orderNumber: string) =>
    pick(s, {
      tl: `Ungal order ${orderNumber} already confirm aagiduchu — pudhu order podala. "Status" nu anuppina update solren.`,
      ta: `உங்க order ${orderNumber} ஏற்கனவே confirm ஆகிடுச்சு — புது order போடல. "Status"-னு அனுப்புனா update சொல்றேன்.`,
      en: `Your order ${orderNumber} is already confirmed — no new order was created. Send "status" for an update.`,
    }),
  notPlaced: (s: Style) =>
    pick(s, {
      tl: 'Sari, order podala. Ungal details save-ah irukku — maathanum-na sollunga.',
      ta: 'சரி, order போடல. உங்க details save-ஆ இருக்கு — மாத்தணும்னா சொல்லுங்க.',
      en: "OK, I haven't placed it. Your details are saved — tell me what to change.",
    }),
  confirmReminder: (s: Style) =>
    pick(s, { tl: 'Confirm panna *Sari* / *Yes*, maathanum-na *No* nu reply pannunga.', ta: 'Confirm பண்ண *சரி* / *Yes*, மாத்தணும்னா *No*-னு reply பண்ணுங்க.', en: 'Reply *Yes* to confirm or *No* to change it.' }),
  couldNotPlace: (s: Style, problems: string[]) =>
    `${pick(s, { tl: 'Sorry, order poda mudiyala:', ta: 'Sorry, order போட முடியல:', en: "Sorry, I couldn't place the order:" })}\n• ${problems.join('\n• ')}`,

  status: (s: Style, p: { orderNumber: string; status: string; pickupAt: Date }) => {
    const st: Record<string, Record<Style, string>> = {
      pending: { tl: 'kadai confirm pannanum', ta: 'கடை confirm பண்ணணும்', en: 'waiting for the shop to confirm' },
      confirmed: { tl: 'confirm aagiduchu', ta: 'confirm ஆகிடுச்சு', en: 'confirmed' },
      preparing: { tl: 'cut panni pack pannitu irukkom 🔪', ta: 'cut பண்ணி pack பண்ணிட்டு இருக்கோம் 🔪', en: 'being cut and packed 🔪' },
      ready: { tl: 'ready! Vandhu collect pannikalaam ✅', ta: 'ready! வந்து collect பண்ணிக்கலாம் ✅', en: 'ready to collect ✅' },
      completed: { tl: 'collect pannitteenga. Nandri!', ta: 'collect பண்ணிட்டீங்க. நன்றி!', en: 'collected. Thank you!' },
      cancelled: { tl: 'cancel aagiduchu', ta: 'cancel ஆகிடுச்சு', en: 'cancelled' },
    };
    return pick(s, {
      tl: `Order *${p.orderNumber}* — ${st[p.status]?.tl ?? p.status}. Collect: ${describeWhen(p.pickupAt, 'tl')}.`,
      ta: `Order *${p.orderNumber}* — ${st[p.status]?.ta ?? p.status}. Collect: ${describeWhen(p.pickupAt, 'ta')}.`,
      en: `Order *${p.orderNumber}* is ${st[p.status]?.en ?? p.status}. Pickup: ${describeWhen(p.pickupAt, 'en')}.`,
    });
  },
  noOrder: (s: Style) => pick(s, { tl: 'Ungal per-la order edhuvum illa.', ta: 'உங்க பேர்ல order எதுவும் இல்ல.', en: "I couldn't find an order for you." }),
  handoff: (s: Style) =>
    pick(s, {
      tl: 'Sari, kadai staff ungalai seekiram contact pannuvaanga 🙏',
      ta: 'சரி, கடை staff உங்களை சீக்கிரம் contact பண்ணுவாங்க 🙏',
      en: 'Sure — our shop staff will contact you shortly 🙏',
    }),
  thanks: (s: Style) => pick(s, { tl: 'Nandri! 🙏', ta: 'நன்றி! 🙏', en: 'Thank you! 🙏' }),
  /** How to order. Example product and cuts come from the catalogue (`hint`); no fixed product names. */
  help: (s: Style, hint?: OrderHint) => {
    const h = hint ?? NO_HINT;
    const cut = h.cuts.length;
    return pick(s, {
      tl: `Order panna: enna venum, alavu${cut ? ', cut' : ''}, payment, collect time sollunga${h.example ? ` — e.g. "${h.example}, cash, 6 mani"` : ''}. Vera edhavadhu-na "staff" nu anuppunga.`,
      ta: `Order பண்ண: என்ன வேணும், அளவு${cut ? ', cut' : ''}, payment, collect நேரம் சொல்லுங்க${h.example ? ` — e.g. "${h.example}, cash, 6 மணி"` : ''}. வேற ஏதாவதுன்னா "staff"-னு அனுப்புங்க.`,
      en: `To order, tell me what you'd like, how much${cut ? ', which cut' : ''}, payment and pickup time${h.example ? ` — e.g. "${h.example}, cash, 6 pm"` : ''}. For anything else, send "staff".`,
    });
  },
  error: (s: Style) =>
    pick(s, { tl: 'Sorry, oru chinna technical problem. Konjam neram kazhichu try pannunga, illa "staff" nu anuppunga.', ta: 'Sorry, ஒரு சின்ன technical problem. கொஞ்ச நேரம் கழிச்சு try பண்ணுங்க, இல்ல "staff"-னு அனுப்புங்க.', en: 'Sorry, something went wrong. Please try again, or send "staff".' }),

  outlets: (s: Style, list: string) => `${pick(s, { tl: 'Engal kadaigal:', ta: 'எங்க கடைகள்:', en: 'Our shops:' })}\n${list}`,

  /** The catalogue says this product is in stock today (price from the catalogue). */
  inStock: (s: Style, name: string, price: number, unit: string) =>
    pick(s, {
      tl: `${name} irukku ✅ — ${rs(price)}/${unit === 'piece' ? 'pc' : 'kg'}.`,
      ta: `${name} இருக்கு ✅ — ${rs(price)}/${unit === 'piece' ? 'pc' : 'kg'}.`,
      en: `${name} is available ✅ — ${rs(price)}/${unit === 'piece' ? 'pc' : 'kg'}.`,
    }),
  /** Staff marked a product unavailable: name what IS available instead of a bare "no". */
  alternatives: (s: Style, names: string[]) =>
    names.length ? pick(s, { tl: `Aanaa ${names.join(', ')} irukku.`, ta: `ஆனா ${names.join(', ')} இருக்கு.`, en: `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} available.` }) : '',
  /**
   * Asked about something that is not a product in the catalogue (mutton, fish, "leg piece"...). We do not know
   * whether the shop has it, so we say we cannot confirm it — never that it is "not available".
   */
  notInList: (s: Style, names: string[]) =>
    pick(s, {
      tl: `Adhu pathi enakku confirm panna mudiyala. Engakitta irukkuradhu: ${names.join(', ')}. Vera edhavadhu-na "staff" nu anuppunga, kadai confirm pannuvaanga.`,
      ta: `அது பத்தி என்னால confirm பண்ண முடியல. எங்ககிட்ட இருக்கிறது: ${names.join(', ')}. வேற ஏதாவதுன்னா "staff"-னு அனுப்புங்க, கடையில confirm பண்ணுவாங்க.`,
      en: `I can't confirm that one. What we have today: ${names.join(', ')}. For anything else, send "staff" and the shop will confirm.`,
    }),
  /**
   * The product list could not be loaded or has no products configured: we cannot verify stock, so we say so
   * (and the conversation goes to staff) instead of claiming anything is unavailable.
   */
  menuUnverified: (s: Style) =>
    pick(s, {
      tl: 'Sorry, inniku stock-ah ippo confirm panna mudiyala. Kadai staff ungalukku confirm pannuvaanga 🙏',
      ta: 'Sorry, இன்னைக்கு stock-ஐ இப்போ confirm பண்ண முடியல. கடை staff உங்களுக்கு confirm பண்ணுவாங்க 🙏',
      en: "Sorry, I can't confirm today's stock right now. The shop staff will confirm it for you 🙏",
    }),
  /** Staff marked every product unavailable today (that is verified, so it may be said). */
  nothingToday: (s: Style) =>
    pick(s, { tl: 'Inniku ellam mudinjiduchu 🙏 Naalaikku order pannalaam.', ta: 'இன்னைக்கு எல்லாம் முடிஞ்சிடுச்சு 🙏 நாளைக்கு order பண்ணலாம்.', en: 'Everything is sold out for today 🙏 You can order tomorrow.' }),

  /**
   * "Which chicken is available?" — every product that can be sold now, with its catalogue price and, when stock
   * is tracked, the quantity in stock (labelled demo when it is sample data). Then one question.
   */
  availableList: (s: Style, items: StockLine[], ask = true) => {
    if (!items.length) return say.nothingToday(s);
    const parts = items.map((i) => `${i.name} — ${rs(i.price)}/${i.unit === 'piece' ? 'pc' : 'kg'}${i.stockQty !== null ? ` (${stockText(i.stockQty, i.unit)}${i.stockIsDemo ? pick(s, { tl: ' demo stock', ta: ' demo stock', en: ' in demo stock' }) : pick(s, { tl: ' irukku', ta: ' இருக்கு', en: ' in stock' })})` : pick(s, { tl: ' (stock confirm aagala)', ta: ' (stock confirm ஆகல)', en: ' (stock not confirmed)' })}`);
    const head = pick(s, { tl: 'Inniku irukkuradhu:', ta: 'இன்னைக்கு இருக்கிறது:', en: 'Available today:' });
    const tail = ask ? `\n${pick(s, { tl: 'Edhu venum?', ta: 'எது வேணும்?', en: 'Which would you like?' })}` : '';
    return `${head}\n• ${parts.join('\n• ')}${tail}`;
  },
  /** "How much stock is there?" — quantities from the database only; products with unknown stock are said to be unconfirmed. */
  stockSummary: (s: Style, inStock: StockLine[], out: string[], unknown: string[]) => {
    const lines: string[] = [];
    if (inStock.length) lines.push(`${pick(s, { tl: 'Ippo stock:', ta: 'இப்போ stock:', en: 'Stock right now:' })}\n• ${inStock.map((i) => `${i.name} — ${stockText(i.stockQty ?? 0, i.unit)}`).join('\n• ')}`);
    if (out.length) lines.push(pick(s, { tl: `Stock illa: ${out.join(', ')}.`, ta: `Stock இல்ல: ${out.join(', ')}.`, en: `Out of stock: ${out.join(', ')}.` }));
    if (unknown.length) lines.push(pick(s, { tl: `${unknown.join(', ')} — stock system-la confirm aagala; kadai confirm pannuvaanga.`, ta: `${unknown.join(', ')} — stock system-ல confirm ஆகல; கடையில confirm பண்ணுவாங்க.`, en: `${unknown.join(', ')} — stock not confirmed in the system; the shop will confirm.` }));
    if (inStock.some((i) => i.stockIsDemo)) lines.push(pick(s, { tl: '(Demo stock — sample numbers)', ta: '(Demo stock — மாதிரி எண்ணிக்கை)', en: '(Demo stock — sample numbers, not counted shop inventory)' }));
    return lines.join('\n');
  },
  /** One product's status from the catalogue, with stock when tracked. */
  itemInStock: (s: Style, i: StockLine): string =>
    i.stockQty === null ? say.stockUnknown(s, i.name, i.price, i.unit) : pick(s, {
      tl: `${i.name} irukku ✅ — ${rs(i.price)}/${i.unit === 'piece' ? 'pc' : 'kg'}${i.stockQty !== null ? `, ${stockText(i.stockQty, i.unit)}${i.stockIsDemo ? ' (demo stock)' : ''}` : ''}.`,
      ta: `${i.name} இருக்கு ✅ — ${rs(i.price)}/${i.unit === 'piece' ? 'pc' : 'kg'}${i.stockQty !== null ? `, ${stockText(i.stockQty, i.unit)}${i.stockIsDemo ? ' (demo stock)' : ''}` : ''}.`,
      en: `${i.name} is available ✅ — ${rs(i.price)}/${i.unit === 'piece' ? 'pc' : 'kg'}${i.stockQty !== null ? `, ${stockText(i.stockQty, i.unit)}${i.stockIsDemo ? ' in demo stock' : ' in stock'}` : ''}.`,
    }),
  /** Stock is not recorded (NULL): never "available", never "out" — the price, and the shop confirms. */
  stockUnknown: (s: Style, name: string, price: number, unit: string) =>
    pick(s, {
      tl: `${name} — ${rs(price)}/${unit === 'piece' ? 'pc' : 'kg'}. Inniku stock system-la confirm aagala; order pannina kadai confirm pannuvaanga.`,
      ta: `${name} — ${rs(price)}/${unit === 'piece' ? 'pc' : 'kg'}. இன்னைக்கு stock system-ல confirm ஆகல; order பண்ணா கடையில confirm பண்ணுவாங்க.`,
      en: `${name} is ${rs(price)}/${unit === 'piece' ? 'pc' : 'kg'}. I can't confirm today's stock from the system — the shop will confirm it when you order.`,
    }),
  /** Asked for more than the shop has: say how much there is, offer that (or less) or something else. */
  onlyHave: (s: Style, name: string, available: string, alternatives: string[]) =>
    [
      pick(s, {
        tl: `Sorry, ${name} ippo ${available} thaan irukku. ${available} or adhukku kammiya venuma?`,
        ta: `Sorry, ${name} இப்போ ${available} தான் இருக்கு. ${available} அல்லது அதுக்கு கம்மியா வேணுமா?`,
        en: `Sorry, we have only ${available} of ${name} right now. Would you like ${available} or less?`,
      }),
      alternatives.length ? pick(s, { tl: `Illa-na ${alternatives.join(', ')} irukku.`, ta: `இல்லன்னா ${alternatives.join(', ')} இருக்கு.`, en: `Or we have ${alternatives.join(', ')}.` }) : '',
    ].filter(Boolean).join(' '),
  /** "2 kg eggs", "6 pieces boneless": the product is sold in the other unit. */
  wrongUnit: (s: Style, name: string, unit: string) =>
    unit === 'piece'
      ? pick(s, { tl: `${name} piece kanakku thaan. Ethana venum?`, ta: `${name} எண்ணிக்கை கணக்கு தான். எத்தனை வேணும்?`, en: `${name} is sold by the piece. How many would you like?` })
      : pick(s, { tl: `${name} kg kanakku thaan. Ethana kg venum?`, ta: `${name} கிலோ கணக்கு தான். எத்தனை கிலோ வேணும்?`, en: `${name} is sold by weight. How many kg would you like?` }),
  /** "மூணு கிலோ" eggs: counted, not weighed — offer the number they said instead of repeating the rule. */
  confirmPieces: (s: Style, name: string, n: number) =>
    pick(s, {
      tl: `${name} piece kanakku thaan (kilo illa). ${n} ${name} podalaamaa? Sari-na "sari" sollunga, illa ethana venum-nu sollunga.`,
      ta: `${name} எண்ணிக்கை கணக்கு தான் (கிலோ இல்ல). ${n} ${name} போடலாமா? சரின்னா "சரி"-னு சொல்லுங்க, இல்ல எத்தனை வேணும்-னு சொல்லுங்க.`,
      en: `${name} are sold by count, not by kilo. Shall I put ${n} ${name}? Say "yes", or tell me how many.`,
    }),
  /** A quantity outside what the product can be ordered in (below minimum, above maximum, or not on its step). */
  badQty: (s: Style, name: string, rule: string) =>
    pick(s, { tl: `${name}: ${rule}. Vera alavu sollunga.`, ta: `${name}: ${rule}. வேற அளவு சொல்லுங்க.`, en: `${name}: ${rule}. Please tell me another amount.` }),
  /** The cart so far, with each line priced from the catalogue and the running total. */
  cart: (s: Style, lines: Array<{ name: string; qty: string; total: number }>, total: number) =>
    `${pick(s, { tl: 'Ungal cart:', ta: 'உங்க cart:', en: 'Your cart:' })}\n• ${lines.map((l) => `${l.qty} ${l.name} — ${rs(l.total)}`).join('\n• ')}\n${pick(s, { tl: 'Total', ta: 'மொத்தம்', en: 'Total' })}: ${rs(total)}`,
  outOfStock: (s: Style, names: string[]) =>
    pick(s, {
      tl: `Sorry, ${names.join(', ')} ippo stock illa.`,
      ta: `Sorry, ${names.join(', ')} இப்போ stock இல்ல.`,
      en: `Sorry, ${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} currently out of stock.`,
    }),
  /** Nothing suitable can be sold: say so plainly and offer the shop staff (stock-return notifications are not built). */
  noSuitableStock: (s: Style) =>
    pick(s, {
      tl: 'Ippo vera edhuvum stock-la illa. Kadai staff kitta pesanum-na "staff" nu anuppunga 🙏',
      ta: 'இப்போ வேற எதுவும் stock-ல இல்ல. கடை staff கிட்ட பேசணும்னா "staff"-னு சொல்லுங்க 🙏',
      en: 'Nothing else is in stock right now. Say "staff" if you would like the shop staff to contact you 🙏',
    }),
  /** The customer's message was not understood twice in a row: do not repeat the same question a third time. */
  notUnderstood: (s: Style, options: string) =>
    pick(s, {
      tl: `Sorry, enakku puriyala. ${options}`,
      ta: `Sorry, எனக்கு புரியல. ${options}`,
      en: `Sorry, I didn't get that. ${options}`,
    }),
  offerStaff: (s: Style) =>
    pick(s, {
      tl: 'Kadai staff ungalukku help pannuvaanga — "staff" nu sollunga, avanga contact pannuvaanga 🙏',
      ta: 'கடை staff உங்களுக்கு help பண்ணுவாங்க — "staff"-னு சொல்லுங்க, அவங்க contact பண்ணுவாங்க 🙏',
      en: 'Our shop staff can help — say "staff" and they will contact you 🙏',
    }),

  /** There is no delivery in GR Chicken's setup (no delivery areas, fees or riders are configured): pickup only. */
  pickupOnly: (s: Style, shops: string) =>
    pick(s, {
      tl: `Sorry, delivery illa — kadaila vandhu collect pannanum.${shops ? ` (${shops})` : ''}`,
      ta: `Sorry, delivery இல்ல — கடையில வந்து collect பண்ணணும்.${shops ? ` (${shops})` : ''}`,
      en: `Sorry, we don't deliver — orders are collected at the shop.${shops ? ` (${shops})` : ''}`,
    }),
  bye: (s: Style) => pick(s, { tl: 'Sari, nandri! 🙏', ta: 'சரிங்க, நன்றி! 🙏', en: 'Okay, thank you! 🙏' }),
  /** Goodbye while an order summary was waiting for a yes: say plainly that nothing was ordered. */
  byeNotPlaced: (s: Style) =>
    pick(s, {
      tl: 'Sari, order innum podala. Eppo venumnaalum WhatsApp-la sollunga. Nandri! 🙏',
      ta: 'சரிங்க, order இன்னும் போடல. எப்போ வேணும்னாலும் WhatsApp-ல சொல்லுங்க. நன்றி! 🙏',
      en: "Okay, the order has not been placed. Message us on WhatsApp any time. Thank you! 🙏",
    }),

  // ---- Order-ready phone call (spoken; Tamil script is read by the Tamil TTS voice) ----------
  readyCallOpening: (s: Style, p: { name?: string; business: string; items: string; shop: string; pickupAt: Date; total: number; paid: boolean }) => {
    const when = spokenWhen(p.pickupAt, s === 'en' ? 'en' : 'ta');
    return s === 'en'
      ? `Hello${p.name ? ` ${p.name}` : ''}, this is ${p.business}. Your order — ${p.items} — is ready, exactly as you asked. You can collect it at ${p.shop}${p.paid ? '' : `; the amount is ${p.total} rupees`}. When will you come?`
      : `வணக்கம்${p.name ? ` ${p.name}` : ''}, ${p.business}-ல இருந்து பேசுறோம். நீங்க சொன்ன மாதிரி ${p.items} எல்லாம் ready-ஆ இருக்கு. ${p.shop} கடைக்கு வந்து collect பண்ணிக்கலாம்${p.paid ? '' : `, ${p.total} ரூபாய்`}. நீங்க ${when}-க்கு வருவீங்களா?`;
  },
  readyCallComing: (s: Style) => (s === 'en' ? 'Great, we will keep it ready. Thank you!' : 'சரிங்க, ready-ஆ வச்சிருக்கோம். நன்றி!'),
  readyCallLater: (s: Style) =>
    s === 'en' ? 'No problem, I have noted it. Our staff will keep it for you. Thank you!' : 'பரவாயில்லைங்க, note பண்ணிட்டேன். நம்ம staff உங்களுக்காக வச்சிருப்பாங்க. நன்றி!',
  readyCallCancel: (s: Style) =>
    s === 'en' ? 'Okay, I have told our staff. Someone from the shop will call you. Thank you.' : 'சரிங்க, staff-கிட்ட சொல்லிட்டேன். கடையில இருந்து உங்களுக்கு call பண்ணுவாங்க. நன்றி.',
  readyCallUnclear: (s: Style) =>
    s === 'en' ? 'Sorry, I could not hear you. I have sent the details on WhatsApp. Thank you!' : 'Sorry, சரியா கேக்கல. Details WhatsApp-ல அனுப்பிருக்கோம். நன்றி!',

  readyWhatsApp: (s: Style, p: { orderNumber: string; items: string; shop: string; total: number; paid: boolean }) =>
    pick(s, {
      tl: `✅ Order *${p.orderNumber}* ready! Neenga sonna maadhiri ${p.items} ellam ready-ah irukku. ${p.shop}-la vandhu collect pannikalaam${p.paid ? '' : ` (${rs(p.total)})`}. Nandri 🙏`,
      ta: `✅ Order *${p.orderNumber}* ready! நீங்க சொன்ன மாதிரி ${p.items} எல்லாம் ready-ஆ இருக்கு. ${p.shop}-ல வந்து collect பண்ணிக்கலாம்${p.paid ? '' : ` (${rs(p.total)})`}. நன்றி 🙏`,
      en: `✅ Order *${p.orderNumber}* is ready! ${p.items}, just as you asked. Collect it at ${p.shop}${p.paid ? '' : ` (${rs(p.total)})`}. Thank you 🙏`,
    }),
};

/** "2 kg Broiler Chicken curry cut, 500 g Boneless" for the call and the ready message. */
export function itemsPhrase(lines: Array<{ name: string; quantity: number; unit: string; cut: string | null }>, s: Style): string {
  return lines
    .map((l) => {
      const qty = l.unit === 'piece' ? `${l.quantity}` : s === 'ta' ? formatQty(l.quantity, 'kg').replace(' kg', ' கிலோ').replace(' g', ' கிராம்') : formatQty(l.quantity, 'kg');
      return `${qty} ${l.name}${l.cut ? ` ${l.cut}` : ''}`;
    })
    .join(', ');
}

/** Today's products with per-kg prices and cuts, from the catalogue (never typed by hand). */
/** Catalogue-derived wording for help and welcome texts: an example order and the cuts the shop actually offers. */
export type OrderHint = { example: string; cuts: string[] };
const NO_HINT: OrderHint = { example: '', cuts: [] };

/** Example from the first product that can be sold now ("1 kg Boneless Chicken"; "12 Eggs" for piece items). */
export function orderHint(catalog: { items: Array<{ name: string; unit: string; cutOptions: string[]; available: boolean }> }): OrderHint {
  const sellable = catalog.items.filter((i) => i.available);
  const first = sellable.find((i) => i.unit !== 'piece') ?? sellable[0];
  const cut = first?.cutOptions[0];
  return {
    example: first ? `${first.unit === 'piece' ? '12' : '1 kg'} ${first.name}${cut ? ` ${cut}` : ''}` : '',
    cuts: [...new Set(sellable.flatMap((i) => i.cutOptions))],
  };
}

export function menuBlock(catalog: { items: Array<{ name: string; price: number; unit: string; cutOptions: string[]; available: boolean; isDemo: boolean }> }, s: Style): string {
  const items = catalog.items.filter((i) => i.available);
  if (!items.length) return '';
  const rows = items.map((i) => `• ${i.name} — ${rs(i.price)}/${i.unit === 'piece' ? 'pc' : 'kg'}${i.cutOptions.length ? ` (${i.cutOptions.join(', ')})` : ''}`);
  const demo = catalog.items.some((i) => i.isDemo) ? `\n${say.demoNote(s)}` : '';
  return `${say.menuTitle(s)}\n${rows.join('\n')}${demo}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Phone-call phrasing. Spoken by the Tamil (or English) TTS voice: no menus as lists, no "reply with a number",
// no symbols; amounts said as "240 ரூபாய்". Every amount, product, cut, shop and time is passed in from the
// catalogue / order service, never written here.
// ---------------------------------------------------------------------------------------------------------------

export type VoiceStyle = 'ta' | 'en';
const vpick = (s: VoiceStyle, v: Record<VoiceStyle, string>) => v[s];
const rupees = (n: number, s: VoiceStyle) => `${Number.isInteger(n) ? n : n.toFixed(2)} ${s === 'en' ? 'rupees' : 'ரூபாய்'}`;
const spokenQty = (q: number, unit: string, s: VoiceStyle) =>
  unit === 'piece' ? `${q}` : s === 'en' ? formatQty(q, 'kg') : formatQty(q, 'kg').replace(' kg', ' கிலோ').replace(' g', ' கிராம்');

export const spoken = {
  /** We called the customer. Who, that it is an AI, and one open question; nothing about any earlier enquiry. */
  outboundOpening: (s: VoiceStyle, p: { name?: string; business: string }) =>
    vpick(s, {
      ta: `வணக்கம்${p.name ? ` ${p.name}` : ''}, ${p.business}-ல இருந்து AI assistant பேசுறேன். Chicken order பண்ணணுமா, இல்ல உங்க order பத்தி ஏதாவது தெரியணுமா?`,
      en: `Hello${p.name ? ` ${p.name}` : ''}, this is the AI assistant from ${p.business}. Would you like to order chicken, or ask about your order?`,
    }),
  inboundOpening: (s: VoiceStyle, p: { name?: string; business: string }) =>
    vpick(s, {
      ta: `வணக்கம்${p.name ? ` ${p.name}` : ''}, ${p.business}. நான் AI assistant பேசுறேன். சொல்லுங்க, என்ன chicken வேணும்?`,
      en: `Hello${p.name ? ` ${p.name}` : ''}, ${p.business}. I am the AI assistant. What would you like to order?`,
    }),
  menu: (s: VoiceStyle, items: Array<{ name: string; price: number; unit: string; available: boolean; isDemo: boolean }>) => {
    const list = items.filter((i) => i.available);
    // No products configured / not loaded: stock is unknown, not "nothing available".
    if (!items.length) return vpick(s, { ta: 'Sorry, இன்னைக்கு stock-ஐ இப்போ confirm பண்ண முடியல. கடை staff confirm பண்ணுவாங்க.', en: "Sorry, I can't confirm today's stock right now. The shop staff will confirm it." });
    if (!list.length) return vpick(s, { ta: 'இன்னைக்கு எல்லாம் முடிஞ்சிடுச்சு. நாளைக்கு order பண்ணலாம்.', en: 'Everything is sold out for today. You can order tomorrow.' });
    const each = list.map((i) => (s === 'en' ? `${i.name}, ${rupees(i.price, s)} a ${i.unit === 'piece' ? 'piece' : 'kilo'}` : `${i.name} ${i.unit === 'piece' ? 'ஒன்னு' : 'கிலோ'} ${rupees(i.price, s)}`));
    const demo = list.some((i) => i.isDemo) ? vpick(s, { ta: ' இது demo rate.', en: ' These are demo prices.' }) : '';
    return `${vpick(s, { ta: 'இன்னைக்கு rate:', en: "Today's prices:" })} ${each.join(', ')}.${demo}`;
  },
  askPayment: (s: VoiceStyle) =>
    vpick(s, { ta: 'Payment எப்படி? Cash-ஆ, UPI-ஆ, இல்ல ஏற்கனவே online-ல pay பண்ணிட்டீங்களா?', en: 'How will you pay? Cash, UPI at the shop, or have you already paid online?' }),
  askPickup: (s: VoiceStyle, shop: string, opens: string, closes: string) =>
    vpick(s, { ta: `எப்போ வந்து collect பண்ணுவீங்க? ${shop} கடை ${opens} முதல் ${closes} வரை open.`, en: `When will you come to collect? ${shop} is open from ${opens} to ${closes}.` }),
  askOutlet: (s: VoiceStyle, shops: string[]) =>
    vpick(s, { ta: `எந்த கடையில collect பண்ணுவீங்க? ${shops.join(', இல்ல ')}?`, en: `Which shop will you collect from? ${shops.join(', or ')}?` }),
  summary: (s: VoiceStyle, p: { lines: SummaryLine[]; discount: number; total: number; payment: string; pickupAt: Date; shop: string; now?: Date }) => {
    const items = p.lines.map((l) => `${spokenQty(l.quantity, l.unit, s)} ${l.name}${l.cut ? ` ${l.cut}` : ''}`).join(', ');
    const when = spokenWhen(p.pickupAt, s, p.now);
    return s === 'en'
      ? `So that is ${items}. ${p.discount ? `After the ${rupees(p.discount, s)} offer, ` : ''}the total is ${rupees(p.total, s)}, ${p.payment}, collect ${when} at ${p.shop}. Shall I place the order?`
      : `சரி, ${items}. ${p.discount ? `${rupees(p.discount, s)} offer கழிச்சு ` : ''}மொத்தம் ${rupees(p.total, s)}. ${p.payment}. ${when} ${p.shop}-ல collect. Order confirm பண்ணவா?`;
  },
  confirmReminder: (s: VoiceStyle) =>
    vpick(s, { ta: 'Order confirm பண்ணவா? சரின்னா ஆமா-ன்னு சொல்லுங்க, மாத்தணும்னா சொல்லுங்க.', en: 'Shall I place the order? Say yes to confirm, or tell me what to change.' }),
  placed: (s: VoiceStyle, p: { total: number; pickupAt: Date; shop: string; demo: boolean; now?: Date }) => {
    const when = spokenWhen(p.pickupAt, s, p.now);
    const demo = p.demo ? vpick(s, { ta: ' இது demo order.', en: ' This is a demo order.' }) : '';
    return vpick(s, {
      ta: `Order confirm ஆச்சு. மொத்தம் ${rupees(p.total, s)}. ${when} ${p.shop}-ல ready-ஆ இருக்கும். Ready ஆனதும் சொல்லுவோம்.${demo} வேற ஏதாவது வேணுமா?`,
      en: `Your order is confirmed. The total is ${rupees(p.total, s)}. It will be ready ${when} at ${p.shop}. We will let you know when it is ready.${demo} Anything else?`,
    });
  },
  offer: (s: VoiceStyle, amount: number) =>
    vpick(s, { ta: `உங்களுக்கு ${rupees(amount, s)} offer இருக்கு, இந்த order-ல கழிச்சுக்கலாம்.`, en: `You have a ${rupees(amount, s)} offer; it will come off this order.` }),
  noOffer: (s: VoiceStyle) => vpick(s, { ta: 'இப்போ உங்களுக்கு offer எதுவும் இல்ல.', en: 'There is no offer on your number right now.' }),
  askQty: (s: VoiceStyle, product: string, unit: string) =>
    unit === 'piece'
      ? vpick(s, { ta: `${product} எத்தனை வேணும்?`, en: `How many ${product} would you like?` })
      : vpick(s, { ta: `${product} எத்தனை கிலோ வேணும்?`, en: `How many kilos of ${product} would you like?` }),
  handoffOffer: (s: VoiceStyle) =>
    vpick(s, { ta: 'எனக்கு சரியா புரியல. கடை staff கிட்ட பேசணும்னா staff-னு சொல்லுங்க, இல்ல bye சொல்லுங்க.', en: "Sorry, I'm not getting it. Say staff and our shop staff will call you, or say bye." }),
  help: (s: VoiceStyle, hint?: OrderHint) =>
    (hint ?? NO_HINT).cuts.length
      ? vpick(s, { ta: 'என்ன வேணும், எவ்வளவு, எப்படி cut, payment எப்படி, எப்போ வருவீங்கன்னு சொல்லுங்க.', en: 'Tell me what you would like, how much, which cut, how you will pay and when you will collect.' })
      : vpick(s, { ta: 'என்ன வேணும், எவ்வளவு, payment எப்படி, எப்போ வருவீங்கன்னு சொல்லுங்க.', en: 'Tell me what you would like, how much, how you will pay and when you will collect.' }),
  error: (s: VoiceStyle) => vpick(s, { ta: 'Sorry, ஒரு சின்ன problem. இன்னொரு தடவை சொல்லுங்களேன்?', en: 'Sorry, something went wrong on our side. Could you say that again?' }),
  handoff: (s: VoiceStyle) => vpick(s, { ta: 'சரிங்க, கடை staff உங்களுக்கு சீக்கிரம் call பண்ணுவாங்க. நன்றி!', en: 'Sure, our shop staff will call you shortly. Thank you!' }),
};

/** What a WhatsApp-style reply sounds like on the phone: no emoji, bullets, asterisks or line breaks. */
export function toSpeech(text: string, s: VoiceStyle = 'ta'): string {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu, '')
    .replace(/[*_`•]/g, '')
    .replace(/₹\s?(\d[\d,]*(?:\.\d+)?)/g, s === 'en' ? '$1 rupees' : '$1 ரூபாய்')
    // "220 rupees/kg" is read out as "slash": say it the way people do.
    .replace(/\/kg\b/g, s === 'en' ? ' a kilo' : ' கிலோவுக்கு')
    .replace(/\/pc\b/g, s === 'en' ? ' each' : ' ஒன்னுக்கு')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/:\s*\./g, ':')
    .replace(/\s+/g, ' ')
    .trim();
}
