import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { DemoLiveModule } from '../demo-live/demo-live.module.js';
import { MonitoringNotifier } from './notifier.service.js';
import { IncidentsService } from './incidents.service.js';
import { MonitoringEngine } from './engine.service.js';
import { MonitoringService } from './monitoring.service.js';
import { TechnicianAssistant } from './technician-assistant.service.js';
import { DemoFeedService } from './demo-feed.service.js';
import { VisionOpsScheduler } from './scheduler.service.js';
import { MonitoringAgentController, MonitoringController } from './monitoring.controller.js';

/**
 * Tacksharp VisionOps: CCTV camera health and downtime monitoring. Reuses the shared auth / tenancy, settings,
 * WhatsApp sender (DRY_RUN-gated), conversations and the industry registry (menu, agents, Data & APIs, scenarios).
 */
@Module({
  imports: [ConversationsModule, DemoLiveModule],
  controllers: [MonitoringController, MonitoringAgentController],
  providers: [MonitoringNotifier, IncidentsService, MonitoringEngine, MonitoringService, TechnicianAssistant, DemoFeedService, VisionOpsScheduler],
  exports: [MonitoringNotifier, IncidentsService, MonitoringEngine, MonitoringService, TechnicianAssistant, DemoFeedService, VisionOpsScheduler],
})
export class VisionOpsModule {}
