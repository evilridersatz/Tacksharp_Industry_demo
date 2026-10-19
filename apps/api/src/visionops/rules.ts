/**
 * Tacksharp VisionOps: deterministic rules. Fault categories, severity triage, troubleshooting steps, message
 * templates, quiet hours / shifts and masking. No model: everything here is plain code and unit-tested.
 */

export type DeviceType = 'camera' | 'recorder' | 'agent' | 'site';
export type Check = 'reachability' | 'stream' | 'recording' | 'storage' | 'gateway' | 'internet';
export const CHECKS: Check[] = ['reachability', 'stream', 'recording', 'storage', 'gateway', 'internet'];

export type Category =
  | 'camera_unreachable'
  | 'recorder_unreachable'
  | 'recording_not_confirmed'
  | 'stream_unavailable'
  | 'network_lost'
  | 'internet_outage'
  | 'agent_offline'
  | 'storage_warning'
  | 'status_unknown';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const INCIDENT_STATES = ['OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESTORATION_CHECK', 'RESOLVED', 'CLOSED'] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];
export const ACTIVE_STATES: IncidentState[] = ['OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESTORATION_CHECK'];

export const CATEGORY_LABEL: Record<Category, string> = {
  camera_unreachable: 'Camera unreachable',
  recorder_unreachable: 'DVR/NVR unreachable',
  recording_not_confirmed: 'Recording not confirmed',
  stream_unavailable: 'Video stream unavailable',
  network_lost: 'Site network connectivity lost',
  internet_outage: 'Site internet outage (local monitoring continues)',
  agent_offline: 'Monitoring agent not reporting',
  storage_warning: 'Recorder storage / disk warning',
  status_unknown: 'Status unknown (monitoring data is stale)',
};

/** Which incident category a failed check of a device type confirms. */
export function categoryFor(deviceType: DeviceType, check: Check): Category | undefined {
  if (check === 'reachability') return deviceType === 'camera' ? 'camera_unreachable' : deviceType === 'recorder' ? 'recorder_unreachable' : undefined;
  if (check === 'stream') return deviceType === 'camera' ? 'stream_unavailable' : undefined;
  if (check === 'recording') return deviceType === 'camera' || deviceType === 'recorder' ? 'recording_not_confirmed' : undefined;
  if (check === 'storage') return deviceType === 'recorder' ? 'storage_warning' : undefined;
  if (check === 'gateway') return deviceType === 'site' ? 'network_lost' : undefined;
  if (check === 'internet') return deviceType === 'site' ? 'internet_outage' : undefined;
  return undefined;
}

/**
 * Severity triage (configurable later; these are the defaults):
 *  - a recorder or the whole site network down = critical (many cameras blind at once)
 *  - a critical camera (cash counter, gate) unreachable, or recording failing = high
 *  - the agent not reporting = high (we are blind, not necessarily the cameras)
 *  - a normal camera, a stream problem, a disk warning, an internet outage while monitoring continues = medium
 *  - stale data on a cloud-checked site = low
 */
export function triage(category: Category, ctx: { critical?: boolean; affected?: number } = {}): Severity {
  switch (category) {
    case 'recorder_unreachable':
    case 'network_lost':
      return 'critical';
    case 'recording_not_confirmed':
    case 'agent_offline':
      return 'high';
    case 'camera_unreachable':
      return ctx.critical ? 'high' : 'medium';
    case 'stream_unavailable':
      return ctx.critical ? 'high' : 'medium';
    case 'storage_warning':
    case 'internet_outage':
      return 'medium';
    case 'status_unknown':
      return 'low';
  }
}

/**
 * Safe first steps for a technician. They only describe checks a person can do on site: the assistant has no remote
 * control of any device and never claims to have restarted or reconfigured anything.
 */
export function troubleshooting(category: Category): string[] {
  switch (category) {
    case 'camera_unreachable':
      return [
        'Check the camera power: PoE switch port light, or the adapter at the camera.',
        'Check the network cable at both ends (camera and switch / NVR port).',
        'On the NVR screen, see whether this channel shows "No video" or "Offline".',
        'If other cameras on the same switch are fine, swap the port or patch cable to isolate the fault.',
      ];
    case 'recorder_unreachable':
      return [
        'Check the NVR/DVR power and that its front panel lights are on.',
        'Check the LAN cable from the NVR to the router / switch and the router itself.',
        'If the NVR is powered but unreachable, note the screen state before restarting it, and restart only if your site process allows it.',
        'All cameras behind this recorder are affected: one fix may restore them all.',
      ];
    case 'recording_not_confirmed':
      return [
        'On the NVR, open playback for this camera for the last hour and confirm footage exists.',
        'Check the recording schedule and that the channel is enabled for recording.',
        'Check the disk status on the NVR (HDD error / full / unformatted).',
      ];
    case 'stream_unavailable':
      return [
        'The camera answers on the network but its video stream does not open.',
        'Check the live view on the NVR for this channel.',
        'Check whether the camera was recently reset or its stream settings changed.',
      ];
    case 'storage_warning':
      return [
        'Open the NVR storage / HDD page and note the reported status.',
        'Check the overwrite setting and free space; plan a disk replacement if it reports errors.',
      ];
    case 'network_lost':
      return [
        'The site\'s local network looks down: check the main switch and router power first.',
        'Check whether the switch / router lights are normal and the uplink cable is connected.',
      ];
    case 'internet_outage':
      return [
        'Only the site\'s internet link looks down; local monitoring continues and events will sync when it returns.',
        'Check the broadband router / ISP status, or contact the ISP.',
      ];
    case 'agent_offline':
      return [
        'We have not heard from the monitoring agent: the site internet or the agent PC may be down.',
        'Check that the agent PC / gateway is powered on and connected, and that the site internet is working.',
        'Camera states show "Unknown" until the agent reports again; this is not a confirmed camera failure.',
      ];
    case 'status_unknown':
      return ['No fresh checks have arrived for this site. Check the monitoring path before assuming any camera is down.'];
  }
}

// ------------------------------------------------------------------ messages (templates; sent only outside DRY_RUN)

export const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

export function durationText(min: number): string {
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h} h${m ? ` ${m} min` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ${h % 24} h`;
}

type Inc = { number: string; category: string; deviceCode?: string | null; title: string; affectedCount: number; firstDetectedAt: Date; severity: string };

export function alertMessage(i: Inc, siteName: string, now: Date): string {
  const what = i.deviceCode ? `${i.category === 'recorder_unreachable' ? 'Recorder' : 'Camera'} ${i.deviceCode}` : 'Monitoring';
  const lead =
    i.category === 'camera_unreachable' || i.category === 'recorder_unreachable'
      ? `${what} at ${siteName} has been unreachable for ${durationText(minutesBetween(i.firstDetectedAt, now))}.`
      : i.category === 'agent_offline'
        ? `The monitoring agent at ${siteName} has not reported for ${durationText(minutesBetween(i.firstDetectedAt, now))}. Camera states are UNKNOWN (not confirmed offline).`
        : `${CATEGORY_LABEL[i.category as Category] ?? i.title} at ${siteName}${i.deviceCode ? ` (${i.deviceCode})` : ''}.`;
  const more = i.affectedCount > 1 ? ` ${i.affectedCount} cameras affected.` : '';
  return `${lead}${more} Incident ${i.number} is open (${i.severity}). Please reply "ACK ${i.number}" to acknowledge and check the device or network connection. Reply "HELP ${i.number}" for first checks.`;
}

export function escalationMessage(i: Inc, siteName: string, level: number, now: Date): string {
  return `Escalation L${level}: ${i.number} (${CATEGORY_LABEL[i.category as Category] ?? i.title}${i.deviceCode ? `, ${i.deviceCode}` : ''}) at ${siteName} has not been acknowledged for ${durationText(minutesBetween(i.firstDetectedAt, now))}. Please acknowledge or assign it: reply "ACK ${i.number}".`;
}

export function restoredMessage(i: Inc, checks: number, now: Date): string {
  const what = i.deviceCode ?? 'The site';
  return `${what} is responding again. Restoration of ${i.number} was verified by ${checks} consecutive successful checks. Incident duration: ${durationText(minutesBetween(i.firstDetectedAt, now))}.`;
}

export function customerReport(i: Inc & { rootCause?: string | null; resolutionNote?: string | null }, siteName: string, now: Date): string {
  return `Service update from your CCTV monitoring team: ${i.number} at ${siteName} (${CATEGORY_LABEL[i.category as Category] ?? i.title}${i.deviceCode ? `, ${i.deviceCode}` : ''}) is resolved. Downtime: ${durationText(minutesBetween(i.firstDetectedAt, now))}.${i.rootCause ? ` Cause: ${i.rootCause}.` : ''} Restoration was verified by fresh monitoring checks.`;
}

// ------------------------------------------------------------------ time windows (IST)

const IST_MS = 330 * 60_000;
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const istMinutes = (d: Date) => {
  const t = new Date(d.getTime() + IST_MS);
  return { minute: t.getUTCHours() * 60 + t.getUTCMinutes(), weekday: t.getUTCDay() };
};

/** Inside the quiet window? Handles windows that cross midnight (22:00 → 07:00). */
export function inQuietHours(q: { enabled: boolean; start: string; end: string }, at: Date): boolean {
  if (!q.enabled) return false;
  const { minute } = istMinutes(at);
  const s = mins(q.start), e = mins(q.end);
  return s <= e ? minute >= s && minute < e : minute >= s || minute < e;
}

/** The next moment the quiet window ends (IST). */
export function quietHoursEnd(q: { start: string; end: string }, at: Date): Date {
  const t = new Date(at.getTime() + IST_MS);
  const target = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), Number(q.end.slice(0, 2)), Number(q.end.slice(3, 5))) - IST_MS;
  return new Date(target > at.getTime() ? target : target + 86_400_000);
}

export type Shift = { days?: number[]; start?: string; end?: string } | null | undefined;

/** On shift now? No shift recorded = always available (a small team). */
export function onShift(shift: Shift, at: Date): boolean {
  if (!shift || !shift.start || !shift.end) return true;
  const { minute, weekday } = istMinutes(at);
  if (shift.days?.length && !shift.days.includes(weekday)) return false;
  const s = mins(shift.start), e = mins(shift.end);
  return s <= e ? minute >= s && minute < e : minute >= s || minute < e;
}

// ------------------------------------------------------------------ privacy

/** 192.168.1.64 → 192.168.•.64 ; host:port keeps the port. Never shows credentials (none are stored). */
export function maskAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d+)?$/);
  if (m) return `${m[1]}.${m[2]}.•.${m[4]}${m[5] ?? ''}`;
  return addr.length > 6 ? `${addr.slice(0, 3)}•••${addr.slice(-3)}` : '•••';
}

export const maskPhone = (p: string | null | undefined) => (p ? `${p.slice(0, 4)}••••${p.slice(-3)}` : null);

/** Strip anything that looks like a credential or RTSP URL from text an agent sent (never stored or shown). */
export function scrub(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(/rtsp:\/\/[^\s]+/gi, 'rtsp://[redacted]')
    .replace(/\b(password|passwd|pwd|pass)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\/\/[^/\s:@]+:[^@\s]+@/g, '//[redacted]@')
    .slice(0, 500);
}
