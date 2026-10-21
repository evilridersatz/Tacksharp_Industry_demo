/**
 * GR Chicken (restaurant) LIVE readiness check — the restaurant counterpart of verify:live, which checks the
 * real-estate product with fixed real-estate sample data.
 *
 *   npm run verify:restaurant                         # read-only: templates, Plivo callbacks, server, signatures
 *   npm run verify:restaurant -- --call=9876543210    # + ONE real restaurant AI call to that (approved) number
 *
 * Read-only by default: it reads template status from Meta and settings from Plivo; it sends no WhatsApp message
 * and places no call. --call places one real call through YOUR server, which still enforces DRY_RUN,
 * LIVE_TEST_RECIPIENTS and the customer's calling consent (the script never bypasses them).
 * Writes verify-output/verify-restaurant-report.md with no secrets and masked phone numbers.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizePhone } from '../src/common/phone.js';
import { diagnoseBaseUrl } from './lib/diagnose-base-url.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : 'true'];
  }),
);
const env = process.env;
const OUT = path.resolve(process.cwd(), 'verify-output');
// Overridable only so the script itself can be tested offline; never set these in normal use.
const GRAPH = env.VERIFY_GRAPH_BASE ?? 'https://graph.facebook.com';
const PLIVO = env.VERIFY_PLIVO_BASE ?? 'https://api.plivo.com';

type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
const report: Array<{ status: Status; name: string; detail?: string }> = [];
const lines: string[] = [];
const mask = (p: string) => (p.length > 4 ? `${'*'.repeat(p.length - 4)}${p.slice(-4)}` : p);
function head(t: string) {
  console.log(`\n== ${t}`);
  lines.push(`\n## ${t}\n`);
}
function result(status: Status, name: string, detail = '') {
  report.push({ status, name, detail });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}`);
  lines.push(`- **${status}** ${name}${detail ? ` — ${detail}` : ''}`);
}
async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: body as any };
}
const errText = (b: any) => String(b?.error?.message ?? b?.message ?? b?.error ?? JSON.stringify(b)).slice(0, 200);

// ---------------------------------------------------------------- 1. WhatsApp templates
/** The restaurant templates the code sends, with the exact number of body variables it fills in. */
export const RESTAURANT_TEMPLATES = [
  { env: 'WHATSAPP_TEMPLATE_ORDER_READY', params: 1, use: '"order ready" message outside the 24h window ({{1}} order number)' },
  { env: 'FOLLOWUP_CONFIRMATION_TEMPLATE', params: 2, use: 'order confirmation / update outside 24h ({{1}} order number, {{2}} customer name)' },
  { env: 'FOLLOWUP_FEEDBACK_TEMPLATE', params: 1, use: 'feedback request outside 24h ({{1}} order number)' },
];

/** Distinct {{n}} variables in a template's BODY component. */
export function bodyVariables(components: Array<{ type?: string; text?: string }> | undefined): number {
  const body = (components ?? []).find((c) => String(c.type).toUpperCase() === 'BODY');
  return new Set([...(body?.text ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1])).size;
}

async function testTemplates() {
  head('1. WhatsApp templates for GR Chicken (read-only)');
  const lang = env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en';
  lines.push(`Template language in .env: \`${lang}\` (every template below must be approved in this language).\n`);
  const canRead = Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_BUSINESS_ACCOUNT_ID);
  for (const t of RESTAURANT_TEMPLATES) {
    const name = env[t.env];
    if (!name) {
      result('WARN', `${t.env}`, `not set — BLOCKER for the ${t.use}; inside 24h a normal message is used. Do not guess a name: copy it from WhatsApp Manager once Meta approves it.`);
      continue;
    }
    if (!canRead) {
      result('SKIP', `${t.env}`, 'set, but WHATSAPP_ACCESS_TOKEN / WHATSAPP_BUSINESS_ACCOUNT_ID missing — approval not checked');
      continue;
    }
    const v = env.WHATSAPP_API_VERSION ?? 'v23.0';
    const r = await getJson(`${GRAPH}/${v}/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,category,language,components`, {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (!r.ok) {
      result('FAIL', `${t.env}`, `Meta: ${errText(r.body)}`);
      continue;
    }
    const all: any[] = (r.body?.data ?? []).filter((x: any) => x.name === name);
    const tpl = all.find((x) => x.language === lang);
    if (!tpl) {
      result('FAIL', `${t.env} = "${name}"`, all.length ? `exists only in ${all.map((x) => x.language).join(', ')}, not "${lang}" (WHATSAPP_TEMPLATE_LANGUAGE)` : 'not found in this WhatsApp Business Account');
      continue;
    }
    const vars = bodyVariables(tpl.components);
    const problems = [
      tpl.status !== 'APPROVED' ? `status ${tpl.status}` : '',
      vars !== t.params ? `body has ${vars} variable(s), the code sends ${t.params}` : '',
    ].filter(Boolean);
    result(problems.length ? 'FAIL' : 'PASS', `${t.env} = "${name}" (${tpl.language})`, problems.length ? problems.join('; ') : `APPROVED · ${tpl.category} · ${vars} variable(s)`);
  }
}

// ---------------------------------------------------------------- 2. Plivo callbacks + signature
async function testPlivo() {
  head('2. Plivo callbacks and signature check');
  result(env.PLIVO_VALIDATE_SIGNATURE === 'true' ? 'PASS' : 'WARN', 'PLIVO_VALIDATE_SIGNATURE', env.PLIVO_VALIDATE_SIGNATURE === 'true' ? 'true' : 'not true — anyone who knows the URL could post fake call events. Turn it on once PUBLIC_BASE_URL is the HTTPS URL Plivo calls.');
  if (!env.PLIVO_AUTH_ID || !env.PLIVO_AUTH_TOKEN) return result('SKIP', 'Plivo account', 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not set');
  const auth = { Authorization: 'Basic ' + Buffer.from(`${env.PLIVO_AUTH_ID}:${env.PLIVO_AUTH_TOKEN}`).toString('base64') };
  const from = normalizePhone(env.PLIVO_FROM_NUMBER);
  if (!from) return result('FAIL', 'PLIVO_FROM_NUMBER', 'not set or invalid');
  const n = await getJson(`${PLIVO}/v1/Account/${env.PLIVO_AUTH_ID}/Number/${from}/`, { headers: auth });
  if (!n.ok) return result('FAIL', `Number ${mask(from)}`, errText(n.body));
  const appId = String(n.body.application ?? '').split('/').filter(Boolean).pop();
  if (!appId) return result('WARN', 'Inbound application', 'no Plivo application on this number — customers calling the shop number will not reach the assistant (outbound calls still work)');
  const app = await getJson(`${PLIVO}/v1/Account/${env.PLIVO_AUTH_ID}/Application/${appId}/`, { headers: auth });
  if (!app.ok) return result('FAIL', 'Inbound application', errText(app.body));
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  result(app.body.answer_url === `${base}/voice/inbound` ? 'PASS' : 'FAIL', 'Inbound Answer URL', app.body.answer_url === `${base}/voice/inbound` ? 'matches PUBLIC_BASE_URL' : `should be ${base}/voice/inbound`);
  result(app.body.hangup_url === `${base}/voice/hangup` ? 'PASS' : 'FAIL', 'Inbound Hangup URL', app.body.hangup_url === `${base}/voice/hangup` ? 'matches PUBLIC_BASE_URL' : `should be ${base}/voice/hangup`);
}

// ---------------------------------------------------------------- 3. Server
let cookie = '';
const api = (p: string) => `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}${p}`;
const authed = (p: string, init: RequestInit = {}) => getJson(api(p), { ...init, headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) } });

async function login() {
  const email = env.VERIFY_EMAIL ?? env.ADMIN_EMAIL;
  const password = env.VERIFY_PASSWORD ?? env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('set VERIFY_EMAIL / VERIFY_PASSWORD (a GR Chicken dashboard user) in .env');
  const res = await fetch(api('/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function testServer() {
  head('3. Your server');
  if (!env.PUBLIC_BASE_URL) return result('SKIP', 'PUBLIC_BASE_URL not set');
  const diag = await diagnoseBaseUrl(env.PUBLIC_BASE_URL);
  for (const p of diag.problems) result('FAIL', 'PUBLIC_BASE_URL reaches the API', p);
  for (const n of diag.notes) lines.push(`- ${n}`);
  if (!diag.ok) return; // login and callbacks would fail for the same reason
  try {
    const h = await getJson(api('/health'));
    result(h.ok ? 'PASS' : 'FAIL', 'GET /health', `db ${h.body?.database?.ok} · redis ${h.body?.redis?.ok}`);
  } catch (e) {
    return result('FAIL', 'GET /health', `unreachable: ${e instanceof Error ? e.message : e}`);
  }
  for (const p of ['/voice/turn?callId=verify', '/voice/ready/turn?callId=verify', '/voice/feedback/turn?followUpId=verify']) {
    const r = await getJson(api(p), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'CallUUID=verify' });
    result(r.status === 403 ? 'PASS' : 'WARN', `Unsigned POST ${p.split('?')[0]} is rejected`, `HTTP ${r.status}${r.status === 403 ? '' : ' (PLIVO_VALIDATE_SIGNATURE is off on the server)'}`);
  }
  try {
    await login();
    const me = await authed('/auth/me');
    result(me.body?.vertical === 'restaurant' ? 'PASS' : 'FAIL', 'Dashboard user belongs to a restaurant tenant', `vertical: ${me.body?.vertical ?? 'unknown'} (${me.body?.organizationName ?? ''})`);
    const integ = await authed('/restaurant/integrations');
    if (integ.ok) {
      result(integ.body?.channels?.whatsapp?.connected ? 'PASS' : 'WARN', 'WhatsApp mapped to this tenant', integ.body?.channels?.whatsapp?.connected ? 'yes' : 'no — inbound WhatsApp will not reach GR Chicken');
      for (const r of integ.body?.routing ?? []) {
        if (!r.configured) continue;
        const what = r.kind === 'plivo_number' ? `Inbound calls to the Plivo number ${r.number}` : `WhatsApp number ${r.number}`;
        result(r.toThisBusiness ? 'PASS' : 'FAIL', `${what} reach GR Chicken`, r.toThisBusiness ? `via ${r.via}` : `NO — routed to a ${r.vertical} organization (${r.via}). Map it: npm run seed:gr-chicken with ${r.kind === 'plivo_number' ? 'GR_PLIVO_NUMBER' : 'GR_WHATSAPP_PHONE_NUMBER_ID'}`);
      }
      result('PASS', 'Server mode', integ.body?.mode ? `DRY_RUN=${integ.body.mode.dryRun} · approved test numbers: ${integ.body.mode.liveTestRecipients}` : 'unknown');
    }
  } catch (e) {
    result('FAIL', 'Dashboard login', e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------- 4. One real restaurant call (opt-in)
async function testCall() {
  head('4. REAL restaurant AI call (opt-in)');
  const phone = normalizePhone(String(args.call));
  if (!phone) return result('FAIL', 'Restaurant call', 'invalid --call number');
  if (!cookie) await login();
  const found = await authed(`/restaurant/customers?q=${encodeURIComponent(phone.slice(-10))}`);
  const customer = (found.body ?? []).find((c: any) => normalizePhone(c.phone) === phone);
  if (!customer) return result('FAIL', 'Customer', `${mask(phone)} is not a GR Chicken customer yet — message the business on WhatsApp from it first`);
  if (!customer.callingConsent) return result('FAIL', 'Calling consent', `turn on "Follow-up calls" for ${mask(phone)} on the Customers page first`);
  console.log(`Calling ${mask(phone)}. Answer, then say for example:\n  1) "ரெண்டு கிலோ broiler curry cut வேணும்"  2) "rate enna?"  3) "சரி, bye"`);
  const start = await authed('/voice/call', { method: 'POST', body: JSON.stringify({ customerId: customer.id }) });
  if (!start.body?.started) return result('FAIL', 'Dial', `not started: ${start.body?.reason ?? start.status} (the server enforces DRY_RUN / LIVE_TEST_RECIPIENTS / consent)`);
  const deadline = Date.now() + 6 * 60_000;
  let call: any = null;
  while (Date.now() < deadline) {
    call = (await authed(`/voice/calls/${start.body.callId}`)).body;
    if (call?.call?.endedAt) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!call?.call?.endedAt) return result('FAIL', 'Restaurant call', 'did not finish within 6 minutes');
  const c = call.call;
  result(c.turns >= 3 ? 'PASS' : 'FAIL', 'Call stayed open for a multi-turn conversation', `${c.turns} turns · ${c.durationSec ?? 0}s · ended: ${c.endReason ?? c.hangupCause ?? '—'}`);
  const transcript = (call.transcript ?? []).map((m: any) => `> **${m.role === 'user' ? 'Customer' : 'AI'}:** ${m.content}`).join('\n');
  const leak = /\b(BHK|property|site visit|apartment|villa|lakhs?)\b/i.test((call.transcript ?? []).filter((m: any) => m.role === 'assistant').map((m: any) => m.content).join(' '));
  result(leak ? 'FAIL' : 'PASS', 'No real-estate words in the assistant\'s lines', leak ? 'found property / BHK words' : 'none');
  lines.push(`\nTranscript:\n${transcript}`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log('GR Chicken live readiness — read-only unless --call is given. No secrets are printed.');
  await testTemplates();
  await testPlivo();
  await testServer();
  if (args.call) await testCall().catch((e) => result('FAIL', 'Restaurant call', String(e?.message ?? e)));
  const count = (s: Status) => report.filter((r) => r.status === s).length;
  const header = `# GR Chicken readiness report\n\nRun: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\n\n**${count('PASS')} passed · ${count('FAIL')} failed · ${count('WARN')} warnings · ${count('SKIP')} skipped**\n\nNo API keys, tokens or full phone numbers are included.`;
  const file = path.join(OUT, 'verify-restaurant-report.md');
  await fs.writeFile(file, `${header}\n${lines.join('\n')}\n`);
  console.log(`\n${count('PASS')} passed · ${count('FAIL')} failed · ${count('WARN')} warnings · ${count('SKIP')} skipped\nReport: ${file}`);
  process.exit(count('FAIL') ? 1 : 0);
}

if (process.argv[1] && /verify-restaurant\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
