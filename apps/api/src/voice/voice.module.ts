import { Module } from '@nestjs/common';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { VoiceController } from './voice.controller.js';

/** Call records API (Sarvam telephony). The Plivo voice engine was removed in 2026-11. */
@Module({
  imports: [TelephonyModule],
  controllers: [VoiceController],
})
export class VoiceModule {}
