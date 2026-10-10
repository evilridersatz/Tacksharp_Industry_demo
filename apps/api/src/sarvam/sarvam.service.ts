import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { TtsLimiter, retryableTtsStatus, ttsBackoffMs, type TtsPriority } from './tts-limiter.js';

export type TtsResult = { url: string; ms: number; attempts: number; cached: boolean; languageCode: string; error?: string };

export type SttResult = {
  transcript: string;
  languageCode?: string;
  latencyMs: number;
};

const TAMIL_SCRIPT = /[\u0B80-\u0BFF]/;

/**
 * Sarvam speech services.
 *  - STT: Saaras v3 (REST, <=30s audio) in "codemix" mode: English words stay English,
 *    Tamil words come back in Tamil script. Best fit for Chennai Tanglish.
 *  - TTS: Bulbul v3. Audio is written to VOICE_AUDIO_DIR and served at /voice/audio/:file
 *    so Plivo can <Play> it.
 */
@Injectable()
export class SarvamService implements OnModuleInit, OnModuleDestroy {
  private readonly cache = new Map<string, string>();
  /** The same text being synthesized right now: share that request instead of paying for it twice. */
  private readonly inflight = new Map<string, Promise<TtsResult>>();
  private readonly limiter = new TtsLimiter(Math.max(1, config.sarvam.ttsConcurrency));
  /** Location / project names to bias STT toward (filled by VoiceService from inventory). */
  keyterms: string[] = config.sarvam.sttKeyterms;
  private cleanupTimer?: NodeJS.Timeout;

  async onModuleInit() {
    await fs.mkdir(config.voice.audioDir, { recursive: true });
    // Delete generated audio older than 2 hours (cached prompts are re-created on demand).
    this.cleanupTimer = setInterval(() => void this.cleanup(), 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  get enabled() {
    return Boolean(config.sarvam.apiKey);
  }

  async speechToText(audio: Buffer, filename = 'audio.wav', mimeType = 'audio/wav'): Promise<SttResult> {
    const startedAt = Date.now();
    if (!this.enabled) throw new Error('SARVAM_API_KEY is missing');

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
    form.append('model', config.sarvam.sttModel);
    if (config.sarvam.sttModel.startsWith('saaras')) {
      form.append('mode', config.sarvam.sttMode);
    }
    form.append('language_code', config.sarvam.sttLanguage);
    // Bias recognition toward local place / project names (saaras:v4 only, max 50).
    if (config.sarvam.sttModel === 'saaras:v4' && this.keyterms.length > 0) {
      form.append('keyterms', JSON.stringify(this.keyterms.slice(0, 50)));
    }

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': config.sarvam.apiKey },
      body: form,
      signal: AbortSignal.timeout(config.sarvam.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sarvam STT ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = (await response.json()) as { transcript?: string; language_code?: string };
    const result = {
      transcript: (data.transcript ?? '').trim(),
      languageCode: data.language_code,
      latencyMs: Date.now() - startedAt,
    };
    log.info('sarvam.stt', {
      latencyMs: result.latencyMs,
      languageCode: result.languageCode,
      chars: result.transcript.length,
      bytes: audio.length,
    });
    return result;
  }

  /** Tamil script present -> ta-IN voice, otherwise en-IN. */
  languageFor(text: string) {
    return TAMIL_SCRIPT.test(text) ? 'ta-IN' : 'en-IN';
  }

  /**
   * Generates speech and returns a public URL for Plivo <Play>.
   * Returns '' on failure so callers can fall back gracefully instead of dropping the call.
   */
  async textToSpeechUrl(text: string, options: { cache?: boolean; priority?: TtsPriority } = {}): Promise<string> {
    return (await this.textToSpeech(text, options)).url;
  }

  /**
   * Speech for one reply, with everything a live call needs:
   *  - cached audio is served from disk with no request (fixed lines and repeated rule replies);
   *  - an identical request already in flight is shared, never sent twice;
   *  - at most SARVAM_TTS_CONCURRENCY requests at once, live calls ahead of background warm-up;
   *  - live: 429 / 5xx / timeouts get one short retry (≤400 ms wait) inside a total time budget; background: no retry;
   *  - on final failure: url '' plus the exact error, so the caller can fall back (never hangs the call).
   */
  async textToSpeech(text: string, options: { cache?: boolean; priority?: TtsPriority } = {}): Promise<TtsResult> {
    const clean = text.trim();
    const languageCode = this.languageFor(clean);
    if (!clean || !this.enabled) return { url: '', ms: 0, attempts: 0, cached: false, languageCode, error: clean ? 'disabled' : 'empty' };

    // The key covers everything that changes the audio, so a changed voice / pace / model never serves old audio.
    const cacheKey = `${languageCode}:${config.sarvam.ttsModel}:${config.sarvam.ttsSpeaker}:${config.sarvam.ttsPace}:${this.temperature() ?? ''}:${config.sarvam.ttsSampleRate}:${clean}`;
    const cachedName = `prompt-${crypto.createHash('sha1').update(cacheKey).digest('hex').slice(0, 16)}.wav`;
    if (options.cache) {
      // Deterministic file name: the disk copy survives API restarts, so a restart does not re-pay for every prompt.
      if (this.cache.has(cacheKey) || (await this.exists(cachedName))) {
        this.cache.set(cacheKey, cachedName);
        return { url: this.publicUrl(cachedName), ms: 0, attempts: 0, cached: true, languageCode };
      }
      const running = this.inflight.get(cacheKey);
      if (running) return running;
    }
    const work = this.synthesize(clean, languageCode, options.cache ? cachedName : `${crypto.randomUUID()}.wav`, options.priority ?? 'live').then((r) => {
      if (r.url && options.cache) this.cache.set(cacheKey, cachedName);
      return r;
    });
    if (options.cache) {
      this.inflight.set(cacheKey, work);
      void work.finally(() => this.inflight.delete(cacheKey));
    }
    return work;
  }

  private async synthesize(clean: string, languageCode: string, filename: string, priority: TtsPriority): Promise<TtsResult> {
    const startedAt = Date.now();
    const budget = priority === 'live' ? config.sarvam.ttsBudgetMs : 60_000;
    // Background (cache warm-up): one try, a 429 is skipped, never retried - it would eat capacity a caller needs.
    // Live: one short retry, then the caller's fallback (cached line / alternate reply) takes over.
    const maxAttempts = priority === 'live' ? 2 : 1;
    let attempts = 0;
    let lastError = '';
    while (attempts < maxAttempts) {
      attempts++;
      const remaining = budget - (Date.now() - startedAt);
      if (remaining < 500) break;
      let retryAfter: string | null = null;
      try {
        const result = await this.limiter.run(priority, async () => {
          const response = await fetch('https://api.sarvam.ai/text-to-speech', {
            method: 'POST',
            headers: { 'api-subscription-key': config.sarvam.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: this.prepareForSpeech(clean).slice(0, 2500),
              model: config.sarvam.ttsModel,
              speaker: config.sarvam.ttsSpeaker,
              language_code: languageCode,
              pace: config.sarvam.ttsPace,
              ...(this.temperature() !== undefined ? { temperature: this.temperature() } : {}),
              speech_sample_rate: config.sarvam.ttsSampleRate,
              output_audio_codec: 'wav',
            }),
            signal: AbortSignal.timeout(Math.min(config.sarvam.ttsTimeoutMs, remaining)),
          });
          if (!response.ok) {
            retryAfter = response.headers.get('retry-after');
            return { status: response.status, body: (await response.text()).slice(0, 300) };
          }
          const data = (await response.json()) as { audios?: string[] };
          return { status: response.status, audio: data.audios?.[0] };
        });
        if ('audio' in result && result.audio) {
          await fs.mkdir(config.voice.audioDir, { recursive: true });
          await fs.writeFile(path.join(config.voice.audioDir, filename), Buffer.from(result.audio, 'base64'));
          const ms = Date.now() - startedAt;
          log.info('sarvam.tts', { latencyMs: ms, languageCode, chars: clean.length, attempts, priority, cached: filename.startsWith('prompt-') });
          return { url: this.publicUrl(filename), ms, attempts, cached: false, languageCode };
        }
        if ('audio' in result) {
          lastError = 'empty_audio';
        } else {
          lastError = `http_${result.status}`;
          log.warn('sarvam.tts_error', { status: result.status, attempt: attempts, priority, body: result.body });
          if (!retryableTtsStatus(result.status)) break;
        }
      } catch (error) {
        lastError = errorMessage(error).slice(0, 120);
        log.warn('sarvam.tts_failed', { error: lastError, attempt: attempts, priority, latencyMs: Date.now() - startedAt });
      }
      if (attempts < maxAttempts) await new Promise((r) => setTimeout(r, ttsBackoffMs(attempts, retryAfter, 400)));
    }
    const ms = Date.now() - startedAt;
    log.error('sarvam.tts_gave_up', { error: lastError, attempts, priority, latencyMs: ms, chars: clean.length, languageCode });
    return { url: '', ms, attempts, cached: false, languageCode, error: lastError || 'budget_exceeded' };
  }

  /** `temperature` exists only on bulbul:v3 / bulbul:v4-flash (Sarvam API reference); never sent to other models. */
  private temperature(): number | undefined {
    const t = config.sarvam.ttsTemperature;
    if (!/^bulbul:v(3|4-flash)/.test(config.sarvam.ttsModel) || !Number.isFinite(t)) return undefined;
    return Math.min(1, Math.max(0.01, t));
  }

  /** Bulbul reads large numbers correctly only with Indian comma grouping (80,00,000). */
  private prepareForSpeech(text: string) {
    return text.replace(/\b\d{5,}\b/g, (n) => Number(n).toLocaleString('en-IN'));
  }

  /** Deletes per-call audio (never the cached shared prompts). Accepts URLs or file names. */
  async deleteAudio(urlsOrNames: string[]) {
    await Promise.all(
      urlsOrNames.map(async (u) => {
        const name = path.basename(u.split('?')[0]);
        if (!name.endsWith('.wav') || name.startsWith('prompt-')) return;
        try {
          await fs.unlink(path.join(config.voice.audioDir, name));
        } catch {
          /* already gone */
        }
      }),
    );
  }

  /** The WAV bytes behind a URL this service returned (real-time mode streams them instead of Plivo fetching them). */
  async audioBytes(url: string): Promise<Buffer | null> {
    const name = path.basename(String(url).split('?')[0]);
    if (!/^[\w.-]+\.wav$/.test(name)) return null;
    try {
      return await fs.readFile(path.join(config.voice.audioDir, name));
    } catch {
      return null;
    }
  }

  private publicUrl(filename: string) {
    return `${config.publicBaseUrl}/voice/audio/${filename}`;
  }

  private async exists(filename: string) {
    try {
      await fs.access(path.join(config.voice.audioDir, filename));
      return true;
    } catch {
      return false;
    }
  }

  private async cleanup() {
    try {
      const cutoff = Date.now() - 30 * 60 * 1000; // safety net; calls delete their own files on hang-up
      const promptCutoff = Date.now() - 7 * 24 * 3600 * 1000; // shared prompts are re-created on demand
      for (const file of await fs.readdir(config.voice.audioDir)) {
        if (!file.endsWith('.wav')) continue;
        const full = path.join(config.voice.audioDir, file);
        const stat = await fs.stat(full);
        const limit = file.startsWith('prompt-') ? promptCutoff : cutoff;
        if (stat.mtimeMs < limit) {
          await fs.unlink(full);
          if (file.startsWith('prompt-')) for (const [k, v] of this.cache) if (v === file) this.cache.delete(k);
        }
      }
    } catch (error) {
      log.warn('sarvam.cleanup_failed', { error: errorMessage(error) });
    }
  }
}
