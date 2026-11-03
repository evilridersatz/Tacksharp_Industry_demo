import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { followUpConfig } from '../restaurant/followup-config.js';
import { recordWebhookFailure } from '../common/webhook-failures.js';
import { log } from '../common/logger.js';
import { BillingService } from './billing.service.js';
import { createPaymentLink, razorpayConfig, toPaise, validRazorpaySignature, type FetchLike } from './razorpay.js';

type Actor = { sub: string };
type LinkEntity = { id?: string; reference_id?: string; amount?: number; amount_paid?: number; currency?: string; status?: string };
type RzpEvent = { event?: string; payload?: { payment_link?: { entity?: LinkEntity }; payment?: { entity?: { id?: string; amount?: number; status?: string; method?: string } } } };

/**
 * Online payment of Tacksharp's invoices through Razorpay Payment Links. A link is created only by a platform admin,
 * never in DRY_RUN, and only with RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET set. An invoice becomes paid ONLY from a
 * webhook whose signature verifies AND whose link, invoice number, amount and currency all match; each event applies
 * once. Anything that does not match is recorded for staff and changes nothing.
 */
@Injectable()
export class PaymentsService {
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  status() {
    const cfg = razorpayConfig();
    return { razorpay: Boolean(cfg), webhook: Boolean(cfg?.webhookSecret), dryRun: followUpConfig().dryRun };
  }

  async createLink(actor: Actor, invoiceId: string) {
    const i = await this.prisma.platformInvoice.findUnique({ where: { id: invoiceId }, include: { organization: { select: { name: true } } } });
    if (!i) throw new NotFoundException('Invoice not found.');
    if (i.status !== 'issued') throw new BadRequestException(`This invoice is ${i.status}.`);
    if (i.paymentLinkId && i.paymentLinkStatus === 'created') throw new ConflictException('This invoice already has an open payment link.');
    const cfg = razorpayConfig();
    if (!cfg) throw new BadRequestException('Online payment is not set up: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not configured on the server.');
    if (!cfg.webhookSecret) throw new BadRequestException('Set RAZORPAY_WEBHOOK_SECRET first: without the webhook a payment could never mark the invoice paid.');
    if (followUpConfig().dryRun) throw new BadRequestException('DRY_RUN is on: payment links are not created in test mode.');
    const sub = i.subscriptionId ? await this.prisma.subscription.findUnique({ where: { id: i.subscriptionId }, include: { contract: { select: { billingEmail: true } } } }) : null;
    const now = Date.now();
    // Razorpay: at least 15 minutes ahead, at most 6 months. Due date, but never less than a day from now.
    const expireBy = Math.floor(Math.min(Math.max(i.dueAt.getTime(), now + 86_400_000), now + 170 * 86_400_000) / 1000);
    const referenceId = `${i.number}-${now.toString(36)}`;
    const r = await createPaymentLink(this.fetchImpl, cfg, {
      amountPaise: toPaise(Number(i.total)),
      referenceId,
      description: `Tacksharp invoice ${i.number}: ${i.description}`,
      expireBy,
      customer: { name: i.organization.name.slice(0, 100), ...(sub?.contract?.billingEmail ? { email: sub.contract.billingEmail } : {}) },
      notes: { invoiceId: i.id, invoiceNumber: i.number, organizationId: i.organizationId },
    });
    if (!r.ok) {
      await this.audit(i.organizationId, `platform:${actor.sub}`, i.id, 'invoice.payment_link_failed', { ambiguous: r.ambiguous });
      throw new BadRequestException(r.message);
    }
    await this.prisma.platformInvoice.update({ where: { id: i.id }, data: { paymentLinkId: r.id, paymentLinkUrl: r.shortUrl.slice(0, 300), paymentLinkStatus: r.status } });
    await this.audit(i.organizationId, `platform:${actor.sub}`, i.id, 'invoice.payment_link_created', { number: i.number, linkId: r.id });
    return { id: i.id, paymentLinkId: r.id, paymentLinkUrl: r.shortUrl, paymentLinkStatus: r.status };
  }

  /** POST /webhooks/razorpay. Refused (401) without a configured secret or a valid signature. */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined, eventId: string | undefined, body: unknown) {
    const cfg = razorpayConfig();
    if (!cfg?.webhookSecret) {
      recordWebhookFailure('whatsapp', 'razorpay_no_secret', '/webhooks/razorpay');
      throw new UnauthorizedException('Razorpay webhook secret not configured');
    }
    if (!validRazorpaySignature(rawBody, signature, cfg.webhookSecret)) {
      recordWebhookFailure('whatsapp', 'razorpay_signature_invalid', '/webhooks/razorpay');
      throw new UnauthorizedException('Invalid signature');
    }
    const e = body as RzpEvent;
    const event = String(e?.event ?? '').slice(0, 60);
    if (!eventId) return { ok: true, ignored: 'no event id' };
    try {
      await this.prisma.paymentWebhookEvent.create({ data: { provider: 'razorpay', eventId: eventId.slice(0, 100), event, outcome: 'processing' } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { ok: true, duplicate: true };
      throw err;
    }
    try {
      const outcome = await this.apply(event, e);
      await this.prisma.paymentWebhookEvent.update({ where: { provider_eventId: { provider: 'razorpay', eventId: eventId.slice(0, 100) } }, data: { outcome: outcome.slice(0, 200) } });
      log.info('razorpay.webhook', { event, outcome });
      return { ok: true, outcome };
    } catch (err) {
      // Let Razorpay retry: forget the claim.
      await this.prisma.paymentWebhookEvent.delete({ where: { provider_eventId: { provider: 'razorpay', eventId: eventId.slice(0, 100) } } }).catch(() => undefined);
      throw err;
    }
  }

  private async apply(event: string, e: RzpEvent): Promise<string> {
    if (!event.startsWith('payment_link.')) return 'ignored: not a payment link event';
    const link = e.payload?.payment_link?.entity;
    if (!link?.id) return 'ignored: no payment link';
    const i = await this.prisma.platformInvoice.findUnique({ where: { paymentLinkId: link.id } });
    if (!i) return 'ignored: unknown payment link';
    const status = String(link.status ?? event.slice('payment_link.'.length)).slice(0, 20);
    if (event !== 'payment_link.paid') {
      await this.prisma.platformInvoice.update({ where: { id: i.id }, data: { paymentLinkStatus: status } });
      await this.audit(i.organizationId, 'razorpay', i.id, `invoice.payment_link_${status}`, { number: i.number, amountPaid: link.amount_paid ?? 0 });
      return `link ${status}`;
    }
    const payment = e.payload?.payment?.entity;
    const expected = toPaise(Number(i.total));
    const problems = [
      !String(link.reference_id ?? '').startsWith(`${i.number}-`) && 'reference does not match the invoice number',
      link.currency !== 'INR' && `currency ${link.currency}`,
      link.amount_paid !== expected && `paid ${link.amount_paid} paise, invoice is ${expected}`,
      !payment?.id && 'no payment id',
    ].filter(Boolean) as string[];
    await this.prisma.platformInvoice.update({ where: { id: i.id }, data: { paymentLinkStatus: 'paid' } });
    if (problems.length) {
      await this.audit(i.organizationId, 'razorpay', i.id, 'invoice.payment_mismatch', { number: i.number, problems, paymentId: payment?.id ?? null });
      log.warn('razorpay.payment_mismatch', { invoice: i.number, problems });
      return `mismatch: ${problems.join('; ')}`;
    }
    if (i.status !== 'issued') {
      // Paid although void or already paid: money to refund or reconcile, never silently dropped.
      await this.audit(i.organizationId, 'razorpay', i.id, 'invoice.paid_needs_review', { number: i.number, status: i.status, paymentId: payment!.id });
      return `needs review: invoice was ${i.status}`;
    }
    const r = await this.prisma.platformInvoice.updateMany({ where: { id: i.id, status: 'issued' }, data: { status: 'paid', paidAt: new Date(), paymentReference: `razorpay:${payment!.id}`.slice(0, 120) } });
    if (!r.count) return 'already handled';
    await this.audit(i.organizationId, 'razorpay', i.id, 'invoice.paid', { number: i.number, via: 'razorpay', paymentId: payment!.id, method: payment?.method ?? null });
    await this.billing.refreshPastDue(i.organizationId);
    return 'paid';
  }

  private audit(org: string, actor: string, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId: org, actor, entityType: 'platform_invoice', entityId, action, data: data as Prisma.InputJsonValue } }).catch(() => undefined);
  }
}
