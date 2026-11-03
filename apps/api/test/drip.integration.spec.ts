/**
 * Drip automation, DB-backed (real MySQL TEST database + Redis lock; WhatsApp sender and telephony are fakes).
 * Proves: validation and industry preset; enrolment rules (opt-out, duplicates, one drip at a time, tenant isolation);
 * a 5-step Day 0/1/3/5-call/7 sequence runs to completion in DRY_RUN with every step recorded as simulated and nothing
 * sent; stop on opt-out / reply / human take-over / conversion; paused sequences do not run; sending hours; contact
 * preference; live path through the live gate; transient retry with a limit; ambiguous send and interrupted runs are
 * never repeated; concurrent runs execute a step once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const ORG = 'org_test_drip_a';
const ORG_B = 'org_test_drip_b';
const run = Date.now().toString(36);
const DAY = 86_400_000;
let n = 0;

describe.skipIf(!enabled)('drip automation (integration)', () => {
  let prisma: any, svc: any, conversations: any, sender: any, telephony: any, errors: any;
  const actor = { sub: `drip-admin-${run}`, org: ORG };
  const steps = [
    { day: 0, channel: 'whatsapp', text: 'Hi {name}, thanks for contacting {business}!', templateName: 'drip_intro' },
    { day: 1, channel: 'whatsapp', text: 'Day 1 for {name}', templateName: 'drip_intro' },
    { day: 3, channel: 'whatsapp', text: 'Day 3 for {name}', templateName: 'drip_intro' },
    { day: 5, channel: 'voice' },
    { day: 7, channel: 'whatsapp', text: 'Day 7 for {name}', templateName: 'drip_intro' },
  ];

  async function customer(org = ORG, opts: { consent?: boolean; inbound?: Date | null } = {}) {
    const phone = `9197${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
    const c = await conversations.getOrCreateCustomerByPhone(org, phone, { name: `Drip Cust ${n}` });
    return prisma.customer.update({
      where: { id: c.id },
      data: { messagingConsent: opts.consent ?? true, callingConsent: opts.consent ?? true, lastInboundAt: opts.inbound === undefined ? new Date(Date.now() - 3600_000) : opts.inbound, stage: 'interested' },
    });
  }

  async function sequence(extra: Record<string, unknown> = {}) {
    const s = await svc.create(actor, { name: `Seq ${run} ${n++}`, steps, sendStartHour: 0, sendEndHour: 24, ...extra });
    await svc.setStatus(actor, s.id, 'active');
    return s;
  }

  async function enrollment(seqId: string, customerId: string) {
    return prisma.dripEnrollment.findUnique({ where: { sequenceId_customerId: { sequenceId: seqId, customerId } } });
  }

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { DripService } = await import('../src/drip/drip.service.js');
    errors = await import('../src/whatsapp/whatsapp-sender.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, vertical] of [[ORG, 'restaurant'], [ORG_B, 'real_estate']]) await prisma.organization.upsert({ where: { id }, create: { id, name: id, vertical }, update: {} });
    conversations = new ConversationsService(prisma);
    sender = { sendText: vi.fn(async () => `wamid.DRIP${n++}`), sendCampaignTemplate: vi.fn(async () => `wamid.TPL${n++}`) };
    telephony = { placeSystemCall: vi.fn(async () => ({ started: false, dryRun: true, reason: 'dry_run' })) };
    svc = new DripService(prisma, conversations, sender, telephony);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    for (const org of [ORG, ORG_B]) {
      await prisma.dripSequence.deleteMany({ where: { organizationId: org } });
      await prisma.auditEvent.deleteMany({ where: { organizationId: org, entityType: 'drip_sequence' } });
    }
    await prisma.$disconnect();
  });

  it('validation, duplicate names and the industry preset (Day 0/1/3/5 call/7)', async () => {
    await expect(svc.create(actor, { name: '', steps: [] })).rejects.toMatchObject({ response: { errors: { name: expect.any(String), steps: expect.any(String) } } });
    await expect(svc.create(actor, { name: 'x', steps: [{ day: 3, channel: 'whatsapp', text: 'a' }, { day: 1, channel: 'whatsapp', text: 'b' }] })).rejects.toMatchObject({ response: { errors: { 'steps.1.day': expect.stringMatching(/order/) } } });
    await expect(svc.create(actor, { name: 'x', steps: [{ day: 0, channel: 'whatsapp' }] })).rejects.toMatchObject({ response: { errors: { 'steps.0.text': expect.any(String) } } });
    await expect(svc.create(actor, { name: 'x', steps: [{ day: 0, channel: 'sms', text: 'a' }] })).rejects.toMatchObject({ response: { errors: { 'steps.0.channel': expect.any(String) } } });
    await expect(svc.create(actor, { name: 'x', steps, sendStartHour: 20, sendEndHour: 9 })).rejects.toMatchObject({ response: { errors: { hours: expect.any(String) } } });
    const s = await svc.create(actor, { name: `Dup ${run}`, steps });
    expect(s.status).toBe('draft');
    await expect(svc.create(actor, { name: `Dup ${run}`, steps })).rejects.toThrow(/already exists/);
    const p = await svc.presets(ORG);
    expect(p.steps.map((x: any) => `${x.day}${x.channel[0]}`)).toEqual(['0w', '1w', '3w', '5v', '7w']);
    expect((await svc.presets(ORG_B)).name).toBe('New lead nurture');
  });

  it('a full sequence runs to completion in DRY_RUN: every step simulated, nothing sent, nothing repeated', async () => {
    const s = await sequence();
    const c = await customer();
    const r = await svc.enroll(actor, s.id, { customerIds: [c.id] });
    expect(r).toMatchObject({ enrolled: 1, sequenceActive: true });
    const t0 = Date.now();
    const results: string[] = [];
    for (const day of [0, 1, 3, 5, 7]) results.push(await svc.runOne((await enrollment(s.id, c.id)).id, new Date(t0 + day * DAY + 60_000)));
    expect(results).toEqual(['simulated', 'simulated', 'simulated', 'simulated', 'simulated;completed']);
    const e = await enrollment(s.id, c.id);
    expect(e).toMatchObject({ status: 'completed', nextRunAt: null });
    const runs = await prisma.dripStepRun.findMany({ where: { enrollmentId: e.id }, orderBy: { stepIndex: 'asc' } });
    expect(runs.map((x: any) => `${x.stepIndex}:${x.channel}:${x.status}`)).toEqual(['0:whatsapp:simulated', '1:whatsapp:simulated', '2:whatsapp:simulated', '3:voice:simulated', '4:whatsapp:simulated']);
    expect(runs[0].reason).toMatch(/DRY_RUN/);
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendCampaignTemplate).not.toHaveBeenCalled();
    expect(telephony.placeSystemCall).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, customerId: c.id, purpose: 'drip', idempotencyKey: `${e.id}-3` }));
    // Messages are in the customer's conversation, labelled as not sent.
    const msgs = await prisma.message.findMany({ where: { Conversation: { customerId: c.id } }, orderBy: { createdAt: 'asc' } });
    expect(msgs.map((m: any) => m.content)).toEqual([`Hi Drip, thanks for contacting ${ORG}!`, 'Day 1 for Drip', 'Day 3 for Drip', 'Day 7 for Drip']);
    expect(msgs.every((m: any) => m.metadata.simulated === true && m.metadata.drip.sequenceId === s.id)).toBe(true);
    // Running again does nothing.
    expect(await svc.runOne(e.id, new Date(t0 + 30 * DAY))).toBe('not_due');
    const d = await svc.detail(ORG, s.id);
    expect(d.counts).toMatchObject({ completed: 1 });
    expect(d.stepStats[3]).toEqual({ simulated: 1 });
    expect(d.enrollments[0].customer.phone).toMatch(/^••••\d{4}$/);
  });

  it('enrolment: opted out / no phone skipped, no duplicates, one drip at a time, tenant isolation', async () => {
    const s1 = await sequence();
    const s2 = await sequence();
    const ok = await customer();
    const out = await customer();
    await prisma.customer.update({ where: { id: out.id }, data: { optedOutAt: new Date() } });
    const foreign = await customer(ORG_B);
    const r = await svc.enroll(actor, s1.id, { customerIds: [ok.id, out.id, foreign.id] });
    expect(r).toMatchObject({ matched: 2, enrolled: 1, skipped: { opted_out: 1, already_enrolled: 0 } });
    expect((await svc.enroll(actor, s1.id, { customerIds: [ok.id] })).skipped.already_enrolled).toBe(1);
    expect((await svc.enroll(actor, s2.id, { customerIds: [ok.id] })).skipped.already_enrolled).toBe(1);
    await expect(svc.enroll(actor, s1.id, {})).rejects.toThrow(/Choose customers/);
    await expect(svc.detail(ORG_B, s1.id)).rejects.toThrow(/not found/);
    await expect(svc.enroll({ sub: 'x', org: ORG_B }, s1.id, { customerIds: [foreign.id] })).rejects.toThrow(/not found/);
    // By stage: every interested customer of this org without an active drip.
    const s3 = await sequence();
    const byStage = await svc.enroll(actor, s3.id, { stage: 'interested' });
    expect(byStage.enrolled).toBeGreaterThan(0);
    expect(await enrollment(s3.id, ok.id)).toBeNull();
  });

  it('stops on opt-out, reply, human take-over and conversion; paused sequences do not run', async () => {
    const s = await sequence();
    const [a, b, c, d, e] = [await customer(), await customer(), await customer(), await customer(), await customer()];
    await svc.enroll(actor, s.id, { customerIds: [a.id, b.id, c.id, d.id, e.id] });
    await prisma.customer.update({ where: { id: a.id }, data: { optedOutAt: new Date() } });
    await prisma.customer.update({ where: { id: b.id }, data: { lastInboundAt: new Date(Date.now() + 1000) } });
    const conv = await conversations.getOrCreateConversation({ organizationId: ORG, channel: 'whatsapp', externalId: c.phone, customerId: c.id });
    await prisma.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false, inboxStatus: 'open' } });
    await prisma.customer.update({ where: { id: d.id }, data: { stage: 'converted' } });
    const at = new Date(Date.now() + 60_000);
    expect(await svc.runOne((await enrollment(s.id, a.id)).id, at)).toBe('stopped:opted_out');
    expect(await svc.runOne((await enrollment(s.id, b.id)).id, at)).toBe('stopped:customer_replied');
    expect(await svc.runOne((await enrollment(s.id, c.id)).id, at)).toBe('stopped:human_owner');
    expect(await svc.runOne((await enrollment(s.id, d.id)).id, at)).toBe('stopped:converted');
    expect(await prisma.dripStepRun.count({ where: { enrollment: { sequenceId: s.id, customerId: { in: [a.id, b.id, c.id, d.id] } } } })).toBe(0);
    // Paused: the worker's sweep skips it and runOne refuses.
    await svc.setStatus(actor, s.id, 'paused');
    expect(await svc.runOne((await enrollment(s.id, e.id)).id, at)).toBe('sequence_not_active');
    const pausedId = (await enrollment(s.id, e.id)).id;
    const swept = await svc.runDue(500, at);
    expect(swept.find((x: any) => x.id === pausedId)).toBeUndefined();
    expect(await prisma.dripStepRun.count({ where: { enrollment: { sequenceId: s.id } } })).toBe(0);
    // Resumed: the sweep runs it (Redis customer lock + lease).
    await svc.setStatus(actor, s.id, 'active');
    const eid = (await enrollment(s.id, e.id)).id;
    const after = await svc.runDue(500, at);
    expect(after.find((x: any) => x.id === eid)?.result).toBe('simulated');
    // Stopped by a person.
    expect((await svc.stopEnrollment(actor, eid)).stopReason).toBe('stopped_by_user');
  });

  it('sending hours: a step due outside the hours waits for the next window (nothing sent)', async () => {
    const s = await sequence({ sendStartHour: 9, sendEndHour: 10 });
    const c = await customer();
    await svc.enroll(actor, s.id, { customerIds: [c.id] });
    const e = await enrollment(s.id, c.id);
    // 12:00 IST tomorrow (06:30 UTC).
    const noon = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1, 6, 30));
    await prisma.dripEnrollment.update({ where: { id: e.id }, data: { nextRunAt: new Date(noon.getTime() - 1000) } });
    expect(await svc.runOne(e.id, noon)).toBe('outside_hours');
    const next = (await enrollment(s.id, c.id)).nextRunAt;
    expect(next.toISOString()).toBe(new Date(noon.getTime() + DAY - 3 * 3600_000).toISOString()); // 09:00 IST next day
    expect(await prisma.dripStepRun.count({ where: { enrollmentId: e.id } })).toBe(0);
  });

  it('contact preference: no consent and never contacted -> step skipped, sequence continues', async () => {
    const s = await sequence();
    const c = await customer(ORG, { consent: false, inbound: null });
    await svc.enroll(actor, s.id, { customerIds: [c.id] });
    expect(await svc.runOne((await enrollment(s.id, c.id)).id, new Date(Date.now() + 60_000))).toBe('skipped');
    const e = await enrollment(s.id, c.id);
    expect(e.stepIndex).toBe(1);
    expect((await prisma.dripStepRun.findFirst({ where: { enrollmentId: e.id } })).reason).toMatch(/No WhatsApp consent/);
  });

  it('live path (approved test number): sends; transient errors retry up to 3 times then fail; ambiguous / interrupted sends are never repeated', async () => {
    const prev = { dry: process.env.DRY_RUN, live: process.env.LIVE_TEST_RECIPIENTS };
    try {
      const s = await sequence();
      const [ok, flaky, unknown, crashed] = [await customer(), await customer(), await customer(), await customer()];
      process.env.DRY_RUN = 'false';
      process.env.LIVE_TEST_RECIPIENTS = [ok, flaky, unknown, crashed].map((c: any) => c.phone).join(',');
      await svc.enroll(actor, s.id, { customerIds: [ok.id, flaky.id, unknown.id, crashed.id] });
      let at = new Date(Date.now() + 60_000);

      sender.sendText.mockClear();
      expect(await svc.runOne((await enrollment(s.id, ok.id)).id, at)).toBe('sent');
      expect(sender.sendText).toHaveBeenCalledWith(ok.phone, `Hi Drip, thanks for contacting ${ORG}!`);
      const sentRun = await prisma.dripStepRun.findFirst({ where: { enrollment: { sequenceId: s.id, customerId: ok.id } } });
      expect(sentRun).toMatchObject({ status: 'sent', providerMessageId: expect.stringMatching(/^wamid\.DRIP/) });

      sender.sendText.mockImplementation(async () => { throw new errors.WhatsAppTransientError('WhatsApp API 503'); });
      const fid = (await enrollment(s.id, flaky.id)).id;
      const tries: string[] = [];
      for (let i = 0; i < 4; i++) {
        tries.push(await svc.runOne(fid, at));
        at = new Date(at.getTime() + 2 * 3600_000);
      }
      expect(tries).toEqual(['retry:WhatsApp API 503', 'retry:WhatsApp API 503', 'retry:WhatsApp API 503', 'failed']);
      expect(await prisma.dripStepRun.findFirst({ where: { enrollmentId: fid } })).toMatchObject({ status: 'failed', reason: expect.stringMatching(/Gave up after 4 attempts/) });
      expect((await enrollment(s.id, flaky.id)).stepIndex).toBe(1);

      sender.sendText.mockImplementation(async () => { throw new errors.WhatsAppAmbiguousSendError('timeout after send'); });
      const uid = (await enrollment(s.id, unknown.id)).id;
      expect(await svc.runOne(uid, at)).toBe('failed');
      expect((await prisma.dripStepRun.findFirst({ where: { enrollmentId: uid } })).reason).toMatch(/not repeated/);

      // A crash left a 'processing' run: the next tick does not send it again.
      sender.sendText.mockReset();
      sender.sendText.mockImplementation(async () => `wamid.DRIP${n++}`);
      const cid = (await enrollment(s.id, crashed.id)).id;
      await prisma.dripStepRun.create({ data: { organizationId: ORG, enrollmentId: cid, stepIndex: 0, channel: 'whatsapp', status: 'processing' } });
      expect(await svc.runOne(cid, at)).toBe('interrupted');
      expect(sender.sendText).not.toHaveBeenCalled();
      expect((await enrollment(s.id, crashed.id)).stepIndex).toBe(1);
    } finally {
      process.env.DRY_RUN = prev.dry ?? 'true';
      if (prev.live === undefined) delete process.env.LIVE_TEST_RECIPIENTS; else process.env.LIVE_TEST_RECIPIENTS = prev.live;
      sender.sendText.mockReset();
      sender.sendText.mockImplementation(async () => `wamid.DRIP${n++}`);
    }
  });

  it('concurrent runs of the same step execute it once', async () => {
    const s = await sequence();
    const c = await customer();
    await svc.enroll(actor, s.id, { customerIds: [c.id] });
    const id = (await enrollment(s.id, c.id)).id;
    const at = new Date(Date.now() + 60_000);
    const out = await Promise.all([svc.runOne(id, at), svc.runOne(id, at), svc.runOne(id, at)]);
    expect(out.filter((x) => x === 'simulated')).toHaveLength(1);
    expect(await prisma.dripStepRun.count({ where: { enrollmentId: id } })).toBe(1);
    expect(await prisma.message.count({ where: { Conversation: { customerId: c.id } } })).toBe(1);
  });

  it('editing the steps re-times running enrolments; changes are audited', async () => {
    const s = await sequence();
    const c = await customer();
    await svc.enroll(actor, s.id, { customerIds: [c.id] });
    const e = await enrollment(s.id, c.id);
    await svc.runOne(e.id, new Date(Date.now() + 60_000));
    await svc.update(actor, s.id, { steps: [steps[0], { ...steps[1], day: 4 }] });
    const after = await enrollment(s.id, c.id);
    expect(Math.round((after.nextRunAt.getTime() - after.enrolledAt.getTime()) / DAY)).toBe(4);
    const actions = (await prisma.auditEvent.findMany({ where: { organizationId: ORG, entityId: s.id } })).map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['drip.created', 'drip.activated', 'drip.enrolled', 'drip.updated']));
  });
});
