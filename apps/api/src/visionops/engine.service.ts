import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Socket, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { log } from '../common/logger.js';
import { CHECKS, categoryFor, scrub, type Check, type DeviceType } from './rules.js';
import { IncidentsService, deviceKey, openKeyOf, type Evidence } from './incidents.service.js';
import { MonitoringNotifier } from './notifier.service.js';

export type EventIn = {
  /** The sender's own id for this check result (idempotency: the same id is never applied twice). */
  eventId: string;
  /** Device code (CAM-014, NVR-01). Omit for site-level checks (gateway / internet). */
  device?: string;
  deviceType?: 'camera' | 'recorder' | 'site';
  check: Check;
  ok: boolean;
  observedAt: string;
  latencyMs?: number;
  detail?: string;
};
export type Origin = { source: 'agent' | 'cloud' | 'simulated'; agentId?: string; agentCode?: string; isDemo?: boolean };
type Dev = { id: string; code: string; type: 'camera' | 'recorder'; siteId: string; recorderId?: string | null; critical: boolean; capabilities: Record<string, boolean>; status: string; lastCheckAt: Date | null; isDemo: boolean };

const MAX_BATCH = 1000;
const MAX_AGE_MS = 7 * 86_400_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const REPLAY_AFTER_MS = 2 * 60_000;
/** A camera with recording capability but no recording proof for this long shows "not confirmed" (no incident). */
const RECORDING_PROOF_MS = 2 * 3_600_000;

/**
 * VisionOps monitoring engine. Turns health evidence into device state and incidents with deterministic rules:
 *  - a fault is confirmed after N consecutive failed checks spanning the debounce interval (no incident for a blip);
 *  - one incident per device + fault; camera faults behind a failed recorder / site are folded into it;
 *  - events from a local agent's offline queue are accepted late (replayed) in observed order and never double-applied;
 *  - silence from an agent makes its devices UNKNOWN (never "offline") and raises an agent incident;
 *  - restoration needs N fresh consecutive successful checks. A ping alone never marks recording as verified.
 */
@Injectable()
export class MonitoringEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly incidents: IncidentsService,
    private readonly notifier: MonitoringNotifier,
  ) {}

  private async devicesOf(org: string, siteId: string): Promise<Map<string, Dev>> {
    const [cams, recs] = await Promise.all([
      this.prisma.cameraDevice.findMany({ where: { organizationId: org, siteId } }),
      this.prisma.recorderDevice.findMany({ where: { organizationId: org, siteId } }),
    ]);
    const m = new Map<string, Dev>();
    for (const r of recs) m.set(r.code.toUpperCase(), { id: r.id, code: r.code, type: 'recorder', siteId, critical: true, capabilities: (r.capabilities ?? {}) as Record<string, boolean>, status: r.status, lastCheckAt: r.lastCheckAt, isDemo: r.isDemo });
    for (const c of cams) m.set(c.code.toUpperCase(), { id: c.id, code: c.code, type: 'camera', siteId, recorderId: c.recorderId, critical: c.critical, capabilities: (c.capabilities ?? {}) as Record<string, boolean>, status: c.status, lastCheckAt: c.lastCheckAt, isDemo: c.isDemo });
    return m;
  }

  /**
   * Ingest a batch of check results for ONE site (an agent only ever reports its own site's devices).
   * Returns accepted / duplicate / rejected counts and incident outcomes.
   */
  async ingest(org: string, siteId: string, origin: Origin, events: EventIn[], now = new Date()) {
    if (!Array.isArray(events)) throw new BadRequestException('events must be an array');
    if (events.length > MAX_BATCH) throw new BadRequestException(`At most ${MAX_BATCH} events per request`);
    const site = await this.prisma.monitoringSite.findFirst({ where: { id: siteId, organizationId: org } });
    if (!site) throw new NotFoundException('Site not found');
    const cfg = (await this.settings.get(org)).monitoring;
    const devices = await this.devicesOf(org, siteId);
    const rejected: Array<{ eventId?: string; reason: string }> = [];
    const fresh: Array<{ e: EventIn; at: Date; dev?: Dev; id: string; externalId: string; replayed: boolean }> = [];
    let duplicates = 0;

    for (const e of events) {
      const eventId = typeof e?.eventId === 'string' ? e.eventId.trim() : '';
      if (!/^[\w.:-]{1,80}$/.test(eventId)) { rejected.push({ eventId, reason: 'invalid eventId' }); continue; }
      if (!CHECKS.includes(e.check)) { rejected.push({ eventId, reason: `unknown check "${String(e.check)}"` }); continue; }
      if (typeof e.ok !== 'boolean') { rejected.push({ eventId, reason: 'ok must be true or false' }); continue; }
      const at = new Date(e.observedAt);
      if (Number.isNaN(at.getTime())) { rejected.push({ eventId, reason: 'invalid observedAt' }); continue; }
      if (at.getTime() > now.getTime() + FUTURE_SKEW_MS) { rejected.push({ eventId, reason: 'observedAt is in the future (check the agent clock)' }); continue; }
      if (now.getTime() - at.getTime() > MAX_AGE_MS) { rejected.push({ eventId, reason: 'older than 7 days' }); continue; }
      const siteLevel = e.check === 'gateway' || e.check === 'internet';
      const dev = siteLevel ? undefined : devices.get(String(e.device ?? '').toUpperCase());
      if (!siteLevel && !dev) { rejected.push({ eventId, reason: `unknown device "${String(e.device ?? '')}" for this site` }); continue; }
      if (dev && e.check !== 'reachability' && dev.capabilities[e.check] !== true) { rejected.push({ eventId, reason: `${dev.code} does not support "${e.check}" checks (capability not enabled)` }); continue; }
      const externalId = `${origin.agentCode ?? origin.source}:${eventId}`.slice(0, 190);
      const replayed = now.getTime() - at.getTime() > REPLAY_AFTER_MS;
      try {
        const row = await this.prisma.healthEvent.create({
          data: {
            organizationId: org, siteId, agentId: origin.agentId ?? null, deviceType: siteLevel ? 'site' : dev!.type, deviceId: dev?.id ?? null, check: e.check, ok: e.ok,
            observedAt: at, receivedAt: now, latencyMs: Number.isFinite(e.latencyMs) ? Math.max(0, Math.round(e.latencyMs!)) : null, detail: scrub(e.detail), source: origin.source, externalId, replayed, isDemo: Boolean(origin.isDemo ?? site.isDemo),
          },
        });
        fresh.push({ e, at, dev, id: row.id, externalId, replayed });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') duplicates++;
        else throw error;
      }
    }

    // Apply in observed order: a replayed offline queue rebuilds the timeline as it happened.
    fresh.sort((a, b) => a.at.getTime() - b.at.getTime());
    const outcomes: Record<string, number> = {};
    for (const f of fresh) {
      const o = await this.apply(org, site, f.dev, f.e, f.at, f.externalId, cfg);
      if (o) outcomes[o] = (outcomes[o] ?? 0) + 1;
    }
    if (origin.agentId && fresh.length) await this.prisma.monitoringAgent.update({ where: { id: origin.agentId }, data: { lastEventAt: now, lastSyncAt: now } });
    if (fresh.length) await this.prisma.monitoringSite.update({ where: { id: siteId }, data: { lastHealthyCheckAt: fresh.some((f) => f.e.ok) ? now : site.lastHealthyCheckAt } });
    return { accepted: fresh.length, duplicates, rejected, replayed: fresh.filter((f) => f.replayed).length, outcomes };
  }

  /** Last N results of one check for one device (or the site), newest first. */
  private recent(org: string, deviceId: string | null, siteId: string, check: string, take: number) {
    return this.prisma.healthEvent.findMany({ where: { organizationId: org, check, ...(deviceId ? { deviceId } : { siteId, deviceType: 'site' }) }, orderBy: { observedAt: 'desc' }, take });
  }

  /**
   * Confirmed when the last N results of this check all failed and span at least the debounce interval.
   * Returns when the failing run started (downtime is counted from the first failed check), or undefined.
   */
  private async confirmed(org: string, deviceId: string | null, siteId: string, check: string, cfg: { failureThreshold: number; debounceSeconds: number }): Promise<Date | undefined> {
    const rows = await this.recent(org, deviceId, siteId, check, cfg.failureThreshold);
    if (rows.length < cfg.failureThreshold || rows.some((r) => r.ok)) return undefined;
    const span = rows[0].observedAt.getTime() - rows[rows.length - 1].observedAt.getTime();
    return span >= cfg.debounceSeconds * 1000 ? rows[rows.length - 1].observedAt : undefined;
  }

  private async apply(org: string, site: { id: string; name: string; isDemo: boolean }, dev: Dev | undefined, e: EventIn, at: Date, eventId: string, cfg: Awaited<ReturnType<SettingsService['get']>>['monitoring']): Promise<string | undefined> {
    const evidence: Evidence = { at: at.toISOString(), check: e.check, ok: e.ok, eventId, source: 'agent' };

    // ---- site-level: LAN gateway and internet link (reported by the local agent)
    if (!dev) {
      const category = categoryFor('site', e.check)!;
      const key = openKeyOf('site', site.id, category);
      if (e.check === 'internet') await this.prisma.monitoringSite.update({ where: { id: site.id }, data: { internetStatus: e.ok ? 'online' : 'backup_link' } });
      if (e.ok) return (await this.incidents.recordSuccess(org, key, evidence, at)) ? 'restoration_evidence' : undefined;
      await this.incidents.recordFailure(org, key, at, e.detail);
      // The agent saying "my broadband is down" over its 4G backup is direct evidence: no debounce needed.
      const since = e.check === 'internet' ? at : await this.confirmed(org, null, site.id, e.check, cfg);
      if (since) {
        const cams = await this.prisma.cameraDevice.findMany({ where: { organizationId: org, siteId: site.id }, select: { code: true } });
        const r = await this.incidents.raise({ org, siteId: site.id, deviceType: 'site', deviceId: site.id, category, at, since, affected: e.check === 'gateway' ? cams.map((c) => c.code) : [], detail: scrub(e.detail) ?? undefined, isDemo: site.isDemo });
        return r.outcome;
      }
      return 'failure_pending';
    }

    // Older than what we already know about this device: stored, but it does not move the current state.
    const stale = dev.lastCheckAt && at < dev.lastCheckAt;
    const table = dev.type === 'camera' ? this.prisma.cameraDevice : this.prisma.recorderDevice;
    const category = categoryFor(dev.type as DeviceType, e.check);
    const key = category ? openKeyOf(dev.type, dev.id, category) : undefined;

    if (e.check === 'reachability') {
      const row = dev.type === 'camera' ? await this.prisma.cameraDevice.findUnique({ where: { id: dev.id } }) : await this.prisma.recorderDevice.findUnique({ where: { id: dev.id } });
      if (!row) return undefined;
      if (stale) return 'late';
      if (e.ok) {
        await (table as typeof this.prisma.cameraDevice).update({ where: { id: dev.id }, data: { status: row.status === 'maintenance' ? 'maintenance' : 'online', consecutiveSuccesses: row.consecutiveSuccesses + 1, consecutiveFailures: 0, failingSince: null, lastSeenAt: at, lastCheckAt: at } });
        dev.lastCheckAt = at;
        return (await this.incidents.recordSuccess(org, key!, evidence, at)) ? 'restoration_evidence' : 'ok';
      }
      const failures = row.consecutiveFailures + 1;
      const failingSince = row.failingSince ?? at;
      const isConfirmed = failures >= cfg.failureThreshold && at.getTime() - failingSince.getTime() >= cfg.debounceSeconds * 1000;
      await (table as typeof this.prisma.cameraDevice).update({ where: { id: dev.id }, data: { status: row.status === 'maintenance' ? 'maintenance' : isConfirmed || row.status === 'offline' ? 'offline' : 'degraded', consecutiveFailures: failures, consecutiveSuccesses: 0, failingSince, lastCheckAt: at } });
      dev.lastCheckAt = at;
      await this.incidents.recordFailure(org, key!, at, e.detail);
      if (!isConfirmed || row.status === 'maintenance') return 'failure_pending';
      // Its recorder is failing too but not confirmed yet: the recorder is the likely cause. Wait for it rather than
      // opening (and alerting) one incident per camera that would be merged a minute later. A confirmed (offline)
      // recorder folds the camera into its incident below; a recorder that recovers lets the camera raise its own.
      if (dev.type === 'camera' && dev.recorderId) {
        const rec = await this.prisma.recorderDevice.findUnique({ where: { id: dev.recorderId }, select: { status: true, consecutiveFailures: true } });
        if (rec && rec.status !== 'offline' && rec.status !== 'maintenance' && rec.consecutiveFailures > 0) return 'waiting_for_recorder';
      }
      const affected = dev.type === 'recorder' ? (await this.prisma.cameraDevice.findMany({ where: { organizationId: org, recorderId: dev.id }, select: { code: true } })).map((c) => c.code) : undefined;
      const r = await this.incidents.raise({ org, siteId: site.id, deviceType: dev.type, deviceId: dev.id, deviceCode: dev.code, category: category!, at, since: failingSince, critical: dev.critical, affected, detail: scrub(e.detail) ?? undefined, isDemo: dev.isDemo });
      return r.outcome;
    }

    // stream / recording / storage: capability already verified at intake.
    if (!stale) {
      const data: Record<string, unknown> = { lastCheckAt: dev.lastCheckAt && dev.lastCheckAt > at ? dev.lastCheckAt : at };
      if (e.check === 'stream') data.streamStatus = e.ok ? 'ok' : 'unavailable';
      if (e.check === 'recording') Object.assign(data, e.ok ? { recordingStatus: 'verified', lastRecordingVerifiedAt: at } : { recordingStatus: 'failing' });
      if (e.check === 'storage') Object.assign(data, { storageStatus: e.ok ? 'ok' : 'warning', storageDetail: e.ok ? null : scrub(e.detail)?.slice(0, 180) ?? 'Storage warning' });
      if (dev.type === 'camera') delete data.storageStatus;
      if (dev.type === 'recorder' && e.check === 'stream') delete data.streamStatus;
      await (table as typeof this.prisma.cameraDevice).update({ where: { id: dev.id }, data: data as never });
    }
    if (!key) return undefined;
    if (e.ok) return (await this.incidents.recordSuccess(org, key, evidence, at)) ? 'restoration_evidence' : 'ok';
    await this.incidents.recordFailure(org, key, at, e.detail);
    // A camera that is already unreachable has no separate stream / recording incident: it is the same fault.
    const current = dev.type === 'camera' ? await this.prisma.cameraDevice.findUnique({ where: { id: dev.id }, select: { status: true } }) : null;
    if (current?.status === 'offline') return 'covered_by_reachability';
    const since = await this.confirmed(org, dev.id, site.id, e.check, cfg);
    if (!since) return 'failure_pending';
    const r = await this.incidents.raise({ org, siteId: site.id, deviceType: dev.type, deviceId: dev.id, deviceCode: dev.code, category: category!, at, since, critical: dev.critical, detail: scrub(e.detail) ?? undefined, isDemo: dev.isDemo });
    return r.outcome;
  }

  /** Agent heartbeat: the agent is alive; resolves the agent incident with evidence once it has synced its queue. */
  async heartbeat(org: string, agentId: string, body: { sentAt?: string; queueDepth?: number; version?: string; uptimeSec?: number; link?: string; hostLabel?: string }, now = new Date()) {
    const agent = await this.prisma.monitoringAgent.findFirst({ where: { id: agentId, organizationId: org } });
    if (!agent || agent.status === 'revoked') throw new NotFoundException('Agent not found or revoked');
    const sentAt = body.sentAt ? new Date(body.sentAt) : now;
    if (Number.isNaN(sentAt.getTime())) throw new BadRequestException('invalid sentAt');
    // Replay protection: a heartbeat is about "now"; an old or future one is refused (queued EVENTS may be old).
    if (Math.abs(now.getTime() - sentAt.getTime()) > 10 * 60_000) throw new BadRequestException('Heartbeat sentAt is more than 10 minutes from server time (replayed, or the agent clock is wrong)');
    const queueDepth = Math.max(0, Math.min(1_000_000, Math.round(Number(body.queueDepth ?? 0)) || 0));
    const link = body.link === 'backup_4g' ? 'backup_4g' : 'primary';
    const hb = await this.prisma.agentHeartbeat.create({ data: { organizationId: org, agentId, sentAt, receivedAt: now, queueDepth, version: body.version?.slice(0, 40) ?? null, uptimeSec: Number.isFinite(body.uptimeSec) ? Math.round(body.uptimeSec!) : null, link, isDemo: agent.isDemo } });
    await this.prisma.monitoringAgent.update({ where: { id: agentId }, data: { status: 'online', lastHeartbeatAt: now, queuedEvents: queueDepth, version: body.version?.slice(0, 40) ?? agent.version, hostLabel: body.hostLabel?.slice(0, 80) ?? agent.hostLabel } });
    await this.prisma.monitoringSite.update({ where: { id: agent.siteId }, data: { internetStatus: link === 'backup_4g' ? 'backup_link' : 'online' } });
    let incident: string | undefined;
    if (queueDepth === 0) {
      const r = await this.incidents.resolveAgentIncident(org, agentId, { at: now.toISOString(), check: 'heartbeat', ok: true, eventId: hb.id, source: 'agent' }, now);
      incident = r ? (r.status === 'RESOLVED' ? 'resolved' : 'restoration_evidence') : undefined;
    }
    return { ok: true, serverTime: now.toISOString(), queueDepth, incident };
  }

  /**
   * Periodic sweep (worker every minute; on staging, "Run checks now"):
   *  - agents silent past staleAfterMinutes → offline, their site's devices UNKNOWN, one agent incident;
   *  - cloud-checked sites with stale checks → devices UNKNOWN, one status_unknown incident;
   *  - recording proof older than 2 h → "not confirmed" (shown, no incident);
   *  - escalations and due notifications.
   */
  async sweep(org: string | undefined, now = new Date(), opts: { agentIds?: string[]; includeDemoAgents?: boolean } = {}) {
    const orgs = org ? [org] : (await this.prisma.monitoringSite.findMany({ select: { organizationId: true }, distinct: ['organizationId'] })).map((o) => o.organizationId);
    const summary = { agentsOffline: 0, sitesUnknown: 0, recordingNotConfirmed: 0, escalated: 0, delivered: 0 };
    for (const o of orgs) {
      const cfg = (await this.settings.get(o)).monitoring;
      const cutoff = new Date(now.getTime() - cfg.staleAfterMinutes * 60_000);
      // Seeded demo agents are a static snapshot (no process sends their heartbeats): never aged by the sweep unless a
      // scenario names them or the live demo feed is sending them heartbeats. Real agents (isDemo = false) are always checked.
      const silent = await this.prisma.monitoringAgent.findMany({ where: { organizationId: o, status: 'online', lastHeartbeatAt: { lt: cutoff }, ...(opts.agentIds ? { id: { in: opts.agentIds } } : opts.includeDemoAgents ? {} : { isDemo: false }) }, include: { site: true } });
      for (const a of silent) {
        await this.prisma.monitoringAgent.update({ where: { id: a.id }, data: { status: 'offline' } });
        await this.prisma.monitoringSite.update({ where: { id: a.siteId }, data: { internetStatus: a.hasBackupLink ? 'unknown' : 'suspected_outage' } });
        await this.prisma.cameraDevice.updateMany({ where: { organizationId: o, siteId: a.siteId, status: { not: 'maintenance' } }, data: { status: 'unknown' } });
        await this.prisma.recorderDevice.updateMany({ where: { organizationId: o, siteId: a.siteId, status: { not: 'maintenance' } }, data: { status: 'unknown' } });
        const cams = await this.prisma.cameraDevice.findMany({ where: { organizationId: o, siteId: a.siteId }, select: { code: true } });
        await this.incidents.raise({
          org: o, siteId: a.siteId, deviceType: 'agent', deviceId: a.id, deviceCode: a.code, category: 'agent_offline', at: a.lastHeartbeatAt ?? now, affected: cams.map((c) => c.code),
          detail: `Last heartbeat ${a.lastHeartbeatAt?.toISOString() ?? 'never'}. ${a.hasBackupLink ? 'The agent has a 4G backup link and that is silent too: the agent PC or its power is the likely cause.' : 'Site internet outage or agent PC down; cameras are UNKNOWN, not confirmed offline.'}`,
          isDemo: a.isDemo,
        });
        summary.agentsOffline++;
      }
      const cloudSites = opts.agentIds ? [] : await this.prisma.monitoringSite.findMany({ where: { organizationId: o, monitoringMode: 'cloud', isDemo: false } });
      for (const s of cloudSites) {
        const staleCams = await this.prisma.cameraDevice.findMany({ where: { organizationId: o, siteId: s.id, status: { notIn: ['unknown', 'maintenance'] }, OR: [{ lastCheckAt: { lt: cutoff } }, { lastCheckAt: null }] }, select: { id: true, code: true } });
        if (!staleCams.length) continue;
        await this.prisma.cameraDevice.updateMany({ where: { id: { in: staleCams.map((c) => c.id) } }, data: { status: 'unknown' } });
        await this.incidents.raise({ org: o, siteId: s.id, deviceType: 'site', deviceId: s.id, category: 'status_unknown', at: now, affected: staleCams.map((c) => c.code), isDemo: s.isDemo });
        summary.sitesUnknown++;
      }
      const nc = await this.prisma.cameraDevice.updateMany({
        where: { organizationId: o, isDemo: false, recordingStatus: 'verified', OR: [{ lastRecordingVerifiedAt: { lt: new Date(now.getTime() - RECORDING_PROOF_MS) } }, { lastRecordingVerifiedAt: null }] },
        data: { recordingStatus: 'not_confirmed' },
      });
      summary.recordingNotConfirmed += nc.count;
      summary.escalated += (await this.notifier.escalateDue(o, now)).escalated;
      summary.delivered += (await this.notifier.dispatchDue(o, now)).length;
    }
    return summary;
  }

  // ------------------------------------------------------------------ Mode A: cloud checks of explicitly configured targets

  /**
   * TCP reachability for devices of a cloud-mode site whose monitoring method is cloud_tcp and whose address is an
   * explicit host:port. No scanning: only configured targets; private / loopback addresses are refused unless
   * MONITORING_ALLOW_PRIVATE_TARGETS=true (tests / an on-prem deployment).
   */
  async runCloudChecks(org: string, siteId: string, now = new Date(), probe: (host: string, port: number) => Promise<{ ok: boolean; ms: number; error?: string }> = tcpProbe) {
    const site = await this.prisma.monitoringSite.findFirst({ where: { id: siteId, organizationId: org } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.monitoringMode !== 'cloud') throw new BadRequestException('This site is monitored by a local agent; cloud checks are not used.');
    if (site.isDemo) throw new BadRequestException('Demo site: its addresses are synthetic, so no real network check is run. Use the scenario runner to see the monitoring flow.');
    const [cams, recs] = await Promise.all([
      this.prisma.cameraDevice.findMany({ where: { organizationId: org, siteId, monitoringMethod: 'cloud_tcp' } }),
      this.prisma.recorderDevice.findMany({ where: { organizationId: org, siteId, monitoringMethod: 'cloud_tcp' } }),
    ]);
    const events: EventIn[] = [];
    const skipped: string[] = [];
    for (const d of [...recs, ...cams]) {
      const target = parseTarget(d.networkAddress);
      if (!target) { skipped.push(`${d.code}: no host:port configured`); continue; }
      if (process.env.MONITORING_ALLOW_PRIVATE_TARGETS !== 'true') {
        // A hostname is resolved first: one that points at a private / loopback address is refused like the literal IP.
        const addrs = isIP(target.host) ? [target.host] : await lookup(target.host, { all: true }).then((r) => r.map((a) => a.address)).catch(() => [] as string[]);
        if (!addrs.length) { skipped.push(`${d.code}: ${target.host} does not resolve`); continue; }
        if (isPrivate(target.host) || addrs.some(isPrivate)) { skipped.push(`${d.code}: private / local address refused for cloud checks (use a local agent)`); continue; }
      }
      const r = await probe(target.host, target.port);
      events.push({ eventId: `cloud-${d.code}-${now.getTime()}`, device: d.code, check: 'reachability', ok: r.ok, observedAt: now.toISOString(), latencyMs: r.ms, detail: r.error });
    }
    const result = events.length ? await this.ingest(org, siteId, { source: 'cloud', isDemo: site.isDemo }, events, now) : { accepted: 0, duplicates: 0, rejected: [], replayed: 0, outcomes: {} };
    log.info('visionops.cloud_checks', { org, siteId, checked: events.length, skipped: skipped.length });
    return { ...result, checked: events.length, skipped };
  }

  deviceKey = deviceKey;
}

function parseTarget(addr: string | null): { host: string; port: number } | undefined {
  const m = (addr ?? '').trim().match(/^([a-zA-Z0-9.-]{1,253}):(\d{1,5})$/);
  if (!m) return undefined;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : undefined;
}

function isPrivate(host: string) {
  if (/^(localhost|.*\.local)$/i.test(host)) return true;
  if (host.includes(':')) {
    const h = host.toLowerCase();
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivate(mapped[1]);
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('ff');
  }
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
}

export function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const sock = new Socket();
    const done = (ok: boolean, error?: string) => {
      sock.destroy();
      resolve({ ok, ms: Date.now() - started, ...(error ? { error } : {}) });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, (e as NodeJS.ErrnoException).code ?? 'error'));
    sock.connect(port, host);
  });
}
