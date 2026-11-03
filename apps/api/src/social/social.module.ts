import { Module } from '@nestjs/common';
import { SocialSenderService } from './social-sender.service.js';

/** Sending on Instagram / Messenger (used by the team inbox). */
@Module({
  providers: [SocialSenderService],
  exports: [SocialSenderService],
})
export class SocialModule {}
