import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { normalizePhone } from '../common/phone.js';
import { ACTIVE_STATES, CATEGORY_LABEL, maskAddress, maskPhone, troubleshooting, type Category } from './rules.js';
import { newAgentToken } from './agent-auth.js';

const DOWN: Category[] = ['camera_unreachable', 'recorder_unreachable', 'network_lost', 'stream_unavailable'];
const UNKNOWN: Category[] = ['agent_offline', 'status_unknown'];
const DAY = 86_400_000;
const IST = 330 * 60_000;
const istDay = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
const dayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const cap = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, boolean>) : {});
const str = (v: unknown, max = 191) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const code = (v: unknown) => str(v, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');

type Filters = { customerId?: string; siteId?: string; region?: string; industry?: string; includeLab?: boolean };
/** Site codes starting with LAB- are the demo scenario lab: excluded from fleet KPIs, site lists and reports. */
const NOT_LAB = { NOT: { code: { startsWith: 'LAB-' } } };
/** Whitelisted camera orderings (anything else falls back to site, code). MySQL puts never-seen (NULL) cameras first on ascending order. */
const CAMERA_SORT: Record<string, Prisma.CameraDeviceOrderByWithRelationInput[]> = {
  '': [{ siteId: 'asc' }, { code: 'asc' }],
  code: [{ code: 'asc' }],
  status: [{ consecutiveFailures: 'desc' }, { failingSince: 'asc' }, { code: 'asc' }],
  lastSeen: [{ lastSeenAt: 'asc' }, { code: 'asc' }],
};

/** Read models and management for the VisionOps dashboard. Every query is scoped to the caller's organization. */
@Injectable()
export class MonitoringService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  private async siteIds(org: string, f: Filters): Promise<string[] | undefined> {
    if (!f.customerId && !f.siteId && !f.region && !f.industry && f.includeLab) return undefined;
    const rows = await this.prisma.monitoringSite.findMany({
      where: { organizationId: org, ...(f.siteId ? { id: f.siteId } : f.includeLab ? {} : NOT_LAB), ...(f.customerId ? { customerId: f.customerId } : {}), ...(f.region ? { region: f.region } : {}), ...(f.industry ? { customer: { industry: f.industry } } : {}) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------ uptime (computed from incidents)

  /**
   * Camera-minutes per site per IST day. Down = camera / recorder unreachable, stream unavailable, site network lost
   * (a recorder or network incident counts every affected camera). Unknown = agent silent / stale data: neither up nor
   * down, excluded from the uptime % (it is reported separately).
   */
  async uptime(org: string, from: Date, to: Date, ids?: string[]) {
    const sites = await this.prisma.monitoringSite.findMany({ where: { organizationId: org, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, name: true, code: true, customerId: true, _count: { select: { cameras: true } } } });
    const incidents = await this.prisma.downtimeIncident.findMany({
      where: { organizationId: org, siteId: { in: sites.map((s) => s.id) }, category: { in: [...DOWN, ...UNKNOWN] }, firstDetectedAt: { lt: to }, OR: [{ resolvedAt: null }, { resolvedAt: { gt: from } }] },
      select: { siteId: true, category: true, affectedCount: true, firstDetectedAt: true, resolvedAt: true, closedAt: true, resolvedBy: true },
    });
    const days: string[] = [];
    for (let t = dayStart(istDay(from)).getTime(); t < to.getTime(); t += DAY) days.push(istDay(new Date(t + 1)));
    const per = new Map<string, { total: number; down: number; unknown: number }>();
    const key = (s: string, d: string) => `${s}|${d}`;
    for (const s of sites) for (const d of days) {
      const ds = Math.max(dayStart(d).getTime(), from.getTime()), de = Math.min(dayStart(d).getTime() + DAY, to.getTime());
      per.set(key(s.id, d), { total: Math.max(0, Math.round((de - ds) / 60_000)) * s._count.cameras, down: 0, unknown: 0 });
    }
    const now = Date.now();
    for (const i of incidents) {
      const start = Math.max(i.firstDetectedAt.getTime(), from.getTime());
      const end = Math.min((i.resolvedAt ?? i.closedAt)?.getTime() ?? now, to.getTime());
      if (end <= start) continue;
      const cams = i.category === 'camera_unreachable' || i.category === 'stream_unavailable' ? 1 : Math.max(1, i.affectedCount);
      for (const d of days) {
        const ds = dayStart(d).getTime(), de = ds + DAY;
        const overlap = Math.min(end, de) - Math.max(start, ds);
        if (overlap <= 0) continue;
        const cell = per.get(key(i.siteId, d));
        if (!cell) continue;
        const m = Math.round(overlap / 60_000) * cams;
        if (UNKNOWN.includes(i.category as Category)) cell.unknown += m;
        else cell.down += m;
      }
    }
    const pct = (c: { total: number; down: number; unknown: number }) => {
      const measured = c.total - Math.min(c.unknown, c.total);
      return measured > 0 ? Math.max(0, Math.round(((measured - Math.min(c.down, measured)) / measured) * 100_000) / 1000) : null;
    };
    const bySite = sites.map((s) => {
      const tot = days.reduce((a, d) => { const c = per.get(key(s.id, d))!; return { total: a.total + c.total, down: a.down + c.down, unknown: a.unknown + c.unknown }; }, { total: 0, down: 0, unknown: 0 });
      return { siteId: s.id, site: s.name, code: s.code, customerId: s.customerId, cameras: s._count.cameras, cameraMinutes: tot.total, downMinutes: tot.down, unknownMinutes: tot.unknown, uptimePct: pct(tot) };
    });
    const byDay = days.map((d) => {
      const tot = sites.reduce((a, s) => { const c = per.get(key(s.id, d))!; return { total: a.total + c.total, down: a.down + c.down, unknown: a.unknown + c.unknown }; }, { total: 0, down: 0, unknown: 0 });
      return { day: d, uptimePct: pct(tot), downMinutes: tot.down, unknownMinutes: tot.unknown };
    });
    const all = bySite.reduce((a, s) => ({ total: a.total + s.cameraMinutes, down: a.down + s.downMinutes, unknown: a.unknown + s.unknownMinutes }), { total: 0, down: 0, unknown: 0 });
    return { from: from.toISOString(), to: to.toISOString(), uptimePct: pct(all), downMinutes: all.down, unknownMinutes: all.unknown, bySite, byDay };
  }

  /** Daily uptime rows (SiteUptimeSnapshot) for reporting history; recomputed idempotently. */
  async snapshot(org: string, days: number, now = new Date()) {
    const today = istDay(now);
    let written = 0;
    for (let k = 1; k <= days; k++) {
      const day = istDay(new Date(dayStart(today).getTime() - k * DAY + 1));
      const from = dayStart(day), to = new Date(from.getTime() + DAY);
      const u = await this.uptime(org, from, to);
      for (const s of u.bySite) {
        const incidents = await this.prisma.downtimeIncident.count({ where: { organizationId: org, siteId: s.siteId, firstDetectedAt: { gte: from, lt: to } } });
        const site = await this.prisma.monitoringSite.findUnique({ where: { id: s.siteId }, select: { isDemo: true } });
        const data = { cameraMinutesTotal: s.cameraMinutes, cameraMinutesDown: s.downMinutes, cameraMinutesUnknown: s.unknownMinutes, uptimePct: s.uptimePct ?? 100, incidents, isDemo: Boolean(site?.isDemo) };
        await this.prisma.siteUptimeSnapshot.upsert({ where: { siteId_day: { siteId: s.siteId, day: new Date(`${day}T00:00:00Z`) } }, create: { organizationId: org, siteId: s.siteId, day: new Date(`${day}T00:00:00Z`), ...data }, update: data });
        written++;
      }
    }
    return { written };
  }

  // ------------------------------------------------------------------ overview

  async overview(org: string, f: Filters & { days?: number }, now = new Date()) {
    const days = Math.min(90, Math.max(1, Math.round(f.days ?? 30)));
    const ids = await this.siteIds(org, f);
    const siteWhere = { organizationId: org, ...(ids ? { id: { in: ids } } : {}) };
    const devWhere = { organizationId: org, ...(ids ? { siteId: { in: ids } } : {}) };
    const from = new Date(now.getTime() - days * DAY);
    const [customers, sites, camStatus, recorders, active, period, agents] = await Promise.all([
      this.prisma.monitoringCustomer.count({ where: { organizationId: org, ...(ids ? (f.customerId || f.siteId || f.region || f.industry ? { sites: { some: { id: { in: ids } } } } : { OR: [{ sites: { none: {} } }, { sites: { some: { id: { in: ids } } } }] }) : {}) } }),
      this.prisma.monitoringSite.count({ where: siteWhere }),
      this.prisma.cameraDevice.groupBy({ by: ['status'], where: devWhere, _count: { _all: true } }),
      this.prisma.recorderDevice.groupBy({ by: ['status'], where: devWhere, _count: { _all: true } }),
      this.prisma.downtimeIncident.findMany({ where: { ...devWhere, status: { in: ACTIVE_STATES } }, select: { id: true, siteId: true, category: true, severity: true, acknowledgedAt: true, affectedCount: true } }),
      this.prisma.downtimeIncident.findMany({ where: { ...devWhere, firstDetectedAt: { gte: from }, resolvedBy: { not: 'correlation' } }, select: { firstDetectedAt: true, acknowledgedAt: true, resolvedAt: true, category: true, siteId: true, severity: true } }),
      this.prisma.monitoringAgent.groupBy({ by: ['status'], where: devWhere, _count: { _all: true } }),
    ]);
    const cs = Object.fromEntries(camStatus.map((c) => [c.status, c._count._all]));
    const cameras = camStatus.reduce((a, c) => a + c._count._all, 0);
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const mtta = avg(period.filter((i) => i.acknowledgedAt).map((i) => (i.acknowledgedAt!.getTime() - i.firstDetectedAt.getTime()) / 60_000));
    const mttr = avg(period.filter((i) => i.resolvedAt).map((i) => (i.resolvedAt!.getTime() - i.firstDetectedAt.getTime()) / 60_000));
    const outageSites = new Set(active.filter((i) => ['network_lost', 'agent_offline', 'internet_outage', 'recorder_unreachable'].includes(i.category)).map((i) => i.siteId));
    const up = await this.uptime(org, from, now, ids);
    const siteNames = Object.fromEntries((await this.prisma.monitoringSite.findMany({ where: siteWhere, select: { id: true, name: true } })).map((s) => [s.id, s.name]));

    // weekly MTTA / MTTR
    const weeks = new Map<string, { a: number[]; r: number[]; n: number }>();
    for (const i of period) {
      const wk = istDay(new Date(i.firstDetectedAt.getTime() - ((new Date(i.firstDetectedAt.getTime() + IST).getUTCDay() + 6) % 7) * DAY));
      const w = weeks.get(wk) ?? { a: [], r: [], n: 0 };
      w.n++;
      if (i.acknowledgedAt) w.a.push((i.acknowledgedAt.getTime() - i.firstDetectedAt.getTime()) / 60_000);
      if (i.resolvedAt) w.r.push((i.resolvedAt.getTime() - i.firstDetectedAt.getTime()) / 60_000);
      weeks.set(wk, w);
    }
    const byDay = new Map<string, number>();
    for (const i of period) byDay.set(istDay(i.firstDetectedAt), (byDay.get(istDay(i.firstDetectedAt)) ?? 0) + 1);
    const cats = new Map<string, number>();
    for (const i of period) cats.set(i.category, (cats.get(i.category) ?? 0) + 1);

    return {
      days, generatedAt: now.toISOString(), demo: Boolean((await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } }))?.isDemo),
      kpis: {
        customers, sites, cameras, recorders: recorders.reduce((a, r) => a + r._count._all, 0),
        online: cs.online ?? 0, offline: cs.offline ?? 0, unknown: cs.unknown ?? 0, degraded: cs.degraded ?? 0, maintenance: cs.maintenance ?? 0,
        recordersOffline: recorders.find((r) => r.status === 'offline')?._count._all ?? 0,
        activeIncidents: active.length, critical: active.filter((i) => i.severity === 'critical').length, unacknowledged: active.filter((i) => !i.acknowledgedAt).length,
        mttaMinutes: mtta, mttrMinutes: mttr, uptimePct: up.uptimePct, sitesWithOutage: outageSites.size,
        agentsOnline: agents.find((a) => a.status === 'online')?._count._all ?? 0, agentsOffline: agents.find((a) => a.status === 'offline')?._count._all ?? 0,
      },
      charts: {
        availability: up.byDay.map((d) => ({ day: d.day, uptimePct: d.uptimePct, unknownMinutes: d.unknownMinutes })),
        downtimeBySite: up.bySite.map((s) => ({ site: s.site, downMinutes: s.downMinutes, unknownMinutes: s.unknownMinutes, uptimePct: s.uptimePct })).sort((a, b) => b.downMinutes - a.downMinutes),
        byRootCause: [...cats.entries()].map(([k, v]) => ({ category: k, label: CATEGORY_LABEL[k as Category] ?? k, count: v })).sort((a, b) => b.count - a.count),
        responseByWeek: [...weeks.entries()].sort().map(([wk, w]) => ({ week: wk, incidents: w.n, mttaMinutes: avg(w.a), mttrMinutes: avg(w.r) })),
        incidentsByDay: up.byDay.map((d) => ({ day: d.day, incidents: byDay.get(d.day) ?? 0 })),
        statusMix: camStatus.map((c) => ({ status: c.status, count: c._count._all })),
      },
      activeBySite: [...active.reduce((m, i) => m.set(i.siteId, (m.get(i.siteId) ?? 0) + 1), new Map<string, number>()).entries()].map(([id, n]) => ({ siteId: id, site: siteNames[id] ?? id, incidents: n })),
      notes: ['Uptime = camera-minutes not inside a down incident ÷ measured camera-minutes. Minutes while an agent was silent count as UNKNOWN and are excluded, not counted as up.'],
    };
  }

  // ------------------------------------------------------------------ sites

  async customers(org: string) {
    const rows = await this.prisma.monitoringCustomer.findMany({ where: { organizationId: org, OR: [{ sites: { none: {} } }, { sites: { some: NOT_LAB } }] }, orderBy: { name: 'asc' }, include: { _count: { select: { sites: true } }, contracts: { orderBy: { endDate: 'desc' }, take: 1 } } });
    return rows.map((c) => ({ ...c, contactPhone: maskPhone(c.contactPhone), sites: c._count.sites, contract: c.contracts[0] ? contractView(c.contracts[0]) : null }));
  }

  async sites(org: string, f: Filters & { status?: string; q?: string }) {
    const ids = await this.siteIds(org, f);
    const rows = await this.prisma.monitoringSite.findMany({
      where: { organizationId: org, ...(ids ? { id: { in: ids } } : {}), ...(f.q ? { OR: [{ name: { contains: f.q } }, { code: { contains: f.q } }, { city: { contains: f.q } }] } : {}) },
      orderBy: { name: 'asc' },
      include: { customer: { select: { id: true, name: true, industry: true } }, recorders: { select: { code: true, status: true, storageStatus: true } }, agents: { select: { code: true, status: true, lastHeartbeatAt: true, hasBackupLink: true, queuedEvents: true } }, contracts: { orderBy: { endDate: 'desc' }, take: 1 } },
    });
    const [camCounts, active, techs, customerContracts] = await Promise.all([
      this.prisma.cameraDevice.groupBy({ by: ['siteId', 'status'], where: { organizationId: org, siteId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }),
      this.prisma.downtimeIncident.groupBy({ by: ['siteId', 'severity'], where: { organizationId: org, siteId: { in: rows.map((r) => r.id) }, status: { in: ACTIVE_STATES } }, _count: { _all: true } }),
      this.prisma.siteTechnician.findMany({ where: { organizationId: org, active: true, role: 'technician' }, select: { id: true, name: true, siteId: true, onCall: true } }),
      this.prisma.serviceContract.findMany({ where: { organizationId: org, siteId: null }, orderBy: { endDate: 'desc' } }),
    ]);
    const out = rows.map((s) => {
      const counts = Object.fromEntries(camCounts.filter((c) => c.siteId === s.id).map((c) => [c.status, c._count._all]));
      const inc = active.filter((a) => a.siteId === s.id);
      const worst = inc.length ? (['critical', 'high', 'medium', 'low'].find((sev) => inc.some((i) => i.severity === sev)) ?? null) : null;
      const contract = s.contracts[0] ?? customerContracts.find((c) => c.customerId === s.customerId);
      const tech = techs.filter((t) => t.siteId === s.id);
      return {
        id: s.id, code: s.code, name: s.name, address: s.address, city: s.city, region: s.region, monitoringMode: s.monitoringMode, internetStatus: s.internetStatus, lastHealthyCheckAt: s.lastHealthyCheckAt, latitude: s.latitude, longitude: s.longitude,
        customer: s.customer, cameras: Object.values(counts).reduce((a, b) => a + b, 0), online: counts.online ?? 0, offline: counts.offline ?? 0, unknown: counts.unknown ?? 0, degraded: counts.degraded ?? 0,
        recorders: s.recorders, agents: s.agents, activeIncidents: inc.reduce((a, i) => a + i._count._all, 0), worstSeverity: worst,
        health: inc.some((i) => i.severity === 'critical') ? 'outage' : (counts.offline ?? 0) > 0 || inc.length ? 'degraded' : (counts.unknown ?? 0) > 0 ? 'unknown' : 'healthy',
        technicians: (tech.length ? tech : techs.filter((t) => !t.siteId)).map((t) => ({ id: t.id, name: t.name, onCall: t.onCall })),
        contract: contract ? contractView(contract) : null, isDemo: s.isDemo,
      };
    });
    return f.status ? out.filter((s) => s.health === f.status) : out;
  }

  async site(org: string, id: string) {
    const s = await this.prisma.monitoringSite.findFirst({ where: { id, organizationId: org }, include: { customer: true, recorders: { orderBy: { code: 'asc' } }, agents: { orderBy: { code: 'asc' } }, contracts: true, technicians: true } });
    if (!s) throw new NotFoundException('Site not found');
    const [cameras, incidents] = await Promise.all([
      this.cameras(org, { siteId: id, pageSize: 200 }),
      this.prisma.downtimeIncident.findMany({ where: { organizationId: org, siteId: id }, orderBy: { firstDetectedAt: 'desc' }, take: 20 }),
    ]);
    return {
      ...s, customer: { ...s.customer, contactPhone: maskPhone(s.customer.contactPhone) },
      recorders: s.recorders.map((r) => ({ ...r, networkAddress: maskAddress(r.networkAddress) })),
      agents: s.agents.map(({ tokenHash: _h, ...a }) => a),
      technicians: s.technicians.map((t) => ({ ...t, phone: maskPhone(t.phone) })),
      contracts: s.contracts.map(contractView), cameras: cameras.rows, incidents,
    };
  }

  // ------------------------------------------------------------------ cameras

  async cameras(org: string, f: Filters & { q?: string; status?: string; recorderId?: string; sort?: string; page?: number; pageSize?: number }) {
    const ids = await this.siteIds(org, f);
    const pageSize = Math.min(200, Math.max(5, Math.round(f.pageSize ?? 25)));
    const page = Math.max(1, Math.round(f.page ?? 1));
    const where: Prisma.CameraDeviceWhereInput = {
      organizationId: org, ...(ids ? { siteId: { in: ids } } : {}), ...(f.status ? { status: f.status } : {}), ...(f.recorderId ? { recorderId: f.recorderId } : {}),
      ...(f.q ? { OR: [{ code: { contains: f.q } }, { name: { contains: f.q } }, { location: { contains: f.q } }, { model: { contains: f.q } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.cameraDevice.count({ where }),
      this.prisma.cameraDevice.findMany({ where, orderBy: CAMERA_SORT[f.sort ?? ''] ?? CAMERA_SORT[''], skip: (page - 1) * pageSize, take: pageSize, include: { site: { select: { id: true, name: true, code: true } }, recorder: { select: { id: true, code: true, status: true } } } }),
    ]);
    const active = await this.prisma.downtimeIncident.findMany({ where: { organizationId: org, status: { in: ACTIVE_STATES }, siteId: { in: [...new Set(rows.map((r) => r.siteId))] } }, include: { assignedTechnician: { select: { name: true } } } });
    return {
      total, page, pageSize,
      rows: rows.map((c) => {
        const inc = active.find((i) => i.deviceId === c.id) ?? active.find((i) => Array.isArray(i.affectedDevices) && (i.affectedDevices as string[]).includes(c.code));
        return {
          id: c.id, code: c.code, name: c.name, location: c.location, site: c.site, recorder: c.recorder, channelNo: c.channelNo, networkAddress: maskAddress(c.networkAddress),
          manufacturer: c.manufacturer, model: c.model, monitoringMethod: c.monitoringMethod, capabilities: cap(c.capabilities), critical: c.critical,
          status: c.status, streamStatus: c.streamStatus, recordingStatus: c.recordingStatus, lastSeenAt: c.lastSeenAt, lastCheckAt: c.lastCheckAt, lastRecordingVerifiedAt: c.lastRecordingVerifiedAt,
          incident: inc ? { id: inc.id, number: inc.number, category: inc.category, severity: inc.severity, status: inc.status, technician: inc.assignedTechnician?.name ?? null } : null, isDemo: c.isDemo,
        };
      }),
    };
  }

  async camera(org: string, id: string) {
    const c = await this.prisma.cameraDevice.findFirst({ where: { id, organizationId: org }, include: { site: { select: { id: true, name: true, code: true } }, recorder: { select: { id: true, code: true, name: true, status: true } } } });
    if (!c) throw new NotFoundException('Camera not found');
    const [events, incidents] = await Promise.all([
      this.prisma.healthEvent.findMany({ where: { organizationId: org, deviceId: id }, orderBy: { observedAt: 'desc' }, take: 60, select: { id: true, check: true, ok: true, observedAt: true, receivedAt: true, latencyMs: true, detail: true, source: true, replayed: true } }),
      this.prisma.downtimeIncident.findMany({ where: { organizationId: org, OR: [{ deviceId: id }, { affectedDevices: { path: '$', array_contains: c.code } }] }, orderBy: { firstDetectedAt: 'desc' }, take: 20 }),
    ]);
    return { ...c, networkAddress: maskAddress(c.networkAddress), capabilities: cap(c.capabilities), events, incidents, limitations: limitations(cap(c.capabilities)) };
  }

  // ------------------------------------------------------------------ incidents

  async incidents(org: string, f: Filters & { status?: string; severity?: string; category?: string; q?: string; from?: Date; to?: Date; page?: number; pageSize?: number }) {
    // Incidents include the scenario lab (labelled by its site) unless the caller excludes it (fleet views do).
    const ids = await this.siteIds(org, { ...f, includeLab: f.includeLab ?? true });
    const pageSize = Math.min(100, Math.max(5, Math.round(f.pageSize ?? 25)));
    const page = Math.max(1, Math.round(f.page ?? 1));
    const where: Prisma.DowntimeIncidentWhereInput = {
      organizationId: org, ...(ids ? { siteId: { in: ids } } : {}),
      ...(f.status === 'active' || !f.status ? { status: { in: ACTIVE_STATES } } : f.status === 'resolved' ? { status: { in: ['RESOLVED', 'CLOSED'] } } : f.status === 'all' ? {} : { status: f.status }),
      ...(f.severity ? { severity: f.severity } : {}), ...(f.category ? { category: f.category } : {}),
      ...(f.from || f.to ? { firstDetectedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      ...(f.q ? { OR: [{ number: { contains: f.q } }, { deviceCode: { contains: f.q } }, { title: { contains: f.q } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.downtimeIncident.count({ where }),
      this.prisma.downtimeIncident.findMany({ where, orderBy: [{ firstDetectedAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, include: { site: { select: { id: true, name: true, code: true, customer: { select: { id: true, name: true } } } }, assignedTechnician: { select: { id: true, name: true } } } }),
    ]);
    return { total, page, pageSize, rows: rows.map((i) => ({ ...i, categoryLabel: CATEGORY_LABEL[i.category as Category] ?? i.category, openKey: undefined })) };
  }

  async incident(org: string, id: string) {
    const i = await this.prisma.downtimeIncident.findFirst({
      where: { id, organizationId: org },
      include: { site: { select: { id: true, name: true, code: true, customer: { select: { id: true, name: true, contactName: true } } } }, assignedTechnician: { select: { id: true, name: true, role: true } }, timeline: { orderBy: { at: 'asc' } }, notifications: { orderBy: { createdAt: 'asc' } } },
    });
    if (!i) throw new NotFoundException('Incident not found');
    const technicians = await this.prisma.siteTechnician.findMany({ where: { organizationId: org, active: true, OR: [{ siteId: i.siteId }, { siteId: null }] }, select: { id: true, name: true, role: true, onCall: true }, orderBy: { name: 'asc' } });
    return {
      ...i, openKey: undefined, categoryLabel: CATEGORY_LABEL[i.category as Category] ?? i.category, troubleshooting: troubleshooting(i.category as Category),
      notifications: i.notifications.map((n) => ({ ...n, recipientPhone: maskPhone(n.recipientPhone) })), technicians,
      durationMinutes: Math.round(((i.resolvedAt ?? new Date()).getTime() - i.firstDetectedAt.getTime()) / 60_000),
    };
  }

  async notifications(org: string, f: { page?: number; status?: string }) {
    const page = Math.max(1, Math.round(f.page ?? 1));
    const where = { organizationId: org, ...(f.status ? { status: f.status } : {}) };
    const [total, rows, byStatus, cost] = await Promise.all([
      this.prisma.notificationAttempt.count({ where }),
      this.prisma.notificationAttempt.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50, include: { incident: { select: { number: true, siteId: true } } } }),
      this.prisma.notificationAttempt.groupBy({ by: ['status'], where: { organizationId: org }, _count: { _all: true } }),
      this.prisma.notificationAttempt.aggregate({ where: { organizationId: org, status: { in: ['sent', 'delivered', 'read'] } }, _sum: { costEstimate: true }, _count: { _all: true } }),
    ]);
    return { total, page, rows: rows.map((n) => ({ ...n, recipientPhone: maskPhone(n.recipientPhone) })), byStatus: byStatus.map((b) => ({ status: b.status, count: b._count._all })), liveCostInr: Number(cost._sum.costEstimate ?? 0), liveMessages: cost._count._all };
  }

  // ------------------------------------------------------------------ reports

  async report(org: string, f: Filters & { from: Date; to: Date }) {
    const ids = await this.siteIds(org, f);
    const up = await this.uptime(org, f.from, f.to, ids);
    const incidents = await this.prisma.downtimeIncident.findMany({
      where: { organizationId: org, ...(ids ? { siteId: { in: ids } } : {}), firstDetectedAt: { gte: f.from, lt: f.to }, resolvedBy: { not: 'correlation' } },
      include: { site: { select: { name: true, code: true, customerId: true } } }, orderBy: { firstDetectedAt: 'asc' },
    });
    const customers = await this.prisma.monitoringCustomer.findMany({ where: { organizationId: org }, include: { contracts: true } });
    const byCustomer = customers.map((c) => {
      const s = up.bySite.filter((x) => x.customerId === c.id);
      if (!s.length) return null;
      const total = s.reduce((a, x) => a + x.cameraMinutes, 0), down = s.reduce((a, x) => a + x.downMinutes, 0), unk = s.reduce((a, x) => a + x.unknownMinutes, 0);
      const inc = incidents.filter((i) => i.site.customerId === c.id);
      const contract = c.contracts.find((k) => !k.siteId) ?? c.contracts[0];
      const breaches = contract ? inc.filter((i) => ((i.resolvedAt ?? new Date()).getTime() - i.firstDetectedAt.getTime()) / 3_600_000 > contract.slaHours).length : 0;
      const measured = total - unk;
      return { customerId: c.id, customer: c.name, sites: s.length, cameras: s.reduce((a, x) => a + x.cameras, 0), uptimePct: measured > 0 ? Math.round(((measured - down) / measured) * 100_000) / 1000 : null, downMinutes: down, unknownMinutes: unk, incidents: inc.length, unresolved: inc.filter((i) => !i.resolvedAt).length, slaHours: contract?.slaHours ?? null, slaBreaches: breaches };
    }).filter(Boolean);
    return {
      ...up, byCustomer,
      incidents: incidents.map((i) => ({ number: i.number, site: i.site.name, device: i.deviceCode, category: CATEGORY_LABEL[i.category as Category] ?? i.category, severity: i.severity, status: i.status, detected: i.firstDetectedAt, acknowledged: i.acknowledgedAt, resolved: i.resolvedAt, minutes: Math.round(((i.resolvedAt ?? new Date()).getTime() - i.firstDetectedAt.getTime()) / 60_000), rootCause: i.rootCause, resolvedBy: i.resolvedBy })),
      unresolved: incidents.filter((i) => !i.resolvedAt).length,
    };
  }

  // ------------------------------------------------------------------ management (monitoring.manage)

  async createCustomer(org: string, b: Record<string, unknown>) {
    const name = str(b.name, 120);
    if (!name) throw new BadRequestException('Customer name is required');
    try {
      return await this.prisma.monitoringCustomer.create({ data: { organizationId: org, name, industry: str(b.industry, 40) || 'other', region: str(b.region, 80) || null, contactName: str(b.contactName, 80) || null, contactPhone: normalizePhone(str(b.contactPhone, 30)) ?? null, notifyOnResolution: b.notifyOnResolution === true } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('A customer with this name already exists');
      throw e;
    }
  }

  async createSite(org: string, b: Record<string, unknown>) {
    const customer = await this.prisma.monitoringCustomer.findFirst({ where: { id: str(b.customerId), organizationId: org } });
    if (!customer) throw new BadRequestException('Choose a customer of this workspace');
    const c = code(b.code), name = str(b.name, 120);
    if (!c || !name) throw new BadRequestException('Site code and name are required');
    try {
      return await this.prisma.monitoringSite.create({ data: { organizationId: org, customerId: customer.id, code: c, name, address: str(b.address, 400) || null, city: str(b.city, 80) || null, region: str(b.region, 80) || null, monitoringMode: b.monitoringMode === 'cloud' ? 'cloud' : 'local_agent' } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('A site with this code already exists');
      throw e;
    }
  }

  private capabilities(b: unknown) {
    const c = cap(b);
    return { reachability: true, stream: c.stream === true, recording: c.recording === true, storage: c.storage === true };
  }

  private method(v: unknown) {
    return ['agent_tcp', 'agent_onvif', 'agent_rtsp', 'vendor_api', 'cloud_tcp'].includes(String(v)) ? String(v) : 'agent_tcp';
  }

  /** Rejects credential-bearing addresses: the cloud never stores camera passwords or RTSP URLs. */
  private address(v: unknown) {
    const a = str(v, 120);
    if (!a) return null;
    if (/[@]|rtsp:|\/\//i.test(a)) throw new BadRequestException('Enter only the IP or host[:port]. Camera usernames, passwords and RTSP URLs stay on the site agent and are never stored in the cloud.');
    if (!/^[a-zA-Z0-9.-]{1,100}(:\d{1,5})?$/.test(a)) throw new BadRequestException('Invalid network address');
    return a;
  }

  async createRecorder(org: string, b: Record<string, unknown>) {
    const site = await this.prisma.monitoringSite.findFirst({ where: { id: str(b.siteId), organizationId: org } });
    if (!site) throw new BadRequestException('Choose a site of this workspace');
    const c = code(b.code);
    if (!c) throw new BadRequestException('Recorder code is required');
    try {
      return await this.prisma.recorderDevice.create({ data: { organizationId: org, siteId: site.id, code: c, name: str(b.name, 120) || c, kind: b.kind === 'dvr' ? 'dvr' : 'nvr', manufacturer: str(b.manufacturer, 60) || null, model: str(b.model, 60) || null, channels: Math.min(256, Math.max(1, Number(b.channels) || 8)), networkAddress: this.address(b.networkAddress), monitoringMethod: this.method(b.monitoringMethod), capabilities: this.capabilities(b.capabilities) } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('A device with this code already exists');
      throw e;
    }
  }

  async createCamera(org: string, b: Record<string, unknown>) {
    const site = await this.prisma.monitoringSite.findFirst({ where: { id: str(b.siteId), organizationId: org } });
    if (!site) throw new BadRequestException('Choose a site of this workspace');
    const recorderId = str(b.recorderId) || null;
    if (recorderId && !(await this.prisma.recorderDevice.findFirst({ where: { id: recorderId, organizationId: org, siteId: site.id } }))) throw new BadRequestException('The recorder must be at the same site');
    const c = code(b.code);
    if (!c) throw new BadRequestException('Camera code is required');
    try {
      return await this.prisma.cameraDevice.create({ data: { organizationId: org, siteId: site.id, recorderId, code: c, name: str(b.name, 120) || c, location: str(b.location, 120) || null, manufacturer: str(b.manufacturer, 60) || null, model: str(b.model, 60) || null, channelNo: Number(b.channelNo) || null, networkAddress: this.address(b.networkAddress), monitoringMethod: this.method(b.monitoringMethod), capabilities: this.capabilities(b.capabilities), critical: b.critical === true } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('A device with this code already exists');
      throw e;
    }
  }

  async setMaintenance(org: string, id: string, on: boolean) {
    const c = await this.prisma.cameraDevice.findFirst({ where: { id, organizationId: org } });
    if (!c) throw new NotFoundException('Camera not found');
    return this.prisma.cameraDevice.update({ where: { id }, data: { status: on ? 'maintenance' : 'unknown' } });
  }

  async technicians(org: string) {
    const rows = await this.prisma.siteTechnician.findMany({ where: { organizationId: org }, orderBy: [{ role: 'asc' }, { name: 'asc' }], include: { site: { select: { name: true, code: true } } } });
    return rows.map((t) => ({ ...t, phone: maskPhone(t.phone) }));
  }

  async createTechnician(org: string, b: Record<string, unknown>) {
    const phone = normalizePhone(str(b.phone, 30));
    const name = str(b.name, 80);
    if (!phone || !name) throw new BadRequestException('Name and a valid WhatsApp number are required');
    const siteId = str(b.siteId) || null;
    if (siteId && !(await this.prisma.monitoringSite.findFirst({ where: { id: siteId, organizationId: org } }))) throw new BadRequestException('Unknown site');
    const role = ['technician', 'supervisor', 'manager'].includes(String(b.role)) ? String(b.role) : 'technician';
    const shift = b.shift && typeof b.shift === 'object' ? b.shift : null;
    try {
      const t = await this.prisma.siteTechnician.create({ data: { organizationId: org, siteId, name, phone, role, onCall: b.onCall === true, shift: shift as never, whatsappConsent: b.whatsappConsent !== false } });
      return { ...t, phone: maskPhone(t.phone) };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('This number is already registered');
      throw e;
    }
  }

  async updateTechnician(org: string, id: string, b: Record<string, unknown>) {
    const t = await this.prisma.siteTechnician.findFirst({ where: { id, organizationId: org } });
    if (!t) throw new NotFoundException('Technician not found');
    const u = await this.prisma.siteTechnician.update({ where: { id }, data: { ...(typeof b.onCall === 'boolean' ? { onCall: b.onCall } : {}), ...(typeof b.active === 'boolean' ? { active: b.active } : {}), ...(typeof b.whatsappConsent === 'boolean' ? { whatsappConsent: b.whatsappConsent } : {}) } });
    return { ...u, phone: maskPhone(u.phone) };
  }

  async agents(org: string) {
    const rows = await this.prisma.monitoringAgent.findMany({ where: { organizationId: org }, orderBy: { code: 'asc' }, include: { site: { select: { name: true, code: true } } } });
    const cfg = (await this.settings.get(org)).monitoring;
    return rows.map(({ tokenHash: _h, ...a }) => ({ ...a, staleAfterMinutes: cfg.staleAfterMinutes }));
  }

  /** Registers a site agent. The token is returned ONCE; only its hash is stored. */
  async registerAgent(org: string, b: Record<string, unknown>) {
    const site = await this.prisma.monitoringSite.findFirst({ where: { id: str(b.siteId), organizationId: org } });
    if (!site) throw new BadRequestException('Choose a site of this workspace');
    const c = code(b.code) || `AGT-${site.code}`;
    const t = newAgentToken();
    try {
      const a = await this.prisma.monitoringAgent.create({ data: { organizationId: org, siteId: site.id, code: c, name: str(b.name, 80) || `Agent ${site.name}`, tokenHash: t.hash, tokenPrefix: t.prefix, hasBackupLink: b.hasBackupLink === true } });
      const { tokenHash: _h, ...rest } = a;
      return { agent: rest, token: t.token, note: 'Copy this token into the agent config now. It is shown only once; rotate it if lost.' };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('An agent with this code already exists');
      throw e;
    }
  }

  async rotateAgent(org: string, id: string) {
    const a = await this.prisma.monitoringAgent.findFirst({ where: { id, organizationId: org } });
    if (!a) throw new NotFoundException('Agent not found');
    const t = newAgentToken();
    await this.prisma.monitoringAgent.update({ where: { id }, data: { tokenHash: t.hash, tokenPrefix: t.prefix, status: a.status === 'revoked' ? 'never_seen' : a.status } });
    return { token: t.token, note: 'The old token stops working now. Update the agent config with this one.' };
  }

  async revokeAgent(org: string, id: string) {
    const a = await this.prisma.monitoringAgent.findFirst({ where: { id, organizationId: org } });
    if (!a) throw new NotFoundException('Agent not found');
    await this.prisma.monitoringAgent.update({ where: { id }, data: { status: 'revoked' } });
    return { ok: true };
  }

  async contracts(org: string) {
    const rows = await this.prisma.serviceContract.findMany({ where: { organizationId: org }, orderBy: { endDate: 'asc' }, include: { customer: { select: { name: true } }, site: { select: { name: true } } } });
    return rows.map((c) => ({ ...contractView(c), customer: c.customer.name, site: c.site?.name ?? 'All sites' }));
  }
}

function contractView(c: { id: string; reference: string; kind: string; planCode: string; startDate: Date; endDate: Date; slaHours: number; responseMinutes: number; cameraLimit: number | null; monthlyFee: unknown; notes?: string | null }) {
  const today = Date.now();
  const days = Math.round((c.endDate.getTime() - today) / DAY);
  return { id: c.id, reference: c.reference, kind: c.kind, planCode: c.planCode, startDate: c.startDate, endDate: c.endDate, slaHours: c.slaHours, responseMinutes: c.responseMinutes, cameraLimit: c.cameraLimit, monthlyFee: c.monthlyFee === null ? null : Number(c.monthlyFee), status: days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'active', daysLeft: days };
}

/** What this device's monitoring can and cannot prove (shown on the camera page). */
export function limitations(c: Record<string, boolean>): string[] {
  const out: string[] = [];
  out.push('Reachability shows the device answers on the network. It does not prove the camera is recording.');
  if (!c.stream) out.push('Video stream checks are not enabled for this device.');
  if (!c.recording) out.push('Recording cannot be verified for this device (its recorder exposes no reliable recording status): shown as "unsupported", never as recording.');
  if (c.recording) out.push('Recording status comes from the recorder\'s own report via the site agent.');
  return out;
}
