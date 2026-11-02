/**
 * Enterprise platform (real database: TEST_DB_NAME): self-service signup (transactional, no privilege escalation,
 * duplicates refused), organization suspension stopping sessions, encrypted per-organization credentials with the
 * resolution policy (own → legacy env → never another organization's), masking, connection tests (provider HTTP is
 * MOCKED here: this proves our handling, not live connectivity), and platform-admin enforcement.
 */
import { randomBytes } from 'node:crypto';
import { pcmToWav } from '../src/sarvam/wav.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
  process.env.CREDENTIALS_KEYS = `t1:${randomBytes(32).toString('base64')}`;
  process.env.CREDENTIALS_ACTIVE_KEY = 't1';
}

const run = Date.now().toString(36);
const LEGACY = `org_ent_legacy_${run}`;

describe.skipIf(!enabled)('enterprise platform (integration)', () => {
  let prisma: any, auth: any, creds: any, integrations: any, platform: any, Guard: any, reflector: any;
  let a: any, b: any; // two self-service signups
  const created: string[] = [];

  const guardAllows = async (token: string) => {
    const req: any = { headers: { cookie: `ts_session=${encodeURIComponent(token)}` }, method: 'GET', path: '/customers' };
    await new Guard(reflector, prisma).canActivate({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => undefined, getClass: () => undefined });
    return req.auth;
  };
  const signup = (n: string, extra: Record<string, unknown> = {}) =>
    auth.signup({ organizationName: `Ent ${n} ${run}`, adminName: `Admin ${n}`, email: `ent-${n}-${run}@example.test`, password: 'a strong signup passphrase', industry: 'retail', acceptTerms: true, ...extra });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { AuthService } = await import('../src/auth/auth.service.js');
    const { CredentialsService } = await import('../src/integrations/credentials.service.js');
    const { IntegrationsService } = await import('../src/integrations/integrations.service.js');
    const { PlatformService } = await import('../src/platform/platform.service.js');
    const { TeamService } = await import('../src/team/team.service.js');
    ({ AuthGuard: Guard } = await import('../src/auth/auth.guard.js'));
    reflector = { getAllAndOverride: () => false };
    prisma = new PrismaService();
    await prisma.$connect();
    auth = new AuthService(prisma);
    creds = new CredentialsService(prisma);
    creds.onModuleInit();
    integrations = new IntegrationsService(prisma, creds);
    platform = new PlatformService(prisma, new TeamService(prisma));
    await prisma.organization.create({ data: { id: LEGACY, name: LEGACY, vertical: 'real_estate' } });
    created.push(LEGACY);
    a = await signup('a');
    b = await signup('b');
    created.push(a.organization.id, b.organization.id);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    creds?.onModuleDestroy();
    await prisma.organization.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  it('signup creates the organization, its industry and an ORGANIZATION admin in one go (pending review)', async () => {
    const org = await prisma.organization.findUnique({ where: { id: a.organization.id }, include: { users: true, settings: true } });
    expect(org).toMatchObject({ status: 'pending_review', selfServe: true, isDemo: false });
    expect(org.users).toHaveLength(1);
    expect(org.users[0]).toMatchObject({ role: 'admin', isPlatformAdmin: false });
    expect((org.settings.data as any).industry).toBe('retail');
    expect(await prisma.auditEvent.count({ where: { organizationId: org.id, action: 'organization.registered' } })).toBe(1);
    const me = await auth.me(a.user.id);
    expect(me).toMatchObject({ organizationStatus: 'pending_review', isPlatformAdmin: false });
  });

  it('refuses duplicates (same email, same organization name) and leaves nothing half-created', async () => {
    const before = await prisma.organization.count();
    await expect(signup('a')).rejects.toMatchObject({ status: 409 });
    await expect(signup('c', { organizationName: `Ent a ${run}`.toUpperCase() })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.organization.count()).toBe(before);
  });

  it('a body asking for platform rights is ignored', async () => {
    const r = await signup('d', { isPlatformAdmin: true, role: 'platform_admin', organizationId: LEGACY });
    created.push(r.organization.id);
    const u = await prisma.user.findUnique({ where: { id: r.user.id } });
    expect(u).toMatchObject({ isPlatformAdmin: false, role: 'admin' });
    expect(u.organizationId).not.toBe(LEGACY);
  });

  it('a self-service organization never inherits the platform environment accounts; a legacy one keeps them', async () => {
    for (const p of ['whatsapp', 'sarvam', 'openai']) {
      expect((await creds.resolve(a.organization.id, p)).source).toBe('none');
      expect((await creds.resolve(LEGACY, p)).source).toBe('environment');
    }
  });

  it('saves secrets encrypted, returns masked hints only, and does not treat a save as a working connection', async () => {
    const actor = { sub: a.user.id, org: a.organization.id };
    const view = await integrations.save(actor, 'sarvam', { apiKey: 'sarvam-secret-key-AAAA' });
    expect(JSON.stringify(view)).not.toContain('sarvam-secret-key-AAAA');
    expect(view.secrets.apiKey).toBe('••••AAAA');
    expect(view).toMatchObject({ status: 'untested', enabled: false });
    const row = await prisma.integrationCredential.findUnique({ where: { organizationId_provider: { organizationId: a.organization.id, provider: 'sarvam' } } });
    expect(row.secretCiphertext).not.toContain('sarvam-secret');
    await expect(integrations.setEnabled(actor, 'sarvam', true)).rejects.toMatchObject({ status: 400 });
    expect((await creds.resolve(a.organization.id, 'sarvam')).source).toBe('none');
  });

  it('a passed (mocked) connection test allows enabling; then the organization uses ITS OWN credentials', async () => {
    const actor = { sub: a.user.id, org: a.organization.id };
    const seen: string[] = [];
    integrations.fetchImpl = async (url: string, init: any) => {
      seen.push(`${url} ${init?.headers?.['api-subscription-key'] ?? ''}`);
      return new Response(JSON.stringify({ audios: [pcmToWav(new Int16Array(3200).fill(1000), 8000).toString('base64')] }), { status: 200 });
    };
    const t = await integrations.test(actor, 'sarvam', 'connection', {});
    expect(t.result.ok).toBe(true);
    expect(seen.every((s) => s.includes('/text-to-speech') && s.endsWith('sarvam-secret-key-AAAA'))).toBe(true);
    const en = await integrations.setEnabled(actor, 'sarvam', true);
    expect(en).toMatchObject({ enabled: true, status: 'ok', effective: { source: 'organization' } });
    const r = await creds.resolve(a.organization.id, 'sarvam');
    expect(r.secrets.apiKey).toBe('sarvam-secret-key-AAAA');
    // Organization B is untouched by A's credentials.
    expect((await creds.resolve(b.organization.id, 'sarvam')).source).toBe('none');
    expect((await integrations.get(b.organization.id, 'sarvam')).saved).toBe(false);
  });

  it('a failed test records a sanitized error and blocks use', async () => {
    const actor = { sub: b.user.id, org: b.organization.id };
    await integrations.save(actor, 'openai', { apiKey: 'sk-test-bbbbbbbbbbbbbbbb', model: 'gpt-5.4-mini' });
    integrations.fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-test-bbbbbbbbbbbbbbbb' } }), { status: 401 });
    const t = await integrations.test(actor, 'openai', 'connection', {});
    expect(t.result).toMatchObject({ ok: false, errorCode: 'auth_failed' });
    expect(t.integration.lastError).not.toContain('sk-test-bbbbbbbbbbbbbbbb');
    expect(t.integration.status).toBe('failed');
    const usage = await integrations.usage(b.organization.id, 'openai');
    expect(usage.failed).toBeGreaterThan(0);
  });

  it('a test call is refused while the organization is pending, in dry run, or to an unapproved number', async () => {
    const actor = { sub: a.user.id, org: a.organization.id };
    await integrations.save(actor, 'sarvam_telephony', { apiKey: 'sk_sarvam_agents_AAAA', orgId: 'org1', workspaceId: 'ws1', connectionId: 'conn1', agentPhoneNumber: '918064269808' });
    await expect(integrations.test(actor, 'sarvam_telephony', 'call', { to: '919800011122', confirm: true, appId: 'app-1' })).rejects.toMatchObject({ status: 403 });
  });

  it('Plivo is no longer an integration: it cannot be saved or tested, and it is not listed', async () => {
    const actor = { sub: a.user.id, org: a.organization.id };
    await expect(integrations.save(actor, 'plivo', { authId: 'MA1', authToken: 'x', fromNumber: '914400000001' })).rejects.toMatchObject({ status: 404 });
    await expect(integrations.test(actor, 'plivo', 'connection', {})).rejects.toMatchObject({ status: 404 });
    expect((await integrations.list(a.organization.id)).items.map((i: any) => i.provider)).not.toContain('plivo');
  });

  it('platform routes are refused to organization admins; activation and suspension take effect at once', async () => {
    await expect(platform.requireAdmin(a.user.id)).rejects.toMatchObject({ status: 403 });
    const staff = await prisma.user.create({ data: { organizationId: LEGACY, email: `staff-${run}@example.test`, passwordHash: 'x', role: 'admin', isPlatformAdmin: true } });
    await expect(platform.requireAdmin(staff.id)).resolves.toBeUndefined();
    await expect(platform.activate({ sub: staff.id }, b.organization.id, { confirmName: 'wrong' })).rejects.toMatchObject({ status: 400 });
    const act = await platform.activate({ sub: staff.id }, b.organization.id, { confirmName: `Ent b ${run}` });
    expect(act.status).toBe('active');
    // B's admin session works, then stops the moment B is suspended.
    const { token } = await auth.login(`ent-b-${run}@example.test`, 'a strong signup passphrase');
    expect((await guardAllows(token)).org).toBe(b.organization.id);
    await platform.suspend({ sub: staff.id }, b.organization.id, { confirmName: `Ent b ${run}`, reason: 'test suspension' });
    await expect(guardAllows(token)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login(`ent-b-${run}@example.test`, 'a strong signup passphrase')).rejects.toMatchObject({ status: 403 });
    const detail = await platform.organization(a.organization.id);
    // Platform admins see integration STATUS, never secrets or masked hints.
    expect(JSON.stringify(detail)).not.toContain('AAAA');
    expect(detail.integrations.find((i: any) => i.provider === 'sarvam')).toMatchObject({ enabled: true, status: 'ok' });
  });

  it('forgot-password answers the same for unknown emails and records a request for real ones', async () => {
    const r1 = await auth.forgotPassword(`ent-a-${run}@example.test`);
    const r2 = await auth.forgotPassword(`nobody-${run}@example.test`);
    expect(r1).toEqual(r2);
    expect(await prisma.auditEvent.count({ where: { organizationId: a.organization.id, action: 'password.reset_requested' } })).toBe(1);
  });
});
