import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller.js';
import { WhatsAppService } from './whatsapp.service.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { RestaurantModule } from '../restaurant/restaurant.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { MarketingModule } from '../marketing/marketing.module.js';

import { DemoSessionsModule } from '../demo-sessions/demo-sessions.module.js';
@Module({
  imports: [FollowUpsModule, RestaurantModule, ConversationsModule, MarketingModule, DemoSessionsModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
})
export class WhatsAppModule {}
