import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { DemoActivityService } from './demo-activity.service.js';
import { DemoLiveController } from './demo-live.controller.js';

/** Live demo activity for demo workspaces (chats, calls, follow-ups and each industry's records), run by the scheduler. */
@Module({
  imports: [AgentsModule],
  controllers: [DemoLiveController],
  providers: [DemoActivityService],
  exports: [DemoActivityService],
})
export class DemoLiveModule {}
