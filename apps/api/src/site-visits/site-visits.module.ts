import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';

import { SiteVisitsController } from './site-visits.controller.js';
import { SiteVisitsService } from './site-visits.service.js';

@Module({
  imports: [
    PrismaModule,
    FollowUpsModule,
  ],

  controllers: [
    SiteVisitsController,
  ],

  providers: [
    SiteVisitsService,
  ],

  exports: [
    SiteVisitsService,
  ],
})
export class SiteVisitsModule {}
