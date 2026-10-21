import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

/** Tenant-scoped customer records (add, edit, history) and consent-gated contact tests. */
@Module({
  imports: [VoiceModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
