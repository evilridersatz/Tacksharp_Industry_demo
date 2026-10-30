import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { HomeController } from './home.controller.js';
import { HomeService } from './home.service.js';

@Module({ imports: [SettingsModule], controllers: [HomeController], providers: [HomeService], exports: [HomeService] })
export class HomeModule {}
