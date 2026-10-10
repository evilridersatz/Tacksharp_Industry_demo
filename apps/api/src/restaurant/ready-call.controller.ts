import { Body, Controller, ForbiddenException, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import plivo from 'plivo';
import { Public } from '../auth/decorators.js';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { HANGUP, response } from '../voice/plivo-xml.js';
import { ReadyNoticeService } from './ready-notice.service.js';

/** Plivo webhooks for the "order ready" call. Same signature check as the existing voice webhooks. */
@Controller('voice/ready')
export class ReadyCallController {
  constructor(private readonly ready: ReadyNoticeService) {}

  @Public()
  @Post('answer')
  async answer(@Query('callId') callId: string, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    const body = raw ?? {};
    this.verify(req, body);
    res.status(200).type('application/xml').send(await this.safe(() => this.ready.answer(callId, body)));
  }

  @Public()
  @Post('turn')
  async turn(@Query('callId') callId: string, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    const body = raw ?? {};
    this.verify(req, body);
    res.status(200).type('application/xml').send(await this.safe(() => this.ready.turn(callId, body)));
  }

  @Public()
  @Post('hangup')
  @HttpCode(200)
  hangup(@Query('callId') callId: string | undefined, @Req() req: Request, @Body() raw: Record<string, string> | undefined) {
    const body = raw ?? {};
    this.verify(req, body);
    return this.ready.hangup(callId, body);
  }

  private async safe(fn: () => Promise<string>) {
    try {
      return await fn();
    } catch (error) {
      log.error('ready_call.handler_failed', { error: errorMessage(error) });
      return response(`<Speak voice="WOMAN" language="en-US">Sorry, we have a technical issue. Your order is ready at the shop.</Speak>\n${HANGUP}`);
    }
  }

  private verify(req: Request, body: Record<string, string>) {
    if (!config.plivo.validateSignature) return;
    const signature = req.header('x-plivo-signature-v3');
    const nonce = req.header('x-plivo-signature-v3-nonce');
    const url = `${config.publicBaseUrl}${req.originalUrl}`;
    const valid = signature && nonce && plivo.validateV3Signature(req.method, url, nonce, config.plivo.authToken, signature, body);
    if (!valid) {
      log.warn('ready_call.signature_invalid', { url: req.originalUrl });
      throw new ForbiddenException('Invalid Plivo signature');
    }
  }
}
