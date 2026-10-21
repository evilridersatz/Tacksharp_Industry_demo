import { randomUUID } from 'node:crypto';
import { config } from '../common/config.js';

/**
 * The exact WhatsApp Cloud API request body for a message (what WhatsAppSenderService posts).
 * Stored on the follow-up so staff can see what was (or, in dry-run, would have been) sent.
 */
export type WhatsAppPayload =
  | { messaging_product: 'whatsapp'; recipient_type: 'individual'; to: string; type: 'text'; text: { body: string; preview_url: false } }
  | {
      messaging_product: 'whatsapp';
      recipient_type: 'individual';
      to: string;
      type: 'template';
      template: { name: string; language: { code: string }; components?: Array<{ type: 'body'; parameters: Array<{ type: 'text'; text: string }> }> };
    };

export function textPayload(to: string, body: string): WhatsAppPayload {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false } };
}

export function templatePayload(to: string, name: string, params: string[], language = config.whatsapp.templateLanguage): WhatsAppPayload {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name,
      language: { code: language },
      ...(params.length ? { components: [{ type: 'body' as const, parameters: params.map((text) => ({ type: 'text' as const, text })) }] } : {}),
    },
  };
}

export type SendResult = { messageId: string; simulated: boolean };

/** What the follow-up processor needs from WhatsApp. */
export interface WhatsAppTransport {
  send(payload: WhatsAppPayload): Promise<SendResult>;
}

/** What the follow-up processor needs from the voice provider. */
export interface VoiceTransport {
  dial(input: { from: string; to: string; answerUrl: string; hangupUrl: string }): Promise<{ requestId?: string; simulated: boolean }>;
}

/** Dry-run WhatsApp: records the request, contacts nobody. */
export class MockWhatsAppTransport implements WhatsAppTransport {
  readonly sent: WhatsAppPayload[] = [];
  async send(payload: WhatsAppPayload): Promise<SendResult> {
    this.sent.push(payload);
    return { messageId: `dryrun-wamid-${randomUUID()}`, simulated: true };
  }
}

/** Dry-run voice: records the request, dials nobody. */
export class MockVoiceTransport implements VoiceTransport {
  readonly dialed: Array<{ from: string; to: string; answerUrl: string; hangupUrl: string }> = [];
  async dial(input: { from: string; to: string; answerUrl: string; hangupUrl: string }) {
    this.dialed.push(input);
    return { requestId: `dryrun-call-${randomUUID()}`, simulated: true };
  }
}

/** Real WhatsApp through the existing sender (one HTTP request per call; errors propagate for retry). */
export class LiveWhatsAppTransport implements WhatsAppTransport {
  constructor(
    private readonly sender: {
      sendText(to: string, text: string): Promise<string | undefined>;
      sendNamedTemplate(to: string, templateName: string, params: string[]): Promise<string | undefined>;
    },
  ) {}
  async send(payload: WhatsAppPayload): Promise<SendResult> {
    const id =
      payload.type === 'text'
        ? await this.sender.sendText(payload.to, payload.text.body)
        : await this.sender.sendNamedTemplate(payload.to, payload.template.name, payload.template.components?.[0]?.parameters.map((p) => p.text) ?? []);
    return { messageId: id ?? `wamid-unknown-${randomUUID()}`, simulated: false };
  }
}

/** Real calls through the existing Plivo dialer used by the order-ready call. */
export class LiveVoiceTransport implements VoiceTransport {
  constructor(private readonly dialer: (from: string, to: string, answerUrl: string, hangupUrl: string) => Promise<{ requestUuid?: string }>) {}
  async dial(input: { from: string; to: string; answerUrl: string; hangupUrl: string }) {
    const r = await this.dialer(input.from, input.to, input.answerUrl, input.hangupUrl);
    return { requestId: r.requestUuid, simulated: false };
  }
}
