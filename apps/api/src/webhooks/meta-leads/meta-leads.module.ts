import { Module } from '@nestjs/common';
import { LeadsModule } from '../../leads/leads.module.js';
import { FollowUpsModule } from '../../follow-ups/follow-ups.module.js';
import { MetaLeadsController } from './meta-leads.controller.js';
import { MetaLeadsService } from './meta-leads.service.js';

@Module({
  imports: [LeadsModule, FollowUpsModule],
  controllers: [MetaLeadsController],
  providers: [MetaLeadsService],
})
export class MetaLeadsModule {}
