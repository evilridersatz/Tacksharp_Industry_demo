import { Module } from '@nestjs/common';
import { MetaCapiController } from './meta-capi.controller.js';
import { MetaCapiService } from './meta-capi.service.js';

@Module({
  controllers: [MetaCapiController],
  providers: [MetaCapiService],
  exports: [MetaCapiService],
})
export class MetaCapiModule {}
