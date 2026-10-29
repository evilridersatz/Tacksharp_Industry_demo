import { Module } from '@nestjs/common';
import { TeamModule } from '../team/team.module.js';
import { PlatformController } from './platform.controller.js';
import { PlatformService } from './platform.service.js';

@Module({ imports: [TeamModule], controllers: [PlatformController], providers: [PlatformService] })
export class PlatformModule {}
