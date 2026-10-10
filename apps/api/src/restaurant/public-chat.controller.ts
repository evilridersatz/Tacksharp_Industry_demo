import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { OrderingEngine } from './ordering-engine.service.js';

const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Website chat for restaurant tenants. Public (customers are not logged in): the tenant is resolved
 * from the public chat key in the URL (an OrganizationChannel row), never from the request body.
 * Rate limited per IP (RATE_LIMIT_PUBLIC_CHAT_PER_MIN).
 */
@Controller('public/chat')
export class PublicChatController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly engine: OrderingEngine,
  ) {}

  private async organizationFor(key: string): Promise<string> {
    const organizationId = await this.tenancy.resolve('web_chat_key', key);
    if (!organizationId || (await this.tenancy.vertical(organizationId)) !== 'restaurant') throw new NotFoundException('Chat not found');
    return organizationId;
  }

  @Public()
  @Get(':key')
  async info(@Param('key') key: string) {
    const organizationId = await this.organizationFor(key);
    const [org, demoItems] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
      this.prisma.menuItem.count({ where: { organizationId, isDemo: true } }),
    ]);
    return { businessName: org?.name ?? 'Restaurant', demo: demoItems > 0 };
  }

  @Public()
  @Post(':key/messages')
  @HttpCode(200)
  async message(@Param('key') key: string, @Body() body: { sessionId?: unknown; message?: unknown }) {
    const organizationId = await this.organizationFor(key);
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!SESSION_RE.test(sessionId)) throw new BadRequestException('sessionId must be 16-64 letters, digits, - or _.');
    if (!message) throw new BadRequestException('message is required.');
    if (message.length > 1000) throw new BadRequestException('message is too long (max 1000 characters).');

    const result = await this.engine.generate({ organizationId, channel: 'web', sessionId, message });
    // Only what the customer needs. No internal ids beyond the order reference.
    return {
      reply: result.response,
      step: result.state,
      cart: result.cart,
      order: result.order ? { orderNumber: result.order.orderNumber, total: result.order.total, duplicate: result.order.status === 'duplicate' } : null,
    };
  }
}
