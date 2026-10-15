import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller.js';
import { WhatsAppService } from './whatsapp.service.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { RestaurantModule } from '../restaurant/restaurant.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';

@Module({
  imports: [FollowUpsModule, RestaurantModule, ConversationsModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
})
export class WhatsAppModule {}
