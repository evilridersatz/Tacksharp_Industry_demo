import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DemoSessionsController } from './demo-sessions.controller.js';
import { DemoSessionsService } from './demo-sessions.service.js';

@Module({
  imports: [TenancyModule, SettingsModule],
  controllers: [DemoSessionsController],
  providers: [DemoSessionsService],
  exports: [DemoSessionsService],
})
export class DemoSessionsModule {}
