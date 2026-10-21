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
import { FeedbackService } from './feedback.service.js';
import { OrderFollowUpService } from './order-followup.service.js';
import { InventoryService } from './inventory.service.js';
import { StockAlertService } from './stock-alerts.service.js';

/** Restaurant vertical (GR Chicken): products, shops, ₹50 WhatsApp offer, pickup orders, ready calls, dashboard API. */
@Module({
  imports: [ConversationsModule],
  controllers: [RestaurantController, PublicOffersController, ReadyCallController],
  providers: [CatalogService, InventoryService, StockAlertService, OrdersService, OffersService, OrderSessionStore, OrderingEngine, ReadyNoticeService, FeedbackService, OrderFollowUpService, LlmRunner],
  exports: [OrderingEngine, CatalogService, InventoryService, StockAlertService, OrdersService, OffersService, ReadyNoticeService, FeedbackService, OrderFollowUpService],
})
export class RestaurantModule {}
