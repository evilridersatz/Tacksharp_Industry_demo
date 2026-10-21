import { Org, Public } from '../../auth/decorators.js';
import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { MetaLeadsService } from './meta-leads.service.js';
import { config } from '../../common/config.js';
import { verifyMetaSignature } from '../../common/meta-signature.js';

@Controller('webhooks/meta/leads')
export class MetaLeadsController {
  constructor(private readonly metaLeadsService: MetaLeadsService) {}

  @Public()
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    if (mode === 'subscribe' && token && config.meta.leadVerifyToken && token === config.meta.leadVerifyToken) {
      return challenge;
    }
    return { success: false, message: 'Meta webhook verification failed' };
  }

  @Public()
  @Post()
  @HttpCode(200)
  receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
  ) {
    verifyMetaSignature(req.rawBody, signature);
    return this.metaLeadsService.processWebhook(body);
  }

  /**
   * LOCAL TESTING: simulate a Meta lead without Facebook.
   * curl -X POST localhost:3000/webhooks/meta/leads/test -H 'content-type: application/json' \
   *   -d '{"name":"Ravi","phone":"98xxxxxxxx","location":"Porur","budget":"80 lakhs","bhk":"2"}'
   * Disabled when NODE_ENV=production.
   */
  @Post('test')
  test(@Org() organizationId: string, @Body() body: { name?: string; phone: string; location?: string; budget?: string; bhk?: string; propertyType?: string }) {
    if (process.env.NODE_ENV === 'production') return { error: 'disabled in production' };
    const leadgenId = `test-${Date.now()}`;
    const field_data = Object.entries({
      full_name: body.name,
      phone_number: body.phone,
      location: body.location,
      budget: body.budget,
      bhk: body.bhk,
      property_type: body.propertyType,
    })
      .filter(([, v]) => v)
      .map(([name, v]) => ({ name, values: [String(v)] }));
    return this.metaLeadsService.handleLead(leadgenId, { id: leadgenId, campaign_name: 'local-test', field_data }, organizationId);
  }
}
