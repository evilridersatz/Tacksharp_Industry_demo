/**
 * VisionOps live data: the demo feed (simulated site agents through the real pipeline) and the scheduler
 * (feed → cloud checks → sweep → retention). Runs against TEST_DB_NAME only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}

const DEMO = 'org_vo_live_demo';
const REAL = 'org_vo_live_real';
const ORGS = [DEMO, REAL];
const T0 = Date.parse('2026-10-19T06:00:00Z'); // 11:30 IST, outside quiet hours
const at = (m: number) => new Date(T0 + m * 60_000);

describe.skipIf(!enabled)('VisionOps live feed and scheduler (integration)', { timeout: 240_000 }, () => {
  let prisma: any, settings: any, engine: any, feed: any, scheduler: any, sched: any;
  const ids: Record<string, any> = {};

  async function wipe() {
    const where = { organizationId: { in: ORGS } };
    for (const m of ['incidentTimelineEvent', 'notificationAttempt', 'downtimeIncident', 'healthEvent', 'agentHeartbeat', 'monitoringAgent', 'cameraDevice', 'recorderDevice', 'siteTechnician', 'serviceContract', 'siteUptimeSnapshot', 'monitoringSite', 'monitoringCustomer', 'message', 'conversation', 'lead', 'customer']) await prisma[m].deleteMany({ where });
  }

  async function site(org: string, code: string, isDemo: boolean, backup = false) {
    const customer = await prisma.monitoringCustomer.create({ data: { organizationId: org, name: `${code} Customer`, isDemo } });
    const s = await prisma.monitoringSite.create({ data: { organizationId: org, customerId: customer.id, code, name: `${code} Site`, city: 'Chennai', isDemo } });
    const nvr = await prisma.recorderDevice.create({ data: { organizationId: org, siteId: s.id, code: `${code}-NVR`, name: 'NVR', capabilities: { reachability: true, storage: true }, status: 'online', isDemo } });
    const cams = [];
    for (let i = 1; i <= 4; i++) cams.push(await prisma.cameraDevice.create({ data: { organizationId: org, siteId: s.id, recorderId: nvr.id, code: `${code}-CAM-${i}`, name: `Camera ${i}`, capabilities: { reachability: true, stream: i === 1, recording: i === 1 }, status: 'online', isDemo } }));
    const agent = await prisma.monitoringAgent.create({ data: { organizationId: org, siteId: s.id, code: `${code}-AGT`, name: `${code} agent`, tokenPrefix: `vo_${code.toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(10, '0').slice(0, 10)}`, tokenHash: 'x', status: 'online', lastHeartbeatAt: at(-1), hasBackupLink: backup, isDemo } });
    await prisma.siteTechnician.create({ data: { organizationId: org, siteId: s.id, name: `${code} Tech`, phone: `91980000${String(1000 + code.charCodeAt(0) * 10 + Number(code.slice(-1))).slice(-4)}`, role: 'technician', isDemo } });
    return { site: s, nvr, cams, agent };
  }

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { ConversationsService } = await import('../src/conversations/conversations.service.js');
    const { MonitoringNotifier } = await import('../src/visionops/notifier.service.js');
    const { IncidentsService } = await import('../src/visionops/incidents.service.js');
    const { MonitoringEngine } = await import('../src/visionops/engine.service.js');
    const { TechnicianAssistant } = await import('../src/visionops/technician-assistant.service.js');
    const { DemoFeedService } = await import('../src/visionops/demo-feed.service.js');
    sched = await import('../src/visionops/scheduler.service.js');
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, isDemo] of [[DEMO, true], [REAL, false]] as const) await prisma.organization.upsert({ where: { id }, update: { isDemo }, create: { id, name: id, vertical: 'real_estate', isDemo } });
    await wipe();
    settings = new SettingsService(prisma);
    const mon = { failureThreshold: 3, debounceSeconds: 120, restoreSuccesses: 3, staleAfterMinutes: 5, correlationWindowMinutes: 30, ackDeadlineMinutes: 15, escalationStepMinutes: 30, quietHours: { enabled: false, start: '22:00', end: '07:00' } };
    await settings.update(DEMO, { industry: 'cctv', monitoring: { ...mon, liveDemo: { enabled: true, since: at(0).toISOString() } } });
    await settings.update(REAL, { industry: 'cctv', monitoring: { ...mon, liveDemo: { enabled: true, since: at(0).toISOString() } } });
    const notifier = new MonitoringNotifier(prisma, settings, undefined);
    const incidents = new IncidentsService(prisma, settings, notifier);
    engine = new MonitoringEngine(prisma, settings, incidents, notifier);
    const tech = new TechnicianAssistant(prisma, new ConversationsService(prisma), incidents);
    feed = new DemoFeedService(prisma, settings, engine, incidents, tech);
    feed.random = () => 0.999; // no random faults: the tests inject them explicitly
    scheduler = new sched.VisionOpsScheduler(prisma, settings, engine, feed);
    ids.demo = await site(DEMO, 'LV1', true);
    ids.backup = await site(DEMO, 'LV2', true, true);
    ids.real = await site(REAL, 'RL1', false);
  });

  afterAll(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.$disconnect();
  });

  it('never touches a real workspace, even with liveDemo set in its settings', async () => {
    expect(await feed.tick(REAL, at(0))).toBeNull();
    expect(await feed.liveOrgs()).not.toContain(REAL);
    expect(await prisma.healthEvent.count({ where: { organizationId: REAL } })).toBe(0);
  });

  it('a tick sends heartbeats and checks through the real engine: devices online, data marked demo', async () => {
    const r = await scheduler.runOrg(DEMO, at(0));
    expect(r.feed[DEMO]).toMatchObject({ sites: 2, heartbeats: 2 });
    expect(r.feed[DEMO].events).toBeGreaterThanOrEqual(12);
    const evs = await prisma.healthEvent.findMany({ where: { organizationId: DEMO } });
    expect(evs.every((e: any) => e.isDemo && ['agent'].includes(e.source))).toBe(true);
    const a = await prisma.monitoringAgent.findUnique({ where: { id: ids.demo.agent.id } });
    expect(a.lastHeartbeatAt.getTime()).toBe(at(0).getTime());
    expect(await prisma.cameraDevice.count({ where: { organizationId: DEMO, status: 'online' } })).toBe(8);
  });

  it('an injected camera fault becomes ONE incident; the simulated technician ACKs, works and fixes it; restoration is verified', async () => {
    process.env.DRY_RUN = 'false'; // demo incidents must stay simulated whatever DRY_RUN says
    try {
      const cam = ids.demo.cams[2];
      feed.simulate(DEMO, 'camera_unreachable', cam.id, at(1));
      for (let m = 1; m <= 75; m++) await scheduler.runOrg(DEMO, at(m));
      const incs = await prisma.downtimeIncident.findMany({ where: { organizationId: DEMO, deviceId: cam.id } });
      expect(incs).toHaveLength(1);
      const inc = incs[0];
      expect(['RESOLVED', 'CLOSED']).toContain(inc.status);
      expect(inc.resolvedBy).toBe('verification');
      expect(inc.rootCause).toBeTruthy();
      const types = (await prisma.incidentTimelineEvent.findMany({ where: { incidentId: inc.id } })).map((x: any) => x.type);
      expect(types).toEqual(expect.arrayContaining(['detected', 'acknowledged', 'restoration_check', 'resolved']));
      const sent = await prisma.notificationAttempt.findMany({ where: { organizationId: DEMO } });
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((n: any) => n.status !== 'sent' && (n.simulated || n.status === 'deferred' || n.status === 'skipped'))).toBe(true);
      const msgs = await prisma.message.findMany({ where: { organizationId: DEMO, role: 'user' } });
      expect(msgs.map((x: any) => x.content).join(' ')).toMatch(new RegExp(`ACK ${inc.number}`));
      expect((await prisma.cameraDevice.findUnique({ where: { id: cam.id } })).status).toBe('online');
    } finally {
      process.env.DRY_RUN = 'true';
    }
  });

  it('an agent "power cut": checks are queued locally, the sweep marks devices UNKNOWN with an agent incident, reconnect replays the queue', async () => {
    const agent = ids.demo.agent;
    feed.simulate(DEMO, 'agent_offline', agent.id, at(80));
    for (let m = 80; m <= 88; m++) await scheduler.runOrg(DEMO, at(m));
    const inc = await prisma.downtimeIncident.findFirst({ where: { organizationId: DEMO, deviceId: agent.id, category: 'agent_offline' } });
    expect(inc).toBeTruthy();
    expect(await prisma.cameraDevice.count({ where: { siteId: ids.demo.site.id, status: 'unknown' } })).toBe(4);
    let replayed = 0;
    for (let m = 89; m <= 140; m++) replayed += (await scheduler.runOrg(DEMO, at(m))).feed[DEMO]?.replayed ?? 0;
    expect(replayed).toBeGreaterThan(0);
    expect(await prisma.healthEvent.count({ where: { organizationId: DEMO, replayed: true } })).toBeGreaterThan(0);
    const after = await prisma.downtimeIncident.findUnique({ where: { id: inc.id } });
    expect(['RESOLVED', 'CLOSED']).toContain(after.status);
    expect((await prisma.monitoringAgent.findUnique({ where: { id: agent.id } })).status).toBe('online');
  });

  it('an internet outage on a site with 4G backup: incident while monitoring continues, then cleared', async () => {
    feed.simulate(DEMO, 'internet_outage', ids.backup.site.id, at(150));
    for (let m = 150; m <= 153; m++) await scheduler.runOrg(DEMO, at(m));
    const inc = await prisma.downtimeIncident.findFirst({ where: { organizationId: DEMO, siteId: ids.backup.site.id, category: 'internet_outage' } });
    expect(inc).toBeTruthy();
    expect((await prisma.monitoringSite.findUnique({ where: { id: ids.backup.site.id } })).internetStatus).toBe('backup_link');
    expect(await prisma.cameraDevice.count({ where: { siteId: ids.backup.site.id, status: 'online' } })).toBe(4);
    for (let m = 154; m <= 210; m++) await scheduler.runOrg(DEMO, at(m));
    expect(['RESOLVED', 'CLOSED']).toContain((await prisma.downtimeIncident.findUnique({ where: { id: inc.id } })).status);
  });

  it('random faults: with a quiet fleet the feed injects one, and the device starts failing its checks', async () => {
    feed.random = () => 0.01; // below every threshold: inject, pick the first kind (camera) and the first camera
    try {
      const r = await feed.tick(DEMO, at(300));
      expect(r.injected).toEqual(['camera_unreachable']);
      const failed = await prisma.healthEvent.count({ where: { organizationId: DEMO, ok: false, observedAt: { gte: at(299) } } });
      expect(failed).toBeGreaterThanOrEqual(1);
    } finally {
      feed.random = () => 0.999;
    }
  });

  it('switched off: the feed sends nothing and the sweep no longer ages demo agents', async () => {
    await settings.update(DEMO, { monitoring: { liveDemo: { enabled: false, since: null } } });
    const before = await prisma.healthEvent.count({ where: { organizationId: DEMO } });
    const r = await scheduler.runOrg(DEMO, at(400));
    expect(r.feed[DEMO]).toBeUndefined();
    expect(await prisma.healthEvent.count({ where: { organizationId: DEMO } })).toBe(before);
    expect((await prisma.monitoringAgent.findUnique({ where: { id: ids.demo.agent.id } })).status).toBe('online');
  });

  it('retention: raw checks older than the window are deleted (demo: 3 days); incidents are kept', async () => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    await prisma.healthEvent.create({ data: { organizationId: REAL, siteId: ids.real.site.id, deviceType: 'camera', deviceId: ids.real.cams[0].id, check: 'reachability', ok: true, observedAt: old, receivedAt: old, source: 'agent', externalId: 'old-real-1' } });
    await prisma.healthEvent.create({ data: { organizationId: DEMO, siteId: ids.demo.site.id, deviceType: 'camera', deviceId: ids.demo.cams[0].id, check: 'reachability', ok: true, observedAt: old, receivedAt: old, source: 'agent', externalId: 'old-demo-1', isDemo: true } });
    const incidents = await prisma.downtimeIncident.count({ where: { organizationId: DEMO } });
    const r = await scheduler.retention([DEMO, REAL]);
    expect(r.healthEvents).toBeGreaterThanOrEqual(1);
    expect(await prisma.healthEvent.count({ where: { externalId: 'old-demo-1' } })).toBe(0);
    expect(await prisma.healthEvent.count({ where: { externalId: 'old-real-1' } })).toBe(1); // 10 days < the real workspace's 90
    expect(await prisma.downtimeIncident.count({ where: { organizationId: DEMO } })).toBe(incidents);
  });

  it('cloud checks: hostnames resolving to private addresses are refused; scheduler on/off rules', async () => {
    const s = await prisma.monitoringSite.create({ data: { organizationId: REAL, customerId: ids.real.site.customerId, code: 'RL-CLOUD', name: 'Cloud site', monitoringMode: 'cloud' } });
    await prisma.cameraDevice.create({ data: { organizationId: REAL, siteId: s.id, code: 'RL-CC-1', name: 'Cam', monitoringMethod: 'cloud_tcp', networkAddress: 'localhost:554', capabilities: { reachability: true } } });
    const saved = process.env.MONITORING_ALLOW_PRIVATE_TARGETS;
    delete process.env.MONITORING_ALLOW_PRIVATE_TARGETS;
    const r = await engine.runCloudChecks(REAL, s.id, at(0), async () => ({ ok: true, ms: 1 }));
    expect(r.checked).toBe(0);
    expect(r.skipped[0]).toMatch(/private/);
    if (saved !== undefined) process.env.MONITORING_ALLOW_PRIVATE_TARGETS = saved;

    expect(sched.schedulerEnabled({ VISIONOPS_SCHEDULER: 'true' } as any).on).toBe(true);
    expect(sched.schedulerEnabled({ VISIONOPS_SCHEDULER: 'false' } as any).on).toBe(false);
    expect(sched.schedulerEnabled({ VITEST: 'true' } as any).on).toBe(false);
  });
});
