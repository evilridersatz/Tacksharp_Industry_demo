import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { errorMessage, log } from '../common/logger.js';
import { ACTIVE_STATES, CATEGORY_LABEL, triage, type Category, type DeviceType, type IncidentState } from './rules.js';
import { MonitoringNotifier } from './notifier.service.js';

export type Evidence = { at: string; check: string; ok: boolean; eventId?: string; source?: string };
export type RaiseInput = {
  org: string;
  siteId: string;
  deviceType: DeviceType;
  deviceId?: string | null;
  deviceCode?: string | null;
  category: Category;
  /** When the fault was confirmed (now, in event time). */
  at: Date;
  /** When the device first failed (the first failed check of the confirming run): downtime starts here. */
  since?: Date;
  critical?: boolean;
  /** For recorder / site / agent incidents: the cameras that are blind because of it. */
  affected?: string[];
  detail?: string;
  isDemo?: boolean;
};

export const deviceKey = (t: string, id: string | null | undefined) => `${t}:${id ?? '-'}`;
export const openKeyOf = (t: string, id: string | null | undefined, c: string) => `${deviceKey(t, id)}:${c}`;

/** The status an incident returns to when a restoration check fails (from what already happened to it). */
function statusBeforeCheck(i: { inProgressAt: Date | null; assignedAt: Date | null; acknowledgedAt: Date | null }): IncidentState {
  return i.inProgressAt ? 'IN_PROGRESS' : i.assignedAt ? 'ASSIGNED' : i.acknowledgedAt ? 'ACKNOWLEDGED' : 'OPEN';
}

/**
 * Incident lifecycle: OPEN → ACKNOWLEDGED → ASSIGNED → IN_PROGRESS → RESTORATION_CHECK → RESOLVED → CLOSED.
 *  - one active incident per device + fault (unique openKey): repeated failed checks never create duplicates;
 *  - a camera behind a failed recorder (or a site whose network / agent is down) is folded into that incident;
 *  - the same fault inside the correlation window after resolution REOPENS the incident;
 *  - RESOLVED needs fresh evidence: N consecutive successful checks after the failure. A person saying "fixed" moves it
 *    to RESTORATION_CHECK, never straight to RESOLVED, unless the device already passes fresh checks.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Optional() private readonly notifier?: MonitoringNotifier,
  ) {}

  private cfg(org: string) {
    return this.settings.get(org).then((s) => s.monitoring);
  }

  timeline(org: string, incidentId: string, type: string, message: string, actor = 'system', data?: unknown, at = new Date(), tx: Prisma.TransactionClient = this.prisma) {
    return tx.incidentTimelineEvent.create({ data: { organizationId: org, incidentId, type, message: message.slice(0, 2000), actor, at, ...(data === undefined ? {} : { data: data as Prisma.InputJsonValue }) } });
  }

  private async nextNumber(org: string, tx: Prisma.TransactionClient) {
    const count = await tx.downtimeIncident.count({ where: { organizationId: org } });
    return `INC-${1001 + count}`;
  }

  /** A host incident (recorder / network / agent) at the site that this device's fault belongs to, if any. */
  private async hostIncident(input: RaiseInput) {
    if (input.deviceType === 'camera' && input.deviceId) {
      const cam = await this.prisma.cameraDevice.findFirst({ where: { id: input.deviceId, organizationId: input.org }, select: { recorderId: true } });
      if (cam?.recorderId) {
        const host = await this.prisma.downtimeIncident.findFirst({ where: { organizationId: input.org, openKey: openKeyOf('recorder', cam.recorderId, 'recorder_unreachable') } });
        if (host) return host;
      }
    }
    if (input.deviceType === 'camera' || input.deviceType === 'recorder') {
      return this.prisma.downtimeIncident.findFirst({
        where: { organizationId: input.org, siteId: input.siteId, status: { in: ACTIVE_STATES }, category: { in: ['network_lost', 'agent_offline'] } },
        orderBy: { firstDetectedAt: 'asc' },
      });
    }
    return null;
  }

  /**
   * A confirmed fault. Returns the incident and what happened: created | reopened | existing (duplicate suppressed) |
   * folded (added to a recorder / site incident).
   */
  async raise(input: RaiseInput): Promise<{ incident: Awaited<ReturnType<IncidentsService['get']>> | null; outcome: 'created' | 'reopened' | 'existing' | 'folded' }> {
    const cfg = await this.cfg(input.org);
    const openKey = openKeyOf(input.deviceType, input.deviceId, input.category);

    const existing = await this.prisma.downtimeIncident.findFirst({ where: { organizationId: input.org, openKey } });
    if (existing) {
      await this.prisma.downtimeIncident.update({ where: { id: existing.id }, data: { lastCheckedAt: input.at > existing.lastCheckedAt ? input.at : existing.lastCheckedAt } });
      return { incident: existing as never, outcome: 'existing' };
    }

    // Folding: one incident for the root cause, not one per blind camera.
    if (input.deviceType === 'camera' || (input.deviceType === 'recorder' && input.category === 'recorder_unreachable')) {
      const host = await this.hostIncident(input);
      if (host && host.openKey !== openKey) {
        const affected = new Set<string>(Array.isArray(host.affectedDevices) ? (host.affectedDevices as string[]) : []);
        if (input.deviceCode && !affected.has(input.deviceCode)) {
          affected.add(input.deviceCode);
          await this.prisma.downtimeIncident.update({ where: { id: host.id }, data: { affectedDevices: [...affected], affectedCount: Math.max(host.affectedCount, affected.size), lastCheckedAt: input.at } });
          await this.timeline(input.org, host.id, 'correlated', `${input.deviceCode}: ${CATEGORY_LABEL[input.category]} is explained by ${host.number} (${CATEGORY_LABEL[host.category as Category] ?? host.category}); no separate incident opened.`, 'system', undefined, input.at);
        }
        return { incident: host as never, outcome: 'folded' };
      }
    }

    // Reopen: the same fault on the same device soon after it was resolved.
    const correlationKey = openKey;
    const windowStart = new Date(input.at.getTime() - cfg.correlationWindowMinutes * 60_000);
    const recent = cfg.correlationWindowMinutes > 0
      ? await this.prisma.downtimeIncident.findFirst({ where: { organizationId: input.org, correlationKey, status: { in: ['RESOLVED', 'CLOSED'] }, resolvedAt: { gte: windowStart }, resolvedBy: { not: 'correlation' } }, orderBy: { resolvedAt: 'desc' } })
      : null;
    if (recent) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.downtimeIncident.update({
            where: { id: recent.id },
            data: { status: 'OPEN', openKey, reopenCount: { increment: 1 }, lastReopenedAt: input.at, lastCheckedAt: input.at, resolvedAt: null, closedAt: null, resolvedBy: null, restorationCheckAt: null, restorationEvidence: Prisma.JsonNull, acknowledgedAt: null, acknowledgedBy: null, escalationLevel: 0, nextEscalationAt: new Date(input.at.getTime() + cfg.ackDeadlineMinutes * 60_000) },
          });
          await this.timeline(input.org, recent.id, 'reopened', `The fault came back ${Math.round((input.at.getTime() - recent.resolvedAt!.getTime()) / 60_000)} min after resolution (inside the ${cfg.correlationWindowMinutes}-minute correlation window): incident reopened.`, 'system', undefined, input.at, tx);
        });
        const inc = await this.get(input.org, recent.id);
        await this.notifier?.onOpened(inc!, input.at).catch((e) => log.warn('visionops.notify_failed', { error: errorMessage(e) }));
        return { incident: inc, outcome: 'reopened' };
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
        const again = await this.prisma.downtimeIncident.findFirst({ where: { organizationId: input.org, openKey } });
        return { incident: again as never, outcome: 'existing' };
      }
    }

    const site = await this.prisma.monitoringSite.findFirst({ where: { id: input.siteId, organizationId: input.org }, select: { customerId: true, name: true, isDemo: true } });
    if (!site) throw new NotFoundException('Site not found');
    const severity = triage(input.category, { critical: input.critical, affected: input.affected?.length });
    const title = `${CATEGORY_LABEL[input.category]}${input.deviceCode ? `: ${input.deviceCode}` : ''} at ${site.name}`;
    let created: { id: string } | undefined;
    for (let attempt = 0; attempt < 6 && !created; attempt++) {
      try {
        created = await this.prisma.$transaction(async (tx) => {
          const number = await this.nextNumber(input.org, tx).then((n) => (attempt ? `INC-${Number(n.slice(4)) + attempt}` : n));
          const inc = await tx.downtimeIncident.create({
            data: {
              organizationId: input.org, number, siteId: input.siteId, customerId: site.customerId, deviceType: input.deviceType, deviceId: input.deviceId ?? null, deviceCode: input.deviceCode ?? null,
              category: input.category, severity, status: 'OPEN', title: title.slice(0, 190), affectedCount: Math.max(1, input.affected?.length ?? 1), affectedDevices: input.affected ?? (input.deviceCode ? [input.deviceCode] : []),
              firstDetectedAt: input.since && input.since < input.at ? input.since : input.at, lastCheckedAt: input.at, openKey, correlationKey, nextEscalationAt: new Date(input.at.getTime() + cfg.ackDeadlineMinutes * 60_000), isDemo: Boolean(input.isDemo ?? site.isDemo),
            },
          });
          await this.timeline(input.org, inc.id, 'detected', `${CATEGORY_LABEL[input.category]} confirmed after ${cfg.failureThreshold} failed checks (debounce ${cfg.debounceSeconds}s).${input.detail ? ` ${input.detail}` : ''}`, 'system', { severity, rule: 'deterministic' }, input.at, tx);
          return inc;
        });
      } catch (error) {
        const code = (error as { code?: string; meta?: { target?: unknown } }).code;
        if (code !== 'P2002') throw error;
        // Another request opened the same incident first (openKey), or took the number: re-check.
        const again = await this.prisma.downtimeIncident.findFirst({ where: { organizationId: input.org, openKey } });
        if (again) return { incident: again as never, outcome: 'existing' };
      }
    }
    if (!created) throw new ConflictException('Could not allocate an incident number');

    // A recorder / site incident absorbs the camera incidents it explains.
    if (input.category === 'recorder_unreachable' || input.category === 'network_lost' || input.category === 'agent_offline') await this.absorb(input, created.id);

    const inc = await this.get(input.org, created.id);
    await this.notifier?.onOpened(inc!, input.at).catch((e) => log.warn('visionops.notify_failed', { error: errorMessage(e) }));
    return { incident: inc, outcome: 'created' };
  }

  private async absorb(input: RaiseInput, hostId: string) {
    const host = await this.prisma.downtimeIncident.findUnique({ where: { id: hostId } });
    if (!host) return;
    const cameraIds = input.category === 'recorder_unreachable'
      ? (await this.prisma.cameraDevice.findMany({ where: { organizationId: input.org, recorderId: input.deviceId ?? '-' }, select: { id: true } })).map((c) => c.id)
      : (await this.prisma.cameraDevice.findMany({ where: { organizationId: input.org, siteId: input.siteId }, select: { id: true } })).map((c) => c.id);
    const children = await this.prisma.downtimeIncident.findMany({
      where: { organizationId: input.org, id: { not: hostId }, status: { in: ACTIVE_STATES }, OR: [{ deviceType: 'camera', deviceId: { in: cameraIds } }, ...(input.category !== 'recorder_unreachable' ? [{ siteId: input.siteId, deviceType: 'recorder' }] : [])] },
    });
    for (const c of children) {
      await this.prisma.$transaction(async (tx) => {
        await tx.downtimeIncident.update({ where: { id: c.id }, data: { status: 'CLOSED', openKey: null, closedAt: input.at, resolvedAt: input.at, resolvedBy: 'correlation', rootCause: `Merged into ${host.number}: ${CATEGORY_LABEL[host.category as Category]}.` } });
        await this.timeline(input.org, c.id, 'correlated', `Merged into ${host.number} (${CATEGORY_LABEL[host.category as Category]}): the same root cause.`, 'system', undefined, input.at, tx);
        await this.timeline(input.org, host.id, 'correlated', `${c.number} (${c.deviceCode ?? c.category}) merged into this incident.`, 'system', undefined, input.at, tx);
      });
    }
  }

  /** A fresh successful check for a device + fault: restoration evidence. Resolves after N consecutive successes. */
  async recordSuccess(org: string, openKey: string, ev: Evidence, at: Date) {
    const inc = await this.prisma.downtimeIncident.findFirst({ where: { organizationId: org, openKey } });
    if (!inc) return null;
    const cfg = await this.cfg(org);
    const prior = inc.status === 'RESTORATION_CHECK' && Array.isArray(inc.restorationEvidence) ? (inc.restorationEvidence as Evidence[]) : [];
    // Only evidence newer than the last failure counts; the same check is never counted twice.
    if (prior.some((p) => p.eventId && p.eventId === ev.eventId) || new Date(ev.at) < inc.lastCheckedAt) return inc;
    const evidence = [...prior, ev].slice(-20);
    if (inc.status !== 'RESTORATION_CHECK') {
      await this.prisma.downtimeIncident.update({ where: { id: inc.id }, data: { status: 'RESTORATION_CHECK', restorationCheckAt: at, restorationEvidence: evidence as never } });
      await this.timeline(org, inc.id, 'restoration_check', `${inc.deviceCode ?? 'Device'} responded again (${ev.check}). Restoration check started: ${cfg.restoreSuccesses} consecutive successful checks needed.`, 'system', { evidence: ev }, at);
    } else {
      await this.prisma.downtimeIncident.update({ where: { id: inc.id }, data: { restorationEvidence: evidence as never } });
    }
    if (evidence.length >= cfg.restoreSuccesses) return this.resolveVerified(org, inc.id, evidence, at);
    return inc;
  }

  /** A failed check while an incident exists: keeps it current; a failure during the restoration check resets it. */
  async recordFailure(org: string, openKey: string, at: Date, detail?: string) {
    const inc = await this.prisma.downtimeIncident.findFirst({ where: { organizationId: org, openKey } });
    if (!inc) return null;
    if (inc.status === 'RESTORATION_CHECK') {
      const back = statusBeforeCheck(inc);
      await this.prisma.downtimeIncident.update({ where: { id: inc.id }, data: { status: back, restorationCheckAt: null, restorationEvidence: Prisma.JsonNull, lastCheckedAt: at } });
      await this.timeline(org, inc.id, 'note', `Restoration check failed: ${inc.deviceCode ?? 'the device'} failed again${detail ? ` (${detail})` : ''}. Back to ${back}.`, 'system', undefined, at);
    } else if (at > inc.lastCheckedAt) {
      await this.prisma.downtimeIncident.update({ where: { id: inc.id }, data: { lastCheckedAt: at } });
    }
    return inc;
  }

  private async resolveVerified(org: string, id: string, evidence: Evidence[], at: Date, rootCause?: string) {
    const inc = await this.prisma.downtimeIncident.findUnique({ where: { id } });
    if (!inc || !ACTIVE_STATES.includes(inc.status as IncidentState)) return inc;
    await this.prisma.$transaction(async (tx) => {
      await tx.downtimeIncident.update({
        where: { id },
        data: { status: 'RESOLVED', openKey: null, resolvedAt: at, resolvedBy: 'verification', restorationEvidence: evidence as never, nextEscalationAt: null, rootCause: inc.rootCause ?? rootCause ?? null },
      });
      await this.timeline(org, id, 'resolved', `Restoration verified by ${evidence.length} consecutive successful checks (${evidence.map((e) => e.check).join(', ')}).${rootCause && !inc.rootCause ? ` Root cause: ${rootCause}` : ''}`, 'system', { evidence }, at, tx);
    });
    const done = await this.get(org, id);
    await this.notifier?.onRestored(done!, evidence.length, at).catch((e) => log.warn('visionops.notify_failed', { error: errorMessage(e) }));
    return done;
  }

  /** Agent incident: resolved by heartbeats, with the root cause read from what the agent synced. */
  async resolveAgentIncident(org: string, agentId: string, evidence: Evidence, at: Date) {
    const key = openKeyOf('agent', agentId, 'agent_offline');
    const inc = await this.prisma.downtimeIncident.findFirst({ where: { organizationId: org, openKey: key } });
    if (!inc) return null;
    const replayed = await this.prisma.healthEvent.count({ where: { organizationId: org, agentId, replayed: true, observedAt: { gte: inc.firstDetectedAt, lte: at } } });
    const cause = replayed > 0
      ? `Site internet outage: the local agent kept monitoring and synced ${replayed} queued events after reconnecting`
      : 'The agent stopped reporting (agent PC or power off, or the agent was stopped); there is no monitoring data for the gap';
    await this.prisma.downtimeIncident.update({ where: { id: inc.id }, data: { rootCause: inc.rootCause ?? cause } });
    return this.recordSuccess(org, key, evidence, at);
  }

  // ------------------------------------------------------------------ people (dashboard / WhatsApp)

  async get(org: string, id: string) {
    return this.prisma.downtimeIncident.findFirst({
      where: { id, organizationId: org },
      include: { site: { select: { id: true, name: true, code: true, customerId: true, customer: { select: { id: true, name: true, contactName: true, contactPhone: true, notifyOnResolution: true } } } }, assignedTechnician: { select: { id: true, name: true, phone: true, role: true } } },
    });
  }

  private async load(org: string, id: string) {
    const inc = await this.prisma.downtimeIncident.findFirst({ where: { id, organizationId: org } });
    if (!inc) throw new NotFoundException('Incident not found');
    return inc;
  }

  async acknowledge(org: string, id: string, actor: string, at = new Date(), via = 'dashboard') {
    const inc = await this.load(org, id);
    if (!ACTIVE_STATES.includes(inc.status as IncidentState)) throw new BadRequestException(`${inc.number} is ${inc.status}; nothing to acknowledge.`);
    if (inc.acknowledgedAt) return { incident: await this.get(org, id), already: true };
    await this.prisma.$transaction(async (tx) => {
      await tx.downtimeIncident.update({ where: { id }, data: { acknowledgedAt: at, acknowledgedBy: actor, status: inc.status === 'OPEN' ? 'ACKNOWLEDGED' : inc.status, nextEscalationAt: null } });
      await this.timeline(org, id, 'acknowledged', `Acknowledged by ${actor.replace(/^\w+:/, '')} (${via}).`, actor, undefined, at, tx);
    });
    return { incident: await this.get(org, id), already: false };
  }

  async assign(org: string, id: string, technicianId: string, actor: string, at = new Date()) {
    const inc = await this.load(org, id);
    if (!ACTIVE_STATES.includes(inc.status as IncidentState)) throw new BadRequestException(`${inc.number} is ${inc.status}.`);
    const tech = await this.prisma.siteTechnician.findFirst({ where: { id: technicianId, organizationId: org, active: true } });
    if (!tech) throw new BadRequestException('Unknown or inactive technician');
    await this.prisma.$transaction(async (tx) => {
      await tx.downtimeIncident.update({
        where: { id },
        data: { assignedTechnicianId: tech.id, assignedAt: at, acknowledgedAt: inc.acknowledgedAt ?? at, acknowledgedBy: inc.acknowledgedBy ?? actor, nextEscalationAt: null, status: ['OPEN', 'ACKNOWLEDGED'].includes(inc.status) ? 'ASSIGNED' : inc.status },
      });
      await this.timeline(org, id, 'assigned', `Assigned to ${tech.name} (${tech.role}).`, actor, { technicianId: tech.id }, at, tx);
    });
    return this.get(org, id);
  }

  async start(org: string, id: string, actor: string, at = new Date(), note?: string) {
    const inc = await this.load(org, id);
    if (!['OPEN', 'ACKNOWLEDGED', 'ASSIGNED'].includes(inc.status)) {
      if (inc.status === 'IN_PROGRESS') return this.get(org, id);
      throw new BadRequestException(`${inc.number} is ${inc.status}.`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.downtimeIncident.update({ where: { id }, data: { status: 'IN_PROGRESS', inProgressAt: at, acknowledgedAt: inc.acknowledgedAt ?? at, acknowledgedBy: inc.acknowledgedBy ?? actor, nextEscalationAt: null } });
      await this.timeline(org, id, 'in_progress', `Work started${note ? `: ${note}` : ''}.`, actor, undefined, at, tx);
    });
    return this.get(org, id);
  }

  /**
   * A person reports the fault fixed. Resolved only with fresh evidence: the device must already pass N consecutive
   * successful checks observed after the incident started; otherwise the incident waits in RESTORATION_CHECK.
   */
  async requestResolve(org: string, id: string, actor: string, input: { rootCause?: string; note?: string }, at = new Date()) {
    const inc = await this.load(org, id);
    if (!ACTIVE_STATES.includes(inc.status as IncidentState)) throw new BadRequestException(`${inc.number} is ${inc.status}.`);
    const cfg = await this.cfg(org);
    const rootCause = input.rootCause?.trim().slice(0, 500) || undefined;
    const note = input.note?.trim().slice(0, 1000) || undefined;
    await this.prisma.downtimeIncident.update({ where: { id }, data: { ...(rootCause ? { rootCause } : {}), ...(note ? { resolutionNote: note } : {}) } });
    await this.timeline(org, id, 'note', `Reported fixed by ${actor.replace(/^\w+:/, '')}${rootCause ? `. Cause: ${rootCause}` : ''}${note ? `. ${note}` : ''}.`, actor, undefined, at);

    const evidence = await this.freshEvidence(org, inc, cfg.restoreSuccesses);
    if (evidence.length >= cfg.restoreSuccesses) {
      const done = await this.resolveVerified(org, id, evidence, at, rootCause);
      return { incident: done ? await this.get(org, id) : null, resolved: true, needed: 0 };
    }
    if (inc.status !== 'RESTORATION_CHECK') {
      await this.prisma.downtimeIncident.update({ where: { id }, data: { status: 'RESTORATION_CHECK', restorationCheckAt: at, restorationEvidence: evidence as never } });
      await this.timeline(org, id, 'restoration_check', `Waiting for fresh monitoring evidence: ${cfg.restoreSuccesses} consecutive successful checks (have ${evidence.length}). Not resolved on a report alone.`, 'system', undefined, at);
    }
    return { incident: await this.get(org, id), resolved: false, needed: cfg.restoreSuccesses - evidence.length };
  }

  /** The newest consecutive successful checks for the incident's device + check, observed after the last failure. */
  private async freshEvidence(org: string, inc: { deviceType: string; deviceId: string | null; category: string; lastCheckedAt: Date; firstDetectedAt: Date }, need: number): Promise<Evidence[]> {
    const check = inc.category === 'camera_unreachable' || inc.category === 'recorder_unreachable' ? 'reachability'
      : inc.category === 'stream_unavailable' ? 'stream' : inc.category === 'recording_not_confirmed' ? 'recording'
        : inc.category === 'storage_warning' ? 'storage' : inc.category === 'network_lost' ? 'gateway' : inc.category === 'internet_outage' ? 'internet' : null;
    if (!check || (!inc.deviceId && inc.deviceType !== 'site')) return [];
    const rows = await this.prisma.healthEvent.findMany({
      where: { organizationId: org, check, ...(inc.deviceType === 'site' ? { deviceType: 'site' } : { deviceId: inc.deviceId }), observedAt: { gt: inc.firstDetectedAt } },
      orderBy: { observedAt: 'desc' }, take: Math.max(need * 2, 6),
    });
    const out: Evidence[] = [];
    for (const r of rows) {
      if (!r.ok) break;
      out.push({ at: r.observedAt.toISOString(), check: r.check, ok: true, eventId: r.externalId ?? r.id, source: r.source });
    }
    return out.reverse().slice(-need);
  }

  async close(org: string, id: string, actor: string, at = new Date(), note?: string) {
    const inc = await this.load(org, id);
    if (inc.status !== 'RESOLVED') throw new BadRequestException(`Only a RESOLVED incident can be closed (${inc.number} is ${inc.status}).`);
    await this.prisma.$transaction(async (tx) => {
      await tx.downtimeIncident.update({ where: { id }, data: { status: 'CLOSED', closedAt: at, ...(note ? { resolutionNote: [inc.resolutionNote, note].filter(Boolean).join('\n') } : {}) } });
      await this.timeline(org, id, 'closed', `Closed${note ? `: ${note}` : ''}.`, actor, undefined, at, tx);
    });
    return this.get(org, id);
  }

  async note(org: string, id: string, actor: string, message: string, at = new Date()) {
    await this.load(org, id);
    const text = message.trim().slice(0, 1000);
    if (!text) throw new BadRequestException('Write a note');
    await this.timeline(org, id, 'note', text, actor, undefined, at);
    return this.get(org, id);
  }
}
