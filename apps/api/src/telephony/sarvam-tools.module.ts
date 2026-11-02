import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { RestaurantModule } from '../restaurant/restaurant.module.js';
import { SarvamToolsController } from './sarvam-tools.controller.js';
import { SarvamToolsService } from './sarvam-tools.service.js';

@Module({
  imports: [RestaurantModule, ConversationsModule],
  controllers: [SarvamToolsController],
  providers: [SarvamToolsService],
  exports: [SarvamToolsService],
})
export class SarvamToolsModule {}
