#!/usr/bin/env node
/**
 * Tacksharp VisionOps — reference local monitoring agent (Node 20+, no dependencies).
 *
 * Runs on a PC / mini-PC / gateway inside the site LAN. It checks ONLY the devices listed in its config file, keeps
 * every result in a local queue file, and syncs to the cloud when the internet is available:
 *
 *   - reachability: TCP connect to host:port (camera / NVR web or RTSP port)
 *   - stream:       RTSP OPTIONS request on the RTSP port (a camera answering RTSP; no video is pulled)
 *   - vendor_api:   HTTP GET of a health URL you configure (e.g. an NVR status endpoint) → ok if 2xx
 *   - recording / storage: only via a vendor adapter you enable; otherwise never reported (never guessed from a ping)
 *   - gateway:      TCP connect to the site router; internet: HTTPS reachability of the cloud API
 *
 * Credentials for RTSP / vendor APIs stay in this local config and are NEVER sent to the cloud (events carry only
 * device codes, check names, ok/fail, timings and scrubbed details). No footage leaves the site.
 *
 * Offline: results are appended to a JSONL queue; on reconnect the queue is sent oldest-first in batches with the
 * original observedAt timestamps and stable event ids, so the cloud replays them in order and ignores duplicates.
 *
 *   node agent.mjs --config ./agent.config.json          # run
 *   node agent.mjs --config ./agent.config.json --once   # one check + sync cycle (cron / testing)
 */
import { createConnection } from 'node:net';
import { readFileSync, appendFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomUUID, createHash, verify } from 'node:crypto';

export const VERSION = '0.9.0';

// ------------------------------------------------------------------ checks

export function tcpCheck(host, port, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok, detail) => { sock.destroy(); resolve({ ok, latencyMs: Date.now() - started, ...(detail ? { detail } : {}) }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code ?? 'error'));
  });
}

/** RTSP OPTIONS: proves the camera's RTSP service answers. Uses no credentials and pulls no video. */
export function rtspOptions(host, port = 554, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve) => {
    let buf = '';
    const sock = createConnection({ host, port });
    const done = (ok, detail) => { sock.destroy(); resolve({ ok, latencyMs: Date.now() - started, ...(detail ? { detail } : {}) }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => sock.write(`OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: tacksharp-visionops-agent/${VERSION}\r\n\r\n`));
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n')) done(/^RTSP\/1\.0 (200|401)/.test(buf), buf.split('\r\n')[0].slice(0, 60));
    });
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code ?? 'error'));
  });
}

export async function httpCheck(url, timeoutMs = 4000) {
  const started = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return { ok: r.ok, latencyMs: Date.now() - started, detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, detail: e.name === 'AbortError' ? 'timeout' : (e.cause?.code ?? e.message ?? 'error') };
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------------ queue (durable, append-only)

export class Queue {
  constructor(file) { this.file = file; }
  push(events) { if (events.length) appendFileSync(this.file, events.map((e) => JSON.stringify(e)).join('\n') + '\n'); }
  all() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  size() { return this.all().length; }
  /** Drop the first n events (after the cloud accepted them). Atomic rewrite. */
  drop(n) {
    const rest = this.all().slice(n);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, rest.map((e) => JSON.stringify(e)).join('\n') + (rest.length ? '\n' : ''));
    renameSync(tmp, this.file);
  }
}

/** Never send credentials or RTSP URLs to the cloud, even inside an error message. */
export function scrub(text) {
  if (!text) return undefined;
  return String(text).replace(/rtsp:\/\/[^\s]+/gi, 'rtsp://[redacted]').replace(/\/\/[^/\s:@]+:[^@\s]+@/g, '//[redacted]@').replace(/(password|pass|pwd)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 300);
}

// ------------------------------------------------------------------ one cycle

/** Check every configured device once and return events (not yet sent). */
export async function runChecks(cfg, now = () => new Date()) {
  const out = [];
  const ev = (device, deviceType, check, r) => out.push({ eventId: randomUUID(), device, deviceType, check, ok: r.ok, observedAt: now().toISOString(), latencyMs: r.latencyMs, detail: scrub(r.detail) });
  for (const d of cfg.devices ?? []) {
    const type = d.type === 'recorder' ? 'recorder' : 'camera';
    if (d.host && d.port) ev(d.code, type, 'reachability', await tcpCheck(d.host, d.port, cfg.timeoutMs));
    if (d.rtspPort && d.checks?.includes('stream')) ev(d.code, type, 'stream', await rtspOptions(d.host, d.rtspPort, cfg.timeoutMs));
    if (d.healthUrl && d.checks?.includes('vendor_api')) ev(d.code, type, 'reachability', await httpCheck(d.healthUrl, cfg.timeoutMs));
    // recording / storage: only from a vendor adapter that reads the recorder's own status. None is enabled here.
  }
  if (cfg.gateway?.host) ev(undefined, 'site', 'gateway', await tcpCheck(cfg.gateway.host, cfg.gateway.port ?? 80, cfg.timeoutMs));
  return out;
}

async function post(cfg, path, body, fetchImpl = fetch) {
  const r = await fetchImpl(`${cfg.cloudUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

/** Send the queue oldest-first in batches; stops at the first failure (kept for the next cycle). */
export async function sync(cfg, queue, fetchImpl = fetch, batch = 200) {
  let sent = 0;
  for (;;) {
    const pending = queue.all().slice(0, batch);
    if (!pending.length) break;
    try {
      const r = await post(cfg, '/monitoring/agent/events', { events: pending }, fetchImpl);
      queue.drop(pending.length);
      sent += r.accepted + r.duplicates;
    } catch (e) {
      return { sent, ok: false, error: e.message };
    }
  }
  return { sent, ok: true };
}

export async function heartbeat(cfg, queue, fetchImpl = fetch, link = 'primary') {
  return post(cfg, '/monitoring/agent/heartbeat', { sentAt: new Date().toISOString(), queueDepth: queue.size(), version: VERSION, uptimeSec: Math.round(process.uptime()), link, hostLabel: cfg.hostLabel }, fetchImpl);
}

/**
 * Signed updates: an update is applied only if its manifest {version, sha256} is signed with the publisher key
 * (Ed25519) configured locally AND the downloaded file matches the sha256. This reference agent verifies; the actual
 * download / replace is left to the installer.
 */
export function verifyUpdate(manifestJson, signatureB64, fileBuffer, publicKeyPem) {
  const okSig = verify(null, Buffer.from(manifestJson), publicKeyPem, Buffer.from(signatureB64, 'base64'));
  if (!okSig) return { ok: false, reason: 'bad signature' };
  const m = JSON.parse(manifestJson);
  const sum = createHash('sha256').update(fileBuffer).digest('hex');
  return sum === m.sha256 ? { ok: true, version: m.version } : { ok: false, reason: 'checksum mismatch' };
}

// ------------------------------------------------------------------ main loop

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const cfg = JSON.parse(readFileSync(arg('--config') ?? './agent.config.json', 'utf8'));
  const queue = new Queue(cfg.queueFile ?? './visionops-queue.jsonl');
  const cycle = async () => {
    queue.push(await runChecks(cfg));
    const internet = cfg.cloudUrl ? await httpCheck(`${cfg.cloudUrl.replace(/\/$/, '')}/health`, 5000) : { ok: false };
    if (!internet.ok) { console.log(`[visionops] offline: ${queue.size()} event(s) queued locally`); return; }
    const s = await sync(cfg, queue);
    await heartbeat(cfg, queue, fetch, cfg.backupLink ? 'backup_4g' : 'primary').catch((e) => console.log(`[visionops] heartbeat failed: ${e.message}`));
    console.log(`[visionops] synced ${s.sent} event(s)${s.ok ? '' : ` (stopped: ${s.error})`}; queue ${queue.size()}`);
  };
  await cycle();
  if (process.argv.includes('--once')) return;
  setInterval(() => void cycle().catch((e) => console.log(`[visionops] cycle failed: ${e.message}`)), Math.max(30, cfg.intervalSeconds ?? 60) * 1000);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
