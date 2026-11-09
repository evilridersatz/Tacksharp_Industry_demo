import { Module } from '@nestjs/common';
import { JarvisModule } from '../jarvis/jarvis.module.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { OfficeController } from './office.controller.js';
import { OfficeSetupService } from './office-setup.service.js';
import { OfficeInsightsService } from './office-insights.service.js';
import { OfficeEngine } from './engine/office-engine.service.js';
import { OfficeWorker } from './engine/office.worker.js';
import { OfficeToolbox } from './tools/toolbox.service.js';
import { OfficeWorkflowsService } from './workflows/office-workflows.service.js';

/**
 * Tacksharp AI Office: a CEO agent plans an owner's instruction into tasks for specialist agents, run by a MySQL state
 * machine on BullMQ. Isolated: its own tables (Office*), its own routes (/office), and the platform's shared
 * services (auth, organizations, approvals, work tasks, inbox, knowledge, integrations vault, live events) reused.
 * Design ideas (speech-act messages, hop caps, breaker ladder, secret broker) credited in README.md.
 */
@Module({
  imports: [JarvisModule, InboxModule, ConversationsModule, KnowledgeModule],
  controllers: [OfficeController],
  providers: [OfficeSetupService, OfficeInsightsService, OfficeToolbox, OfficeEngine, OfficeWorkflowsService, OfficeWorker],
  exports: [OfficeEngine],
})
export class OfficeModule {}
