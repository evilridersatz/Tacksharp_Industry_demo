import { BadRequestException } from '@nestjs/common';

/**
 * Provider definitions: which fields are SECRET (encrypted, never returned) and which are plain configuration
 * (returned as-is), with validation. The backend decides what is allowed; the browser only renders it.
 */
export const PROVIDERS = ['plivo', 'sarvam', 'openai', 'whatsapp', 'sarvam_telephony'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p);

/** Models the backend accepts (each is still checked against the provider by the connection test). */
/** Reasoning models only: the conversation agents send a reasoning-effort setting that older models reject. */
export const OPENAI_MODELS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini', 'gpt-5'] as const;
export const SARVAM_STT_MODELS = ['saaras:v3', 'saarika:v2.5'] as const;
export const SARVAM_TTS_MODELS = ['bulbul:v3', 'bulbul:v2'] as const;
/** Language codes Sarvam supports that this product uses (Tamil, English, Tanglish = code-mixed Tamil/English). */
export const SARVAM_LANGUAGES = ['ta-IN', 'en-IN', 'hi-IN', 'te-IN', 'kn-IN', 'ml-IN', 'unknown'] as const;
export const SARVAM_SPEAKERS = ['roopa', 'anushka', 'manisha', 'vidya', 'arya', 'abhilash', 'karun', 'hitesh'] as const;
export const SARVAM_STT_MODES = ['codemix', 'transcribe', 'translit'] as const;

export type FieldDef = { key: string; label: string; secret: boolean; required: boolean; help?: string; options?: readonly string[] };

export const FIELDS: Record<Provider, FieldDef[]> = {
  plivo: [
    { key: 'authId', label: 'Auth ID', secret: true, required: true, help: 'Plivo console → Account → API keys.' },
    { key: 'authToken', label: 'Auth Token', secret: true, required: true },
    { key: 'fromNumber', label: 'Outbound caller ID', secret: false, required: true, help: 'A number on THIS Plivo account, with country code (e.g. 914412345678).' },
  ],
  sarvam: [
    { key: 'apiKey', label: 'API key', secret: true, required: true, help: 'Sarvam dashboard → API keys.' },
    { key: 'sttModel', label: 'Speech-to-text model', secret: false, required: true, options: SARVAM_STT_MODELS },
    { key: 'sttMode', label: 'Recognition mode', secret: false, required: false, options: SARVAM_STT_MODES, help: 'codemix handles Tanglish (Tamil and English mixed).' },
    { key: 'sttLanguage', label: 'Speech-to-text language', secret: false, required: true, options: SARVAM_LANGUAGES, help: '"unknown" lets Sarvam detect the language.' },
    { key: 'ttsModel', label: 'Text-to-speech model', secret: false, required: true, options: SARVAM_TTS_MODELS },
    { key: 'ttsLanguage', label: 'Voice language', secret: false, required: true, options: SARVAM_LANGUAGES.filter((l) => l !== 'unknown') },
    { key: 'ttsSpeaker', label: 'Voice', secret: false, required: true, options: SARVAM_SPEAKERS },
  ],
  openai: [
    { key: 'apiKey', label: 'API key', secret: true, required: true, help: 'platform.openai.com → API keys. A project key is recommended.' },
    { key: 'model', label: 'Model', secret: false, required: true, options: OPENAI_MODELS },
  ],
  sarvam_telephony: [
    { key: 'apiKey', label: 'Voice Agents API key', secret: true, required: true, help: 'Sarvam Voice Agents → Settings → API keys (workspace key, sent as X-API-Key).' },
    { key: 'orgId', label: 'Sarvam org ID', secret: false, required: true, help: 'From your Sarvam Voice Agents workspace URL / settings.' },
    { key: 'workspaceId', label: 'Workspace ID', secret: false, required: true },
    { key: 'connectionId', label: 'Telephony connection ID', secret: false, required: true, help: 'Deploy → Phone Numbers → the connection (Sarvam-rented Vobiz number, or your own provider).' },
    { key: 'agentPhoneNumber', label: 'Caller number (agent phone number)', secret: false, required: true, help: 'A number on that connection, with country code. Renting a number does not by itself enable calls: it must be KYC-approved, assigned to an inbound deployment for inbound and to a group / campaign for outbound.' },
  ],
  whatsapp: [
    { key: 'accessToken', label: 'Access token (system user)', secret: true, required: true, help: 'Meta Business → System users → token with whatsapp_business_messaging and whatsapp_business_management.' },
    { key: 'appSecret', label: 'App secret', secret: true, required: false, help: 'Used to verify webhook signatures for this app.' },
    { key: 'phoneNumberId', label: 'Phone number ID', secret: false, required: true },
    { key: 'businessAccountId', label: 'WhatsApp Business Account ID', secret: false, required: true, help: 'Needed to read template status.' },
  ],
};

export const DEFAULT_CONFIG: Record<Provider, Record<string, string>> = {
  plivo: {},
  sarvam: { sttModel: 'saaras:v3', sttMode: 'codemix', sttLanguage: 'unknown', ttsModel: 'bulbul:v3', ttsLanguage: 'ta-IN', ttsSpeaker: 'roopa' },
  openai: { model: 'gpt-5.4-mini' },
  whatsapp: {},
  sarvam_telephony: {},
};

const digits = (v: string) => v.replace(/[\s()+-]/g, '');

/**
 * Validates a save. Secret fields left empty keep the stored value (the browser never has it to resend); a secret
 * set to the literal null removes it. Returns the new plain config and the secrets to merge.
 */
export function validateSave(provider: Provider, body: Record<string, unknown>, existing: { config: Record<string, string>; hasSecret: Set<string> }) {
  const errors: Record<string, string> = {};
  const config: Record<string, string> = { ...DEFAULT_CONFIG[provider], ...existing.config };
  const secrets: Record<string, string | null> = {};
  for (const f of FIELDS[provider]) {
    const raw = body[f.key];
    if (raw === undefined) continue;
    if (f.secret) {
      if (raw === null) { secrets[f.key] = null; continue; }
      if (typeof raw !== 'string') { errors[f.key] = 'Must be text.'; continue; }
      const v = raw.trim();
      if (!v) continue; // unchanged
      if (v.length > 512 || /\s/.test(v)) { errors[f.key] = 'That does not look like a valid value (no spaces, at most 512 characters).'; continue; }
      if (v.startsWith('••••')) continue; // the masked hint sent back unchanged
      secrets[f.key] = v;
    } else {
      if (typeof raw !== 'string') { errors[f.key] = 'Must be text.'; continue; }
      let v = raw.trim();
      if (f.options && v && !f.options.includes(v)) { errors[f.key] = `Choose one of: ${f.options.join(', ')}.`; continue; }
      if (provider === 'plivo' && f.key === 'fromNumber' && v) {
        v = digits(v);
        if (!/^\d{8,15}$/.test(v)) { errors[f.key] = 'Digits with country code, 8 to 15 long.'; continue; }
      }
      if (provider === 'sarvam_telephony' && f.key === 'agentPhoneNumber' && v) {
        v = digits(v);
        if (!/^\d{8,15}$/.test(v)) { errors[f.key] = 'Digits with country code, 8 to 15 long.'; continue; }
      }
      if (provider === 'sarvam_telephony' && ['orgId', 'workspaceId', 'connectionId'].includes(f.key) && v && !/^[\w-]{2,100}$/.test(v)) { errors[f.key] = 'Letters, digits, - and _ only (copy it from Sarvam).'; continue; }
      if (provider === 'whatsapp' && (f.key === 'phoneNumberId' || f.key === 'businessAccountId') && v && !/^\d{5,30}$/.test(v)) { errors[f.key] = 'Digits only (copy it from WhatsApp Manager).'; continue; }
      config[f.key] = v;
    }
  }
  // Required fields must exist after the save (either newly given or already stored).
  for (const f of FIELDS[provider].filter((x) => x.required)) {
    const present = f.secret ? (secrets[f.key] !== undefined ? secrets[f.key] !== null : existing.hasSecret.has(f.key)) : Boolean(config[f.key]);
    if (!present && !errors[f.key]) errors[f.key] = `${f.label} is required.`;
  }
  if (provider === 'sarvam' && config.ttsLanguage === 'unknown') errors.ttsLanguage = 'Choose a voice language.';
  if (Object.keys(errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please correct the highlighted fields.', fields: errors });
  return { config, secrets };
}

/** Cost estimates come from prices the operator sets (provider prices change): null when not set, never invented. */
export function priceFromEnv(name: string): number | null {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : null;
}
