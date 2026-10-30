import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, Org, Public } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { VoiceAgentsService } from './voice-agents.service.js';

type ChatBody = { message?: unknown; history?: unknown; lang?: unknown };

@Controller()
export class VoiceAgentsController {
  constructor(private readonly svc: VoiceAgentsService) {}

  @Get('voice-agents')
  list(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.svc.list(org);
  }

  @Get('voice-agents/templates')
  templates(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.svc.templates();
  }

  @Get('voice-agents/:id')
  get(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.svc.get(org, id);
  }

  @Post('voice-agents')
  create(@CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.svc.create({ sub: u.sub, org: u.org }, body ?? {});
  }

  @Patch('voice-agents/:id')
  update(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.svc.update({ sub: u.sub, org: u.org }, id, body ?? {});
  }

  /** Test mode: one real turn with the agent's instructions and knowledge base. No call, no message is sent. */
  @Post('voice-agents/:id/test')
  @HttpCode(200)
  test(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: ChatBody) {
    requirePermission(u, PERMISSIONS.agentsRun);
    return this.svc.test({ sub: u.sub, org: u.org }, id, body ?? {});
  }

  @Post('voice-agents/:id/publish')
  @HttpCode(200)
  publish(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.svc.publish({ sub: u.sub, org: u.org }, id);
  }

  @Post('voice-agents/:id/archive')
  @HttpCode(200)
  archive(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.svc.archive({ sub: u.sub, org: u.org }, id);
  }

  @Post('voice-agents/:id/restore')
  @HttpCode(200)
  restore(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.svc.restore({ sub: u.sub, org: u.org }, id);
  }

  // ------------------------------------------------------------------ public template demos (simulated, sample data)

  @Public()
  @Get('demos/agents')
  demoList() {
    return this.svc.templates();
  }

  @Public()
  @Post('demos/agents/:key/chat')
  @HttpCode(200)
  demoChat(@Param('key') key: string, @Body() body: ChatBody) {
    return this.svc.demo(key, body ?? {});
  }
}
