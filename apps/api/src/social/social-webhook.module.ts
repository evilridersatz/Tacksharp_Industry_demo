import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { SocialModule } from './social.module.js';
import { SocialController } from './social.controller.js';
import { SocialWebhookService } from './social-webhook.service.js';
import { SocialAiService } from './social-ai.service.js';
import { SocialSettingsController } from './social-settings.controller.js';
import { VoiceAgentsModule } from '../voice-agents/voice-agents.module.js';

/** Instagram / Messenger inbound webhook (into the team inbox). */
@Module({
  imports: [ConversationsModule, InboxModule, SocialModule, VoiceAgentsModule],
  controllers: [SocialController, SocialSettingsController],
  providers: [SocialWebhookService, SocialAiService],
  exports: [SocialAiService],
})
export class SocialWebhookModule {}
