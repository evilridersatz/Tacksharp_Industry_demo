import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LlmRunner } from '../ai/llm-runner.service.js';
import { CatalogService } from './catalog.service.js';
import { OrdersService } from './orders.service.js';
import { OrderSessionStore } from './order-session.store.js';
import { OrderingEngine } from './ordering-engine.service.js';
import { RestaurantController } from './restaurant.controller.js';
import { PublicChatController } from './public-chat.controller.js';

/** Restaurant vertical (GR Chicken): menu, outlets, orders, ordering conversation and its dashboard API. */
@Module({
  imports: [ConversationsModule],
  controllers: [RestaurantController, PublicChatController],
  providers: [CatalogService, OrdersService, OrderSessionStore, OrderingEngine, LlmRunner],
  exports: [OrderingEngine, CatalogService, OrdersService],
})
export class RestaurantModule {}
