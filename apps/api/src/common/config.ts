import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Central configuration. Everything that used to be hardcoded
 * (DB credentials, organization id, base URL) lives here.
 */
const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,
  port: num('PORT', 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),

  /** Single-tenant default until auth / multi-tenancy (Phase 6). */
  defaultOrganizationId: process.env.DEFAULT_ORGANIZATION_ID ?? 'org_real_estate_001',
  defaultOrganizationName: process.env.DEFAULT_ORGANIZATION_NAME ?? 'Tacksharp Realty',

  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: num('DB_PORT', 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: process.env.DB_NAME ?? 'tacksharp',
    connectionLimit: num('DB_POOL_SIZE', 10),
  },

  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: num('REDIS_PORT', 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true',
  },

  auth: {
    /** HMAC key for session tokens. Must be long and random in production. */
    secret: process.env.AUTH_SECRET ?? (isProduction ? '' : 'dev-only-insecure-secret-change-me-0000000000'),
  },

  rateLimit: {
    loginPerWindow: num('RATE_LIMIT_LOGIN', 10),
    apiPerMinute: num('RATE_LIMIT_API_PER_MIN', 300),
    webhookPerMinute: num('RATE_LIMIT_WEBHOOK_PER_MIN', 1200),
  },

  /** Run BullMQ workers inside the API process (simplest for local + single Lightsail box). */
  runWorkers: process.env.RUN_WORKERS !== 'false',

  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE ?? '91',
  /** Log each turn's transcript and reply (phone/account numbers masked) for debugging real calls. LOG_TRANSCRIPTS=false turns it off. */
  logTranscripts: process.env.LOG_TRANSCRIPTS !== 'false',

  whatsapp: {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v23.0',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
    appSecret: process.env.META_APP_SECRET ?? '',
    /** Approved template used for first contact and follow-ups outside the 24h window. */
    templateName: process.env.WHATSAPP_TEMPLATE_NAME ?? '',
    /**
     * Optional approved template per follow-up step. A step without its own template uses WHATSAPP_TEMPLATE_NAME.
     * All templates must take the same body variables ({{1}} name, {{2}} requirement) - see WHATSAPP_TEMPLATE_PARAMS.
     */
    stepTemplates: {
      first_contact: process.env.WHATSAPP_TEMPLATE_FIRST_CONTACT ?? '',
      reminder: process.env.WHATSAPP_TEMPLATE_REMINDER ?? '',
      final: process.env.WHATSAPP_TEMPLATE_FINAL ?? '',
      missed_call: process.env.WHATSAPP_TEMPLATE_MISSED_CALL ?? '',
      // Visit messages outside the 24h window: {{1}} customer name, {{2}} "Property, Sat 10 Oct, 11:00 AM".
      visit_confirm: process.env.WHATSAPP_TEMPLATE_VISIT_CONFIRM ?? '',
      visit_reminder: process.env.WHATSAPP_TEMPLATE_VISIT_REMINDER ?? '',
      visit_after: process.env.WHATSAPP_TEMPLATE_VISIT_AFTER ?? '',
    } as Record<string, string>,
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en',
    /** Number of {{n}} body variables in the template (0, 1 = customer name, 2 = name + requirement). */
    templateParams: num('WHATSAPP_TEMPLATE_PARAMS', 1),
  },

  meta: {
    pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN ?? '',
    graphVersion: process.env.META_GRAPH_API_VERSION ?? 'v23.0',
    leadVerifyToken: process.env.META_LEAD_VERIFY_TOKEN ?? '',
    /** Facebook Page that owns the lead form. When set, lead webhooks for any other page are rejected. */
    pageId: process.env.META_PAGE_ID ?? '',
  },

  plivo: {
    authId: process.env.PLIVO_AUTH_ID ?? '',
    authToken: process.env.PLIVO_AUTH_TOKEN ?? '',
    fromNumber: process.env.PLIVO_FROM_NUMBER ?? '',
    ringTimeoutSec: num('PLIVO_RING_TIMEOUT', 30),
    maxCallSec: num('PLIVO_MAX_CALL_SECONDS', 600),
    /** Seconds of silence that ends the customer's turn. 2 is snappier, 3 is safer for slow speakers. */
    silenceTimeoutSec: num('VOICE_SILENCE_TIMEOUT', 2),
    maxTurnSec: num('VOICE_MAX_TURN_SECONDS', 25),
    validateSignature: process.env.PLIVO_VALIDATE_SIGNATURE === 'true',
  },

  sarvam: {
    apiKey: process.env.SARVAM_API_KEY ?? '',
    sttModel: process.env.SARVAM_STT_MODEL ?? 'saaras:v3',
    sttMode: process.env.SARVAM_STT_MODE ?? 'codemix',
    sttLanguage: process.env.SARVAM_STT_LANGUAGE ?? 'unknown',
    sttKeyterms: (process.env.SARVAM_STT_KEYTERMS ?? '')
      .split(',')
      .map((term) => term.trim())
      .filter(Boolean),
    ttsModel: process.env.SARVAM_TTS_MODEL ?? 'bulbul:v3',
    /** bulbul:v3 voice. roopa = "Gentle & Soothing" (Sarvam's own description): soft, calm sales-coordinator voice.
     *  Alternatives: suhani ("Pleasant & Soothing"), kavitha ("Graceful & Articulate"), ishita ("Polished & Articulate"). */
    ttsSpeaker: process.env.SARVAM_TTS_SPEAKER ?? 'roopa',
    /** 0.5-2.0. Slightly under 1 sounds calmer on a phone line without dragging. */
    ttsPace: num('SARVAM_TTS_PACE', 0.95),
    /** bulbul:v3 / v4-flash only (0.01-1, Sarvam default 0.6). Lower = steadier, less sing-song delivery. */
    ttsTemperature: num('SARVAM_TTS_TEMPERATURE', 0.5),
    ttsSampleRate: num('SARVAM_TTS_SAMPLE_RATE', 8000),
    timeoutMs: num('SARVAM_TIMEOUT_MS', 12000),
    /** Per-request TTS timeout on a live call (a slow request is retried or falls back instead of blocking the turn). */
    ttsTimeoutMs: num('SARVAM_TTS_TIMEOUT_MS', 5000),
    /** Total time a live turn may spend on TTS including retries. */
    ttsBudgetMs: num('SARVAM_TTS_BUDGET_MS', 8000),
    /** Concurrent TTS requests to Sarvam (protects against HTTP 429). */
    ttsConcurrency: num('SARVAM_TTS_CONCURRENCY', 3),
  },

  voice: {
    audioDir: process.env.VOICE_AUDIO_DIR ?? '/tmp/tacksharp-voice',
    agentName: process.env.VOICE_AGENT_NAME ?? '',
    maxCallAttempts: num('VOICE_MAX_CALL_ATTEMPTS', 3),
    retryAfterMinutes: num('VOICE_RETRY_AFTER_MINUTES', 120),
    /** Automatic calls to the same customer are at least this far apart (a callback they asked for is exempt). */
    minGapMinutes: num('VOICE_MIN_GAP_MINUTES', 30),
    /** Calls only between these IST hours (TRAI-friendly). */
    callWindowStartHour: num('VOICE_CALL_WINDOW_START', 9),
    callWindowEndHour: num('VOICE_CALL_WINDOW_END', 21),
    /**
     * 'stream' = real-time call over a Plivo audio stream (local end-of-speech detection, no recording download,
     * sentence-by-sentence speech, barge-in). 'record' = the older record -> webhook -> play loop (fallback).
     */
    mode: (process.env.VOICE_MODE === 'stream' ? 'stream' : 'record') as 'stream' | 'record',
    /** Stream mode: silence that ends the customer's turn (ms). Lower = snappier, higher = fewer cut-offs. */
    streamEndSilenceMs: num('VOICE_END_SILENCE_MS', 700),
    /** Stream mode: speech (ms) that interrupts the AI while it talks. 0 turns interruption off. */
    bargeInMs: num('VOICE_BARGE_IN_MS', 400),
    /** Stream mode: a short wait line only if DECIDING the answer (after STT) takes longer than this. 0 = off. */
    fillerAfterMs: num('VOICE_FILLER_AFTER_MS', 700),
    /** Stream mode: minimum speech level (RMS, 16-bit). Raise if line noise starts turns; lower for quiet callers. */
    streamMinLevel: num('VOICE_MIN_SPEECH_LEVEL', 600),
    /** Stream mode: caller silent this long after we finished speaking -> "ஹலோ? கேக்குதா?" (ms). */
    noResponseMs: num('VOICE_NO_RESPONSE_MS', 7000),
  },

  followUp: {
    /** Multiply all sequence delays by this. Use 0.01 locally to test a 2h step in ~72s. */
    timeScale: num('FOLLOWUP_TIME_SCALE', 1),
  },
};

export { required };

/**
 * Refuse to start in production with unsafe settings. Returns the list of problems
 * (empty = OK) so it can be unit-tested; main.ts exits when it is not empty.
 */
export function productionProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  const missing = (...names: string[]) => names.filter((n) => !env[n] || !env[n]!.trim());

  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) problems.push('AUTH_SECRET must be set to a random string of 32+ characters');
  if (!env.META_APP_SECRET) problems.push('META_APP_SECRET must be set (Meta webhook signature check)');
  if (env.PLIVO_VALIDATE_SIGNATURE !== 'true') problems.push('PLIVO_VALIDATE_SIGNATURE must be true');
  const base = env.PUBLIC_BASE_URL ?? '';
  if (!base.startsWith('https://')) problems.push('PUBLIC_BASE_URL must be your https:// domain');
  if (base.includes('ngrok')) problems.push('PUBLIC_BASE_URL must be your own domain, not ngrok');
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(base)) problems.push('PUBLIC_BASE_URL must be a public address, not localhost / a private IP');
  if (!env.DB_PASSWORD || env.DB_PASSWORD === 'password') problems.push('DB_PASSWORD must be a real password');

  // Providers the product cannot work without. Names only - values are never printed.
  const keys = missing('OPENAI_API_KEY', 'SARVAM_API_KEY', 'PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN', 'PLIVO_FROM_NUMBER', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN');
  if (keys.length) problems.push(`Missing required settings: ${keys.join(', ')}`);

  // Test-only knobs must not be active against real customers.
  if (env.FOLLOWUP_TIME_SCALE && Number(env.FOLLOWUP_TIME_SCALE) !== 1) problems.push('FOLLOWUP_TIME_SCALE must be unset or 1 in production (it speeds up follow-up delays for testing)');
  if (env.RATE_LIMIT_API_PER_MIN && Number(env.RATE_LIMIT_API_PER_MIN) <= 0) problems.push('RATE_LIMIT_API_PER_MIN must be a positive number');
  return problems;
}

/** Not fatal, but worth reading at start-up. Never contains values, only names and advice. */
export function productionWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const warnings: string[] = [];
  if (!env.WHATSAPP_TEMPLATE_NAME && !env.WHATSAPP_TEMPLATE_FIRST_CONTACT) warnings.push('No approved WhatsApp template is configured: first contact with a new lead (outside the 24h window) cannot be sent');
  if ((env.VOICE_AUDIO_DIR ?? '/tmp/tacksharp-voice').startsWith('/tmp')) warnings.push('VOICE_AUDIO_DIR is under /tmp; use a persistent directory so cached prompt audio survives reboots');
  if (!env.META_PAGE_ID) warnings.push('META_PAGE_ID is not set: lead-ad webhooks are accepted from any page while no page mapping exists (single-tenant mode)');
  if (!env.META_LEAD_VERIFY_TOKEN) warnings.push('META_LEAD_VERIFY_TOKEN is not set: Meta lead-ads webhook verification will fail');
  if (!env.WHATSAPP_TEMPLATE_NAME && !(env.WHATSAPP_TEMPLATE_VISIT_CONFIRM && env.WHATSAPP_TEMPLATE_VISIT_REMINDER)) {
    warnings.push('No approved WhatsApp template for site-visit confirmation/reminder: they reach only customers who messaged in the last 24h');
  }
  return warnings;
}
