import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';

export class WhatsAppWindowClosedError extends Error {
  constructor() {
    super(
      'Customer has not messaged in the last 24h and no approved WhatsApp template is configured (WHATSAPP_TEMPLATE_NAME).',
    );
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
    if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId) {
      throw new Error('WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing');
    }
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number };
    };
    if (!response.ok) {
      const message = `WhatsApp API ${response.status}: ${data.error?.message ?? 'unknown error'} (code ${data.error?.code ?? '-'})`;
      // 4xx (bad number, template rejected, policy) won't succeed on retry; 429 / 5xx might.
      if (isPermanentWhatsAppError(response.status)) throw new UnrecoverableError(message);
      throw new Error(message);
    }
    return data.messages?.[0]?.id;
  }

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
