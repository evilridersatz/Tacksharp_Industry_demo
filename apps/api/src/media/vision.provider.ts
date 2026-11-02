import { providerCredentials } from '../integrations/provider-scope.js';
import { errorMessage, log } from '../common/logger.js';

/** What an image is, as far as a vision model can tell. Payment screenshots are recognised only to route them to staff. */
export const VISION_KINDS = ['food_photo', 'menu_screenshot', 'order_screenshot', 'payment_screenshot', 'document', 'other'] as const;
export type VisionKind = (typeof VISION_KINDS)[number];

export type VisionResult = {
  kind: VisionKind;
  /** One short sentence: what is in the picture. */
  description: string;
  /** Text read from the image (OCR), as written. */
  text: string;
  /** Products / quantities written or clearly shown (menu lines, order lines). Never prices the model invented. */
  items: Array<{ name: string; quantity?: number; unit?: string }>;
  /** 0..1, the model's own confidence in the reading. */
  confidence: number;
  provider: string;
  model: string;
};

export interface VisionProvider {
  readonly id: string;
  analyze(image: Buffer, mimeType: string, hint: { caption?: string; catalogue?: string[] }): Promise<VisionResult>;
}

export class VisionNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`vision not configured: ${reason}`);
    this.name = 'VisionNotConfiguredError';
  }
}

const PROMPT = [
  'You read images that customers send to a business on WhatsApp. Reply with ONE JSON object only:',
  '{"kind": one of food_photo | menu_screenshot | order_screenshot | payment_screenshot | document | other,',
  ' "description": one short plain sentence about what is shown,',
  ' "text": the text visible in the image, copied as written (empty if none),',
  ' "items": [{"name": product name, "quantity": number or null, "unit": "kg" | "g" | "piece" | null}] for products that are written or clearly shown,',
  ' "confidence": 0 to 1}.',
  'Rules: copy names and quantities only from what is visible; never invent prices, offers, discounts or availability;',
  'if a product looks like one in the business catalogue given, use the catalogue name; if unsure, lower the confidence;',
  'a UPI / bank / payment app screen is payment_screenshot (do not judge whether it is genuine).',
].join('\n');

/**
 * OpenAI (or OpenAI-compatible) vision model through the Chat Completions API with an inline image. Credentials come
 * from the organization's OpenAI integration (or the deployment's OPENAI_API_KEY for legacy organizations); the model
 * from VISION_MODEL, else the organization's configured OpenAI model. Never called when VISION_PROVIDER=none.
 */
export class OpenAIVisionProvider implements VisionProvider {
  readonly id = 'openai';
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    private readonly fetchImpl: typeof fetch = (u, i) => fetch(u, i),
  ) {}

  async analyze(image: Buffer, mimeType: string, hint: { caption?: string; catalogue?: string[] }): Promise<VisionResult> {
    const context = [hint.caption ? `Customer's caption: "${hint.caption.slice(0, 300)}"` : 'No caption.', hint.catalogue?.length ? `Business catalogue: ${hint.catalogue.slice(0, 80).join(', ')}` : ''].filter(Boolean).join('\n');
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        max_completion_tokens: 800,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: [{ type: 'text', text: context }, { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image.toString('base64')}`, detail: 'auto' } }] },
        ],
      }),
      signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS) || 30_000),
    });
    if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseVision(data.choices?.[0]?.message?.content ?? '', this.id, this.model);
  }
}

/** Strict reading of the model's JSON: unknown kinds, junk items and out-of-range confidence are normalised. */
export function parseVision(raw: string, provider: string, model: string): VisionResult {
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()) as Record<string, unknown>;
  } catch {
    return { kind: 'other', description: '', text: '', items: [], confidence: 0, provider, model };
  }
  const kind = (VISION_KINDS as readonly string[]).includes(String(j.kind)) ? (j.kind as VisionKind) : 'other';
  const items = Array.isArray(j.items)
    ? (j.items as Array<Record<string, unknown>>)
        .map((i) => ({ name: String(i?.name ?? '').trim().slice(0, 80), quantity: Number.isFinite(Number(i?.quantity)) && Number(i?.quantity) > 0 ? Number(i.quantity) : undefined, unit: ['kg', 'g', 'piece'].includes(String(i?.unit)) ? String(i.unit) : undefined }))
        .filter((i) => i.name)
        .slice(0, 20)
    : [];
  const c = Number(j.confidence);
  return {
    kind,
    description: String(j.description ?? '').trim().slice(0, 300),
    text: String(j.text ?? '').trim().slice(0, 2000),
    items,
    confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0,
    provider,
    model,
  };
}

/** The configured vision provider for the current organization, or a reason it is not available. */
export async function resolveVisionProvider(fetchImpl?: typeof fetch): Promise<VisionProvider> {
  const choice = (process.env.VISION_PROVIDER ?? 'openai').toLowerCase();
  if (choice === 'none') throw new VisionNotConfiguredError('VISION_PROVIDER=none');
  if (choice !== 'openai') throw new VisionNotConfiguredError(`unsupported VISION_PROVIDER ${choice}`);
  try {
    const cred = await providerCredentials('openai');
    if (cred.source === 'none' || !cred.secrets.apiKey) throw new VisionNotConfiguredError(cred.reason ?? 'no OpenAI account');
    return new OpenAIVisionProvider(cred.secrets.apiKey, process.env.VISION_MODEL || cred.config.model || 'gpt-5.4-mini', undefined, fetchImpl);
  } catch (error) {
    if (error instanceof VisionNotConfiguredError) throw error;
    log.warn('vision.resolve_failed', { error: errorMessage(error) });
    throw new VisionNotConfiguredError('credentials unavailable');
  }
}
