import { Body, Controller, ForbiddenException, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators.js';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { HANGUP, response } from '../voice/plivo-xml.js';
import { checkPlivoSignature } from '../voice/plivo-signature.js';
import { ReadyNoticeService } from './ready-notice.service.js';
import { OrderFollowUpService } from './order-followup.service.js';

/** Plivo webhooks for the "order ready" call. Same signature check as the existing voice webhooks. */
@Controller('voice')
export class ReadyCallController {
  constructor(
    private readonly ready: ReadyNoticeService,
    private readonly followUps: OrderFollowUpService,
  ) {}

  // ---- Post-collection feedback call ----

  @Public()
  @Post('feedback/answer')
  async feedbackAnswer(@Query('followUpId') id: string, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    const body = raw ?? {};
    this.verify(req, body);
    res.status(200).type('application/xml').send(await this.safe(() => this.followUps.answer(id, body)));
  }

  @Public()
  @Post('feedback/turn')
  async feedbackTurn(@Query('followUpId') id: string, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    const body = raw ?? {};
    this.verify(req, body);
    res.status(200).type('application/xml').send(await this.safe(() => this.followUps.turn(id, body)));
  }

  @Public()
  @Post('feedback/hangup')
  @HttpCode(200)
  feedbackHangup(@Query('followUpId') id: string | undefined, @Req() req: Request, @Body() raw: Record<string, string> | undefined) {
    const body = raw ?? {};
    this.verify(req, body);
    return this.followUps.hangup(id, body);
  }

  // ---- Order-ready call ----

  @Public()
  @Post('ready/answer')
  async answer(@Query('callId') callId: string, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    const body = raw ?? {};
    this.verify(req, body);
    res.status(200).type('application/xml').send(await this.safe(() => this.ready.answer(callId, body)));
  }

  @Public()
  @Post('ready/turn')
  async turn(@Query('callId') callId: string, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    const body = raw ?? {};
    this.verify(req, body);
    res.status(200).type('application/xml').send(await this.safe(() => this.ready.turn(callId, body)));
  }

  @Public()
  @Post('ready/hangup')
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

  /** Plivo V3 signature check (PLIVO_VALIDATE_SIGNATURE=true; see voice/plivo-signature.ts). */
  private verify(req: Request, body: Record<string, string>) {
    const check = checkPlivoSignature(req, body, { enabled: config.plivo.validateSignature, authToken: config.plivo.authToken, publicBaseUrl: config.publicBaseUrl });
    if (!check.ok) {
      log.warn('ready_call.signature_invalid', { path: req.path, reason: check.reason });
      throw new ForbiddenException('Invalid Plivo signature');
    }
  }

}
