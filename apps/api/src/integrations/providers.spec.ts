import { describe, expect, it } from 'vitest';
import { validateSave } from './providers.js';
import { openaiChat, plivoAccount, sarvamTts, scrub, whatsappNumber, type FetchLike } from './provider-clients.js';

const none = { config: {}, hasSecret: new Set<string>() };
const fields = (fn: () => unknown) => {
  try { fn(); return null; } catch (e) { return ((e as { getResponse?: () => { fields?: Record<string, string> } }).getResponse?.() ?? {}).fields ?? {}; }
};

describe('integration save validation', () => {
  it('requires every required field on first save', () => {
    expect(Object.keys(fields(() => validateSave('plivo', {}, none)) ?? {})).toEqual(['authId', 'authToken', 'fromNumber']);
  });
  it('keeps stored secrets when the field is left empty or the masked hint is sent back', () => {
    const r = validateSave('openai', { apiKey: '', model: 'gpt-5.4' }, { config: {}, hasSecret: new Set(['apiKey']) });
    expect(r.secrets).toEqual({});
    expect(validateSave('openai', { apiKey: '••••1234' }, { config: {}, hasSecret: new Set(['apiKey']) }).secrets).toEqual({});
  });
  it('rejects unsupported models, voices and malformed numbers (backend-validated, not just the dropdown)', () => {
    expect(fields(() => validateSave('openai', { apiKey: 'sk-abc', model: 'gpt-3.5-turbo' }, none))).toHaveProperty('model');
    expect(fields(() => validateSave('sarvam', { apiKey: 'k1234567', ttsSpeaker: 'darth' }, none))).toHaveProperty('ttsSpeaker');
    expect(fields(() => validateSave('plivo', { authId: 'MA123', authToken: 'tok', fromNumber: '12ab' }, none))).toHaveProperty('fromNumber');
    expect(fields(() => validateSave('whatsapp', { accessToken: 'EAA', phoneNumberId: 'abc', businessAccountId: '123456' }, none))).toHaveProperty('phoneNumberId');
  });
  it('normalises the caller ID and applies defaults', () => {
    const r = validateSave('plivo', { authId: 'MAID12345', authToken: 'token-abc', fromNumber: '+91 44 1234 5678' }, none);
    expect(r.config.fromNumber).toBe('914412345678');
    expect(validateSave('sarvam', { apiKey: 'key-123456' }, none).config).toMatchObject({ ttsModel: 'bulbul:v3', ttsLanguage: 'ta-IN' });
  });
  it('secrets with spaces are refused (copy-paste mistakes)', () => {
    expect(fields(() => validateSave('openai', { apiKey: 'sk abc' }, none))).toHaveProperty('apiKey');
  });
});

// Provider MOCKS (automated tests only): these prove request shape and error handling, not live connectivity.
const reply = (status: number, body: unknown): FetchLike => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('provider clients (mocked HTTP)', () => {
  it('Plivo: 401 becomes auth_failed with a safe message that never contains the token', async () => {
    const r = await plivoAccount(reply(401, 'authentication failed for token super-secret-token'), { authId: 'MAID1', authToken: 'super-secret-token' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('auth_failed');
    expect(r.message).not.toContain('super-secret-token');
  });
  it('Plivo: success reports the account, not the credentials', async () => {
    const r = await plivoAccount(reply(200, { name: 'Acme', account_type: 'standard', cash_credits: '12.5' }), { authId: 'MAID1', authToken: 'tok-123456' });
    expect(r).toMatchObject({ ok: true, details: { accountName: 'Acme' } });
  });
  it('OpenAI: insufficient_quota is reported as a quota problem', async () => {
    const r = await openaiChat(reply(429, { error: { code: 'insufficient_quota' } }), 'sk-test', 'gpt-5.4-mini');
    expect(r.errorCode).toBe('quota');
  });
  it('Sarvam: a non-WAV answer is not treated as working speech', async () => {
    const r = await sarvamTts(reply(200, { audios: [Buffer.from('not audio at all, really').toString('base64')] }), 'key', { text: 'hi', model: 'bulbul:v3', language: 'ta-IN', speaker: 'roopa' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('invalid_response');
  });
  it('WhatsApp: network failure is a clear network error (retried once)', async () => {
    let calls = 0;
    const r = await whatsappNumber(async () => { calls++; throw new TypeError('fetch failed'); }, { accessToken: 'EAAtoken12345' }, '123456');
    expect(r.errorCode).toBe('network');
    expect(calls).toBe(2);
  });
  it('scrub removes secrets and bearer tokens from provider text', () => {
    expect(scrub('bad key sk-abcdefghijk and Bearer EAAGxyz12345 for my-secret-value', ['my-secret-value'])).toBe('bad key sk-•••• and Bearer •••• for ••••');
  });
});
