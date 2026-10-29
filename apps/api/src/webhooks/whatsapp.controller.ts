import { Public } from '../auth/decorators.js';
import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Optional, Post, Query, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WhatsAppService } from './whatsapp.service.js';
import { config } from '../common/config.js';
import { verifyMetaSignature } from '../common/meta-signature.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { CredentialsService } from '../integrations/credentials.service.js';

@Controller('webhooks/whatsapp')
export class WhatsAppController {
  constructor(
    private readonly whatsappService: WhatsAppService,
    @Optional() private readonly tenancy?: TenancyService,
    @Optional() private readonly creds?: CredentialsService,
  ) {}

  /**
   * The app secret of the organization that owns the number in this delivery, when it runs its OWN WhatsApp app
   * (saved, tested, enabled credentials). The organization is found from Meta's phone_number_id, never the message.
   */
  private async orgAppSecrets(body: unknown): Promise<string[]> {
    if (!this.tenancy || !this.creds) return [];
    const ids = new Set<string>();
    for (const e of (body as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }> }> } | null)?.entry ?? [])
      for (const c of e.changes ?? []) if (c.value?.metadata?.phone_number_id) ids.add(String(c.value.metadata.phone_number_id));
    const out: string[] = [];
    for (const id of [...ids].slice(0, 3)) {
      const org = await this.tenancy.resolve('whatsapp_phone_number_id', id).catch(() => undefined);
      if (!org) continue;
      const r = await this.creds.resolve(org, 'whatsapp').catch(() => null);
      if (r?.source === 'organization' && r.secrets.appSecret) out.push(r.secrets.appSecret);
    }
    return out;
  }

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
  async receiveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
  ) {
    verifyMetaSignature(req.rawBody, signature, await this.orgAppSecrets(body));
    return this.whatsappService.processWebhook(body);
  }
}
