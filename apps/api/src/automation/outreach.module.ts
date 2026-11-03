import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { WhatsAppSenderModule } from '../whatsapp/whatsapp-sender.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { OutreachService } from './outreach.service.js';

@Module({
  imports: [ConversationsModule, WhatsAppSenderModule, TelephonyModule],
  providers: [OutreachService],
  exports: [OutreachService],
})
export class OutreachModule {}
