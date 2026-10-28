/**
 * Sharable workspace access: expiring single-use invitation / reset links, immediate revocation, roles read from the
 * database on every request, read-only viewers, and no way across workspaces. Real database (TEST_DB_NAME).
 * No email is sent (no provider is configured): links are returned once to the admin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const HOTEL = 'org_ta_hotel';
const TEXTILE = 'org_ta_textile';
const run = Date.now().toString(36);
const mail = (n: string) => `ta-${n}-${run}@example.test`;

describe.skipIf(!enabled)('team access (integration)', () => {
  let prisma: any, team: any, auth: any, Guard: any, signSession: any, config: any, reflector: any;
  let hotelAdmin: any, textileAdmin: any;

  const ctx = (token: string, method = 'GET', path = '/customers') => {
    const req: any = { headers: { cookie: `ts_session=${encodeURIComponent(token)}` }, method, path };
    return { req, c: { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => undefined, getClass: () => undefined } };
  };
  const guard = () => new Guard(reflector, prisma);
  const allow = async (token: string, method = 'GET', path = '/customers') => { const { req, c } = ctx(token, method, path); await guard().canActivate(c); return req.auth; };
  const actor = (u: any, org: string) => ({ sub: u.id, org });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { TeamService } = await import('../src/team/team.service.js');
    const { AuthService } = await import('../src/auth/auth.service.js');
    ({ AuthGuard: Guard } = await import('../src/auth/auth.guard.js'));
    ({ signSession } = await import('../src/auth/token.js'));
    ({ config } = await import('../src/common/config.js'));
    reflector = { getAllAndOverride: () => false };
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, isDemo] of [[HOTEL, true], [TEXTILE, true]] as const) await prisma.organization.upsert({ where: { id }, update: {}, create: { id, name: id, vertical: 'real_estate', isDemo } });
    team = new TeamService(prisma);
    auth = new AuthService(prisma);
    hotelAdmin = await auth.createUser({ organizationId: HOTEL, email: mail('hadmin'), password: 'hotel-admin-pass-1', role: 'admin' });
    textileAdmin = await auth.createUser({ organizationId: TEXTILE, email: mail('tadmin'), password: 'textile-admin-pass-1', role: 'admin' });
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.userInvitation.deleteMany({ where: { organizationId: { in: [HOTEL, TEXTILE] } } });
    await prisma.auditEvent.deleteMany({ where: { organizationId: { in: [HOTEL, TEXTILE] } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: [HOTEL, TEXTILE] } } });
    await prisma.user.deleteMany({ where: { email: { contains: `-${run}@example.test` } } });
    await prisma.$disconnect();
  });

  it('an admin invites a demo viewer; the link is single-use, lands them in that workspace only, and is read-only', async () => {
    await expect(team.invite(actor(hotelAdmin, HOTEL), { email: 'nope', role: 'viewer' })).rejects.toMatchObject({ status: 400 });
    await expect(team.invite(actor(hotelAdmin, HOTEL), { email: mail('v'), role: 'superadmin' })).rejects.toMatchObject({ status: 400 });
    const link = await team.invite(actor(hotelAdmin, HOTEL), { email: mail('v'), role: 'viewer' });
    expect(link).toMatchObject({ kind: 'invite', role: 'viewer', path: expect.stringMatching(/^\/invite#/), emailDelivery: 'not_configured' });
    const stored = await prisma.userInvitation.findUnique({ where: { id: link.id } });
    expect(stored.tokenHash).not.toBe(link.token); // only the hash is kept
    expect(await team.inspect(link.token)).toMatchObject({ kind: 'invite', email: mail('v'), workspace: HOTEL, existingAccount: false });
    await expect(team.accept({ token: link.token, password: 'short' })).rejects.toMatchObject({ status: 400 });
    const r = await team.accept({ token: link.token, name: 'Viewer', password: 'a-long-viewer-password' });
    expect(r.organizationId).toBe(HOTEL);
    await expect(team.accept({ token: link.token, password: 'a-long-viewer-password' })).rejects.toMatchObject({ status: 400 }); // single use
    const claims = await allow(r.token);
    expect(claims).toMatchObject({ org: HOTEL, role: 'viewer' });
    await expect(allow(r.token, 'POST', '/customers')).rejects.toMatchObject({ status: 403 });       // read-only
    await expect(allow(r.token, 'POST', '/auth/logout')).resolves.toBeTruthy();
    const ws = await auth.workspaces(claims.sub);
    expect(ws.map((w: any) => w.organizationId)).toEqual([HOTEL]);                               // no other industry
    await expect(auth.switchWorkspace(claims.sub, TEXTILE)).rejects.toMatchObject({ status: 403 });
    expect(await prisma.auditEvent.count({ where: { organizationId: HOTEL, entityType: 'team', action: { in: ['invitation_created', 'invitation_accepted'] } } })).toBeGreaterThanOrEqual(2);
  });

  it('expired, revoked and replaced links do not work', async () => {
    const a = await team.invite(actor(hotelAdmin, HOTEL), { email: mail('e'), role: 'sales' });
    const b = await team.invite(actor(hotelAdmin, HOTEL), { email: mail('e'), role: 'sales' }); // replaces a
    await expect(team.inspect(a.token)).rejects.toMatchObject({ status: 400 });
    await prisma.userInvitation.update({ where: { id: b.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(team.accept({ token: b.token, password: 'whatever-long-password' })).rejects.toMatchObject({ response: { message: expect.stringMatching(/expired/) } });
    const c = await team.invite(actor(hotelAdmin, HOTEL), { email: mail('e'), role: 'sales' });
    await team.revokeInvitation(actor(hotelAdmin, HOTEL), c.id);
    await expect(team.inspect(c.token)).rejects.toMatchObject({ status: 400 });
    await expect(team.inspect('x'.repeat(43))).rejects.toMatchObject({ status: 400 });
  });

  it('an existing account joins another workspace only with its own password (a link cannot take it over)', async () => {
    const link = await team.invite(actor(textileAdmin, TEXTILE), { email: mail('hadmin'), role: 'manager' });
    expect((await team.inspect(link.token)).existingAccount).toBe(true);
    await expect(team.accept({ token: link.token, password: 'attacker-new-password' })).rejects.toMatchObject({ status: 401 });
    const ok = await team.accept({ token: link.token, currentPassword: 'hotel-admin-pass-1' });
    expect(ok.organizationId).toBe(TEXTILE);
    expect(await allow((await auth.login(mail('hadmin'), 'hotel-admin-pass-1')).token)).toMatchObject({ org: HOTEL, role: 'admin' }); // password unchanged
    expect((await auth.workspaces(hotelAdmin.id)).map((w: any) => w.organizationId).sort()).toEqual([HOTEL, TEXTILE].sort());
  });

  it('role changes and removal apply to existing sessions at once; removed people cannot log in', async () => {
    const link = await team.invite(actor(hotelAdmin, HOTEL), { email: mail('s'), role: 'sales' });
    const r = await team.accept({ token: link.token, password: 'sales-person-password' });
    expect((await allow(r.token)).role).toBe('sales');
    const userId = (await prisma.user.findUnique({ where: { email: mail('s') } })).id;
    await team.changeRole(actor(hotelAdmin, HOTEL), userId, { role: 'viewer' });
    expect((await allow(r.token)).role).toBe('viewer');                    // same token, new role
    await team.remove(actor(hotelAdmin, HOTEL), userId);
    await expect(allow(r.token)).rejects.toMatchObject({ status: 401 });   // session refused now
    await expect(auth.login(mail('s'), 'sales-person-password')).rejects.toMatchObject({ status: 401 });
  });

  it('a removed guest membership ends that workspace session immediately but not their home access', async () => {
    const hotelSession = (await auth.switchWorkspace(hotelAdmin.id, TEXTILE)).token;
    expect((await allow(hotelSession)).org).toBe(TEXTILE);
    await team.remove(actor(textileAdmin, TEXTILE), hotelAdmin.id);
    await expect(allow(hotelSession)).rejects.toMatchObject({ status: 401 });
    expect((await allow((await auth.login(mail('hadmin'), 'hotel-admin-pass-1')).token)).org).toBe(HOTEL);
  });

  it('password reset: only for home members, single use, and every older session ends', async () => {
    const link = await team.invite(actor(hotelAdmin, HOTEL), { email: mail('r'), role: 'front_desk' });
    const first = await team.accept({ token: link.token, password: 'front-desk-password' });
    const userId = (await prisma.user.findUnique({ where: { email: mail('r') } })).id;
    const reset = await team.resetLink(actor(hotelAdmin, HOTEL), userId);
    expect(reset.kind).toBe('reset');
    const after = await team.accept({ token: reset.token, password: 'a-brand-new-password' });
    await expect(allow(first.token)).rejects.toMatchObject({ status: 401 });   // old session revoked
    expect((await allow(after.token)).org).toBe(HOTEL);
    await expect(auth.login(mail('r'), 'front-desk-password')).rejects.toMatchObject({ status: 401 });
    // another workspace's admin cannot reset a guest's account (account takeover guard)
    const g = await team.invite(actor(textileAdmin, TEXTILE), { email: mail('r'), role: 'viewer' });
    await team.accept({ token: g.token, currentPassword: 'a-brand-new-password' });
    await expect(team.resetLink(actor(textileAdmin, TEXTILE), userId)).rejects.toMatchObject({ status: 403 });
  });

  it('cross-workspace: an admin cannot see, change or remove another workspace\'s people', async () => {
    const hotelPeople = await team.members(HOTEL);
    const someone = hotelPeople.members.find((m: any) => m.email === mail('v')); // hotel-only viewer, no textile access
    await expect(team.changeRole(actor(textileAdmin, TEXTILE), someone.userId, { role: 'admin' })).rejects.toMatchObject({ status: 404 });
    await expect(team.remove(actor(textileAdmin, TEXTILE), someone.userId)).rejects.toMatchObject({ status: 404 });
    expect((await team.members(TEXTILE)).members.some((m: any) => m.userId === someone.userId)).toBe(false);
  });

  it('safety rails: no self-removal, a workspace keeps one admin, a forged or tampered session is refused', async () => {
    await expect(team.remove(actor(hotelAdmin, HOTEL), hotelAdmin.id)).rejects.toMatchObject({ status: 403 });
    await expect(team.changeRole(actor(hotelAdmin, HOTEL), hotelAdmin.id, { role: 'viewer' })).rejects.toMatchObject({ status: 403 });
    const forged = signSession({ sub: hotelAdmin.id, org: TEXTILE, role: 'admin', exp: Math.floor(Date.now() / 1000) + 600, iat: Date.now() }, 'not-the-secret-at-all-not-the-secret');
    await expect(allow(forged)).rejects.toMatchObject({ status: 401 });
    const claimsOrg = signSession({ sub: hotelAdmin.id, org: TEXTILE, role: 'admin', exp: Math.floor(Date.now() / 1000) + 600, iat: Date.now() }, config.auth.secret);
    await expect(allow(claimsOrg)).rejects.toMatchObject({ status: 401 }); // home is HOTEL, no TEXTILE membership any more
  });
});
