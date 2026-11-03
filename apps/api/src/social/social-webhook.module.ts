import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { SocialModule } from './social.module.js';
import { SocialController } from './social.controller.js';
import { SocialWebhookService } from './social-webhook.service.js';

/** Instagram / Messenger inbound webhook (into the team inbox). */
@Module({
  imports: [ConversationsModule, InboxModule, SocialModule],
  controllers: [SocialController],
  providers: [SocialWebhookService],
})
export class SocialWebhookModule {}
