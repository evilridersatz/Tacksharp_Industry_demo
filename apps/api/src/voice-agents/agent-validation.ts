import { BadRequestException } from '@nestjs/common';
import { SARVAM_SPEAKERS } from '../integrations/providers.js';
import { TEMPLATES } from './templates.js';

export const AGENT_LANGUAGES = ['ta', 'en', 'tanglish'] as const;
export const AGENT_INDUSTRIES = [...new Set([...TEMPLATES.map((t) => t.industry), 'other'])];
export const TELEPHONY_PROVIDERS = ['plivo', 'sarvam'] as const;

/** E.164 as stored in this product: digits only, with country code, 8 to 15 digits (leading + allowed in input). */
export function e164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/[\s()-]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(v)) return null;
  return v.replace(/^\+/, '');
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Server-side DTO validation for the Agent Builder. Unknown fields are ignored; every accepted field is type- and
 * range-checked. Returns only the fields present (partial updates) unless `full` is set.
 */
export function validateAgent(body: Record<string, unknown>, full: boolean) {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  const has = (k: string) => body[k] !== undefined;
  const str = (k: string, min: number, max: number, required: boolean) => {
    if (!has(k)) { if (required && full) errors[k] = 'Required.'; return; }
    const v = body[k];
    if (v === null && !required) { out[k] = null; return; }
    if (typeof v !== 'string') { errors[k] = 'Must be text.'; return; }
    const t = v.trim();
    if (t.length < min || t.length > max) { errors[k] = `Between ${min} and ${max} characters.`; return; }
    out[k] = t;
  };
  str('name', 2, 80, true);
  str('description', 0, 500, false);
  str('useCase', 0, 200, false);
  str('instructions', 20, 6000, true);
  str('greeting', 2, 400, true);
  str('fallbackMessage', 2, 400, true);
  if (has('industry')) {
    if (!AGENT_INDUSTRIES.includes(String(body.industry))) errors.industry = `One of: ${AGENT_INDUSTRIES.join(', ')}.`;
    else out.industry = body.industry;
  } else if (full) errors.industry = 'Required.';
  if (has('languages')) {
    const l = body.languages;
    if (!Array.isArray(l) || !l.length || l.some((x) => !(AGENT_LANGUAGES as readonly string[]).includes(String(x)))) errors.languages = 'Choose at least one of Tamil, English, Tanglish.';
    else out.languages = [...new Set(l.map(String))];
  } else if (full) out.languages = ['ta', 'en', 'tanglish'];
  if (has('voice')) {
    const v = obj(body.voice);
    const speaker = v.speaker === undefined ? 'roopa' : String(v.speaker);
    const pace = v.pace === undefined ? 1 : Number(v.pace);
    if (!(SARVAM_SPEAKERS as readonly string[]).includes(speaker)) errors.voice = `Voice: one of ${SARVAM_SPEAKERS.join(', ')}.`;
    else if (!(pace >= 0.7 && pace <= 1.5)) errors.voice = 'Speaking pace between 0.7 and 1.5.';
    else out.voice = { speaker, pace };
  }
  if (has('inbound')) {
    const v = obj(body.inbound);
    const enabled = v.enabled === true;
    const phone = v.phoneNumber ? e164(v.phoneNumber) : null;
    if (enabled && !phone) errors.inbound = 'Inbound calls need the number customers dial, with country code (e.g. +914412345678).';
    else out.inbound = { enabled, phoneNumber: phone };
  }
  if (has('outbound')) {
    const v = obj(body.outbound);
    const purpose = typeof v.purpose === 'string' ? v.purpose.trim().slice(0, 300) : '';
    out.outbound = { enabled: v.enabled === true, purpose };
  }
  if (has('knowledgeBaseId')) {
    const v = body.knowledgeBaseId;
    if (v !== null && (typeof v !== 'string' || !/^[a-z0-9]{10,40}$/i.test(v))) errors.knowledgeBaseId = 'Unknown knowledge base.';
    else out.knowledgeBaseId = v;
  }
  if (has('businessHours')) {
    const v = body.businessHours === null ? null : obj(body.businessHours);
    if (v === null) out.businessHours = null;
    else {
      const days = Array.isArray(v.days) ? [...new Set(v.days.map(Number))] : [1, 2, 3, 4, 5, 6, 7];
      const tz = typeof v.timezone === 'string' && v.timezone ? v.timezone : 'Asia/Kolkata';
      if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) || !days.length) errors.businessHours = 'Days are 1 (Monday) to 7 (Sunday).';
      else if (!HHMM.test(String(v.start)) || !HHMM.test(String(v.end)) || String(v.start) >= String(v.end)) errors.businessHours = 'Opening and closing time as HH:MM, opening before closing.';
      else if (!validTz(tz)) errors.businessHours = 'Unknown time zone.';
      else out.businessHours = { days, start: v.start, end: v.end, timezone: tz, afterHoursMessage: typeof v.afterHoursMessage === 'string' ? v.afterHoursMessage.trim().slice(0, 300) : '' };
    }
  }
  if (has('escalation')) {
    const v = obj(body.escalation);
    const kw = Array.isArray(v.keywords) ? v.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean) : [];
    const phone = v.phone ? e164(v.phone) : null;
    if (kw.length > 20 || kw.some((k) => k.length > 40)) errors.escalation = 'At most 20 handoff keywords, each under 40 characters.';
    else if (v.phone && !phone) errors.escalation = 'Handoff phone with country code.';
    else out.escalation = { keywords: kw, handoffMessage: typeof v.handoffMessage === 'string' ? v.handoffMessage.trim().slice(0, 300) : '', phone };
  }
  if (has('callLimits')) {
    const v = obj(body.callLimits);
    const maxCallSeconds = int(v.maxCallSeconds, 300);
    const maxConcurrent = int(v.maxConcurrent, 2);
    const dailyLimit = int(v.dailyLimit, 50);
    if (maxCallSeconds < 30 || maxCallSeconds > 1800) errors.callLimits = 'Call length between 30 seconds and 30 minutes.';
    else if (maxConcurrent < 1 || maxConcurrent > 50) errors.callLimits = 'Concurrent calls between 1 and 50.';
    else if (dailyLimit < 1 || dailyLimit > 5000) errors.callLimits = 'Daily calls between 1 and 5,000.';
    else out.callLimits = { maxCallSeconds, maxConcurrent, dailyLimit };
  }
  if (has('telephonyProvider')) {
    if (!(TELEPHONY_PROVIDERS as readonly string[]).includes(String(body.telephonyProvider))) errors.telephonyProvider = 'plivo or sarvam.';
    else out.telephonyProvider = body.telephonyProvider;
  }
  if (has('sarvamAppId')) {
    const v = body.sarvamAppId;
    if (v !== null && v !== '' && (typeof v !== 'string' || !/^[\w-]{3,100}$/.test(v))) errors.sarvamAppId = 'The Sarvam agent (app) id from the Sarvam dashboard.';
    else out.sarvamAppId = v || null;
  }
  if (has('sarvamAppVersion')) {
    const n = body.sarvamAppVersion === null || body.sarvamAppVersion === '' ? null : Number(body.sarvamAppVersion);
    if (n !== null && (!Number.isInteger(n) || n < 1)) errors.sarvamAppVersion = 'A whole number (1, 2, ...).';
    else out.sarvamAppVersion = n;
  }
  if (Object.keys(errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please correct the highlighted fields.', fields: errors });
  return out;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number(v));
function validTz(tz: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
