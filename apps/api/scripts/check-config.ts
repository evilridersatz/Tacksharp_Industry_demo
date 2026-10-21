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
const voiceLive = set('PLIVO_AUTH_ID');

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
tpl('FOLLOWUP_CONFIRMATION_TEMPLATE', '1 body variable ({{1}} order number)', 'order confirmation / updates');
tpl('FOLLOWUP_FEEDBACK_TEMPLATE', '2 body variables ({{1}} name, {{2}} order number)', 'feedback request');
row('Restaurant templates', 'Offer template', 'INFO', 'set per offer campaign in the dashboard (Offers page), not in .env');

// Real-estate templates (other product; listed so their absence is not confused with a restaurant problem)
row('Real-estate templates', 'WHATSAPP_TEMPLATE_NAME', set('WHATSAPP_TEMPLATE_NAME') ? 'OK' : 'INFO', set('WHATSAPP_TEMPLATE_NAME') ? 'set' : 'missing — only affects real-estate lead first contact, not GR Chicken');

// Voice
secret('Voice (Plivo)', 'PLIVO_AUTH_ID', false, 'no calls');
secret('Voice (Plivo)', 'PLIVO_AUTH_TOKEN', voiceLive);
secret('Voice (Plivo)', 'PLIVO_FROM_NUMBER', voiceLive);
row('Voice (Plivo)', 'PLIVO_VALIDATE_SIGNATURE', env.PLIVO_VALIDATE_SIGNATURE === 'true' ? 'OK' : voiceLive ? 'WARN' : 'INFO', env.PLIVO_VALIDATE_SIGNATURE === 'true' ? 'true' : 'not true — callbacks are not signature-checked');
shown('Voice (Plivo)', 'VOICE_MODE', 'record', 'record = Plivo <Record> turns; stream = real-time audio stream');
secret('Voice (Sarvam)', 'SARVAM_API_KEY', voiceLive, 'speech-to-text / text-to-speech for calls');

// Stock alerts (optional)
row('Stock alerts', 'STOCK_ALERT_SNS_TOPIC_ARN', set('STOCK_ALERT_SNS_TOPIC_ARN') ? 'OK' : 'INFO', set('STOCK_ALERT_SNS_TOPIC_ARN') ? 'set' : 'not set — low-stock alerts are skipped (stock still works)');
row('Stock alerts', 'AWS credentials', set('AWS_ACCESS_KEY_ID') || set('AWS_PROFILE') ? 'OK' : 'INFO', set('AWS_ACCESS_KEY_ID') || set('AWS_PROFILE') ? 'present (not shown)' : 'from the standard AWS chain (env, profile or instance role)');

// AI
row('AI', 'OPENAI_API_KEY / OPENAI_BASE_URL', set('OPENAI_API_KEY') || set('OPENAI_BASE_URL') ? 'OK' : 'INFO', set('OPENAI_API_KEY') || set('OPENAI_BASE_URL') ? 'set' : 'none — ordering still works by rules; free-form questions get a help reply');

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
