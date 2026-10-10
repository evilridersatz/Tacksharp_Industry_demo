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

export type Style = 'tl' | 'ta' | 'en';

const rs = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
const pick = (s: Style, v: Record<Style, string>) => v[s];

export type SummaryLine = { name: string; quantity: number; unit: string; cut: string | null; lineTotal: number; unitPrice: number };

export const say = {
  offerGreeting: (s: Style, p: { name?: string; business: string; amount: number; menu: string }) =>
    pick(s, {
      tl: `Vanakkam${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business} vaangiyatharku romba nandri.\nUngalukku *${rs(p.amount)} offer* irukku 🎉\n\nOffer claim panna munnadi konjam sollunga:\n1️⃣ Enna chicken venum?\n2️⃣ Ethana kg?\n3️⃣ Eppadi cut pannanum? (curry cut / biryani cut / fry cut / whole)\n4️⃣ Payment eppadi? (cash / UPI / already online-la paid)\n5️⃣ Eppo vandhu collect pannuveenga?\n\nEllam ore message-la kooda sollalaam, e.g. "2 kg broiler curry cut, GPay, saayangaalam 6 mani".\n\n${p.menu}`,
      ta: `வணக்கம்${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business}-ல வாங்கியதற்கு ரொம்ப நன்றி.\nஉங்களுக்கு *${rs(p.amount)} offer* இருக்கு 🎉\n\nOffer claim பண்றதுக்கு முன்னாடி கொஞ்சம் சொல்லுங்க:\n1️⃣ என்ன chicken வேணும்?\n2️⃣ எத்தனை கிலோ?\n3️⃣ எப்படி cut பண்ணணும்? (curry cut / biryani cut / fry cut / whole)\n4️⃣ Payment எப்படி? (cash / UPI / ஏற்கனவே online-ல paid)\n5️⃣ எப்போ வந்து collect பண்ணுவீங்க?\n\nஎல்லாம் ஒரே message-ல கூட சொல்லலாம், e.g. "2 கிலோ broiler curry cut, GPay, சாயங்காலம் 6 மணி".\n\n${p.menu}`,
      en: `Hello${p.name ? ` ${p.name}` : ''}! 🙏 Thank you for buying from ${p.business}.\nYou have a *${rs(p.amount)} offer* 🎉\n\nTo claim it, please tell me:\n1️⃣ Which chicken?\n2️⃣ How many kg?\n3️⃣ Which cut? (curry cut / biryani cut / fry cut / whole)\n4️⃣ Payment? (cash / UPI / already paid online)\n5️⃣ When will you come to collect?\n\nYou can send it all in one message, e.g. "2 kg broiler curry cut, GPay, 6 pm today".\n\n${p.menu}`,
    }),

  plainGreeting: (s: Style, p: { name?: string; business: string; menu: string }) =>
    pick(s, {
      tl: `Vanakkam${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business}. Enna chicken, ethana kg, eppadi cut, payment eppadi, eppo collect pannuveenga nu sollunga, naan order ready pannidren.\n\n${p.menu}`,
      ta: `வணக்கம்${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business}. என்ன chicken, எத்தனை கிலோ, எப்படி cut, payment எப்படி, எப்போ collect பண்ணுவீங்கன்னு சொல்லுங்க, நான் order ready பண்ணிடுறேன்.\n\n${p.menu}`,
      en: `Hello${p.name ? ` ${p.name}` : ''}! 🙏 ${p.business}. Tell me which chicken, how many kg, which cut, how you'll pay and when you'll collect, and I'll get your order ready.\n\n${p.menu}`,
    }),

  offerAlreadyUsed: (s: Style) =>
    pick(s, {
      tl: 'Ungaloda offer already use panniteenga 🙏 Aanaa normal-ah order pannalaam.',
      ta: 'உங்க offer ஏற்கனவே use பண்ணிட்டீங்க 🙏 ஆனா normal-ஆ order பண்ணலாம்.',
      en: 'Your offer has already been used 🙏 You can still place a normal order.',
    }),

  menuTitle: (s: Style) => pick(s, { tl: '*Inniku rate* (per kg):', ta: '*இன்னைக்கு rate* (கிலோவுக்கு):', en: "*Today's prices* (per kg):" }),
  demoNote: (s: Style) => pick(s, { tl: '(Demo rate — sample prices)', ta: '(Demo rate — மாதிரி விலை)', en: '(Demo prices — sample data)' }),

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
  removed: (s: Style, names: string[]) => pick(s, { tl: `${names.join(', ')} eduthutten.`, ta: `${names.join(', ')} எடுத்துட்டேன்.`, en: `Removed ${names.join(', ')}.` }),
  cleared: (s: Style) => pick(s, { tl: 'Sari, order clear pannitten. Pudhusa sollunga.', ta: 'சரி, order clear பண்ணிட்டேன். புதுசா சொல்லுங்க.', en: 'OK, cleared. Tell me what you need.' }),

  problems: (s: Style, problems: string[]) =>
    `${pick(s, { tl: 'Konjam check pannunga:', ta: 'கொஞ்சம் check பண்ணுங்க:', en: 'Please check:' })}\n• ${problems.join('\n• ')}`,

  summary: (
    s: Style,
    p: { lines: SummaryLine[]; subtotal: number; discount: number; total: number; payment: string; pickupAt: Date; shop: string; offerNote?: string },
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
      tl: `✅ Order *${p.orderNumber}* confirm aachu — ${rs(p.total)}.\n${when}-ku ${p.shop}-la ready pannidrom. Ready aanadhum ungalukku call pannuvom 📞\nNandri! 🙏`,
      ta: `✅ Order *${p.orderNumber}* confirm ஆச்சு — ${rs(p.total)}.\n${when}-க்கு ${p.shop}-ல ready பண்ணிடுறோம். Ready ஆனதும் உங்களுக்கு call பண்ணுவோம் 📞\nநன்றி! 🙏`,
      en: `✅ Order *${p.orderNumber}* confirmed — ${rs(p.total)}.\nWe'll have it ready at ${p.shop} for ${when}. We'll call you when it's ready 📞\nThank you! 🙏`,
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
  help: (s: Style) =>
    pick(s, {
      tl: 'Order panna: chicken, kg, cut, payment, collect time sollunga — e.g. "2 kg broiler curry cut, cash, 6 mani". Vera edhavadhu-na "staff" nu anuppunga.',
      ta: 'Order பண்ண: chicken, கிலோ, cut, payment, collect நேரம் சொல்லுங்க — e.g. "2 கிலோ broiler curry cut, cash, 6 மணி". வேற ஏதாவதுன்னா "staff"-னு அனுப்புங்க.',
      en: 'To order, tell me chicken, kg, cut, payment and pickup time — e.g. "2 kg broiler curry cut, cash, 6 pm". For anything else, send "staff".',
    }),
  error: (s: Style) =>
    pick(s, { tl: 'Sorry, oru chinna technical problem. Konjam neram kazhichu try pannunga, illa "staff" nu anuppunga.', ta: 'Sorry, ஒரு சின்ன technical problem. கொஞ்ச நேரம் கழிச்சு try பண்ணுங்க, இல்ல "staff"-னு அனுப்புங்க.', en: 'Sorry, something went wrong. Please try again, or send "staff".' }),

  outlets: (s: Style, list: string) => `${pick(s, { tl: 'Engal kadaigal:', ta: 'எங்க கடைகள்:', en: 'Our shops:' })}\n${list}`,

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
export function menuBlock(catalog: { items: Array<{ name: string; price: number; unit: string; cutOptions: string[]; available: boolean; isDemo: boolean }> }, s: Style): string {
  const items = catalog.items.filter((i) => i.available);
  if (!items.length) return '';
  const rows = items.map((i) => `• ${i.name} — ${rs(i.price)}/${i.unit === 'piece' ? 'pc' : 'kg'}${i.cutOptions.length ? ` (${i.cutOptions.join(', ')})` : ''}`);
  const demo = catalog.items.some((i) => i.isDemo) ? `\n${say.demoNote(s)}` : '';
  return `${say.menuTitle(s)}\n${rows.join('\n')}${demo}`;
}
