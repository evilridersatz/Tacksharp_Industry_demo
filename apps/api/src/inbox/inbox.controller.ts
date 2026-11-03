import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { InboxService } from './inbox.service.js';

/** Team inbox (all channels, every industry). Organization from the session only; permissions checked per action. */
@Controller('inbox')
export class InboxController {
  constructor(private readonly svc: InboxService) {}

  private actor(u: SessionClaims) {
    return { sub: u.sub, org: u.org, role: u.role };
  }

  @Get('conversations')
  list(@CurrentUser() u: SessionClaims, @Query() q: Record<string, string>) {
    requirePermission(u, PERMISSIONS.inboxView);
    return this.svc.list(u.org, u.sub, q);
  }

  @Get('conversations/:id')
  detail(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.inboxView);
    return this.svc.detail(u.org, id);
  }

  @Patch('conversations/:id')
  update(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.inboxReply);
    return this.svc.update(this.actor(u), id, body ?? {});
  }

  @Post('conversations/:id/take-over')
  @HttpCode(200)
  takeOver(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.inboxReply);
    return this.svc.takeOver(this.actor(u), id);
  }

  @Post('conversations/:id/return-to-ai')
  @HttpCode(200)
  returnToAi(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.inboxReply);
    return this.svc.returnToAi(this.actor(u), id);
  }

  @Post('conversations/:id/notes')
  @HttpCode(200)
  note(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { body?: unknown }) {
    requirePermission(u, PERMISSIONS.inboxReply);
    return this.svc.addNote(this.actor(u), id, body?.body);
  }

  @Post('conversations/:id/reply')
  @HttpCode(200)
  reply(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { text?: unknown }) {
    requirePermission(u, PERMISSIONS.inboxReply);
    return this.svc.reply(this.actor(u), id, body?.text);
  }

  @Post('conversations/:id/assign-round-robin')
  @HttpCode(200)
  roundRobin(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.inboxManage);
    return this.svc.assignRoundRobin(this.actor(u), u.org, id);
  }

  @Post('conversations/:id/drafts/:messageId/approve')
  @HttpCode(200)
  approveDraft(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Param('messageId') messageId: string, @Body() body: { text?: unknown }) {
    requirePermission(u, PERMISSIONS.inboxReply);
    return this.svc.approveDraft(this.actor(u), id, messageId, body ?? {});
  }

  @Post('conversations/:id/drafts/:messageId/discard')
  @HttpCode(200)
  discardDraft(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Param('messageId') messageId: string) {
    requirePermission(u, PERMISSIONS.inboxReply);
    return this.svc.discardDraft(this.actor(u), id, messageId);
  }

  @Get('members')
  members(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.inboxView);
    return this.svc.members(u.org);
  }

  @Get('saved-replies')
  saved(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.inboxView);
    return this.svc.savedReplies(u.org);
  }

  @Post('saved-replies')
  createSaved(@CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.inboxManage);
    return this.svc.saveReply(this.actor(u), null, body ?? {});
  }

  @Patch('saved-replies/:id')
  updateSaved(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.inboxManage);
    return this.svc.saveReply(this.actor(u), id, body ?? {});
  }

  @Delete('saved-replies/:id')
  deleteSaved(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.inboxManage);
    return this.svc.deleteReply(this.actor(u), id);
  }
}
