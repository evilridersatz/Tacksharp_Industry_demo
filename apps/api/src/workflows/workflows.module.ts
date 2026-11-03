import { Module } from '@nestjs/common';
import { OutreachModule } from '../automation/outreach.module.js';
import { DripModule } from '../drip/drip.module.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';

@Module({
  imports: [OutreachModule, DripModule, InboxModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
