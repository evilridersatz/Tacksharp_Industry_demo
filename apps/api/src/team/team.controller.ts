import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Public } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { SESSION_COOKIE } from '../auth/auth.guard.js';
import { config } from '../common/config.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { TeamService } from './team.service.js';

/** Members and access links of the logged-in workspace (organization from the session). Admins only. */
@Controller('team')
export class TeamController {
  constructor(private readonly svc: TeamService) {}

  @Get()
  members(@CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.usersManage);
    return this.svc.members(u.org);
  }

  @Post('invitations')
  invite(@CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.usersManage);
    return this.svc.invite(u, body ?? {});
  }

  @Post('invitations/:id/revoke')
  @HttpCode(200)
  revoke(@CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.usersManage);
    return this.svc.revokeInvitation(u, id);
  }

  @Patch('members/:userId')
  role(@CurrentUser() u: SessionClaims, @Param('userId') userId: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.usersManage);
    return this.svc.changeRole(u, userId, body ?? {});
  }

  @Delete('members/:userId')
  remove(@CurrentUser() u: SessionClaims, @Param('userId') userId: string) {
    requirePermission(u, PERMISSIONS.usersManage);
    return this.svc.remove(u, userId);
  }

  @Post('members/:userId/reset-link')
  reset(@CurrentUser() u: SessionClaims, @Param('userId') userId: string) {
    requirePermission(u, PERMISSIONS.usersManage);
    return this.svc.resetLink(u, userId);
  }

  /** Public: what an invitation / reset link is for. The token travels in the body, never in a URL. */
  @Public()
  @Post('links/inspect')
  @HttpCode(200)
  inspect(@Body() body: { token?: unknown }) {
    return this.svc.inspect(body?.token);
  }

  /** Public: use the link (set a password / join the workspace); signs the person in. */
  @Public()
  @Post('links/accept')
  @HttpCode(200)
  async accept(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.accept(body ?? {});
    res.cookie(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/', maxAge: r.maxAgeSec * 1000 });
    return { organizationId: r.organizationId, kind: r.kind };
  }
}
