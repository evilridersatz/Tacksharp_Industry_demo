/**
 * VisionOps local agent ↔ cloud: the reference agent (apps/monitoring-agent/agent.mjs) talking to the real agent
 * controller (token auth) and engine on the MySQL test database. The "network" is a fetch stub that calls the
 * controller, so offline / online is controlled precisely. Device checks run against local TCP / RTSP test servers.
 *
 *   TEST_DB_NAME=tacksharp_test npx vitest run test/visionops-agent.integration.spec.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enabled = Boolean(process.env.TEST_DB_NAME);
if (enabled) {
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.REDIS_HOST ??= '127.0.0.1';
}
const ORG = 'org_vo_agent_test';

describe.skipIf(!enabled)('VisionOps local agent protocol (integration)', () => {
  let prisma: any, svc: any, engine: any, ctl: any, agentLib: any;
  let token: string, siteId: string, agentId: string, dir: string;
  let online = true;
  const servers: Server[] = [];

  /** fetch → controller, as the HTTP layer would route it (401 / 400 become HTTP errors). */
  const fetchStub = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    if (!online) throw new TypeError('fetch failed (offline)');
    const path = new URL(url).pathname;
    try {
      const body = JSON.parse(init.body);
      const out = path.endsWith('/events') ? await ctl.events(init.headers.authorization, body) : await ctl.heartbeat(init.headers.authorization, body);
      return { ok: true, status: 200, json: async () => out };
    } catch (e: any) {
      return { ok: false, status: e.status ?? e.getStatus?.() ?? 500, json: async () => ({ message: e.message }) };
    }
  };

  async function wipe() {
    const where = { organizationId: ORG };
    for (const m of ['incidentTimelineEvent', 'notificationAttempt', 'downtimeIncident', 'healthEvent', 'agentHeartbeat', 'monitoringAgent', 'cameraDevice', 'recorderDevice', 'siteTechnician', 'monitoringSite', 'monitoringCustomer']) await prisma[m].deleteMany({ where });
  }

  beforeAll(async () => {
    process.env.DRY_RUN = 'true';
    agentLib = await import('../../monitoring-agent/agent.mjs');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { SettingsService } = await import('../src/settings/settings.service.js');
    const { MonitoringNotifier } = await import('../src/visionops/notifier.service.js');
    const { IncidentsService } = await import('../src/visionops/incidents.service.js');
    const { MonitoringEngine } = await import('../src/visionops/engine.service.js');
    const { MonitoringService } = await import('../src/visionops/monitoring.service.js');
    const { MonitoringAgentController } = await import('../src/visionops/monitoring.controller.js');
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.organization.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: 'VO Agent Test', vertical: 'real_estate' } });
    await wipe();
    const settings = new SettingsService(prisma);
    await settings.update(ORG, { industry: 'cctv', monitoring: { failureThreshold: 3, debounceSeconds: 0, restoreSuccesses: 2, quietHours: { enabled: false, start: '22:00', end: '07:00' } } });
    const notifier = new MonitoringNotifier(prisma, settings, undefined);
    const incidents = new IncidentsService(prisma, settings, notifier);
    engine = new MonitoringEngine(prisma, settings, incidents, notifier);
    svc = new MonitoringService(prisma, settings);
    ctl = new MonitoringAgentController(prisma, engine);
    const cust = await svc.createCustomer(ORG, { name: 'Agent Test Customer' });
    const site = await svc.createSite(ORG, { customerId: cust.id, code: 'AGT-LAB', name: 'Agent lab' });
    siteId = site.id;
    await svc.createRecorder(ORG, { siteId, code: 'NVR-1', networkAddress: '127.0.0.1' });
    await svc.createCamera(ORG, { siteId, code: 'CAM-UP', networkAddress: '127.0.0.1', capabilities: { stream: true } });
    await svc.createCamera(ORG, { siteId, code: 'CAM-DOWN', networkAddress: '127.0.0.1' });
    const reg = await svc.registerAgent(ORG, { siteId, code: 'AGT-1' });
    token = reg.token;
    agentId = reg.agent.id;
    dir = mkdtempSync(join(tmpdir(), 'vo-agent-'));
  });

  afterAll(async () => {
    for (const s of servers) s.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!prisma) return;
    await wipe();
    await prisma.$disconnect();
  });

  const listen = async (handler: (c: any) => void) => {
    const s = createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    servers.push(s);
    return (s.address() as { port: number }).port;
  };

  it('device checks: TCP reachability against a live and a closed port; RTSP OPTIONS answered; credentials scrubbed', async () => {
    const up = await listen((c) => c.end());
    const rtsp = await listen((c) => c.on('data', () => c.end('RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n')));
    const closed = await listen((c) => c.end());
    servers[servers.length - 1].close(); // now closed
    const cfg = { timeoutMs: 1500, devices: [{ code: 'CAM-UP', type: 'camera', host: '127.0.0.1', port: up, rtspPort: rtsp, checks: ['stream'] }, { code: 'CAM-DOWN', type: 'camera', host: '127.0.0.1', port: closed }] };
    const events = await agentLib.runChecks(cfg);
    expect(events.map((e: any) => [e.device, e.check, e.ok])).toEqual([['CAM-UP', 'reachability', true], ['CAM-UP', 'stream', true], ['CAM-DOWN', 'reachability', false]]);
    expect(events[2].detail).toBe('ECONNREFUSED');
    expect(agentLib.scrub('rtsp://admin:pw@10.0.0.2:554/x failed password=abc')).toBe('rtsp://[redacted] failed password=[redacted]');
  });

  it('offline: events stay in the local queue; on reconnect they replay oldest-first and duplicates never double-apply', async () => {
    const queue = new agentLib.Queue(join(dir, 'q.jsonl'));
    const cfg = { cloudUrl: 'https://cloud.test', token };
    const at = (m: number) => new Date(Date.now() - (40 - m) * 60_000).toISOString();
    const mk = (id: string, device: string, ok: boolean, m: number) => ({ eventId: id, device, check: 'reachability', ok, observedAt: at(m) });
    // Site internet down: the agent keeps checking and queuing.
    online = false;
    queue.push([mk('a1', 'CAM-DOWN', false, 0), mk('a2', 'CAM-DOWN', false, 1), mk('a3', 'CAM-UP', true, 1)]);
    const r1 = await agentLib.sync(cfg, queue, fetchStub as never);
    expect(r1.ok).toBe(false);
    expect(queue.size()).toBe(3);
    queue.push([mk('a4', 'CAM-DOWN', false, 2), mk('a5', 'CAM-DOWN', true, 10), mk('a6', 'CAM-DOWN', true, 11)]);
    // Internet back: the whole queue goes up, in order.
    online = true;
    const r2 = await agentLib.sync(cfg, queue, fetchStub as never, 4);
    expect(r2).toMatchObject({ ok: true, sent: 6 });
    expect(queue.size()).toBe(0);
    const stored = await prisma.healthEvent.findMany({ where: { organizationId: ORG, agentId }, orderBy: { observedAt: 'asc' } });
    expect(stored).toHaveLength(6);
    expect(stored.every((e: any) => e.replayed)).toBe(true);
    // CAM-DOWN: 3 failures (incident) then 2 successes (restored with restoreSuccesses = 2), all from the replayed queue.
    const inc = await prisma.downtimeIncident.findFirst({ where: { organizationId: ORG, deviceCode: 'CAM-DOWN' } });
    expect(inc).toMatchObject({ status: 'RESOLVED', resolvedBy: 'verification' });
    // A crash after sending but before the local queue was trimmed: the same events are sent again → duplicates.
    queue.push([mk('a5', 'CAM-DOWN', true, 10), mk('a6', 'CAM-DOWN', true, 11)]);
    const r3 = await agentLib.sync(cfg, queue, fetchStub as never);
    expect(r3).toMatchObject({ ok: true, sent: 2 });
    expect(await prisma.healthEvent.count({ where: { organizationId: ORG, agentId } })).toBe(6);
  });

  it('heartbeat carries the queue depth; a wrong or revoked token is refused by the controller', async () => {
    const queue = new agentLib.Queue(join(dir, 'hb.jsonl'));
    queue.push([{ eventId: 'x', device: 'CAM-UP', check: 'reachability', ok: true, observedAt: new Date().toISOString() }]);
    const hb = await agentLib.heartbeat({ cloudUrl: 'https://cloud.test', token, hostLabel: 'test box' }, queue, fetchStub as never);
    expect(hb).toMatchObject({ ok: true, queueDepth: 1 });
    expect(await prisma.monitoringAgent.findUnique({ where: { id: agentId } })).toMatchObject({ status: 'online', queuedEvents: 1, hostLabel: 'test box', version: agentLib.VERSION });
    await expect(agentLib.heartbeat({ cloudUrl: 'https://cloud.test', token: token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }, queue, fetchStub as never)).rejects.toThrow(/HTTP 401/);
    await expect(ctl.events('Bearer nonsense', { events: [] })).rejects.toThrow(/Agent token required/);
    await svc.revokeAgent(ORG, agentId);
    await expect(agentLib.heartbeat({ cloudUrl: 'https://cloud.test', token }, queue, fetchStub as never)).rejects.toThrow(/HTTP 401/);
  });

  it('signed updates: applied only with a valid Ed25519 signature and a matching checksum', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const file = Buffer.from('agent v0.9.1');
    const manifest = JSON.stringify({ version: '0.9.1', sha256: createHash('sha256').update(file).digest('hex') });
    const sig = sign(null, Buffer.from(manifest), privateKey).toString('base64');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    expect(agentLib.verifyUpdate(manifest, sig, file, pem)).toEqual({ ok: true, version: '0.9.1' });
    expect(agentLib.verifyUpdate(manifest, sig, Buffer.from('tampered'), pem)).toEqual({ ok: false, reason: 'checksum mismatch' });
    expect(agentLib.verifyUpdate(manifest.replace('0.9.1', '9.9.9'), sig, file, pem)).toEqual({ ok: false, reason: 'bad signature' });
  });
});
