import { Global, Module } from '@nestjs/common';
import { BillingController, PlatformBillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

/** Global so the creation points (team, agents, workflows, drips, MCP keys) can check plan limits. */
@Global()
@Module({ controllers: [BillingController, PlatformBillingController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
