import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import { OffersService, hashKey } from './offers.service.js';

/**
 * For the GR Chicken website: after a customer orders there, the site calls
 *   POST /public/offers   x-api-key: <website key>
 *   { "phone": "9876543210", "name": "Priya", "websiteOrderId": "WEB-1042" }
 * and the assistant sends the Tamil ₹50 offer message on WhatsApp. The same websiteOrderId twice
 * returns the same offer (safe to retry). The tenant comes from the key, never from the body.
 */
@Controller('public/offers')
export class PublicOffersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly offers: OffersService,
  ) {}

  @Public()
  @Post()
  @HttpCode(200)
  async create(@Headers('x-api-key') key: string | undefined, @Body() body: { phone?: unknown; name?: unknown; websiteOrderId?: unknown }) {
    if (!key || key.length < 20) throw new UnauthorizedException('Missing API key');
    const channel = await this.prisma.organizationChannel.findUnique({ where: { kind_externalId: { kind: 'website_api_key', externalId: hashKey(key) } } });
    if (!channel) {
      log.warn('public_offers.bad_key', {});
      throw new UnauthorizedException('Invalid API key');
    }
    const result = await this.offers.createAndSend({
      organizationId: channel.organizationId,
      phone: String(body?.phone ?? ''),
      name: typeof body?.name === 'string' ? body.name : undefined,
      websiteOrderRef: typeof body?.websiteOrderId === 'string' || typeof body?.websiteOrderId === 'number' ? String(body.websiteOrderId) : undefined,
      source: 'website',
    });
    return {
      offerId: result.claim.id,
      status: result.claim.status,
      duplicate: result.duplicate,
      amount: result.claim.amount,
      expiresAt: result.claim.expiresAt,
      ...(result.claim.sendError ? { note: result.claim.sendError } : {}),
    };
  }
}
