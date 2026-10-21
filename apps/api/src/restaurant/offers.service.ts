import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';
import { firstName } from '../whatsapp/message-templates.js';
import { CatalogService } from './catalog.service.js';
import { OPEN_CLAIM_STATUSES } from './orders.service.js';
import { menuBlock, orderHint, say } from './replies.js';
import { followUpConfig, liveGate } from './followup-config.js';

export type ClaimSource = 'whatsapp_link' | 'website' | 'dashboard';
export type ClaimView = Awaited<ReturnType<OffersService['list']>>[number];

const num = (d: Prisma.Decimal | number) => Number(d);
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * The website offer: "₹50 off — claim it on WhatsApp". A claim is created three ways (the customer
 * taps the WhatsApp link and says hi, the GR Chicken website sends us the order, or staff add the
 * customer) and is used by at most one order (marked claimed inside the order transaction).
 */
@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly sender: WhatsAppSenderService,
    private readonly catalog: CatalogService,
  ) {}

  activeCampaign(organizationId: string) {
    return this.prisma.offerCampaign.findFirst({ where: { organizationId, active: true }, orderBy: { createdAt: 'asc' } });
  }

  /** The customer's offer that can still be used (newest first). */
  async openClaim(organizationId: string, customerId: string) {
    return this.prisma.offerClaim.findFirst({
      where: { organizationId, customerId, status: { in: OPEN_CLAIM_STATUSES }, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: { campaign: true },
    });
  }

  /**
   * The customer opened the chat (said hi / sent the link code). Uses their open offer, or creates
   * one from the WhatsApp link — once per customer per campaign, so the link cannot be farmed.
   */
  async startFromChat(organizationId: string, customerId: string, phone: string): Promise<{ claim?: Awaited<ReturnType<OffersService['openClaim']>>; alreadyUsed?: boolean }> {
    const open = await this.openClaim(organizationId, customerId);
    if (open) {
      if (open.status !== 'started') await this.prisma.offerClaim.update({ where: { id: open.id }, data: { status: 'started' } });
      return { claim: { ...open, status: 'started' } };
    }
    const campaign = await this.activeCampaign(organizationId);
    if (!campaign) return {};
    const used = await this.prisma.offerClaim.findFirst({ where: { organizationId, campaignId: campaign.id, customerId, source: 'whatsapp_link' } });
    if (used) return { alreadyUsed: true };
    const claim = await this.prisma.offerClaim.create({
      data: {
        organizationId,
        campaignId: campaign.id,
        customerId,
        phone,
        source: 'whatsapp_link',
        status: 'started',
        amount: campaign.amount,
        expiresAt: new Date(Date.now() + campaign.validDays * 86_400_000),
      },
      include: { campaign: true },
    });
    log.info('offer.claim_created', { organizationId, claimId: claim.id, source: 'whatsapp_link' });
    return { claim };
  }

  /**
   * Website order or staff: create the customer's offer and send the Tamil offer message on WhatsApp.
   * Inside the 24h window a normal message is sent; otherwise an approved template (campaign.templateName)
   * is required. Failures are recorded on the claim, never hidden: the customer can still start with the link.
   */
  async createAndSend(input: { organizationId: string; phone: string; name?: string; source: ClaimSource; websiteOrderRef?: string }) {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new BadRequestException(`Invalid phone number: ${input.phone}`);
    const ref = input.websiteOrderRef?.trim().slice(0, 100) || undefined;
    if (ref) {
      const existing = await this.prisma.offerClaim.findFirst({ where: { organizationId: input.organizationId, websiteOrderRef: ref } });
      if (existing) return { claim: await this.view(existing.id), duplicate: true };
    }
    const campaign = await this.activeCampaign(input.organizationId);
    if (!campaign) throw new BadRequestException('No active offer. Turn the offer on in the dashboard first.');

    const customer = await this.conversations.getOrCreateCustomerByPhone(input.organizationId, phone, { name: input.name?.trim().slice(0, 80) || undefined, source: input.source });
    if (customer.doNotContact || customer.optedOutAt) throw new BadRequestException('This customer opted out of messages.');
    const open = await this.openClaim(input.organizationId, customer.id);
    if (open) return { claim: await this.view(open.id), duplicate: true };

    let claim;
    try {
      claim = await this.prisma.offerClaim.create({
        data: {
          organizationId: input.organizationId,
          campaignId: campaign.id,
          customerId: customer.id,
          phone,
          source: input.source,
          websiteOrderRef: ref,
          status: 'pending_send',
          amount: campaign.amount,
          expiresAt: new Date(Date.now() + campaign.validDays * 86_400_000),
        },
      });
    } catch (error) {
      if (ref && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.offerClaim.findFirst({ where: { organizationId: input.organizationId, websiteOrderRef: ref } });
        if (raced) return { claim: await this.view(raced.id), duplicate: true };
      }
      throw error;
    }
    log.info('offer.claim_created', { organizationId: input.organizationId, claimId: claim.id, source: input.source });
    await this.send(input.organizationId, claim.id);
    return { claim: await this.view(claim.id), duplicate: false };
  }

  /** (Re)send the offer message for a claim. Records exactly what happened. */
  async send(organizationId: string, claimId: string) {
    const claim = await this.prisma.offerClaim.findFirst({ where: { id: claimId, organizationId }, include: { campaign: true, customer: true } });
    if (!claim) throw new NotFoundException('Offer not found');
    if (!['pending_send', 'send_failed', 'sent'].includes(claim.status)) return this.view(claim.id);
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    const catalog = await this.catalog.get(organizationId);
    const text = say.offerGreeting('tl', { name: firstName(claim.customer.name) || undefined, business: org?.name ?? 'GR Chicken', amount: num(claim.amount), menu: menuBlock(catalog, 'tl'), hint: orderHint(catalog) });
    if (claim.customer.optedOutAt) {
      await this.prisma.offerClaim.update({ where: { id: claim.id }, data: { status: 'cancelled', sendError: 'Customer opted out (STOP)' } });
      return this.view(claim.id);
    }
    const windowOpen = await this.conversations.isWhatsAppWindowOpen(organizationId, claim.customerId);
    let status = 'sent';
    let sendError: string | null = null;
    let stored: string | undefined;
    let simulated = false;
    const gate = liveGate(followUpConfig(), { phone: claim.phone, isDemo: claim.customer.isDemo });
    try {
      if (!gate.live) {
        // DRY_RUN / not an approved test number: record what would be sent, contact nobody.
        simulated = true;
        stored = windowOpen || !claim.campaign.templateName ? text : `[template:${claim.campaign.templateName}] offer ${num(claim.amount)}`;
        sendError = `Simulated (${gate.reason}): nothing was sent on WhatsApp.`;
      } else if (windowOpen) {
        await this.sender.sendText(claim.phone, text);
        stored = text;
      } else if (claim.campaign.templateName) {
        await this.sender.sendNamedTemplate(claim.phone, claim.campaign.templateName, [firstName(claim.customer.name) || 'Customer']);
        stored = `[template:${claim.campaign.templateName}] offer ${num(claim.amount)}`;
      } else {
        status = 'pending_send';
        sendError = 'No approved WhatsApp template for the first message (customer has not messaged in 24h). Share the WhatsApp link, or add the approved template name to the offer.';
      }
    } catch (error) {
      status = 'send_failed';
      sendError = errorMessage(error).slice(0, 500);
    }
    await this.prisma.offerClaim.update({ where: { id: claim.id }, data: { status, sendError } });
    if (stored) {
      const conv = await this.conversations.getOrCreateConversation({ organizationId, channel: 'whatsapp', externalId: claim.phone, customerId: claim.customerId });
      await this.conversations.addMessage({ organizationId, conversationId: conv.id, role: 'assistant', content: stored, metadata: { offerClaimId: claim.id, kind: 'offer_invite', simulated } });
    }
    log.info('offer.send', { organizationId, claimId: claim.id, status });
    return this.view(claim.id);
  }

  async view(claimId: string) {
    const c = await this.prisma.offerClaim.findUniqueOrThrow({ where: { id: claimId }, include: { customer: { select: { id: true, name: true, phone: true } }, order: { select: { id: true, orderNumber: true, total: true, status: true } } } });
    return toView(c);
  }

  async list(organizationId: string, filter: { status?: string; source?: string } = {}) {
    const rows = await this.prisma.offerClaim.findMany({
      where: { organizationId, ...(filter.status ? { status: filter.status } : {}), ...(filter.source ? { source: filter.source } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { customer: { select: { id: true, name: true, phone: true } }, order: { select: { id: true, orderNumber: true, total: true, status: true } } },
    });
    return rows.map(toView);
  }

  async stats(organizationId: string, since?: Date) {
    const where = { organizationId, ...(since ? { createdAt: { gte: since } } : {}) };
    const [byStatus, bySource] = await Promise.all([
      this.prisma.offerClaim.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.offerClaim.groupBy({ by: ['source'], where, _count: { _all: true } }),
    ]);
    const s = Object.fromEntries(byStatus.map((x) => [x.status, x._count._all])) as Record<string, number>;
    const total = byStatus.reduce((a, x) => a + x._count._all, 0);
    return {
      total,
      sent: (s.sent ?? 0) + (s.started ?? 0) + (s.claimed ?? 0),
      started: (s.started ?? 0) + (s.claimed ?? 0),
      claimed: s.claimed ?? 0,
      notSent: (s.pending_send ?? 0) + (s.send_failed ?? 0),
      byStatus: s,
      bySource: Object.fromEntries(bySource.map((x) => [x.source, x._count._all])),
    };
  }

  async updateCampaign(organizationId: string, id: string, patch: Record<string, unknown>) {
    const c = await this.prisma.offerCampaign.findFirst({ where: { id, organizationId } });
    if (!c) throw new NotFoundException('Offer not found');
    const data: Prisma.OfferCampaignUpdateInput = {};
    const money = (v: unknown, label: string) => {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10_000) throw new BadRequestException(`${label} must be between 0 and 10000.`);
      return new Prisma.Decimal(n.toFixed(2));
    };
    if (patch.amount !== undefined) data.amount = money(patch.amount, 'Amount');
    if (patch.minOrderValue !== undefined) data.minOrderValue = money(patch.minOrderValue, 'Minimum order');
    if (patch.validDays !== undefined) {
      const d = Number(patch.validDays);
      if (!Number.isInteger(d) || d < 1 || d > 365) throw new BadRequestException('validDays must be 1–365.');
      data.validDays = d;
    }
    if (patch.active !== undefined) {
      if (typeof patch.active !== 'boolean') throw new BadRequestException('active must be true or false.');
      data.active = patch.active;
    }
    if (patch.templateName !== undefined) data.templateName = typeof patch.templateName === 'string' && patch.templateName.trim() ? patch.templateName.trim().slice(0, 120) : null;
    return this.prisma.offerCampaign.update({ where: { id: c.id }, data });
  }

  /** New website API key. Only the hash is stored; the key is shown once. */
  async rotateWebsiteKey(organizationId: string) {
    const key = `grk_${randomBytes(24).toString('hex')}`;
    await this.prisma.$transaction([
      this.prisma.organizationChannel.deleteMany({ where: { organizationId, kind: 'website_api_key' } }),
      this.prisma.organizationChannel.create({ data: { organizationId, kind: 'website_api_key', externalId: hashKey(key) } }),
    ]);
    log.info('offer.website_key_rotated', { organizationId });
    return key;
  }
}

function toView(c: Prisma.OfferClaimGetPayload<{ include: { customer: { select: { id: true; name: true; phone: true } }; order: { select: { id: true; orderNumber: true; total: true; status: true } } } }>) {
  const expired = ['pending_send', 'sent', 'send_failed', 'started'].includes(c.status) && c.expiresAt.getTime() < Date.now();
  return {
    id: c.id,
    source: c.source,
    status: expired ? 'expired' : c.status,
    sendError: c.sendError,
    websiteOrderRef: c.websiteOrderRef,
    amount: num(c.amount),
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    customer: c.customer,
    order: c.order ? { ...c.order, total: num(c.order.total) } : null,
  };
}
