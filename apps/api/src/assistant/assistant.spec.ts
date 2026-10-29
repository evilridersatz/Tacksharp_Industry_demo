import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../common/config.js';
import { AssistantService, detectStyle, forSpeech } from './assistant.service.js';

const wav = (bytes = 4000) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(bytes)]).toString('base64');
const saved = { key: config.sarvam.apiKey, openai: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
afterEach(() => {
  config.sarvam.apiKey = saved.key;
  if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
  if (saved.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved.base;
});

describe('assistant language detection', () => {
  it('tells Tamil, Tanglish and English apart', () => {
    expect(detectStyle('விலை எவ்வளவு?')).toBe('ta');
    expect(detectStyle('price evlo irukku?')).toBe('tanglish');
    expect(detectStyle('enna plans irukku')).toBe('tanglish');
    expect(detectStyle('How much does the Growth plan cost?')).toBe('en');
  });
  it('speech text drops emojis, markdown and links', () => {
    expect(forSpeech('Hi 👋 see **Pricing** https://x.example ₹500')).toBe('Hi see Pricing rupees 500');
  });
});

describe('assistant chat', () => {
  it('without a model: answers from the website FAQ in the visitor\'s language', async () => {
    delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_BASE_URL;
    const s = new AssistantService();
    const r = await s.chat({ message: 'price evlo?' });
    expect(r).toMatchObject({ source: 'faq', style: 'tanglish' });
    expect(r.reply).toMatch(/Pilot, Growth, Enterprise/);
    expect((await s.chat({ message: 'Do you integrate with SAP?' })).reply).toMatch(/don't have that detail/);
  });
  it('with a model: grounded system prompt, language instruction, short history', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const s = new AssistantService();
    let sent: any;
    s.fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'வணக்கம்! Pilot plan-ல ஆரம்பிக்கலாம் 🙂' } }] }), { status: 200 });
    });
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const r = await s.chat({ message: 'எப்படி ஆரம்பிக்கறது?', history });
    expect(r).toMatchObject({ source: 'ai', style: 'ta' });
    expect(sent.messages[0].content).toMatch(/Answer ONLY from the facts/);
    expect(sent.messages[0].content).toMatch(/Tamil script/);
    expect(sent.messages[0].content).toMatch(/53 B, SPE Monocity/);
    expect(sent.messages).toHaveLength(1 + 8 + 1);
  });
  it('a model failure falls back to the FAQ instead of an error', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const s = new AssistantService();
    s.fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 }));
    expect(await s.chat({ message: 'what about whatsapp?', lang: 'en' })).toMatchObject({ source: 'faq', style: 'en' });
  });
  it('refuses an empty message', async () => {
    await expect(new AssistantService().chat({ message: '  ' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('assistant voice (Sarvam mocked)', () => {
  it('speech-to-text sends code-mixed recognition and validates the audio', async () => {
    config.sarvam.apiKey = 'sv-test';
    const s = new AssistantService();
    let form: FormData | undefined;
    s.fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => { form = init?.body as FormData; return new Response(JSON.stringify({ transcript: 'price evlo irukku', language_code: 'ta-IN' }), { status: 200 }); });
    const r = await s.speechToText({ audioBase64: wav() });
    expect(r).toMatchObject({ transcript: 'price evlo irukku', style: 'tanglish' });
    expect(form?.get('language_code')).toBe('unknown');
    await expect(s.speechToText({ audioBase64: Buffer.from('not audio at all, nope, not RIFF').toString('base64').repeat(40) })).rejects.toMatchObject({ status: 400 });
  });
  it('text-to-speech: Tamil voice for Tamil / Tanglish, English voice for English, cached repeats', async () => {
    config.sarvam.apiKey = 'sv-test';
    const s = new AssistantService();
    const langs: string[] = [];
    s.fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => { langs.push(JSON.parse(String(init?.body)).language_code); return new Response(JSON.stringify({ audios: [wav(100)] }), { status: 200 }); });
    await s.textToSpeech({ text: 'Unga dashboard ready 🙂', style: 'tanglish' });
    await s.textToSpeech({ text: 'Your dashboard is ready.', style: 'en' });
    const again = await s.textToSpeech({ text: 'Your dashboard is ready.', style: 'en' });
    expect(langs).toEqual(['ta-IN', 'en-IN']);
    expect(again.cached).toBe(true);
  });
  it('says plainly when voice is not configured', async () => {
    config.sarvam.apiKey = '';
    await expect(new AssistantService().textToSpeech({ text: 'hi' })).rejects.toMatchObject({ status: 503 });
  });
});

describe('video presenter session (Simli mocked)', () => {
  const env = { key: process.env.SIMLI_API_KEY, face: process.env.SIMLI_FACE_ID };
  afterEach(() => {
    if (env.key === undefined) delete process.env.SIMLI_API_KEY; else process.env.SIMLI_API_KEY = env.key;
    if (env.face === undefined) delete process.env.SIMLI_FACE_ID; else process.env.SIMLI_FACE_ID = env.face;
  });
  it('creates a capped session with the server-side key and returns only the token', async () => {
    process.env.SIMLI_API_KEY = 'simli-secret-key'; process.env.SIMLI_FACE_ID = 'face-123';
    const s = new AssistantService();
    let call: { url: string; headers: Record<string, string>; body: any } | undefined;
    s.fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      call = { url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ session_token: 'tok-abc', warnings: [] }), { status: 200 });
    });
    const r = await s.videoSession();
    expect(r).toEqual({ sessionToken: 'tok-abc' });
    expect(JSON.stringify(r)).not.toContain('simli-secret-key');
    expect(call!.url).toBe('https://api.simli.ai/compose/token');
    expect(call!.headers['x-simli-api-key']).toBe('simli-secret-key');
    expect(call!.body).toMatchObject({ faceId: 'face-123', handleSilence: true, maxSessionLength: 600, maxIdleTime: 90 });
  });
  it('is unavailable (503) without a key or face, and when Simli refuses', async () => {
    delete process.env.SIMLI_API_KEY;
    await expect(new AssistantService().videoSession()).rejects.toMatchObject({ status: 503 });
    process.env.SIMLI_API_KEY = 'k'; process.env.SIMLI_FACE_ID = 'f';
    const s = new AssistantService();
    s.fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: 'bad face' }), { status: 400 }));
    await expect(s.videoSession()).rejects.toMatchObject({ status: 503 });
  });
  it('voice for the presenter is synthesised at 16 kHz', async () => {
    config.sarvam.apiKey = 'sv-test';
    const s = new AssistantService();
    let rate = 0;
    s.fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => { rate = JSON.parse(String(init?.body)).speech_sample_rate; return new Response(JSON.stringify({ audios: [wav(100)] }), { status: 200 }); });
    await s.textToSpeech({ text: 'Vanakkam', sampleRate: 16000 });
    expect(rate).toBe(16000);
  });
});
