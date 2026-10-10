import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { SarvamModule } from './sarvam/sarvam.module.js';
import { WhatsAppSenderModule } from './whatsapp/whatsapp-sender.module.js';
import { PropertiesModule } from './properties/properties.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { AiModule } from './ai/ai.module.js';
import { FollowUpsModule } from './follow-ups/follow-ups.module.js';
import { SiteVisitsModule } from './site-visits/site-visits.module.js';
import { WhatsAppModule } from './webhooks/whatsapp.module.js';
import { MetaLeadsModule } from './webhooks/meta-leads/meta-leads.module.js';
import { VoiceModule } from './voice/voice.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { RestaurantModule } from './restaurant/restaurant.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrivacyController } from './privacy.controller.js';

@Module({
  imports: [
    PrismaModule,
    TenancyModule,
    SettingsModule,
    AuthModule,
    HealthModule,
    SarvamModule,
    WhatsAppSenderModule,
    PropertiesModule,
    LeadsModule,
    ConversationsModule,
    AiModule,
    FollowUpsModule,
    SiteVisitsModule,
    WhatsAppModule,
    MetaLeadsModule,
    VoiceModule,
    WorkersModule,
    DashboardModule,
    RestaurantModule,
  ],
  controllers: [AppController, PrivacyController],
  providers: [AppService],
})
export class AppModule {}
