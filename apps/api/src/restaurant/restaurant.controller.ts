import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { queueRedis } from '../queues/queues.js';
import { config } from '../common/config.js';
import { CatalogService } from './catalog.service.js';
import { OrdersService } from './orders.service.js';
import { OffersService } from './offers.service.js';
import { OrderingEngine } from './ordering-engine.service.js';
import { ReadyNoticeService } from './ready-notice.service.js';
import { findPhone } from './chicken-parse.js';
import { OrderFollowUpService, DEMO_SCENARIOS, type DemoScenario } from './order-followup.service.js';
import { followUpConfig } from './followup-config.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { InventoryService } from './inventory.service.js';
import { InboundMessageService } from '../whatsapp/inbound-messages.service.js';

const IST_OFFSET_MS = 330 * 60_000;
const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const startOfIstDay = (offsetDays = 0) => new Date(Date.now() - ((Date.now() + IST_OFFSET_MS) % 86_400_000) + offsetDays * 86_400_000);
const ACTIVE = ['pending', 'confirmed', 'preparing', 'ready'];

function requireStaff(user: SessionClaims) {
  if (user.role === 'viewer') throw new ForbiddenException('Your role can only view.');
}

/** Restaurant dashboard API. Organization always comes from the session; every query is scoped by it. */
@Controller('restaurant')
export class RestaurantController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly engine: OrderingEngine,
    private readonly ready: ReadyNoticeService,
    private readonly followUps: OrderFollowUpService,
    private readonly tenancy: TenancyService,
    private readonly inventory: InventoryService,
    private readonly inbound: InboundMessageService,
  ) {}

  @Get('overview')
  async overview(@Org() organizationId: string, @Query('days') daysParam?: string) {
    const days = Math.min(Math.max(Number(daysParam) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const today = startOfIstDay();
    const tomorrow = startOfIstDay(1);
    const notCancelled = { status: { not: 'cancelled' } };

    const [offerStats, ordersInRange, byStatus, salesInRange, discountInRange, pickupsToday, upcoming, readyNotices, recentConversations, handoffsOpen, seriesRows, demoItems] =
      await Promise.all([
        this.offers.stats(organizationId, since),
        this.prisma.order.count({ where: { organizationId, createdAt: { gte: since } } }),
        this.prisma.order.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
        this.prisma.order.aggregate({ where: { organizationId, createdAt: { gte: since }, ...notCancelled }, _sum: { total: true } }),
        this.prisma.order.aggregate({ where: { organizationId, createdAt: { gte: since }, ...notCancelled }, _sum: { discount: true } }),
        this.prisma.order.count({ where: { organizationId, pickupAt: { gte: today, lt: tomorrow }, ...notCancelled } }),
        this.orders.list(organizationId, { status: 'active', limit: 8 }),
        this.prisma.order.groupBy({ by: ['readyNotice'], where: { organizationId, readyNotice: { not: null }, updatedAt: { gte: since } }, _count: { _all: true } }),
        this.prisma.conversation.findMany({
          where: { organizationId },
          orderBy: { updatedAt: 'desc' },
          take: 6,
          include: { Customer: { select: { id: true, name: true, phone: true } }, Message: { orderBy: { createdAt: 'desc' }, take: 1 } },
        }),
        this.prisma.conversation.count({ where: { organizationId, status: 'human_handoff' } }),
        this.prisma.order.findMany({ where: { organizationId, createdAt: { gte: since } }, select: { createdAt: true, total: true, status: true } }),
        this.prisma.menuItem.count({ where: { organizationId, isDemo: true } }),
      ]);

    const buckets = Array.from({ length: days }, (_, i) => istDay(new Date(Date.now() - (days - 1 - i) * 86_400_000)));
    const series = buckets.map((day) => {
      const rows = seriesRows.filter((r) => istDay(r.createdAt) === day);
      return { day, orders: rows.length, sales: rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + Number(r.total), 0) };
    });
    const status = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    return {
      days,
      offers: { ...offerStats, claimRate: offerStats.sent ? Math.round((offerStats.claimed / offerStats.sent) * 1000) / 10 : 0 },
      orders: { inRange: ordersInRange, active: ACTIVE.reduce((s, k) => s + (status[k] ?? 0), 0), byStatus: status, pickupsToday },
      sales: { inRange: Number(salesInRange._sum.total ?? 0), discountGiven: Number(discountInRange._sum.discount ?? 0) },
      readyNotices: Object.fromEntries(readyNotices.map((r) => [r.readyNotice ?? 'none', r._count._all])),
      upcoming,
      handoffsOpen,
      recentConversations: recentConversations.map((c) => ({
        id: c.id,
        channel: c.channel,
        status: c.status,
        updatedAt: c.updatedAt,
        customer: c.Customer,
        lastMessage: c.Message[0] ? { role: c.Message[0].role, content: c.Message[0].content.slice(0, 160), createdAt: c.Message[0].createdAt } : null,
      })),
      series,
      demoData: demoItems > 0,
    };
  }

  // ---- Orders ------------------------------------------------------------------------------

  @Get('orders')
  listOrders(@Org() organizationId: string, @Query('status') status?: string, @Query('q') q?: string, @Query('outletId') outletId?: string) {
    return this.orders.list(organizationId, { status, q, outletId });
  }

  @Get('orders/:id')
  getOrder(@Org() organizationId: string, @Param('id') id: string) {
    return this.orders.getOrder(organizationId, id);
  }

  /** Staff status / payment change. Marking Ready triggers the customer call (in the background). */
  @Patch('orders/:id')
  async updateOrder(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: { status?: unknown; note?: unknown; paymentStatus?: unknown }) {
    const { order, changedTo } = await this.orders.updateStatus(organizationId, id, body ?? {}, user);
    if (changedTo === 'ready') void this.ready.notify(organizationId, order.id);
    if (changedTo) await this.followUps.onStatusChanged(organizationId, order.id, changedTo).catch(() => undefined);
    return order;
  }

  /** "Call again" from the order screen. */
  @Post('orders/:id/notify-ready')
  async notifyReady(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string) {
    requireStaff(user);
    const order = await this.orders.getOrder(organizationId, id);
    if (order.status !== 'ready') throw new BadRequestException('Only orders that are Ready can be notified.');
    await this.ready.notify(organizationId, id);
    return this.orders.getOrder(organizationId, id);
  }

  // ---- Products ----------------------------------------------------------------------------

  @Get('menu')
  menu(@Org() organizationId: string) {
    return this.catalog.get(organizationId, true);
  }

  @Patch('menu/items/:id')
  updateItem(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requireStaff(user);
    return this.catalog.updateItem(organizationId, id, body ?? {}, `user:${user.sub}`);
  }

  @Post('menu/items')
  createItem(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: Record<string, unknown>) {
    if (user.role !== 'admin') throw new ForbiddenException('Only an admin can add products.');
    return this.catalog.createItem(organizationId, body ?? {}, `user:${user.sub}`);
  }

  // ---- Inventory (stock on hand) -----------------------------------------------------------

  /** Stock per product for this organization (any signed-in role can view). */
  @Get('inventory')
  inventoryList(@Org() organizationId: string) {
    return this.inventory.list(organizationId);
  }

  /** Set counted stock, add / remove a quantity, or change the low-stock level. Staff and admins only. */
  @Patch('inventory/:id')
  inventoryUpdate(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requireStaff(user);
    return this.inventory.update(organizationId, id, body ?? {}, `user:${user.sub}`);
  }

  /** Recent stock movements of one product (orders, cancellations, staff changes). */
  @Get('inventory/:id/movements')
  inventoryMovements(@Org() organizationId: string, @Param('id') id: string) {
    return this.inventory.movements(organizationId, id);
  }

  /** Latest stock movements across all products (orders, cancellations, staff changes, demo seed). */
  @Get('inventory-movements')
  inventoryRecentMovements(@Org() organizationId: string, @Query('limit') limit?: string) {
    return this.inventory.recentMovements(organizationId, Number(limit) || 30);
  }

  // ---- Activity (carts being built, WhatsApp processing) ----------------------------------

  /** Carts customers are building now (WhatsApp, phone, test chat), priced from the catalogue. */
  @Get('carts')
  carts(@Org() organizationId: string) {
    return this.engine.activeCarts(organizationId);
  }

  /** Inbound WhatsApp messages with processing / reply status (received, queued, replied, unknown, failed). */
  @Get('whatsapp-inbound')
  whatsappInbound(@Org() organizationId: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    const allowed = ['received', 'queued', 'processing', 'replied', 'reply_unknown', 'failed', 'skipped'];
    if (status && !allowed.includes(status)) throw new BadRequestException(`status must be one of ${allowed.join(', ')}`);
    return this.inbound.recent(organizationId, { status, limit: Number(limit) || 50 });
  }

  // ---- Offer (₹50 website offer) -----------------------------------------------------------

  @Get('offers')
  async offerOverview(@Org() organizationId: string, @Query('status') status?: string, @Query('source') source?: string) {
    const [campaign, claims, stats, waNumber, websiteKey] = await Promise.all([
      this.offers.activeCampaign(organizationId).then((c) => c ?? this.prisma.offerCampaign.findFirst({ where: { organizationId }, orderBy: { createdAt: 'asc' } })),
      this.offers.list(organizationId, { status, source }),
      this.offers.stats(organizationId),
      this.prisma.organizationChannel.findFirst({ where: { organizationId, kind: 'whatsapp_display_number' } }),
      this.prisma.organizationChannel.findFirst({ where: { organizationId, kind: 'website_api_key' } }),
    ]);
    const linkText = campaign ? `Vanakkam GR Chicken! En ₹${Number(campaign.amount)} offer claim pannanum (${campaign.code})` : '';
    return {
      campaign: campaign && { ...campaign, amount: Number(campaign.amount), minOrderValue: Number(campaign.minOrderValue) },
      stats,
      claims,
      whatsappLink: waNumber && campaign ? `https://wa.me/${waNumber.externalId}?text=${encodeURIComponent(linkText)}` : null,
      whatsappLinkNote: waNumber ? null : 'Set the WhatsApp business number (GR_WHATSAPP_DISPLAY_NUMBER in the seed) to get the claim link.',
      website: { keyConfigured: Boolean(websiteKey), endpoint: `${config.publicBaseUrl}/public/offers` },
    };
  }

  @Patch('offers/campaign/:id')
  updateCampaign(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (user.role !== 'admin') throw new ForbiddenException('Only an admin can change the offer.');
    return this.offers.updateCampaign(organizationId, id, body ?? {});
  }

  /** Staff add customers who ordered on the website: one number per line, optional name after a comma. */
  @Post('offers/send')
  async sendOffers(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { entries?: unknown }) {
    requireStaff(user);
    const raw = typeof body?.entries === 'string' ? body.entries : '';
    const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50);
    if (!lines.length) throw new BadRequestException('Add at least one phone number.');
    const results = [];
    for (const line of lines) {
      const phone = findPhone(line);
      if (!phone) {
        results.push({ input: line, ok: false, error: 'No valid mobile number' });
        continue;
      }
      const name = line.replace(/(?:\+?91)?[\s-]*[6-9](?:[\s-]*\d){9}/, '').replace(/^[\s,;-]+|[\s,;-]+$/g, '').slice(0, 80) || undefined;
      try {
        const r = await this.offers.createAndSend({ organizationId, phone, name, source: 'dashboard' });
        results.push({ input: line, ok: true, duplicate: r.duplicate, status: r.claim.status, note: r.claim.sendError });
      } catch (e) {
        results.push({ input: line, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { results };
  }

  @Post('offers/:id/resend')
  resendOffer(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string) {
    requireStaff(user);
    return this.offers.send(organizationId, id);
  }

  /** New key for the website integration; shown once, only its hash is stored. */
  @Post('offers/website-key')
  async rotateWebsiteKey(@Org() organizationId: string, @CurrentUser() user: SessionClaims) {
    if (user.role !== 'admin') throw new ForbiddenException('Only an admin can create API keys.');
    return { key: await this.offers.rotateWebsiteKey(organizationId), note: 'Copy it now: it will not be shown again.' };
  }

  // ---- Test chat (same conversation as WhatsApp, nothing is sent) ---------------------------

  @Post('test-chat')
  async testChat(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { phone?: unknown; message?: unknown; name?: unknown }) {
    requireStaff(user);
    const phone = findPhone(String(body?.phone ?? ''));
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!phone) throw new BadRequestException('Enter a 10-digit test mobile number.');
    if (!message || message.length > 1000) throw new BadRequestException('Message must be 1–1000 characters.');
    const r = await this.engine.generate({ organizationId, channel: 'test', phone, message, customerName: typeof body?.name === 'string' ? body.name.slice(0, 60) : undefined });
    return { reply: r.response, step: r.state, draft: r.draft, order: r.order ?? null, path: r.path };
  }

  // ---- Conversations -----------------------------------------------------------------------

  @Get('conversations')
  async conversations(@Org() organizationId: string, @Query('channel') channel?: string, @Query('status') status?: string) {
    const rows = await this.prisma.conversation.findMany({
      where: { organizationId, ...(channel ? { channel } : {}), ...(status ? { status } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        Customer: { select: { id: true, name: true, phone: true } },
        Message: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { Message: true } },
      },
    });
    const orderCounts = await this.prisma.order.groupBy({
      by: ['conversationId'],
      where: { organizationId, conversationId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    return rows.map((c) => ({
      id: c.id,
      channel: c.channel,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      customer: c.Customer,
      messageCount: c._count.Message,
      orderCount: orderCounts.find((o) => o.conversationId === c.id)?._count._all ?? 0,
      lastMessage: c.Message[0] ? { role: c.Message[0].role, content: c.Message[0].content.slice(0, 200), createdAt: c.Message[0].createdAt } : null,
    }));
  }

  @Get('conversations/:id')
  async conversation(@Org() organizationId: string, @Param('id') id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, organizationId },
      include: { Customer: { select: { id: true, name: true, phone: true, doNotContact: true } }, Message: { orderBy: { createdAt: 'asc' }, take: 500 } },
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    const orderIds = await this.prisma.order.findMany({
      where: { organizationId, OR: [{ conversationId: conv.id }, ...(conv.customerId ? [{ customerId: conv.customerId }] : [])] },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true },
    });
    const orders = await Promise.all(orderIds.map((o) => this.orders.getOrder(organizationId, o.id)));
    return {
      id: conv.id,
      channel: conv.channel,
      status: conv.status,
      createdAt: conv.createdAt,
      customer: conv.Customer,
      messages: conv.Message.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, metadata: m.metadata, deliveryStatus: m.deliveryStatus })),
      orders,
    };
  }

  /** Staff take over / hand back / close a conversation. */
  @Patch('conversations/:id')
  async updateConversation(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: { status?: unknown }) {
    requireStaff(user);
    const allowed = ['active', 'human_handoff', 'closed'];
    if (typeof body?.status !== 'string' || !allowed.includes(body.status)) throw new BadRequestException(`status must be one of ${allowed.join(', ')}`);
    const res = await this.prisma.conversation.updateMany({ where: { id, organizationId }, data: { status: body.status, updatedAt: new Date() } });
    if (!res.count) throw new NotFoundException('Conversation not found');
    return { ok: true, status: body.status };
  }

  // ---- Customers ---------------------------------------------------------------------------

  @Get('customers')
  async customers(@Org() organizationId: string, @Query('q') q?: string) {
    const term = q?.trim();
    const customers = await this.prisma.customer.findMany({
      where: {
        organizationId,
        ...(term ? { OR: [{ name: { contains: term } }, { phone: { contains: term.replace(/\D/g, '') || term } }] } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 300,
      select: { id: true, name: true, phone: true, source: true, doNotContact: true, createdAt: true, lastInboundAt: true, messagingConsent: true, callingConsent: true, optedOutAt: true, isDemo: true, _count: { select: { Conversation: true } } },
    });
    const stats = await this.prisma.order.groupBy({
      by: ['customerId'],
      where: { organizationId, customerId: { in: customers.map((c) => c.id) }, status: { not: 'cancelled' } },
      _count: { _all: true },
      _sum: { total: true },
      _max: { createdAt: true },
    });
    return customers.map((c) => {
      const s = stats.find((x) => x.customerId === c.id);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        source: c.source,
        doNotContact: c.doNotContact,
        messagingConsent: c.messagingConsent,
        callingConsent: c.callingConsent,
        optedOutAt: c.optedOutAt,
        isDemo: c.isDemo,
        createdAt: c.createdAt,
        lastInboundAt: c.lastInboundAt,
        conversations: c._count.Conversation,
        orders: s?._count._all ?? 0,
        totalSpend: Number(s?._sum.total ?? 0),
        lastOrderAt: s?._max.createdAt ?? null,
      };
    });
  }

  @Get('customers/:id')
  async customer(@Org() organizationId: string, @Param('id') id: string) {
    const c = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      select: { id: true, name: true, phone: true, email: true, source: true, doNotContact: true, createdAt: true, lastInboundAt: true, messagingConsent: true, callingConsent: true, optedOutAt: true, isDemo: true },
    });
    if (!c) throw new NotFoundException('Customer not found');
    const [orders, conversations] = await Promise.all([
      this.prisma.order.findMany({ where: { organizationId, customerId: c.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } }),
      this.prisma.conversation.findMany({
        where: { organizationId, customerId: c.id },
        orderBy: { updatedAt: 'desc' },
        include: { Message: { orderBy: { createdAt: 'desc' }, take: 1 }, _count: { select: { Message: true } } },
      }),
    ]);
    return {
      ...c,
      orders: await Promise.all(orders.map((o) => this.orders.getOrder(organizationId, o.id))),
      conversations: conversations.map((cv) => ({ id: cv.id, channel: cv.channel, status: cv.status, updatedAt: cv.updatedAt, messageCount: cv._count.Message, lastMessage: cv.Message[0]?.content.slice(0, 160) ?? null })),
    };
  }

  /** Consent recorded by staff: do-not-contact, WhatsApp messaging consent, calling consent. */
  @Patch('customers/:id')
  async updateCustomer(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: { doNotContact?: unknown; messagingConsent?: unknown; callingConsent?: unknown }) {
    requireStaff(user);
    const data: { doNotContact?: boolean; messagingConsent?: boolean; callingConsent?: boolean } = {};
    for (const k of ['doNotContact', 'messagingConsent', 'callingConsent'] as const) {
      if (body?.[k] === undefined) continue;
      if (typeof body[k] !== 'boolean') throw new BadRequestException(`${k} must be true or false.`);
      data[k] = body[k] as boolean;
    }
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to update.');
    const customer = await this.prisma.customer.findFirst({ where: { id, organizationId } });
    if (!customer) throw new NotFoundException('Customer not found');
    // A customer who replied STOP is only re-enabled by their own START.
    if (customer.optedOutAt && (data.messagingConsent || data.callingConsent)) throw new BadRequestException('This customer replied STOP. Only the customer can opt back in (by replying START).');
    await this.prisma.customer.update({ where: { id: customer.id }, data });
    return { ok: true, ...data };
  }

  // ---- Follow-ups (WhatsApp + voice) ---------------------------------------------------------

  @Get('followups')
  async listFollowUps(@Org() organizationId: string, @Query('status') status?: string, @Query('channel') channel?: string, @Query('kind') kind?: string, @Query('orderId') orderId?: string) {
    const rows = await this.prisma.orderFollowUp.findMany({
      where: {
        organizationId,
        ...(status === 'open' ? { status: { in: ['scheduled', 'retrying', 'processing', 'calling'] } } : status ? { status } : {}),
        ...(channel ? { channel } : {}),
        ...(kind ? { kind } : {}),
        ...(orderId ? { orderId } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 300,
      include: { order: { select: { id: true, orderNumber: true, isDemo: true, status: true } }, customer: { select: { id: true, name: true, phone: true, isDemo: true } } },
    });
    const callIds = rows.map((r) => r.callId).filter((x): x is string => Boolean(x));
    const calls = callIds.length ? await this.prisma.call.findMany({ where: { organizationId, id: { in: callIds } }, select: { id: true, status: true, outcome: true, durationSec: true, summary: true, answeredAt: true, endedAt: true } }) : [];
    return rows.map((r) => ({ ...r, call: calls.find((c) => c.id === r.callId) ?? null }));
  }

  @Get('followups/summary')
  async followUpSummary(@Org() organizationId: string) {
    const cfg = followUpConfig();
    const [byStatus, byKind, rated, complaintsOpen, complaintsResolved, demoOrders] = await Promise.all([
      this.prisma.orderFollowUp.groupBy({ by: ['status', 'channel'], where: { organizationId }, _count: { _all: true } }),
      this.prisma.orderFollowUp.groupBy({ by: ['kind'], where: { organizationId }, _count: { _all: true } }),
      this.prisma.order.aggregate({ where: { organizationId, feedbackRating: { not: null } }, _avg: { feedbackRating: true }, _count: { feedbackRating: true } }),
      this.prisma.order.count({ where: { organizationId, complaintStatus: 'open' } }),
      this.prisma.order.count({ where: { organizationId, complaintStatus: 'resolved' } }),
      this.prisma.order.findMany({ where: { organizationId, isDemo: true, status: 'completed' }, orderBy: { orderNumber: 'asc' }, select: { id: true, orderNumber: true, customerName: true, demoScenario: true } }),
    ]);
    const count = (pred: (r: (typeof byStatus)[number]) => boolean) => byStatus.filter(pred).reduce((a, r) => a + r._count._all, 0);
    return {
      mode: cfg.dryRun ? 'dry_run' : 'live',
      liveTestRecipients: cfg.liveTestRecipients.length,
      liveAllowAll: cfg.liveAllowAll,
      settings: { feedbackDelayMinutes: cfg.feedbackDelayMinutes, callDelayMinutes: cfg.callDelayMinutes, callMaxAttempts: cfg.callMaxAttempts, callRetryMinutes: cfg.callRetryMinutes, feedbackTemplateSet: Boolean(cfg.feedbackTemplate), confirmationTemplateSet: Boolean(cfg.confirmationTemplate) },
      scheduled: count((r) => ['scheduled', 'retrying', 'processing', 'calling'].includes(r.status)),
      whatsappSent: count((r) => r.channel === 'whatsapp' && ['sent', 'delivered', 'read', 'completed'].includes(r.status)),
      whatsappDelivered: count((r) => r.channel === 'whatsapp' && ['delivered', 'read'].includes(r.status)),
      callsAnswered: count((r) => r.channel === 'voice' && r.status === 'completed'),
      callsNoAnswer: count((r) => r.channel === 'voice' && r.status === 'no_answer'),
      failed: count((r) => r.status === 'failed'),
      skipped: count((r) => ['skipped', 'cancelled'].includes(r.status)),
      byKind: Object.fromEntries(byKind.map((k) => [k.kind, k._count._all])),
      averageRating: rated._avg.feedbackRating ? Math.round(rated._avg.feedbackRating * 10) / 10 : null,
      ratings: rated._count.feedbackRating,
      complaintsOpen,
      complaintsResolved,
      demoOrders,
      scenarios: DEMO_SCENARIOS,
    };
  }

  /** Dashboard "Run demo follow-up": always simulated, through the real queue + processor. */
  @Post('followups/demo-run')
  async demoRun(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { orderId?: unknown; scenario?: unknown }) {
    requireStaff(user);
    const scenario = String(body?.scenario ?? 'call_happy') as DemoScenario;
    if (!DEMO_SCENARIOS.includes(scenario)) throw new BadRequestException(`scenario must be one of ${DEMO_SCENARIOS.join(', ')}`);
    try {
      return await this.followUps.runDemo(organizationId, { orderId: typeof body?.orderId === 'string' ? body.orderId : undefined, scenario });
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  @Post('followups/:id/cancel')
  async cancelFollowUp(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string) {
    requireStaff(user);
    const r = await this.prisma.orderFollowUp.updateMany({ where: { id, organizationId, status: { in: ['scheduled', 'retrying'] } }, data: { status: 'cancelled', lastError: `Cancelled by staff`, completedAt: new Date() } });
    if (!r.count) throw new BadRequestException('Only scheduled follow-ups can be cancelled.');
    return { ok: true };
  }

  /** Feedback and complaints, newest first. */
  @Get('feedback')
  async feedbackList(@Org() organizationId: string, @Query('filter') filter?: string) {
    const rows = await this.prisma.order.findMany({
      where: {
        organizationId,
        ...(filter === 'complaints' ? { complaintStatus: { not: null } } : filter === 'open' ? { complaintStatus: 'open' } : { OR: [{ feedbackRating: { not: null } }, { complaintStatus: { not: null } }] }),
      },
      orderBy: { feedbackAt: 'desc' },
      take: 200,
      select: { id: true, orderNumber: true, customerName: true, customerPhone: true, customerId: true, conversationId: true, feedbackRating: true, feedbackComment: true, feedbackAt: true, feedbackChannel: true, complaintStatus: true, complaintNote: true, isDemo: true, total: true },
    });
    return rows.map((r) => ({ ...r, total: Number(r.total) }));
  }

  @Patch('orders/:id/complaint')
  async updateComplaint(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: { status?: unknown; note?: unknown }) {
    requireStaff(user);
    if (body?.status !== 'resolved' && body?.status !== 'open') throw new BadRequestException('status must be resolved or open.');
    const order = await this.prisma.order.findFirst({ where: { id, organizationId } });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.complaintStatus) throw new BadRequestException('This order has no complaint.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    await this.prisma.order.update({ where: { id: order.id }, data: { complaintStatus: body.status } });
    await this.prisma.orderEvent.create({ data: { organizationId, orderId: order.id, type: 'complaint', actor: `user:${user.sub}`, note: `Complaint ${body.status === 'resolved' ? 'resolved' : 're-opened'} by staff${note ? `: ${note}` : ''}` } });
    if (body.status === 'resolved' && order.conversationId) await this.prisma.conversation.updateMany({ where: { id: order.conversationId, organizationId, status: 'human_handoff' }, data: { status: 'active', updatedAt: new Date() } });
    return { ok: true, status: body.status };
  }

  // ---- Settings & integrations (status only, never secret values) -----------------------------

  @Get('integrations')
  async integrations(@Org() organizationId: string) {
    const [org, channels, outlets, db, redis, llm, campaign] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, vertical: true, createdAt: true } }),
      this.prisma.organizationChannel.findMany({ where: { organizationId }, select: { kind: true, externalId: true } }),
      this.catalog.get(organizationId, true).then((c) => c.outlets),
      check(() => this.prisma.$queryRaw`SELECT 1`),
      check(() => queueRedis.ping()),
      llmStatus(),
      this.offers.activeCampaign(organizationId),
    ]);
    const waMapped = channels.some((c) => c.kind === 'whatsapp_phone_number_id') || (organizationId === config.defaultOrganizationId && Boolean(config.whatsapp.phoneNumberId));
    const voice = this.ready.voiceStatus();
    const fu = followUpConfig();
    // Where this deployment's WhatsApp / Plivo numbers are routed: an unmapped number reaches DEFAULT_ORGANIZATION_ID.
    const routing = (await this.tenancy.mappingReport().catch(() => [])).map((r) => ({
      kind: r.kind,
      configured: r.configured,
      number: r.masked,
      toThisBusiness: r.organizationId === organizationId,
      via: r.via,
      vertical: r.vertical,
    }));
    return {
      routing,
      tenant: org,
      outlets,
      health: { database: db, redis },
      // Safety mode of this server: in dry-run nothing is sent and no restaurant call is placed.
      mode: { dryRun: fu.dryRun, liveTestRecipients: fu.liveTestRecipients.length, liveAllowAll: fu.liveAllowAll },
      llm,
      channels: {
        whatsapp: {
          connected: waMapped && Boolean(config.whatsapp.accessToken) && Boolean(config.whatsapp.phoneNumberId),
          accessTokenSet: Boolean(config.whatsapp.accessToken),
          phoneNumberIdSet: Boolean(config.whatsapp.phoneNumberId),
          verifyTokenSet: Boolean(config.whatsapp.verifyToken),
          appSecretSet: Boolean(config.whatsapp.appSecret),
          mappedToThisTenant: waMapped,
          displayNumberSet: channels.some((c) => c.kind === 'whatsapp_display_number'),
          offerTemplateSet: Boolean(campaign?.templateName),
          orderReadyTemplateSet: Boolean(config.whatsapp.stepTemplates.order_ready),
          webhookUrl: `${config.publicBaseUrl}/webhooks/whatsapp`,
        },
        voice: {
          connected: voice.ready,
          missing: voice.missing,
          callingHours: `${config.voice.callWindowStartHour}:00–${config.voice.callWindowEndHour}:00 IST`,
          answerUrl: `${config.publicBaseUrl}/voice/ready/answer`,
          signatureCheck: config.plivo.validateSignature,
          note: voice.ready ? 'The assistant calls the customer in Tamil when staff mark an order Ready; WhatsApp if unanswered.' : 'Ready calls are off until these are set; the ready message goes on WhatsApp instead.',
        },
        website: { keyConfigured: channels.some((c) => c.kind === 'website_api_key'), endpoint: `${config.publicBaseUrl}/public/offers` },
      },
      pos: { status: 'not_integrated', note: 'No GR Chicken POS API access yet. Orders stay in Tacksharp; staff confirm them here.' },
      payments: { status: 'not_integrated', note: 'No payment gateway. Customers pay cash or UPI at the shop; "paid online" is the customer\'s word until staff verify it.' },
    };
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function check(fn: () => Promise<unknown>) {
  const t = Date.now();
  try {
    await withTimeout(fn(), 3000);
    return { ok: true, ms: Date.now() - t };
  } catch (error) {
    return { ok: false, ms: Date.now() - t, error: error instanceof Error ? error.message : 'error' };
  }
}

/** Which model the assistant would use and whether it answers. Never returns keys. */
async function llmStatus() {
  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  if (baseUrl) {
    let host = 'configured';
    try {
      const u = new URL(baseUrl);
      host = `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
    } catch {
      /* keep generic */
    }
    const reach = await check(async () => {
      const r = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    });
    return { provider: 'local (OpenAI-compatible, e.g. llama.cpp)', model, host, configured: true, reachable: reach.ok, error: reach.ok ? undefined : reach.error };
  }
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model, configured: true, reachable: null, note: 'API key present (not tested from the dashboard).' };
  return { provider: 'none', model: null, configured: false, reachable: false, note: 'No model configured. Ordering still works (rules); free-form questions get a standard help reply.' };
}
