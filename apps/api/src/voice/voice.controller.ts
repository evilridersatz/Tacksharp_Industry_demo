import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VoiceService } from './voice.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { HANGUP, response } from './plivo-xml.js';
import { Org, Public } from '../auth/decorators.js';
import { latencyStats } from '../common/latency.js';
import { checkPlivoSignature } from './plivo-signature.js';
import { recordWebhookFailure } from '../common/webhook-failures.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { bindOrganization, providerCredentials } from '../integrations/provider-scope.js';
import { followUpConfig, liveGate } from '../restaurant/followup-config.js';

@Controller('voice')
export class VoiceController {
  constructor(
    private readonly voice: VoiceService,
    private readonly prisma: PrismaService,
    @Optional() private readonly tenancy?: TenancyService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { success: true, service: 'tacksharp-voice', status: 'ready' };
  }

  /**
   * Start an AI call to a lead now (dashboard button / testing).
   * curl -X POST localhost:3000/voice/call -H 'content-type: application/json' -d '{"leadId":"..."}'
   */
  @Post('call')
  async startCall(@Org() organizationId: string, @Body() body: { leadId?: string; customerId?: string; ignoreCallWindow?: boolean; confirm?: boolean }) {
    // A person pressed "Call now": it must be confirmed in the dashboard, the customer must have agreed to calls, and
    // the number must pass the live gate (DRY_RUN, approved test recipients, never a demo number). Calling hours
    // apply unless the caller explicitly overrides them.
    if (body?.confirm !== true) throw new BadRequestException('Confirm the call first (confirm: true).');
    // Both ids are checked against the logged-in organization.
    const lead = body.leadId ? await this.prisma.lead.findFirst({ where: { id: body.leadId, organizationId } }) : null;
    const customer = await this.prisma.customer.findFirst({
      where: { id: lead?.customerId ?? body.customerId ?? '', organizationId },
    });
    if (!customer || (body.leadId && !lead)) throw new NotFoundException('Lead or customer not found');
    if (!customer.callingConsent) return { started: false, reason: 'no_calling_consent: record the customer\'s consent to be called first' };
    const gate = liveGate(followUpConfig(), customer);
    if (!gate.live) return { started: false, reason: `not_live: ${gate.reason}` };
    const customerId = customer.id;
    return this.voice.startOutboundCall({
      organizationId,
      customerId,
      leadId: body.leadId,
      ignoreCallWindow: body.ignoreCallWindow === true,
    });
  }

  /** P50 / P95 per stage for recent voice turns (technical; not shown on the business dashboard). */
  @Get('latency')
  latency() {
    return latencyStats();
  }

  @Get('calls')
  listCalls(@Org() organizationId: string) {
    return this.prisma.call.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { customer: true },
    });
  }

  /** One call with its transcript (voice messages between dial and hang-up). */
  @Get('calls/:callId')
  async getCall(@Org() organizationId: string, @Param('callId') callId: string) {
    const call = await this.prisma.call.findFirst({
      where: { id: callId, organizationId },
      include: { customer: true, lead: true },
    });
    if (!call) throw new NotFoundException('Call not found');
    const conversation = await this.prisma.conversation.findFirst({
      where: { organizationId, customerId: call.customerId, channel: 'voice' },
    });
    const end = new Date((call.endedAt ?? new Date()).getTime() + 5000);
    const window = conversation
      ? await this.prisma.message.findMany({
          where: { conversationId: conversation.id, createdAt: { gte: call.createdAt, lte: end } },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    return { call, transcript: messagesOfCall(window, call.id) };
  }

  /** Plivo answer URL for calls WE dialed (callId in query). */
  @Public()
  @Post('answer')
  async answer(@Query('callId') callId: string | undefined, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    // A request without a form body (a manual test, a misconfigured webhook) must not crash the handler.
    const body = raw ?? {};
    await this.verify(req, body);
    const xml = await this.safe(() => (callId ? this.voice.answerOutbound(callId, body) : this.voice.answerInbound(body)));
    res.status(200).type('application/xml').send(xml);
  }

  /** Configure this as the Answer URL of your Plivo application for INBOUND calls. */
  @Public()
  @Post('inbound')
  async inbound(@Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    // A request without a form body (a manual test, a misconfigured webhook) must not crash the handler.
    const body = raw ?? {};
    await this.verify(req, body);
    const xml = await this.safe(() => this.voice.answerInbound(body));
    res.status(200).type('application/xml').send(xml);
  }

  /** Plivo <Record> action: one customer utterance. */
  @Public()
  @Post('turn')
  async turn(@Query('callId') callId: string, @Req() req: Request, @Res() res: Response, @Body() raw: Record<string, string> | undefined) {
    // A request without a form body (a manual test, a misconfigured webhook) must not crash the handler.
    const body = raw ?? {};
    await this.verify(req, body);
    const xml = await this.safe(() => this.voice.handleTurn(callId, body), () => this.voice.recordHandlerFailure(callId));
    res.status(200).type('application/xml').send(xml);
  }

  @Public()
  @Post('hangup')
  @HttpCode(200)
  async hangup(@Query('callId') callId: string | undefined, @Req() req: Request, @Body() raw: Record<string, string> | undefined) {
    // A request without a form body (a manual test, a misconfigured webhook) must not crash the handler.
    const body = raw ?? {};
    await this.verify(req, body);
    // Inbound calls: configure this same URL as the Plivo application's Hangup URL (no callId; resolved by CallUUID).
    return this.voice.handleHangup(callId || undefined, body);
  }

  @Public()
  @Get('audio/:filename')
  async audio(@Param('filename') filename: string, @Res() res: Response) {
    const safe = path.basename(filename);
    if (safe !== filename || !safe.endsWith('.wav')) throw new NotFoundException();
    try {
      const audio = await fs.readFile(path.join(config.voice.audioDir, safe));
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', audio.length.toString());
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(audio);
    } catch {
      throw new NotFoundException('Voice audio not found');
    }
  }

  /**
   * Never let an exception drop the call silently: say sorry and hang up. No business action is taken because of
   * an error. "We will call you back" is only said when a follow-up task for the team was really created.
   */
  private async safe(fn: () => Promise<string>, onFailure?: () => Promise<boolean>) {
    try {
      return await fn();
    } catch (error) {
      log.error('voice.handler_failed', { error: errorMessage(error) });
      const taskCreated = onFailure ? await onFailure().catch(() => false) : false;
      const sentence = taskCreated ? 'Sorry, we have a technical issue. Our team will call you back.' : 'Sorry, we have a technical issue. Please try again later.';
      return response(`<Speak voice="WOMAN" language="en-US">${sentence}</Speak>\n` + HANGUP);
    }
  }

  /** Plivo V3 signature check (enable with PLIVO_VALIDATE_SIGNATURE=true once behind a stable HTTPS URL). */
  /** Plivo V3 signature check (PLIVO_VALIDATE_SIGNATURE=true; see voice/plivo-signature.ts). */
  private async verify(req: Request, body: Record<string, string>) {
    // Which organization this callback is for: the call WE placed (callId), or the number the customer dialled. Never
    // the caller's input. Its account's token is the one Plivo signed with.
    const organizationId = await this.callbackOrganization(req, body);
    bindOrganization(organizationId);
    const pv = organizationId ? await providerCredentials('plivo', organizationId) : null;
    const authToken = pv?.source === 'organization' ? pv.secrets.authToken : config.plivo.authToken;
    const check = checkPlivoSignature(req, body, { enabled: config.plivo.validateSignature || pv?.source === 'organization', authToken, publicBaseUrl: config.publicBaseUrl });
    if (!check.ok) {
      log.warn('voice.signature_invalid', { path: req.path, reason: check.reason });
      recordWebhookFailure('plivo', check.reason ?? 'signature_invalid', req.path);
      throw new ForbiddenException('Invalid Plivo signature');
    }
  }

  private async callbackOrganization(req: Request, body: Record<string, string>): Promise<string | undefined> {
    const callId = typeof req.query?.callId === 'string' ? req.query.callId : '';
    try {
      if (callId) return (await this.prisma.call.findUnique({ where: { id: callId }, select: { organizationId: true } }))?.organizationId;
      if (body.To && this.tenancy) return await this.tenancy.resolve('plivo_number', body.To);
    } catch {
      // Lookup trouble: fall back to the deployment's account (legacy behaviour).
    }
    return undefined;
  }
}

/**
 * Messages saved during a call carry its id; an overlapping call (inbound while an outbound was ringing) must not
 * show up in this transcript. Messages saved before ids were recorded have none, and stay in by time window.
 */
export function messagesOfCall<T extends { metadata: unknown }>(messages: T[], callId: string): T[] {
  return messages.filter((m) => {
    const id = (m.metadata as { callId?: unknown } | null)?.callId;
    return typeof id !== 'string' || id === callId;
  });
}
