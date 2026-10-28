import { Public } from '../auth/decorators.js';
import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Query, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WhatsAppService } from './whatsapp.service.js';
import { config } from '../common/config.js';
import { verifyMetaSignature } from '../common/meta-signature.js';

@Controller('webhooks/whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) {}

  @Public()
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    if (mode === 'subscribe' && token && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
      return challenge;
    }
    // Meta treats anything but the echoed challenge as a failure; 403 makes the refusal explicit (and testable).
    throw new ForbiddenException('Webhook verification failed');
  }

  @Public()
  @Post()
  @HttpCode(200)
  receiveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
  ) {
    verifyMetaSignature(req.rawBody, signature);
    return this.whatsappService.processWebhook(body);
  }
}
