import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LlmRunner } from '../ai/llm-runner.service.js';
import { CatalogService } from './catalog.service.js';
import { OrdersService } from './orders.service.js';
import { OffersService } from './offers.service.js';
import { OrderSessionStore } from './order-session.store.js';
import { OrderingEngine } from './ordering-engine.service.js';
import { ReadyNoticeService } from './ready-notice.service.js';
import { RestaurantController } from './restaurant.controller.js';
import { PublicOffersController } from './public-offers.controller.js';
import { ReadyCallController } from './ready-call.controller.js';

/** Restaurant vertical (GR Chicken): products, shops, ₹50 WhatsApp offer, pickup orders, ready calls, dashboard API. */
@Module({
  imports: [ConversationsModule],
  controllers: [RestaurantController, PublicOffersController, ReadyCallController],
  providers: [CatalogService, OrdersService, OffersService, OrderSessionStore, OrderingEngine, ReadyNoticeService, LlmRunner],
  exports: [OrderingEngine, CatalogService, OrdersService, OffersService, ReadyNoticeService],
})
export class RestaurantModule {}
