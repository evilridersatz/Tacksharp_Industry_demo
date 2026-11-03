import { Module } from '@nestjs/common';
import { OutreachModule } from '../automation/outreach.module.js';
import { DripController } from './drip.controller.js';
import { DripService } from './drip.service.js';

@Module({
  imports: [OutreachModule],
  controllers: [DripController],
  providers: [DripService],
  exports: [DripService],
})
export class DripModule {}
