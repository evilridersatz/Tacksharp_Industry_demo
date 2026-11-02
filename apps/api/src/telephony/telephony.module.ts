import { Module } from '@nestjs/common';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { TelephonyController } from './telephony.controller.js';
import { TelephonyService } from './telephony.service.js';

@Module({
  imports: [FollowUpsModule],
  controllers: [TelephonyController],
  providers: [TelephonyService],
  exports: [TelephonyService],
})
export class TelephonyModule {}
