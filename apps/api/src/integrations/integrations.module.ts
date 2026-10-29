import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CredentialsService } from './credentials.service.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { ProviderScopeInterceptor } from './provider-scope.interceptor.js';

/** Encrypted per-organization provider credentials (Plivo, Sarvam, OpenAI, WhatsApp) and their resolution policy. */
@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [CredentialsService, IntegrationsService, { provide: APP_INTERCEPTOR, useClass: ProviderScopeInterceptor }],
  exports: [CredentialsService, IntegrationsService],
})
export class IntegrationsModule {}
