/**
 * Sarvam voice-agent tools (GR Chicken grounding), DB-backed. Real MySQL test database; the WhatsApp sender is a spy.
 * Proves: menu/prices come from the database, unknown products are refused (never invented), unavailable items are
 * reported as unavailable, Tamil/Tanglish/English orders are priced by the order service, the confirmed order is
 * saved exactly once, the WhatsApp confirmation is scheduled only with consent, tenant isolation and tool-key auth.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/sarvam-tools.integration.spec.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
const ORG = 'org_test_st_a';
const ORG_B = 'org_test_st_b';
const SECRET = 'x'.repeat(16) + 'sarvam-tools-test-secret';
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.TELEPHONY_WEBHOOK_SECRET = SECRET;
}
const PHONE = '919999900771';

describe.skipIf(!enabled)('Sarvam voice-agent tools (integration)', () => {
  let prisma: any, tools: any, followUps: any, mod: any, controller: any;

  async function setupOrg(id: string, name: string, broilerPrice: number) {
    await prisma.organization.upsert({ where: { id }, create: { id, name, vertical: 'restaurant' }, update: { name, vertical: 'restaurant' } });
    const cat = await prisma.menuCategory.upsert({ where: { organizationId_name: { organizationId: id, name: 'Chicken' } }, create: { id: `${id}_cat`, organizationId: id, name: 'Chicken' }, update: {} });
    // Aliases as in the production GR Chicken seed (scripts/seed-gr-chicken.ts).
    const rows = [
      ['Broiler Chicken', broilerPrice, 'kg', true, 'broiler, broiler chicken, chicken, kozhi, koli, கோழி, பிராய்லர், சிக்கன்'],
      ['Country Chicken', 450, 'kg', true, 'country, country chicken, nattu kozhi, naatu kozhi, nattukozhi, நாட்டு கோழி, நாட்டுக்கோழி'],
      ['Chicken Liver', 160, 'kg', false, 'liver, eeral, ஈரல், chicken liver'],
      ['Country Eggs', 12, 'piece', true, 'eggs, egg, muttai, முட்டை'],
    ] as const;
    for (const [n, price, unit, available, aliases] of rows) {
      const rid = `${id}_${n.replace(/\s/g, '_')}`;
      const data = { organizationId: id, categoryId: cat.id, name: n, price, unit, cutOptions: unit === 'kg' ? ['Curry cut', 'Biryani cut', 'Whole'] : [], aliases, available, stockQty: null };
      await prisma.menuItem.upsert({ where: { id: rid }, create: { id: rid, ...data }, update: data });
    }
    const shop = { organizationId: id, name: `${name} Shop`, address: 'Test', opensAt: '00:00', closesAt: '00:00', prepMinutes: 30, active: true, minOrderValue: 0 };
    await prisma.outlet.upsert({ where: { id: `${id}_shop` }, create: { id: `${id}_shop`, ...shop }, update: shop });
  }

  async function cleanup() {
    for (const org of [ORG, ORG_B]) {
      await prisma.orderFollowUp.deleteMany({ where: { organizationId: org } }).catch(() => undefined);
      await prisma.orderItem.deleteMany({ where: { order: { organizationId: org } } });
      await prisma.order.deleteMany({ where: { organizationId: org } });
      await prisma.workTask.deleteMany({ where: { organizationId: org } });
      await prisma.auditEvent.deleteMany({ where: { organizationId: org } });
      await prisma.message.deleteMany({ where: { organizationId: org } });
      await prisma.conversation.deleteMany({ where: { organizationId: org } });
      await prisma.call.deleteMany({ where: { organizationId: org } });
      await prisma.telephonyWebhookEvent.deleteMany({ where: { organizationId: org } });
    }
  }

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { OrdersService } = await import('../src/restaurant/orders.service.js');
    const { CatalogService } = await import('../src/restaurant/catalog.service.js');
    mod = await import('../src/telephony/sarvam-tools.service.js');
    const { SarvamToolsController } = await import('../src/telephony/sarvam-tools.controller.js');
    prisma = new PrismaService();
    await prisma.$connect();
    await setupOrg(ORG, 'GR Chicken Test', 220);
    await setupOrg(ORG_B, 'Other Shop', 999);
    await prisma.customer.deleteMany({ where: { organizationId: { in: [ORG, ORG_B] }, phone: PHONE } });
    await cleanup();
    followUps = { onOrderCreated: vi.fn(async () => undefined) };
    tools = new mod.SarvamToolsService(prisma, new CatalogService(prisma), new OrdersService(prisma), new ConversationsService(prisma), followUps);
    controller = new SarvamToolsController(tools, prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
    await prisma.$disconnect();
  });

  it('context and menu come from the database, with prices, unavailable items and the no-Hindi rule', async () => {
    const ctx = await tools.context(ORG, { caller_phone: PHONE });
    expect(ctx.ok).toBe(true);
    expect(ctx.business_name).toBe('GR Chicken Test');
    expect(ctx.menu_text).toContain('Broiler Chicken: ₹220 per kg');
    expect(ctx.menu_text).toContain('Country Eggs: ₹12 per piece');
    expect(ctx.menu_text).not.toContain('Chicken Liver');
    expect(ctx.unavailable_today).toBe('Chicken Liver');
    expect(ctx.language_rule).toMatch(/Never Hindi/);
    expect(ctx.delivery).toMatch(/Pickup/);
    const m = await tools.menu(ORG);
    expect(m.items.map((i: any) => i.name).sort()).toEqual(['Broiler Chicken', 'Country Chicken', 'Country Eggs']);
  });

  it('item lookup: real price in English, Tanglish and Tamil; unknown product is never invented; unavailable is said', async () => {
    expect((await tools.item(ORG, { item_name: 'broiler' })).price_text).toBe('Broiler Chicken is ₹220 per kg.');
    const naatu = await tools.item(ORG, { item_name: 'naatu kozhi evvalavu' });
    expect(naatu.found).toBe(true);
    expect(naatu.name).toBe('Country Chicken');
    const tamil = await tools.item(ORG, { item_name: 'நாட்டுக்கோழி விலை' });
    expect(tamil.name).toBe('Country Chicken');
    const mutton = await tools.item(ORG, { item_name: 'mutton' });
    expect(mutton.found).toBe(false);
    expect(mutton.message).toMatch(/not on our menu/);
    expect(mutton.price).toBeUndefined();
    const liver = await tools.item(ORG, { item_name: 'chicken liver' });
    expect(liver.found).toBe(true);
    expect(liver.available).toBe(false);
  });

  it('quote asks for missing details instead of guessing', async () => {
    const q = await tools.quote(ORG, { items_text: 'broiler' });
    expect(q.ok).toBe(false);
    expect(q.questions_text).toMatch(/How much Broiler Chicken/);
    expect(q.questions_text).toMatch(/Which cut/);
    expect(q.questions_text).toMatch(/pick it up/);
    const none = await tools.quote(ORG, { items_text: 'two plates biryani' });
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/could not find/);
  });

  it('Tanglish order is priced by the order service, saved once on confirmation, WhatsApp scheduled with consent', async () => {
    const q = await tools.quote(ORG, { items_text: 'rendu kilo broiler curry cut', pickup_time: 'oru mani nerathula' });
    expect(q.ok).toBe(true);
    expect(q.total).toBe(440);
    expect(q.summary_text).toContain('Broiler Chicken');
    expect(q.summary_text).toContain('Total ₹440');

    const notYet = await tools.order(ORG, { cart_token: q.cart_token, caller_phone: PHONE, confirmed: 'no' });
    expect(notYet.ok).toBe(false);
    expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(0);

    const body = { cart_token: q.cart_token, caller_phone: `+${PHONE}`, confirmed: 'aama', send_whatsapp: 'yes', call_id: 'call-test-1', customer_name: 'Kumar' };
    const placed = await tools.order(ORG, body);
    expect(placed.ok).toBe(true);
    expect(placed.order_number).toBeTruthy();
    const row = await prisma.order.findFirst({ where: { organizationId: ORG, orderNumber: placed.order_number }, include: { items: true } });
    expect(row.channel).toBe('voice');
    expect(Number(row.total)).toBe(440);
    expect(row.items[0].name).toBe('Broiler Chicken');
    expect(Number(row.items[0].quantity)).toBe(2);
    const customer = await prisma.customer.findFirst({ where: { organizationId: ORG, phone: PHONE } });
    expect(customer.messagingConsent).toBe(true);
    expect(followUps.onOrderCreated).toHaveBeenCalledWith(ORG, row.id, 'voice');

    // Sarvam retries the tool call: same order, no second row, no second confirmation.
    const again = await tools.order(ORG, body);
    expect(again.order_number).toBe(placed.order_number);
    expect(again.duplicate).toBe(true);
    expect(await prisma.order.count({ where: { organizationId: ORG } })).toBe(1);
    expect(followUps.onOrderCreated).toHaveBeenCalledTimes(1);

    const st = await tools.status(ORG, { caller_phone: PHONE });
    expect(st.order_number).toBe(placed.order_number);
  });

  it('a tampered, expired or other-tenant cart is refused; a price change is not charged silently', async () => {
    const q = await tools.quote(ORG, { items_text: '1 kg country chicken whole', pickup_time: '30 minutes' });
    expect(q.ok).toBe(true);
    const [body, mac] = q.cart_token.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.t = 1;
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${mac}`;
    expect((await tools.order(ORG, { cart_token: tampered, caller_phone: PHONE, confirmed: 'yes' })).error).toBe('cart_invalid');
    expect((await tools.order(ORG_B, { cart_token: q.cart_token, caller_phone: PHONE, confirmed: 'yes' })).error).toBe('cart_invalid');

    await prisma.menuItem.update({ where: { id: `${ORG}_Country_Chicken` }, data: { price: 480 } });
    try {
      const r = await tools.order(ORG, { cart_token: q.cart_token, caller_phone: PHONE, confirmed: 'yes', call_id: 'call-test-2' });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('rejected');
    } finally {
      await prisma.menuItem.update({ where: { id: `${ORG}_Country_Chicken` }, data: { price: 450 } });
    }
  });

  it('tenant isolation: each organization sees only its own menu and prices', async () => {
    expect((await tools.item(ORG_B, { item_name: 'broiler' })).price).toBe(999);
    expect((await tools.item(ORG, { item_name: 'broiler' })).price).toBe(220);
    expect((await tools.status(ORG_B, { caller_phone: PHONE })).found).toBe(false);
  });

  it('handoff creates one staff call-back task per caller per day', async () => {
    await tools.handoff(ORG, { caller_phone: PHONE, reason: 'wants bulk order' });
    await tools.handoff(ORG, { caller_phone: PHONE, reason: 'wants bulk order again' });
    const tasks = await prisma.workTask.findMany({ where: { organizationId: ORG, agent: 'voice' } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].detail).toMatch(/again/);
  });

  it('controller: tool key required, wrong-org key refused, no secret = fail closed', async () => {
    const req = (org: string, key?: string) => ({ headers: { 'x-tacksharp-org': org, ...(key ? { 'x-tacksharp-tool-key': key } : {}) } }) as any;
    const key = mod.toolKey(ORG);
    expect((await controller.run('menu', req(ORG, key), {}, {})).ok).toBe(true);
    await expect(controller.run('menu', req(ORG), {}, {})).rejects.toThrow(/Invalid tool key/);
    await expect(controller.run('menu', req(ORG_B, key), {}, {})).rejects.toThrow(/Invalid tool key/);
    expect((await controller.run('nope', req(ORG, key), {}, {})).error).toBe('unknown_tool');
    process.env.TELEPHONY_WEBHOOK_SECRET = 'short';
    try {
      expect(mod.toolKey(ORG)).toBeNull();
      await expect(controller.run('menu', req(ORG, key), {}, {})).rejects.toThrow(/Invalid tool key/);
    } finally {
      process.env.TELEPHONY_WEBHOOK_SECRET = SECRET;
    }
  });

  it('post-call webhook for the hosted agent (scope "inbound"): call, transcript and a factual summary on the dashboard', async () => {
    const { SarvamTelephonyProvider } = await import('../src/telephony/sarvam.provider.js');
    const provider = new SarvamTelephonyProvider(prisma);
    const url = new URL(SarvamTelephonyProvider.webhookUrl(ORG, 'inbound')!);
    const query = Object.fromEntries(url.searchParams);
    const body = {
      interaction_id: `int-${Date.now()}`, status: 'connected', duration: 95, channel_info: { user_phone_number: `+${PHONE}` },
      interaction_transcript: [{ role: 'user', content: 'rendu kilo broiler curry cut venum' }, { role: 'assistant', content: 'சரி, 440 ரூபாய்.' }],
    };
    const bad = await provider.handleWebhook({ query: { ...query, t: '0'.repeat(64) }, body, headers: {} });
    expect(bad.reason).toBe('invalid_token');
    const r = await provider.handleWebhook({ query, body, headers: {} });
    expect(r.accepted).toBe(true);
    const call = await prisma.call.findFirst({ where: { organizationId: ORG, providerCallId: body.interaction_id } });
    expect(call.direction).toBe('inbound');
    expect(call.status).toBe('completed');
    expect(call.durationSec).toBe(95);
    expect(call.summary).toMatch(/rendu kilo broiler/);
    expect(call.summary).toMatch(/Order GR-.* placed on the call \(₹440\)/);
    expect(call.summary).toMatch(/staff call-back/);
    expect(await prisma.message.count({ where: { organizationId: ORG, metadata: { path: '$.callId', equals: call.id } } })).toBe(2);
    expect((await provider.handleWebhook({ query, body, headers: {} })).duplicate).toBe(true);
  });

  it('config pack: Tamil + English only (no Hindi), tools point at this org, key hidden unless revealed', async () => {
    const owner = { sub: 'u1', org: ORG, role: 'admin' } as any;
    const hidden = await controller.configPack(ORG, owner);
    expect(hidden.language.allowedLanguages).toEqual(['Tamil (ta-IN)', 'English (en-IN)']);
    expect(hidden.language.startingLanguage).toMatch(/Tamil/);
    expect(JSON.stringify(hidden.language.allowedLanguages)).not.toMatch(/Hindi/);
    expect(hidden.instructions).toMatch(/Never speak Hindi/);
    expect(hidden.instructions).toMatch(/GR Chicken Test/);
    expect(hidden.tools.map((t: any) => t.name)).toEqual(['get_menu', 'get_item', 'quote_order', 'place_order', 'order_status', 'request_callback']);
    expect(hidden.tools[0].headers['x-tacksharp-tool-key']).toMatch(/hidden/);
    expect(hidden.postCallWebhook).toMatch(/hidden/);
    const shown = await controller.configPack(ORG, owner, '1');
    expect(shown.tools[0].headers['x-tacksharp-tool-key']).toBe(mod.toolKey(ORG));
    expect(shown.postCallWebhook).toMatch(/scope=inbound&t=[0-9a-f]{64}$/);
    await expect(controller.configPack(ORG, { sub: 'u2', org: ORG, role: 'sales' } as any)).rejects.toThrow(/agents.manage/);
    // Not a food business: the menu / ordering tools are not offered (honest "pending"), no tool key.
    await prisma.organization.upsert({ where: { id: 'org_test_st_re' }, create: { id: 'org_test_st_re', name: 'Realty', vertical: 'real_estate' }, update: {} });
    expect(await controller.configPack('org_test_st_re', { sub: 'u1', org: 'org_test_st_re', role: 'admin' } as any, '1')).toMatchObject({ applicable: false });
    expect((await controller.configPack(ORG, { sub: 'u3', org: ORG, role: 'manager' } as any)).tools.length).toBe(6);
    await expect(controller.configPack(ORG, { sub: 'u3', org: ORG, role: 'manager' } as any, '1')).rejects.toThrow(/integrations.manage/);
  });
});
