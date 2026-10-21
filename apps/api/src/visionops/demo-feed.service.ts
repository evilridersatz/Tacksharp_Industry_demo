import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { errorMessage, log } from '../common/logger.js';
import { ACTIVE_STATES, type Category } from './rules.js';
import { MonitoringEngine, type EventIn, type Origin } from './engine.service.js';
import { IncidentsService } from './incidents.service.js';
import { TechnicianAssistant } from './technician-assistant.service.js';

const MIN = 60_000;
const QUEUE_CAP = 600;

type Fault = { kind: Category; deviceId: string; since: number };
export type FeedSummary = { sites: number; events: number; heartbeats: number; replayed: number; injected: string[]; actions: string[]; closed: number };

/** What a simulated technician did to fix each kind of fault (shown as the incident's root cause). */
const ROOT_CAUSE: Record<string, string[]> = {
  camera_unreachable: ['loose PoE cable reseated', 'camera power adapter replaced', 'switch port reset', 'RJ45 connector re-crimped'],
  recorder_unreachable: ['NVR power cycled after a UPS trip', 'NVR network cable replaced', 'NVR restarted after a firmware hang'],
  recording_not_confirmed: ['recording schedule re-enabled on the NVR', 'channel re-added to the recording plan'],
  stream_unavailable: ['camera stream profile reset', 'camera restarted'],
  storage_warning: ['failed disk replaced', 'old footage archived and disk health checked'],
  internet_outage: ['ISP restored the broadband line', 'router restarted and line re-provisioned'],
  network_lost: ['site switch power restored'],
};

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * When the simulated technician acknowledges, reaches the site and fixes an incident (deterministic per incident).
 * One incident in five is acknowledged only after the deadline, so escalation shows up in the demo too. Already
 * acknowledged incidents move on 1–2 minutes after their acknowledgment.
 * Times count from the later of when the incident was raised and when the feed was switched on, so seeded incidents
 * are worked live.
 */
export function feedPlan(incidentId: string, startMs: number) {
  const h = hash(incidentId);
  const slowAck = h % 5 === 0;
  // Demo pace (a real repair takes longer): ACK in 1–4 min (or 17–21, past the 15-min deadline), fixed in 7–20 min.
  const ackAt = startMs + (slowAck ? 17 + (h % 5) : 1 + (h % 4)) * MIN;
  const progressAt = ackAt + (1 + (h % 2)) * MIN;
  const fixAt = Math.max(progressAt + 3 * MIN, startMs + (7 + (h % 14)) * MIN);
  return { ackAt, progressAt, fixAt, slowAck, pick: <T>(list: T[]) => list[h % list.length] };
}

/**
 * Live demo feed: plays the site agents of a DEMO workspace. Every tick it sends heartbeats and health checks through
 * the same engine a real agent's HTTPS calls reach (debounce, incidents, folding, escalation, verified restoration),
 * injects occasional faults, and answers alerts as a technician would on WhatsApp (through the real technician
 * assistant). It never touches a non-demo workspace or device, and every notification it causes stays SIMULATED
 * (demo incidents are never sent, whatever DRY_RUN says).
 */
@Injectable()
export class DemoFeedService {
  /** Faults injected but not yet confirmed as incidents (in memory; a restart only drops a pending blip). */
  private readonly pending = new Map<string, Map<string, Fault>>();
  /** Checks an "offline" demo agent could not deliver; replayed on reconnect, like the real agent's local queue. */
  private readonly queued = new Map<string, EventIn[]>();
  private ticks = 0;
  /** Replaceable in tests. */
  random: () => number = Math.random;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly engine: MonitoringEngine,
    private readonly incidents: IncidentsService,
    private readonly tech: TechnicianAssistant,
  ) {}

  /** Inject a fault now (tests; a dashboard "simulate a fault" action could use it too). Demo workspaces only. */
  async simulate(org: string, kind: Category, deviceId: string, now = new Date()) {
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } });
    if (!o?.isDemo) throw new Error('Faults can only be simulated in a demo workspace');
    const pend = this.pending.get(org) ?? new Map<string, Fault>();
    pend.set(`${deviceId}:${kind}`, { kind, deviceId, since: now.getTime() });
    this.pending.set(org, pend);
  }

  /** Demo organizations with the feed switched on. */
  async liveOrgs(): Promise<string[]> {
    const orgs = await this.prisma.organization.findMany({ where: { isDemo: true, monitoringSites: { some: {} } }, select: { id: true } });
    const on: string[] = [];
    for (const o of orgs) if ((await this.settings.get(o.id)).monitoring.liveDemo?.enabled) on.push(o.id);
    return on;
  }

  async tick(org: string, now = new Date()): Promise<FeedSummary | null> {
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } });
    if (!o?.isDemo) return null; // never a real workspace
    const cfg = (await this.settings.get(org)).monitoring;
    if (!cfg.liveDemo?.enabled) return null;
    const t = now.getTime();
    const feedStart = cfg.liveDemo.since ? Date.parse(cfg.liveDemo.since) : t;
    const tick = ++this.ticks;
    const summary: FeedSummary = { sites: 0, events: 0, heartbeats: 0, replayed: 0, injected: [], actions: [], closed: 0 };

    const sites = await this.prisma.monitoringSite.findMany({
      where: { organizationId: org, isDemo: true, NOT: { code: { startsWith: 'LAB-' } } },
      include: { recorders: { where: { isDemo: true } }, cameras: { where: { isDemo: true } }, agents: { where: { isDemo: true, status: { not: 'revoked' } } } },
    });
    const siteIds = sites.map((s) => s.id);
    const active = await this.prisma.downtimeIncident.findMany({ where: { organizationId: org, siteId: { in: siteIds }, status: { in: ACTIVE_STATES } } });
    const techs = await this.prisma.siteTechnician.findMany({ where: { organizationId: org, active: true, phone: { not: '' } }, orderBy: { name: 'asc' } });

    // ---- 1. The technician side of each open incident, and which devices are still failing.
    const faulty = new Map<string, Fault>();
    const watch = new Set<string>(); // device:category with an active incident: its checks are sent every tick
    for (const inc of active) {
      // The technician reacts to the alert: an agent outage is only raised after the stale window; a reopened incident restarts.
      const raised = Math.max(inc.firstDetectedAt.getTime() + (inc.category === 'agent_offline' ? cfg.staleAfterMinutes * MIN : 0), inc.lastReopenedAt?.getTime() ?? 0);
      const plan = feedPlan(inc.id, Math.max(raised, feedStart));
      if (inc.deviceId) watch.add(`${inc.deviceId}:${inc.category}`);
      if (inc.deviceId && t < plan.fixAt && inc.status !== 'RESTORATION_CHECK') faulty.set(`${inc.deviceId}:${inc.category}`, { kind: inc.category as Category, deviceId: inc.deviceId, since: inc.firstDetectedAt.getTime() });
      const person = techs.find((x) => x.id === inc.assignedTechnicianId) ?? techs.find((x) => x.siteId === inc.siteId && x.role === 'technician') ?? techs.find((x) => x.role === 'technician');
      if (!person?.phone) continue;
      let message: string | undefined;
      if (inc.status === 'OPEN' && t >= plan.ackAt) message = `ACK ${inc.number}`;
      else if ((inc.status === 'ACKNOWLEDGED' || inc.status === 'ASSIGNED') && t >= Math.min(plan.progressAt, Math.max(inc.acknowledgedAt?.getTime() ?? Infinity, feedStart) + (1 + (hash(inc.id) % 2)) * MIN)) message = `reached site ${inc.number}`;
      else if (inc.status === 'IN_PROGRESS' && t >= plan.fixAt && inc.category !== 'agent_offline' && inc.category !== 'status_unknown') message = `fixed ${inc.number} ${plan.pick(ROOT_CAUSE[inc.category] ?? ['issue fixed on site'])}`;
      if (!message) continue;
      try {
        await this.tech.generate({ organizationId: org, channel: 'whatsapp', phone: person.phone, message, metadata: { simulated: true, demoFeed: true } } as never, now);
        summary.actions.push(`${person.name}: ${message}`);
      } catch (error) {
        log.warn('visionops.demo_feed_reply_failed', { org, incident: inc.number, error: errorMessage(error) });
      }
    }

    // ---- 2. Close incidents the feed resolved a while ago (as a supervisor would after the customer confirms).
    const done = await this.prisma.downtimeIncident.findMany({ where: { organizationId: org, siteId: { in: siteIds }, status: 'RESOLVED', resolvedAt: { gte: new Date(feedStart), lt: new Date(t - 20 * MIN) } }, take: 5 });
    for (const d of done) {
      await this.incidents.close(org, d.id, 'user:Supervisor (simulated)', now, 'Customer confirmed the cameras are back (simulated demo).').catch(() => undefined);
      summary.closed++;
    }

    // ---- 3. Occasionally a new fault, keeping a realistic number of open incidents.
    const pend = this.pending.get(org) ?? new Map<string, Fault>();
    this.pending.set(org, pend);
    for (const [k, f] of pend) if (active.some((i) => i.deviceId === f.deviceId && i.category === f.kind) || t - f.since > 25 * MIN) pend.delete(k);
    for (const [k, f] of pend) faulty.set(k, f);
    const load = active.filter((i) => i.status !== 'RESTORATION_CHECK').length + pend.size;
    // Aim for roughly 3–8 open incidents: a new fault every few minutes while the fleet is calm, none when it is busy.
    const p = load < 3 ? 0.5 : load < 8 ? 0.3 : 0;
    if (this.random() < p) {
      const f = this.inject(sites, faulty, t);
      if (f) {
        pend.set(`${f.deviceId}:${f.kind}`, f);
        faulty.set(`${f.deviceId}:${f.kind}`, f);
        summary.injected.push(f.kind);
      }
    }

    // ---- 4. Each site's agent: heartbeat + this minute's checks (or queue them while "offline").
    for (const site of sites) {
      try {
        await this.site(org, site, faulty, watch, tick, now, summary);
        summary.sites++;
      } catch (error) {
        log.warn('visionops.demo_feed_site_failed', { org, site: site.code, error: errorMessage(error) });
      }
    }
    return summary;
  }

  private inject(sites: SiteRow[], faulty: Map<string, Fault>, t: number): Fault | undefined {
    const busy = (id: string) => [...faulty.values()].some((f) => f.deviceId === id);
    const live = sites.filter((s) => !s.agents.some((a) => faulty.has(`${a.id}:agent_offline`) || a.status === 'offline'));
    const cams = live.flatMap((s) => s.cameras).filter((c) => c.status === 'online' && !busy(c.id) && !(c.recorderId && busy(c.recorderId)));
    const capCams = (cap: string) => cams.filter((c) => (c.capabilities as Record<string, boolean> | null)?.[cap]);
    const recs = live.flatMap((s) => s.recorders).filter((r) => r.status === 'online' && !busy(r.id));
    const options: Array<[Category, number, string[]]> = [
      ['camera_unreachable', 0.63, cams.map((c) => c.id)],
      ['recorder_unreachable', 0.05, recs.map((r) => r.id)],
      ['stream_unavailable', 0.07, capCams('stream').map((c) => c.id)],
      ['recording_not_confirmed', 0.07, capCams('recording').map((c) => c.id)],
      ['storage_warning', 0.06, recs.filter((r) => (r.capabilities as Record<string, boolean> | null)?.storage).map((r) => r.id)],
      ['internet_outage', 0.06, live.filter((s) => s.agents.some((a) => a.hasBackupLink) && !busy(s.id)).map((s) => s.id)],
      ['agent_offline', 0.06, live.flatMap((s) => s.agents.filter((a) => !a.hasBackupLink).map((a) => a.id)).filter((id) => !busy(id))],
    ];
    let r = this.random();
    let chosen = options[0];
    for (const o of options) {
      if (r < o[1]) { chosen = o; break; }
      r -= o[1];
    }
    const pool = chosen[2].length ? chosen : options[0];
    if (!pool[2].length) return undefined;
    return { kind: pool[0], deviceId: pool[2][Math.floor(this.random() * pool[2].length)], since: t };
  }

  private async site(org: string, site: SiteRow, faulty: Map<string, Fault>, watch: Set<string>, tick: number, now: Date, summary: FeedSummary) {
    const t = now.getTime();
    const agent = site.agents[0];
    const agentDown = Boolean(agent && faulty.has(`${agent.id}:agent_offline`));
    const internetDown = faulty.has(`${site.id}:internet_outage`);
    const events: EventIn[] = [];
    let k = 0;
    const at = () => new Date(t - 1000 * (3 + (k++ % 25))).toISOString();
    const id = (code: string, check: string) => `df${t.toString(36)}-${code}-${check}`.slice(0, 80);
    const every = (key: string, n: number) => watch.has(key) || faulty.has(key) || tick % n === 1;
    const ms = (base: number) => base + Math.round(this.random() * base);

    const recorderDown = new Set<string>();
    for (const r of site.recorders) {
      if (r.status === 'maintenance') continue;
      const down = faulty.has(`${r.id}:recorder_unreachable`);
      if (down) recorderDown.add(r.id);
      events.push({ eventId: id(r.code, 'reach'), device: r.code, check: 'reachability', ok: !down, observedAt: at(), latencyMs: down ? undefined : ms(4), detail: down ? 'No TCP answer on the recorder service port (simulated)' : undefined });
      const cap = (r.capabilities ?? {}) as Record<string, boolean>;
      const key = `${r.id}:storage_warning`;
      if (!down && cap.storage && every(key, 5)) {
        const bad = faulty.has(key);
        events.push({ eventId: id(r.code, 'storage'), device: r.code, check: 'storage', ok: !bad, observedAt: at(), detail: bad ? 'Recorder reports a disk SMART warning (simulated)' : undefined });
      }
    }
    for (const c of site.cameras) {
      if (c.status === 'maintenance') continue;
      const down = faulty.has(`${c.id}:camera_unreachable`) || Boolean(c.recorderId && recorderDown.has(c.recorderId));
      events.push({ eventId: id(c.code, 'reach'), device: c.code, check: 'reachability', ok: !down, observedAt: at(), latencyMs: down ? undefined : ms(6), detail: down ? 'No TCP answer from the camera (simulated)' : undefined });
      if (down) continue;
      const cap = (c.capabilities ?? {}) as Record<string, boolean>;
      for (const [check, category, n] of [['stream', 'stream_unavailable', 3], ['recording', 'recording_not_confirmed', 5]] as const) {
        const key = `${c.id}:${category}`;
        if (!cap[check] || !every(key, n)) continue;
        const bad = faulty.has(key);
        events.push({ eventId: id(c.code, check), device: c.code, check, ok: !bad, observedAt: at(), detail: bad ? (check === 'stream' ? 'RTSP DESCRIBE failed (simulated)' : 'Recorder reports no recording on this channel (simulated)') : undefined });
      }
    }
    if (agent?.hasBackupLink) events.push({ eventId: id(site.code, 'internet'), deviceType: 'site', check: 'internet', ok: !internetDown, observedAt: at(), detail: internetDown ? 'Broadband down; agent reporting over 4G backup (simulated)' : undefined });

    if (agent && agentDown) {
      // The agent PC is "off": nothing reaches the cloud. Real agents keep checking locally; so does this one.
      const q = this.queued.get(agent.id) ?? [];
      q.push(...events);
      this.queued.set(agent.id, q.slice(-QUEUE_CAP));
      return;
    }
    const origin: Origin = agent ? { source: 'agent', agentId: agent.id, agentCode: agent.code, isDemo: true } : { source: 'cloud', isDemo: true };
    const backlog = agent ? this.queued.get(agent.id) : undefined;
    if (agent && backlog?.length) {
      await this.engine.heartbeat(org, agent.id, { sentAt: now.toISOString(), queueDepth: backlog.length, version: agent.version ?? '1.0.0', link: internetDown ? 'backup_4g' : 'primary' }, now);
      for (let i = 0; i < backlog.length; i += 500) await this.engine.ingest(org, site.id, origin, backlog.slice(i, i + 500), now);
      summary.replayed += backlog.length;
      this.queued.delete(agent.id);
    }
    if (events.length) {
      await this.engine.ingest(org, site.id, origin, events, now);
      summary.events += events.length;
    }
    if (agent) {
      await this.engine.heartbeat(org, agent.id, { sentAt: now.toISOString(), queueDepth: 0, version: agent.version ?? '1.0.0', link: internetDown ? 'backup_4g' : 'primary', uptimeSec: Math.round((t - Date.parse('2026-01-01')) / 1000) % 2_592_000 }, now);
      summary.heartbeats++;
    }
  }
}

type SiteRow = Awaited<ReturnType<PrismaService['monitoringSite']['findMany']>>[number] & {
  recorders: Awaited<ReturnType<PrismaService['recorderDevice']['findMany']>>;
  cameras: Awaited<ReturnType<PrismaService['cameraDevice']['findMany']>>;
  agents: Awaited<ReturnType<PrismaService['monitoringAgent']['findMany']>>;
};
