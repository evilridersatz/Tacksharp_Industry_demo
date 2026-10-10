import { Global, Module } from '@nestjs/common';
import { WhatsAppSenderService } from './whatsapp-sender.service.js';

@Global()
@Module({
  providers: [WhatsAppSenderService],
  exports: [WhatsAppSenderService],
})
export class WhatsAppSenderModule {}
