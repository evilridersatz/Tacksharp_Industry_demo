import { Global, Module } from '@nestjs/common';
import { BillingController, PlatformBillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayWebhookController } from './razorpay-webhook.controller.js';

/** Global so the creation points (team, agents, workflows, drips, MCP keys) can check plan limits. */
@Global()
@Module({ controllers: [BillingController, PlatformBillingController, RazorpayWebhookController], providers: [BillingService, PaymentsService], exports: [BillingService] })
export class BillingModule {}
