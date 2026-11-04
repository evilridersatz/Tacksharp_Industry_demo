import { formatQty } from './chicken-parse.js';

/**
 * The first sentence the phone agent says on a call WE place about an order (Sarvam app_overrides
 * initial_bot_message), so the customer hears why we are calling instead of a general "how can I help?".
 * Facts come from the order row only. Tamil (Tamil script, as the Tamil voice reads it best) unless the customer
 * speaks English.
 */
type OrderFacts = {
  orderNumber: string;
  customerName: string | null;
  total: number;
  language: string | null;
  outlet: { name: string };
  items: Array<{ name: string; quantity: number; unit: string; cut: string | null }>;
  pickupAt?: Date | string;
};

export type CallLanguage = 'Tamil' | 'English';
export const callLanguage = (lang: string | null | undefined): CallLanguage => (lang === 'english' ? 'English' : 'Tamil');

const first = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] ?? '';
const rupees = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}`;
const itemsText = (o: OrderFacts) => o.items.map((i) => `${formatQty(i.quantity, i.unit).replace(' kg', ' kilo')} ${i.name}${i.cut ? ` ${i.cut}` : ''}`).join(', ');
/** The order number spoken clearly: "GR-8QSB25" -> "G R 8 Q S B 2 5". */
export const spellOrderNumber = (n: string) => n.replace(/-/g, ' ').split('').filter((c) => c !== ' ').join(' ');

export function readyCallOpening(o: OrderFacts): { message: string; language: CallLanguage } {
  const language = callLanguage(o.language);
  const name = first(o.customerName);
  const num = spellOrderNumber(o.orderNumber);
  if (language === 'English') {
    return { language, message: `Hello${name ? ` ${name}` : ''}, this is GR Chicken. Your order ${num} is ready: ${itemsText(o)}. The total is ${rupees(o.total)} rupees. You can collect it at ${o.outlet.name}. When will you come to pick it up?` };
  }
  return { language, message: `வணக்கம்${name ? ` ${name}` : ''}! GR Chicken-ல இருந்து பேசுறோம். உங்க order ${num} ready ஆ இருக்கு: ${itemsText(o)}. மொத்தம் ${rupees(o.total)} ரூபாய். ${o.outlet.name}-ல வந்து வாங்கிக்கலாம். எப்போ வருவீங்க?` };
}

export function orderCallOpening(o: OrderFacts & { status: string }): { message: string; language: CallLanguage } {
  const language = callLanguage(o.language);
  const name = first(o.customerName);
  const num = spellOrderNumber(o.orderNumber);
  if (language === 'English') {
    return { language, message: `Hello${name ? ` ${name}` : ''}, this is GR Chicken, calling about your order ${num}: ${itemsText(o)}, total ${rupees(o.total)} rupees. Is everything fine with your order?` };
  }
  return { language, message: `வணக்கம்${name ? ` ${name}` : ''}! GR Chicken-ல இருந்து பேசுறோம், உங்க order ${num} பத்தி: ${itemsText(o)}, மொத்தம் ${rupees(o.total)} ரூபாய். Order எல்லாம் சரியா இருக்கா?` };
}

/** Feedback call after collection: asks for a 1-5 rating (the feedback flow already understands the answer). */
export function feedbackCallOpening(o: { orderNumber: string; customerName: string | null; language: string | null }): { message: string; language: CallLanguage } {
  const language = callLanguage(o.language);
  const name = first(o.customerName);
  if (language === 'English') return { language, message: `Hello${name ? ` ${name}` : ''}, this is GR Chicken. Thank you for your order ${spellOrderNumber(o.orderNumber)}. How was it? Please rate it from 1 to 5.` };
  return { language, message: `வணக்கம்${name ? ` ${name}` : ''}! GR Chicken-ல இருந்து பேசுறோம். உங்க order ${spellOrderNumber(o.orderNumber)} எப்படி இருந்தது? 1 முதல் 5 வரை ஒரு மதிப்பெண் சொல்லுங்க.` };
}
