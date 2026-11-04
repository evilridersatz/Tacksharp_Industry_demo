/**
 * Configuration readiness check — reads apps/api/.env and prints which settings are SET or MISSING.
 * Never prints a secret value: only names, "set" / "missing", and harmless values (true/false flags, language
 * codes, numbers, URLs scheme+host). Makes no network request and changes nothing.
 *
 *   npm run check:config            (from the repo root)
 *
 * Exit code 0 = nothing blocking; 1 = a setting needed for the selected mode is missing.
 */
import 'dotenv/config';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Level = 'OK' | 'MISSING' | 'WARN' | 'INFO';
const env = process.env;
const rows: Array<{ group: string; name: string; level: Level; note: string }> = [];
const set = (name: string) => Boolean(env[name] && env[name]!.trim());
const row = (group: string, name: string, level: Level, note = '') => rows.push({ group, name, level, note });

function secret(group: string, name: string, required: boolean, why = '') {
  row(group, name, set(name) ? 'OK' : required ? 'MISSING' : 'WARN', set(name) ? 'set' : `missing${why ? ` — ${why}` : ''}`);
}
function shown(group: string, name: string, fallback: string, note = '') {
  row(group, name, 'INFO', `${set(name) ? env[name] : `${fallback} (default)`}${note ? ` — ${note}` : ''}`);
}
function hostOnly(url: string | undefined) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'not a valid URL';
  }
}

const dryRun = env.DRY_RUN !== 'false';
const whatsappLive = set('WHATSAPP_ACCESS_TOKEN');
const voiceLive = set('SARVAM_AGENTS_API_KEY');

// Core
row('Core', 'PUBLIC_BASE_URL', set('PUBLIC_BASE_URL') ? (env.PUBLIC_BASE_URL!.startsWith('https://') ? 'OK' : 'WARN') : 'MISSING', set('PUBLIC_BASE_URL') ? `${hostOnly(env.PUBLIC_BASE_URL)}${env.PUBLIC_BASE_URL!.startsWith('https://') ? '' : ' — Plivo and Meta need HTTPS'}` : 'missing — webhooks and call audio need it');
secret('Core', 'AUTH_SECRET', true, 'dashboard login sessions');
shown('Core', 'DEFAULT_ORGANIZATION_ID', 'org_default');

// Database / Redis (names only)
for (const n of ['DB_HOST', 'DB_NAME', 'DB_USER']) secret('Database', n, true);
secret('Database', 'DB_PASSWORD', false);
secret('Redis', 'REDIS_HOST', false, 'defaults to localhost');
shown('Redis', 'REDIS_TLS', 'false');

// Safety mode
row('Safety', 'DRY_RUN', 'INFO', dryRun ? 'true — restaurant follow-ups and restaurant calls are simulated (nothing is sent)' : 'false — live mode');
row('Safety', 'LIVE_TEST_RECIPIENTS', dryRun ? 'INFO' : set('LIVE_TEST_RECIPIENTS') || env.LIVE_ALLOW_ALL_CUSTOMERS === 'true' ? 'OK' : 'WARN', set('LIVE_TEST_RECIPIENTS') ? `${env.LIVE_TEST_RECIPIENTS!.split(',').filter(Boolean).length} approved number(s)` : 'none — live mode reaches nobody');
shown('Safety', 'LIVE_ALLOW_ALL_CUSTOMERS', 'false');

// WhatsApp
secret('WhatsApp', 'WHATSAPP_ACCESS_TOKEN', false, 'no WhatsApp sending');
secret('WhatsApp', 'WHATSAPP_PHONE_NUMBER_ID', whatsappLive);
secret('WhatsApp', 'WHATSAPP_BUSINESS_ACCOUNT_ID', false, 'needed to check template approval (npm run verify:restaurant)');
secret('WhatsApp', 'WHATSAPP_VERIFY_TOKEN', whatsappLive, 'Meta webhook verification');
secret('WhatsApp', 'META_APP_SECRET', whatsappLive, 'webhook signature check');
shown('WhatsApp', 'WHATSAPP_API_VERSION', 'v23.0');
shown('WhatsApp', 'WHATSAPP_TEMPLATE_LANGUAGE', 'en', 'must equal the approved language of EVERY template below');

// Restaurant templates (names are not secret, but only presence matters here)
const tpl = (name: string, params: string, use: string) =>
  row('Restaurant templates', name, set(name) ? 'OK' : 'WARN', set(name) ? `set — must be APPROVED with ${params}` : `missing — ${use} reaches only customers who messaged in the last 24h`);
tpl('WHATSAPP_TEMPLATE_ORDER_READY', '1 body variable ({{1}} order number)', '"order ready" WhatsApp fallback');
tpl('FOLLOWUP_CONFIRMATION_TEMPLATE', '2 body variables ({{1}} order number, {{2}} customer name)', 'order confirmation / updates');
tpl('FOLLOWUP_FEEDBACK_TEMPLATE', '1 body variable ({{1}} order number)', 'feedback request');
row('Restaurant templates', 'Offer template', 'INFO', 'set per offer campaign in the dashboard (Offers page), not in .env');

// Real-estate templates (other product; listed so their absence is not confused with a restaurant problem)
row('Real-estate templates', 'WHATSAPP_TEMPLATE_NAME', set('WHATSAPP_TEMPLATE_NAME') ? 'OK' : 'INFO', set('WHATSAPP_TEMPLATE_NAME') ? 'set' : 'missing — only affects real-estate lead first contact, not GR Chicken');

// Voice
if (set('PLIVO_AUTH_ID') || set('PLIVO_AUTH_TOKEN') || set('PLIVO_FROM_NUMBER')) row('Voice', 'PLIVO_*', 'WARN', 'Plivo was removed: these settings are ignored; delete them');
secret('Voice (Sarvam)', 'SARVAM_API_KEY', voiceLive, 'speech-to-text / text-to-speech for calls');

// Stock alerts (optional)
row('Stock alerts', 'STOCK_ALERT_SNS_TOPIC_ARN', set('STOCK_ALERT_SNS_TOPIC_ARN') ? 'OK' : 'INFO', set('STOCK_ALERT_SNS_TOPIC_ARN') ? 'set' : 'not set — low-stock alerts are skipped (stock still works)');
row('Stock alerts', 'AWS credentials', set('AWS_ACCESS_KEY_ID') || set('AWS_PROFILE') ? 'OK' : 'INFO', set('AWS_ACCESS_KEY_ID') || set('AWS_PROFILE') ? 'present (not shown)' : 'from the standard AWS chain (env, profile or instance role)');

// AI
row('AI', 'OPENAI_API_KEY / OPENAI_BASE_URL', set('OPENAI_API_KEY') || set('OPENAI_BASE_URL') ? 'OK' : 'INFO', set('OPENAI_API_KEY') || set('OPENAI_BASE_URL') ? 'set' : 'none — ordering still works by rules; free-form questions get a help reply');

// Enterprise: per-organization credentials (encrypted), signup
secret('Enterprise', 'CREDENTIALS_KEYS', false, 'organizations cannot save their own provider credentials (environment accounts keep working)');
secret('Enterprise', 'CREDENTIALS_ACTIVE_KEY', set('CREDENTIALS_KEYS'));
shown('Enterprise', 'SIGNUP_ENABLED', 'true', 'public self-service registration');

// Voice agents, knowledge bases, telephony routing (release 2026-10-30)
{
  const s = env.TELEPHONY_WEBHOOK_SECRET ?? '';
  row('Voice agents', 'TELEPHONY_WEBHOOK_SECRET', s.length >= 32 ? 'OK' : 'WARN', s.length >= 32 ? 'set (32+ characters)' : s ? 'too short (needs 32+ characters) — Sarvam calls are refused' : 'missing — calls through Sarvam are refused (Plivo is unaffected)');
  const dir = path.resolve(env.KNOWLEDGE_DIR || './data/knowledge');
  let note = `${dir}${env.KNOWLEDGE_DIR ? '' : ' (default, relative to the API directory: set an absolute path that is backed up)'}`;
  let level: Level = env.KNOWLEDGE_DIR && path.isAbsolute(env.KNOWLEDGE_DIR) ? 'OK' : 'WARN';
  if (existsSync(dir)) {
    try { accessSync(dir, constants.W_OK); note += ' — exists, writable'; } catch { level = 'MISSING'; note += ' — exists but NOT writable by this user'; }
  } else note += ' — will be created on the first upload';
  row('Voice agents', 'KNOWLEDGE_DIR', level, note);
  shown('Voice agents', 'TELEPHONY_ORG_MAX_CONCURRENT', '5');
  shown('Voice agents', 'TELEPHONY_ORG_DAILY_LIMIT', '200');
  const sa = ['SARVAM_AGENTS_API_KEY', 'SARVAM_AGENTS_ORG_ID', 'SARVAM_AGENTS_WORKSPACE_ID', 'SARVAM_AGENTS_CONNECTION_ID', 'SARVAM_AGENTS_PHONE_NUMBER'];
  const n = sa.filter(set).length;
  row('Voice agents', 'SARVAM_AGENTS_* (platform account)', n === sa.length ? 'OK' : n ? 'WARN' : 'INFO', n === sa.length ? 'all set' : n ? `${n} of ${sa.length} set — incomplete` : 'not set — organizations use their own Sarvam account (optional)');
}

// WhatsApp multimodal (voice notes, images, documents)
shown('Multimodal', 'VISION_PROVIDER', 'openai', 'openai = OpenAI-compatible vision model (needs an OpenAI key); none = images are not read');
shown('Multimodal', 'VISION_MODEL', '(the OpenAI integration model)', 'a vision-capable model');
shown('Multimodal', 'VISION_CONFIDENCE_MIN', '0.6', 'below this the image reading is shown back for confirmation');
shown('Multimodal', 'WHATSAPP_VOICE_REPLIES', 'false', 'true = also send a Sarvam voice-note reply to voice notes (text is always sent)');
shown('Multimodal', 'WHATSAPP_MAX_VOICE_SECONDS', '180', 'longer voice notes are refused politely');
row('Multimodal', 'ffmpeg', (() => { try { execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }); return 'OK'; } catch { return 'WARN'; } })(), 'converts voice notes for Sarvam STT (30 s per request); without it only notes under 30 s are transcribed');

// Website assistant video (Simli)
row('Assistant video', 'SIMLI_API_KEY + SIMLI_FACE_ID', set('SIMLI_API_KEY') && set('SIMLI_FACE_ID') ? 'OK' : 'INFO', set('SIMLI_API_KEY') && set('SIMLI_FACE_ID') ? 'set' : 'not set — the Video call button is hidden');
row('Assistant video background', 'SIMLI_BACKGROUND_ID', 'INFO', set('SIMLI_BACKGROUND_ID') ? 'set (Trinity-2 background)' : 'not set — the avatar\'s own background');

// Instagram & Messenger (per-organization credentials are saved in the dashboard; these are deployment settings)
row('Instagram & Messenger', 'META_SOCIAL_VERIFY_TOKEN', set('META_SOCIAL_VERIFY_TOKEN') ? 'OK' : set('WHATSAPP_VERIFY_TOKEN') ? 'INFO' : 'WARN', set('META_SOCIAL_VERIFY_TOKEN') ? 'set' : set('WHATSAPP_VERIFY_TOKEN') ? 'not set — the WhatsApp verify token is used for /webhooks/meta-social' : 'missing — Meta cannot verify /webhooks/meta-social');
row('Instagram & Messenger', 'LIVE_TEST_SOCIAL_IDS', dryRun ? 'INFO' : set('LIVE_TEST_SOCIAL_IDS') || env.LIVE_ALLOW_ALL_CUSTOMERS === 'true' ? 'OK' : 'WARN', set('LIVE_TEST_SOCIAL_IDS') ? `${env.LIVE_TEST_SOCIAL_IDS!.split(',').filter(Boolean).length} approved account(s)` : 'none — live mode reaches no Instagram / Messenger account');

// Tacksharp billing (platform account: online payment and invoice seller details)
{
  const keys = set('RAZORPAY_KEY_ID') && set('RAZORPAY_KEY_SECRET');
  row('Billing', 'RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET', keys ? 'OK' : set('RAZORPAY_KEY_ID') || set('RAZORPAY_KEY_SECRET') ? 'WARN' : 'INFO', keys ? `set${env.RAZORPAY_KEY_ID!.startsWith('rzp_test_') ? ' (TEST mode keys)' : env.RAZORPAY_KEY_ID!.startsWith('rzp_live_') ? ' (LIVE keys)' : ''}` : set('RAZORPAY_KEY_ID') || set('RAZORPAY_KEY_SECRET') ? 'only one of the two is set' : 'not set — "Payment link" is refused; invoices are paid by bank transfer / UPI and recorded by staff');
  if (keys || set('RAZORPAY_WEBHOOK_SECRET')) secret('Billing', 'RAZORPAY_WEBHOOK_SECRET', keys, 'without it a payment can never mark an invoice paid (links are refused)');
  for (const n of ['PLATFORM_LEGAL_NAME', 'PLATFORM_GSTIN', 'PLATFORM_ADDRESS']) row('Billing', n, set(n) ? 'OK' : 'WARN', set(n) ? 'set' : 'missing — invoices are labelled as a payment request, not a tax invoice');
  if (set('PLATFORM_GSTIN') && !/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(env.PLATFORM_GSTIN!.trim())) row('Billing', 'PLATFORM_GSTIN format', 'WARN', 'not 15 characters like 33ABCDE1234F1Z5');
  secret('Billing', 'PLATFORM_BILLING_EMAIL', false, 'shown on invoices');
}

// Meta Lead Ads (real estate)
secret('Meta Lead Ads (real estate)', 'META_PAGE_ACCESS_TOKEN', false, 'real-estate lead ads only');

const width = Math.max(...rows.map((r) => r.name.length));
let group = '';
for (const r of rows) {
  if (r.group !== group) {
    group = r.group;
    console.log(`\n${group}`);
  }
  console.log(`  ${r.level.padEnd(7)} ${r.name.padEnd(width)}  ${r.note}`);
}
const missing = rows.filter((r) => r.level === 'MISSING');
console.log(`\n${missing.length ? `${missing.length} required setting(s) missing.` : 'No required setting is missing.'} ${rows.filter((r) => r.level === 'WARN').length} warning(s). No values were printed.`);
process.exit(missing.length ? 1 : 0);
