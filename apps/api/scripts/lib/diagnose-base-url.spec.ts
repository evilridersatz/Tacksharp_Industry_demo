import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diagnoseBaseUrl } from './diagnose-base-url.js';

/** Three local stand-ins: the API, the Next.js dashboard, and an offline ngrok endpoint. */
const servers: http.Server[] = [];
const start = (handler: http.RequestListener) =>
  new Promise<string>((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    servers.push(s);
  });
let api = '', dashboard = '', ngrokOffline = '';
const env = { PORT: '1' } as NodeJS.ProcessEnv; // nothing local on port 1: the local check just reports it
/** The ngrok check is off unless a test supplies a mock inspector: never the developer's real ngrok agent. */
const noNgrok = { ngrokInspectorUrl: null };
/** A stand-in for ngrok's inspector API (GET /api/tunnels) listing the given tunnels. */
const inspector = (tunnels: Array<{ public_url: string; config: { addr: string } }>) =>
  start((req, res) => (req.url === '/api/tunnels' ? res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tunnels })) : res.writeHead(404).end()));

beforeAll(async () => {
  api = await start((req, res) => (req.url === '/health' ? res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}') : res.writeHead(404).end()));
  dashboard = await start((_req, res) => res.writeHead(404, { 'x-powered-by': 'Next.js', 'content-type': 'text/html' }).end('<html><script src="/_next/static/x.js"></script></html>'));
  ngrokOffline = await start((_req, res) => res.writeHead(404, { 'ngrok-error-code': 'ERR_NGROK_3200' }).end('The endpoint is offline. ERR_NGROK_3200'));
});
afterAll(() => servers.forEach((s) => s.close()));

describe('why /health and /auth/login return 404 through PUBLIC_BASE_URL', () => {
  it('the API itself passes', async () => {
    const d = await diagnoseBaseUrl(api, env, noNgrok);
    expect(d.problems).toEqual([]);
    expect(d.ok).toBe(true);
  });
  it('a tunnel to the dashboard (port 3001) is named as such', async () => {
    const d = await diagnoseBaseUrl(dashboard, env, noNgrok);
    expect(d.ok).toBe(false);
    expect(d.problems.join(' ')).toContain('is the dashboard (Next.js), not the API');
  });
  it('an offline / restarted ngrok tunnel is named as such', async () => {
    const d = await diagnoseBaseUrl(ngrokOffline, env, noNgrok);
    expect(d.problems.join(' ')).toContain('ERR_NGROK_3200');
  });
  it('a path in PUBLIC_BASE_URL is reported (routes are at the root)', async () => {
    const d = await diagnoseBaseUrl(`${api}/api`, env, noNgrok);
    expect(d.problems.join(' ')).toContain('has a path ("/api")');
  });
});

describe('ngrok tunnel checks (mock inspector only — never the real local ngrok agent)', () => {
  it('the API passes when the inspector reports no tunnels', async () => {
    const d = await diagnoseBaseUrl(api, env, { ngrokInspectorUrl: `${await inspector([])}/api/tunnels` });
    expect(d.problems).toEqual([]);
    expect(d.ok).toBe(true);
  });
  it('an inspector that does not answer is not a problem (ngrok not in use)', async () => {
    const d = await diagnoseBaseUrl(api, env, { ngrokInspectorUrl: 'http://127.0.0.1:1/api/tunnels' });
    expect(d.problems).toEqual([]);
    expect(d.ok).toBe(true);
  });
  it('a running tunnel with a different URL than PUBLIC_BASE_URL is reported as a mismatch', async () => {
    const other = 'https://example-tunnel.ngrok-free.test';
    const d = await diagnoseBaseUrl(api, env, { ngrokInspectorUrl: `${await inspector([{ public_url: other, config: { addr: 'http://localhost:1' } }])}/api/tunnels` });
    expect(d.ok).toBe(false);
    expect(d.problems).toEqual([`ngrok is running with ${other} but PUBLIC_BASE_URL is ${api} — update PUBLIC_BASE_URL and the webhook / callback URLs`]);
  });
  it('the tunnel for PUBLIC_BASE_URL forwarding to another port (e.g. the dashboard) is reported', async () => {
    const d = await diagnoseBaseUrl(api, env, { ngrokInspectorUrl: `${await inspector([{ public_url: api, config: { addr: 'http://localhost:3001' } }])}/api/tunnels` });
    expect(d.ok).toBe(false);
    expect(d.problems).toEqual(['the ngrok tunnel for PUBLIC_BASE_URL forwards to http://localhost:3001, not the API port 1']);
    expect(d.notes).toContain(`ngrok tunnel ${new URL(api).host} -> http://localhost:3001`);
  });
  it('the tunnel for PUBLIC_BASE_URL forwarding to the API port passes', async () => {
    const d = await diagnoseBaseUrl(api, env, { ngrokInspectorUrl: `${await inspector([{ public_url: api, config: { addr: 'http://localhost:1' } }])}/api/tunnels` });
    expect(d.problems).toEqual([]);
    expect(d.ok).toBe(true);
  });
});
