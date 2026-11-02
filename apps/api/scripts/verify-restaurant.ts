/**
 * GR Chicken (restaurant) LIVE readiness check — the restaurant counterpart of verify:live, which checks the
 * real-estate product with fixed real-estate sample data.
 *
 *   npm run verify:restaurant                         # read-only: templates, Sarvam voice tools (menu / price / quote
 *                                                       against the LIVE database; nothing is ordered), server checks
 *   npm run verify:restaurant -- --call=9876543210    # + ONE real Sarvam call to that (approved) number
 *
 * Read-only by default: it reads template status from Meta and asks the voice tools for menu, prices and a quote; it
 * sends no WhatsApp message
 * and places no call. --call places one real call through YOUR server, which still enforces DRY_RUN,
 * LIVE_TEST_RECIPIENTS and the customer's calling consent (the script never bypasses them).
 * Writes verify-output/verify-restaurant-report.md with no secrets and masked phone numbers.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizePhone } from '../src/common/phone.js';
import { diagnoseBaseUrl } from './lib/diagnose-base-url.js';
import { toolKey } from '../src/telephony/sarvam-tools.service.js';

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

// ---------------------------------------------------------------- 2. Sarvam voice tools (grounded answers, read-only)
async function testVoiceTools() {
  head('2. Sarvam voice tools: menu, prices and a quote from the live database (nothing is ordered)');
  const org = env.GR_ORGANIZATION_ID ?? 'org_gr_chicken';
  const key = toolKey(org);
  if (!key) return result('FAIL', 'TELEPHONY_WEBHOOK_SECRET', 'missing or shorter than 32 characters: the voice agent cannot reach its tools');
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  if (!base) return result('SKIP', 'PUBLIC_BASE_URL not set');
  const call = (tool: string, body: Record<string, unknown> = {}, k = key) =>
    getJson(`${base}/telephony/sarvam/tools/${tool}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tacksharp-org': org, 'x-tacksharp-tool-key': k }, body: JSON.stringify(body) });
  const bad = await call('menu', {}, '0'.repeat(64));
  result(bad.status === 403 ? 'PASS' : 'FAIL', 'Wrong tool key is refused', `HTTP ${bad.status}`);
  const menu = await call('menu');
  if (!menu.ok || !menu.body?.ok) return result('FAIL', 'Menu', `HTTP ${menu.status}`);
  result(menu.body.items?.length ? 'PASS' : 'FAIL', 'Menu from the database', `${menu.body.items?.length ?? 0} available products; not available today: ${menu.body.unavailable_today}`);
  lines.push(`\n> ${menu.body.menu_text}`);
  const ctx = await call('context', {});
  result(ctx.body?.ok && /Never Hindi/.test(ctx.body?.language_rule ?? '') ? 'PASS' : 'FAIL', 'On-start context (business, shops, no-Hindi rule)', ctx.body?.business_name ?? `HTTP ${ctx.status}`);
  for (const said of ['broiler', 'naatu kozhi', 'நாட்டுக்கோழி']) {
    const r = await call('item', { item_name: said });
    result(r.body?.found ? 'PASS' : 'WARN', `Price for "${said}"`, r.body?.found ? `${r.body.price_text} ${r.body.availability_text}` : r.body?.message ?? `HTTP ${r.status}`);
  }
  const unknown = await call('item', { item_name: 'mutton biryani' });
  result(unknown.body?.found === false ? 'PASS' : 'FAIL', 'Unknown product is not invented', unknown.body?.found === false ? 'answered "not on our menu"' : JSON.stringify(unknown.body).slice(0, 200));
  const q = await call('quote', { items_text: 'rendu kilo broiler curry cut', pickup_time: 'oru mani nerathula' });
  result(q.body?.ok ? 'PASS' : 'WARN', 'Tanglish quote priced by the order service (not saved)', q.body?.ok ? q.body.summary_text : q.body?.questions_text ?? q.body?.problems_text ?? q.body?.message ?? `HTTP ${q.status}`);
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
  const wh = await getJson(api('/telephony/sarvam/webhook?org=verify&scope=inbound&t=0'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interaction_id: 'verify' }) });
  result(wh.status === 403 ? 'PASS' : 'FAIL', 'Sarvam webhook rejects a bad token', `HTTP ${wh.status}`);
  try {
    await login();
    const me = await authed('/auth/me');
    result(me.body?.vertical === 'restaurant' ? 'PASS' : 'FAIL', 'Dashboard user belongs to a restaurant tenant', `vertical: ${me.body?.vertical ?? 'unknown'} (${me.body?.organizationName ?? ''})`);
    const integ = await authed('/restaurant/integrations');
    if (integ.ok) {
      result(integ.body?.channels?.whatsapp?.connected ? 'PASS' : 'WARN', 'WhatsApp mapped to this tenant', integ.body?.channels?.whatsapp?.connected ? 'yes' : 'no — inbound WhatsApp will not reach GR Chicken');
      for (const r of integ.body?.routing ?? []) {
        if (!r.configured) continue;
        const what = `WhatsApp number ${r.number}`;
        result(r.toThisBusiness ? 'PASS' : 'FAIL', `${what} reach GR Chicken`, r.toThisBusiness ? `via ${r.via}` : `NO — routed to a ${r.vertical} organization (${r.via}). Map it: npm run seed:gr-chicken with GR_WHATSAPP_PHONE_NUMBER_ID`);
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
  const start = await authed('/voice/call', { method: 'POST', body: JSON.stringify({ customerId: customer.id, confirm: true }) });
  if (!start.body?.started) return result('FAIL', 'Dial', `not started: ${start.body?.reason ?? start.status} (the server enforces DRY_RUN / LIVE_TEST_RECIPIENTS / consent / the Sarvam agent for automatic calls)`);
  // Sarvam reports the call by webhook after it ends.
  const deadline = Date.now() + 6 * 60_000;
  let call: any = null;
  while (Date.now() < deadline) {
    const req = (await authed(`/telephony/calls/${start.body.requestId}`)).body;
    if (req?.callId) { call = (await authed(`/voice/calls/${req.callId}`)).body; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!call?.call) return result('FAIL', 'Restaurant call', 'no Sarvam webhook within 6 minutes');
  const c = call.call;
  result((call.transcript ?? []).length >= 3 ? 'PASS' : 'FAIL', 'Transcript saved', `${(call.transcript ?? []).length} lines · ${c.durationSec ?? 0}s · summary: ${c.summary ?? '—'}`);
  const transcript = (call.transcript ?? []).map((m: any) => `> **${m.role === 'user' ? 'Customer' : 'AI'}:** ${m.content}`).join('\n');
  const leak = /\b(BHK|property|site visit|apartment|villa|lakhs?)\b/i.test((call.transcript ?? []).filter((m: any) => m.role === 'assistant').map((m: any) => m.content).join(' '));
  result(leak ? 'FAIL' : 'PASS', 'No real-estate words in the assistant\'s lines', leak ? 'found property / BHK words' : 'none');
  lines.push(`\nTranscript:\n${transcript}`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log('GR Chicken live readiness — read-only unless --call is given. No secrets are printed.');
  await testTemplates();
  await testVoiceTools();
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
