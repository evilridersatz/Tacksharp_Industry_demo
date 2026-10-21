/**
 * Tacksharp VisionOps (CCTV health & downtime monitoring) against the real MySQL test database.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/visionops.integration.spec.ts
 *
 * FAKE: nothing is sent (DRY_RUN=true): WhatsApp messages become SIMULATED notification attempts. No device is
 * contacted except a local TCP server for the cloud-check test. No model is used anywhere (AI-disabled operation).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const VO = 'org_vo_test';
const VO2 = 'org_vo_other';
const ORGS = [VO, VO2];
const T0 = Date.parse('2026-10-19T06:00:00Z'); // 11:30 IST, outside quiet hours
const min = (m: number) => new Date(T0 + m * 60_000);
let seq = 0;

describe.skipIf(!enabled)('VisionOps CCTV monitoring (integration)', () => {
  let prisma: any, settings: any, incidents: any, notifier: any, engine: any, svc: any, tech: any, ai: any, auth: any, rules: any, perms: any;
  let customerId: string, otherCustomerId: string;
  const people: Record<string, string> = {};

  async function wipe() {
    const where = { organizationId: { in: ORGS } };
    await prisma.incidentTimelineEvent.deleteMany({ where });
    await prisma.notificationAttempt.deleteMany({ where });
    await prisma.downtimeIncident.deleteMany({ where });
    await prisma.healthEvent.deleteMany({ where });
    await prisma.agentHeartbeat.deleteMany({ where });
    await prisma.monitoringAgent.deleteMany({ where });
    await prisma.cameraDevice.deleteMany({ where });
    await prisma.recorderDevice.deleteMany({ where });
    await prisma.siteTechnician.deleteMany({ where });
    await prisma.serviceContract.deleteMany({ where });
    await prisma.siteUptimeSnapshot.deleteMany({ where });
    await prisma.monitoringSite.deleteMany({ where });
    await prisma.monitoringCustomer.deleteMany({ where });
    await prisma.message.deleteMany({ where });
    await prisma.conversation.deleteMany({ where });
    await prisma.lead.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
  }

  /** One site with an NVR, N cameras behind it (+ one standalone camera with stream / recording checks) and an agent. */
  async function makeSite(label: string, opts: { cameras?: number; org?: string; customer?: string; mode?: string } = {}) {
    const org = opts.org ?? VO;
    const k = ++seq;
    const site = await prisma.monitoringSite.create({ data: { organizationId: org, customerId: opts.customer ?? customerId, code: `S${k}`, name: `${label} ${k}`, city: 'Chennai', monitoringMode: opts.mode ?? 'local_agent' } });
    const nvr = await prisma.recorderDevice.create({ data: { organizationId: org, siteId: site.id, code: `NVR-${k}`, name: 'NVR', capabilities: { reachability: true, storage: true }, networkAddress: '192.168.1.10' } });
    const cams = [];
    for (let i = 1; i <= (opts.cameras ?? 3); i++) cams.push(await prisma.cameraDevice.create({ data: { organizationId: org, siteId: site.id, recorderId: nvr.id, code: `CAM-${k}-${i}`, name: `Camera ${i}`, capabilities: { reachability: true }, critical: i === 1, networkAddress: `192.168.1.${20 + i}` } }));
    const solo = await prisma.cameraDevice.create({ data: { organizationId: org, siteId: site.id, code: `CAM-${k}-X`, name: 'Gate camera', capabilities: { reachability: true, stream: true, recording: true } } });
    const reg = await svc.registerAgent(org, { siteId: site.id, code: `AGT-${k}`, hasBackupLink: false });
    return { site, nvr, cams, solo, agent: reg.agent, token: reg.token };
  }

  const ev = (device: string | undefined, ok: boolean, at: Date, check = 'reachability', id = `e${++seq}`) => ({ eventId: id, device, check, ok, observedAt: at.toISOString() });
  const send = (s: any, events: any[], now?: Date, org = VO) => engine.ingest(org, s.site.id, { source: 'agent', agentId: s.agent.id, agentCode: s.agent.code }, events, now ?? new Date(new Date(events[events.length - 1].observedAt).getTime() + 5000));
  const fail3 = async (s: any, code: string, from: number, check = 'reachability') => {
    for (const m of [from, from + 1, from + 2]) await send(s, [ev(code, false, min(m), check)]);
  };
  const ok = async (s: any, code: string, ms: number[], check = 'reachability') => {
    for (const m of ms) await send(s, [ev(code, true, min(m), check)]);
  };
  const openFor = (deviceId: string) => prisma.downtimeIncident.findMany({ where: { organizationId: VO, deviceId } });

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    rules = await import('../src/visionops/rules.js');
    auth = await import('../src/visionops/agent-auth.js');
    perms = await import('../src/governance/permissions.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { MonitoringNotifier } = await import('../src/visionops/notifier.service.js');
    const { IncidentsService } = await import('../src/visionops/incidents.service.js');
    const { MonitoringEngine } = await import('../src/visionops/engine.service.js');
    const { MonitoringService } = await import('../src/visionops/monitoring.service.js');
    const { TechnicianAssistant } = await import('../src/visionops/technician-assistant.service.js');
    const { AiService } = await import('../src/ai/ai.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, name] of [[VO, 'VO Secure Systems'], [VO2, 'VO Other Integrator']] as const) await prisma.organization.upsert({ where: { id }, update: { name, vertical: 'real_estate' }, create: { id, name, vertical: 'real_estate' } });
    await wipe();
    settings = new SettingsService(prisma);
    for (const o of ORGS) await settings.update(o, { industry: 'cctv', monitoring: { failureThreshold: 3, debounceSeconds: 120, restoreSuccesses: 3, staleAfterMinutes: 10, correlationWindowMinutes: 30, ackDeadlineMinutes: 15, escalationStepMinutes: 30, quietHours: { enabled: false, start: '22:00', end: '07:00' }, notifyCustomerOnResolution: true, whatsappCostInr: 0.12 } });
    notifier = new MonitoringNotifier(prisma, settings, undefined);
    incidents = new IncidentsService(prisma, settings, notifier);
    engine = new MonitoringEngine(prisma, settings, incidents, notifier);
    svc = new MonitoringService(prisma, settings);
    const conversations = new ConversationsService(prisma);
    tech = new TechnicianAssistant(prisma, conversations, incidents);
    ai = new AiService({ generate: async () => ({ response: 'RE ENGINE' }) } as any, { vertical: async () => 'real_estate' } as any, {} as any, settings, undefined, tech);

    customerId = (await svc.createCustomer(VO, { name: 'Chennai Warehousing Ltd', industry: 'warehouse', contactName: 'Mr Rao', contactPhone: '919900000001', notifyOnResolution: true })).id;
    otherCustomerId = (await svc.createCustomer(VO2, { name: 'Other Co', industry: 'retail' })).id;
    people.ravi = (await prisma.siteTechnician.create({ data: { organizationId: VO, name: 'Ravi', phone: '919900000011', role: 'technician' } })).id;
    people.priya = (await prisma.siteTechnician.create({ data: { organizationId: VO, name: 'Priya', phone: '919900000012', role: 'supervisor' } })).id;
    people.kumar = (await prisma.siteTechnician.create({ data: { organizationId: VO, name: 'Kumar', phone: '919900000013', role: 'manager' } })).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.$disconnect();
  });

  it('vertical slice: debounce → ONE incident → simulated WhatsApp → technician ACK → evidence-based restoration → customer report', async () => {
    const s = await makeSite('Chennai Warehouse');
    const cam = s.cams[1]; // not critical
    // Two failures: not confirmed yet (debounce), camera is "degraded", no incident.
    await send(s, [ev(cam.code, false, min(0))]);
    await send(s, [ev(cam.code, false, min(1))]);
    expect((await prisma.cameraDevice.findUnique({ where: { id: cam.id } })).status).toBe('degraded');
    expect(await openFor(cam.id)).toHaveLength(0);
    // Third failure 2 minutes after the first: confirmed.
    const r = await send(s, [ev(cam.code, false, min(2))]);
    expect(r.outcomes.created).toBe(1);
    let [inc] = await openFor(cam.id);
    expect(inc).toMatchObject({ status: 'OPEN', category: 'camera_unreachable', severity: 'medium', deviceCode: cam.code });
    expect((await prisma.cameraDevice.findUnique({ where: { id: cam.id } })).status).toBe('offline');
    const alert = await prisma.notificationAttempt.findFirst({ where: { incidentId: inc.id, purpose: 'alert' } });
    expect(alert).toMatchObject({ status: 'simulated', simulated: true, recipientName: 'Ravi', channel: 'whatsapp' });
    expect(alert.body).toMatch(new RegExp(`Camera ${cam.code} at Chennai Warehouse \\d+ has been unreachable for 2 minutes\\. Incident ${inc.number} is open`));
    expect(Number(alert.costEstimate)).toBe(0.12);

    // Repeated failures and a replayed batch: still one incident, no new alert.
    await send(s, [ev(cam.code, false, min(3)), ev(cam.code, false, min(4))]);
    const replay = await send(s, [ev(cam.code, false, min(3), 'reachability', 'dup-1'), ev(cam.code, false, min(3), 'reachability', 'dup-1')]);
    expect(replay.duplicates).toBe(1);
    expect(await openFor(cam.id)).toHaveLength(1);
    expect(await prisma.notificationAttempt.count({ where: { incidentId: inc.id, purpose: 'alert' } })).toBe(1);

    // Technician acknowledges on WhatsApp (through the AI entry point; rules only).
    const ack = await ai.generateResponse({ organizationId: VO, channel: 'whatsapp', phone: '919900000011', message: 'ack' });
    expect(ack.response).toBe(`${inc.number} acknowledged. Assigned to Ravi. Status: investigating. Reply "HELP ${inc.number}" for first checks.`);
    inc = await prisma.downtimeIncident.findUnique({ where: { id: inc.id } });
    expect(inc).toMatchObject({ status: 'ASSIGNED', assignedTechnicianId: people.ravi, acknowledgedBy: 'technician:Ravi', nextEscalationAt: null });
    const help = await tech.generate({ organizationId: VO, channel: 'whatsapp', phone: '919900000011', message: `HELP ${inc.number}` });
    expect(help.response).toMatch(/Check the camera power/);
    expect(help.response).toMatch(/cannot control the device remotely/);

    // "Fixed" while the camera still fails: NOT resolved, waits for evidence.
    const fixed = await tech.generate({ organizationId: VO, channel: 'whatsapp', phone: '919900000011', message: `fixed ${inc.number} loose PoE cable`, }, min(5));
    expect(fixed.response).toMatch(/after 3 more successful monitoring check/);
    inc = await prisma.downtimeIncident.findUnique({ where: { id: inc.id } });
    expect(inc.status).toBe('RESTORATION_CHECK');
    expect(inc.rootCause).toBe('loose PoE cable');

    // Two successes, then a failure: the restoration check resets.
    await ok(s, cam.code, [6, 7]);
    expect((await prisma.downtimeIncident.findUnique({ where: { id: inc.id } })).status).toBe('RESTORATION_CHECK');
    await send(s, [ev(cam.code, false, min(8))]);
    expect((await prisma.downtimeIncident.findUnique({ where: { id: inc.id } })).status).toBe('ASSIGNED');

    // Three consecutive successes: resolved by verification, with the evidence.
    await ok(s, cam.code, [9, 10, 11]);
    inc = await prisma.downtimeIncident.findUnique({ where: { id: inc.id } });
    expect(inc).toMatchObject({ status: 'RESOLVED', resolvedBy: 'verification', openKey: null });
    expect(inc.restorationEvidence).toHaveLength(3);
    const restored = await prisma.notificationAttempt.findFirst({ where: { incidentId: inc.id, purpose: 'restored' } });
    expect(restored.body).toBe(`${cam.code} is responding again. Restoration of ${inc.number} was verified by 3 consecutive successful checks. Incident duration: 11 minutes.`);
    const report = await prisma.notificationAttempt.findFirst({ where: { incidentId: inc.id, purpose: 'customer_report' } });
    expect(report).toMatchObject({ recipientType: 'customer', status: 'simulated' });
    expect(report.body).toMatch(/Cause: loose PoE cable/);
    const types = (await prisma.incidentTimelineEvent.findMany({ where: { incidentId: inc.id }, orderBy: { at: 'asc' } })).map((t: any) => t.type);
    expect(types).toEqual(expect.arrayContaining(['detected', 'notified', 'acknowledged', 'assigned', 'troubleshooting', 'restoration_check', 'resolved', 'customer_notified']));

    // Dashboard read model shows it.
    const ov = await svc.overview(VO, { siteId: s.site.id, days: 1 }, min(12));
    expect(ov.kpis).toMatchObject({ cameras: 4, activeIncidents: 0, mttaMinutes: expect.any(Number) });
    const page = await svc.cameras(VO, { siteId: s.site.id });
    expect(page.rows.find((c: any) => c.code === cam.code).networkAddress).toBe('192.168.•.22');
    // Closing needs RESOLVED; it then stays closed.
    await incidents.close(VO, inc.id, 'user:test', min(13), 'Checked with customer');
    expect((await prisma.downtimeIncident.findUnique({ where: { id: inc.id } })).status).toBe('CLOSED');
  });

  it('AI disabled: with no LLM credentials and an LLM engine that would fail, monitoring, alerts and technician replies still work', async () => {
    const saved = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    try {
      const { AiService } = await import('../src/ai/ai.service.js');
      const noLlm = new AiService({ generate: async () => { throw new Error('LLM must not be called'); } } as any, { vertical: async () => 'real_estate' } as any, {} as any, settings, undefined, tech);
      const s = await makeSite('No AI Depot');
      const cam = s.cams[2];
      await fail3(s, cam.code, 100);
      const [inc] = await openFor(cam.id);
      expect(inc).toMatchObject({ status: 'OPEN', category: 'camera_unreachable' });
      expect(await prisma.notificationAttempt.findFirst({ where: { incidentId: inc.id, purpose: 'alert' } })).toMatchObject({ status: 'simulated', simulated: true });
      const ack = await noLlm.generateResponse({ organizationId: VO, channel: 'whatsapp', phone: '919900000011', message: `ack ${inc.number}` });
      expect(ack.response).toMatch(new RegExp(`${inc.number} acknowledged`));
      await ok(s, cam.code, [104, 105, 106]);
      expect(await prisma.downtimeIncident.findUnique({ where: { id: inc.id } })).toMatchObject({ status: 'RESOLVED', resolvedBy: 'verification' });
      // Camera list sorting is whitelisted; an unknown sort falls back to site/code order.
      const worst = await svc.cameras(VO, { siteId: s.site.id, sort: 'status' });
      expect(worst.rows.map((c: any) => c.code)).toHaveLength(4);
      const bogus = await svc.cameras(VO, { siteId: s.site.id, sort: 'password; DROP' });
      expect(bogus.rows.map((c: any) => c.code)).toEqual([...bogus.rows.map((c: any) => c.code)].sort());
    } finally {
      if (saved.key !== undefined) process.env.OPENAI_API_KEY = saved.key;
      if (saved.base !== undefined) process.env.OPENAI_BASE_URL = saved.base;
    }
  });

  it('intermittent connectivity (alternating results) never opens an incident; a blip is not an outage', async () => {
    const s = await makeSite('Flaky');
    const code = s.cams[2].code;
    for (let m = 0; m < 12; m++) await send(s, [ev(code, m % 2 === 0, min(m))]);
    expect(await openFor(s.cams[2].id)).toHaveLength(0);
    expect(['online', 'degraded']).toContain((await prisma.cameraDevice.findUnique({ where: { id: s.cams[2].id } })).status);
  });

  it('whole NVR offline: one critical recorder incident covering its cameras; camera faults are merged / folded', async () => {
    const s = await makeSite('Mall');
    await fail3(s, s.cams[0].code, 0); // CAM-…-1 critical camera fails first
    const [camInc] = await openFor(s.cams[0].id);
    expect(camInc.severity).toBe('high');
    await fail3(s, s.nvr.code, 1);
    const rec = await prisma.downtimeIncident.findFirst({ where: { organizationId: VO, deviceId: s.nvr.id } });
    expect(rec).toMatchObject({ category: 'recorder_unreachable', severity: 'critical', affectedCount: 3 });
    expect(await prisma.downtimeIncident.findUnique({ where: { id: camInc.id } })).toMatchObject({ status: 'CLOSED', resolvedBy: 'correlation' });
    const folded = await fail3(s, s.cams[1].code, 4);
    expect(folded).toBeUndefined();
    expect(await openFor(s.cams[1].id)).toHaveLength(0);
    // Camera offline while the DVR stays reachable is its own incident (other site).
    const s2 = await makeSite('Office');
    await ok(s2, s2.nvr.code, [0, 1, 2, 3]);
    await fail3(s2, s2.cams[1].code, 1);
    expect(await openFor(s2.cams[1].id)).toHaveLength(1);
  });

  it('NVR and its cameras fail together: ONE recorder incident and ONE alert, no per-camera incidents (no alert storm)', async () => {
    const s = await makeSite('Storm', { cameras: 5 });
    for (const m of [0, 1, 2, 3]) {
      // Cameras reported before the recorder in each batch (older observedAt): they must still wait for it.
      await send(s, [...s.cams.map((c: any) => ev(c.code, false, new Date(min(m).getTime() - 2000))), ev(s.nvr.code, false, min(m))]);
    }
    const incs = await prisma.downtimeIncident.findMany({ where: { organizationId: VO, siteId: s.site.id } });
    expect(incs.map((i: any) => i.category)).toEqual(['recorder_unreachable']);
    expect(incs[0]).toMatchObject({ affectedCount: 5, severity: 'critical' });
    expect(await prisma.notificationAttempt.count({ where: { organizationId: VO, incident: { siteId: s.site.id }, purpose: 'alert' } })).toBe(1);
    expect(await prisma.cameraDevice.count({ where: { siteId: s.site.id, recorderId: s.nvr.id, status: 'offline' } })).toBe(5);
  });

  it('the same fault inside the correlation window reopens the incident instead of opening a new one', async () => {
    const s = await makeSite('Reopen');
    const code = s.cams[1].code;
    await fail3(s, code, 0);
    await ok(s, code, [3, 4, 5]);
    const [inc] = await openFor(s.cams[1].id);
    expect(inc.status).toBe('RESOLVED');
    await fail3(s, code, 15);
    const all = await openFor(s.cams[1].id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'OPEN', reopenCount: 1 });
    // Outside the window: a new incident.
    await ok(s, code, [18, 19, 20]);
    await fail3(s, code, 60);
    expect(await openFor(s.cams[1].id)).toHaveLength(2);
  });

  it('agent silent: devices UNKNOWN (not offline) + agent incident; reconnect replays the queue in order; internet outage is the root cause', async () => {
    const s = await makeSite('Remote Godown');
    await engine.heartbeat(VO, s.agent.id, { sentAt: min(0).toISOString(), queueDepth: 0 }, min(0));
    await ok(s, s.cams[0].code, [0]);
    const sweep = await engine.sweep(VO, min(12));
    expect(sweep.agentsOffline).toBe(1);
    expect((await prisma.cameraDevice.findUnique({ where: { id: s.cams[0].id } })).status).toBe('unknown');
    expect((await prisma.monitoringSite.findUnique({ where: { id: s.site.id } })).internetStatus).toBe('suspected_outage');
    const agentInc = await prisma.downtimeIncident.findFirst({ where: { organizationId: VO, deviceId: s.agent.id } });
    expect(agentInc).toMatchObject({ category: 'agent_offline', severity: 'high', status: 'OPEN' });
    const alert = await prisma.notificationAttempt.findFirst({ where: { incidentId: agentInc.id } });
    expect(alert.body).toMatch(/Camera states are UNKNOWN \(not confirmed offline\)/);
    // No duplicate on the next sweep.
    await engine.sweep(VO, min(13));
    expect(await prisma.downtimeIncident.count({ where: { organizationId: VO, deviceId: s.agent.id } })).toBe(1);

    // Back online at minute 30: the agent flushes events it queued locally during the outage (sent out of order).
    const queued = [ev(s.cams[0].code, true, min(20)), ev(s.cams[0].code, true, min(5)), ev(s.cams[1].code, true, min(10))];
    const res = await send(s, queued, min(30));
    expect(res).toMatchObject({ accepted: 3, replayed: 3 });
    expect((await prisma.cameraDevice.findUnique({ where: { id: s.cams[0].id } })).lastSeenAt.toISOString()).toBe(min(20).toISOString());
    for (const m of [30, 31, 32]) await engine.heartbeat(VO, s.agent.id, { sentAt: min(m).toISOString(), queueDepth: 0 }, min(m));
    const done = await prisma.downtimeIncident.findUnique({ where: { id: agentInc.id } });
    expect(done).toMatchObject({ status: 'RESOLVED', resolvedBy: 'verification' });
    expect(done.rootCause).toMatch(/^Site internet outage: the local agent kept monitoring and synced 3 queued events/);
  });

  it('agent with a 4G backup reports "broadband down": internet-outage incident while monitoring continues; cleared when it returns', async () => {
    const s = await makeSite('Backup Link');
    await engine.heartbeat(VO, s.agent.id, { sentAt: min(0).toISOString(), queueDepth: 0, link: 'backup_4g' }, min(0));
    expect((await prisma.monitoringSite.findUnique({ where: { id: s.site.id } })).internetStatus).toBe('backup_link');
    await send(s, [ev(undefined, false, min(0), 'internet')]);
    const inc = await prisma.downtimeIncident.findFirst({ where: { organizationId: VO, siteId: s.site.id, category: 'internet_outage' } });
    expect(inc.severity).toBe('medium');
    await send(s, [ev(undefined, true, min(5), 'internet'), ev(undefined, true, min(6), 'internet'), ev(undefined, true, min(7), 'internet')]);
    expect((await prisma.downtimeIncident.findUnique({ where: { id: inc.id } })).status).toBe('RESOLVED');
  });

  it('escalation: unacknowledged → supervisor (L1) after the deadline → manager (L2); acknowledgment stops it', async () => {
    const s = await makeSite('Escalation');
    await fail3(s, s.cams[1].code, 0);
    const [inc] = await openFor(s.cams[1].id);
    const esc = (where: Record<string, unknown> = {}) => prisma.notificationAttempt.findMany({ where: { incidentId: inc.id, purpose: 'escalation', ...where } });
    await notifier.escalateDue(VO, min(10));
    expect(await esc()).toHaveLength(0);
    await notifier.escalateDue(VO, min(18));
    expect(await esc()).toMatchObject([{ recipientName: 'Priya', recipientType: 'supervisor', status: 'simulated' }]);
    await notifier.escalateDue(VO, min(40));
    expect(await esc()).toHaveLength(1);
    await notifier.escalateDue(VO, min(49));
    expect(await esc({ recipientType: 'manager' })).toMatchObject([{ recipientName: 'Kumar' }]);
    await notifier.escalateDue(VO, min(200)); // L2 is the last level
    expect(await esc()).toHaveLength(2);
    expect((await prisma.downtimeIncident.findUnique({ where: { id: inc.id } })).escalationLevel).toBe(2);
    const s2 = await makeSite('Acked');
    await fail3(s2, s2.cams[1].code, 0);
    const [i2] = await openFor(s2.cams[1].id);
    await incidents.acknowledge(VO, i2.id, 'user:noc', min(5));
    await notifier.escalateDue(VO, min(30));
    expect(await prisma.notificationAttempt.count({ where: { incidentId: i2.id, purpose: 'escalation' } })).toBe(0);
  });

  it('quiet hours: a non-critical alert waits until the window ends; a critical one goes out', async () => {
    await settings.update(VO, { monitoring: { quietHours: { enabled: true, start: '11:00', end: '13:00' } } });
    try {
      const s = await makeSite('Quiet');
      await fail3(s, s.cams[1].code, 0); // medium
      const [inc] = await openFor(s.cams[1].id);
      const a = await prisma.notificationAttempt.findFirst({ where: { incidentId: inc.id, purpose: 'alert' } });
      expect(a.status).toBe('deferred');
      expect(a.scheduledFor.toISOString()).toBe('2026-10-19T07:30:00.000Z'); // 13:00 IST
      await fail3(s, s.nvr.code, 0); // critical
      const rec = await prisma.downtimeIncident.findFirst({ where: { organizationId: VO, deviceId: s.nvr.id } });
      expect((await prisma.notificationAttempt.findFirst({ where: { incidentId: rec.id, purpose: 'alert' } })).status).toBe('simulated');
    } finally {
      await settings.update(VO, { monitoring: { quietHours: { enabled: false, start: '22:00', end: '07:00' } } });
    }
  });

  it('capabilities: a ping never proves recording; unsupported checks are refused; recording / stream / storage incidents when supported', async () => {
    const s = await makeSite('Capabilities');
    await ok(s, s.cams[0].code, [0, 1, 2]);
    expect((await prisma.cameraDevice.findUnique({ where: { id: s.cams[0].id } })).recordingStatus).toBe('unsupported');
    const r = await send(s, [ev(s.cams[0].code, true, min(3), 'recording')]);
    expect(r.rejected[0].reason).toMatch(/does not support "recording"/);
    await ok(s, s.solo.code, [0, 1, 2]);
    await ok(s, s.solo.code, [3], 'recording');
    expect((await prisma.cameraDevice.findUnique({ where: { id: s.solo.id } })).recordingStatus).toBe('verified');
    await fail3(s, s.solo.code, 4, 'recording');
    await fail3(s, s.solo.code, 5, 'recording'); // needs a 2-minute span
    expect(await prisma.downtimeIncident.findFirst({ where: { organizationId: VO, deviceId: s.solo.id, category: 'recording_not_confirmed' } })).toMatchObject({ severity: 'high' });
    await fail3(s, s.solo.code, 4, 'stream');
    await fail3(s, s.solo.code, 6, 'stream');
    expect(await prisma.downtimeIncident.findFirst({ where: { organizationId: VO, deviceId: s.solo.id, category: 'stream_unavailable' } })).toBeTruthy();
    await fail3(s, s.nvr.code, 10, 'storage');
    expect(await prisma.downtimeIncident.findFirst({ where: { organizationId: VO, deviceId: s.nvr.id, category: 'storage_warning' } })).toMatchObject({ severity: 'medium' });
    // A failing recording stays "failing". Proof that simply gets old (2 h) becomes "not confirmed", without an incident.
    const s2 = await makeSite('Recording proof');
    await ok(s2, s2.solo.code, [0], 'recording');
    await engine.sweep(VO, min(200));
    expect((await prisma.cameraDevice.findUnique({ where: { id: s.solo.id } })).recordingStatus).toBe('failing');
    expect((await prisma.cameraDevice.findUnique({ where: { id: s2.solo.id } })).recordingStatus).toBe('not_confirmed');
    expect(await prisma.downtimeIncident.count({ where: { organizationId: VO, deviceId: s2.solo.id } })).toBe(0);
  });

  it('validation: bad events are rejected with reasons; credentials in details are scrubbed; addresses with credentials refused', async () => {
    const s = await makeSite('Validation');
    const r = await send(s, [
      { eventId: 'bad id!', device: s.cams[0].code, check: 'reachability', ok: true, observedAt: min(0).toISOString() },
      { eventId: 'x1', device: 'CAM-NOPE', check: 'reachability', ok: true, observedAt: min(0).toISOString() },
      { eventId: 'x2', device: s.cams[0].code, check: 'teleport', ok: true, observedAt: min(0).toISOString() },
      { eventId: 'x3', device: s.cams[0].code, check: 'reachability', ok: true, observedAt: min(30).toISOString() },
      { eventId: 'x4', device: s.cams[0].code, check: 'reachability', ok: false, observedAt: min(0).toISOString(), detail: 'rtsp://admin:secret@192.168.1.21/stream password=hunter2' },
    ], min(1));
    expect(r.accepted).toBe(1);
    expect(r.rejected.map((x: any) => x.reason)).toEqual(['invalid eventId', 'unknown device "CAM-NOPE" for this site', 'unknown check "teleport"', 'observedAt is in the future (check the agent clock)']);
    const stored = await prisma.healthEvent.findFirst({ where: { organizationId: VO, externalId: `${s.agent.code}:x4` } });
    expect(stored.detail).toBe('rtsp://[redacted] password=[redacted]');
    await expect(svc.createCamera(VO, { siteId: s.site.id, code: 'CAM-NEW', networkAddress: 'rtsp://admin:pw@10.0.0.5:554/h264' })).rejects.toThrow(/never stored in the cloud/);
  });

  it('agent auth: token found by prefix, secret checked by hash; wrong / revoked tokens refused; old heartbeats refused', async () => {
    const s = await makeSite('Auth');
    const parsed = auth.parseAgentToken(`Bearer ${s.token}`);
    const row = await prisma.monitoringAgent.findUnique({ where: { tokenPrefix: parsed.prefix } });
    expect(row.id).toBe(s.agent.id);
    expect(auth.secretMatches(parsed.secret, row.tokenHash)).toBe(true);
    expect(auth.secretMatches(`${parsed.secret}x`, row.tokenHash)).toBe(false);
    expect(row.tokenHash).not.toContain(parsed.secret);
    expect(auth.parseAgentToken('Bearer nope')).toBeUndefined();
    await expect(engine.heartbeat(VO, s.agent.id, { sentAt: new Date(Date.now() - 3_600_000).toISOString() })).rejects.toThrow(/more than 10 minutes/);
    const rotated = await svc.rotateAgent(VO, s.agent.id);
    expect(rotated.token).not.toBe(s.token);
    expect(await prisma.monitoringAgent.findUnique({ where: { tokenPrefix: parsed.prefix } })).toBeNull();
    await svc.revokeAgent(VO, s.agent.id);
    await expect(engine.heartbeat(VO, s.agent.id, {})).rejects.toThrow(/revoked/);
  });

  it('tenant isolation: another organization cannot read or act on these records; an agent only reports its own site', async () => {
    const mine = await makeSite('Mine');
    const theirs = await makeSite('Theirs', { org: VO2, customer: otherCustomerId });
    await fail3(mine, mine.cams[1].code, 0);
    const [inc] = await openFor(mine.cams[1].id);
    await expect(svc.incident(VO2, inc.id)).rejects.toThrow(/not found/i);
    await expect(incidents.acknowledge(VO2, inc.id, 'user:x')).rejects.toThrow(/not found/i);
    await expect(svc.site(VO2, mine.site.id)).rejects.toThrow(/not found/i);
    expect((await svc.cameras(VO2, {})).rows.some((c: any) => c.code === mine.cams[1].code)).toBe(false);
    // VO2's agent naming a VO camera is rejected: devices are resolved inside the agent's own site only.
    const r = await engine.ingest(VO2, theirs.site.id, { source: 'agent', agentId: theirs.agent.id, agentCode: theirs.agent.code }, [ev(mine.cams[1].code, false, min(9))], min(9));
    expect(r.rejected[0].reason).toMatch(/unknown device/);
    await expect(engine.ingest(VO2, mine.site.id, { source: 'agent' }, [], min(9))).rejects.toThrow(/Site not found/);
  });

  it('concurrent confirmations of the same fault create exactly one incident (unique open key)', async () => {
    const s = await makeSite('Race');
    const cam = s.cams[2];
    await prisma.cameraDevice.update({ where: { id: cam.id }, data: { consecutiveFailures: 5, failingSince: min(0), status: 'degraded' } });
    await Promise.all([3, 3, 3, 3].map((m, k) => incidents.raise({ org: VO, siteId: s.site.id, deviceType: 'camera', deviceId: cam.id, deviceCode: cam.code, category: 'camera_unreachable', at: min(m + k / 10) })));
    expect(await openFor(cam.id)).toHaveLength(1);
  });

  it('incident numbers stay unique after incidents are removed (scenario reset / retention), instead of colliding', async () => {
    // One incident per site (no folding). Remove the first six, keep six newer ones: a row-count based number would now
    // point at six numbers still in use and every retry would collide ("Could not allocate an incident number").
    const sites: Array<Awaited<ReturnType<typeof makeSite>>> = [];
    for (let i = 0; i < 13; i++) sites.push(await makeSite(`Numbering ${i}`, { cameras: 1 }));
    const raise = (s: (typeof sites)[number]) => incidents.raise({ org: VO, siteId: s.site.id, deviceType: 'camera', deviceId: s.cams[0].id, deviceCode: s.cams[0].code, category: 'camera_unreachable', at: min(5) });
    for (const s of sites.slice(0, 12)) await raise(s);
    await prisma.downtimeIncident.deleteMany({ where: { organizationId: VO, siteId: { in: sites.slice(0, 6).map((s) => s.site.id) } } }); // what a scenario reset does
    const next = await raise(sites[12]);
    expect(next.outcome).toBe('created');
    const numbers = (await prisma.downtimeIncident.findMany({ where: { organizationId: VO }, select: { number: true } })).map((r: { number: string }) => r.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('uptime: camera-minutes down from incidents; unknown minutes excluded from the percentage', async () => {
    const s = await makeSite('Uptime', { cameras: 1 }); // 2 cameras incl. the standalone one
    const day0 = new Date('2026-10-10T18:30:00Z'); // 11 Oct 00:00 IST
    const at = (m: number) => new Date(day0.getTime() + m * 60_000);
    await prisma.downtimeIncident.create({ data: { organizationId: VO, number: 'INC-U1', siteId: s.site.id, customerId, deviceType: 'camera', deviceId: s.cams[0].id, deviceCode: s.cams[0].code, category: 'camera_unreachable', severity: 'medium', status: 'RESOLVED', title: 't', firstDetectedAt: at(600), lastCheckedAt: at(660), resolvedAt: at(660), correlationKey: 'u1' } });
    await prisma.downtimeIncident.create({ data: { organizationId: VO, number: 'INC-U2', siteId: s.site.id, customerId, deviceType: 'agent', category: 'agent_offline', severity: 'high', status: 'RESOLVED', title: 't', affectedCount: 2, firstDetectedAt: at(900), lastCheckedAt: at(930), resolvedAt: at(930), correlationKey: 'u2' } });
    const u = await svc.uptime(VO, day0, at(1440), [s.site.id]);
    expect(u.bySite[0]).toMatchObject({ cameraMinutes: 2880, downMinutes: 60, unknownMinutes: 60 });
    expect(u.uptimePct).toBe(Math.round(((2820 - 60) / 2820) * 100_000) / 1000);
    expect((await svc.snapshot(VO, 1, new Date('2026-10-11T20:00:00Z'))).written).toBeGreaterThan(0);
  });

  it('cloud mode: only configured host:port targets; private addresses refused unless allowed', async () => {
    const server: Server = createServer((c) => c.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const site = await prisma.monitoringSite.create({ data: { organizationId: VO, customerId, code: `CLOUD${++seq}`, name: 'Cloud site', monitoringMode: 'cloud' } });
      await prisma.cameraDevice.create({ data: { organizationId: VO, siteId: site.id, code: `CAM-CL-${seq}`, name: 'Cloud cam', capabilities: { reachability: true }, monitoringMethod: 'cloud_tcp', networkAddress: `127.0.0.1:${port}` } });
      const refused = await engine.runCloudChecks(VO, site.id);
      expect(refused.checked).toBe(0);
      expect(refused.skipped[0]).toMatch(/private \/ local address refused/);
      process.env.MONITORING_ALLOW_PRIVATE_TARGETS = 'true';
      const r = await engine.runCloudChecks(VO, site.id);
      expect(r).toMatchObject({ checked: 1, accepted: 1 });
      expect((await prisma.cameraDevice.findFirst({ where: { siteId: site.id } })).status).toBe('online');
    } finally {
      delete process.env.MONITORING_ALLOW_PRIVATE_TARGETS;
      server.close();
    }
  });

  it('rules: categories, triage, quiet hours across midnight, masking, permissions', () => {
    expect(rules.categoryFor('camera', 'reachability')).toBe('camera_unreachable');
    expect(rules.categoryFor('recorder', 'storage')).toBe('storage_warning');
    expect(rules.triage('recorder_unreachable')).toBe('critical');
    expect(rules.triage('camera_unreachable', { critical: true })).toBe('high');
    expect(rules.inQuietHours({ enabled: true, start: '22:00', end: '07:00' }, new Date('2026-10-19T18:00:00Z'))).toBe(true); // 23:30 IST
    expect(rules.inQuietHours({ enabled: true, start: '22:00', end: '07:00' }, new Date('2026-10-19T06:00:00Z'))).toBe(false);
    expect(rules.maskAddress('10.20.30.40:554')).toBe('10.20.•.40:554');
    expect(rules.durationText(78)).toBe('1 h 18 min');
    expect(perms.can('technician', 'monitoring.operate')).toBe(true);
    expect(perms.can('technician', 'monitoring.manage')).toBe(false);
    expect(perms.can('sales', 'monitoring.view')).toBe(false);
    expect(perms.can('manager', 'monitoring.manage')).toBe(true);
  });
});
