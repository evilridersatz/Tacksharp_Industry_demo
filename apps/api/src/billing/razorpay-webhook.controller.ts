import { Body, Controller, Headers, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators.js';
import { PaymentsService } from './payments.service.js';

/** Razorpay webhook (payment_link.* events). Configure {PUBLIC_BASE_URL}/webhooks/razorpay with the webhook secret. */
@Controller('webhooks/razorpay')
export class RazorpayWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature: string | undefined, @Headers('x-razorpay-event-id') eventId: string | undefined, @Body() body: unknown) {
    return this.payments.webhook(req.rawBody, signature, eventId, body);
  }
}
