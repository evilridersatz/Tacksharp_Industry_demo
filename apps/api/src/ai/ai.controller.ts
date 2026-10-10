import { Org } from '../auth/decorators.js';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { latencyByChannel } from '../common/latency.js';
import { AiService } from './ai.service.js';

/** Test endpoint: chat with the agent without WhatsApp/Plivo. */
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /** P50 / P95 per stage and per channel (voice, whatsapp) for recent turns, split by rules vs model replies. */
  @Get('latency')
  latency() {
    return latencyByChannel();
  }

  @Post('chat')
  chat(@Org() organizationId: string, @Body() body: { phone: string; message: string; channel?: 'whatsapp' | 'voice'; name?: string }) {
    return this.aiService.generateResponse({
      organizationId,
      channel: body.channel ?? 'whatsapp',
      phone: body.phone,
      message: body.message,
      customerName: body.name,
    });
  }
}
