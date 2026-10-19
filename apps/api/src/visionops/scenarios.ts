import type { PrismaService } from '../prisma/prisma.service.js';
import type { AiService } from '../ai/ai.service.js';
import type { MonitoringEngine, EventIn } from './engine.service.js';
import type { IncidentsService } from './incidents.service.js';
import type { MonitoringNotifier } from './notifier.service.js';
import { sanitizeSettings } from '../settings/tenant-settings.js';

type StepStatus = 'passed' | 'failed' | 'blocked' | 'simulated' | 'provider_required';
type Step = { name: string; kind: 'chat' | 'voice' | 'api' | 'follow_up' | 'check' | 'provider'; input?: string; output?: string; status: StepStatus; detail?: string; ms?: number };

export const CCTV_SCENARIOS = [
  { id: 'cctv_full_flow', title: 'End to end: camera offline → WhatsApp → ACK → verified restoration', description: 'Health checks → debounce → one incident → simulated technician alert → "ACK" on WhatsApp → "HELP" → "fixed" (waits for evidence) → 3 fresh checks → resolved → restored + customer report (simulated).' },
  { id: 'cctv_camera_offline', title: '1. Camera offline while the DVR stays reachable', description: 'One camera fails three checks over the debounce interval while its NVR keeps answering: a single camera incident, repeats suppressed.' },
  { id: 'cctv_nvr_offline', title: '2. Entire DVR / NVR offline', description: 'The recorder stops answering: one CRITICAL incident covering all its cameras; camera failures behind it are folded, not separate alerts.' },
  { id: 'cctv_internet_outage', title: '3. Internet outage while local monitoring continues', description: 'The agent reports over its 4G backup that broadband is down: internet-outage incident, camera checks keep arriving, cleared when broadband returns.' },
  { id: 'cctv_agent_disconnected', title: '4. Monitoring agent disconnected, then reconnects', description: 'Heartbeats stop: devices become UNKNOWN (not offline) and an agent incident opens. On reconnect the queued events replay in order and the root cause is recorded.' },
  { id: 'cctv_intermittent', title: '5. Intermittent camera connectivity', description: 'Alternating success / failure: the debounce prevents a false incident; the camera shows as degraded.' },
  { id: 'cctv_recording_failure', title: '6. Recording failure (recorder reports it)', description: 'A camera whose recorder exposes recording status reports failures: "recording not confirmed" incident. A camera without that capability can never be shown as recording.' },
  { id: 'cctv_recovery_reopen', title: '7. Recovery after a fault, then recurrence', description: 'Verified recovery resolves the incident; the same fault inside the correlation window reopens it instead of creating a duplicate.' },
  { id: 'cctv_escalation', title: '8. Unacknowledged alert escalation', description: 'Nobody acknowledges: supervisor alerted after the deadline (L1), manager after the next step (L2), all simulated.' },
];

const LAB_CUSTOMER = 'Scenario Lab (demo)';

/**
 * VisionOps demo scenarios: drive the real engine, incident service, notifier and WhatsApp assistant on a dedicated,
 * clearly labelled lab site in a DEMO workspace (the caller refuses anything else). Each run resets only its own lab
 * site's synthetic events / incidents first, so reruns are repeatable and nothing else is touched.
 */
export async function runCctvScenario(
  deps: { prisma: PrismaService; ai: AiService; engine: MonitoringEngine; incidents: IncidentsService; notifier: MonitoringNotifier },
  org: string, id: string, steps: Step[],
) {
  const { prisma, engine, incidents, notifier, ai } = deps;
  const now = new Date();
  const lab = await labSite(prisma, org, id);
  let k = 0;
  const at = (min: number) => new Date(now.getTime() + min * 60_000);
  const e = (device: string | undefined, ok: boolean, t: Date, check: EventIn['check'] = 'reachability'): EventIn => ({ eventId: `lab-${id}-${now.getTime()}-${++k}`, device, check, ok, observedAt: t.toISOString() });
  const push = (name: string, ok: boolean, detail: string, kind: Step['kind'] = 'check', output?: string) => steps.push({ name, kind, status: ok ? 'passed' : 'failed', detail, ...(output ? { output } : {}) });
  const send = (events: EventIn[], recv?: Date) => engine.ingest(org, lab.site.id, { source: 'simulated', agentId: lab.agent.id, agentCode: lab.agent.code, isDemo: true }, events, recv ?? new Date(new Date(events[events.length - 1].observedAt).getTime() + 2000));
  // Follow THIS workspace's rules: N failed checks spanning the debounce interval; M successes to restore.
  const cfg = sanitizeSettings((await prisma.organizationSettings.findUnique({ where: { organizationId: org } }))?.data ?? {}).monitoring;
  const n = cfg.failureThreshold;
  const step = Math.max(0.5, Math.ceil((cfg.debounceSeconds / Math.max(1, n - 1) / 60) * 10) / 10);
  /** Failures at from, from+step, …: exactly enough to confirm. Returns the minute of the last one. */
  const failN = async (code: string | undefined, from: number, check: EventIn['check'] = 'reachability', count = n) => {
    for (let j = 0; j < count; j++) await send([e(code, false, at(from + j * step), check)]);
    return from + (count - 1) * step;
  };
  const okN = async (code: string | undefined, from: number, check: EventIn['check'] = 'reachability', count = cfg.restoreSuccesses) => {
    for (let j = 0; j < count; j++) await send([e(code, true, at(from + j), check)]);
  };
  const fail3 = failN;
  const ok3 = okN;
  const incidentOf = (deviceId: string, category?: string) => prisma.downtimeIncident.findFirst({ where: { organizationId: org, deviceId, ...(category ? { category } : {}) }, orderBy: { createdAt: 'desc' } });
  const simulated = async (incidentId: string, purpose: string, name: string) => {
    const a = await prisma.notificationAttempt.findFirst({ where: { organizationId: org, incidentId, purpose }, orderBy: { createdAt: 'desc' } });
    steps.push({ name, kind: 'follow_up', status: a?.status === 'simulated' ? 'simulated' : a ? 'passed' : 'failed', output: a?.body, detail: a ? `${a.recipientType} ${a.recipientName ?? ''}: ${a.status}${a.simulated ? ' (DRY_RUN / demo: nothing was sent to WhatsApp)' : ''}` : `No "${purpose}" message was queued.` });
  };
  const chat = async (name: string, message: string, expect: RegExp) => {
    const t = Date.now();
    const r = await ai.generateResponse({ organizationId: org, channel: 'web', phone: lab.techPhone, message, metadata: { playground: true } });
    steps.push({ name, kind: 'chat', input: message, output: r.response, status: expect.test(r.response) ? 'passed' : 'failed', ms: Date.now() - t, detail: 'Dashboard test channel as the demo technician (rules only, no model).' });
  };
  const [cam1, cam2, cam3] = lab.cams;

  switch (id) {
    case 'cctv_full_flow':
    case 'cctv_camera_offline': {
      await ok3(lab.nvr.code, -25);
      const last = await failN(cam2.code, -20, 'reachability', n - 1);
      push(`${n - 1} failed check(s): not confirmed yet (debounce)`, !(await incidentOf(cam2.id)), `Rule: ${n} failed checks over at least ${cfg.debounceSeconds} s. Camera shows "degraded"; no incident and no alert for a short blip.`);
      await send([e(cam2.code, false, at(last + step)), e(lab.nvr.code, true, at(last + step))]);
      const inc = await incidentOf(cam2.id);
      push('Third failure → one incident (NVR still reachable)', inc?.category === 'camera_unreachable', inc ? `${inc.number}: ${inc.title} · severity ${inc.severity}` : 'no incident', 'api');
      if (!inc) break;
      await send([e(cam2.code, false, at(-12)), e(cam2.code, false, at(-11))]);
      const count = await prisma.downtimeIncident.count({ where: { organizationId: org, deviceId: cam2.id } });
      push('Repeated failures are suppressed', count === 1, `${count} incident for ${cam2.code}; lastChecked updated, no new alert.`);
      await simulated(inc.id, 'alert', 'WhatsApp alert to the on-duty technician');
      if (id === 'cctv_camera_offline') break;
      await chat('Technician acknowledges on WhatsApp', `ack ${inc.number}`, new RegExp(`${inc.number} acknowledged`));
      await chat('Technician asks for first checks', `HELP ${inc.number}`, /Check the camera power/);
      await chat('Technician says it is fixed (camera still failing)', `fixed ${inc.number} loose PoE cable at the switch`, /more successful monitoring check/);
      const waiting = await prisma.downtimeIncident.findUnique({ where: { id: inc.id } });
      push('Not resolved on a report alone', waiting?.status === 'RESTORATION_CHECK', `Status ${waiting?.status}: waiting for fresh evidence.`);
      await ok3(cam2.code, -3);
      const done = await prisma.downtimeIncident.findUnique({ where: { id: inc.id } });
      push('Three fresh successful checks → resolved by verification', done?.status === 'RESOLVED' && done.resolvedBy === 'verification', `Evidence: ${Array.isArray(done?.restorationEvidence) ? (done!.restorationEvidence as unknown[]).length : 0} checks. Root cause: ${done?.rootCause ?? '-'}`, 'api');
      await simulated(inc.id, 'restored', 'Restoration message to the technician');
      await simulated(inc.id, 'customer_report', 'Resolution report to the customer');
      break;
    }
    case 'cctv_nvr_offline': {
      await fail3(lab.nvr.code, -20);
      const inc = await incidentOf(lab.nvr.id);
      push('Recorder down → one critical incident for all its cameras', inc?.severity === 'critical' && inc.affectedCount === lab.cams.length, inc ? `${inc.number}: ${inc.affectedCount} cameras affected (${(inc.affectedDevices as string[] | null)?.join(', ')})` : 'no incident', 'api');
      await fail3(cam1.code, -14);
      await fail3(cam3.code, -14);
      const own = await prisma.downtimeIncident.count({ where: { organizationId: org, deviceId: { in: [cam1.id, cam3.id] } } });
      push('Camera failures behind the recorder are folded', own === 0, own === 0 ? 'No separate camera incidents; the recorder incident timeline notes them.' : `${own} separate camera incident(s)`);
      if (inc) await simulated(inc.id, 'alert', 'Critical alert to the on-duty technician');
      await ok3(lab.nvr.code, -5);
      const done = inc ? await prisma.downtimeIncident.findUnique({ where: { id: inc.id } }) : null;
      push('Recorder answers again → verified restoration', done?.status === 'RESOLVED', `Status ${done?.status}`);
      break;
    }
    case 'cctv_internet_outage': {
      await engine.heartbeat(org, lab.agent.id, { sentAt: now.toISOString(), queueDepth: 0, link: 'backup_4g' }, now);
      await send([e(undefined, false, at(-6), 'internet')]);
      const inc = await prisma.downtimeIncident.findFirst({ where: { organizationId: org, siteId: lab.site.id, category: 'internet_outage' }, orderBy: { createdAt: 'desc' } });
      push('Agent reports broadband down over 4G → internet outage incident', Boolean(inc), inc ? `${inc.number} · ${inc.severity}. Site internet status: backup link.` : 'no incident', 'api');
      await send([e(cam1.code, true, at(-5)), e(cam2.code, true, at(-5)), e(cam3.code, true, at(-5))]);
      const c = await prisma.cameraDevice.findUnique({ where: { id: cam1.id } });
      push('Local monitoring continues during the outage', c?.status === 'online', `${cam1.code} is ${c?.status}: camera checks still arrive through the backup link.`);
      await send([e(undefined, true, at(-3), 'internet'), e(undefined, true, at(-2), 'internet'), e(undefined, true, at(-1), 'internet')]);
      const done = inc ? await prisma.downtimeIncident.findUnique({ where: { id: inc.id } }) : null;
      push('Broadband back → incident resolved with evidence', done?.status === 'RESOLVED', `Status ${done?.status}`);
      steps.push({ name: 'Live alert when every path is down', kind: 'provider', status: 'provider_required', detail: 'Without a working internet or 4G path at the site, the cloud cannot receive events: alerts are queued on the agent and sent when a path returns. No live WhatsApp is promised in that case.' });
      break;
    }
    case 'cctv_agent_disconnected': {
      await send([e(cam1.code, true, at(-20)), e(cam2.code, true, at(-20))]);
      await prisma.monitoringAgent.update({ where: { id: lab.agent.id }, data: { status: 'online', lastHeartbeatAt: at(-18) } });
      const sweep = await engine.sweep(org, now, { agentIds: [lab.agent.id] });
      const c = await prisma.cameraDevice.findUnique({ where: { id: cam1.id } });
      push('No heartbeat for 18 min → devices UNKNOWN (not offline)', c?.status === 'unknown', `${cam1.code}: ${c?.status}. Sweep: ${sweep.agentsOffline} agent(s) offline.`, 'api');
      const inc = await incidentOf(lab.agent.id, 'agent_offline');
      push('One agent incident (site internet or agent PC)', Boolean(inc), inc ? `${inc.number} · ${inc.severity} · ${inc.affectedCount} cameras unknown` : 'no incident');
      if (inc) await simulated(inc.id, 'alert', 'Technician told: monitoring blind, cameras UNKNOWN');
      const replay = await send([e(cam1.code, true, at(-12)), e(cam2.code, true, at(-15)), e(cam3.code, true, at(-9))], now);
      push('Reconnect: queued events replay in observed order', replay.replayed === 3, `${replay.accepted} accepted, ${replay.replayed} replayed from the agent's offline queue, ${replay.duplicates} duplicates.`, 'api');
      for (const s of [0, 1, 2]) await engine.heartbeat(org, lab.agent.id, { sentAt: new Date(now.getTime() + s * 1000).toISOString(), queueDepth: 0 }, new Date(now.getTime() + s * 1000));
      const done = inc ? await prisma.downtimeIncident.findUnique({ where: { id: inc.id } }) : null;
      push('Heartbeats with an empty queue → resolved; root cause recorded', done?.status === 'RESOLVED', done?.rootCause ?? `Status ${done?.status}`);
      break;
    }
    case 'cctv_intermittent': {
      for (let m = -12; m < 0; m++) await send([e(cam3.code, m % 2 === 0, at(m))]);
      const inc = await incidentOf(cam3.id);
      const c = await prisma.cameraDevice.findUnique({ where: { id: cam3.id } });
      push('Alternating results never open an incident', !inc, `12 checks, 6 failed, never 3 in a row: ${cam3.code} is ${c?.status}.`);
      break;
    }
    case 'cctv_recording_failure': {
      const r1 = await send([e(cam1.code, true, at(-9), 'recording')]);
      push('A camera without recording capability cannot be shown as recording', r1.accepted === 0 && r1.rejected.length === 1, r1.rejected[0]?.reason ?? 'accepted (wrong)');
      await ok3(lab.gate.code, -25);
      await send([e(lab.gate.code, true, at(-20), 'recording')]);
      await failN(lab.gate.code, -15, 'recording');
      const inc = await incidentOf(lab.gate.id, 'recording_not_confirmed');
      push('Recorder reports recording failing → incident', Boolean(inc), inc ? `${inc.number} · ${inc.severity}: ${inc.title}` : 'no incident', 'api');
      if (inc) await simulated(inc.id, 'alert', 'Technician alerted about the recording failure');
      break;
    }
    case 'cctv_recovery_reopen': {
      await fail3(cam1.code, -45);
      await ok3(cam1.code, -38);
      const first = await incidentOf(cam1.id);
      push('Fault → verified recovery', first?.status === 'RESOLVED', `${first?.number}: ${first?.status}`);
      await fail3(cam1.code, -18);
      const again = await prisma.downtimeIncident.findMany({ where: { organizationId: org, deviceId: cam1.id } });
      push('Same fault inside the correlation window → reopened, not duplicated', again.length === 1 && again[0].reopenCount === 1, `${again.length} incident, reopened ${again[0]?.reopenCount ?? 0} time(s), status ${again[0]?.status}`, 'api');
      break;
    }
    case 'cctv_escalation': {
      await fail3(cam2.code, -10);
      const inc = await incidentOf(cam2.id);
      if (!inc) { push('Incident opened', false, 'no incident'); break; }
      await simulated(inc.id, 'alert', 'Technician alert');
      await notifier.escalateDue(org, at(13), inc.id);
      await simulated(inc.id, 'escalation', 'Not acknowledged in time → supervisor (L1)');
      await notifier.escalateDue(org, at(44), inc.id);
      const l2 = await prisma.notificationAttempt.findFirst({ where: { organizationId: org, incidentId: inc.id, purpose: 'escalation', recipientType: 'manager' } });
      steps.push({ name: 'Still not acknowledged → manager (L2)', kind: 'follow_up', status: l2?.status === 'simulated' ? 'simulated' : 'failed', output: l2?.body, detail: l2 ? `manager ${l2.recipientName}: ${l2.status}` : 'no manager escalation' });
      await incidents.acknowledge(org, inc.id, 'user:Scenario NOC', at(45));
      const after = await prisma.downtimeIncident.findUnique({ where: { id: inc.id } });
      push('Acknowledgment stops further escalation', after?.nextEscalationAt === null && after.status === 'ACKNOWLEDGED', `Escalation level ${after?.escalationLevel}, status ${after?.status}`);
      steps.push({ name: 'Voice escalation call', kind: 'provider', status: 'provider_required', detail: 'Off by default; real escalation calls need Plivo / Sarvam verification first.' });
      break;
    }
  }
}

/** The lab site for a scenario (created once, reset on each run: only its own synthetic events / incidents). */
async function labSite(prisma: PrismaService, org: string, id: string) {
  const customer = await prisma.monitoringCustomer.upsert({ where: { organizationId_name: { organizationId: org, name: LAB_CUSTOMER } }, update: {}, create: { organizationId: org, name: LAB_CUSTOMER, industry: 'other', notifyOnResolution: true, contactName: 'Lab contact', contactPhone: '919990000999', isDemo: true } });
  // One shared lab site (code LAB-01): reset at the start of every run; excluded from fleet KPIs and reports.
  const n = 1;
  void id;
  const code = 'LAB-01';
  const site = await prisma.monitoringSite.upsert({ where: { organizationId_code: { organizationId: org, code } }, update: {}, create: { organizationId: org, customerId: customer.id, code, name: 'Scenario Lab', city: 'Chennai', region: 'Lab', isDemo: true } });
  if (!site.isDemo || !site.code.startsWith('LAB-')) throw new Error('Refusing to reset a non-lab site');
  // Reset this lab site only.
  await prisma.downtimeIncident.deleteMany({ where: { organizationId: org, siteId: site.id } });
  await prisma.healthEvent.deleteMany({ where: { organizationId: org, siteId: site.id } });
  const nvr = await prisma.recorderDevice.upsert({ where: { organizationId_code: { organizationId: org, code: `${code}-NVR` } }, update: { status: 'online', consecutiveFailures: 0, consecutiveSuccesses: 0, failingSince: null, lastCheckAt: null }, create: { organizationId: org, siteId: site.id, code: `${code}-NVR`, name: 'Lab NVR', capabilities: { reachability: true, storage: true }, status: 'online', networkAddress: '192.168.50.10', isDemo: true } });
  const cams = [];
  for (const i of [1, 2, 3]) {
    const c = `${code}-CAM-0${i}`;
    cams.push(await prisma.cameraDevice.upsert({ where: { organizationId_code: { organizationId: org, code: c } }, update: { status: 'online', consecutiveFailures: 0, consecutiveSuccesses: 0, failingSince: null, lastCheckAt: null, recordingStatus: 'unsupported', streamStatus: 'unsupported' }, create: { organizationId: org, siteId: site.id, recorderId: nvr.id, code: c, name: `Lab camera ${i}`, capabilities: { reachability: true }, status: 'online', networkAddress: `192.168.50.${20 + i}`, isDemo: true } }));
  }
  const gate = await prisma.cameraDevice.upsert({ where: { organizationId_code: { organizationId: org, code: `${code}-GATE` } }, update: { status: 'online', consecutiveFailures: 0, consecutiveSuccesses: 0, failingSince: null, lastCheckAt: null, recordingStatus: 'unsupported' }, create: { organizationId: org, siteId: site.id, code: `${code}-GATE`, name: 'Lab gate camera', capabilities: { reachability: true, stream: true, recording: true }, critical: true, status: 'online', isDemo: true } });
  const agentCode = `${code}-AGT`;
  let agent = await prisma.monitoringAgent.findUnique({ where: { organizationId_code: { organizationId: org, code: agentCode } } });
  if (!agent) agent = await prisma.monitoringAgent.create({ data: { organizationId: org, siteId: site.id, code: agentCode, name: 'Lab agent (simulated)', tokenHash: 'lab-no-token', tokenPrefix: `vo_lab${String(n).padStart(2, '0')}${org.slice(-4).replace(/[^a-f0-9]/g, '0')}`.slice(0, 13), hasBackupLink: true, isDemo: true } });
  await prisma.monitoringAgent.update({ where: { id: agent.id }, data: { status: 'online', lastHeartbeatAt: new Date(), queuedEvents: 0 } });
  await prisma.monitoringSite.update({ where: { id: site.id }, data: { internetStatus: 'online' } });
  const techPhone = '919990000901';
  return { site, nvr, cams, gate, agent, techPhone };
}
