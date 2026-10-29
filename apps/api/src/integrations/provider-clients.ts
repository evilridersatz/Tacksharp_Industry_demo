/**
 * Real provider requests for connection tests and test operations. Every request has a timeout; transient failures
 * (network, 429, 5xx) get one short retry; results are sanitized (secrets scrubbed, bodies truncated, no stack traces).
 * Tests inject `fetchImpl`; production uses the global fetch.
 */
export type FetchLike = (url: string, init?: RequestInit & { signal?: AbortSignal }) => Promise<Response>;

export type ProviderResult = {
  ok: boolean;
  latencyMs: number;
  /** Stable code for the UI: auth_failed | not_found | quota | rate_limited | timeout | network | provider_error | invalid_response | ... */
  errorCode?: string;
  /** User-safe message. */
  message: string;
  details?: Record<string, unknown>;
  units?: number;
  unitType?: string;
};

const TIMEOUT_MS = Number(process.env.PROVIDER_TEST_TIMEOUT_MS) || 12_000;

export function scrub(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets.filter((x) => x && x.length >= 4)) t = t.split(s).join('••••');
  // Bearer tokens / keys that might appear in echoed requests.
  t = t.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/g, '$1••••').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-••••');
  return t.replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function request(fetchImpl: FetchLike, url: string, init: RequestInit, secrets: string[], retry = true): Promise<{ status: number; body: string; json: unknown; ms: number; error?: string; code?: string }> {
  const started = Date.now();
  for (let attempt = 1; attempt <= (retry ? 2 : 1); attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await res.text();
      let json: unknown = null;
      try { json = body ? JSON.parse(body) : null; } catch { json = null; }
      if ((res.status === 429 || res.status >= 500) && attempt === 1 && retry) { await new Promise((r) => setTimeout(r, 400)); continue; }
      return { status: res.status, body: scrub(body, secrets), json, ms: Date.now() - started };
    } catch (e) {
      const name = (e as Error)?.name;
      const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
      if (attempt === 1 && retry) { await new Promise((r) => setTimeout(r, 400)); continue; }
      return { status: 0, body: '', json: null, ms: Date.now() - started, code, error: code === 'timeout' ? `No answer within ${Math.round(TIMEOUT_MS / 1000)} s.` : `Could not reach the provider (${scrub(String((e as Error)?.message ?? e), secrets)}).` };
    }
  }
  return { status: 0, body: '', json: null, ms: Date.now() - started, code: 'network', error: 'Could not reach the provider.' };
}

function classify(status: number): string {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  return 'rejected';
}

const fail = (r: { status: number; body: string; ms: number; error?: string; code?: string }, what: string, hint?: string): ProviderResult => ({
  ok: false,
  latencyMs: r.ms,
  errorCode: r.code ?? classify(r.status),
  message: r.error ?? `${what} failed (HTTP ${r.status})${r.status === 401 || r.status === 403 ? ': the credentials were rejected' : ''}.${hint ? ` ${hint}` : ''}${r.body ? ` Provider said: ${r.body}` : ''}`,
});

// ------------------------------------------------------------------------------------------------ Plivo
export const PLIVO_API = 'https://api.plivo.com/v1';
const plivoAuth = (s: { authId: string; authToken: string }) => 'Basic ' + Buffer.from(`${s.authId}:${s.authToken}`).toString('base64');

/** Account check (read-only): proves the Auth ID / Token pair works. */
export async function plivoAccount(fetchImpl: FetchLike, s: { authId: string; authToken: string }): Promise<ProviderResult> {
  const r = await request(fetchImpl, `${PLIVO_API}/Account/${encodeURIComponent(s.authId)}/`, { headers: { Authorization: plivoAuth(s) } }, [s.authId, s.authToken]);
  if (r.status !== 200) return fail(r, 'Plivo account check');
  const a = (r.json ?? {}) as { name?: string; account_type?: string; cash_credits?: string; auto_recharge?: boolean };
  return { ok: true, latencyMs: r.ms, message: 'Plivo accepted these credentials.', details: { accountName: a.name ?? null, accountType: a.account_type ?? null, credits: a.cash_credits ?? null } };
}

/** Does this number belong to this Plivo account? (read-only; used before mapping or calling from it) */
export async function plivoNumber(fetchImpl: FetchLike, s: { authId: string; authToken: string }, number: string): Promise<ProviderResult> {
  const r = await request(fetchImpl, `${PLIVO_API}/Account/${encodeURIComponent(s.authId)}/Number/${encodeURIComponent(number)}/`, { headers: { Authorization: plivoAuth(s) } }, [s.authId, s.authToken]);
  if (r.status === 404) return { ok: false, latencyMs: r.ms, errorCode: 'number_not_on_account', message: `${number} is not a number on this Plivo account.` };
  if (r.status !== 200) return fail(r, 'Plivo number check');
  const n = (r.json ?? {}) as { voice_enabled?: boolean; application?: string | null; alias?: string | null };
  return { ok: true, latencyMs: r.ms, message: `${number} is on this Plivo account.`, details: { voiceEnabled: n.voice_enabled ?? null, application: n.application ? 'linked' : 'none' } };
}

/** Places a REAL call (costs money). Callers must have already applied every gate (dry run, approved recipient). */
export async function plivoCall(fetchImpl: FetchLike, s: { authId: string; authToken: string }, p: { from: string; to: string; answerUrl: string; hangupUrl: string }): Promise<ProviderResult> {
  const form = new URLSearchParams({ from: p.from, to: p.to, answer_url: p.answerUrl, answer_method: 'POST', hangup_url: p.hangupUrl, hangup_method: 'POST', ring_timeout: '30', time_limit: '60' });
  // Never retried: a timeout might still have placed the call.
  const r = await request(fetchImpl, `${PLIVO_API}/Account/${encodeURIComponent(s.authId)}/Call/`, { method: 'POST', headers: { Authorization: plivoAuth(s), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }, [s.authId, s.authToken], false);
  if (r.status !== 201 && r.status !== 200) return fail(r, 'Plivo call request');
  const j = (r.json ?? {}) as { request_uuid?: string | string[]; message?: string };
  const id = Array.isArray(j.request_uuid) ? j.request_uuid[0] : j.request_uuid;
  return { ok: true, latencyMs: r.ms, message: 'Plivo accepted the call request. Whether it rang and was answered is reported by the hangup callback.', details: { requestUuid: id ?? null }, units: 1, unitType: 'calls' };
}

// ------------------------------------------------------------------------------------------------ Sarvam
export const SARVAM_API = 'https://api.sarvam.ai';

export async function sarvamTts(fetchImpl: FetchLike, apiKey: string, p: { text: string; model: string; language: string; speaker: string }): Promise<ProviderResult & { audioBase64?: string }> {
  const r = await request(fetchImpl, `${SARVAM_API}/text-to-speech`, {
    method: 'POST',
    headers: { 'api-subscription-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: p.text, model: p.model, speaker: p.speaker, language_code: p.language, speech_sample_rate: 16000, output_audio_codec: 'wav' }),
  }, [apiKey]);
  if (r.status !== 200) return fail(r, 'Sarvam text-to-speech', r.status === 400 ? 'Check that the voice is available for this model and language.' : undefined);
  const audio = ((r.json ?? {}) as { audios?: string[] }).audios?.[0];
  if (!audio) return { ok: false, latencyMs: r.ms, errorCode: 'invalid_response', message: 'Sarvam answered without audio.' };
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.length < 44 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF') return { ok: false, latencyMs: r.ms, errorCode: 'invalid_response', message: 'Sarvam returned audio that is not a WAV file.' };
  return { ok: true, latencyMs: r.ms, message: `Sarvam generated ${p.language} speech with the voice "${p.speaker}".`, audioBase64: audio, details: { bytes: bytes.length }, units: p.text.length, unitType: 'characters' };
}

export async function sarvamStt(fetchImpl: FetchLike, apiKey: string, p: { audio: Buffer; model: string; mode?: string; language: string }): Promise<ProviderResult & { transcript?: string }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(p.audio)], { type: 'audio/wav' }), 'test.wav');
  form.append('model', p.model);
  if (p.model.startsWith('saaras') && p.mode) form.append('mode', p.mode);
  form.append('language_code', p.language);
  const r = await request(fetchImpl, `${SARVAM_API}/speech-to-text`, { method: 'POST', headers: { 'api-subscription-key': apiKey }, body: form }, [apiKey]);
  if (r.status !== 200) return fail(r, 'Sarvam speech-to-text');
  const j = (r.json ?? {}) as { transcript?: string; language_code?: string };
  const transcript = (j.transcript ?? '').trim();
  return { ok: true, latencyMs: r.ms, transcript, message: transcript ? 'Sarvam recognised the speech.' : 'Sarvam answered, but heard no words in this audio.', details: { languageDetected: j.language_code ?? null }, units: Math.max(1, Math.round(p.audio.length / 32_000)), unitType: 'seconds' };
}

// ------------------------------------------------------------------------------------------------ OpenAI
export const OPENAI_API = 'https://api.openai.com/v1';

/** Model availability for this key (read-only, free). */
export async function openaiModel(fetchImpl: FetchLike, apiKey: string, model: string): Promise<ProviderResult> {
  const r = await request(fetchImpl, `${OPENAI_API}/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` } }, [apiKey]);
  if (r.status === 404) return { ok: false, latencyMs: r.ms, errorCode: 'model_unavailable', message: `The model "${model}" is not available to this API key.` };
  if (r.status !== 200) return fail(r, 'OpenAI key check');
  return { ok: true, latencyMs: r.ms, message: `This key can use ${model}.`, details: { model } };
}

/** A tiny real completion: proves the key has quota, and reports token usage. */
export async function openaiChat(fetchImpl: FetchLike, apiKey: string, model: string): Promise<ProviderResult & { inputTokens?: number; outputTokens?: number; reply?: string }> {
  const r = await request(fetchImpl, `${OPENAI_API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_completion_tokens: 200 }),
  }, [apiKey]);
  if (r.status === 429) {
    const quota = /insufficient_quota/.test(r.body);
    return { ok: false, latencyMs: r.ms, errorCode: quota ? 'quota' : 'rate_limited', message: quota ? 'OpenAI says this account has no remaining quota (billing / credits). Add credits in the OpenAI dashboard.' : 'OpenAI rate-limited the request. Try again in a minute.' };
  }
  if (r.status !== 200) return fail(r, 'OpenAI test request');
  const j = (r.json ?? {}) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ message?: { content?: string } }> };
  const inputTokens = j.usage?.prompt_tokens ?? 0;
  const outputTokens = j.usage?.completion_tokens ?? 0;
  return { ok: true, latencyMs: r.ms, message: `${model} answered.`, reply: (j.choices?.[0]?.message?.content ?? '').slice(0, 80), inputTokens, outputTokens, units: inputTokens + outputTokens, unitType: 'tokens' };
}

// ------------------------------------------------------------------------------------------------ WhatsApp (Meta Graph)
export const GRAPH_API = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? 'v23.0'}`;

export async function whatsappNumber(fetchImpl: FetchLike, s: { accessToken: string }, phoneNumberId: string): Promise<ProviderResult> {
  const r = await request(fetchImpl, `${GRAPH_API}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type`, { headers: { Authorization: `Bearer ${s.accessToken}` } }, [s.accessToken]);
  if (r.status !== 200) return fail(r, 'WhatsApp phone number check', r.status === 400 ? 'Check the phone number ID and that the token can manage this WhatsApp account.' : undefined);
  const n = (r.json ?? {}) as Record<string, string>;
  return { ok: true, latencyMs: r.ms, message: `Meta confirmed the number ${n.display_phone_number ?? ''}.`.replace(' .', '.'), details: { displayPhoneNumber: n.display_phone_number ?? null, verifiedName: n.verified_name ?? null, qualityRating: n.quality_rating ?? null, nameStatus: n.name_status ?? null, codeVerification: n.code_verification_status ?? null, platform: n.platform_type ?? null } };
}

export async function whatsappTemplates(fetchImpl: FetchLike, s: { accessToken: string }, wabaId: string): Promise<ProviderResult & { templates?: Array<{ name: string; status: string; language: string; category: string }> }> {
  const r = await request(fetchImpl, `${GRAPH_API}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,language,category&limit=100`, { headers: { Authorization: `Bearer ${s.accessToken}` } }, [s.accessToken]);
  if (r.status !== 200) return fail(r, 'WhatsApp template list', 'Check the WhatsApp Business Account ID and the token\'s whatsapp_business_management permission.');
  const data = (((r.json ?? {}) as { data?: Array<Record<string, string>> }).data ?? []).map((t) => ({ name: t.name, status: t.status, language: t.language, category: t.category }));
  return { ok: true, latencyMs: r.ms, message: `${data.length} template(s); ${data.filter((t) => t.status === 'APPROVED').length} approved.`, templates: data };
}
