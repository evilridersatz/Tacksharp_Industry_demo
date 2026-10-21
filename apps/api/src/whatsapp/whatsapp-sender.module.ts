import { Global, Module } from '@nestjs/common';
import { WhatsAppSenderService } from './whatsapp-sender.service.js';
import { InboundMessageService } from './inbound-messages.service.js';

@Global()
@Module({
  providers: [WhatsAppSenderService, InboundMessageService],
  exports: [WhatsAppSenderService, InboundMessageService],
})
export class WhatsAppSenderModule {}
