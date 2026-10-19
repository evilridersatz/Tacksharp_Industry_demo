import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { MonitoringNotifier } from './notifier.service.js';
import { IncidentsService } from './incidents.service.js';
import { MonitoringEngine } from './engine.service.js';
import { MonitoringService } from './monitoring.service.js';
import { TechnicianAssistant } from './technician-assistant.service.js';
import { MonitoringAgentController, MonitoringController } from './monitoring.controller.js';

/**
 * Tacksharp VisionOps: CCTV camera health and downtime monitoring. Reuses the shared auth / tenancy, settings,
 * WhatsApp sender (DRY_RUN-gated), conversations and the industry registry (menu, agents, Data & APIs, scenarios).
 */
@Module({
  imports: [ConversationsModule],
  controllers: [MonitoringController, MonitoringAgentController],
  providers: [MonitoringNotifier, IncidentsService, MonitoringEngine, MonitoringService, TechnicianAssistant],
  exports: [MonitoringNotifier, IncidentsService, MonitoringEngine, MonitoringService, TechnicianAssistant],
})
export class VisionOpsModule {}
