import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { WhatsAppSenderModule } from '../whatsapp/whatsapp-sender.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { DripController } from './drip.controller.js';
import { DripService } from './drip.service.js';

@Module({
  imports: [ConversationsModule, WhatsAppSenderModule, TelephonyModule],
  controllers: [DripController],
  providers: [DripService],
  exports: [DripService],
})
export class DripModule {}
