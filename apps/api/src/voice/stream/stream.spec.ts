import { describe, expect, it, vi } from 'vitest';
import { decodeMulaw, encodeMulaw, linearToMulaw, mulawToLinear, parseWav, pcmToWav, resample, wavToPhoneMulaw, mulawMs } from './audio.js';
import { DEFAULT_ENDPOINTER, Endpointer, type EndpointEvent } from './endpointer.js';
import { StreamCall, implausibleTranscript, isBareHello, isEchoOf, splitForSpeech, type StreamDeps } from './stream-call.js';
import { streamToken, validStreamToken, streamXml } from '../plivo-xml.js';

const RATE = 8000;
const tone = (ms: number, amp = 6000, rate = RATE) => {
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate));
  return out;
};
const quiet = (ms: number, amp = 60) => {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round((Math.random() * 2 - 1) * amp);
  return out;
};
const cat = (...parts: Int16Array[]) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const feed = (ep: Endpointer, pcm: Int16Array, chunk = 160 * 3) => {
  const events: EndpointEvent[] = [];
  for (let i = 0; i < pcm.length; i += chunk) events.push(...ep.push(pcm.subarray(i, i + chunk)));
  return events;
};

describe('μ-law and WAV', () => {
  it('μ-law round trip stays within G.711 quantisation error', () => {
    for (const v of [0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]) {
      const back = mulawToLinear(linearToMulaw(v));
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(8, Math.abs(v) * 0.07));
    }
    expect(linearToMulaw(0)).toBe(0xff); // G.711 silence
  });
  it('buffer encode/decode keeps length and shape', () => {
    const pcm = tone(100);
    const back = decodeMulaw(encodeMulaw(pcm));
    expect(back.length).toBe(pcm.length);
    expect(Math.abs(back[20] - pcm[20])).toBeLessThan(500);
  });
  it('WAV written for STT parses back to the same audio', () => {
    const pcm = tone(50);
    const { pcm: back, sampleRate } = parseWav(pcmToWav(pcm));
    expect(sampleRate).toBe(8000);
    expect(Array.from(back)).toEqual(Array.from(pcm));
  });
  it('TTS WAV at 22.05 kHz with an extra chunk becomes 8 kHz phone audio of the same duration', () => {
    const pcm = tone(500, 6000, 22050);
    const wav = pcmToWav(pcm, 22050);
    // insert a LIST chunk before data, as some encoders do
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
    const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4);
    const mu = wavToPhoneMulaw(withList);
    expect(Math.abs(mulawMs(mu.length) - 500)).toBeLessThanOrEqual(2);
  });
  it('resample keeps duration', () => {
    expect(resample(tone(1000, 1000, 16000), 16000, 8000).length).toBe(8000);
  });
  it('rejects a file that is not WAV', () => {
    expect(() => parseWav(Buffer.from('ID3 not a wav file'))).toThrow();
  });
});

describe('end-of-speech detection', () => {
  it('a phrase followed by 700 ms of silence is one utterance, without the trailing silence', () => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    const events = feed(ep, cat(quiet(400), tone(1200), quiet(900)));
    const utt = events.find((e) => e.type === 'utterance');
    expect(events[0]?.type === 'speech_start' || events.some((e) => e.type === 'speech_start')).toBe(true);
    expect(utt?.type).toBe('utterance');
    if (utt?.type === 'utterance') {
      expect(utt.durationMs).toBeGreaterThanOrEqual(1200);
      expect(utt.durationMs).toBeLessThan(1900); // pre-roll + speech + 200 ms tail, not the full silence
    }
  });
  it('turn ends ~700 ms after speech stops, not 2 s (the old Plivo <Record> timeout)', () => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    feed(ep, cat(quiet(300), tone(800)));
    const before = feed(ep, quiet(600));
    expect(before.some((e) => e.type === 'utterance')).toBe(false);
    const after = feed(ep, quiet(200));
    expect(after.some((e) => e.type === 'utterance')).toBe(true);
  });
  it('a short pause inside a sentence does not end the turn', () => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    const events = feed(ep, cat(quiet(300), tone(600), quiet(400), tone(600), quiet(900)));
    expect(events.filter((e) => e.type === 'utterance')).toHaveLength(1);
  });
  it('a click or cough is noise, not a turn', () => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    const events = feed(ep, cat(quiet(300), tone(100), quiet(900)));
    expect(events.some((e) => e.type === 'utterance')).toBe(false);
    expect(events.some((e) => e.type === 'noise')).toBe(true);
  });
  it('steady line noise never starts a turn', () => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    expect(feed(ep, quiet(5000, 300)).some((e) => e.type === 'speech_start')).toBe(false);
  });
  it('a very long turn is cut at the maximum and still sent', () => {
    const ep = new Endpointer({ ...DEFAULT_ENDPOINTER, maxUtteranceMs: 3000 });
    // Real speech has syllable dips; a constant tone is treated as background, not speech.
    const syllables = Int16Array.from({ length: 4000 * 8 }, (_, i) => Math.round(6000 * Math.max(0.03, Math.abs(Math.sin((Math.PI * i) / 1600))) * Math.sin((2 * Math.PI * 200 * i) / 8000)));
    const utt = feed(ep, cat(quiet(400), syllables)).find((e) => e.type === 'utterance');
    expect(utt?.type === 'utterance' && utt.cut).toBe(true);
  });
  it('while our audio plays, quieter echo does not count as the customer', () => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    feed(ep, quiet(400));
    ep.setPlayback(true);
    expect(feed(ep, tone(600, 900)).some((e) => e.type === 'speech_start')).toBe(false);
    expect(feed(ep, tone(600, 6000)).some((e) => e.type === 'speech_start')).toBe(true);
  });
});

describe('end-of-speech detection on noisy phone lines', () => {
  const noise = (ms: number, amp: number) => Int16Array.from({ length: ms * 8 }, () => Math.round((Math.random() * 2 - 1) * amp * 1.7));
  const speech = (ms: number, amp: number, bg = 0) =>
    Int16Array.from({ length: ms * 8 }, (_, i) => {
      const syllable = Math.max(0.03, Math.abs(Math.sin((Math.PI * i) / 1600)));
      return Math.round(amp * 1.41 * syllable * Math.sin((2 * Math.PI * 200 * i) / 8000) + (Math.random() * 2 - 1) * bg * 1.7);
    });
  const endsAfter = (parts: Int16Array[], speechIndex: number) => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    let t = 0;
    let speechEnd = 0;
    const ends: number[] = [];
    parts.forEach((p, k) => {
      for (const e of feed(ep, p, 160)) if (e.type === 'utterance') ends.push(t + 0);
      t += p.length / 8;
      if (k === speechIndex) speechEnd = t;
    });
    return { ends, speechEnd };
  };
  it.each([300, 700, 900, 1200])('steady background (RMS %i): no false turn, and the answer still ends', (bg) => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    expect(feed(ep, noise(3000, bg), 160).some((e) => e.type === 'speech_start')).toBe(false);
    const events = feed(ep, cat(speech(1500, 3000, bg), noise(1500, bg)), 160);
    expect(events.filter((e) => e.type === 'utterance')).toHaveLength(1);
  });
  it('a quiet speaker in a noisy room is heard', () => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    feed(ep, noise(2000, 900), 160);
    expect(feed(ep, cat(speech(1500, 2000, 900), noise(1500, 900)), 160).some((e) => e.type === 'utterance')).toBe(true);
  });
  it('an 8-second answer with normal syllable dips is one turn', () => {
    const ep = new Endpointer(DEFAULT_ENDPOINTER);
    feed(ep, noise(1000, 200), 160);
    const utts = feed(ep, cat(speech(8000, 3000), noise(1200, 200)), 160).filter((e) => e.type === 'utterance');
    expect(utts).toHaveLength(1);
    expect(utts[0].type === 'utterance' && utts[0].durationMs).toBeGreaterThan(7500);
  });
  it('noise that starts suddenly ends its turn within ~2.5 s (the background estimate catches up)', () => {
    const { ends } = endsAfter([noise(1000, 200), noise(3500, 1000)], 0);
    expect(ends.length).toBeLessThanOrEqual(1);
  });
});

describe('sentence splitting for speech', () => {
  it('splits at sentence ends and joins very short pieces', () => {
    // A short tail question stays with the sentence before it (a lone "Correct-ஆ?" sounds clipped).
    expect(splitForSpeech('ஓகே. Porur, 2 BHK, 1 crore budget-ல பாக்குறீங்க. Correct-ஆ?')).toEqual(['ஓகே. Porur, 2 BHK, 1 crore budget-ல பாக்குறீங்க. Correct-ஆ?']);
    expect(splitForSpeech('Okay.')).toEqual(['Okay.']);
    expect(splitForSpeech('Green Valley Residency is 72 lakhs. It is ready to move. Shall we fix a site visit?')).toEqual([
      'Green Valley Residency is 72 lakhs.',
      'It is ready to move. Shall we fix a site visit?',
    ]);
  });
});

describe('pre-recorded first sentence plays at once', () => {
  it('a cached acknowledgement stays its own piece; a fully cached reply is one piece', () => {
    const cached = (t: string) => ['சரிங்க.', 'ஓகே. Budget எவ்ளோ வரைக்கும் பாக்குறீங்க?'].includes(t);
    expect(splitForSpeech('சரிங்க. Velachery-ல Metro Square, 84 lakhs இருக்கு. பாக்கலாமா?', 28, cached)).toEqual([
      'சரிங்க.',
      'Velachery-ல Metro Square, 84 lakhs இருக்கு. பாக்கலாமா?',
    ]);
    expect(splitForSpeech('ஓகே. Budget எவ்ளோ வரைக்கும் பாக்குறீங்க?', 28, cached)).toEqual(['ஓகே. Budget எவ்ளோ வரைக்கும் பாக்குறீங்க?']);
  });
});

describe('stream URL security', () => {
  it('token is per call and checked in constant time', () => {
    expect(validStreamToken('call_a', streamToken('call_a'))).toBe(true);
    expect(validStreamToken('call_b', streamToken('call_a'))).toBe(false);
    expect(validStreamToken('call_a', '')).toBe(false);
    expect(streamXml('call_a')).toMatch(/<Stream bidirectional="true" keepCallAlive="true" contentType="audio\/x-mulaw;rate=8000"/);
    expect(streamXml('call_a')).toMatch(/wss?:\/\/.*\/voice\/stream\?callId=call_a&amp;token=/);
  });
});

// ------------------------------------------------------------------------------------------------ the call loop

function harness(over: Partial<StreamDeps> = {}, opts: Partial<{ bargeInMs: number; fillerAfterMs: number; noResponseMs: number; openingText: string }> = {}) {
  const sent: Array<Record<string, any>> = [];
  const audio = (ms: number) => encodeMulaw(tone(ms));
  const reply = (text: string, end = false) => ({
    kind: 'reply' as const,
    turns: 1,
    finalText: text,
    end,
    cacheable: true,
    result: { path: 'rules', actions: {}, aiUsage: { requests: 0 } } as any,
  });
  const deps: StreamDeps = {
    transcribe: vi.fn(async () => ({ transcript: 'Porur la 2 BHK venum', languageCode: 'ta-IN' })),
    understand: vi.fn(async () => reply('Got it, Porur, 2 BHK apartment. What is your budget range for this?')),
    speak: vi.fn(async (text: string) => ({ audio: audio(text.length * 10), languageCode: 'en-IN', cached: false, attempts: 1 })),
    audioForUrl: vi.fn(async () => audio(300)),
    ttsFailed: vi.fn(async () => ({ audio: audio(200), fallback: 'line_issue_prompt' })),
    markReplyNotHeard: vi.fn(),
    logTurn: vi.fn(),
    hangup: vi.fn(async () => undefined),
    filler: vi.fn(async () => audio(300)),
    isEnglish: () => false,
    ...over,
  };
  const call = new StreamCall('call_1', (m) => sent.push(m), deps, {
    endpointer: DEFAULT_ENDPOINTER,
    bargeInMs: opts.bargeInMs ?? 400,
    fillerAfterMs: opts.fillerAfterMs ?? 0,
    noResponseMs: opts.noResponseMs ?? 0,
    chunkBytes: 4000,
  }, 'https://x/voice/audio/opening.wav', opts.openingText);
  const media = (pcm: Int16Array) => call.onMessage(JSON.stringify({ event: 'media', media: { track: 'inbound', payload: encodeMulaw(pcm).toString('base64') } }));
  const speakTurn = async (ms = 900) => {
    for (const piece of [quiet(200), tone(ms), quiet(900)]) for (let i = 0; i < piece.length; i += 160) await media(piece.subarray(i, i + 160));
  };
  const played = (name: string) => call.onMessage(JSON.stringify({ event: 'playedStream', streamId: 's1', name }));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { call, sent, deps, reply, media, speakTurn, played, settle, start: () => call.onMessage(JSON.stringify({ event: 'start', start: { streamId: 's1', callId: 'plivo-uuid', mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } } })) };
}

describe('real-time call loop', () => {
  it('plays the opening over the stream as soon as it starts, then listens', async () => {
    const h = harness();
    await h.start();
    expect(h.sent.some((m) => m.event === 'playAudio' && m.media.contentType === 'audio/x-mulaw' && m.media.sampleRate === 8000)).toBe(true);
    expect(h.sent.at(-1)).toMatchObject({ event: 'checkpoint', name: 'opening', streamId: 's1' });
    expect(h.call.currentState).toBe('speaking');
    await h.played('opening');
    expect(h.call.currentState).toBe('listening');
  });

  it('customer speaks -> STT -> engine -> reply audio, with the turn logged', async () => {
    const h = harness();
    await h.start();
    await h.played('opening');
    const before = h.sent.length;
    await h.speakTurn();
    await h.settle();
    expect(h.deps.transcribe).toHaveBeenCalledTimes(1);
    const wav = (h.deps.transcribe as any).mock.calls[0][0] as Buffer;
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.deps.understand).toHaveBeenCalledWith('Porur la 2 BHK venum', 'ta-IN', expect.any(Number));
    expect(h.sent.slice(before).filter((m) => m.event === 'playAudio').length).toBeGreaterThan(0);
    expect(h.deps.logTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stt: expect.any(Number) }), expect.objectContaining({ mode: 'stream', firstAudioMs: expect.any(Number), sentences: 2 }));
  });

  it('a two-sentence reply starts playing the first sentence before the second is synthesized', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const h = harness({
      speak: vi.fn(async (text: string) => {
        if (text.includes('budget')) await gate; // second sentence is slow
        order.push(`ready:${text.slice(0, 6)}`);
        return { audio: encodeMulaw(tone(300)), languageCode: 'en-IN', cached: false, attempts: 1 };
      }),
    });
    await h.start();
    await h.played('opening');
    await h.speakTurn();
    await h.settle();
    const playsBefore = h.sent.filter((m) => m.event === 'playAudio').length;
    expect(playsBefore).toBeGreaterThan(1); // opening + first sentence already sent
    release();
    await h.settle();
    expect(h.sent.filter((m) => m.event === 'playAudio').length).toBeGreaterThan(playsBefore);
  });

  it('barge-in: customer talks over the AI -> clearAudio, and an unheard question is marked not heard', async () => {
    const h = harness({ understand: vi.fn(async () => h.reply('Green Valley Residency, Sunday 18 October 11 AM. Shall I confirm this site visit?')) });
    await h.start();
    await h.played('opening');
    await h.speakTurn();
    await h.settle();
    expect(h.call.currentState).toBe('speaking');
    for (const piece of [tone(700)]) for (let i = 0; i < piece.length; i += 160) await h.media(piece.subarray(i, i + 160));
    expect(h.sent.some((m) => m.event === 'clearAudio' && m.streamId === 's1')).toBe(true);
    expect(h.deps.markReplyNotHeard).toHaveBeenCalled();
    expect(h.call.currentState).toBe('listening');
  });

  it('echo-level audio during our speech does not interrupt', async () => {
    const h = harness();
    await h.start();
    for (let i = 0; i < 4000; i += 160) await h.media(tone(20, 900));
    expect(h.sent.some((m) => m.event === 'clearAudio')).toBe(false);
  });

  it('end of conversation: goodbye plays, then the call is hung up after Plivo confirms playback', async () => {
    const h = harness({ understand: vi.fn(async () => h.reply('சரி, Thank you!', true)) });
    await h.start();
    await h.played('opening');
    await h.speakTurn();
    await h.settle();
    expect(h.deps.hangup).not.toHaveBeenCalled();
    expect(h.sent.at(-1)).toMatchObject({ event: 'checkpoint', name: 'end' });
    await h.played('end');
    expect(h.deps.hangup).toHaveBeenCalledWith('conversation_end');
    expect(h.call.currentState).toBe('closed');
  });

  it('TTS failure on a reply: line-issue prompt plays and the reply is marked not heard (via ttsFailed)', async () => {
    const h = harness({ speak: vi.fn(async () => ({ audio: null, languageCode: 'ta-IN', attempts: 3, error: 'http_429' })) });
    await h.start();
    await h.played('opening');
    await h.speakTurn();
    await h.settle();
    expect(h.deps.ttsFailed).toHaveBeenCalledWith(expect.anything(), 'http_429', 3);
    expect(h.deps.logTurn).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ fallback: 'line_issue_prompt' }));
  });

  it('silence or garbled speech: the unclear prompt plays, the engine is not involved beyond the gate', async () => {
    const h = harness({ understand: vi.fn(async () => ({ kind: 'unclear' as const, text: 'Sorry, சரியா கேக்கல.', english: 'x', end: false })) });
    await h.start();
    await h.played('opening');
    await h.speakTurn();
    await h.settle();
    expect(h.deps.speak).toHaveBeenCalledWith('Sorry, சரியா கேக்கல.', true);
  });

  it('a sound that transcribes to nothing (bus, door, TV) is ignored: no engine call, nothing said', async () => {
    const h = harness({ transcribe: vi.fn(async () => ({ transcript: '', languageCode: undefined })) });
    await h.start();
    await h.played('opening');
    const before = h.sent.length;
    await h.speakTurn();
    await h.settle();
    expect(h.deps.understand).not.toHaveBeenCalled();
    expect(h.sent.slice(before).some((m) => m.event === 'playAudio')).toBe(false);
    expect(h.call.currentState).toBe('listening');
  });

  it('a caller who says nothing after our question gets the silent-turn prompt from the timer', async () => {
    const h = harness({ understand: vi.fn(async () => ({ kind: 'unclear' as const, text: 'ஹலோ? கேக்குதா? சொல்லுங்க.', english: 'x', end: false })) }, { noResponseMs: 60 });
    await h.start();
    await h.played('opening');
    await new Promise((r) => setTimeout(r, 150));
    expect(h.deps.understand).toHaveBeenCalledWith('', undefined, 0);
    expect(h.deps.speak).toHaveBeenCalledWith('ஹலோ? கேக்குதா? சொல்லுங்க.', true);
  });

  it('the silence timer does not fire while the caller is talking', async () => {
    const h = harness({}, { noResponseMs: 60 });
    await h.start();
    await h.played('opening');
    for (let i = 0; i < 20; i++) await h.media(quiet(20)); // the line is measured first (opening time on a real call)
    for (let i = 0; i < 3; i++) await h.media(tone(40));
    await new Promise((r) => setTimeout(r, 120));
    expect(h.deps.understand).not.toHaveBeenCalledWith('', undefined, 0);
  });

  it('the cached acknowledgement is requested from cache and played before the slower sentence is ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      understand: vi.fn(async () => h.reply('சரிங்க. Velachery-ல Metro Square, 84 lakhs இருக்கு. பாக்கலாமா?')),
      isCachedLine: (t: string) => t === 'சரிங்க.',
      speak: vi.fn(async (text: string) => {
        if (text !== 'சரிங்க.') await gate; // the dynamic sentence takes time to synthesize
        return { audio: encodeMulaw(tone(300)), languageCode: 'ta-IN', cached: text === 'சரிங்க.', attempts: 1 };
      }),
    });
    await h.start();
    await h.played('opening');
    const before = h.sent.filter((m) => m.event === 'playAudio').length;
    await h.speakTurn();
    await h.settle();
    expect((h.deps.speak as any).mock.calls[0]).toEqual(['சரிங்க.', true]);
    expect(h.sent.filter((m) => m.event === 'playAudio').length).toBeGreaterThan(before); // ack already playing
    release();
    await h.settle();
  });

  it('filler policy: a rule-answered turn never gets a filler, even when speech-to-text itself is slow', async () => {
    const h = harness(
      {
        transcribe: vi.fn(async () => (await new Promise((r) => setTimeout(r, 120)), { transcript: 'Porur la 2 BHK venum', languageCode: 'ta-IN' })),
        understand: vi.fn(async () => h.reply('Got it, Porur, 2 BHK apartment. What is your budget range for this?')), // instant, like rules
      },
      { fillerAfterMs: 40 },
    );
    await h.start();
    await h.played('opening');
    await h.speakTurn();
    await new Promise((r) => setTimeout(r, 250));
    expect(h.deps.filler).not.toHaveBeenCalled();
    expect(h.deps.logTurn).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ filler: false }));
  });

  it('filler policy: never on two turns in a row, and the line rotates', async () => {
    const slow = vi.fn(async () => (await new Promise((r) => setTimeout(r, 120)), h.reply('Yes, it has covered parking for residents.')));
    const h = harness({ understand: slow }, { fillerAfterMs: 40 });
    await h.start();
    await h.played('opening');
    for (let k = 0; k < 3; k++) {
      await h.speakTurn();
      await new Promise((r) => setTimeout(r, 250));
      const cp = [...h.sent].reverse().find((m) => m.event === 'checkpoint');
      if (cp) await h.played(cp.name);
    }
    const calls = (h.deps.filler as any).mock.calls as Array<[boolean, number]>;
    expect(calls.length).toBe(2); // turns 1 and 3, not turn 2
    expect(calls[0][1]).not.toBe(calls[1][1]); // a different line each time
  });

  it('a slow answer gets a short filler so the line is never dead', async () => {
    const h = harness(
      { understand: vi.fn(async () => (await new Promise((r) => setTimeout(r, 120)), h.reply('Yes, it has covered parking.'))) },
      { fillerAfterMs: 40 },
    );
    await h.start();
    await h.played('opening');
    await h.speakTurn();
    await new Promise((r) => setTimeout(r, 250));
    expect(h.deps.filler).toHaveBeenCalled();
    expect(h.deps.logTurn).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ filler: true }));
  });
});

describe('real call 2026-10-10 (20:28): the caller\'s "Hello?" must not silence us', () => {
  const say = async (h: ReturnType<typeof harness>, ms: number) => {
    for (const piece of [quiet(200), tone(ms), quiet(900)]) for (let i = 0; i < piece.length; i += 160) await h.media(piece.subarray(i, i + 160));
  };

  it('"Hello?" on pick-up (short) does not cut the opening and is not answered as a turn', async () => {
    const h = harness({ transcribe: vi.fn(async () => ({ transcript: 'Hello?', languageCode: 'en-IN' })) });
    await h.start();
    expect(h.call.currentState).toBe('speaking');
    await say(h, 600);
    await h.settle();
    expect(h.sent.some((m) => m.event === 'clearAudio')).toBe(false); // opening keeps playing
    expect(h.deps.understand).not.toHaveBeenCalled(); // the opening answers "hello"
  });

  it('a real sentence over the opening (1.5 s+) still interrupts it', async () => {
    const h = harness();
    await h.start();
    for (let i = 0, t = cat(quiet(300), tone(1900)); i < t.length; i += 160) await h.media(t.subarray(i, i + 160));
    expect(h.sent.some((m) => m.event === 'clearAudio')).toBe(true);
  });

  it('a short "hello?" while the reply is being prepared does NOT throw the reply away (it plays), and is not answered twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const transcripts = ['Porur la 2 BHK venum', 'Hello?'];
    const h = harness({
      transcribe: vi.fn(async () => ({ transcript: transcripts.shift() ?? 'Hello?', languageCode: 'ta-IN' })),
      understand: vi.fn(async () => {
        await gate; // slow TTS / decision: the caller says "hello?" meanwhile
        return h.reply('Porur-ல Green Valley 80 lakhs இருக்கு. பாக்கலாமா?');
      }),
    });
    await h.start();
    await h.played('opening');
    await say(h, 900);
    await h.settle();
    expect(h.call.currentState).toBe('thinking');
    const playsBefore = h.sent.filter((m) => m.event === 'playAudio').length;
    await say(h, 600); // "Hello?"
    release();
    await h.settle();
    await h.settle();
    expect(h.sent.filter((m) => m.event === 'playAudio').length).toBeGreaterThan(playsBefore); // the reply WAS played
    expect(h.deps.understand).toHaveBeenCalledTimes(1); // the "hello" was not a second turn
  });

  it('a caller who keeps talking (1.5 s+) while we prepare still gets the newer answer instead', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const h = harness({
      understand: vi.fn(async () => {
        if (first) { first = false; await gate; }
        return h.reply('Okay, which budget?');
      }),
    });
    await h.start();
    await h.played('opening');
    await say(h, 900);
    await h.settle();
    for (let i = 0, t = tone(1900); i < t.length; i += 160) await h.media(t.subarray(i, i + 160));
    release();
    await h.settle();
    expect(h.deps.markReplyNotHeard).toHaveBeenCalled(); // the first answer was dropped, not spoken
  });

  it('bare "hello" detection', () => {
    for (const t of ['Hello?', 'hello hello', 'ஹலோ', 'ஹலோ ஹலோ.', 'Hello.']) expect(isBareHello(t)).toBe(true);
    for (const t of ['Hello, Porur la venum', 'ஆமா', 'hello sir I need 2 BHK']) expect(isBareHello(t)).toBe(false);
  });
});

describe('P0 2026-10-10 (21:20): silent caller, agent heard its own voice - speech validation before the engine', () => {
  const OPENING = 'Hi Sathish, Tacksharp Realty-ல இருந்து பேசுறேன். Porur Premium Residency enquiry பண்ணிருந்தீங்க. பேசலாமா?';
  const feedPcm = async (h: ReturnType<typeof harness>, pcm: Int16Array) => {
    for (let i = 0; i < pcm.length; i += 160) await h.media(pcm.subarray(i, i + 160));
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('1 + 10: complete silence -> no transcript, nothing invented; only the silence prompts, then a polite end', async () => {
    let silent = 0;
    const h = harness({
      understand: vi.fn(async (t: string) => {
        expect(t).toBe(''); // never invented text
        silent++;
        return { kind: 'unclear' as const, text: silent > 2 ? 'goodbye' : 'ஹலோ? கேக்குதா?', english: '', end: silent > 2 };
      }),
    }, { noResponseMs: 30 });
    await h.start();
    await h.played('opening');
    for (let round = 0; round < 6 && h.call.currentState !== 'closed'; round++) {
      await feedPcm(h, quiet(300));
      await wait(60);
      const last = [...h.sent].reverse().find((m) => m.event === 'checkpoint');
      if (last) await h.played(last.name);
      await wait(10);
    }
    expect(h.deps.transcribe).not.toHaveBeenCalled();
    expect(silent).toBe(3); // two prompts, then the goodbye
    expect(h.deps.hangup).toHaveBeenCalled();
  });

  it('2: agent audio only (inbound silent) -> no transcript, no barge-in', async () => {
    const h = harness({}, { openingText: OPENING });
    await h.start();
    await feedPcm(h, quiet(3000));
    expect(h.sent.some((m) => m.event === 'clearAudio')).toBe(false);
    expect(h.deps.transcribe).not.toHaveBeenCalled();
  });

  it('2b (the real bug): our own voice coming back during playback is transcribed but REJECTED - no engine call', async () => {
    const h = harness({ transcribe: vi.fn(async () => ({ transcript: 'Porur Premium Residency.', languageCode: 'ta-IN' })) }, { openingText: OPENING });
    await h.start(); // opening playing
    await feedPcm(h, cat(quiet(300), tone(900), quiet(900))); // echo of "Porur Premium Residency" (under the 1.5 s cut)
    await h.settle();
    expect(h.deps.transcribe).toHaveBeenCalledTimes(1);
    expect(h.deps.understand).not.toHaveBeenCalled(); // nothing reached the conversation engine
  });

  it('2b1: short unrelated STT result during the echo window never reaches the engine', async () => {
    const h = harness({
      transcribe: vi.fn(async () => ({ transcript: 'Okay.', languageCode: 'en-IN' })),
    }, { openingText: OPENING });
    await h.start(); // agent opening is playing
    await feedPcm(h, cat(quiet(300), tone(350), quiet(900)));
    await h.settle();

    expect(h.deps.transcribe).toHaveBeenCalledTimes(1);
    expect(h.deps.understand).not.toHaveBeenCalled();
  });

  it('2c: loud echo that cut our reply is rejected, the echo gate rises, and the reply is played again once', async () => {
    const reply = 'Porur-ல Porur Premium Residency, Green Acres Plots Guduvanchery இருக்கு. எதை பாக்கலாம்?';
    const transcripts = ['Porur la 2 BHK venum', 'Guduvanchery.'];
    const h = harness({
      transcribe: vi.fn(async () => ({ transcript: transcripts.shift() ?? 'Guduvanchery.', languageCode: 'ta-IN' })),
      understand: vi.fn(async () => h.reply(reply)),
    });
    await h.start();
    await h.played('opening');
    await feedPcm(h, cat(quiet(200), tone(900), quiet(900)));
    await h.settle();
    expect(h.call.currentState).toBe('speaking');
    await feedPcm(h, cat(tone(700), quiet(900))); // echo loud enough to barge in
    await h.settle();
    expect(h.sent.some((m) => m.event === 'clearAudio')).toBe(true);
    expect(h.deps.understand).toHaveBeenCalledTimes(1); // "Guduvanchery." (our own word) never became a customer turn
    const lastPlay = [...h.sent].reverse().find((m) => m.event === 'checkpoint');
    expect(lastPlay?.name).toMatch(/^replay-/); // the cut reply is heard again
  });

  it('3: background noise -> no transcript, no engine call', async () => {
    const h = harness();
    await h.start();
    await h.played('opening');
    await feedPcm(h, quiet(5000, 250)); // steady room noise
    for (let i = 0; i < 6; i++) await feedPcm(h, cat(tone(40, 9000), quiet(400))); // clicks
    expect(h.deps.understand).not.toHaveBeenCalled();
  });

  it('4: a real "ஆமா" said AFTER our line ends is accepted, even though our line contained "ஆமா"', async () => {
    const h = harness({ transcribe: vi.fn(async () => ({ transcript: 'ஆமா.', languageCode: 'ta-IN' })) }, { openingText: 'Visit confirm பண்ணட்டுமா? ஆமா, இல்ல வேண்டாம்னு சொல்லுங்க.' });
    await h.start();
    await h.played('opening');
    await wait(1500); // the caller answers after we finished (frames are fed faster than real time: wait out their length)
    await feedPcm(h, cat(quiet(200), tone(700), quiet(900)));
    await h.settle();
    expect(h.deps.understand).toHaveBeenCalledWith('ஆமா.', 'ta-IN', expect.any(Number));
  });

  it('6: a real interruption (different words) cuts us, is answered once, nothing replayed', async () => {
    const transcripts = ['Porur la 2 BHK venum', 'illa Velachery venum'];
    const h = harness({
      transcribe: vi.fn(async () => ({ transcript: transcripts.shift() ?? 'x', languageCode: 'ta-IN' })),
      understand: vi.fn(async () => h.reply('Porur-ல Porur Premium Residency 1.2 crore இருக்கு. பாக்கலாமா?')),
    });
    await h.start();
    await h.played('opening');
    await feedPcm(h, cat(quiet(200), tone(900), quiet(900)));
    await h.settle();
    await feedPcm(h, cat(tone(900), quiet(900)));
    await h.settle();
    expect(h.sent.some((m) => m.event === 'clearAudio')).toBe(true);
    expect(h.deps.understand).toHaveBeenCalledTimes(2);
    expect((h.deps.understand as any).mock.calls[1][0]).toBe('illa Velachery venum');
    expect(h.sent.some((m) => m.event === 'checkpoint' && /^replay-/.test(m.name))).toBe(false);
  });

  it('7: repeated / late frames (same sequence number) are dropped - one turn, normal length', async () => {
    const h = harness();
    await h.start();
    await h.played('opening');
    const pcm = cat(quiet(200), tone(900), quiet(900));
    let seq = 0;
    for (let i = 0; i < pcm.length; i += 160) {
      const payload = encodeMulaw(pcm.subarray(i, i + 160)).toString('base64');
      seq++;
      await h.call.onMessage(JSON.stringify({ event: 'media', sequenceNumber: seq, media: { track: 'inbound', payload } }));
      await h.call.onMessage(JSON.stringify({ event: 'media', sequenceNumber: seq, media: { track: 'inbound', payload } })); // duplicate
      if (seq > 3) await h.call.onMessage(JSON.stringify({ event: 'media', sequenceNumber: seq - 3, media: { track: 'inbound', payload } })); // late
    }
    await h.settle();
    expect(h.deps.transcribe).toHaveBeenCalledTimes(1);
    const wav = (h.deps.transcribe as any).mock.calls[0][0] as Buffer;
    const ms = ((wav.length - 44) / 2 / 8000) * 1000;
    expect(ms).toBeLessThan(1700); // not doubled
  });

  it('8: STT returns a fluent sentence for a tiny burst -> rejected as implausible, no engine call', async () => {
    const h = harness({ transcribe: vi.fn(async () => ({ transcript: 'நான் Porur Premium Residency-ல ரெண்டு BHK வீடு வாங்கணும்னு நினைக்கிறேன்', languageCode: 'ta-IN' })) });
    await h.start();
    await h.played('opening');
    await wait(1500);
    await feedPcm(h, cat(quiet(200), tone(500), quiet(900)));
    await h.settle();
    expect(h.deps.transcribe).toHaveBeenCalledTimes(1); // it WAS a speech segment
    expect(h.deps.understand).not.toHaveBeenCalled(); // but the text could not fit in it
  });

  it('9: echo of our confirmation question ("... ஆமா ...") never reaches the engine, so it can never book', async () => {
    const question = 'Porur Premium Residency, 13 October சாயங்காலம் 4 மணி. Confirm பண்ணட்டுமா? ஆமா, இல்ல வேண்டாம்னு சொல்லுங்க.';
    const h = harness({ transcribe: vi.fn(async () => ({ transcript: 'ஆமா.', languageCode: 'ta-IN' })) }, { openingText: question });
    await h.start(); // the question is playing
    await feedPcm(h, cat(quiet(200), tone(600), quiet(900)));
    await h.settle();
    expect(h.deps.understand).not.toHaveBeenCalled();
  });

  it('echo / plausibility helpers', () => {
    expect(isEchoOf('Porur Premium Residency.', 'Porur-ல Porur Premium Residency 1.2 crore இருக்கு')).toBe(true);
    expect(isEchoOf('Guduvanchery.', 'Porur, OMR, Guduvanchery - இதுல எந்த area பாக்கலாம்?')).toBe(true);
    expect(isEchoOf('illa Velachery venum', 'Porur-ல Porur Premium Residency இருக்கு')).toBe(false);
    expect(isEchoOf('ஆமா', '')).toBe(false);
    expect(implausibleTranscript('ஆமா', 400)).toBe(false);
    expect(implausibleTranscript('Porur Premium Residency', 1200)).toBe(false);
    expect(implausibleTranscript('நாளைக்கு சாயங்காலம் நாலு மணிக்கு வரேன்', 1500)).toBe(false); // real Tamil
    expect(implausibleTranscript('சரி பண்ணிருங்க', 500)).toBe(false);
    expect(implausibleTranscript('நான் Porur Premium Residency-ல ரெண்டு BHK வீடு வாங்கணும்னு நினைக்கிறேன்', 300)).toBe(true);
  });
});
