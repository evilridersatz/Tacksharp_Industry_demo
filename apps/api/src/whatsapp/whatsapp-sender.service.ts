import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { describeError, isAmbiguousNetworkFailure, isConnectFailure } from '../common/errors.js';

export class WhatsAppWindowClosedError extends Error {
  constructor() {
    super(
      'Customer has not messaged in the last 24h and no approved WhatsApp template is configured (WHATSAPP_TEMPLATE_NAME).',
    );
  }
}

/**
 * A send that failed in a way that may be retried safely (Meta never got it, or told us to slow down / try later).
 * Tagged with the dependency so logs say "meta_graph", not just "fetch failed".
 */
export class WhatsAppTransientError extends Error {
  readonly dependency = 'meta_graph' as const;
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'WhatsAppTransientError';
  }
}

/**
 * The request may have reached Meta but no answer came back (read timeout / connection reset after sending).
 * The Cloud API has no idempotency key, so a retry could deliver the same message twice: never retried
 * automatically. The message is recorded with delivery status "unknown"; a delivery receipt, if it arrives,
 * cannot be matched (no message id), so staff see "unknown" and decide.
 */
export class WhatsAppAmbiguousSendError extends UnrecoverableError {
  readonly dependency = 'meta_graph' as const;
  readonly ambiguous = true;
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppAmbiguousSendError';
  }
}

/** Meta rejected the request for good (bad number, closed 24h window, template not approved, auth). */
export class WhatsAppPermanentError extends UnrecoverableError {
  readonly dependency = 'meta_graph' as const;
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = 'WhatsAppPermanentError';
  }
}

/**
 * Meta WhatsApp Cloud API sender.
 *
 * Meta rule: free-form text is only allowed within 24h of the customer's last message.
 * Outside that window (e.g. a fresh Meta Lead Ad lead) only an APPROVED TEMPLATE can be sent.
 */
@Injectable()
export class WhatsAppSenderService {
  private get url() {
    return `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  }

  /** Template for a follow-up step: its own approved template, else the shared one. */
  templateFor(step?: string): string {
    return (step && config.whatsapp.stepTemplates[step]) || config.whatsapp.templateName;
  }

  templateConfigured(step?: string) {
    return Boolean(this.templateFor(step));
  }

  private async post(body: Record<string, unknown>) {
    if (process.env.DRY_RUN !== 'false') {
      throw new WhatsAppPermanentError('DRY_RUN is on: WhatsApp provider request blocked', 0);
    }
    if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId) {
      // Configuration, not a network problem: retrying in a few seconds cannot fix it.
      throw new WhatsAppPermanentError('WhatsApp not configured: WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing', 0);
    }
    let response: Response;
    try {
      response = await (this.fetchImpl ?? fetch)(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.whatsapp.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }),
        signal: AbortSignal.timeout(config.whatsapp.sendTimeoutMs),
      });
    } catch (error) {
      // Which kind of network failure decides whether a retry is safe.
      if (isConnectFailure(error)) throw new WhatsAppTransientError(`WhatsApp API unreachable (not sent): ${describeError(error)}`);
      if (isAmbiguousNetworkFailure(error)) throw new WhatsAppAmbiguousSendError(`WhatsApp API did not answer after the request was sent (delivery unknown): ${describeError(error)}`);
      throw new WhatsAppTransientError(`WhatsApp API request failed: ${describeError(error)}`);
    }
    const data = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number };
    };
    if (!response.ok) {
      const message = `WhatsApp API ${response.status}: ${data.error?.message ?? 'unknown error'} (code ${data.error?.code ?? '-'})`;
      const kind = classifyWhatsAppFailure(response.status, data.error?.code);
      if (kind === 'permanent') throw new WhatsAppPermanentError(message, response.status, data.error?.code);
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new WhatsAppTransientError(message, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
    }
    return data.messages?.[0]?.id;
  }

  /** Tests inject a fake fetch; production uses the global one. */
  fetchImpl?: typeof fetch;

  async sendText(to: string, text: string) {
    const id = await this.post({ to, type: 'text', text: { preview_url: false, body: text.slice(0, 4000) } });
    log.info('whatsapp.sent_text', { to: mask(to), messageId: id, chars: text.length });
    return id;
  }

  async sendTemplate(to: string, params: string[], step?: string) {
    const templateName = this.templateFor(step);
    const count = Math.max(0, config.whatsapp.templateParams);
    const values = params.slice(0, count);
    while (values.length < count) values.push('-');

    const id = await this.post({
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: config.whatsapp.templateLanguage },
        ...(count > 0
          ? { components: [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }] }
          : {}),
      },
    });
    log.info('whatsapp.sent_template', { to: mask(to), messageId: id, template: templateName, step });
    return id;
  }

  /** A specific approved template with exactly these body variables (team alerts). */
  async sendNamedTemplate(to: string, templateName: string, params: string[]) {
    const id = await this.post({
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: config.whatsapp.templateLanguage },
        ...(params.length ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: text.slice(0, 1000) })) }] } : {}),
      },
    });
    log.info('whatsapp.sent_template', { to: mask(to), messageId: id, template: templateName });
    return id;
  }

  /**
   * A marketing campaign message: an APPROVED template chosen by the business (its own name and language), the body
   * variables filled for this customer and, when the template has an image header, the public https image link.
   */
  async sendCampaignTemplate(to: string, t: { name: string; language: string; bodyParams: string[]; headerImageUrl?: string }) {
    const components: Array<Record<string, unknown>> = [];
    if (t.headerImageUrl) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: t.headerImageUrl } }] });
    if (t.bodyParams.length) components.push({ type: 'body', parameters: t.bodyParams.map((text) => ({ type: 'text', text: text.slice(0, 1000) })) });
    const id = await this.post({ to, type: 'template', template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) } });
    log.info('whatsapp.sent_campaign_template', { to: mask(to), messageId: id, template: t.name });
    return id;
  }

  /**
   * Send `text` if the 24h window is open, otherwise the approved template.
   * Returns what was actually sent so it can be stored in the conversation.
   */
  async sendWithinPolicy(params: {
    to: string;
    windowOpen: boolean;
    text: string;
    templateParams: string[];
    /** Follow-up step (first_contact / reminder / final): picks the step's own approved template. */
    step?: string;
  }): Promise<{ kind: 'text' | 'template'; messageId?: string; content: string }> {
    if (params.windowOpen) {
      return { kind: 'text', messageId: await this.sendText(params.to, params.text), content: params.text };
    }
    if (!this.templateConfigured(params.step)) {
      throw new WhatsAppWindowClosedError();
    }
    const messageId = await this.sendTemplate(params.to, params.templateParams, params.step);
    return {
      kind: 'template',
      messageId,
      content: `[template:${this.templateFor(params.step)}] ${params.templateParams.join(' | ')}`,
    };
  }

  /** Downloads an incoming media file (voice note) from Meta. */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const meta = await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!meta.ok) throw new Error(`WhatsApp media lookup ${meta.status}`);
    const info = (await meta.json()) as { url: string; mime_type?: string };
    const file = await fetch(info.url, {
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!file.ok) throw new Error(`WhatsApp media download ${file.status}`);
    return {
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: (info.mime_type ?? 'audio/ogg').split(';')[0],
    };
  }
}

export function mask(phone: string) {
  return phone.length > 4 ? `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}` : phone;
}

/** 4xx except 408 / 429 are permanent; the job fails once instead of retrying. */
export function isPermanentWhatsAppError(status: number) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Meta error codes that arrive as HTTP 400 but mean "slow down / try later" (Cloud API error codes):
 * 4 app rate limit, 80007 WABA rate limit, 130429 throughput, 131056 pair rate limit, 1 / 2 temporary.
 */
const RETRYABLE_META_CODES = new Set([1, 2, 4, 80007, 130429, 131056]);

/**
 * permanent: never retried (bad number, 24h window closed (131047), template missing / not approved / wrong
 * parameters (132xxx), auth (401 / 403, code 190)). retryable: 408, 429, 5xx and Meta's rate-limit codes.
 */
export function classifyWhatsAppFailure(status: number, metaCode?: number): 'permanent' | 'retryable' {
  if (metaCode !== undefined && RETRYABLE_META_CODES.has(metaCode)) return 'retryable';
  if (status === 401 || status === 403) return 'permanent';
  return isPermanentWhatsAppError(status) ? 'permanent' : 'retryable';
}
