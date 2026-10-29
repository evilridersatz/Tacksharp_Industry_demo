import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { CurrentUser, Public } from './decorators.js';
import { SESSION_COOKIE } from './auth.guard.js';
import type { SessionClaims } from './token.js';
import { config } from '../common/config.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email?: string; password?: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(String(body?.email ?? ''), String(body?.password ?? ''));
    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      path: '/',
      maxAge: result.maxAgeSec * 1000,
    });
    // Token is also returned for API clients (Authorization: Bearer). The dashboard uses the cookie.
    return { user: result.user, token: result.token };
  }

  /** Self-service registration: creates the organization + its first admin (pending review) and signs them in. */
  @Public()
  @Post('signup')
  @HttpCode(201)
  async signup(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.signup(body);
    res.cookie(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/', maxAge: r.maxAgeSec * 1000 });
    return { user: r.user, organization: r.organization };
  }

  /** Records a reset request for the admins (no email provider); same answer whether or not the email exists. */
  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() body: { email?: unknown }) {
    return this.auth.forgotPassword(body?.email);
  }

  /** Whether public registration is open (the signup page asks before showing the form). */
  @Public()
  @Get('signup-status')
  signupStatus() {
    return { enabled: config.signup.enabled, emailVerification: 'not_configured', activation: 'platform_review' };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: SessionClaims) {
    return this.auth.me(user.sub, user);
  }

  @Get('workspaces')
  workspaces(@CurrentUser() user: SessionClaims) {
    return this.auth.workspaces(user.sub).then((list) => list.map((w) => ({ ...w, current: w.organizationId === user.org })));
  }

  /** Open another workspace (industry) the user is a member of. The server checks the membership. */
  @Post('workspace')
  @HttpCode(200)
  async switchWorkspace(@CurrentUser() user: SessionClaims, @Body() body: { organizationId?: string }, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.switchWorkspace(user.sub, String(body?.organizationId ?? ''));
    res.cookie(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/', maxAge: r.maxAgeSec * 1000 });
    return { workspace: r.workspace, token: r.token };
  }
}
