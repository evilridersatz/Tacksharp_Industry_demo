/**
 * Razorpay payment links for Tacksharp's invoices, DB-backed (real MySQL TEST database; Razorpay's API is a fake fetch,
 * webhooks are signed here exactly as Razorpay signs them). Proves: refused without keys / webhook secret / in DRY_RUN;
 * the exact create request (basic auth, paise, unique reference, no Razorpay notifications); one open link per invoice;
 * void refused while a link is open; webhook: no secret / bad signature -> 401; unknown link ignored; amount or
 * reference mismatch never marks paid (recorded for staff); a matching payment marks paid once (event id idempotency,
 * re-delivery and a second event); past_due cleared; paid-after-void flagged; expired / cancelled free the invoice;
 * printable invoice data scoped to the organization; seller details only from configuration.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const run = Date.now().toString(36);
const A = `org_pay_a_${run}`;
const B = `org_pay_b_${run}`;
const WH = `whsec_${run}_abcdef`;
const ENV_KEYS = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'DRY_RUN', 'PLATFORM_LEGAL_NAME', 'PLATFORM_GSTIN'] as const;

describe.skipIf(!enabled)('Razorpay payment links (integration)', () => {
  let prisma: any, billing: any, payments: any, staff: any, inv: any;
  const saved: Record<string, string | undefined> = {};
  const admin = () => ({ sub: staff.id });
  const calls: Array<{ url: string; auth: string; body: any }> = [];
  let reply: () => Response = () => new Response('{}', { status: 500 });
  const hook = async (body: unknown, opts: { secret?: string; eventId?: string; sig?: string } = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = opts.sig ?? createHmac('sha256', opts.secret ?? WH).update(raw).digest('hex');
    return payments.webhook(raw, sig, opts.eventId ?? `evt_${Math.random().toString(36).slice(2)}`, JSON.parse(raw.toString()));
  };
  const paidEvent = (linkId: string, reference: string, amountPaid: number, currency = 'INR') => ({
    entity: 'event', event: 'payment_link.paid', contains: ['payment_link', 'order', 'payment'],
    payload: { payment_link: { entity: { id: linkId, reference_id: reference, amount: amountPaid, amount_paid: amountPaid, currency, status: 'paid' } }, payment: { entity: { id: `pay_${run}`, amount: amountPaid, status: 'captured', method: 'upi' } } },
  });

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DRY_RUN = 'true';
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { BillingService } = await import('../src/billing/billing.service.js');
    const { PaymentsService } = await import('../src/billing/payments.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [A, B]) await prisma.organization.create({ data: { id, name: `Pay ${id}`, vertical: 'restaurant' } });
    staff = await prisma.user.create({ data: { organizationId: B, email: `pay-staff-${run}@example.test`, name: 'Staff', passwordHash: 'x', role: 'admin', isPlatformAdmin: true } });
    billing = new BillingService(prisma);
    payments = new PaymentsService(prisma, billing);
    payments.fetchImpl = async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return reply();
    };
    const c = await billing.createContract(admin(), { name: `Group ${run}`, billingEmail: 'accounts@group.example', gstin: '33ABCDE1234F1Z5', billingAddress: '12 Anna Salai, Chennai' });
    await billing.setSubscription(admin(), A, { planCode: 'growth', price: 4999, contractId: c.id });
    inv = await billing.issueInvoice(admin(), A);
  }, 60_000);

  afterAll(async () => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (!prisma) return;
    await prisma.paymentWebhookEvent.deleteMany({ where: { eventId: { startsWith: `evt_${run}` } } });
    await prisma.user.deleteMany({ where: { id: staff.id } });
    await prisma.organization.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.billingContract.deleteMany({ where: { name: `Group ${run}` } });
    await prisma.$disconnect();
  });

  it('refused without keys, without a webhook secret, and in DRY_RUN; nothing sent', async () => {
    await expect(payments.createLink(admin(), inv.id)).rejects.toThrow(/RAZORPAY_KEY_ID/);
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    await expect(payments.createLink(admin(), inv.id)).rejects.toThrow(/RAZORPAY_WEBHOOK_SECRET/);
    process.env.RAZORPAY_WEBHOOK_SECRET = WH;
    await expect(payments.createLink(admin(), inv.id)).rejects.toThrow(/DRY_RUN/);
    expect(calls).toEqual([]);
    expect(payments.status()).toEqual({ razorpay: true, webhook: true, dryRun: true });
  });

  it('creates the link with the exact request; one open link per invoice; void refused while it is open', async () => {
    process.env.DRY_RUN = 'false';
    reply = () => new Response(JSON.stringify({ id: `plink_${run}`, short_url: 'https://rzp.io/i/abc123', status: 'created' }), { status: 200 });
    const r = await payments.createLink(admin(), inv.id);
    expect(r).toMatchObject({ paymentLinkId: `plink_${run}`, paymentLinkUrl: 'https://rzp.io/i/abc123', paymentLinkStatus: 'created' });
    const c = calls[0];
    expect(c.url).toBe('https://api.razorpay.com/v1/payment_links');
    expect(c.auth).toBe(`Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`);
    expect(c.body).toMatchObject({ amount: 589882, currency: 'INR', accept_partial: false, notify: { sms: false, email: false }, reminder_enable: false, customer: { name: `Pay ${A}`, email: 'accounts@group.example' }, notes: { invoiceId: inv.id, invoiceNumber: inv.number, organizationId: A } });
    expect(c.body.reference_id.startsWith(`${inv.number}-`)).toBe(true);
    expect(c.body.reference_id.length).toBeLessThanOrEqual(40);
    expect(c.body.expire_by).toBeGreaterThan(Date.now() / 1000 + 900);
    await expect(payments.createLink(admin(), inv.id)).rejects.toMatchObject({ status: 409 });
    await expect(billing.voidInvoice(admin(), inv.id, { reason: 'wrong price' })).rejects.toThrow(/open Razorpay payment link/);
    // The organization sees "pay online".
    expect((await billing.summary(A)).invoices[0]).toMatchObject({ payUrl: 'https://rzp.io/i/abc123' });
    // Razorpay refusal is shown and nothing is stored.
    const inv2 = await prisma.platformInvoice.create({ data: { number: `TS-T-${run}`, organizationId: A, description: 'x', periodStart: new Date(), periodEnd: new Date(), subtotal: 0.5, taxRatePct: 0, tax: 0, total: 0.5, dueAt: new Date(Date.now() + 86400000) } });
    await expect(payments.createLink(admin(), inv2.id)).rejects.toThrow(/at least ₹1/);
    await prisma.platformInvoice.delete({ where: { id: inv2.id } });
  });

  it('webhook: secret and signature required; unknown link ignored; mismatches never mark paid', async () => {
    const ok = paidEvent(`plink_${run}`, `${inv.number}-x`, 589882);
    await expect(hook(ok, { secret: 'wrong' })).rejects.toMatchObject({ status: 401 });
    await expect(hook(ok, { sig: 'nothex' })).rejects.toMatchObject({ status: 401 });
    expect(await hook(paidEvent('plink_unknown', 'x', 100), { eventId: `evt_${run}_u` })).toMatchObject({ outcome: 'ignored: unknown payment link' });
    const r1 = await hook(paidEvent(`plink_${run}`, `${inv.number}-x`, 500000), { eventId: `evt_${run}_amt` });
    expect(r1.outcome).toMatch(/mismatch: paid 500000 paise, invoice is 589882/);
    const r2 = await hook(paidEvent(`plink_${run}`, 'TS-1999-00001-x', 589882), { eventId: `evt_${run}_ref` });
    expect(r2.outcome).toMatch(/reference does not match/);
    expect((await prisma.platformInvoice.findUnique({ where: { id: inv.id } })).status).toBe('issued');
    const audit = await prisma.auditEvent.findMany({ where: { organizationId: A, action: 'invoice.payment_mismatch' } });
    expect(audit).toHaveLength(2);
    // Unsigned config: refused.
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    await expect(hook(ok)).rejects.toThrow(/not configured/);
    process.env.RAZORPAY_WEBHOOK_SECRET = WH;
  });

  it('a matching payment marks the invoice paid once; re-delivery ignored; past_due cleared', async () => {
    await prisma.platformInvoice.updateMany({ where: { id: inv.id }, data: { paymentLinkStatus: 'created' } });
    await prisma.platformInvoice.update({ where: { id: inv.id }, data: { dueAt: new Date(Date.now() - 86_400_000) } });
    await billing.refreshPastDue(A);
    expect((await prisma.subscription.findUnique({ where: { organizationId: A } })).status).toBe('past_due');
    const ev = paidEvent(`plink_${run}`, `${inv.number}-x`, 589882);
    expect(await hook(ev, { eventId: `evt_${run}_paid` })).toMatchObject({ outcome: 'paid' });
    expect(await hook(ev, { eventId: `evt_${run}_paid` })).toMatchObject({ duplicate: true });
    expect(await hook(ev, { eventId: `evt_${run}_paid2` })).toMatchObject({ outcome: 'needs review: invoice was paid' });
    const i = await prisma.platformInvoice.findUnique({ where: { id: inv.id } });
    expect(i).toMatchObject({ status: 'paid', paymentReference: `razorpay:pay_${run}`, paymentLinkStatus: 'paid' });
    expect((await prisma.subscription.findUnique({ where: { organizationId: A } })).status).toBe('active');
    expect((await billing.summary(A)).invoices[0].payUrl).toBeNull();
    expect(await prisma.auditEvent.count({ where: { organizationId: A, action: 'invoice.paid', actor: 'razorpay' } })).toBe(1);
  });

  it('expired link frees the invoice for a new link or a void; paid after void is flagged, not applied', async () => {
    await billing.renew(admin(), A).catch(() => undefined);
    await prisma.subscription.update({ where: { organizationId: A }, data: { currentPeriodStart: new Date('2026-12-01T00:00:00Z'), currentPeriodEnd: new Date('2027-01-01T00:00:00Z') } });
    const inv3 = await billing.issueInvoice(admin(), A);
    reply = () => new Response(JSON.stringify({ id: `plink_${run}_3`, short_url: 'https://rzp.io/i/def456', status: 'created' }), { status: 200 });
    await payments.createLink(admin(), inv3.id);
    expect(await hook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: `plink_${run}_3`, status: 'expired', amount_paid: 0 } } } }, { eventId: `evt_${run}_exp` })).toMatchObject({ outcome: 'link expired' });
    expect((await billing.summary(A)).invoices.find((x: any) => x.id === inv3.id).payUrl).toBeNull();
    await billing.voidInvoice(admin(), inv3.id, { reason: 'Re-issued with a discount' });
    expect(await hook(paidEvent(`plink_${run}_3`, `${inv3.number}-x`, toPaise(inv3.total)), { eventId: `evt_${run}_late` })).toMatchObject({ outcome: 'needs review: invoice was void' });
    expect((await prisma.platformInvoice.findUnique({ where: { id: inv3.id } })).status).toBe('void');
    expect(await prisma.auditEvent.count({ where: { organizationId: A, action: 'invoice.paid_needs_review' } })).toBe(2);
  });

  it('printable invoice: scoped to the organization; seller details only from configuration', async () => {
    let d = await billing.invoiceDocument(A, inv.id);
    expect(d.buyer).toMatchObject({ name: `Group ${run}`, gstin: '33ABCDE1234F1Z5', address: '12 Anna Salai, Chennai', email: 'accounts@group.example' });
    expect(d.seller).toEqual({ name: null, gstin: null, address: null, email: null });
    expect(d.note).toMatch(/not a tax invoice/);
    process.env.PLATFORM_LEGAL_NAME = 'Example Seller Pvt Ltd';
    process.env.PLATFORM_GSTIN = '33AAAAA0000A1Z5';
    d = await billing.invoiceDocument(null, inv.id);
    expect(d.seller).toMatchObject({ name: 'Example Seller Pvt Ltd', gstin: '33AAAAA0000A1Z5' });
    expect(d.note).toMatch(/not a GST e-invoice/);
    await expect(billing.invoiceDocument(B, inv.id)).rejects.toMatchObject({ status: 404 });
  });
});

const toPaise = (n: number) => Math.round(n * 100);
