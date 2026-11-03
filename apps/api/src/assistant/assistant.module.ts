import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { BusinessAssistantController } from './business-assistant.controller.js';

@Module({ imports: [AiModule], controllers: [AssistantController, BusinessAssistantController], providers: [AssistantService] })
export class AssistantModule {}
