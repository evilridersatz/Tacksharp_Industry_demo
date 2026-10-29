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
