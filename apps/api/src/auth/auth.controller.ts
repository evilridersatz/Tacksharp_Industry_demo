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

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: SessionClaims) {
    return this.auth.me(user.sub);
  }
}
