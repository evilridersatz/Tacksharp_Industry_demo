import { Module } from '@nestjs/common';
import { LiveController } from './live.controller.js';

@Module({ controllers: [LiveController] })
export class LiveModule {}
