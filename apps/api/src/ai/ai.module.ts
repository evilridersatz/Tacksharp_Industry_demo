import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { ConversationEngine } from './conversation-engine.service.js';
import { SessionStore } from './session.store.js';
import { LlmRunner } from './llm-runner.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { SiteVisitsModule } from '../site-visits/site-visits.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { RestaurantModule } from '../restaurant/restaurant.module.js';
import { TextileModule } from '../textile/textile.module.js';
import { VerticalsModule } from '../verticals/verticals.module.js';
import { VisionOpsModule } from '../visionops/visionops.module.js';

@Module({
  imports: [ConversationsModule, LeadsModule, PropertiesModule, SiteVisitsModule, FollowUpsModule, RestaurantModule, TextileModule, VerticalsModule, VisionOpsModule],
  controllers: [AiController],
  providers: [AiService, ConversationEngine, SessionStore, LlmRunner],
  exports: [AiService],
})
export class AiModule {}
