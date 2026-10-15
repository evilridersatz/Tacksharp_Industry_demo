/**
 * Why does PUBLIC_BASE_URL not answer like the Tacksharp API?
 *
 * The API serves GET /health and POST /auth/login at the root (no global prefix). A 404 on those through the
 * public URL therefore means the URL does not reach the API, usually one of:
 *   - the ngrok tunnel is offline / restarted with a new URL (ngrok answers 404 with ERR_NGROK_3200);
 *   - the tunnel points at the dashboard (Next.js, port 3001) instead of the API (port 3000);
 *   - PUBLIC_BASE_URL has a path ("https://x.ngrok-free.app/api") the API does not serve.
 * Read-only checks; nothing is changed. Never prints tokens.
 */
export type BaseUrlDiagnosis = { ok: boolean; problems: string[]; notes: string[] };

/** The local ngrok agent's inspector API (lists running tunnels). */
export const NGROK_INSPECTOR_URL = 'http://127.0.0.1:4040/api/tunnels';

export type DiagnoseOptions = {
  /**
   * Where to ask ngrok which tunnels are running. Defaults to the local agent (NGROK_INSPECTOR_URL), which is what
   * the verify scripts want. Tests pass a mock server's URL, or null to skip the ngrok check, so they never depend on
   * a tunnel running on the developer's machine.
   */
  ngrokInspectorUrl?: string | null;
};

async function get(url: string, timeoutMs = 8000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'ngrok-skip-browser-warning': '1' } });
    const text = await res.text().catch(() => '');
    return { status: res.status, headers: res.headers, text };
  } catch (error) {
    return { status: 0, headers: new Headers(), text: error instanceof Error ? error.message : String(error) };
  }
}

export async function diagnoseBaseUrl(baseUrl: string, env: NodeJS.ProcessEnv = process.env, options: DiagnoseOptions = {}): Promise<BaseUrlDiagnosis> {
  const problems: string[] = [];
  const notes: string[] = [];
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, problems: ['PUBLIC_BASE_URL is not a valid URL'], notes };
  }
  if (url.pathname !== '/' && url.pathname !== '') problems.push(`PUBLIC_BASE_URL has a path ("${url.pathname}"); the API routes are at the root. Use ${url.origin}`);
  const base = url.origin;

  const health = await get(`${base}/health`);
  const isApi = health.status === 200 && /"status"\s*:\s*"(ok|degraded)"/.test(health.text);
  if (isApi) notes.push('GET /health answered by the Tacksharp API');
  else if (health.status === 0) problems.push(`${base} is not reachable (${health.text.slice(0, 120)})`);
  else if (health.headers.get('ngrok-error-code') || /ERR_NGROK_\d+/.test(health.text)) {
    const code = health.headers.get('ngrok-error-code') ?? /ERR_NGROK_\d+/.exec(health.text)?.[0];
    problems.push(`ngrok answered instead of the API (${code}): the tunnel for this URL is offline or was restarted with a new URL. Start ngrok again and update PUBLIC_BASE_URL (and the Plivo / Meta webhook URLs).`);
  } else if (/next\.js/i.test(health.headers.get('x-powered-by') ?? '') || /__next|_next\/static/.test(health.text)) {
    problems.push(`${base} is the dashboard (Next.js), not the API. Point the tunnel at the API port (${env.PORT ?? 3000}): ngrok http ${env.PORT ?? 3000}`);
  } else {
    problems.push(`GET ${base}/health returned HTTP ${health.status}, not the Tacksharp API`);
  }

  // Local checks (on the machine running the API): is the API up, and where does the ngrok tunnel point?
  const local = await get(`http://127.0.0.1:${env.PORT ?? 3000}/health`, 3000);
  notes.push(local.status === 200 ? `the API answers locally on port ${env.PORT ?? 3000}` : `nothing answers /health locally on port ${env.PORT ?? 3000} — is the API running (npm run dev)?`);
  const inspector = options.ngrokInspectorUrl === undefined ? NGROK_INSPECTOR_URL : options.ngrokInspectorUrl;
  const tunnels = inspector ? await get(inspector, 2000) : undefined;
  if (tunnels?.status === 200) {
    try {
      const list = (JSON.parse(tunnels.text).tunnels ?? []) as Array<{ public_url?: string; config?: { addr?: string } }>;
      const mine = list.find((t) => t.public_url && new URL(t.public_url).host === url.host);
      if (mine) {
        const addr = mine.config?.addr ?? '?';
        notes.push(`ngrok tunnel ${url.host} -> ${addr}`);
        if (!new RegExp(`:${env.PORT ?? 3000}$`).test(addr)) problems.push(`the ngrok tunnel for PUBLIC_BASE_URL forwards to ${addr}, not the API port ${env.PORT ?? 3000}`);
      } else if (list.length) {
        problems.push(`ngrok is running with ${list.map((t) => t.public_url).join(', ')} but PUBLIC_BASE_URL is ${base} — update PUBLIC_BASE_URL and the webhook / callback URLs`);
      }
    } catch {
      /* ngrok inspector not JSON: ignore */
    }
  }
  return { ok: isApi && problems.length === 0, problems, notes };
}
