import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { AgentSessionStore } from './common.js';
import { FoodService } from './food/food.service.js';
import { FoodAgent } from './food/food-agent.js';
import { HotelService } from './hotel/hotel.service.js';
import { HotelAgent } from './hotel/hotel-agent.js';
import { HospitalService } from './hospital/hospital.service.js';
import { HospitalAgent } from './hospital/hospital-agent.js';
import { VerticalFollowUps } from './vertical-followups.service.js';
import { VerticalAssistant } from './vertical-assistant.service.js';
import { FoodController, HospitalController, HotelController } from './verticals.controller.js';

/**
 * Restaurant & food ordering, hotel & room booking, hospital & healthcare: backend-validated services, their
 * assistants (WhatsApp / voice / test chat via AiService) and follow-ups. Reuses customers, leads, conversations,
 * follow-ups, settings and the agent catalogue of the shared platform.
 */
@Module({
  imports: [ConversationsModule, LeadsModule, FollowUpsModule],
  controllers: [FoodController, HotelController, HospitalController],
  providers: [AgentSessionStore, FoodService, FoodAgent, HotelService, HotelAgent, HospitalService, HospitalAgent, VerticalFollowUps, VerticalAssistant],
  exports: [FoodService, HotelService, HospitalService, VerticalFollowUps, VerticalAssistant],
})
export class VerticalsModule {}
