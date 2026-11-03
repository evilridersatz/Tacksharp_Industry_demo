import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { AiService } from '../ai/ai.service.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';
import { AssistantService, detectStyle } from './assistant.service.js';
import type { Style } from './knowledge.js';

/** The business's own greeting in the dashboard assistant (Tamil, Tanglish, English). */
const greeting = (name: string, ordering: boolean): Record<Style, string> => ordering
  ? {
      en: `Vanakkam! This is the ${name} assistant. Ask for the menu or today's prices, or place an order by chat, voice or video. Answers come from your shop's live menu and records.`,
      ta: `வணக்கம்! ${name} assistant பேசுறேன். Menu, இன்றைய விலை கேளுங்க, அல்லது chat, voice, video-ல order பண்ணுங்க.`,
      tanglish: `Vanakkam! ${name} assistant pesuren. Menu, inniku price kelunga, illa chat, voice, video la order pannunga.`,
    }
  : {
      en: `Vanakkam! This is the ${name} assistant. Ask anything a customer would ask; answers come from your business's own records.`,
      ta: `வணக்கம்! ${name} assistant பேசுறேன். ஒரு customer கேட்கற மாதிரி எதுவேணாலும் கேளுங்க.`,
      tanglish: `Vanakkam! ${name} assistant pesuren. Customer kekura maadhiri edhu venaalum kelunga.`,
    };

/**
 * The dashboard assistant in "business" mode: staff talk to THEIR business's assistant as a customer would, by chat,
 * voice or the video presenter. Every turn goes through the same engine as WhatsApp and phone calls (a restaurant:
 * the ordering engine with the live menu, prices, stock, outlets and the customer's history by mobile number), on the
 * dashboard test channel: nothing is sent on WhatsApp and no call is placed. A confirmed order is a real order record.
 * Logged-in staff only; the organization always comes from the session.
 */
@Controller('business-assistant')
export class BusinessAssistantController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly ai: AiService,
    private readonly assistant: AssistantService,
  ) {}

  private async workspace(organizationId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true, isDemo: true } });
    const ordering = (await this.tenancy.vertical(organizationId).catch(() => 'unknown')) === 'restaurant';
    const industry = ordering ? 'restaurant' : ((await this.ai.industry(organizationId)) ?? 'other');
    // Other industries' engines can book visits or update records: like the agent playground, demo workspaces only.
    const enabled = ordering || Boolean(org?.isDemo);
    return { name: org?.name ?? 'Your business', isDemo: Boolean(org?.isDemo), ordering, industry, enabled };
  }

  @Get('status')
  async status(@Org() organizationId: string, @Query('lang') lang?: string) {
    const ws = await this.workspace(organizationId);
    const style = (['ta', 'en', 'tanglish'].includes(String(lang)) ? lang : 'en') as Style;
    return {
      ...this.assistant.status(),
      enabled: ws.enabled,
      reason: ws.enabled ? null : 'Your business assistant can be tried here in a demo workspace. Live customers talk to it on WhatsApp and phone.',
      organizationName: ws.name,
      industry: ws.industry,
      ordering: ws.ordering,
      greeting: greeting(ws.name, ws.ordering)[style],
    };
  }

  /** What the business already knows about this customer (the same records WhatsApp and phone calls use). */
  @Get('customer')
  async customer(@Org() organizationId: string, @Query('phone') raw?: string) {
    const phone = normalizePhone(raw);
    if (!phone) throw new BadRequestException('Enter a 10-digit mobile number.');
    const c = await this.prisma.customer.findFirst({ where: { organizationId, phone }, select: { id: true, name: true, language: true, createdAt: true } });
    if (!c) return { known: false, phone };
    const [orders, count, conversations] = await Promise.all([
      this.prisma.order.findMany({ where: { organizationId, customerId: c.id }, orderBy: { createdAt: 'desc' }, take: 3, select: { orderNumber: true, total: true, status: true, channel: true, createdAt: true } }).catch(() => []),
      this.prisma.order.count({ where: { organizationId, customerId: c.id } }).catch(() => 0),
      this.prisma.conversation.findMany({ where: { organizationId, customerId: c.id }, orderBy: { updatedAt: 'desc' }, take: 5, select: { channel: true, updatedAt: true } }),
    ]);
    return {
      known: true,
      phone,
      name: c.name,
      language: c.language,
      since: c.createdAt,
      orderCount: count,
      recentOrders: orders.map((o) => ({ orderNumber: o.orderNumber, total: Number(o.total), status: o.status, channel: o.channel, at: o.createdAt })),
      channels: [...new Set(conversations.map((v) => v.channel))],
      lastContactAt: conversations[0]?.updatedAt ?? null,
    };
  }

  /** One customer turn. `spoken` = the assistant is in voice or video mode (replies worded for speech). */
  @Post('chat')
  @HttpCode(200)
  async chat(@Org() organizationId: string, @CurrentUser() user: SessionClaims, @Body() body: { message?: unknown; phone?: unknown; name?: unknown; spoken?: unknown; sttLanguage?: unknown }) {
    if (user.role === 'viewer') throw new ForbiddenException('Your role can only view.');
    const ws = await this.workspace(organizationId);
    if (!ws.enabled) throw new ForbiddenException('Your business assistant can be tried here in a demo workspace.');
    const phone = normalizePhone(typeof body?.phone === 'string' ? body.phone : '');
    if (!phone) throw new BadRequestException('Enter the customer’s 10-digit mobile number first.');
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 1000) throw new BadRequestException('Message must be 1–1000 characters.');
    const spoken = body?.spoken === true;
    const started = Date.now();
    try {
      const r = await this.ai.generateResponse({
        organizationId,
        channel: 'web',
        phone,
        message,
        customerName: typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : undefined,
        metadata: { assistant: 'dashboard', by: `user:${user.sub}`, spoken, ...(typeof body?.sttLanguage === 'string' ? { sttLanguage: body.sttLanguage.slice(0, 10) } : {}) },
      });
      const order = (r as { order?: { status: string; orderNumber: string; total: number } }).order ?? null;
      log.info('business_assistant.reply', { organizationId, spoken, ms: Date.now() - started, path: r.path ?? null, order: order?.orderNumber ?? null });
      return { reply: r.response, style: detectStyle(r.response), step: r.state ?? null, order, path: r.path ?? 'rules', sent: false };
    } catch (e) {
      log.warn('business_assistant.failed', { organizationId, error: errorMessage(e) });
      throw new BadRequestException('The assistant could not answer just now. Please try again.');
    }
  }

  // Speech for the business assistant (signed-in staff; not the public per-visitor allowance).
  @Post('stt')
  @HttpCode(200)
  stt(@Body() body: { audioBase64?: unknown }) {
    return this.assistant.speechToText(body ?? {});
  }

  @Post('tts')
  @HttpCode(200)
  tts(@Body() body: { text?: unknown; style?: unknown; sampleRate?: unknown }) {
    return this.assistant.textToSpeech(body ?? {});
  }
}
