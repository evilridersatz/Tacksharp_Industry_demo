import { Module } from '@nestjs/common';
import { TextileModule } from '../textile/textile.module.js';
import { InventoryService } from '../operations/inventory.service.js';
import { OperationsController } from '../operations/operations.controller.js';
import { AgentsController } from './agents.controller.js';
import { Orchestrator } from './orchestrator.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { FinanceEvents } from '../finance/finance-events.js';
import { FinanceController } from '../finance/finance.controller.js';
import { MarketingModule } from '../marketing/marketing.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { CollectionsService } from '../finance/collections.service.js';
import { FulfilmentService } from '../operations/fulfilment.service.js';
import { QualityService } from '../industry/quality.service.js';

/** AI Orchestrator + Marketing / Sales / Finance / Operations agents, Agent Centre and Operations API. */
@Module({
  imports: [TextileModule, MarketingModule, FollowUpsModule],
  controllers: [AgentsController, OperationsController, FinanceController],
  providers: [Orchestrator, InventoryService, FinanceService, FinanceEvents, CollectionsService, FulfilmentService, QualityService],
  exports: [Orchestrator, InventoryService, FinanceService, CollectionsService, FulfilmentService, QualityService],
})
export class AgentsModule {}
