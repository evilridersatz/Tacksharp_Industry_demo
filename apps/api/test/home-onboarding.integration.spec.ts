/**
 * Business-owner Home and onboarding against the real database (TEST_DB_NAME): chicken-shop signup, converting a new
 * self-service workspace to the chicken-shop engine (and refusing it for workspaces with data), shops and categories,
 * the Home readiness checklist (never green when incomplete; "connected" only with proof), real metrics with empty
 * states, the agent launch checklist, and tenant isolation. Nothing is sent; no provider is called.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
  process.env.CREDENTIALS_KEYS = `t1:${randomBytes(32).toString('base64')}`;
  process.env.CREDENTIALS_ACTIVE_KEY = 't1';
  process.env.DRY_RUN = 'true';
}
const run = Date.now().toString(36);

describe.skipIf(!enabled)('home and onboarding (integration)', () => {
  let prisma: any, auth: any, home: any, settingsCtl: any, catalog: any, tel: any, creds: any;
  const created: string[] = [];
  const signup = (n: string, industry: string) => auth.signup({ organizationName: `Home ${n} ${run}`, adminName: `Admin ${n}`, email: `home-${n}-${run}@example.test`, password: 'a strong signup passphrase', industry, acceptTerms: true });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { AuthService } = await import('../src/auth/auth.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { SettingsController } = await import('../src/settings/settings.controller.js');
    const { CredentialsService } = await import('../src/integrations/credentials.service.js');
    const { HomeService } = await import('../src/home/home.service.js');
    const { CatalogService } = await import('../src/restaurant/catalog.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    const { TelephonyService } = await import('../src/telephony/telephony.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    auth = new AuthService(prisma);
    const settings = new SettingsService(prisma);
    creds = new CredentialsService(prisma);
    creds.onModuleInit();
    home = new HomeService(prisma, settings, creds);
    settingsCtl = new SettingsController(settings, prisma, new TenancyService(prisma));
    catalog = new CatalogService(prisma);
    tel = new TelephonyService(prisma, {} as any, { settingsFor: async () => ({ calling: { windowStartHour: 9, windowEndHour: 20 } }) } as any);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    creds?.onModuleDestroy();
    await prisma.menuItem.deleteMany({ where: { organizationId: { in: created } } });
    await prisma.organization.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  it('signup as "GR Chicken / Chicken Shop" creates a restaurant-engine workspace (industry food in Settings)', async () => {
    const r = await signup('chicken', 'chicken_shop');
    created.push(r.organization.id);
    expect(r.organization).toMatchObject({ industry: 'restaurant', status: 'pending_review' });
    const org = await prisma.organization.findUnique({ where: { id: r.organization.id }, include: { settings: true } });
    expect(org).toMatchObject({ vertical: 'restaurant', selfServe: true });
    expect(org.settings.data.industry).toBe('food');
  });

  it('a new empty self-service workspace can become a chicken shop; one with data, a demo or a legacy one cannot', async () => {
    const r = await signup('convert', 'retail');
    created.push(r.organization.id);
    const admin = { sub: r.user.id, org: r.organization.id, role: 'admin' };
    await expect(settingsCtl.update(r.organization.id, { ...admin, role: 'viewer' }, { industry: 'chicken_shop' })).rejects.toMatchObject({ status: 403 });
    const ok = await settingsCtl.update(r.organization.id, admin, { industry: 'chicken_shop' });
    expect(ok.industry).toBe('restaurant');
    expect((await prisma.organization.findUnique({ where: { id: r.organization.id } })).vertical).toBe('restaurant');
    expect(await prisma.auditEvent.count({ where: { organizationId: r.organization.id, action: 'industry_changed' } })).toBe(1);

    const busy = await signup('busy', 'retail');
    created.push(busy.organization.id);
    await prisma.customer.create({ data: { organizationId: busy.organization.id, phone: '919811100001' } });
    await expect(settingsCtl.update(busy.organization.id, { sub: busy.user.id, org: busy.organization.id, role: 'admin' }, { industry: 'chicken_shop' })).rejects.toMatchObject({ status: 400 });
    const legacy = `org_home_legacy_${run}`;
    await prisma.organization.create({ data: { id: legacy, name: legacy } });
    created.push(legacy);
    await expect(settingsCtl.update(legacy, { sub: 'u', org: legacy, role: 'admin' }, { industry: 'chicken_shop' })).rejects.toMatchObject({ status: 400 });
  });

  it('a chicken shop adds its categories and shops (validated, tenant-scoped)', async () => {
    const org = created[0];
    await expect(catalog.createCategory(org, { name: 'x' }, 't')).rejects.toMatchObject({ status: 400 });
    const cat = await catalog.createCategory(org, { name: 'Chicken' }, 't');
    await expect(catalog.createCategory(org, { name: 'Chicken' }, 't')).rejects.toMatchObject({ status: 400 });
    const item = await catalog.createItem(org, { name: 'Broiler Chicken', price: 240, unit: 'kg', categoryId: cat.id }, 't');
    expect(item.categoryId).toBe(cat.id);
    await expect(catalog.saveOutlet(org, null, { name: 'A', address: 'x' }, 't')).rejects.toMatchObject({ status: 400 });
    await expect(catalog.saveOutlet(org, null, { name: 'Anna Nagar', address: '12 Main Road', opensAt: '21:00', closesAt: '07:00' }, 't')).rejects.toMatchObject({ status: 400 });
    const shop = await catalog.saveOutlet(org, null, { name: 'Anna Nagar', address: '12 Main Road, Chennai', opensAt: '06:00', closesAt: '21:00', prepMinutes: 20 }, 't');
    expect(shop).toMatchObject({ organizationId: org, prepMinutes: 20, isDemo: false });
    await expect(catalog.saveOutlet(created[1], shop.id, { name: 'Stolen' }, 't')).rejects.toMatchObject({ status: 404 });
    const menu = await catalog.get(org, true);
    expect(menu.outlets.map((o: any) => o.name)).toEqual(['Anna Nagar']);
  });

  it('Home for a brand-new business: honest checklist, nothing green that is not done, empty metrics', async () => {
    const org = created[1];
    const h = await home.overview(org, '7d');
    expect(h.business).toMatchObject({ industry: 'restaurant', status: 'pending_review' });
    const st = Object.fromEntries(h.checklist.map((c: any) => [c.id, c.status]));
    expect(st).toMatchObject({ profile: 'action_required', agent: 'complete', channels: 'action_required', customers: 'action_required', consent: 'blocked', test: 'action_required', production: 'blocked' });
    expect(h.readiness.ready).toBe(false);
    expect(h.readiness.next).toMatchObject({ href: '/settings' });
    expect(h.channels.every((c: any) => c.status === 'not_connected')).toBe(true);
    expect(h.metrics.every((m: any) => m.value === 0 && m.hasData === false)).toBe(true);
    expect(h.metrics.map((m: any) => m.id)).toContain('orders');
    expect(h.metrics.map((m: any) => m.id)).not.toContain('leads');
    expect(h.attention.map((a: any) => a.id)).toContain('review');
    expect(h.series.labels).toHaveLength(7);
  });

  it('Home counts only this organization, in the chosen period, with the previous period for comparison', async () => {
    const org = created[2]; // "busy": retail, one customer
    const other = created[0];
    const cust = await prisma.customer.findFirst({ where: { organizationId: org } });
    await prisma.customer.update({ where: { id: cust.id }, data: { callingConsent: true } });
    const conv = await prisma.conversation.create({ data: { id: `conv_home_${run}`, organizationId: org, channel: 'whatsapp', externalId: cust.phone, customerId: cust.id, updatedAt: new Date() } });
    await prisma.message.createMany({ data: [
      { id: `m1_${run}`, organizationId: org, conversationId: conv.id, role: 'user', content: 'hi' },
      { id: `m2_${run}`, organizationId: org, conversationId: conv.id, role: 'assistant', content: 'hello' },
      { id: `m3_${run}`, organizationId: org, conversationId: conv.id, role: 'user', content: 'old', createdAt: new Date(Date.now() - 10 * 86_400_000) },
    ] });
    await prisma.lead.create({ data: { organizationId: org, customerId: cust.id, source: 'whatsapp' } });
    const h = await home.overview(org, '7d');
    const m = Object.fromEntries(h.metrics.map((x: any) => [x.id, x]));
    expect(m.enquiries).toMatchObject({ value: 1, previous: 1, hasData: true });
    expect(m.conversations.value).toBe(1);
    expect(m.leads.value).toBe(1);
    expect(h.series.messages.reduce((a: number, b: number) => a + b, 0)).toBe(1);
    const st = Object.fromEntries(h.checklist.map((c: any) => [c.id, c.status]));
    expect(st).toMatchObject({ customers: 'complete', consent: 'complete' });
    expect(h.activity.some((a: any) => a.kind === 'lead')).toBe(true);
    const hOther = await home.overview(other, '30d');
    expect(hOther.metrics.find((x: any) => x.id === 'enquiries').value).toBe(0);
    expect(hOther.activity.some((a: any) => a.kind === 'lead')).toBe(false);
  });

  it('a channel is "connected" only with proof: saved-but-untested credentials are "incomplete", a failed test "needs attention"', async () => {
    const org = created[2];
    await prisma.integrationCredential.create({ data: { organizationId: org, provider: 'whatsapp', enabled: false, status: 'untested', config: { phoneNumberId: '12345' } } });
    let wa = (await home.channels(org)).find((c: any) => c.id === 'whatsapp');
    expect(wa.status).toBe('incomplete');
    await prisma.integrationCredential.update({ where: { organizationId_provider: { organizationId: org, provider: 'whatsapp' } }, data: { status: 'failed' } });
    creds.invalidate(org, 'whatsapp');
    wa = (await home.channels(org)).find((c: any) => c.id === 'whatsapp');
    expect(wa.status).toBe('needs_attention');
    expect((await home.overview(org, 'today')).attention.map((a: any) => a.id)).toContain('channel-whatsapp');
  });

  it('agent launch checklist names exactly what is missing', async () => {
    const org = created[2];
    const agent = await prisma.voiceAgent.create({ data: { organizationId: org, name: 'Desk', industry: 'retail', instructions: 'Answer questions about the store politely.', languages: ['en'], greeting: 'Hello', fallbackMessage: 'I will check.', outbound: { enabled: true }, status: 'draft' } });
    const r = await tel.agentReadiness(org, agent.id);
    expect(r.ready).toBe(false);
    const by = Object.fromEntries(r.checks.map((c: any) => [c.id, c]));
    expect(by.tested.ok).toBe(false);
    expect(by.active.ok).toBe(false);
    expect(by.provider.ok).toBe(false);
    expect(by.consent.ok).toBe(true);
    expect(by.hours.detail).toMatch(/between 09:00 and 20:00/);
    expect(by.live).toMatchObject({ ok: false, required: false });
    expect(r.missing).toEqual(expect.arrayContaining(['Tested after the latest changes', 'Agent published', 'Voice provider (Plivo)']));
    await expect(tel.agentReadiness(created[0], agent.id)).rejects.toMatchObject({ status: 404 });
  });
});
