import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { VoiceAgentsController } from './voice-agents.controller.js';
import { VoiceAgentsService } from './voice-agents.service.js';

@Module({ imports: [KnowledgeModule], controllers: [VoiceAgentsController], providers: [VoiceAgentsService], exports: [VoiceAgentsService] })
export class VoiceAgentsModule {}
