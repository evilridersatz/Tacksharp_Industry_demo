import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { KnowledgeStudioService } from './knowledge-studio.service.js';

@Module({ controllers: [KnowledgeController], providers: [KnowledgeService, KnowledgeStudioService], exports: [KnowledgeService, KnowledgeStudioService] })
export class KnowledgeModule {}
