/**
 * Marketing agent against the real MySQL test database:
 *   import (consent + suppression) → segment → campaign draft (agent) → approval queue → simulated send (DRY_RUN)
 *   → live send to an approved test number with a FAKE WhatsApp fetch → delivery receipt → reply → attribution report,
 *   plus the content calendar and permission / tenant checks.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/marketing.integration.spec.ts
 *
 * REAL: MarketingService, Orchestrator + marketing task kinds, ApprovalsService, WhatsAppSenderService (with an injected
 * fake fetch - no network), ConversationsService, every database write. Nothing is sent to Meta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const ORG = 'org_marketing_test';
const OTHER = 'org_marketing_other';
const ADMIN = { sub: 'u_admin', role: 'admin' };
const MKT = { sub: 'u_mkt', role: 'marketing' };
const SALES = { sub: 'u_sales', role: 'sales' };
let n = 0;
const key = (p: string) => `${p}-${Date.now()}-${n++}`;
const base = String(Date.now()).slice(-6);
const phone = (i: number) => `9198${base}${String(i).padStart(2, '0')}`;
const csv = (rows: string[]) => ({ originalname: 'customers.csv', buffer: Buffer.from(rows.join('\n'), 'utf8') });

describe.skipIf(!enabled)('Marketing (integration)', () => {
  let prisma: any, marketing: any, orchestrator: any, approvals: any, sender: any, config: any;
  let segmentId: string;
  const sent: Array<Record<string, any>> = [];
  const saved = { dryRun: process.env.DRY_RUN, live: process.env.LIVE_TEST_RECIPIENTS, token: '', phoneId: '' };

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { ApprovalsService } = await import('../src/governance/approvals.service.js');
    const { WorkTasksService } = await import('../src/governance/work-tasks.service.js');
    const { InventoryService } = await import('../src/operations/inventory.service.js');
    const { Orchestrator } = await import('../src/agents/orchestrator.service.js');
    const { MarketingService } = await import('../src/marketing/marketing.service.js');
    const { WhatsAppSenderService } = await import('../src/whatsapp/whatsapp-sender.service.js');
    config = (await import('../src/common/config.js')).config;
    saved.token = config.whatsapp.accessToken;
    saved.phoneId = config.whatsapp.phoneNumberId;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, name] of [[ORG, 'Marketing Silks'], [OTHER, 'Other Mills']]) {
      await prisma.organization.upsert({ where: { id }, update: {}, create: { id, name } });
      await prisma.organizationSettings.upsert({ where: { organizationId: id }, update: { data: { industry: 'textile', roi: { whatsappCostPerMessageInr: 0.8 } } }, create: { organizationId: id, data: { industry: 'textile', roi: { whatsappCostPerMessageInr: 0.8 } } } });
    }
    // Clean slate for this org's marketing rows (customers cascade their recipients).
    await prisma.contentItem.deleteMany({ where: { organizationId: { in: [ORG, OTHER] } } });
    await prisma.marketingCampaign.deleteMany({ where: { organizationId: { in: [ORG, OTHER] } } });
    await prisma.marketingSegment.deleteMany({ where: { organizationId: { in: [ORG, OTHER] } } });
    await prisma.lead.deleteMany({ where: { organizationId: ORG } });
    await prisma.customer.deleteMany({ where: { organizationId: ORG } });
    await prisma.textileProduct.deleteMany({ where: { organizationId: ORG } });
    await prisma.textileProduct.createMany({
      data: [
        { organizationId: ORG, sku: 'MK-SLK', name: 'Kanchi Silk', fabricCategory: 'silk saree', colour: 'maroon', priceUnit: 'piece', price: 12000, priceApproved: true, stockStatus: 'in_stock', imageUrls: ['https://example.com/silk.jpg'] },
        { organizationId: ORG, sku: 'MK-COT', name: 'Chettinad Cotton', fabricCategory: 'cotton saree', priceUnit: 'piece', price: 1500, priceApproved: false, stockStatus: 'low' },
      ],
    });

    const settings = new SettingsService(prisma);
    const conversations = new ConversationsService(prisma);
    approvals = new ApprovalsService(prisma);
    sender = new WhatsAppSenderService();
    sender.fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.TEST${sent.length}` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never;
    marketing = new MarketingService(prisma, conversations, sender, approvals, settings);
    marketing.useQueue(null);
    orchestrator = new Orchestrator(prisma, new InventoryService(prisma), new WorkTasksService(prisma), approvals, settings, undefined, undefined, undefined, marketing);
    orchestrator.useQueue(null);
  });

  afterAll(async () => {
    process.env.DRY_RUN = saved.dryRun ?? 'true';
    if (saved.live === undefined) delete process.env.LIVE_TEST_RECIPIENTS;
    else process.env.LIVE_TEST_RECIPIENTS = saved.live;
    if (config) Object.assign(config.whatsapp, { accessToken: saved.token, phoneNumberId: saved.phoneId });
    await prisma?.$disconnect();
    const { followUpQueue, whatsappQueue, agentQueue, marketingQueue, closeRedisConnections } = await import('../src/queues/queues.js');
    await Promise.allSettled([followUpQueue.close(), whatsappQueue.close(), agentQueue.close(), marketingQueue.close()]);
    await closeRedisConnections();
  });

  const runRecipients = async (campaignId: string) => {
    const rs = await prisma.campaignRecipient.findMany({ where: { campaignId, status: 'queued' } });
    const out: string[] = [];
    for (const r of rs) out.push(await marketing.processRecipient({ campaignId, recipientId: r.id }));
    return out;
  };

  it('imports a customer list: preview writes nothing, consent only from an explicit column the importer confirmed', async () => {
    // Customer 5 opted out earlier (STOP): an import must never re-consent them.
    await prisma.customer.create({ data: { organizationId: ORG, phone: phone(5), name: 'Opted Out', optedOutAt: new Date() } });
    const file = csv([
      'Name,Mobile,Tags,WhatsApp consent,Language',
      `Anitha,${phone(1)},saree; wedding,yes,Tamil`,
      `Bala,${phone(2)},saree,no,English`,
      `Chitra,${phone(3)},saree,yes,`,
      `Opted Out,${phone(5)},saree,yes,`,
      'Broken,12,saree,yes,',
    ]);
    const preview = await marketing.importCustomers(ORG, file, { commit: 'false' });
    expect(preview.committed).toBe(false);
    expect(preview.valid).toBe(4);
    expect(preview.invalid).toBe(1);
    expect(preview.consentColumn).toBe(true);
    expect(await prisma.customer.count({ where: { organizationId: ORG } })).toBe(1);

    // Without "consent was collected": imported, but nobody gets consent.
    const noConfirm = await marketing.importCustomers(ORG, file, { commit: 'true' });
    expect(noConfirm.created).toBe(3);
    expect(noConfirm.consentRecorded).toBe(0);
    expect(await prisma.customer.count({ where: { organizationId: ORG, messagingConsent: true } })).toBe(0);

    const confirmed = await marketing.importCustomers(ORG, file, { commit: 'true', consentConfirmed: 'true', tags: 'diwali_list' });
    expect(confirmed.updated).toBe(4);
    expect(confirmed.consentRecorded).toBe(2); // Anitha, Chitra
    expect(confirmed.suppressedKept).toBe(1); // the opted-out customer stays opted out
    const anitha = await prisma.customer.findFirst({ where: { organizationId: ORG, phone: phone(1) } });
    expect(anitha.messagingConsent).toBe(true);
    expect(anitha.tags).toEqual(expect.arrayContaining(['saree', 'wedding', 'diwali_list']));
    expect((await prisma.customer.findFirst({ where: { organizationId: ORG, phone: phone(5) } })).messagingConsent).toBe(false);
    expect((await prisma.customer.findFirst({ where: { organizationId: ORG, phone: phone(2) } })).messagingConsent).toBe(false);
  });

  it('suppression list opts numbers out; segments always exclude opted-out and non-consented customers', async () => {
    const r = await marketing.importSuppression(ORG, csv(['phone', phone(3)]));
    expect(r.suppressed).toBe(1);
    const p = await marketing.previewAudience(ORG, { tags: ['saree'] });
    expect(p.inSegment).toBe(4);
    expect(p.eligible).toBe(1); // only Anitha
    expect(p.excluded).toEqual({ optedOut: 2, noConsent: 1 });
    segmentId = (await marketing.saveSegment(ORG, { name: 'Saree buyers', rules: { tags: ['Saree'] } }, 'user:u_mkt')).id;
    const list = await marketing.segments(ORG);
    expect(list.find((s: any) => s.id === segmentId)).toMatchObject({ eligible: 1, rules: { tags: ['saree'] } });
    await expect(marketing.saveSegment(ORG, { name: 'Saree buyers', rules: {} }, 'x')).rejects.toThrow(/already exists/);
  });

  let draftId: string;
  it('marketing agent drafts a campaign from the catalogue (approved prices only) - nothing is sent', async () => {
    const { task } = await orchestrator.submit(ORG, { kind: 'marketing.campaign_brief', input: { occasion: 'diwali', segmentId, offer: 'Free blouse stitching' }, trigger: 'user', idempotencyKey: key('brief'), requestedBy: 'user:u_mkt' }, { runNow: true });
    expect(task.status).toBe('COMPLETED');
    draftId = task.result.campaignId;
    const c = await marketing.detail(ORG, draftId);
    expect(c.status).toBe('draft');
    expect(c.segmentId).toBe(segmentId);
    expect(JSON.stringify(c.brief)).toContain('₹12000');
    expect(JSON.stringify(c.brief)).not.toContain('1500'); // unapproved price never mentioned
    expect(c.headerImageUrl).toBe('https://example.com/silk.jpg');
    expect(await prisma.campaignRecipient.count({ where: { campaignId: draftId } })).toBe(0);
    // No template yet: cannot be sent.
    const est = await marketing.estimate(ORG, draftId);
    expect(est.ready).toBe(false);
    expect(est.problems.join(' ')).toMatch(/approved WhatsApp template/);
  });

  it('approval queue: a marketing user requests, the stale screen / edits are refused, an admin approves, DRY_RUN simulates', async () => {
    await marketing.updateCampaign(ORG, draftId, { templateName: 'diwali_offer', templateLanguage: 'en', templateParams: ['{{name}}', 'Kanchi silk', 'Free stitching'] });
    const est = await marketing.estimate(ORG, draftId);
    expect(est).toMatchObject({ ready: true, eligible: 1, estimatedCost: 0.8, mode: 'simulation' });
    await expect(marketing.requestSend(ORG, draftId, MKT, { confirm: true, expectedRecipients: 5 })).rejects.toThrow(/audience changed/);
    await expect(marketing.requestSend(ORG, draftId, MKT, { expectedRecipients: 1 })).rejects.toThrow(/Confirm/);

    const pending = await marketing.requestSend(ORG, draftId, MKT, { confirm: true, expectedRecipients: 1 });
    expect(pending.status).toBe('pending_approval');
    expect(pending.approval.status).toBe('pending');
    await expect(marketing.updateCampaign(ORG, draftId, { name: 'Changed' })).rejects.toThrow(/Withdraw/);
    // Neither marketing staff nor sales can approve sending.
    await expect(approvals.decide(ORG, pending.approval.id, 'approve', MKT)).rejects.toThrow(/marketing.approve_campaign/);
    await expect(approvals.decide(ORG, pending.approval.id, 'approve', SALES)).rejects.toThrow(/marketing.approve_campaign/);

    const decided = await approvals.decide(ORG, pending.approval.id, 'approve', ADMIN);
    expect(decided.status).toBe('executed');
    const started = await marketing.detail(ORG, draftId);
    expect(started.status).toBe('sending');
    expect(started.simulated).toBe(true);
    expect(started.recipients).toHaveLength(1);
    expect(await runRecipients(draftId)).toEqual(['simulated']);
    expect(sent).toHaveLength(0); // DRY_RUN: no provider call at all
    const report = await marketing.report(ORG, draftId);
    expect(report).toMatchObject({ status: 'completed', simulated: true, sent: 0, simulatedCount: 1, adSpend: null });
    // Running it again never sends twice.
    expect(await marketing.processRecipient({ campaignId: draftId, recipientId: started.recipients[0].id })).toBe('already_simulated');
  });

  it('rejected requests come back editable with the decision; content changed after approval is never sent', async () => {
    const c = await marketing.createCampaign(ORG, { name: 'Pongal', occasion: 'pongal', segmentId, templateName: 'pongal_offer', templateLanguage: 'en', templateParams: ['{{name}}'] }, 'user:u_mkt');
    const p = await marketing.requestSend(ORG, c.id, MKT, { confirm: true, expectedRecipients: 1 });
    await approvals.decide(ORG, p.approval.id, 'reject', ADMIN, 'Wrong offer');
    const back = await marketing.detail(ORG, c.id);
    expect(back.status).toBe('rejected');
    expect(back.approval.decisionNote).toBe('Wrong offer');

    // Agent path: request → (someone changes the text in the database) → approve → refused, nothing queued.
    await marketing.updateCampaign(ORG, c.id, { templateParams: ['{{name}}', 'v2'] });
    const { task } = await orchestrator.submit(ORG, { kind: 'marketing.request_campaign_send', input: { campaignId: c.id }, trigger: 'user', idempotencyKey: key('send'), requestedBy: 'user:u_mkt' }, { runNow: true });
    expect(task.status).toBe('NEEDS_APPROVAL');
    await prisma.marketingCampaign.update({ where: { id: c.id }, data: { templateParams: ['{{name}}', 'TAMPERED'] } });
    const a = await approvals.decide(ORG, task.approvalId, 'approve', ADMIN);
    expect(a.status).toBe('failed');
    expect(await prisma.campaignRecipient.count({ where: { campaignId: c.id } })).toBe(0);
    expect((await prisma.marketingCampaign.findUnique({ where: { id: c.id } })).status).toBe('pending_approval');
  });

  let liveId: string;
  it('live send (fake provider): only approved test numbers, consent re-checked at send time, receipts, reply → lead attribution', async () => {
    process.env.DRY_RUN = 'false';
    process.env.LIVE_TEST_RECIPIENTS = phone(1);
    Object.assign(config.whatsapp, { accessToken: 'test-token', phoneNumberId: 'test-phone-id' });
    // A second consented customer, NOT a test number, and a third who opts out after approval.
    await prisma.customer.create({ data: { organizationId: ORG, phone: phone(6), name: 'Devi', tags: ['saree'], messagingConsent: true } });
    await prisma.customer.create({ data: { organizationId: ORG, phone: phone(7), name: 'Ezhil', tags: ['saree'], messagingConsent: true } });
    // Anitha already has an open enquiry without a campaign.
    const anitha = await prisma.customer.findFirst({ where: { organizationId: ORG, phone: phone(1) } });
    const lead = await prisma.lead.create({ data: { organizationId: ORG, customerId: anitha.id, status: 'new', source: 'whatsapp' } });

    const c = await marketing.createCampaign(ORG, { name: 'Diwali silk', occasion: 'diwali', segmentId, templateName: 'diwali_offer', templateLanguage: 'ta', templateParams: ['{{name}}', '{{shop}} silk'], headerImageUrl: 'https://example.com/silk.jpg' }, 'user:u_mkt');
    liveId = c.id;
    const { task } = await orchestrator.submit(ORG, { kind: 'marketing.request_campaign_send', input: { campaignId: c.id }, trigger: 'user', idempotencyKey: key('send'), requestedBy: 'user:u_mkt' }, { runNow: true });
    expect(task.status).toBe('NEEDS_APPROVAL');
    const approval = await approvals.get(ORG, task.approvalId);
    expect(approval.payload).toMatchObject({ campaignId: c.id, expectedRecipients: 3, proposed: 'marketing.campaign_send' });
    expect(approval.requiredPermission).toBe('marketing.approve_campaign');
    expect((await approvals.decide(ORG, task.approvalId, 'approve', ADMIN)).status).toBe('executed');
    expect((await prisma.agentTask.findUnique({ where: { id: task.id } })).status).toBe('COMPLETED');

    await prisma.customer.update({ where: { organizationId_phone: { organizationId: ORG, phone: phone(7) } }, data: { optedOutAt: new Date() } });
    const results = (await runRecipients(c.id)).sort();
    expect(results).toEqual(['sent', 'simulated', 'skipped']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: phone(1), type: 'template', template: { name: 'diwali_offer', language: { code: 'ta' } } });
    expect(sent[0].template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://example.com/silk.jpg' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Anitha' }, { type: 'text', text: 'Marketing Silks silk' }] },
    ]);
    const detail = await marketing.detail(ORG, c.id);
    expect(detail.recipients.find((r: any) => r.phone === phone(6))).toMatchObject({ status: 'simulated', reason: expect.stringMatching(/LIVE_TEST_RECIPIENTS/) });
    expect(detail.recipients.find((r: any) => r.phone === phone(7))).toMatchObject({ status: 'skipped', reason: 'customer opted out' });
    expect(detail.status).toBe('completed');

    // Meta receipts move forward only; then Anitha replies.
    await marketing.applyDeliveryStatus(ORG, 'wamid.TEST1', 'delivered');
    await marketing.applyDeliveryStatus(ORG, 'wamid.TEST1', 'sent');
    await marketing.applyDeliveryStatus(ORG, 'wamid.TEST1', 'read');
    expect(await marketing.recordReply(ORG, phone(1))).toBe(c.id);
    expect((await prisma.lead.findUnique({ where: { id: lead.id } })).campaign).toBe('Diwali silk');

    const report = await marketing.report(ORG, c.id);
    expect(report).toMatchObject({ simulated: false, sent: 1, delivered: 1, replied: 1, simulatedCount: 1, skipped: 1, leads: 1, messagingCost: 0.8, adSpend: null });
    // Fake credentials are removed before anything could call Meta (the permission check is read-only, but never with a fake token).
    Object.assign(config.whatsapp, { accessToken: saved.token, phoneNumberId: saved.phoneId });
    const perf = await marketing.performance(ORG, 30);
    expect(perf.totals.leads).toBeGreaterThanOrEqual(1);
    expect(perf.adSpend.available).toBe(false);

    // The agent report says the same.
    const r = await orchestrator.submit(ORG, { kind: 'marketing.campaign_report', input: { campaignId: c.id }, trigger: 'user', idempotencyKey: key('rep'), requestedBy: 'user:u_mkt' }, { runNow: true });
    expect(r.task.result).toMatchObject({ sent: 1, replied: 1, leads: 1 });
    process.env.DRY_RUN = 'true';
  });

  it('a reply to a simulated message is not credited to a campaign', async () => {
    expect(await marketing.recordReply(ORG, phone(6))).toBeNull();
  });

  it('content calendar: agent drafts, approval, editing resets approval, published is recorded by a person', async () => {
    const { task } = await orchestrator.submit(ORG, { kind: 'marketing.content_plan', input: { days: 6, channels: ['instagram', 'whatsapp_status'], occasion: 'diwali' }, trigger: 'user', idempotencyKey: key('plan'), requestedBy: 'user:u_mkt' }, { runNow: true });
    expect(task.status).toBe('COMPLETED');
    expect(task.result.created).toHaveLength(6); // days 0, 2, 4 × 2 channels
    const items = await marketing.content(ORG, { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    expect(items.every((i: any) => i.status === 'draft')).toBe(true);
    expect(items.map((i: any) => i.body).join(' ')).not.toContain('1500');

    const it0 = items[0];
    await expect(marketing.markPublished(ORG, it0.id, 'user:u_mkt')).rejects.toThrow(/Only approved/);
    const approved = await marketing.requestContentApproval(ORG, it0.id, MKT); // marketing staff hold approve_content
    expect(approved.status).toBe('approved');
    const edited = await marketing.updateContent(ORG, it0.id, { body: 'New text' });
    expect(edited.status).toBe('draft');

    // Sales cannot approve content: their request waits in the queue for someone who can.
    const queued = await marketing.requestContentApproval(ORG, it0.id, SALES);
    expect(queued.status).toBe('pending_approval');
    await approvals.decide(ORG, queued.approvalId, 'approve', MKT);
    const pub = await marketing.markPublished(ORG, it0.id, 'user:u_mkt', 'Posted on Instagram');
    expect(pub).toMatchObject({ status: 'published', publishedBy: 'user:u_mkt', publishedNote: 'Posted on Instagram' });
  });

  it('tenant isolation: another business cannot see or act on these records', async () => {
    await expect(marketing.detail(OTHER, liveId)).rejects.toThrow(/not found/);
    await expect(marketing.requestSend(OTHER, liveId, ADMIN, { confirm: true, expectedRecipients: 0 })).rejects.toThrow(/not found/);
    expect((await marketing.customers(OTHER)).items).toHaveLength(0);
    expect(await marketing.recordReply(OTHER, phone(1))).toBeNull();
  });
});
