import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { AssistantService } from './assistant.service.js';
import type { Style } from './knowledge.js';

/**
 * Website / dashboard assistant (public: visitors are not logged in). Rate-limited per IP ("assistant" bucket);
 * nothing about the visitor is stored. Uses the platform's own OpenAI / Sarvam accounts on the server.
 */
@Controller('assistant')
export class AssistantController {
  constructor(private readonly svc: AssistantService) {}

  @Public()
  @Get('status')
  status(@Query('lang') lang?: string) {
    const style = (['ta', 'en', 'tanglish'].includes(String(lang)) ? lang : 'en') as Style;
    return { ...this.svc.status(), greeting: this.svc.greeting(style).reply };
  }

  @Public()
  @Post('chat')
  @HttpCode(200)
  chat(@Body() body: { message?: unknown; history?: unknown; lang?: unknown }) {
    return this.svc.chat(body ?? {});
  }

  @Public()
  @Post('stt')
  @HttpCode(200)
  stt(@Body() body: { audioBase64?: unknown }) {
    return this.svc.speechToText(body ?? {});
  }

  @Public()
  @Post('tts')
  @HttpCode(200)
  tts(@Body() body: { text?: unknown; style?: unknown }) {
    return this.svc.textToSpeech(body ?? {});
  }
}
