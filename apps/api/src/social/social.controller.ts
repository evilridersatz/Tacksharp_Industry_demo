import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Query, Req, UnauthorizedException, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators.js';
import { config } from '../common/config.js';
import { verifyMetaSignature } from '../common/meta-signature.js';
import { recordWebhookFailure } from '../common/webhook-failures.js';
import { SocialWebhookService } from './social-webhook.service.js';

/**
 * Meta webhook for Messenger (object "page") and Instagram (object "instagram"). Subscribe the Page's "messages" field
 * and the Instagram "messages" field to {PUBLIC_BASE_URL}/webhooks/meta-social.
 *
 * Unlike the older WhatsApp endpoint, the signature is ALWAYS required here: with no app secret available (neither the
 * organization's saved one nor META_APP_SECRET) every delivery is refused.
 */
@Controller('webhooks/meta-social')
export class SocialController {
  constructor(private readonly svc: SocialWebhookService) {}

  @Public()
  @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    const expected = process.env.META_SOCIAL_VERIFY_TOKEN || config.whatsapp.verifyToken;
    if (mode === 'subscribe' && token && expected && token === expected) return challenge;
    throw new ForbiddenException('Webhook verification failed');
  }

  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: unknown) {
    const secrets = await this.svc.appSecrets(body);
    if (!secrets.length && !config.whatsapp.appSecret) {
      recordWebhookFailure('whatsapp', 'social_no_app_secret', '/webhooks/meta-social');
      throw new UnauthorizedException('No app secret configured for this Page / Instagram account');
    }
    verifyMetaSignature(req.rawBody, signature, secrets);
    return this.svc.process(body);
  }
}
