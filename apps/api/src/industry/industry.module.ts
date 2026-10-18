import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AiModule } from '../ai/ai.module.js';
import { IndustryController, QualityController } from './industry.controller.js';
import { IndustryService } from './industry.service.js';
import { ScenarioService } from './scenario.service.js';
import { VerticalsModule } from '../verticals/verticals.module.js';

/** Multi-industry workspace, dashboards, agent catalogue / playground and manufacturing quality records. */
@Module({
  imports: [AgentsModule, AiModule, VerticalsModule],
  controllers: [IndustryController, QualityController],
  providers: [IndustryService, ScenarioService],
  exports: [IndustryService],
})
export class IndustryModule {}
