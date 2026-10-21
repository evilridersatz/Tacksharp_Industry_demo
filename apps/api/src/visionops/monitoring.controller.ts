import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, UnauthorizedException } from '@nestjs/common';
import { CurrentUser, Org, Public } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import { MonitoringService } from './monitoring.service.js';
import { IncidentsService } from './incidents.service.js';
import { MonitoringEngine, type EventIn } from './engine.service.js';
import { parseAgentToken, secretMatches } from './agent-auth.js';
import { VisionOpsScheduler } from './scheduler.service.js';
import { SettingsService } from '../settings/settings.service.js';

const int = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
const date = (v: unknown) => {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const filters = (q: Record<string, string | undefined>) => ({ customerId: q.customerId || undefined, siteId: q.siteId || undefined, region: q.region || undefined, industry: q.industry || undefined });

/** VisionOps dashboard API (logged-in users of the workspace; every query is scoped to their organization). */
@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly svc: MonitoringService, private readonly incidents: IncidentsService, private readonly engine: MonitoringEngine, private readonly prisma: PrismaService, private readonly scheduler: VisionOpsScheduler, private readonly settings: SettingsService) {}

  private view(u: SessionClaims) { requirePermission(u, PERMISSIONS.monitoringView); }
  private operate(u: SessionClaims) { requirePermission(u, PERMISSIONS.monitoringOperate); }
  private manage(u: SessionClaims) { requirePermission(u, PERMISSIONS.monitoringManage); }
  private async actor(u: SessionClaims) {
    const user = await this.prisma.user.findUnique({ where: { id: u.sub }, select: { name: true, email: true } }).catch(() => null);
    return `user:${user?.name || user?.email || u.sub}`;
  }

  @Get('overview')
  overview(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: Record<string, string>) {
    this.view(u);
    return this.svc.overview(org, { ...filters(q), days: int(q.days) });
  }

  @Get('customers')
  customers(@Org() org: string, @CurrentUser() u: SessionClaims) { this.view(u); return this.svc.customers(org); }

  @Post('customers')
  createCustomer(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: Record<string, unknown>) { this.manage(u); return this.svc.createCustomer(org, b ?? {}); }

  @Get('sites')
  sites(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: Record<string, string>) { this.view(u); return this.svc.sites(org, { ...filters(q), status: q.status || undefined, q: q.q || undefined }); }

  @Post('sites')
  createSite(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: Record<string, unknown>) { this.manage(u); return this.svc.createSite(org, b ?? {}); }

  @Get('sites/:id')
  site(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) { this.view(u); return this.svc.site(org, id); }

  /** Mode A: run the configured TCP checks for a cloud-monitored site now. */
  @Post('sites/:id/check')
  check(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) { this.operate(u); return this.engine.runCloudChecks(org, id); }

  @Get('cameras')
  cameras(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: Record<string, string>) {
    this.view(u);
    return this.svc.cameras(org, { ...filters(q), q: q.q || undefined, status: q.status || undefined, recorderId: q.recorderId || undefined, sort: q.sort || undefined, page: int(q.page), pageSize: int(q.pageSize) });
  }

  @Post('cameras')
  createCamera(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: Record<string, unknown>) { this.manage(u); return this.svc.createCamera(org, b ?? {}); }

  @Get('cameras/:id')
  camera(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) { this.view(u); return this.svc.camera(org, id); }

  @Post('cameras/:id/maintenance')
  maintenance(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { on?: boolean }) { this.manage(u); return this.svc.setMaintenance(org, id, b?.on !== false); }

  @Post('recorders')
  createRecorder(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: Record<string, unknown>) { this.manage(u); return this.svc.createRecorder(org, b ?? {}); }

  @Get('incidents')
  list(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: Record<string, string>) {
    this.view(u);
    return this.svc.incidents(org, { ...filters(q), includeLab: q.lab !== 'exclude', status: q.status || undefined, severity: q.severity || undefined, category: q.category || undefined, q: q.q || undefined, from: date(q.from), to: date(q.to), page: int(q.page), pageSize: int(q.pageSize) });
  }

  @Get('incidents/:id')
  incident(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) { this.view(u); return this.svc.incident(org, id); }

  @Post('incidents/:id/acknowledge')
  async acknowledge(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    this.operate(u);
    await this.incidents.acknowledge(org, id, await this.actor(u));
    return this.svc.incident(org, id);
  }

  @Post('incidents/:id/assign')
  async assign(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { technicianId?: string }) {
    this.operate(u);
    await this.incidents.assign(org, id, String(b?.technicianId ?? ''), await this.actor(u));
    return this.svc.incident(org, id);
  }

  @Post('incidents/:id/start')
  async start(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { note?: string }) {
    this.operate(u);
    await this.incidents.start(org, id, await this.actor(u), new Date(), b?.note);
    return this.svc.incident(org, id);
  }

  /** "Fixed": resolved only if fresh checks already prove it; otherwise RESTORATION_CHECK until they do. */
  @Post('incidents/:id/resolve')
  async resolve(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { rootCause?: string; note?: string }) {
    this.operate(u);
    const r = await this.incidents.requestResolve(org, id, await this.actor(u), { rootCause: b?.rootCause, note: b?.note });
    return { ...(await this.svc.incident(org, id)), resolution: { resolved: r.resolved, checksStillNeeded: r.needed } };
  }

  @Post('incidents/:id/close')
  async close(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { note?: string }) {
    this.operate(u);
    await this.incidents.close(org, id, await this.actor(u), new Date(), b?.note);
    return this.svc.incident(org, id);
  }

  @Post('incidents/:id/note')
  async note(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { message?: string }) {
    this.operate(u);
    await this.incidents.note(org, id, await this.actor(u), String(b?.message ?? ''));
    return this.svc.incident(org, id);
  }

  @Get('notifications')
  notifications(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: Record<string, string>) { this.view(u); return this.svc.notifications(org, { page: int(q.page), status: q.status || undefined }); }

  @Get('reports/uptime')
  uptime(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: Record<string, string>) {
    this.view(u);
    const to = date(q.to) ?? new Date();
    const from = date(q.from) ?? new Date(to.getTime() - 30 * 86_400_000);
    return this.svc.report(org, { ...filters(q), from, to });
  }

  @Get('technicians')
  technicians(@Org() org: string, @CurrentUser() u: SessionClaims) { this.view(u); return this.svc.technicians(org); }

  @Post('technicians')
  createTechnician(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: Record<string, unknown>) { this.manage(u); return this.svc.createTechnician(org, b ?? {}); }

  @Patch('technicians/:id')
  updateTechnician(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: Record<string, unknown>) { this.manage(u); return this.svc.updateTechnician(org, id, b ?? {}); }

  @Get('contracts')
  contracts(@Org() org: string, @CurrentUser() u: SessionClaims) { this.view(u); return this.svc.contracts(org); }

  @Get('agents')
  agents(@Org() org: string, @CurrentUser() u: SessionClaims) { this.view(u); return this.svc.agents(org); }

  @Post('agents')
  registerAgent(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: Record<string, unknown>) { this.manage(u); return this.svc.registerAgent(org, b ?? {}); }

  @Post('agents/:id/rotate')
  rotate(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) { this.manage(u); return this.svc.rotateAgent(org, id); }

  @Post('agents/:id/revoke')
  revoke(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) { this.manage(u); return this.svc.revokeAgent(org, id); }

  /** Run this workspace's minute now: live demo feed (if on), cloud checks, stale-telemetry sweep, escalations, due notifications. */
  @Post('run-checks')
  runChecks(@Org() org: string, @CurrentUser() u: SessionClaims) { this.operate(u); return this.scheduler.runOrg(org); }

  /** Is data flowing? When the last check / heartbeat arrived, whether the scheduler runs here, and the demo feed state. */
  @Get('live')
  async live(@Org() org: string, @CurrentUser() u: SessionClaims) {
    this.view(u);
    const [o, s, agents, sites] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } }),
      this.settings.get(org),
      this.prisma.monitoringAgent.aggregate({ where: { organizationId: org, status: { not: 'revoked' } }, _max: { lastHeartbeatAt: true, lastEventAt: true } }),
      this.prisma.monitoringSite.aggregate({ where: { organizationId: org, NOT: { code: { startsWith: 'LAB-' } } }, _max: { lastHealthyCheckAt: true } }),
    ]);
    const times = [agents._max.lastHeartbeatAt, agents._max.lastEventAt, sites._max.lastHealthyCheckAt].filter((d): d is Date => Boolean(d)).map((d) => d.getTime());
    return {
      lastDataAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      scheduler: { on: this.scheduler.state.on, reason: this.scheduler.state.reason, lastTickAt: this.scheduler.lastTick?.at ?? null },
      liveDemo: { available: Boolean(o?.isDemo) && process.env.VISIONOPS_DEMO_FEED !== 'off', enabled: Boolean(o?.isDemo && s.monitoring.liveDemo?.enabled), since: s.monitoring.liveDemo?.since ?? null },
    };
  }

  /** Demo workspaces only: switch the simulated live feed on or off (real workspaces get data from their agents). */
  @Post('live-demo')
  async liveDemo(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: { enabled?: unknown }) {
    this.manage(u);
    const o = await this.prisma.organization.findUnique({ where: { id: org }, select: { isDemo: true } });
    if (!o?.isDemo) throw new BadRequestException('The live demo feed is only available in demo workspaces. Real workspaces receive data from their site agents and cloud checks.');
    if (process.env.VISIONOPS_DEMO_FEED === 'off') throw new BadRequestException('The live demo feed is disabled on this server (VISIONOPS_DEMO_FEED=off).');
    const enabled = b?.enabled === true;
    const now = new Date();
    await this.settings.update(org, { monitoring: { liveDemo: { enabled, since: enabled ? now.toISOString() : null } } } as never);
    log.info('visionops.live_demo', { org, enabled, by: u.sub });
    const tick = enabled ? await this.scheduler.runOrg(org, now) : null;
    return { enabled, since: enabled ? now.toISOString() : null, scheduler: this.scheduler.state, firstTick: tick?.feed[org] ?? null };
  }
}

/**
 * Local monitoring agent API. Public routes, authenticated ONLY by the agent token (Authorization: Bearer vo_….…);
 * the agent's organization and site come from the token, never from the request body. Rate-limited per IP.
 */
@Controller('monitoring/agent')
export class MonitoringAgentController {
  constructor(private readonly prisma: PrismaService, private readonly engine: MonitoringEngine) {}

  private async auth(header: string | undefined) {
    const t = parseAgentToken(header);
    if (!t) throw new UnauthorizedException('Agent token required');
    const agent = await this.prisma.monitoringAgent.findUnique({ where: { tokenPrefix: t.prefix } });
    if (!agent || agent.status === 'revoked' || !secretMatches(t.secret, agent.tokenHash)) {
      log.warn('visionops.agent_auth_failed', { prefix: t.prefix });
      throw new UnauthorizedException('Invalid or revoked agent token');
    }
    return agent;
  }

  @Public()
  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@Headers('authorization') h: string | undefined, @Body() b: Record<string, unknown>) {
    const agent = await this.auth(h);
    return this.engine.heartbeat(agent.organizationId, agent.id, (b ?? {}) as never);
  }

  @Public()
  @Post('events')
  @HttpCode(200)
  async events(@Headers('authorization') h: string | undefined, @Body() b: { events?: EventIn[] }) {
    const agent = await this.auth(h);
    return this.engine.ingest(agent.organizationId, agent.siteId, { source: 'agent', agentId: agent.id, agentCode: agent.code, isDemo: agent.isDemo }, b?.events ?? []);
  }

  /** The devices this agent is authorized to check (codes, addresses and capabilities; never credentials). */
  @Public()
  @Get('config')
  async config(@Headers('authorization') h: string | undefined) {
    const agent = await this.auth(h);
    const [cameras, recorders] = await Promise.all([
      this.prisma.cameraDevice.findMany({ where: { organizationId: agent.organizationId, siteId: agent.siteId }, select: { code: true, networkAddress: true, monitoringMethod: true, capabilities: true, recorderId: true } }),
      this.prisma.recorderDevice.findMany({ where: { organizationId: agent.organizationId, siteId: agent.siteId }, select: { id: true, code: true, networkAddress: true, monitoringMethod: true, capabilities: true } }),
    ]);
    return { agent: agent.code, siteId: agent.siteId, recorders, cameras, note: 'Credentials for ONVIF / RTSP checks are configured locally on the agent and are never sent to or stored by the cloud.' };
  }
}
