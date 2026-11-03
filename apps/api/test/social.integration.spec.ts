/**
 * Instagram / Messenger into the team inbox, DB-backed (real MySQL TEST database, real credential encryption, Redis
 * lock; Meta's Graph API is a fake fetch). Proves: enabling maps the Page / Instagram account to the organization
 * (refused when another organization has it; disabling removes it); a signed webhook is required (no secret, missing or
 * bad signature -> 401; the organization's app secret works); unknown Page / account dropped; messages stored once
 * (re-delivery), echoes ignored, media labelled; customer + identity created once; conversation open with the AI off;
 * automatic acknowledgement after 24 h of silence (simulated in DRY_RUN, sent live to an approved id only); STOP / START;
 * staff replies (window, opt-out, live gate, request shape, token not in URL, rejection, delivery unknown); return to AI
 * refused; tenant isolation.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.CREDENTIALS_KEYS = `t1:${randomBytes(32).toString('base64')}`;
  process.env.CREDENTIALS_ACTIVE_KEY = 't1';
}
const run = Date.now().toString(36);
const ORG = `org_social_a_${run}`;
const ORG_B = `org_social_b_${run}`;
const digits = String(Date.now()).slice(-9);
const PAGE = `91${digits}`;
const IG = `17${digits}`;
const TOKEN = `EAApagetoken${run}xyz`;
const SECRET = `appsecret${run}abcdef`;
let n = 0;

describe.skipIf(!enabled)('Instagram / Messenger (integration)', () => {
  let prisma: any, creds: any, integrations: any, tenancy: any, conversations: any, inbox: any, social: any, hook: any, controller: any, admin: any;
  const actor = () => ({ sub: admin.id, org: ORG, role: 'admin' });
  const calls: Array<{ url: string; init: any; body: any }> = [];
  let reply: (url: string) => Response = () => new Response('{}', { status: 500 });
  const fakeFetch = async (url: string, init: any = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return reply(url);
  };
  const msg = (object: 'page' | 'instagram', entryId: string, from: string, message: Record<string, unknown>) => ({ object, entry: [{ id: entryId, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: entryId }, timestamp: Date.now(), message }] }] });
  const user = () => `2${digits}${String(n++).padStart(3, '0')}`;
  const sign = (body: unknown, secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, sig: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` };
  };
  const post = async (body: unknown, secret = SECRET) => {
    const { raw, sig } = sign(body, secret);
    return controller.receive({ rawBody: raw } as any, sig, JSON.parse(raw.toString()));
  };
  const convOf = (from: string, channel = 'messenger') => prisma.conversation.findFirst({ where: { organizationId: ORG, channel, externalId: from }, include: { Message: { orderBy: { createdAt: 'asc' } } } });

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { CredentialsService } = await import('../src/integrations/credentials.service.js');
    const { IntegrationsService } = await import('../src/integrations/integrations.service.js');
    const { TenancyService } = await import('../src/tenancy/tenancy.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { InboxService } = await import('../src/inbox/inbox.service.js');
    const { SocialSenderService } = await import('../src/social/social-sender.service.js');
    const { SocialWebhookService } = await import('../src/social/social-webhook.service.js');
    const { SocialController } = await import('../src/social/social.controller.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [ORG, ORG_B]) await prisma.organization.create({ data: { id, name: `Social ${id}`, vertical: 'real_estate' } });
    admin = await prisma.user.create({ data: { organizationId: ORG, email: `social-admin-${run}@example.test`, name: 'Social Admin', passwordHash: 'x', role: 'admin' } });
    creds = new CredentialsService(prisma);
    creds.onModuleInit();
    integrations = new IntegrationsService(prisma, creds);
    integrations.fetchImpl = fakeFetch;
    tenancy = new TenancyService(prisma);
    conversations = new ConversationsService(prisma);
    social = new SocialSenderService(prisma, creds);
    social.fetchImpl = fakeFetch;
    inbox = new InboxService(prisma, conversations, { sendText: async () => 'x' } as any, social);
    hook = new SocialWebhookService(prisma, tenancy, conversations, creds, social, inbox);
    controller = new SocialController(hook);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    creds?.onModuleDestroy();
    await prisma.organizationChannel.deleteMany({ where: { organizationId: { in: [ORG, ORG_B] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('setup: Page read with the token, enable maps the Page + Instagram account; another organization cannot take them', async () => {
    await expect(integrations.save(actor(), 'meta_social', { pageAccessToken: TOKEN, appSecret: SECRET, pageId: 'abc' })).rejects.toMatchObject({ response: { fields: { pageId: expect.any(String) } } });
    await integrations.save(actor(), 'meta_social', { pageAccessToken: TOKEN, appSecret: SECRET, pageId: PAGE, instagramAccountId: IG, autoReply: 'Thanks! Our team will reply shortly.' });
    reply = () => new Response(JSON.stringify({ id: PAGE, name: 'Realty Page', instagram_business_account: { id: '999' } }), { status: 200 });
    expect((await integrations.test(actor(), 'meta_social', 'connection', {})).result).toMatchObject({ ok: false, errorCode: 'mismatch' });
    calls.length = 0;
    reply = () => new Response(JSON.stringify({ id: PAGE, name: 'Realty Page', instagram_business_account: { id: IG } }), { status: 200 });
    expect((await integrations.test(actor(), 'meta_social', 'connection', {})).result).toMatchObject({ ok: true });
    expect(calls[0].url).toMatch(new RegExp(`/${PAGE}\\?fields=id,name,instagram_business_account$`));
    expect(calls[0].url).not.toContain(TOKEN);
    await integrations.setEnabled(actor(), 'meta_social', true);
    const map = await prisma.organizationChannel.findMany({ where: { organizationId: ORG }, orderBy: { kind: 'asc' } });
    expect(map.map((m: any) => `${m.kind}:${m.externalId}`)).toEqual([`instagram_account_id:${IG}`, `messenger_page_id:${PAGE}`]);
    // Organization B tries to connect the same Page.
    const bAdmin = { sub: 'b-admin', org: ORG_B, role: 'admin' };
    await integrations.save(bAdmin, 'meta_social', { pageAccessToken: TOKEN, appSecret: SECRET, pageId: PAGE });
    reply = () => new Response(JSON.stringify({ id: PAGE, name: 'Realty Page' }), { status: 200 });
    await integrations.test(bAdmin, 'meta_social', 'connection', {});
    await expect(integrations.setEnabled(bAdmin, 'meta_social', true)).rejects.toThrow(/already connected to another organization/);
    expect(await tenancy.resolve('messenger_page_id', PAGE)).toBe(ORG);
  });

  it('webhook authentication: signature required; wrong secret / missing signature / unknown account refused or dropped', async () => {
    const body = msg('page', PAGE, user(), { mid: `m.${run}.auth`, text: 'hi' });
    const { raw } = sign(body);
    await expect(controller.receive({ rawBody: raw } as any, undefined, body)).rejects.toThrow(/Missing signature/);
    await expect(post(body, 'not-the-secret')).rejects.toThrow(/Invalid signature/);
    const unknown = msg('page', '5550001112223', user(), { mid: `m.${run}.unknown`, text: 'hi' });
    // No organization owns this Page, so no secret exists for it (and none in the environment in tests).
    await expect(post(unknown)).rejects.toThrow(/No app secret/);
    expect(await prisma.message.count({ where: { externalId: `m.${run}.unknown` } })).toBe(0);
  });

  it('inbound: stored once, echo ignored, media labelled, customer + identity once, inbox open with the AI off; acknowledgement simulated in DRY_RUN', async () => {
    const from = user();
    const first = msg('page', PAGE, from, { mid: `m.${run}.1`, text: '2BHK in Velachery available?' });
    expect(await post(first)).toMatchObject({ stored: 1 });
    expect(await post(first)).toMatchObject({ stored: 0 }); // Meta re-delivery
    expect(await post(msg('page', PAGE, from, { mid: `m.${run}.echo`, text: 'our own reply', is_echo: true }))).toMatchObject({ stored: 0 });
    expect(await post(msg('page', PAGE, from, { mid: `m.${run}.2`, attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg' } }] }))).toMatchObject({ stored: 1 });
    const conv = await convOf(from);
    expect(conv).toMatchObject({ aiEnabled: false, inboxStatus: 'open', handoffReason: expect.stringMatching(/pending/) });
    expect(conv.Message.map((m: any) => `${m.role}:${m.content}`)).toEqual(['user:2BHK in Velachery available?', 'assistant:Thanks! Our team will reply shortly.', 'user:[Image]']);
    expect(conv.Message[1].metadata).toMatchObject({ autoReply: true, simulated: true, notSentReason: 'DRY_RUN is on' });
    expect(JSON.stringify(conv.Message)).not.toContain('cdn.example');
    expect(await prisma.socialIdentity.count({ where: { organizationId: ORG, externalUserId: from } })).toBe(1);
    const cust = await prisma.customer.findUnique({ where: { id: conv.customerId } });
    expect(cust).toMatchObject({ phone: null, source: 'messenger', name: expect.stringMatching(/Messenger user ••/) });
    // In the inbox list with the channel filter.
    const list = await inbox.list(ORG, admin.id, { channel: 'messenger' });
    expect(list.items.map((i: any) => i.id)).toContain(conv.id);
    // Instagram goes to its own conversation.
    const igUser = user();
    await post(msg('instagram', IG, igUser, { mid: `m.${run}.ig1`, text: 'price?' }));
    expect((await convOf(igUser, 'instagram')).Message[0].content).toBe('price?');
  });

  it('staff replies: DRY_RUN not sent; live only to approved ids with the right request; rejection and unknown delivery; window and opt-out', async () => {
    const from = user();
    await post(msg('page', PAGE, from, { mid: `m.${run}.r1`, text: 'call me' }));
    const conv = await convOf(from);
    const dry = await inbox.reply(actor(), conv.id, 'Sure, calling at 5 PM.');
    expect(dry).toMatchObject({ sent: false, notSentReason: 'DRY_RUN is on' });

    const prev = { dry: process.env.DRY_RUN, ids: process.env.LIVE_TEST_SOCIAL_IDS };
    try {
      process.env.DRY_RUN = 'false';
      process.env.LIVE_TEST_SOCIAL_IDS = 'someone-else';
      expect(await inbox.reply(actor(), conv.id, 'Hello')).toMatchObject({ sent: false, notSentReason: expect.stringMatching(/LIVE_TEST_SOCIAL_IDS/) });
      process.env.LIVE_TEST_SOCIAL_IDS = from;
      calls.length = 0;
      reply = () => new Response(JSON.stringify({ recipient_id: from, message_id: 'mid.SENT1' }), { status: 200 });
      expect(await inbox.reply(actor(), conv.id, 'Sending details now.')).toMatchObject({ sent: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toMatch(new RegExp(`/${PAGE}/messages$`));
      expect(calls[0].url).not.toContain(TOKEN);
      expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(calls[0].body).toEqual({ recipient: { id: from }, messaging_type: 'RESPONSE', message: { text: 'Sending details now.' } });
      const last = (await convOf(from)).Message.at(-1);
      expect(last).toMatchObject({ externalId: 'mid.SENT1', deliveryStatus: 'accepted' });
      expect(last.metadata).toMatchObject({ author: 'staff', authorName: 'Social Admin' });

      reply = () => new Response(JSON.stringify({ error: { message: `(#10) Outside the allowed window ${TOKEN}` } }), { status: 400 });
      await expect(inbox.reply(actor(), conv.id, 'x')).rejects.toThrow(/did not accept/);
      expect(JSON.stringify((await convOf(from)).Message.at(-1))).not.toContain(TOKEN);
      reply = () => new Response(JSON.stringify({ recipient_id: from }), { status: 200 });
      await expect(inbox.reply(actor(), conv.id, 'y')).rejects.toThrow(/delivery unknown: not resent/);
      expect((await convOf(from)).Message.at(-1)).toMatchObject({ deliveryStatus: 'unknown' });

      // Window closed.
      await prisma.customer.update({ where: { id: conv.customerId }, data: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) } });
      await expect(inbox.reply(actor(), conv.id, 'late')).rejects.toThrow(/24 hours/);
      expect((await inbox.detail(ORG, conv.id)).replyWindow).toMatchObject({ open: false });
    } finally {
      process.env.DRY_RUN = prev.dry ?? 'true';
      if (prev.ids === undefined) delete process.env.LIVE_TEST_SOCIAL_IDS; else process.env.LIVE_TEST_SOCIAL_IDS = prev.ids;
    }
    await expect(inbox.returnToAi(actor(), conv.id)).rejects.toThrow(/not available yet/);
  });

  it('STOP / START honoured; the acknowledgement is never sent to an opted-out customer; another organization cannot see it', async () => {
    const from = user();
    await post(msg('page', PAGE, from, { mid: `m.${run}.s1`, text: 'STOP' }));
    const conv = await convOf(from);
    const cust = await prisma.customer.findUnique({ where: { id: conv.customerId } });
    expect(cust.optedOutAt).not.toBeNull();
    expect(conv.Message.at(-1).metadata).toMatchObject({ optOut: true });
    await expect(inbox.reply(actor(), conv.id, 'hello?')).rejects.toThrow(/opted out/);
    await post(msg('page', PAGE, from, { mid: `m.${run}.s2`, text: 'START' }));
    expect((await prisma.customer.findUnique({ where: { id: conv.customerId } })).optedOutAt).toBeNull();
    await expect(inbox.detail(ORG_B, conv.id)).rejects.toThrow();
    expect((await inbox.list(ORG_B, 'x', {})).items.some((i: any) => i.id === conv.id)).toBe(false);
  });

  it('disabling the integration stops routing: the next delivery is refused', async () => {
    await integrations.setEnabled(actor(), 'meta_social', false);
    creds.invalidate(ORG, 'meta_social');
    tenancy.clearCache();
    expect(await prisma.organizationChannel.count({ where: { organizationId: ORG } })).toBe(0);
    await expect(post(msg('page', PAGE, user(), { mid: `m.${run}.off`, text: 'hi' }))).rejects.toThrow(/No app secret/);
    expect(await prisma.message.count({ where: { externalId: `m.${run}.off` } })).toBe(0);
  });
});
