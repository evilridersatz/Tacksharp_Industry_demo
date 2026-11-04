import { log } from '../common/logger.js';
import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, Org, Public } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { config } from '../common/config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SarvamTelephonyProvider } from './sarvam.provider.js';
import { SarvamToolsService, isPlaceholder, sarvamConfigPack, verifyToolKey } from './sarvam-tools.service.js';

const TOOLS = ['context', 'menu', 'item', 'quote', 'order', 'status', 'handoff'] as const;
type Tool = (typeof TOOLS)[number];

/**
 * Endpoints the Sarvam voice agent calls during a live call (configured as Sarvam "API tools" / on-start hook).
 * Public route (Sarvam has no user session) but every request must carry the organization's tool key; see
 * SarvamToolsService. Errors are returned as { ok:false } bodies so the agent can say something sensible.
 */
@Controller('telephony/sarvam/tools')
export class SarvamToolsController {
  constructor(
    private readonly tools: SarvamToolsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Dashboard: the Sarvam console configuration pack (language policy, instructions, tools, on-start hook) for this
   * organization. Signed-in agent managers only; the tool key is shown in full only with ?reveal=1.
   */
  @Get('config')
  async configPack(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('reveal') reveal?: string, @Query('agentId') agentId?: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    // The full tool key lets a caller place orders for this shop: only integration admins can reveal it.
    if (reveal === '1') requirePermission(u, PERMISSIONS.integrationsManage);
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { name: true, vertical: true } });
    // The grounded tools read a food business's menu, shops and orders. Other industries: not offered yet (pending).
    if (o?.vertical !== 'restaurant') return { applicable: false, reason: 'The live menu and ordering tools are for food businesses (restaurant / chicken shop). Tools for this industry are pending.' };
    return sarvamConfigPack({
      organizationId: org,
      businessName: o?.name ?? 'our shop',
      baseUrl: config.publicBaseUrl,
      revealKey: reveal === '1',
      webhookUrl: reveal === '1' ? SarvamTelephonyProvider.webhookUrl(org, agentId ? `inbound:${String(agentId).slice(0, 64)}` : 'inbound') : 'hidden; reveal to copy',
    });
  }

  private auth(req: Request, query: Record<string, unknown>): string {
    const org = String(req.headers['x-tacksharp-org'] ?? query.org ?? '').slice(0, 64);
    const key = req.headers['x-tacksharp-tool-key'];
    if (!org) throw new UnauthorizedException('Missing organization');
    if (!verifyToolKey(org, key)) throw new ForbiddenException('Invalid tool key');
    return org;
  }

  @Public()
  @Get('menu')
  menuGet(@Req() req: Request, @Query() query: Record<string, unknown>) {
    return this.tools.menu(this.auth(req, query));
  }

  @Public()
  @Post(':tool')
  @HttpCode(200)
  async run(@Param('tool') tool: string, @Req() req: Request, @Query() query: Record<string, unknown>, @Body() body: unknown) {
    const org = this.auth(req, query);
    const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (!TOOLS.includes(tool as Tool)) return { ok: false, error: 'unknown_tool' };
    const started = Date.now();
    const r = await this.dispatch(tool as Tool, org, b);
    // One line per tool call (no customer data): shows in the logs what the agent asked and whether it worked.
    // Field names only, and which of them carried a real value (not an empty / "@Variable" placeholder): shows what
    // the Sarvam console actually sends for this tool, without logging what the caller said.
    const filled = Object.entries(b).filter(([k, v]) => k !== 'key' && k !== 'tool_key' && (typeof v === 'number' || (typeof v === 'string' ? Boolean(v.trim()) && !isPlaceholder(v.trim()) : Array.isArray(v) ? v.length > 0 : Boolean(v)))).map(([k]) => k);
    log.info('sarvam_tools.call', { organizationId: org, tool, ok: r.ok !== false, error: (r as { error?: unknown }).error ?? (r as { needs?: unknown }).needs ?? null, ms: Date.now() - started, fields: Object.keys(b).filter((k) => k !== 'key' && k !== 'tool_key').slice(0, 15).join(','), filled: filled.slice(0, 15).join(',') });
    return r;
  }

  private dispatch(tool: Tool, org: string, b: Record<string, unknown>) {
    switch (tool) {
      case 'context': return this.tools.context(org, b);
      case 'menu': return this.tools.menu(org);
      case 'item': return this.tools.item(org, b);
      case 'quote': return this.tools.quote(org, b);
      case 'order': return this.tools.order(org, b);
      case 'status': return this.tools.status(org, b);
      case 'handoff': return this.tools.handoff(org, b);
    }
  }
}
