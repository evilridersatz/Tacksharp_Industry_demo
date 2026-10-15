import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TtsLimiter, retryableTtsStatus, ttsBackoffMs } from './tts-limiter.js';
import { pcmToWav } from '../voice/stream/audio.js';
/** 0.4 s of 8 kHz audio: a real, playable WAV (the service rejects anything else). */
const VALID_WAV = pcmToWav(new Int16Array(3200).fill(1000), 8000).toString('base64');

describe('TTS limiter', () => {
  it('never runs more than the limit at once', async () => {
    const limiter = new TtsLimiter(2);
    let running = 0, peak = 0;
    const job = () => limiter.run('live', async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--; });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
  });
  it('live call audio goes before background warm-up, and warm-up runs one at a time', async () => {
    const limiter = new TtsLimiter(1);
    const order: string[] = [];
    const job = (p: 'live' | 'background', name: string) => limiter.run(p, async () => { order.push(name); await new Promise((r) => setTimeout(r, 5)); });
    await Promise.all([job('background', 'b1'), job('background', 'b2'), job('live', 'l1'), job('live', 'l2')]);
    expect(order).toEqual(['b1', 'l1', 'l2', 'b2']);
  });
  it('retries only rate limits and server errors, with a capped back-off that honours Retry-After', () => {
    expect([429, 500, 503].every(retryableTtsStatus)).toBe(true);
    expect([400, 401, 422].some(retryableTtsStatus)).toBe(false);
    expect(ttsBackoffMs(1, '1')).toBe(1000);
    expect(ttsBackoffMs(1, '30')).toBe(1500);
    expect(ttsBackoffMs(1)).toBeLessThan(500);
  });
});

describe('Sarvam TTS (fetch faked)', () => {
  let SarvamService: any;
  beforeAll(async () => {
    process.env.SARVAM_API_KEY = 'test-key';
    process.env.VOICE_AUDIO_DIR = '/tmp/tacksharp-tts-test';
    ({ SarvamService } = await import('./sarvam.service.js'));
  });
  afterEach(() => vi.unstubAllGlobals());
  const ok = () => new Response(JSON.stringify({ audios: [VALID_WAV] }), { status: 200 });

  it('a 429 is retried and the reply still gets audio', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0.05' } })).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = await new SarvamService().textToSpeech(`hello ${Math.random()}`);
    expect(r.url).toMatch(/\.wav$/);
    expect(r.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('background warm-up: a 429 is skipped, never retried (capacity belongs to callers)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'retry-after': '0.05' } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await new SarvamService().textToSpeech(`warm ${Math.random()}`, { cache: true, priority: 'background' });
    expect(r).toMatchObject({ url: '', error: 'http_429', attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('live audio: one short retry at most, then the caller falls back', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '5' } }));
    vi.stubGlobal('fetch', fetchMock);
    const started = Date.now();
    const r = await new SarvamService().textToSpeech(`live ${Math.random()}`);
    expect(r).toMatchObject({ url: '', error: 'http_429', attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(1000); // Retry-After 5 s is capped at 400 ms for a live caller
  });
  it('audio Plivo cannot play (not a WAV / no samples) is a failure with a reason — never a silent URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ audios: [Buffer.from('<html>oops</html>' + ' '.repeat(40)).toString('base64')] }), { status: 200 })));
    const r = await new SarvamService().textToSpeech(`bad audio ${Math.random()}`);
    expect(r).toMatchObject({ url: '', error: 'invalid_audio:not_wav' });
  });
  it('a corrupt cached prompt (e.g. a crash mid-write) is deleted and synthesized again, not served silent forever', async () => {
    const fs = await import('node:fs/promises');
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const text = `cached corrupt ${Math.random()}`;
    const first = await new SarvamService().textToSpeech(text, { cache: true });
    const file = `/tmp/tacksharp-tts-test/${first.url.split('/').pop()}`;
    await fs.writeFile(file, Buffer.alloc(10)); // truncated
    const again = await new SarvamService().textToSpeech(text, { cache: true }); // a new process: no memory cache
    expect(again).toMatchObject({ cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await fs.readFile(file)).length).toBeGreaterThan(44);
  });
  it('a 400 is not retried; the caller gets an empty url and the exact error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await new SarvamService().textToSpeech('hello bad');
    expect(r).toMatchObject({ url: '', error: 'http_400', attempts: 1 });
  });
  it('the same cached line requested twice at once is synthesized once, then served from disk', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => { await new Promise((r) => setTimeout(r, 20)); return ok(); });
    vi.stubGlobal('fetch', fetchMock);
    const svc = new SarvamService();
    const text = `cached line ${Math.random()}`;
    const [a, b] = await Promise.all([svc.textToSpeech(text, { cache: true }), svc.textToSpeech(text, { cache: true })]);
    expect(a.url).toBe(b.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const again = await new SarvamService().textToSpeech(text, { cache: true });
    expect(again.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('Tamil script is spoken with ta-IN, English with en-IN', () => {
    const svc = new SarvamService();
    expect(svc.languageFor('சரி, Porur-ல 2 BHK')).toBe('ta-IN');
    expect(svc.languageFor('Which day and time suit you?')).toBe('en-IN');
  });
});

describe('Sarvam TTS latency guard (regression: 8.15 s turn)', () => {
  let SarvamService: any;
  beforeAll(async () => {
    process.env.SARVAM_API_KEY = 'test-key';
    process.env.VOICE_AUDIO_DIR = '/tmp/tacksharp-tts-test';
    ({ SarvamService } = await import('./sarvam.service.js'));
  });
  afterEach(() => vi.unstubAllGlobals());
  const ok = () => new Response(JSON.stringify({ audios: [VALID_WAV] }), { status: 200 });

  it('a live request that timed out is NOT retried (the caller falls back at once instead of waiting a second timeout)', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })).mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = await new SarvamService().textToSpeech(`timeout ${Math.random()}`, { priority: 'live' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ url: '', attempts: 1 });
    expect(r.error).toMatch(/timeout/);
  });

  it('a fast server error is still retried once and the reply gets audio', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const r = await new SarvamService().textToSpeech(`fast-fail ${Math.random()}`, { priority: 'live' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.url).toMatch(/\.wav$/);
  });

  it('cache: the same text in Tamil and English voices never shares audio; personal lines are not cacheable', async () => {
    const svc = new SarvamService();
    expect(svc.languageFor('அரை கிலோ boneless')).toBe('ta-IN');
    expect(svc.languageFor('half kilo boneless')).toBe('en-IN');
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const word = `line${Math.random()}`;
    const a = await svc.textToSpeech(`${word} சரிங்க`, { cache: true });
    const b = await svc.textToSpeech(`${word} சரிங்க`, { cache: true });
    const c = await svc.textToSpeech(`${word} okay`, { cache: true });
    expect(b).toMatchObject({ cached: true, url: a.url });
    expect(c.url).not.toBe(a.url);
    const { isPersonalLine } = await import('../voice/voice.service.js');
    expect(isPersonalLine('Order GR-ZEJ3NC confirm aachu — 646 rupees')).toBe(true);
    expect(isPersonalLine('Calling 98765 43210')).toBe(true);
    expect(isPersonalLine('How many kg of Boneless Chicken? 360 rupees a kilo.')).toBe(false);
  });
});

describe('TTS audio validation (no audio is ever served that Plivo cannot play)', () => {
  it('reads the format and duration of a WAV; rejects non-WAV, empty and silent-length files', async () => {
    const { inspectWav } = await import('./sarvam.service.js'); // after the key is set above (config is read at import)
    expect(inspectWav(pcmToWav(new Int16Array(8000), 8000))).toMatchObject({ ok: true, codec: 'pcm', sampleRate: 8000, channels: 1, bits: 16, durationMs: 1000 });
    expect(inspectWav(Buffer.from('RIFFxxxx'))).toEqual({ ok: false, reason: 'too_short' });
    expect(inspectWav(Buffer.concat([Buffer.from('<html>ngrok warning</html>'), Buffer.alloc(40)]))).toEqual({ ok: false, reason: 'not_wav' });
    expect(inspectWav(pcmToWav(new Int16Array(0), 8000))).toEqual({ ok: false, reason: 'no_audio_data' });
    expect(inspectWav(pcmToWav(new Int16Array(100), 8000))).toEqual({ ok: false, reason: 'silent_or_empty' });
  });
});
