import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { JarvisController } from './jarvis.controller.js';
import { JarvisDataService } from './jarvis-data.service.js';
import { JarvisScheduler } from './jarvis.scheduler.js';
import { JarvisService } from './jarvis.service.js';

@Module({ imports: [IntegrationsModule], controllers: [JarvisController], providers: [JarvisDataService, JarvisService, JarvisScheduler], exports: [JarvisService] })
export class JarvisModule {}
