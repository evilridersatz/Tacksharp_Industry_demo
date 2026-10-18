/**
 * Customer messages for the textile flow (quotation, order updates, feedback). Facts come from the database only:
 * every amount, item and status here is what a salesperson entered or approved.
 */
import { formatInr } from './textile-rules.js';

type Lang = 'en' | 'ta';
export const langOf = (language?: string | null): Lang => (language && /^(ta|tamil|tanglish)/i.test(language) ? 'ta' : 'en');

const first = (name?: string | null) => (name ?? '').trim().split(/\s+/)[0] || '';

export function quotationMessage(
  q: { number: string; currency: string; total: number; validUntil?: Date | null; paymentTerms?: string | null; deliveryTerms?: string | null; items: Array<{ description: string; quantity: number; unit: string; unitPrice: number }> },
  customerName: string | null | undefined,
  org: string,
  lang: Lang,
): string {
  const lines = q.items.slice(0, 10).map((i) => `• ${i.description}: ${i.quantity} ${i.unit} × ${formatInr(i.unitPrice, q.currency)}`);
  const valid = q.validUntil ? q.validUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '';
  const extra = [q.paymentTerms && `Payment: ${q.paymentTerms}`, q.deliveryTerms && `Delivery: ${q.deliveryTerms}`].filter(Boolean).join('\n');
  if (lang === 'ta') {
    return [
      `வணக்கம் ${first(customerName)}! ${org} quotation ${q.number}:`,
      ...lines,
      `மொத்தம்: ${formatInr(q.total, q.currency)}${valid ? ` (${valid} வரை valid)` : ''}`,
      extra,
      'Order confirm பண்ணணும்னா "confirm" னு reply பண்ணுங்க, மாற்றம் வேணும்னா சொல்லுங்க.',
    ].filter(Boolean).join('\n');
  }
  return [
    `Hi ${first(customerName)}! Quotation ${q.number} from ${org}:`,
    ...lines,
    `Total: ${formatInr(q.total, q.currency)}${valid ? ` (valid till ${valid})` : ''}`,
    extra,
    'Reply "confirm" to go ahead, or tell us what to change.',
  ].filter(Boolean).join('\n');
}

export function quoteReminderMessage(number: string, customerName: string | null | undefined, lang: Lang): string {
  return lang === 'ta'
    ? `வணக்கம் ${first(customerName)}! Quotation ${number} பாத்தீங்களா? ஏதாவது சந்தேகம் இருந்தா கேளுங்க, இல்ல "confirm" னு reply பண்ணுங்க.`
    : `Hi ${first(customerName)}! Did you get a chance to look at quotation ${number}? Ask us anything, or reply "confirm" to go ahead.`;
}

export function orderStatusMessage(number: string, status: string, customerName: string | null | undefined, lang: Lang, dispatch?: { courier?: string | null; trackingRef?: string | null }): string | undefined {
  const track = dispatch?.courier || dispatch?.trackingRef ? ` (${[dispatch.courier, dispatch.trackingRef ? `tracking ${dispatch.trackingRef}` : null].filter(Boolean).join(', ')})` : '';
  const en: Record<string, string> = {
    confirmed: `Hi ${first(customerName)}! Your order ${number} is confirmed. We will update you when it is dispatched.`,
    dispatched: `Hi ${first(customerName)}! Your order ${number} has been dispatched${track}.`,
    delivered: `Hi ${first(customerName)}! Your order ${number} is marked delivered. Thank you for your business!`,
  };
  const ta: Record<string, string> = {
    confirmed: `வணக்கம் ${first(customerName)}! உங்க order ${number} confirm ஆயிடுச்சு. Dispatch ஆனதும் சொல்றோம்.`,
    dispatched: `வணக்கம் ${first(customerName)}! உங்க order ${number} dispatch ஆயிடுச்சு${track}.`,
    delivered: `வணக்கம் ${first(customerName)}! உங்க order ${number} deliver ஆயிடுச்சு. நன்றி!`,
  };
  return (lang === 'ta' ? ta : en)[status];
}

export function feedbackRequestMessage(number: string, customerName: string | null | undefined, lang: Lang): string {
  return lang === 'ta'
    ? `வணக்கம் ${first(customerName)}! Order ${number} எப்படி இருந்துச்சு? 1 முதல் 5 வரை ஒரு rating அனுப்புங்க (5 = ரொம்ப நல்லா இருந்துச்சு).`
    : `Hi ${first(customerName)}! How was order ${number}? Please reply with a rating from 1 to 5 (5 = excellent).`;
}

/** After a payment is VERIFIED by Finance (never for a claim or an unverified UTR). */
export function paymentReceivedMessage(p: { amount: number; invoiceNumber: string; balance: number }, customerName: string | null | undefined, lang: Lang): string {
  const bal = p.balance > 0.005 ? ` Balance on ${p.invoiceNumber}: ₹${p.balance}.` : ` ${p.invoiceNumber} is fully paid.`;
  return lang === 'ta'
    ? `வணக்கம் ${first(customerName)}! ₹${p.amount} payment கிடைச்சுடுச்சு (invoice ${p.invoiceNumber}). நன்றி!${bal}`
    : `Hi ${first(customerName)}! We have received your payment of ₹${p.amount} for invoice ${p.invoiceNumber}. Thank you!${bal}`;
}

/** A stock-shortage decision the owner approved: the approved text is sent as written, with the order number. */
export function orderRevisedMessage(number: string, approvedText: string, customerName: string | null | undefined, lang: Lang): string {
  return lang === 'ta' ? `வணக்கம் ${first(customerName)}! Order ${number}: ${approvedText}` : `Hi ${first(customerName)}! About your order ${number}: ${approvedText}`;
}
