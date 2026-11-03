import { WorkflowsModule } from '../workflows/workflows.module.js';
import { Module } from '@nestjs/common';
import { MetaCapiModule } from '../meta-capi/meta-capi.module.js';
import { DripModule } from '../drip/drip.module.js';
import { MultimodalService } from '../media/multimodal.service.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { AiModule } from '../ai/ai.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { MarketingModule } from '../marketing/marketing.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { RestaurantModule } from '../restaurant/restaurant.module.js';
import { VerticalsModule } from '../verticals/verticals.module.js';
import { VisionOpsModule } from '../visionops/visionops.module.js';
import { FollowUpProcessor } from './follow-up.processor.js';
import { WhatsAppMessageProcessor } from './whatsapp-message.processor.js';
import { WorkersService } from './workers.service.js';

@Module({
  imports: [InboxModule, DripModule, MetaCapiModule, WorkflowsModule, AiModule, ConversationsModule, LeadsModule, TelephonyModule, FollowUpsModule, RestaurantModule, AgentsModule, MarketingModule, VerticalsModule, VisionOpsModule],
  providers: [FollowUpProcessor, WhatsAppMessageProcessor, WorkersService, MultimodalService],
})
export class WorkersModule {}
