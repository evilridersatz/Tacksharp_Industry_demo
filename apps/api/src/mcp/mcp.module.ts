import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';

@Module({
  imports: [CustomersModule, AnalyticsModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
