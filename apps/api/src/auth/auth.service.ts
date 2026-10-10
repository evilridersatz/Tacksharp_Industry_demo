import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { log } from '../common/logger.js';
import { hashPassword, verifyPassword } from './password.js';
import { signSession } from './token.js';

const SESSION_DAYS = 7;

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Same error and similar timing whether the email exists or not.
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, DUMMY_HASH);
    if (!user || !ok) {
      log.warn('auth.login_failed', { email: maskEmail(email) });
      throw new UnauthorizedException('Wrong email or password.');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const token = signSession({ sub: user.id, org: user.organizationId, role: user.role, exp }, config.auth.secret);
    log.info('auth.login', { userId: user.id, organizationId: user.organizationId });
    return { token, maxAgeSec: SESSION_DAYS * 86400, user: publicUser(user) };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { organization: true } });
    if (!user) throw new UnauthorizedException();
    return { ...publicUser(user), organizationName: user.organization.name, vertical: user.organization.vertical };
  }

  async createUser(input: { organizationId: string; email: string; password: string; name?: string; role?: string }) {
    const passwordHash = await hashPassword(input.password);
    return this.prisma.user.upsert({
      where: { email: input.email.trim().toLowerCase() },
      create: {
        organizationId: input.organizationId,
        email: input.email.trim().toLowerCase(),
        name: input.name,
        role: input.role ?? 'admin',
        passwordHash,
      },
      update: { passwordHash, name: input.name, organizationId: input.organizationId },
    });
  }
}

// A real scrypt hash of a random string, used to equalize timing for unknown emails.
const DUMMY_HASH = 'scrypt$c2FsdHNhbHRzYWx0c2FsdA==$' + Buffer.alloc(64, 1).toString('base64');

function publicUser(u: { id: string; email: string; name: string | null; role: string; organizationId: string }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, organizationId: u.organizationId };
}

function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  return `${(name ?? '').slice(0, 2)}***@${domain ?? ''}`;
}
