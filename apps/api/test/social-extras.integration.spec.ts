/**
 * Instagram / Messenger extras, DB-backed (real MySQL TEST database, credential encryption, Redis lock; Meta's Graph
 * API is a fake fetch; webhooks signed with the organization's app secret). Proves: delivery and read receipts
 * (Messenger mids + watermark, Instagram read.mid; never backwards); media kept only as Meta CDN links (other hosts
 * dropped, nothing downloaded); story replies labelled; the Human Agent tag (staff only, 24 h - 7 days, only when
 * turned on; exact request); Instagram comments (both webhook formats, once, own comments ignored, customer by
 * username, AI off), public reply and the one private reply (exact requests, 7-day limit, opt-out, live gate).
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
const ORG = `org_sx_${run}`;
const digits = String(Date.now()).slice(-9);
const PAGE = `94${digits}`;
const IG = `18${digits}`;
const SECRET = `appsecret${run}xyz123`;
let n = 0;

describe.skipIf(!enabled)('Instagram / Messenger extras (integration)', () => {
  let prisma: any, creds: any, integrations: any, conversations: any, inbox: any, social: any, controller: any, admin: any;
  const actor = () => ({ sub: admin.id, org: ORG, role: 'admin' });
  const calls: Array<{ url: string; body: any }> = [];
  let reply: () => Response = () => new Response('{}', { status: 500 });
  const fakeFetch = async (url: string, init: any = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return reply();
  };
  const user = () => `4${digits}${String(n++).padStart(3, '0')}`;
  const post = async (body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    return controller.receive({ rawBody: raw } as any, `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`, JSON.parse(raw.toString()));
  };
  const messaging = (object: 'page' | 'instagram', from: string, event: Record<string, unknown>) => ({ object, entry: [{ id: object === 'page' ? PAGE : IG, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: object === 'page' ? PAGE : IG }, timestamp: Date.now(), ...event }] }] });
  const say = (object: 'page' | 'instagram', from: string, message: Record<string, unknown>) => post(messaging(object, from, { message: { mid: `m.${run}.${n++}`, ...message } }));
  const convOf = (from: string, channel: string) => prisma.conversation.findFirst({ where: { organizationId: ORG, channel, externalId: from }, include: { Message: { orderBy: { createdAt: 'asc' } } } });
  const live = async (ids: string, fn: () => Promise<void>) => {
    const prev = { dry: process.env.DRY_RUN, ids: process.env.LIVE_TEST_SOCIAL_IDS };
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_SOCIAL_IDS = ids;
    try { await fn(); } finally {
      process.env.DRY_RUN = prev.dry ?? 'true';
      if (prev.ids === undefined) delete process.env.LIVE_TEST_SOCIAL_IDS; else process.env.LIVE_TEST_SOCIAL_IDS = prev.ids;
    }
  };

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
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
    await prisma.organization.create({ data: { id: ORG, name: `Extras ${run}`, vertical: 'restaurant' } });
    admin = await prisma.user.create({ data: { organizationId: ORG, email: `sx-admin-${run}@example.test`, name: 'Admin', passwordHash: 'x', role: 'admin' } });
    creds = new CredentialsService(prisma);
    creds.onModuleInit();
    integrations = new IntegrationsService(prisma, creds);
    integrations.fetchImpl = fakeFetch;
    conversations = new ConversationsService(prisma);
    social = new SocialSenderService(prisma, creds);
    social.fetchImpl = fakeFetch;
    inbox = new InboxService(prisma, conversations, { sendText: async () => 'x' } as any, social);
    controller = new SocialController(new SocialWebhookService(prisma, new TenancyService(prisma), conversations, creds, social, inbox));
    await integrations.save(actor(), 'meta_social', { pageAccessToken: `EAAx${run}token`, appSecret: SECRET, pageId: PAGE, instagramAccountId: IG });
    reply = () => new Response(JSON.stringify({ id: PAGE, name: 'Shop', instagram_business_account: { id: IG } }), { status: 200 });
    await integrations.test(actor(), 'meta_social', 'connection', {});
    await integrations.setEnabled(actor(), 'meta_social', true);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    creds?.onModuleDestroy();
    await prisma.organizationChannel.deleteMany({ where: { organizationId: ORG } });
    await prisma.organization.deleteMany({ where: { id: ORG } });
    await prisma.$disconnect();
  });

  it('receipts: Messenger delivery (mids) and read (watermark), Instagram read (mid); never backwards', async () => {
    const from = user();
    await say('page', from, { text: 'hello' });
    const c = await convOf(from, 'messenger');
    await live(from, async () => {
      reply = () => new Response(JSON.stringify({ recipient_id: from, message_id: `mid.R1${run}` }), { status: 200 });
      await inbox.reply(actor(), c.id, 'First reply');
      reply = () => new Response(JSON.stringify({ recipient_id: from, message_id: `mid.R2${run}` }), { status: 200 });
      await inbox.reply(actor(), c.id, 'Second reply');
    });
    const status = async (mid: string) => (await prisma.message.findFirst({ where: { externalId: mid } })).deliveryStatus;
    await post(messaging('page', from, { delivery: { mids: [`mid.R1${run}`], watermark: 1 } }));
    expect([await status(`mid.R1${run}`), await status(`mid.R2${run}`)]).toEqual(['delivered', 'accepted']);
    await post(messaging('page', from, { read: { watermark: Date.now() + 1000 } }));
    expect([await status(`mid.R1${run}`), await status(`mid.R2${run}`)]).toEqual(['read', 'read']);
    await post(messaging('page', from, { delivery: { mids: [`mid.R2${run}`], watermark: 1 } }));
    expect(await status(`mid.R2${run}`)).toBe('read');
    // Instagram: read.mid marks that message and everything sent before it.
    const ig = user();
    await say('instagram', ig, { text: 'price?' });
    const ic = await convOf(ig, 'instagram');
    await live(ig, async () => {
      reply = () => new Response(JSON.stringify({ recipient_id: ig, message_id: `mid.I1${run}` }), { status: 200 });
      await inbox.reply(actor(), ic.id, 'Rs 240');
    });
    await post(messaging('instagram', ig, { read: { mid: `mid.I1${run}` } }));
    expect(await status(`mid.I1${run}`)).toBe('read');
    // A receipt from someone we never wrote to changes nothing.
    expect(await post(messaging('page', user(), { read: { watermark: Date.now() } }))).toMatchObject({ success: true });
  });

  it('media: only Meta CDN links kept (nothing downloaded); story replies labelled', async () => {
    const from = user();
    calls.length = 0;
    await say('instagram', from, { attachments: [{ type: 'image', payload: { url: 'https://scontent.cdninstagram.com/v/t51/abc.jpg?oh=1' } }, { type: 'file', payload: { url: 'https://evil.example/x.pdf' } }, { type: 'video', payload: { url: 'http://video.fbcdn.net/v.mp4' } }] });
    const m = (await convOf(from, 'instagram')).Message[0];
    expect(m.content).toBe('[Image] [File] [Video]');
    expect(m.metadata.social.media).toEqual([{ type: 'image', url: 'https://scontent.cdninstagram.com/v/t51/abc.jpg?oh=1' }]);
    expect(calls).toEqual([]); // no download
    await say('instagram', from, { text: 'Is this available?', reply_to: { story: { id: '1790', url: 'https://lookaside.fbsbx.com/story/1790' } } });
    const s = (await convOf(from, 'instagram')).Message.at(-1);
    expect(s.content).toBe('[Reply to your story] Is this available?');
    expect(s.metadata.social.story).toEqual({ id: '1790', url: 'https://lookaside.fbsbx.com/story/1790' });
  });

  it('Human Agent tag: staff only, 24 h - 7 days, only when turned on; exact request', async () => {
    const from = user();
    await say('page', from, { text: 'any update on my order?' });
    const c = await convOf(from, 'messenger');
    await prisma.customer.update({ where: { id: c.customerId }, data: { lastInboundAt: new Date(Date.now() - 3 * 86_400_000) } });
    await expect(inbox.reply(actor(), c.id, 'Sorry for the delay')).rejects.toThrow(/Human Agent permission/);
    await integrations.save(actor(), 'meta_social', { humanAgentTag: 'on' });
    reply = () => new Response(JSON.stringify({ id: PAGE, name: 'Shop', instagram_business_account: { id: IG } }), { status: 200 });
    await integrations.test(actor(), 'meta_social', 'connection', {});
    calls.length = 0;
    await live(from, async () => {
      reply = () => new Response(JSON.stringify({ recipient_id: from, message_id: `mid.HA${run}` }), { status: 200 });
      await inbox.reply(actor(), c.id, 'Sorry for the delay, it ships today.');
    });
    expect(calls.at(-1)!.body).toEqual({ recipient: { id: from }, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT', message: { text: 'Sorry for the delay, it ships today.' } });
    expect((await prisma.message.findFirst({ where: { externalId: `mid.HA${run}` } })).metadata).toMatchObject({ humanAgentTag: true });
    // Inside 24 h: a normal RESPONSE.
    await prisma.customer.update({ where: { id: c.customerId }, data: { lastInboundAt: new Date() } });
    await live(from, async () => {
      reply = () => new Response(JSON.stringify({ recipient_id: from, message_id: `mid.HB${run}` }), { status: 200 });
      await inbox.reply(actor(), c.id, 'Anything else?');
    });
    expect(calls.at(-1)!.body.messaging_type).toBe('RESPONSE');
    // Past 7 days: refused even with the tag on; an AI draft (not staff) never gets the tag.
    await prisma.customer.update({ where: { id: c.customerId }, data: { lastInboundAt: new Date(Date.now() - 8 * 86_400_000) } });
    await expect(inbox.reply(actor(), c.id, 'Late')).rejects.toThrow(/24 hours/);
    expect(await social.check(ORG, { channel: 'messenger', externalId: from, customerId: c.customerId })).toMatchObject({ ok: false });
    await prisma.customer.update({ where: { id: c.customerId }, data: { lastInboundAt: new Date(Date.now() - 2 * 86_400_000) } });
    expect(await social.check(ORG, { channel: 'messenger', externalId: from, customerId: c.customerId })).toMatchObject({ ok: false });
    expect(await social.check(ORG, { channel: 'messenger', externalId: from, customerId: c.customerId }, { staff: true })).toMatchObject({ ok: true, humanAgent: true });
  });

  it('Instagram comments: both webhook formats, once, own comments ignored; public reply and the one private reply', async () => {
    const commenter = user();
    const cid = `179${digits}${n++}`;
    const loginFormat = { object: 'instagram', entry: [{ id: IG, time: Date.now(), field: 'comments', value: { id: cid, text: 'Price of the combo?', from: { id: commenter, username: 'kavya.eats' }, media: { id: '555', media_product_type: 'FEED' } } }] };
    expect(await post(loginFormat)).toMatchObject({ stored: 1 });
    expect(await post(loginFormat)).toMatchObject({ stored: 0 });
    // Facebook Login format, and our own reply coming back as a comment.
    const cid2 = `179${digits}${n++}`;
    expect(await post({ object: 'instagram', entry: [{ id: IG, time: Date.now(), changes: [{ field: 'comments', value: { id: cid2, text: 'Love it', from: { id: user() }, media: { id: '556' } } }, { field: 'comments', value: { id: `own${run}`, text: 'Thanks!', from: { id: IG } } }] }] })).toMatchObject({ stored: 1 });
    const c = await convOf(cid, 'instagram_comment');
    expect(c).toMatchObject({ aiEnabled: false, inboxStatus: 'open' });
    expect(c.Message[0]).toMatchObject({ role: 'user', content: 'Price of the combo?', metadata: { comment: { commentId: cid, userId: commenter, username: 'kavya.eats', mediaId: '555' } } });
    expect((await prisma.customer.findUnique({ where: { id: c.customerId } })).name).toBe('@kavya.eats');
    expect((await inbox.detail(ORG, c.id)).replyWindow).toMatchObject({ open: true, comment: true });
    await expect(inbox.returnToAi(actor(), c.id)).rejects.toThrow(/does not answer Instagram comments/);
    // DRY_RUN: recorded, not posted.
    calls.length = 0;
    const d = await inbox.reply(actor(), c.id, 'Rs 299 today!');
    expect(d.sent).toBe(false);
    expect(calls).toEqual([]);
    await live(commenter, async () => {
      reply = () => new Response(JSON.stringify({ id: `rep${run}` }), { status: 200 });
      await inbox.reply(actor(), c.id, 'Rs 299 today!');
      expect(calls.at(-1)).toMatchObject({ url: expect.stringMatching(new RegExp(`/${cid}/replies$`)), body: { message: 'Rs 299 today!' } });
      reply = () => new Response(JSON.stringify({ recipient_id: commenter, message_id: `mid.PR${run}` }), { status: 200 });
      await inbox.privateCommentReply(actor(), c.id, 'Hi Kavya, sending the menu here.');
      expect(calls.at(-1)).toMatchObject({ url: expect.stringMatching(new RegExp(`/${IG}/messages$`)), body: { recipient: { comment_id: cid }, message: { text: 'Hi Kavya, sending the menu here.' } } });
      await expect(inbox.privateCommentReply(actor(), c.id, 'Again')).rejects.toThrow(/already sent/);
    });
    // 7-day limit and opt-out.
    const other = await convOf(cid2, 'instagram_comment');
    await prisma.message.updateMany({ where: { conversationId: other.id }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    await expect(inbox.privateCommentReply(actor(), other.id, 'Hello')).rejects.toThrow(/7 days/);
    await prisma.message.updateMany({ where: { conversationId: other.id }, data: { createdAt: new Date() } });
    await prisma.customer.update({ where: { id: other.customerId }, data: { optedOutAt: new Date() } });
    await expect(inbox.privateCommentReply(actor(), other.id, 'Hello')).rejects.toThrow(/opted out/);
    const messenger = await convOf((await prisma.conversation.findFirst({ where: { organizationId: ORG, channel: 'messenger' } })).externalId, 'messenger');
    await expect(inbox.privateCommentReply(actor(), messenger.id, 'x')).rejects.toThrow(/Instagram comments/);
  });
});
