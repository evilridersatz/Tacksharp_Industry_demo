import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { Org, Public } from '../auth/decorators.js';
import { latencyStats } from '../common/latency.js';
import { TelephonyService } from '../telephony/telephony.service.js';

/**
 * Calls API. Telephony runs on Sarvam only (Plivo removed 2026-11): no answer / turn / hangup XML routes remain.
 * Call records and transcripts (including historical Plivo calls) are still listed here.
 */
@Controller('voice')
export class VoiceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephony: TelephonyService,
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
    // Sarvam outbound with the organization's automatic-call agent; every gate (consent, DND, hours, limits, DRY_RUN
    // and the live gate) runs again in TelephonyService.
    return this.telephony.placeSystemCall({
      organizationId,
      customerId: customer.id,
      purpose: 'manual_call',
      idempotencyKey: `${customer.id}:${Date.now()}`,
      ignoreCallWindow: body.ignoreCallWindow === true,
      variables: body.leadId ? { lead_id: body.leadId } : undefined,
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
