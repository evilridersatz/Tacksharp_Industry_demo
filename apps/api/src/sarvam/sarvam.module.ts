import { Global, Module } from '@nestjs/common';
import { SarvamService } from './sarvam.service.js';

@Global()
@Module({
  providers: [SarvamService],
  exports: [SarvamService],
})
export class SarvamModule {}
