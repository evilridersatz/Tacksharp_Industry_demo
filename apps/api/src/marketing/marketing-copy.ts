import { Agent, Runner } from '@openai/agents';
import { openaiRunner } from '../integrations/openai-runner.js';
import { configureClient, modelSettings } from 'ai/agents/real-estate-agent.js';
import { llmConfigured } from 'ai/agents/restaurant-agent.js';
import { errorMessage, log } from '../common/logger.js';

export const COPY_KINDS = ['caption', 'promo', 'reel_script', 'broadcast'] as const;
export type CopyKind = (typeof COPY_KINDS)[number];
export const COPY_LANGUAGES = ['english', 'tamil', 'tanglish'] as const;
export type CopyLanguage = (typeof COPY_LANGUAGES)[number];

/** Only these facts may appear in a draft. Prices only when approved; stock only as recorded. */
export type CopyProduct = {
  name: string;
  fabricCategory: string;
  colour?: string | null;
  composition?: string | null;
  design?: string | null;
  gsm?: number | null;
  width?: string | null;
  price?: number | null; // only set when priceApproved
  priceUnit: string;
  stockStatus: string; // in_stock | low | out_of_stock | unknown
};
export type CopyRequest = { kind: CopyKind; language: CopyLanguage; products: CopyProduct[]; offer?: string | null; occasion?: string | null; shopName: string };
export type CopyGeneration = { text: string; model: string | null; inputTokens?: number; outputTokens?: number };
export type CopyGenerator = (req: CopyRequest, factSheet: string) => Promise<CopyGeneration>;
export type CopyResult = { text: string; source: 'ai' | 'template'; model: string | null; inputTokens?: number; outputTokens?: number; removed: string[]; note?: string };

const KIND_RULE: Record<CopyKind, string> = {
  caption: 'An Instagram / WhatsApp status caption: 2-4 short lines, up to 3 relevant hashtags at the end.',
  promo: 'A short promotional message (3-5 lines) ending with "Reply to see photos or ask for a quotation."',
  reel_script: 'A 15-30 second Reels script: 4-6 numbered shots, each with what to show and one spoken line.',
  broadcast: 'A WhatsApp broadcast text (3-4 lines), friendly, ending with how to reply.',
};
const LANG_RULE: Record<CopyLanguage, string> = {
  english: 'Write in simple Indian English.',
  tamil: 'Write in Tamil script (product names and prices may stay in English).',
  tanglish: 'Write in Tanglish: Tamil words in English letters, as Chennai customers type on WhatsApp.',
};

export function factSheet(req: CopyRequest): string {
  const lines = req.products.map((p) => {
    const bits = [p.fabricCategory, p.colour, p.composition, p.design, p.gsm ? `${p.gsm} GSM` : null, p.width ? `width ${p.width}` : null].filter(Boolean).join(', ');
    const price = p.price !== null && p.price !== undefined ? `₹${p.price} per ${p.priceUnit}` : 'price: do not mention';
    const stock = p.stockStatus === 'in_stock' ? 'in stock' : p.stockStatus === 'low' ? 'limited stock' : 'availability: do not mention';
    return `- ${p.name}: ${bits}; ${price}; ${stock}`;
  });
  return [
    `SHOP: ${req.shopName}`,
    req.occasion ? `OCCASION: ${req.occasion}` : null,
    req.offer ? `OFFER (use exactly, add nothing): ${req.offer}` : 'OFFER: none. Do not mention any discount, offer, sale, free item or cashback.',
    'PRODUCTS (the ONLY facts you may use):',
    ...lines,
  ].filter(Boolean).join('\n');
}

/**
 * The grounding check. A sentence is removed when it states a number / price / percentage that is not in the fact
 * sheet, an offer when none was given, or availability / delivery that was not given. The model may phrase; it may
 * never decide prices, discounts, stock or delivery.
 */
export function groundCheck(text: string, req: CopyRequest): { text: string; removed: string[] } {
  const facts = factSheet(req);
  const allowedNumbers = new Set((facts.match(/\d+(?:\.\d+)?/g) ?? []).map((x) => String(Number(x))));
  const offerText = (req.offer ?? '').toLowerCase();
  const anyStock = req.products.some((p) => p.stockStatus === 'in_stock' || p.stockStatus === 'low');
  const OFFER = /\b(discount|offer|sale|free|cashback|% ?off|flat \d|buy \d+ get|combo|deal)\b|தள்ளுபடி|இலவசம்|ஆஃபர்/i;
  const STOCK = /\b(in stock|available now|limited stock|only \d+ left|few pieces left|stock available|ready stock)\b|ஸ்டாக்|கிடைக்கும்/i;
  const DELIVERY = /\b(delivery|deliver|shipping|dispatch)\w*\b|டெலிவரி/i;
  const removed: string[] = [];
  const parts = text.split(/(?<=[.!?\n])\s*/).filter((s) => s.trim());
  const kept = parts.filter((sentence) => {
    const s = sentence.toLowerCase();
    const numbers = (sentence.replace(/#\w+/g, '').match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => String(Number(x.replace(/,/g, ''))));
    // Numbered Reels shots ("1." / "Shot 2") are layout, not facts.
    const layout = /^\s*(shot\s*)?\d{1,2}[.):-]\s/i.test(sentence) ? [String(Number(sentence.match(/\d{1,2}/)![0]))] : [];
    const badNumber = numbers.find((x) => !allowedNumbers.has(x) && !layout.includes(x));
    const offer = OFFER.test(sentence) && !(offerText && OFFER.test(offerText) && s.includes(offerText.slice(0, 12)));
    const stock = STOCK.test(sentence) && !anyStock;
    const delivery = DELIVERY.test(sentence);
    if (badNumber || offer || stock || delivery) {
      removed.push(sentence.trim().slice(0, 300));
      return false;
    }
    return true;
  });
  return { text: kept.join(' ').replace(/\s+\n/g, '\n').trim(), removed };
}

/** Deterministic draft from the facts (used when no model is configured, or the model's draft was rejected). */
export function templateCopy(req: CopyRequest): string {
  const p = req.products[0];
  const line = p ? `${p.name}${p.colour ? ` in ${p.colour}` : ''}${p.composition ? ` (${p.composition})` : ''}${p.price !== null && p.price !== undefined ? ` - ₹${p.price}/${p.priceUnit}` : ''}` : `our ${req.occasion ?? 'new'} collection`;
  const offer = req.offer ? ` ${req.offer}.` : '';
  if (req.language === 'tamil') return `${req.shopName}: ${line}.${offer} புகைப்படங்கள் / quotation வேணும்னா reply பண்ணுங்க.`;
  if (req.language === 'tanglish') return `${req.shopName}: ${line}.${offer} Photos / quotation venum na reply pannunga.`;
  if (req.kind === 'reel_script') return `1. Close-up of ${p?.name ?? 'the fabric'}: "${line}". 2. Drape / fold shot: "Feel the fabric." 3. Shop front: "${req.shopName}." 4. End card: "Reply on WhatsApp for photos and a quotation."`;
  return `${line}.${offer} Reply to see photos or ask for a quotation - ${req.shopName}.`;
}

let agent: Agent | undefined;
/** The configured model (same OpenAI / OpenAI-compatible settings as the assistant). */
export const openAiCopyGenerator: CopyGenerator = async (req, sheet) => {
  configureClient();
  agent ??= new Agent({
    name: 'Tacksharp Marketing Copywriter',
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    modelSettings: modelSettings(process.env.OPENAI_REASONING_EFFORT || 'low', 600),
    instructions: [
      'You write marketing drafts for an Indian textile business. A person reviews and approves every draft before it is used.',
      'Use ONLY the facts given. Never invent prices, discounts, offers, stock, delivery times, product specifications or claims (no "best", "lowest", "guaranteed").',
      'If a price says "do not mention", do not mention a price for it. Output only the draft text, no explanations.',
    ].join('\n'),
    tools: [],
  });
  // The organization's own OpenAI key and model when configured, else the deployment's default.
  const acct = await openaiRunner();
  if (!acct.runner) throw new Error(`OpenAI is not configured for this organization (${acct.reason ?? 'no key'})`);
  const result = await acct.runner.run(agent, `${KIND_RULE[req.kind]}\n${LANG_RULE[req.language]}\n\n${sheet}`, { maxTurns: 1, signal: AbortSignal.timeout(30_000) });
  const usage = result.runContext?.usage;
  return { text: String(result.finalOutput ?? '').trim(), model: acct.model ?? (process.env.OPENAI_MODEL || 'gpt-5.4-mini'), inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens };
};

/**
 * A draft: the model when configured (grounded: unsupported sentences removed), otherwise / on failure the template.
 * The result says which, so the dashboard can label it.
 */
export async function generateCopy(req: CopyRequest, generator: CopyGenerator | null = llmConfigured() ? openAiCopyGenerator : null): Promise<CopyResult> {
  if (!req.products.length && !req.offer && !req.occasion) throw new Error('Choose at least one product, an occasion or an offer');
  if (!generator) return { text: templateCopy(req), source: 'template', model: null, removed: [], note: 'No AI model is configured (OPENAI_API_KEY / OPENAI_BASE_URL): template draft.' };
  const sheet = factSheet(req);
  try {
    const g = await generator(req, sheet);
    const checked = groundCheck(g.text, req);
    if (checked.text.length < 15) {
      return { text: templateCopy(req), source: 'template', model: g.model, inputTokens: g.inputTokens, outputTokens: g.outputTokens, removed: checked.removed, note: 'The AI draft made claims not in the catalogue and was rejected: template draft.' };
    }
    return { text: checked.text.slice(0, 4000), source: 'ai', model: g.model, inputTokens: g.inputTokens, outputTokens: g.outputTokens, removed: checked.removed, note: checked.removed.length ? `${checked.removed.length} unsupported sentence(s) removed.` : undefined };
  } catch (e) {
    log.warn('marketing.copy_failed', { error: errorMessage(e) });
    return { text: templateCopy(req), source: 'template', model: null, removed: [], note: `AI unavailable (${errorMessage(e).slice(0, 80)}): template draft.` };
  }
}
