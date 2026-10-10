import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { queueRedis } from '../queues/queues.js';
import { config } from '../common/config.js';
import { CatalogService } from './catalog.service.js';
import { OrdersService } from './orders.service.js';

const IST_OFFSET_MS = 330 * 60_000;
const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const startOfIstDay = () => new Date(Date.now() - ((Date.now() + IST_OFFSET_MS) % 86_400_000));
const ACTIVE = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery'];

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
  ) {}

  @Get('overview')
  async overview(@Org() organizationId: string, @Query('days') daysParam?: string) {
    const days = Math.min(Math.max(Number(daysParam) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const today = startOfIstDay();
    const notCancelled = { status: { not: 'cancelled' } };

    const [
      conversationsTotal, enquiriesInRange, ordersTotal, ordersInRange, byStatus, ordersToday, salesToday, salesInRange,
      convByChannel, ordersByChannel, recentOrders, recentConversations, handoffsOpen, convertedInRange, seriesRows, demoItems,
    ] = await Promise.all([
      this.prisma.conversation.count({ where: { organizationId } }),
      this.prisma.conversation.count({ where: { organizationId, Message: { some: { role: 'user', createdAt: { gte: since } } } } }),
      this.prisma.order.count({ where: { organizationId } }),
      this.prisma.order.count({ where: { organizationId, createdAt: { gte: since } } }),
      this.prisma.order.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
      this.prisma.order.count({ where: { organizationId, createdAt: { gte: today } } }),
      this.prisma.order.aggregate({ where: { organizationId, createdAt: { gte: today }, ...notCancelled }, _sum: { total: true } }),
      this.prisma.order.aggregate({ where: { organizationId, createdAt: { gte: since }, ...notCancelled }, _sum: { total: true } }),
      this.prisma.conversation.groupBy({ by: ['channel'], where: { organizationId }, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ['channel'], where: { organizationId }, _count: { _all: true } }),
      this.orders.list(organizationId, { limit: 8 }),
      this.prisma.conversation.findMany({
        where: { organizationId },
        orderBy: { updatedAt: 'desc' },
        take: 6,
        include: { Customer: { select: { id: true, name: true, phone: true } }, Message: { orderBy: { createdAt: 'desc' }, take: 1 } },
      }),
      this.prisma.conversation.count({ where: { organizationId, status: 'human_handoff' } }),
      this.prisma.order.findMany({ where: { organizationId, createdAt: { gte: since }, conversationId: { not: null } }, select: { conversationId: true }, distinct: ['conversationId'] }),
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
      enquiries: { total: conversationsTotal, inRange: enquiriesInRange },
      orders: {
        total: ordersTotal,
        inRange: ordersInRange,
        today: ordersToday,
        active: ACTIVE.reduce((s, k) => s + (status[k] ?? 0), 0),
        byStatus: status,
        conversionRate: enquiriesInRange ? Math.round((convertedInRange.length / enquiriesInRange) * 1000) / 10 : 0,
      },
      sales: { today: Number(salesToday._sum.total ?? 0), inRange: Number(salesInRange._sum.total ?? 0) },
      channels: ['web', 'whatsapp', 'voice'].map((channel) => ({
        channel,
        conversations: convByChannel.find((c) => c.channel === channel)?._count._all ?? 0,
        orders: ordersByChannel.find((c) => c.channel === channel)?._count._all ?? 0,
      })),
      handoffsOpen,
      recentOrders,
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

  @Patch('orders/:id')
  updateOrder(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: { status?: unknown; note?: unknown; paymentStatus?: unknown }) {
    return this.orders.updateStatus(organizationId, id, body ?? {}, user);
  }

  // ---- Menu --------------------------------------------------------------------------------

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
    if (user.role !== 'admin') throw new ForbiddenException('Only an admin can add menu items.');
    return this.catalog.createItem(organizationId, body ?? {}, `user:${user.sub}`);
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
      messages: conv.Message.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, metadata: m.metadata })),
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
      select: { id: true, name: true, phone: true, source: true, doNotContact: true, createdAt: true, lastInboundAt: true, _count: { select: { Conversation: true } } },
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
      select: { id: true, name: true, phone: true, email: true, source: true, doNotContact: true, createdAt: true, lastInboundAt: true },
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

  /** Marketing consent: staff record when a customer opts out of (or back into) promotional messages. */
  @Patch('customers/:id')
  async updateCustomer(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Param('id') id: string, @Body() body: { doNotContact?: unknown }) {
    requireStaff(user);
    if (typeof body?.doNotContact !== 'boolean') throw new BadRequestException('doNotContact must be true or false.');
    const res = await this.prisma.customer.updateMany({ where: { id, organizationId }, data: { doNotContact: body.doNotContact } });
    if (!res.count) throw new NotFoundException('Customer not found');
    return { ok: true, doNotContact: body.doNotContact };
  }

  // ---- Settings & integrations (status only, never secret values) -----------------------------

  @Get('integrations')
  async integrations(@Org() organizationId: string) {
    const [org, channels, outlets, db, redis, llm] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, vertical: true, createdAt: true } }),
      this.prisma.organizationChannel.findMany({ where: { organizationId }, select: { kind: true, externalId: true } }),
      this.catalog.get(organizationId, true).then((c) => c.outlets),
      check(() => this.prisma.$queryRaw`SELECT 1`),
      check(() => queueRedis.ping()),
      llmStatus(),
    ]);
    const waMapped = channels.some((c) => c.kind === 'whatsapp_phone_number_id') || (organizationId === config.defaultOrganizationId && Boolean(config.whatsapp.phoneNumberId));
    const webKey = channels.find((c) => c.kind === 'web_chat_key')?.externalId;
    return {
      tenant: org,
      outlets,
      health: { database: db, redis },
      llm,
      channels: {
        web: { connected: Boolean(webKey), chatKey: webKey ?? null, note: webKey ? 'Public website chat is live for this tenant.' : 'No website chat key. Run the GR Chicken seed or add an OrganizationChannel(kind=web_chat_key).' },
        whatsapp: {
          connected: waMapped && Boolean(config.whatsapp.accessToken) && Boolean(config.whatsapp.phoneNumberId),
          accessTokenSet: Boolean(config.whatsapp.accessToken),
          phoneNumberIdSet: Boolean(config.whatsapp.phoneNumberId),
          verifyTokenSet: Boolean(config.whatsapp.verifyToken),
          appSecretSet: Boolean(config.whatsapp.appSecret),
          mappedToThisTenant: waMapped,
          webhookUrl: `${config.publicBaseUrl}/webhooks/whatsapp`,
        },
        voice: { connected: false, note: 'Voice ordering is not built for restaurants yet. Calls to a restaurant number get a polite "order on WhatsApp or website" reply.' },
      },
      pos: { status: 'not_integrated', note: 'No GR Chicken POS API access yet. Orders stay in Tacksharp; staff confirm them here and enter them into the outlet POS.' },
      payments: { status: 'not_integrated', note: 'No payment gateway. Orders are cash on delivery / pay at outlet. Only staff can mark an order paid.' },
      delivery: { status: 'not_integrated', note: 'No delivery-partner API. Delivery orders are fulfilled by the outlet.' },
      campaigns: {
        sendingEnabled: false,
        templateConfigured: Boolean(config.whatsapp.templateName),
        note: 'Campaign sending is disabled. It needs WhatsApp credentials, an approved marketing template and recorded customer opt-in.',
      },
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

/** Which model the restaurant assistant would use and whether it answers. Never returns keys. */
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
