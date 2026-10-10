import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { VoiceModule } from '../voice/voice.module.js';
import { FollowUpProcessor } from './follow-up.processor.js';
import { WhatsAppMessageProcessor } from './whatsapp-message.processor.js';
import { WorkersService } from './workers.service.js';

@Module({
  imports: [AiModule, ConversationsModule, LeadsModule, VoiceModule, FollowUpsModule],
  providers: [FollowUpProcessor, WhatsAppMessageProcessor, WorkersService],
})
export class WorkersModule {}
