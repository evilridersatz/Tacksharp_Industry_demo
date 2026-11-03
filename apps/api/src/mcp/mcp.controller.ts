import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Public } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { MCP_PROTOCOL_VERSIONS, McpService } from './mcp.service.js';

/**
 * MCP server, Streamable HTTP transport (stateless, JSON responses): POST /mcp with one JSON-RPC message or a batch.
 * Authentication: `Authorization: Bearer tsk_mcp_...` (an access key from Settings → Integrations → MCP server). The
 * session cookie is never accepted here. Requests from a browser Origin that is not one of this deployment's own web
 * origins are refused (DNS-rebinding protection required by the MCP spec). GET (server stream) and DELETE (session
 * end) are not offered: 405.
 */
@Controller('mcp')
export class McpController {
  constructor(private readonly svc: McpService) {}

  @Public()
  @Post()
  async rpc(@Headers('authorization') auth: string | undefined, @Headers('origin') origin: string | undefined, @Headers('mcp-protocol-version') version: string | undefined, @Body() body: unknown, @Res() res: Response) {
    const allowed = (process.env.CORS_ORIGINS ?? 'http://localhost:3001').split(',').map((s) => s.trim());
    if (origin && !allowed.includes(origin)) return res.status(403).json(err(null, -32000, 'Origin not allowed'));
    if (version && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return res.status(400).json(err(null, -32000, `Unsupported MCP-Protocol-Version: ${version}`));
    const key = await this.svc.authenticate(auth);
    if (!key) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="tacksharp-mcp"');
      return res.status(401).json(err(null, -32001, 'A valid MCP access key is required (Authorization: Bearer tsk_mcp_...)'));
    }
    if (this.svc.rateLimited(key.id)) return res.status(429).json(err(null, -32002, 'Too many requests: at most 120 per minute per key'));
    if (body === undefined || body === null || typeof body !== 'object') return res.status(400).json(err(null, -32700, 'Parse error: send a JSON-RPC message'));
    if (Array.isArray(body)) {
      if (!body.length || body.length > 20) return res.status(400).json(err(null, -32600, 'Batch of 1-20 messages'));
      const out = (await Promise.all(body.map((m) => this.svc.handle(key, m)))).filter((r) => r !== null);
      return out.length ? res.status(200).json(out) : res.status(202).end();
    }
    const out = await this.svc.handle(key, body);
    return out ? res.status(200).json(out) : res.status(202).end();
  }

  @Public()
  @Get()
  noStream(@Res() res: Response) {
    res.setHeader('Allow', 'POST');
    return res.status(405).json(err(null, -32000, 'This server does not offer a server-to-client stream; use POST'));
  }

  @Public()
  @Delete()
  noSession(@Res() res: Response) {
    res.setHeader('Allow', 'POST');
    return res.status(405).json(err(null, -32000, 'Stateless server: there is no session to end'));
  }

  // ------------------------------------------------------------------------------------- key management (session)
  @Get('keys')
  keys(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.listKeys(u.org);
  }

  @Post('keys')
  @HttpCode(201)
  create(@CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.createKey({ sub: u.sub, org: u.org }, body ?? {});
  }

  @Post('keys/:id/revoke')
  @HttpCode(200)
  revoke(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.integrationsManage);
    return this.svc.revokeKey({ sub: u.sub, org: u.org }, id);
  }

  @Get('tools')
  tools(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.integrationsView);
    return this.svc.tools().map((t) => ({ name: t.name, title: t.title, description: t.description, write: t.write }));
  }
}

const err = (id: string | number | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
