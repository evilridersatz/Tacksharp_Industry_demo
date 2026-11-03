import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { TelephonyService } from '../telephony/telephony.service.js';
import { WhatsAppAmbiguousSendError, WhatsAppSenderService, WhatsAppTransientError } from '../whatsapp/whatsapp-sender.service.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';
import { firstName } from '../whatsapp/message-templates.js';
import { config } from '../common/config.js';
import { describeError } from '../common/errors.js';

export type OutreachResult =
  | { status: 'sent' | 'simulated' | 'skipped' | 'failed'; reason?: string; messageId?: string; retryable?: undefined }
  | { retryable: true; reason: string; retryAt?: Date; countsAsAttempt: boolean; status?: undefined };

export const fillVars = (text: string, v: { name: string; business: string }) => text.replace(/\{name\}/g, v.name).replace(/\{business\}/g, v.business);

/**
 * Business-initiated WhatsApp messages and AI calls for automation (drip sequences and workflows), one set of rules:
 * - WhatsApp: needs marketing consent or the customer having contacted the business; free text only inside the 24 h
 *   window, otherwise the step's approved template, otherwise skipped; the live gate (DRY_RUN / approved numbers /
 *   demo customers) decides whether anything reaches Meta; the message is saved in the conversation either way
 *   (labelled "not sent (test mode)" when simulated). A send whose delivery is unknown is never repeated.
 * - Call: needs calling consent or an enquiry; every telephony gate (hours, concurrency, DRY_RUN) applies.
 * Opt-out / do-not-contact are checked by the caller before (drip stops the enrolment; workflows skip the step).
 */
@Injectable()
export class OutreachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly whatsapp: WhatsAppSenderService,
    @Optional() private readonly telephony?: TelephonyService,
  ) {}

  async whatsApp(org: string, customerId: string, step: { text?: string; templateName?: string; templateLanguage?: string }, metadata: Record<string, unknown>): Promise<OutreachResult> {
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, organizationId: org } });
    if (!c) return { status: 'skipped', reason: 'Customer not found' };
    if (c.optedOutAt || c.doNotContact) return { status: 'skipped', reason: 'Customer opted out or is do-not-contact' };
    if (!c.phone) return { status: 'skipped', reason: 'No WhatsApp number for this customer' };
    if (!c.messagingConsent && !c.lastInboundAt) return { status: 'skipped', reason: 'No WhatsApp consent and the customer never contacted the business' };
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { name: true } });
    const vars = { name: firstName(c.name) || 'there', business: o?.name ?? config.defaultOrganizationName };
    const windowOpen = await this.conversations.isWhatsAppWindowOpen(org, c.id);
    const useText = windowOpen && Boolean(step.text);
    if (!useText && !step.templateName) return { status: 'skipped', reason: '24-hour window closed and no approved template on this step' };
    const content = useText ? fillVars(step.text!, vars) : `[template:${step.templateName}] ${vars.name} | ${vars.business}`;

    const gate = liveGate(followUpConfig(), { phone: c.phone, isDemo: c.isDemo });
    let messageId: string | undefined;
    if (gate.live) {
      try {
        messageId = useText
          ? await this.whatsapp.sendText(c.phone, content)
          : await this.whatsapp.sendCampaignTemplate(c.phone, { name: step.templateName!, language: step.templateLanguage ?? 'en', bodyParams: [vars.name, vars.business] });
      } catch (err) {
        if (err instanceof WhatsAppTransientError) return { retryable: true, reason: describeError(err), countsAsAttempt: true };
        if (err instanceof WhatsAppAmbiguousSendError) return { status: 'failed', reason: `Delivery unknown, not repeated: ${describeError(err)}` };
        return { status: 'failed', reason: describeError(err) };
      }
    }
    const conversation = await this.conversations.getOrCreateConversation({ organizationId: org, channel: 'whatsapp', externalId: c.phone, customerId: c.id });
    await this.conversations.addMessage({
      organizationId: org,
      conversationId: conversation.id,
      role: 'assistant',
      content,
      externalId: messageId,
      metadata: { ...metadata, kind: useText ? 'text' : 'template', ...(gate.live ? {} : { simulated: true, notSentReason: gate.reason }) } as never,
    });
    return gate.live ? { status: 'sent', messageId } : { status: 'simulated', reason: gate.reason };
  }

  /** What whatsApp() / call() would do for this customer, without sending or saving anything (studio test runs). */
  async preview(org: string, customerId: string, kind: 'whatsapp' | 'call', step: { text?: string; templateName?: string } = {}): Promise<{ wouldSend: boolean; reason?: string; content?: string }> {
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, organizationId: org } });
    if (!c) return { wouldSend: false, reason: 'Customer not found' };
    if (c.optedOutAt || c.doNotContact) return { wouldSend: false, reason: 'Customer opted out or is do-not-contact' };
    if (kind === 'call') {
      const enquired = await this.prisma.lead.count({ where: { customerId: c.id } });
      return !c.callingConsent && !enquired ? { wouldSend: false, reason: 'No calling consent and no enquiry from this customer' } : { wouldSend: true, reason: 'AI call (inside calling hours, through every telephony gate)' };
    }
    if (!c.phone) return { wouldSend: false, reason: 'No WhatsApp number for this customer' };
    if (!c.messagingConsent && !c.lastInboundAt) return { wouldSend: false, reason: 'No WhatsApp consent and the customer never contacted the business' };
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { name: true } });
    const vars = { name: firstName(c.name) || 'there', business: o?.name ?? config.defaultOrganizationName };
    const windowOpen = await this.conversations.isWhatsAppWindowOpen(org, c.id);
    if (windowOpen && step.text) return { wouldSend: true, content: fillVars(step.text, vars), reason: 'Free text (24-hour window open)' };
    if (step.templateName) return { wouldSend: true, content: `[template:${step.templateName}] ${vars.name} | ${vars.business}`, reason: 'Approved template (24-hour window closed)' };
    return { wouldSend: false, reason: '24-hour window closed and no approved template on this step' };
  }

  async call(org: string, customerId: string, purpose: string, idempotencyKey: string): Promise<OutreachResult> {
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, organizationId: org } });
    if (!c) return { status: 'skipped', reason: 'Customer not found' };
    if (c.optedOutAt || c.doNotContact) return { status: 'skipped', reason: 'Customer opted out or is do-not-contact' };
    const enquired = await this.prisma.lead.count({ where: { customerId: c.id } });
    if (!c.callingConsent && !enquired) return { status: 'skipped', reason: 'No calling consent and no enquiry from this customer' };
    if (!this.telephony) return { status: 'skipped', reason: 'Telephony module unavailable' };
    const r = await this.telephony.placeSystemCall({ organizationId: org, customerId: c.id, purpose, idempotencyKey });
    if (r.started) return { status: 'sent', messageId: r.requestId };
    if (r.dryRun) return { status: 'simulated', reason: 'DRY_RUN or not an approved live recipient: no call placed' };
    if (r.reason === 'outside_calling_hours' || r.reason === 'call_already_in_progress' || r.reason === 'concurrency_limit') {
      return { retryable: true, retryAt: r.retryAt ?? new Date(Date.now() + 15 * 60_000), reason: r.reason, countsAsAttempt: false };
    }
    return { status: 'skipped', reason: r.reason ?? 'call not started' };
  }
}
