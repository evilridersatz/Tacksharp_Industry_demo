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
export type Tool = (typeof TOOLS)[number];

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
    return forAgent(tool as Tool, withAllFields(tool as Tool, r));
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

/** Never spoken: what the agent must not read aloud. Added once to every tool message (kept short: it costs tokens). */
export const SPEAK_RULE = 'Say only words for the caller; never notes or tool names.';

/**
 * The reply as the agent's model reads it, kept small because every word is Sarvam LLM tokens on every turn: the
 * console forwards @message, and a tool with "Include in context" on puts the whole reply in context. So: no copies
 * of the message under other names, and the menu's item list (the same as menu_text) only on the GET menu route.
 */
export function forAgent<T extends Record<string, unknown>>(tool: Tool, r: T): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...r };
  if (tool === 'menu') delete out.items;
  if (typeof out.message === 'string' && out.message && !out.message.includes(SPEAK_RULE)) out.message = `${out.message} ${SPEAK_RULE}`;
  return out as T & Record<string, unknown>;
}

/**
 * Every field the console may forward for a tool ("Send fields from the API response to the agent": @summary_text,
 * @order_number, ...). A field the reply lacks reaches the agent as the literal "@summary_text"; it is sent empty instead.
 */
const TOOL_FIELDS: Record<Tool, string[]> = {
  context: ['business_name', 'customer_name', 'menu_text', 'unavailable_today', 'shops_text', 'delivery', 'language_rule', 'message'],
  menu: ['menu_text', 'unavailable_today', 'shops_text', 'message'],
  item: ['found', 'price_text', 'availability_text', 'cuts', 'message'],
  quote: ['ok', 'summary_text', 'total', 'cart_token', 'questions_text', 'problems_text', 'message'],
  order: ['ok', 'order_number', 'message'],
  status: ['found', 'order_number', 'status', 'message'],
  handoff: ['ok', 'message'],
};
export function withAllFields<T extends Record<string, unknown>>(tool: Tool, r: T): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...r };
  for (const k of TOOL_FIELDS[tool] ?? []) {
    if (out[k] !== undefined && out[k] !== null) continue;
    out[k] = k === 'ok' ? r.ok !== false : k === 'found' ? false : k === 'message' ? (typeof r.error === 'string' ? `The tool could not do this (${r.error}). Offer the caller a staff call back.` : '') : '';
  }
  return out as T & Record<string, unknown>;
}

