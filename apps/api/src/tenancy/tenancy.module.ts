import { Global, Module } from '@nestjs/common';
import { TenancyService } from './tenancy.service.js';

@Global()
@Module({ providers: [TenancyService], exports: [TenancyService] })
export class TenancyModule {}
