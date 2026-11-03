import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { log } from '../common/logger.js';
import { describeError } from '../common/errors.js';
import { assertPlanAllows } from '../billing/entitlements.js';

/** Protocol versions this server speaks (the same list the official TypeScript SDK supports). */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_SERVER_INFO = { name: 'tacksharp', title: 'Tacksharp workspace', version: '1.0.0' };
const KEY_PREFIX = 'tsk_mcp_';
const RATE_PER_MIN = 120;

export type McpKey = { id: string; organizationId: string; name: string; scope: 'read' | 'write' };
type Json = Record<string, unknown>;
type ToolDef = { name: string; title: string; description: string; write: boolean; inputSchema: Json; run: (k: McpKey, a: Json) => Promise<unknown> };

export const hashKey = (raw: string) => createHash('sha256').update(raw).digest('hex');
const mask = (phone: string | null | undefined) => (phone ? `••••${phone.slice(-4)}` : null);
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** A tool refused the call for a reason the assistant should see (returned as isError, not a protocol error). */
export class ToolError extends Error {}

/**
 * MCP server for one organization per access key. Tools read the workspace (customers, conversations, orders,
 * analytics) and, with a write key, add notes, set CRM stages and create tasks. No tool sends a WhatsApp message or
 * places a call: customer contact stays behind the product's own consent and safety gates. Phone numbers are masked.
 * Every tool call is audited with the key; keys are rate limited (120 calls / minute).
 */
@Injectable()
export class McpService {
  private readonly hits = new Map<string, { minute: number; n: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly customers?: CustomersService,
    @Optional() private readonly analytics?: AnalyticsService,
  ) {}

  // -------------------------------------------------------------------------------------------- keys
  async createKey(actor: { sub: string; org: string }, body: { name?: unknown; scope?: unknown }) {
    const name = str(body.name, 80);
    if (!name) throw new BadRequestException({ message: 'Give the key a name (who / what uses it)', errors: { name: 'Name is required' } });
    const scope = body.scope === 'write' ? 'write' : 'read';
    await assertPlanAllows(this.prisma, actor.org, 'mcpKeys');
    const raw = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    const row = await this.prisma.mcpAccessKey.create({ data: { organizationId: actor.org, name, scope, prefix: raw.slice(0, 14), keyHash: hashKey(raw), createdBy: actor.sub } });
    await this.audit(actor.org, `user:${actor.sub}`, row.id, 'mcp.key_created', { name, scope });
    return { id: row.id, name, scope, prefix: row.prefix, key: raw, note: 'Copy it now: it is shown only once.' };
  }

  listKeys(org: string) {
    return this.prisma.mcpAccessKey.findMany({ where: { organizationId: org }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, scope: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true } });
  }

  async revokeKey(actor: { sub: string; org: string }, id: string) {
    const k = await this.prisma.mcpAccessKey.findFirst({ where: { id, organizationId: actor.org } });
    if (!k) throw new NotFoundException('Key not found');
    if (!k.revokedAt) {
      await this.prisma.mcpAccessKey.update({ where: { id: k.id }, data: { revokedAt: new Date() } });
      await this.audit(actor.org, `user:${actor.sub}`, k.id, 'mcp.key_revoked', { name: k.name });
    }
    return { revoked: true };
  }

  /** The key behind an Authorization header, or null (unknown, revoked, malformed, suspended organization). */
  async authenticate(header: string | undefined): Promise<McpKey | null> {
    const m = /^Bearer\s+(tsk_mcp_[A-Za-z0-9_-]{20,80})$/.exec(header ?? '');
    if (!m) return null;
    const k = await this.prisma.mcpAccessKey.findUnique({ where: { keyHash: hashKey(m[1]) } });
    if (!k || k.revokedAt) return null;
    const org = await this.prisma.organization.findUnique({ where: { id: k.organizationId }, select: { status: true } });
    if (!org || org.status === 'suspended') return null;
    // Last use, at most once a minute per key.
    if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 60_000) await this.prisma.mcpAccessKey.update({ where: { id: k.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { id: k.id, organizationId: k.organizationId, name: k.name, scope: k.scope === 'write' ? 'write' : 'read' };
  }

  rateLimited(keyId: string) {
    const minute = Math.floor(Date.now() / 60_000);
    const h = this.hits.get(keyId);
    if (!h || h.minute !== minute) {
      this.hits.set(keyId, { minute, n: 1 });
      return false;
    }
    h.n++;
    return h.n > RATE_PER_MIN;
  }

  // -------------------------------------------------------------------------------------------- JSON-RPC
  /** Handles one JSON-RPC message. Returns the response object, or null for notifications. */
  async handle(key: McpKey, msg: unknown): Promise<Json | null> {
    const m = (msg ?? {}) as { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: Json };
    const isRequest = m.id !== undefined && m.id !== null;
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return isRequest || m.id === undefined ? rpcError(m.id ?? null, -32600, 'Invalid request') : null;
    if (!isRequest) return null; // notifications (initialized, cancelled ...) need no answer
    const id = m.id as string | number;
    try {
      switch (m.method) {
        case 'initialize': {
          const asked = String((m.params ?? {}).protocolVersion ?? '');
          const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
          return rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: MCP_SERVER_INFO,
            instructions: `Tacksharp workspace tools (${key.scope === 'write' ? 'read and write' : 'read only'}). Phone numbers are masked. No tool contacts customers: messages and calls stay with the team and the product's safety rules.`,
          });
        }
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: this.tools().filter((t) => key.scope === 'write' || !t.write).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !t.write, destructiveHint: false, openWorldHint: false } })) });
        case 'tools/call': {
          const p = m.params ?? {};
          const tool = this.tools().find((t) => t.name === p.name);
          if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(p.name)}`);
          if (tool.write && key.scope !== 'write') return rpcResult(id, toolText(`"${tool.name}" needs a key with write access. This key is read only.`, true));
          const args = (p.arguments ?? {}) as Json;
          try {
            const out = await tool.run(key, args);
            await this.audit(key.organizationId, `mcp:${key.id}`, key.id, 'mcp.tool_called', { tool: tool.name, ok: true, write: tool.write });
            return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: Array.isArray(out) ? { items: out } : (out as Json), isError: false });
          } catch (e) {
            const expected = e instanceof ToolError || e instanceof NotFoundException || e instanceof BadRequestException;
            const message = expected ? (e as Error).message : 'The tool failed. Try again later.';
            if (!expected) log.warn('mcp.tool_failed', { tool: tool.name, error: describeError(e) });
            await this.audit(key.organizationId, `mcp:${key.id}`, key.id, 'mcp.tool_called', { tool: tool.name, ok: false, write: tool.write });
            return rpcResult(id, toolText(message, true));
          }
        }
        case 'resources/list':
          return rpcResult(id, { resources: [] });
        case 'prompts/list':
          return rpcResult(id, { prompts: [] });
        default:
          return rpcError(id, -32601, `Method not found: ${m.method}`);
      }
    } catch (e) {
      log.warn('mcp.request_failed', { method: m.method, error: describeError(e) });
      return rpcError(id, -32603, 'Internal error');
    }
  }

  // -------------------------------------------------------------------------------------------- tools
  tools(): ToolDef[] {
    const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
    return [
      {
        name: 'search_customers', title: 'Search customers', write: false,
        description: 'Find customers of this workspace by name, phone digits or email. Phone numbers are masked.',
        inputSchema: obj({ query: { type: 'string', description: 'Name, phone digits or email (2+ characters)' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']),
        run: async (k, a) => {
          const q = str(a.query, 80);
          if (q.length < 2) throw new ToolError('Give at least 2 characters to search for.');
          const digits = q.replace(/\D/g, '');
          const rows = await this.prisma.customer.findMany({
            where: { organizationId: k.organizationId, OR: [{ name: { contains: q } }, { email: { contains: q } }, ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : [])] },
            orderBy: { updatedAt: 'desc' },
            take: int(a.limit, 10, 1, 20),
            select: { id: true, name: true, phone: true, stage: true, tags: true, lastInboundAt: true, optedOutAt: true },
          });
          return rows.map((c) => ({ id: c.id, name: c.name, phone: mask(c.phone), stage: c.stage ?? 'new', tags: c.tags ?? [], lastMessageAt: c.lastInboundAt, optedOut: Boolean(c.optedOutAt) }));
        },
      },
      {
        name: 'get_customer', title: 'Customer details', write: false,
        description: 'One customer: CRM stage, tags, custom attributes, consent, recent notes, open tasks, recent orders and the last messages.',
        inputSchema: obj({ customerId: { type: 'string' } }, ['customerId']),
        run: async (k, a) => {
          const c = await this.prisma.customer.findFirst({ where: { id: str(a.customerId, 64), organizationId: k.organizationId } });
          if (!c) throw new ToolError('Customer not found in this workspace.');
          const [notes, tasks, orders, conv] = await Promise.all([
            this.prisma.customerNote.findMany({ where: { organizationId: k.organizationId, customerId: c.id }, orderBy: { createdAt: 'desc' }, take: 5, select: { body: true, authorName: true, createdAt: true } }),
            this.prisma.workTask.findMany({ where: { organizationId: k.organizationId, entityType: 'customer', entityId: c.id, status: 'open' }, take: 10, select: { title: true, dueAt: true } }),
            this.prisma.order.findMany({ where: { organizationId: k.organizationId, customerId: c.id }, orderBy: { createdAt: 'desc' }, take: 5, select: { orderNumber: true, status: true, total: true, createdAt: true } }),
            this.prisma.conversation.findFirst({ where: { organizationId: k.organizationId, customerId: c.id }, orderBy: { updatedAt: 'desc' }, select: { id: true, channel: true, Message: { orderBy: { createdAt: 'desc' }, take: 10, select: { role: true, content: true, createdAt: true } } } }),
          ]);
          return {
            id: c.id, name: c.name, phone: mask(c.phone), language: c.language, source: c.source, stage: c.stage ?? 'new', tags: c.tags ?? [], attributes: c.attributes ?? {}, followUpAt: c.followUpAt,
            consent: { whatsapp: c.messagingConsent, calls: c.callingConsent, optedOut: Boolean(c.optedOutAt), doNotContact: c.doNotContact },
            notes, openTasks: tasks, orders: orders.map((o) => ({ ...o, total: Number(o.total) })),
            lastConversation: conv ? { id: conv.id, channel: conv.channel, messages: conv.Message.reverse().map((m) => ({ from: m.role === 'user' ? 'customer' : 'business', text: m.content.slice(0, 1000), at: m.createdAt })) } : null,
          };
        },
      },
      {
        name: 'list_conversations', title: 'Team inbox conversations', write: false,
        description: 'Conversations in the team inbox, newest first, with status, channel, assignee and the last message.',
        inputSchema: obj({ status: { type: 'string', enum: ['open', 'pending', 'resolved', 'all'] }, channel: { type: 'string', enum: ['whatsapp', 'instagram', 'messenger', 'voice', 'web'] }, needsPerson: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
        run: async (k, a) => {
          const status = ['open', 'pending', 'resolved'].includes(String(a.status)) ? String(a.status) : undefined;
          const rows = await this.prisma.conversation.findMany({
            where: { organizationId: k.organizationId, ...(status ? { inboxStatus: status } : {}), ...(typeof a.channel === 'string' ? { channel: a.channel } : {}), ...(a.needsPerson === true ? { OR: [{ status: 'human_handoff' }, { aiEnabled: false }] } : {}) },
            orderBy: { updatedAt: 'desc' },
            take: int(a.limit, 20, 1, 50),
            select: { id: true, channel: true, inboxStatus: true, priority: true, aiEnabled: true, status: true, assigneeId: true, updatedAt: true, Customer: { select: { id: true, name: true } }, Message: { orderBy: { createdAt: 'desc' }, take: 1, select: { role: true, content: true } } },
          });
          return rows.map((c) => ({ id: c.id, channel: c.channel, status: c.inboxStatus, priority: c.priority, aiAnswering: c.aiEnabled && c.status !== 'human_handoff', customer: c.Customer, updatedAt: c.updatedAt, lastMessage: c.Message[0] ? { from: c.Message[0].role === 'user' ? 'customer' : 'business', text: c.Message[0].content.slice(0, 300) } : null }));
        },
      },
      {
        name: 'get_conversation', title: 'Conversation messages', write: false,
        description: 'The messages of one conversation, oldest first (up to 50 most recent).',
        inputSchema: obj({ conversationId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['conversationId']),
        run: async (k, a) => {
          const c = await this.prisma.conversation.findFirst({ where: { id: str(a.conversationId, 64), organizationId: k.organizationId }, select: { id: true, channel: true, inboxStatus: true, Customer: { select: { id: true, name: true } } } });
          if (!c) throw new ToolError('Conversation not found in this workspace.');
          const msgs = await this.prisma.message.findMany({ where: { conversationId: c.id, organizationId: k.organizationId }, orderBy: { createdAt: 'desc' }, take: int(a.limit, 30, 1, 50), select: { role: true, content: true, createdAt: true, metadata: true } });
          return { ...c, messages: msgs.reverse().map((m) => ({ from: m.role === 'user' ? 'customer' : (m.metadata as { author?: string } | null)?.author === 'staff' ? 'team' : 'ai', text: m.content.slice(0, 2000), at: m.createdAt, notSent: Boolean((m.metadata as { simulated?: boolean } | null)?.simulated) })) };
        },
      },
      {
        name: 'list_orders', title: 'Orders', write: false,
        description: 'Orders of this workspace (restaurant / food ordering), newest first, optionally by status, for the last N days.',
        inputSchema: obj({ status: { type: 'string', enum: ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'] }, days: { type: 'integer', minimum: 1, maximum: 90 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
        run: async (k, a) => {
          const since = new Date(Date.now() - int(a.days, 7, 1, 90) * 86_400_000);
          const rows = await this.prisma.order.findMany({ where: { organizationId: k.organizationId, createdAt: { gte: since }, ...(typeof a.status === 'string' ? { status: a.status } : {}) }, orderBy: { createdAt: 'desc' }, take: int(a.limit, 20, 1, 50), select: { id: true, orderNumber: true, status: true, channel: true, total: true, pickupAt: true, createdAt: true, customerName: true } });
          return rows.map((o) => ({ ...o, total: Number(o.total) }));
        },
      },
      {
        name: 'analytics_summary', title: 'Analytics summary', write: false,
        description: 'Key figures for the last N days compared with the period before: messages, reply times, hand-overs, leads, conversion, orders, revenue.',
        inputSchema: obj({ days: { type: 'integer', minimum: 1, maximum: 180 } }),
        run: async (k, a) => {
          if (!this.analytics) throw new ToolError('Analytics are not available on this server.');
          const r = await this.analytics.advanced(k.organizationId, int(a.days, 30, 1, 180));
          return { days: r.days, kpis: r.kpis, responseTimes: r.responseTimes, answeredBy: r.answeredBy, channels: r.channels, definitions: r.definitions };
        },
      },
      {
        name: 'add_customer_note', title: 'Add a note to a customer', write: true,
        description: 'Adds an internal note to a customer record (never sent to the customer). Needs a write key.',
        inputSchema: obj({ customerId: { type: 'string' }, note: { type: 'string', maxLength: 4000 } }, ['customerId', 'note']),
        run: async (k, a) => {
          const c = await this.prisma.customer.findFirst({ where: { id: str(a.customerId, 64), organizationId: k.organizationId }, select: { id: true } });
          if (!c) throw new ToolError('Customer not found in this workspace.');
          const body = str(a.note, 4000);
          if (!body) throw new ToolError('Write the note text.');
          const n = await this.prisma.customerNote.create({ data: { organizationId: k.organizationId, customerId: c.id, authorId: `mcp:${k.id}`, authorName: `AI assistant (${k.name})`, body } });
          return { noteId: n.id, saved: true };
        },
      },
      {
        name: 'set_customer_stage', title: 'Set CRM stage', write: true,
        description: 'Moves a customer to a CRM stage: new, interested, qualified, converted or lost. Needs a write key.',
        inputSchema: obj({ customerId: { type: 'string' }, stage: { type: 'string', enum: ['new', 'interested', 'qualified', 'converted', 'lost'] } }, ['customerId', 'stage']),
        run: async (k, a) => {
          if (!this.customers) throw new ToolError('Not available on this server.');
          const stage = String(a.stage);
          if (!['new', 'interested', 'qualified', 'converted', 'lost'].includes(stage)) throw new ToolError('Stage must be new, interested, qualified, converted or lost.');
          const r = await this.customers.update(k.organizationId, { sub: `mcp:${k.id}` }, str(a.customerId, 64), { stage });
          return { customerId: r.id, stage: r.stage ?? 'new' };
        },
      },
      {
        name: 'create_task', title: 'Create a follow-up task', write: true,
        description: 'Creates a follow-up task for the team, linked to a customer. Needs a write key.',
        inputSchema: obj({ customerId: { type: 'string' }, title: { type: 'string', minLength: 3, maxLength: 200 }, dueInDays: { type: 'integer', minimum: 0, maximum: 365 } }, ['customerId', 'title']),
        run: async (k, a) => {
          if (!this.customers) throw new ToolError('Not available on this server.');
          const due = a.dueInDays === undefined ? undefined : new Date(Date.now() + int(a.dueInDays, 0, 0, 365) * 86_400_000).toISOString();
          const t = await this.customers.addTask(k.organizationId, { sub: `mcp:${k.id}` }, str(a.customerId, 64), { title: a.title, dueAt: due });
          return { taskId: t.id, title: t.title, dueAt: t.dueAt };
        },
      },
    ];
  }

  private audit(org: string, actor: string, entityId: string, action: string, data: Json) {
    return this.prisma.auditEvent.create({ data: { organizationId: org, actor, entityType: 'mcp', entityId, action, data: data as Prisma.InputJsonValue } }).catch(() => undefined);
  }
}

const rpcResult = (id: string | number, result: Json) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolText = (text: string, isError: boolean) => ({ content: [{ type: 'text', text }], isError });
