import { Module } from '@nestjs/common';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

/** Tenant-scoped customer records (add, edit, history) and consent-gated contact tests. */
@Module({
  imports: [TelephonyModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
