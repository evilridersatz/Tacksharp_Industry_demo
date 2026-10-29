import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { config } from '../common/config.js';
import { errorMessage, log } from '../common/logger.js';
import { FALLBACK, FAQ, GREETING, KNOWLEDGE, type Style } from './knowledge.js';

/**
 * "Tara", the Tacksharp website and dashboard assistant: answers questions about Tacksharp from the website's own
 * content (KNOWLEDGE), in Tamil, English or Tanglish, by text or voice (Sarvam speech-to-text and text-to-speech).
 * It uses the platform's own OpenAI and Sarvam accounts (server .env); keys never reach the browser.
 * It never claims to be a person, never invents prices or features, and stores nothing about the visitor.
 */
export type ChatTurn = { role: 'user' | 'assistant'; content: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TAMIL = /[஀-௿]/g;
/** Common romanised Tamil words: their presence in Latin text means Tanglish. */
const TANGLISH = /\b(enna|epdi|eppadi|irukka|irukku|iruku|venum|vendum|pannunga|panna|pannu|sollunga|sollu|illa|illai|inga|anga|unga|enga|naan|nan|neenga|ungaluku|theriyuma|theriyum|evlo|evvalavu|aagum|aaguma|vanakkam|seri|sari|konjam|romba|nalla|edhu|yaaru|eppo|epo|kudunga|paakanum|pesanum|kekanum|da|ji|nga|thaan|than|vaanga|podhum|mudiyuma|mudiyum|kitta|ku|la)\b/gi;

export function detectStyle(text: string): Style {
  const t = text.trim();
  if (!t) return 'en';
  const tamil = (t.match(TAMIL) ?? []).length;
  const letters = (t.match(/[\p{L}]/gu) ?? []).length || 1;
  if (tamil / letters > 0.3) return 'ta';
  const words = t.split(/\s+/).length;
  const hits = (t.match(TANGLISH) ?? []).length;
  if (hits >= 2 || (words <= 4 && hits >= 1)) return 'tanglish';
  return 'en';
}

/** Spoken form: emojis, markdown and URLs are not read aloud. */
export function forSpeech(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/₹\s?/g, 'rupees ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SYSTEM = (style: Style) => `You are Tara, the friendly assistant on the Tacksharp.ai website and dashboard. You talk like a warm, helpful person from Chennai on a live call: short sentences, natural, never robotic. You are an AI assistant; if asked, say so plainly.

Answer ONLY from the facts below. If something is not covered (exact prices, dates, integrations not listed, custom promises), say you don't have that detail and suggest creating an account, opening a demo, or that the team will help. Never invent prices, features, customers, numbers or contact details. Never give legal, medical or financial advice.

Language: reply in ${style === 'ta' ? 'Tamil script (you may keep product words like WhatsApp, dashboard, demo in English)' : style === 'tanglish' ? 'Tanglish: Tamil written in English letters, mixed naturally with English words, the way people in Chennai chat' : 'simple Indian English'}. Match the visitor if they switch language.
Length: 1 to 3 short sentences (under 60 words) - it will be spoken aloud. Add at most one fitting emoji. No markdown, no lists, no links; name pages by their button text (Create an account, Demos, Pricing).
End with a short natural question only when it helps the visitor move forward.

FACTS:
${KNOWLEDGE}`;

@Injectable()
export class AssistantService {
  fetchImpl: Fetch = (url, init) => fetch(url, init);
  private readonly ttsCache = new Map<string, string>();

  status() {
    return {
      chat: Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) ? 'ai' : 'faq',
      voice: Boolean(config.sarvam.apiKey),
      // Talking video presenter (Simli): needs its key + a face, and our own voice (Sarvam) to drive the lip-sync.
      video: Boolean(process.env.SIMLI_API_KEY && process.env.SIMLI_FACE_ID && config.sarvam.apiKey),
      languages: ['ta', 'en', 'tanglish'],
    };
  }

  greeting(style: Style) {
    return { reply: GREETING[style], style };
  }

  private faq(message: string, style: Style) {
    const hit = FAQ.find((f) => f.keys.test(message));
    return hit ? hit.answer[style] : FALLBACK[style];
  }

  /** One reply. `lang` = the visitor's choice (auto when absent). History is the visible conversation (client-held). */
  async chat(body: { message?: unknown; history?: unknown; lang?: unknown }) {
    const message = typeof body?.message === 'string' ? body.message.trim().slice(0, 600) : '';
    if (!message) throw new BadRequestException('Type or say something first.');
    const lang = ['ta', 'en', 'tanglish'].includes(String(body?.lang)) ? (body.lang as Style) : null;
    const style = lang ?? detectStyle(message);
    const history = (Array.isArray(body?.history) ? body.history : [])
      .filter((h): h is ChatTurn => Boolean(h) && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .slice(-8)
      .map((h) => ({ role: h.role, content: h.content.slice(0, 600) }));

    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    if (!apiKey && !process.env.OPENAI_BASE_URL) return { reply: this.faq(message, style), style, source: 'faq' as const };

    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey || 'local'}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OPENAI_ASSISTANT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
          messages: [{ role: 'system', content: SYSTEM(style) }, ...history, { role: 'user', content: message }],
          max_completion_tokens: Number(process.env.OPENAI_ASSISTANT_MAX_TOKENS) || 900,
          ...(process.env.OPENAI_ASSISTANT_REASONING_EFFORT ? { reasoning_effort: process.env.OPENAI_ASSISTANT_REASONING_EFFORT } : {}),
        }),
        signal: AbortSignal.timeout(Number(process.env.ASSISTANT_TIMEOUT_MS) || 20_000),
      });
      const j = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { code?: string } };
      const reply = (j.choices?.[0]?.message?.content ?? '').trim();
      if (!res.ok || !reply) {
        log.warn('assistant.ai_failed', { status: res.status, code: j.error?.code ?? null, ms: Date.now() - started });
        return { reply: this.faq(message, style), style, source: 'faq' as const };
      }
      log.info('assistant.reply', { style, ms: Date.now() - started, chars: reply.length });
      return { reply: reply.slice(0, 900), style, source: 'ai' as const };
    } catch (e) {
      log.warn('assistant.ai_unreachable', { error: errorMessage(e), ms: Date.now() - started });
      return { reply: this.faq(message, style), style, source: 'faq' as const };
    }
  }

  /** Visitor's voice -> text (Sarvam, code-mixed Tamil/English). Audio: base64 WAV, at most ~30 s. */
  async speechToText(body: { audioBase64?: unknown }) {
    if (!config.sarvam.apiKey) throw new ServiceUnavailableException('Voice input is not available right now. Please type your question.');
    const b64 = typeof body?.audioBase64 === 'string' ? body.audioBase64 : '';
    const audio = Buffer.from(b64, 'base64');
    if (audio.length < 1000) throw new BadRequestException('I could not hear anything. Please try again.');
    if (audio.length > 1_100_000) throw new BadRequestException('Please keep it under 30 seconds.');
    if (audio.subarray(0, 4).toString('ascii') !== 'RIFF') throw new BadRequestException('Unsupported audio.');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'visitor.wav');
    form.append('model', config.sarvam.sttModel);
    if (config.sarvam.sttModel.startsWith('saaras')) form.append('mode', 'codemix');
    form.append('language_code', 'unknown');
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.sarvam.ai/speech-to-text', { method: 'POST', headers: { 'api-subscription-key': config.sarvam.apiKey }, body: form, signal: AbortSignal.timeout(config.sarvam.timeoutMs) });
    } catch (e) {
      log.warn('assistant.stt_unreachable', { error: errorMessage(e) });
      throw new ServiceUnavailableException('Voice input is not reachable right now. Please type your question.');
    }
    if (!res.ok) {
      log.warn('assistant.stt_failed', { status: res.status, ms: Date.now() - started });
      throw new ServiceUnavailableException('I could not understand that audio. Please try again or type.');
    }
    const j = (await res.json()) as { transcript?: string; language_code?: string };
    const transcript = (j.transcript ?? '').trim();
    log.info('assistant.stt', { ms: Date.now() - started, chars: transcript.length, lang: j.language_code ?? null });
    return { transcript, language: j.language_code ?? null, style: transcript ? detectStyle(transcript) : null };
  }

  /**
   * A short-lived Simli session token for the talking video presenter. The Simli API key never leaves the server;
   * sessions are capped (length and idle time) because video is billed per minute.
   */
  async videoSession() {
    const apiKey = process.env.SIMLI_API_KEY ?? '';
    const faceId = process.env.SIMLI_FACE_ID ?? '';
    if (!apiKey || !faceId) throw new ServiceUnavailableException('The video presenter is not set up. Chat and voice still work.');
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.simli.ai/compose/token', {
        method: 'POST',
        headers: { 'x-simli-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faceId,
          handleSilence: true,
          maxSessionLength: Number(process.env.SIMLI_MAX_SESSION_SECONDS) || 600,
          maxIdleTime: Number(process.env.SIMLI_MAX_IDLE_SECONDS) || 90,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log.warn('assistant.video_unreachable', { error: errorMessage(e) });
      throw new ServiceUnavailableException('The video presenter is not reachable right now. Chat and voice still work.');
    }
    const j = (await res.json().catch(() => ({}))) as { session_token?: string; detail?: unknown };
    if (!res.ok || !j.session_token) {
      log.warn('assistant.video_refused', { status: res.status, ms: Date.now() - started });
      throw new ServiceUnavailableException('The video presenter could not start. Chat and voice still work.');
    }
    log.info('assistant.video_session', { ms: Date.now() - started });
    return { sessionToken: j.session_token };
  }

  /**
   * Text -> natural speech (Sarvam). Tamil and Tanglish use a Tamil voice (it reads mixed English naturally), English
   * an Indian-English voice. Short sentences are synthesised separately by the browser for a fast first word.
   */
  async textToSpeech(body: { text?: unknown; style?: unknown; sampleRate?: unknown }) {
    if (!config.sarvam.apiKey) throw new ServiceUnavailableException('Voice replies are not available right now.');
    const text = forSpeech(typeof body?.text === 'string' ? body.text : '').slice(0, 500);
    if (!text) throw new BadRequestException('Nothing to say.');
    const style = ['ta', 'en', 'tanglish'].includes(String(body?.style)) ? (body.style as Style) : detectStyle(text);
    const language = style === 'en' && !/[஀-௿]/.test(text) ? 'en-IN' : 'ta-IN';
    const speaker = process.env.ASSISTANT_TTS_SPEAKER || config.sarvam.ttsSpeaker;
    // 16 kHz drives the video presenter's lip-sync (PCM16 16 kHz mono); 22.05 kHz otherwise.
    const rate = Number(body?.sampleRate) === 16000 ? 16000 : 22050;
    const key = createHash('sha1').update(`${language}|${speaker}|${config.sarvam.ttsModel}|${rate}|${text}`).digest('hex');
    const hit = this.ttsCache.get(key);
    if (hit) return { audioBase64: hit, cached: true, language };
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: { 'api-subscription-key': config.sarvam.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model: config.sarvam.ttsModel, speaker, language_code: language, pace: Number(process.env.ASSISTANT_TTS_PACE) || 1.05, speech_sample_rate: rate, output_audio_codec: 'wav' }),
        signal: AbortSignal.timeout(config.sarvam.ttsTimeoutMs * 2),
      });
    } catch (e) {
      log.warn('assistant.tts_unreachable', { error: errorMessage(e) });
      throw new ServiceUnavailableException('Voice replies are not reachable right now.');
    }
    if (!res.ok) {
      log.warn('assistant.tts_failed', { status: res.status, ms: Date.now() - started });
      throw new ServiceUnavailableException('Could not create the voice reply.');
    }
    const audio = ((await res.json()) as { audios?: string[] }).audios?.[0];
    if (!audio) throw new ServiceUnavailableException('Could not create the voice reply.');
    if (this.ttsCache.size > 300) this.ttsCache.delete(this.ttsCache.keys().next().value!);
    this.ttsCache.set(key, audio);
    log.info('assistant.tts', { ms: Date.now() - started, chars: text.length, language });
    return { audioBase64: audio, cached: false, language };
  }
}
