import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { OpenAIVisionProvider, parseVision } from './vision.provider.js';
import { prepareForStt } from './audio-convert.js';

process.env.SARVAM_API_KEY ||= 'test-sarvam-key';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'PNID_TEST';

const ogg = (seconds: number) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { maxBuffer: 20 * 1024 * 1024 });

describe('voice-note preparation for Sarvam STT (30 s per request)', () => {
  it('converts OGG/Opus to 16 kHz mono WAV and cuts a 65 s note into 28 s pieces, in order', async () => {
    const r = await prepareForStt(ogg(65), 'audio/ogg');
    if ('tooLong' in r) throw new Error('unexpected');
    expect(r.converted).toBe(true);
    expect(r.durationSec).toBeGreaterThan(64);
    expect(r.pieces.map((p) => p.filename)).toEqual(['part-000.wav', 'part-001.wav', 'part-002.wav']);
    for (const p of r.pieces) {
      expect(p.mimeType).toBe('audio/wav');
      expect(p.bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(p.bytes.readUInt32LE(24)).toBe(16000); // sample rate
      expect(p.bytes.readUInt16LE(22)).toBe(1); // mono
    }
  });

  it('refuses a note longer than the limit (asked to send a shorter one), before any STT', async () => {
    process.env.WHATSAPP_MAX_VOICE_SECONDS = '10';
    try {
      expect(await prepareForStt(ogg(12), 'audio/ogg')).toMatchObject({ tooLong: true });
    } finally {
      delete process.env.WHATSAPP_MAX_VOICE_SECONDS;
    }
  });

  it('without ffmpeg the original bytes are used unchanged (works for notes under 30 s) and the reason is recorded', async () => {
    const bytes = ogg(2);
    const r = await prepareForStt(bytes, 'audio/ogg', { ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' });
    expect(r).toMatchObject({ converted: false, reason: 'ffmpeg_not_installed' });
    if (!('tooLong' in r)) expect(r.pieces[0]).toMatchObject({ mimeType: 'audio/ogg', filename: 'voice-note.ogg', bytes });
  });
});

describe('vision provider (OpenAI-compatible, mocked HTTP)', () => {
  it('sends the image inline with the catalogue and caption; reads strict JSON', async () => {
    const calls: Array<{ url: string; body: any; auth: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).Authorization) });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'menu_screenshot', description: 'A menu', text: 'Broiler 220', items: [{ name: 'Broiler Chicken', quantity: null, unit: null }], confidence: 0.81 }) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const v = new OpenAIVisionProvider('sk-test-key', 'gpt-vision-test', 'https://api.example.test/v1', fetchImpl);
    const r = await v.analyze(Buffer.from([1, 2, 3]), 'image/png', { caption: 'rate?', catalogue: ['Broiler Chicken'] });
    expect(r).toMatchObject({ kind: 'menu_screenshot', confidence: 0.81, items: [{ name: 'Broiler Chicken' }], provider: 'openai', model: 'gpt-vision-test' });
    expect(calls[0].url).toBe('https://api.example.test/v1/chat/completions');
    expect(calls[0].auth).toBe('Bearer sk-test-key');
    expect(calls[0].body.model).toBe('gpt-vision-test');
    const user = calls[0].body.messages[1].content;
    expect(user[0].text).toContain('Broiler Chicken');
    expect(user[0].text).toContain('rate?');
    expect(user[1].image_url.url).toBe('data:image/png;base64,AQID');
  });

  it('normalises junk: unknown kind -> other, confidence clamped, invalid JSON -> confidence 0', () => {
    expect(parseVision('{"kind":"selfie","confidence":7,"items":[{"name":""},{"name":"Eggs","quantity":"12","unit":"piece"}]}', 'p', 'm')).toMatchObject({ kind: 'other', confidence: 1, items: [{ name: 'Eggs', quantity: 12, unit: 'piece' }] });
    expect(parseVision('not json', 'p', 'm')).toMatchObject({ kind: 'other', confidence: 0, items: [] });
    expect(parseVision('```json\n{"kind":"food_photo","confidence":0.5}\n```', 'p', 'm').kind).toBe('food_photo');
  });
});

describe('Sarvam speech for voice-note replies (mocked HTTP): real audio or nothing', () => {
  it('calls the documented stream endpoint for MP3 and returns the bytes', async () => {
    const { SarvamService } = await import('../sarvam/sarvam.service.js');
    const { config } = await import('../common/config.js');
    config.sarvam.apiKey ||= 'test-sarvam-key'; // config is read at import time
    const svc = new SarvamService();
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(500, 1)]);
    const seen: any[] = [];
    svc.fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(new Uint8Array(mp3), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await svc.speechBytes('உங்க order ready', { languageCode: 'ta-IN' });
    expect(r).toMatchObject({ ok: true, mimeType: 'audio/mpeg', languageCode: 'ta-IN' });
    expect(seen[0].url).toBe('https://api.sarvam.ai/text-to-speech/stream');
    expect(seen[0].body).toMatchObject({ output_audio_codec: 'mp3', language_code: 'ta-IN' });
    svc.onModuleDestroy?.();
  });

  it('an error, a 429 or non-MP3 bytes give NO audio (never fabricated)', async () => {
    const { SarvamService } = await import('../sarvam/sarvam.service.js');
    const { config } = await import('../common/config.js');
    config.sarvam.apiKey ||= 'test-sarvam-key';
    const svc = new SarvamService();
    svc.fetchImpl = vi.fn(async () => new Response('{"error":{"code":"rate_limit_exceeded_error"}}', { status: 429 })) as unknown as typeof fetch;
    expect(await svc.speechBytes('hello')).toEqual({ ok: false, error: 'sarvam_tts_429' });
    svc.fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await svc.speechBytes('hello')).toMatchObject({ ok: false, error: 'invalid_audio:not_mp3' });
    svc.fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect((await svc.speechBytes('hello')).ok).toBe(false);
    svc.onModuleDestroy?.();
  });
});

describe('WhatsApp audio upload and send (mocked HTTP)', () => {
  it('uploads MP3 as multipart to /{phone-number-id}/media, then sends type=audio with the media id; blocked in DRY_RUN', async () => {
    const { WhatsAppSenderService } = await import('../whatsapp/whatsapp-sender.service.js');
    const { config } = await import('../common/config.js');
    config.whatsapp.accessToken ||= 'test-token';
    config.whatsapp.phoneNumberId ||= 'PNID_TEST';
    const s = new WhatsAppSenderService();
    const calls: Array<{ url: string; body: unknown }> = [];
    s.fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body });
      return new Response(JSON.stringify(String(url).endsWith('/media') ? { id: 'MEDIA123' } : { messages: [{ id: 'wamid.A1', message_status: 'accepted' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    process.env.DRY_RUN = 'true';
    await expect(s.uploadMedia(Buffer.alloc(200), 'audio/mpeg', 'r.mp3')).rejects.toThrow(/DRY_RUN/);
    expect(calls).toHaveLength(0);
    process.env.DRY_RUN = 'false';
    try {
      const id = await s.uploadMedia(Buffer.alloc(200), 'audio/mpeg', 'r.mp3');
      expect(id).toBe('MEDIA123');
      expect(calls[0].url).toMatch(/\/PNID_TEST\/media$|\/media$/);
      const form = calls[0].body as FormData;
      expect(form.get('messaging_product')).toBe('whatsapp');
      expect(form.get('type')).toBe('audio/mpeg');
      await s.sendAudio('919800011122', 'MEDIA123');
      expect(JSON.parse(String(calls[1].body))).toMatchObject({ messaging_product: 'whatsapp', to: '919800011122', type: 'audio', audio: { id: 'MEDIA123' } });
    } finally {
      process.env.DRY_RUN = 'true';
    }
  });
});
