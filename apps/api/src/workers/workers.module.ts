import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { MarketingModule } from '../marketing/marketing.module.js';
import { VoiceModule } from '../voice/voice.module.js';
import { RestaurantModule } from '../restaurant/restaurant.module.js';
import { VerticalsModule } from '../verticals/verticals.module.js';
import { FollowUpProcessor } from './follow-up.processor.js';
import { WhatsAppMessageProcessor } from './whatsapp-message.processor.js';
import { WorkersService } from './workers.service.js';

@Module({
  imports: [AiModule, ConversationsModule, LeadsModule, VoiceModule, FollowUpsModule, RestaurantModule, AgentsModule, MarketingModule, VerticalsModule],
  providers: [FollowUpProcessor, WhatsAppMessageProcessor, WorkersService],
})
export class WorkersModule {}
