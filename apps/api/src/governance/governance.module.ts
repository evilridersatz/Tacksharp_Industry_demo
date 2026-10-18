import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service.js';
import { WorkTasksService } from './work-tasks.service.js';

/** Approvals and people's work tasks: shared by textile sales and every AI agent. */
@Global()
@Module({ providers: [ApprovalsService, WorkTasksService], exports: [ApprovalsService, WorkTasksService] })
export class GovernanceModule {}
