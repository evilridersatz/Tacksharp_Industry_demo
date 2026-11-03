/**
 * Visual Workflow Studio engine, DB-backed (real MySQL TEST database + Redis lock; WhatsApp sender and telephony are
 * fakes). Proves: validation (per-step errors, foreign drip refused), versioning; triggers start only after
 * activation and once per record (lead, completed order, stage, needs a person, message keyword); a run goes through
 * WhatsApp (simulated in DRY_RUN), condition branches, stage / tag / task / hand-over / drip enrolment with real effects;
 * waits; opted-out customers are not messaged; paused workflows hold runs; a running run keeps its graph snapshot after
 * an edit; live sends with retry limit; an interrupted send is not repeated; test runs change nothing; stop; isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateGraph } from '../src/workflows/workflow-graph.js';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
}
const run = Date.now().toString(36);
const ORG = `org_wf_a_${run}`;
const ORG_B = `org_wf_b_${run}`;
let n = 0;

describe.skipIf(!enabled)('Visual Workflow Studio (integration)', () => {
  let prisma: any, svc: any, conversations: any, sender: any, telephony: any, drips: any, inbox: any, errors: any, outlet: any, agent: any;
  const actor = { sub: `wf-admin-${run}`, org: ORG };
  const later = (min: number) => new Date(Date.now() + min * 60_000);

  async function customer(org = ORG, extra: Record<string, unknown> = {}) {
    const phone = `9195${String(Date.now()).slice(-6)}${String(n++ % 100).padStart(2, '0')}`;
    const c = await conversations.getOrCreateCustomerByPhone(org, phone, { name: `Wf Cust ${n}` });
    return prisma.customer.update({ where: { id: c.id }, data: { messagingConsent: true, callingConsent: true, lastInboundAt: new Date(Date.now() - 3600_000), ...extra } });
  }
  async function workflow(graph: Record<string, unknown>, activate = true, org = ORG) {
    const w = await svc.create({ sub: actor.sub, org }, { name: `WF ${run} ${n++}`, graph });
    if (activate) await svc.setStatus({ sub: actor.sub, org }, w.id, 'active');
    await new Promise((r) => setTimeout(r, 20)); // records created after this are "after activation"
    return w;
  }
  const runsOf = (wfId: string) => prisma.workflowRun.findMany({ where: { workflowId: wfId }, orderBy: { createdAt: 'asc' } });
  async function drive(runId: string, at = later(1)) {
    const out: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await svc.execute(runId, at);
      out.push(r);
      if (r !== 'budget') break;
    }
    return out;
  }

  beforeAll(async () => {
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { OutreachService } = await import('../src/automation/outreach.service.js');
    const { DripService } = await import('../src/drip/drip.service.js');
    const { InboxService } = await import('../src/inbox/inbox.service.js');
    const { WorkflowsService } = await import('../src/workflows/workflows.service.js');
    errors = await import('../src/whatsapp/whatsapp-sender.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const id of [ORG, ORG_B]) await prisma.organization.create({ data: { id, name: `Org ${id}`, vertical: 'restaurant' } });
    agent = await prisma.user.create({ data: { organizationId: ORG, email: `wf-support-${run}@example.test`, name: 'Priya Support', passwordHash: 'x', role: 'support' } });
    outlet = await prisma.outlet.create({ data: { organizationId: ORG, name: 'WF outlet', address: 'Chennai' } });
    conversations = new ConversationsService(prisma);
    sender = { sendText: vi.fn(async () => `wamid.WF${n++}`), sendCampaignTemplate: vi.fn(async () => `wamid.WFT${n++}`) };
    telephony = { placeSystemCall: vi.fn(async () => ({ started: false, dryRun: true })) };
    const outreach = new OutreachService(prisma, conversations, sender, telephony);
    drips = new DripService(prisma, outreach);
    inbox = new InboxService(prisma, conversations, sender);
    svc = new WorkflowsService(prisma, outreach, drips, inbox);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    for (const org of [ORG, ORG_B]) {
      await prisma.workflow.deleteMany({ where: { organizationId: org } });
      await prisma.dripSequence.deleteMany({ where: { organizationId: org } });
      await prisma.workTask.deleteMany({ where: { organizationId: org } });
      await prisma.order.deleteMany({ where: { organizationId: org } });
    }
    await prisma.user.deleteMany({ where: { email: { contains: `-${run}@example.test` } } });
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
    await prisma.$disconnect();
  });

  it('validation per step, foreign drip refused, duplicate name, versions', async () => {
    await expect(svc.create(actor, { name: 'x', graph: { trigger: { type: 'nope' }, steps: [{ id: 'w', type: 'wait', minutes: -1 }] } })).rejects.toMatchObject({ response: { errors: { trigger: expect.any(String), w: expect.any(String) } } });
    const foreign = await drips.create({ sub: 'b', org: ORG_B }, { name: `B drip ${run}`, steps: [{ day: 0, channel: 'whatsapp', text: 'hi' }] });
    await expect(svc.create(actor, { name: 'y', graph: { trigger: { type: 'lead_created' }, steps: [{ id: 'd', type: 'enroll_drip', sequenceId: foreign.id }] } })).rejects.toMatchObject({ response: { errors: { d: expect.stringMatching(/does not exist/) } } });
    const w = await svc.create(actor, { name: `Dup ${run}`, graph: { trigger: { type: 'lead_created' }, steps: [{ type: 'ai_call' }] } });
    await expect(svc.create(actor, { name: `Dup ${run}`, graph: { trigger: { type: 'lead_created' }, steps: [{ type: 'ai_call' }] } })).rejects.toThrow(/already exists/);
    expect((await svc.update(actor, w.id, { graph: { trigger: { type: 'lead_created' }, steps: [{ type: 'add_tag', tag: 'x' }] } })).version).toBe(2);
    await expect(svc.detail(ORG_B, w.id)).rejects.toThrow(/not found/);
    await expect(svc.testRun({ sub: 'b', org: ORG_B }, w.id, {})).rejects.toThrow(/not found/);
  });

  it('lead trigger: only after activation, once per lead; full run with WhatsApp (DRY_RUN), branch, stage, tag, task, hand-over', async () => {
    const before = await customer();
    await prisma.lead.create({ data: { organizationId: ORG, customerId: before.id, source: 'whatsapp' } });
    const w = await workflow({
      trigger: { type: 'lead_created' },
      steps: [
        { id: 'hello', type: 'send_whatsapp', text: 'Hi {name}, thanks for contacting {business}!' },
        { id: 'chk', type: 'condition', field: 'trigger.channel', op: 'eq', value: 'whatsapp', yes: [{ id: 'stage', type: 'set_stage', stage: 'interested' }, { id: 'tag', type: 'add_tag', tag: 'wa lead' }], no: [{ id: 'never', type: 'add_tag', tag: 'other' }] },
        { id: 'task', type: 'create_task', title: 'Call this lead', dueInDays: 1 },
        { id: 'team', type: 'assign_team', reason: 'New WhatsApp lead' },
      ],
    });
    const c = await customer();
    const lead = await prisma.lead.create({ data: { organizationId: ORG, customerId: c.id, source: 'whatsapp' } });
    expect(await svc.collect(later(1))).toBeGreaterThanOrEqual(1);
    await svc.collect(later(1)); // idempotent
    const runs = await runsOf(w.id);
    expect(runs.map((r: any) => r.triggerKey)).toEqual([`lead:${lead.id}`]); // the lead from before activation never starts
    expect(await drive(runs[0].id)).toEqual(['completed']);
    const done = (await runsOf(w.id))[0];
    expect(done.status).toBe('completed');
    expect(done.log.map((l: any) => `${l.stepId}:${l.result}`)).toEqual(['hello:simulated', 'chk:yes', 'stage:done', 'tag:done', 'task:done', 'team:done']);
    const cust = await prisma.customer.findUnique({ where: { id: c.id } });
    expect(cust).toMatchObject({ stage: 'interested', tags: ['wa lead'] });
    expect(await prisma.workTask.count({ where: { organizationId: ORG, entityId: c.id, agent: 'workflow' } })).toBe(1);
    const conv = await prisma.conversation.findFirst({ where: { organizationId: ORG, customerId: c.id } });
    expect(conv).toMatchObject({ aiEnabled: false, inboxStatus: 'open', priority: 'high', handoffReason: 'New WhatsApp lead', assigneeId: agent.id });
    const msg = await prisma.message.findFirst({ where: { conversationId: conv.id, role: 'assistant' } });
    expect(msg.content).toBe(`Hi Wf, thanks for contacting Org ${ORG}!`);
    expect(msg.metadata).toMatchObject({ simulated: true, workflow: { workflowId: w.id, stepId: 'hello' } });
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('waits; paused workflows hold runs; a run keeps its graph snapshot after an edit; opted-out customers are not messaged', async () => {
    const w = await workflow({ trigger: { type: 'stage_reached', stage: 'qualified' }, steps: [{ id: 'w1', type: 'wait', minutes: 60 }, { id: 'msg', type: 'send_whatsapp', text: 'Ready to book?' }, { id: 'tag', type: 'add_tag', tag: 'nudged' }] });
    const c = await customer(ORG, { stage: 'qualified' });
    const out = await customer(ORG, { stage: 'qualified' });
    await svc.collect(later(1));
    const all = await runsOf(w.id);
    const r1 = all.find((r: any) => r.customerId === c.id);
    const r2 = all.find((r: any) => r.customerId === out.id);
    expect(await svc.execute(r1.id, later(1))).toBe('waiting');
    expect(await svc.execute(r2.id, later(1))).toBe('waiting');
    expect(await svc.execute(r1.id, later(30))).toBe('not_due');
    // Edit: the new version drops the message; running runs keep their snapshot.
    expect((await svc.update(actor, w.id, { graph: { trigger: { type: 'stage_reached', stage: 'qualified' }, steps: [{ id: 'only', type: 'add_tag', tag: 'v2' }] } })).version).toBe(2);
    await svc.setStatus(actor, w.id, 'paused');
    expect(await svc.execute(r1.id, later(90))).toBe('not_due');
    expect((await svc.tick(later(90))).executed).toBe(0);
    await svc.setStatus(actor, w.id, 'active');
    await prisma.customer.update({ where: { id: out.id }, data: { optedOutAt: new Date() } });
    expect(await drive(r1.id, later(90))).toEqual(['completed']);
    expect(await drive(r2.id, later(90))).toEqual(['completed']);
    const a = (await prisma.workflowRun.findUnique({ where: { id: r1.id } })).log.map((l: any) => `${l.stepId}:${l.result}`);
    expect(a).toEqual(['w1:waiting', 'w1:done', 'msg:simulated', 'tag:done']);
    const b = (await prisma.workflowRun.findUnique({ where: { id: r2.id } })).log;
    expect(b.find((l: any) => l.stepId === 'msg')).toMatchObject({ result: 'skipped', detail: expect.stringMatching(/opted out/) });
    expect((await prisma.customer.findUnique({ where: { id: c.id } })).tags).toEqual(['nudged']);
    // Re-activating starts from now: the same customer does not start the workflow twice for the same stage.
    await svc.collect(later(91));
    expect((await runsOf(w.id)).length).toBe(2);
  });

  it('order trigger with an order-total condition, keyword and needs-a-person triggers, drip enrolment, AI call', async () => {
    const seq = await drips.create(actor, { name: `WF drip ${run}`, steps: [{ day: 0, channel: 'whatsapp', text: 'hi' }] });
    const w = await workflow({ trigger: { type: 'order_completed' }, steps: [{ id: 'big', type: 'condition', field: 'order.total', op: 'gt', value: '500', yes: [{ id: 'vip', type: 'add_tag', tag: 'big spender' }, { id: 'drip', type: 'enroll_drip', sequenceId: seq.id }], no: [{ id: 'small', type: 'add_tag', tag: 'small' }] }] });
    const c = await customer();
    const o = await prisma.order.create({ data: { organizationId: ORG, orderNumber: `GR-${run}-${n++}`, customerId: c.id, outletId: outlet.id, channel: 'whatsapp', status: 'completed', pickupAt: new Date(), subtotal: 640, total: 640, paymentMethod: 'cash', idempotencyKey: `wf-${run}-${n}` } });
    await svc.collect(later(1));
    const [r] = await runsOf(w.id);
    expect(r.triggerKey).toBe(`order:${o.id}`);
    await drive(r.id);
    expect((await prisma.workflowRun.findUnique({ where: { id: r.id } })).log.map((l: any) => `${l.stepId}:${l.result}`)).toEqual(['big:yes', 'vip:done', 'drip:done']);
    expect(await prisma.dripEnrollment.count({ where: { sequenceId: seq.id, customerId: c.id } })).toBe(1);

    const kw = await workflow({ trigger: { type: 'message_keyword', keywords: ['Refund'] }, steps: [{ id: 'call', type: 'ai_call' }] });
    const k = await customer();
    const conv = await conversations.getOrCreateConversation({ organizationId: ORG, channel: 'whatsapp', externalId: k.phone, customerId: k.id });
    await conversations.addMessage({ organizationId: ORG, conversationId: conv.id, role: 'user', content: 'I want a REFUND please' });
    await conversations.addMessage({ organizationId: ORG, conversationId: conv.id, role: 'assistant', content: 'refund policy...' });
    await svc.collect(later(1));
    const kr = await runsOf(kw.id);
    expect(kr).toHaveLength(1);
    await drive(kr[0].id);
    expect((await prisma.workflowRun.findUnique({ where: { id: kr[0].id } })).log[0]).toMatchObject({ stepId: 'call', result: 'simulated' });
    expect(telephony.placeSystemCall).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, customerId: k.id, purpose: 'workflow', idempotencyKey: `${kr[0].id}-call` }));

    const hw = await workflow({ trigger: { type: 'needs_human' }, steps: [{ id: 't', type: 'create_task', title: 'Answer the handed-over chat' }] });
    await prisma.conversation.update({ where: { id: conv.id }, data: { status: 'human_handoff', handoffAt: new Date() } });
    await svc.collect(later(1));
    expect((await runsOf(hw.id)).map((r: any) => r.triggerKey)).toEqual([expect.stringMatching(new RegExp(`^handoff:${conv.id}:`))]);
  });

  it('live: sends once; temporary failures retry 3 times then fail; an interrupted send is never repeated', async () => {
    const prev = { dry: process.env.DRY_RUN, live: process.env.LIVE_TEST_RECIPIENTS };
    try {
      const w = await workflow({ trigger: { type: 'lead_created' }, steps: [{ id: 'm', type: 'send_whatsapp', text: 'Hello {name}' }, { id: 'tag', type: 'add_tag', tag: 'after' }] });
      const [ok, flaky, crashed] = [await customer(), await customer(), await customer()];
      process.env.DRY_RUN = 'false';
      process.env.LIVE_TEST_RECIPIENTS = [ok, flaky, crashed].map((c: any) => c.phone).join(',');
      for (const c of [ok, flaky, crashed]) await prisma.lead.create({ data: { organizationId: ORG, customerId: c.id, source: 'web' } });
      await svc.collect(later(1));
      const runs = await runsOf(w.id);
      const byCustomer = (id: string) => runs.find((r: any) => r.customerId === id);

      sender.sendText.mockClear();
      expect(await drive(byCustomer(ok.id).id)).toEqual(['completed']);
      expect(sender.sendText).toHaveBeenCalledTimes(1);
      expect(sender.sendText).toHaveBeenCalledWith(ok.phone, 'Hello Wf');

      sender.sendText.mockImplementation(async () => { throw new errors.WhatsAppTransientError('WhatsApp API 503'); });
      const fid = byCustomer(flaky.id).id;
      let at = later(1);
      const tries: string[] = [];
      for (let i = 0; i < 4; i++) { tries.push(await svc.execute(fid, at)); at = new Date(at.getTime() + 2 * 3600_000); }
      expect(tries).toEqual(['retry', 'retry', 'retry', 'completed']);
      expect((await prisma.workflowRun.findUnique({ where: { id: fid } })).log.filter((l: any) => l.stepId === 'm').at(-1)).toMatchObject({ result: 'failed', detail: expect.stringMatching(/Gave up after 4/) });

      sender.sendText.mockReset();
      sender.sendText.mockImplementation(async () => `wamid.WF${n++}`);
      const cid = byCustomer(crashed.id).id;
      await prisma.workflowRun.update({ where: { id: cid }, data: { context: { inflight: '0' } } });
      expect(await drive(cid)).toEqual(['completed']);
      expect(sender.sendText).not.toHaveBeenCalled();
      expect((await prisma.workflowRun.findUnique({ where: { id: cid } })).log[0]).toMatchObject({ stepId: 'm', result: 'failed', detail: expect.stringMatching(/not repeated/) });
    } finally {
      process.env.DRY_RUN = prev.dry ?? 'true';
      if (prev.live === undefined) delete process.env.LIVE_TEST_RECIPIENTS; else process.env.LIVE_TEST_RECIPIENTS = prev.live;
      sender.sendText.mockReset();
      sender.sendText.mockImplementation(async () => `wamid.WF${n++}`);
    }
  });

  it('test run: real facts, nothing sent or changed, waits skipped; stop a run', async () => {
    const w = await workflow({ trigger: { type: 'lead_created' }, steps: [{ id: 'w', type: 'wait', minutes: 1440 }, { id: 'm', type: 'send_whatsapp', text: 'Hi {name}' }, { id: 'st', type: 'set_stage', stage: 'qualified' }, { id: 'c', type: 'ai_call' }] }, false);
    const c = await customer();
    const out = await customer(ORG, { optedOutAt: new Date() });
    const r = await svc.testRun(actor, w.id, { customerId: c.id });
    expect(r).toMatchObject({ status: 'completed', test: true });
    expect(r.log.map((l: any) => `${l.stepId}:${l.result}`)).toEqual(['w:skipped', 'm:would_send', 'st:would_change', 'c:would_send']);
    expect(r.log[1].detail).toContain('Hi Wf');
    expect((await prisma.customer.findUnique({ where: { id: c.id } })).stage).toBeNull();
    expect(await prisma.message.count({ where: { Conversation: { customerId: c.id } } })).toBe(0);
    const r2 = await svc.testRun(actor, w.id, { customerId: out.id });
    expect(r2.log.find((l: any) => l.stepId === 'm')).toMatchObject({ result: 'would_skip', detail: expect.stringMatching(/opted out/) });
    await expect(svc.testRun(actor, w.id, { customerId: (await customer(ORG_B)).id })).rejects.toThrow(/Choose a customer/);

    await svc.setStatus(actor, w.id, 'active');
    const l = await customer();
    await prisma.lead.create({ data: { organizationId: ORG, customerId: l.id } });
    await svc.collect(later(1));
    const live = (await runsOf(w.id)).find((x: any) => !x.test);
    expect(await svc.execute(live.id, later(1))).toBe('waiting');
    expect((await svc.stopRun(actor, live.id)).status).toBe('stopped');
    expect(await svc.execute(live.id, later(2000))).toBe('not_runnable');
    await expect(svc.stopRun({ sub: 'b', org: ORG_B }, live.id)).rejects.toThrow(/not found/);
    const d = await svc.detail(ORG, w.id);
    expect(d.runs.some((x: any) => x.test)).toBe(true);
    expect(d.runs.find((x: any) => x.id === live.id).customer.name).toMatch(/Wf Cust/);
  });

  it('tag added trigger: fires once per newly added tag (CRM edit, a workflow step), not for tags already there', async () => {
    expect(validateGraph({ trigger: { type: 'tag_added' }, steps: [{ id: 'a', type: 'add_tag', tag: 'x' }] }).errors.trigger).toMatch(/tag/);
    const { CustomersService } = await import('../src/customers/customers.service.js');
    const crm = new CustomersService(prisma);
    const had = await customer(ORG, { tags: ['vip'] });
    const w = await workflow({ trigger: { type: 'tag_added', tag: 'VIP' }, steps: [{ id: 't', type: 'add_tag', tag: 'vip_welcomed' }] });
    expect(w.graph.trigger.tag).toBe('vip');
    // Already tagged before: editing something else does not start it.
    await crm.update(ORG, actor, had.id, { name: 'Renamed VIP' });
    const fresh = await customer();
    await crm.update(ORG, actor, fresh.id, { tags: ['VIP', 'wedding'] });
    await crm.update(ORG, actor, fresh.id, { tags: ['vip', 'wedding', 'gold'] }); // vip kept: not "added" again
    await svc.collect(later(0));
    await svc.collect(later(0)); // a second sweep starts nothing new
    let runs = await runsOf(w.id);
    expect(runs.map((r: any) => r.customerId)).toEqual([fresh.id]);
    await drive(runs[0].id);
    expect((await prisma.customer.findUnique({ where: { id: fresh.id } })).tags).toEqual(['vip', 'wedding', 'gold', 'vip_welcomed']);
    // A workflow adding the tag also counts (and another organization's tag events never start this workflow).
    const chained = await customer();
    const tagger = await workflow({ trigger: { type: 'stage_reached', stage: 'qualified' }, steps: [{ id: 'tv', type: 'add_tag', tag: 'vip' }] });
    await prisma.customer.update({ where: { id: chained.id }, data: { stage: 'qualified' } });
    await svc.collect(later(0));
    await drive((await runsOf(tagger.id))[0].id);
    const foreign = await customer(ORG_B);
    await crm.update(ORG_B, { sub: 'b', org: ORG_B }, foreign.id, { tags: ['vip'] });
    await svc.collect(later(0));
    runs = await runsOf(w.id);
    expect(runs.map((r: any) => r.customerId).sort()).toEqual([fresh.id, chained.id].sort());
  });
});

