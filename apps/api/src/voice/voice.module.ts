import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { VoiceController } from './voice.controller.js';
import { VoiceService } from './voice.service.js';
import { VoiceStreamService } from './stream/voice-stream.service.js';

import { DemoSessionsModule } from '../demo-sessions/demo-sessions.module.js';
import { VoiceAgentsModule } from '../voice-agents/voice-agents.module.js';
@Module({
  imports: [AiModule, ConversationsModule, LeadsModule, FollowUpsModule, DemoSessionsModule, VoiceAgentsModule],
  controllers: [VoiceController],
  providers: [VoiceService, VoiceStreamService],
  exports: [VoiceService],
})
export class VoiceModule {}
