import { Injectable, Optional } from '@nestjs/common';
import { SarvamService } from '../sarvam/sarvam.service.js';
import { MediaRejectedError, WhatsAppSenderService } from '../whatsapp/whatsapp-sender.service.js';
import { assessTranscript } from '../conversation/transcript-gate.js';
import { detectLanguage } from '../conversation/language.js';
import { errorMessage, log } from '../common/logger.js';
import { prepareForStt } from './audio-convert.js';
import { resolveVisionProvider, VisionNotConfiguredError, type VisionProvider, type VisionResult } from './vision.provider.js';

/**
 * Multimodal WhatsApp understanding shared by every industry (one service, no per-industry copies):
 *   voice note -> validated download -> Sarvam STT -> quality gate -> text for the industry's own engine
 *   image      -> validated download -> vision model (OCR, items, kind, confidence) -> text for the engine, or a
 *                 confirmation question when unsure, or a staff hand-off (payment screenshots are never "verified")
 *   reply      -> optional Sarvam TTS voice note in addition to the text (text is always sent; audio only when real)
 *
 * The media bytes are processed in memory and NEVER stored: only metadata (type, MIME, size), the transcription /
 * extracted text and the processing status are kept on the conversation message. That is the retention policy.
 * Facts (products, prices, availability) always come from the industry engine and its database, never from here.
 */
export type MediaMeta = { messageType: 'voice' | 'image' | 'document'; mimeType?: string; sizeBytes?: number; processing: 'ok' | 'weak' | 'rejected' | 'failed' | 'not_configured'; reason?: string };

export type Understood =
  /** Hand this text to the industry engine as the customer's message. */
  | { kind: 'text'; text: string; quality: 'ok' | 'weak'; meta: MediaMeta & Record<string, unknown> }
  /** Answer directly (could not understand, needs confirmation, or routed to staff); the engine is not run. */
  | { kind: 'reply'; reply: string; handoff?: boolean; meta: MediaMeta & Record<string, unknown> };

/** Below this the reading is shown back to the customer for confirmation instead of being acted on. */
export const VISION_CONFIDENCE_MIN = () => Number(process.env.VISION_CONFIDENCE_MIN) || 0.6;

const say = (lang: 'ta' | 'en', ta: string, en: string) => (lang === 'en' ? en : ta);
const langOf = (text: string | undefined): 'ta' | 'en' => (text && detectLanguage(text).lang === 'english' ? 'en' : 'ta');

@Injectable()
export class MultimodalService {
  /** Tests inject a provider; production resolves the organization's configured one per image. */
  visionOverride?: VisionProvider;

  constructor(
    private readonly sarvam: SarvamService,
    private readonly sender: WhatsAppSenderService,
    @Optional() private readonly visionResolver?: { resolve(): Promise<VisionProvider> },
  ) {}

  /** Voice note / audio -> text (Tamil, English, Tanglish), or a polite reply when it cannot be understood. */
  async understandAudio(mediaId: string): Promise<Understood> {
    let media: { buffer: Buffer; mimeType: string; sizeBytes: number };
    try {
      media = await this.sender.downloadMedia(mediaId, 'audio');
    } catch (error) {
      if (error instanceof MediaRejectedError) {
        log.warn('multimodal.audio_rejected', { reason: error.reason });
        return { kind: 'reply', reply: error.reason === 'too_large' ? 'Voice note romba periya size-ah irukku. Chinna voice note illa text-la anuppunga 🙏' : 'Indha file-ah ennala kekka mudiyala. Voice note illa text-la anuppunga 🙏', meta: { messageType: 'voice', processing: 'rejected', reason: error.reason } };
      }
      throw error; // network / Meta trouble: the job is retried (bounded), then dead-lettered
    }
    const started = Date.now();
    try {
      // Sarvam REST STT takes ≤ 30 s per request: convert to 16 kHz mono WAV and cut into pieces (ffmpeg), in order.
      const prepared = await prepareForStt(media.buffer, media.mimeType);
      if ('tooLong' in prepared) {
        return { kind: 'reply', reply: `Voice note romba neelama irukku (${Math.round(prepared.durationSec)} s). ${Math.round(Number(process.env.WHATSAPP_MAX_VOICE_SECONDS) || 180) / 60} nimishathukkulla anuppunga, illa text-la sollunga 🙏`, meta: { messageType: 'voice', mimeType: media.mimeType, sizeBytes: media.sizeBytes, processing: 'rejected', reason: 'too_long', durationSec: prepared.durationSec } };
      }
      const texts: string[] = [];
      let sttLanguage: string | undefined;
      for (const piece of prepared.pieces) {
        const r = await this.sarvam.speechToText(piece.bytes, piece.filename, piece.mimeType);
        if (r.transcript?.trim()) texts.push(r.transcript.trim());
        sttLanguage ??= r.languageCode;
      }
      const stt = { transcript: texts.join(' '), languageCode: sttLanguage };
      const gate = assessTranscript({ transcript: stt.transcript, sttLanguage: stt.languageCode });
      const meta = { messageType: 'voice' as const, mimeType: media.mimeType, sizeBytes: media.sizeBytes, transcription: stt.transcript.slice(0, 2000), sttLanguage: stt.languageCode ?? null, sttMs: Date.now() - started, durationSec: prepared.durationSec ?? null, pieces: prepared.pieces.length, converted: prepared.converted, ...(prepared.reason ? { conversionNote: prepared.reason } : {}) };
      log.info('multimodal.audio_transcribed', { ms: meta.sttMs, verdict: gate.verdict, language: stt.languageCode });
      if (gate.verdict === 'reject' || !gate.text) return { kind: 'reply', reply: 'Sorry, voice note clear-ah kekkala. Text-la anuppa mudiyuma? 🙏', meta: { ...meta, processing: 'failed', reason: 'unclear_speech' } };
      return { kind: 'text', text: gate.text, quality: gate.verdict === 'ok' ? 'ok' : 'weak', meta: { ...meta, processing: gate.verdict === 'ok' ? 'ok' : 'weak' } };
    } catch (error) {
      log.error('multimodal.stt_failed', { error: errorMessage(error) });
      return { kind: 'reply', reply: 'Sorry, voice note-ah ippo kekka mudiyala. Text-la anuppa mudiyuma? 🙏', meta: { messageType: 'voice', mimeType: media.mimeType, sizeBytes: media.sizeBytes, processing: 'failed', reason: 'stt_failed' } };
    }
  }

  /**
   * Image -> what the customer most likely means, grounded later by the industry engine against its own catalogue.
   * Payment screenshots go to staff (an image never proves a payment). Low confidence asks the customer to confirm.
   */
  async understandImage(mediaId: string, caption: string | undefined, catalogue: string[]): Promise<Understood> {
    const lang = langOf(caption);
    let media: { buffer: Buffer; mimeType: string; sizeBytes: number };
    try {
      media = await this.sender.downloadMedia(mediaId, 'image');
    } catch (error) {
      if (error instanceof MediaRejectedError) return { kind: 'reply', reply: say(lang, 'Indha image-ah open panna mudiyala (JPG / PNG, 5 MB-kulla anuppunga). Illa text-la sollunga 🙏', 'I could not open that image (please send a JPG or PNG under 5 MB), or type your message 🙏'), meta: { messageType: 'image', processing: 'rejected', reason: error.reason } };
      throw error;
    }
    let vision: VisionResult;
    try {
      const provider = this.visionOverride ?? (this.visionResolver ? await this.visionResolver.resolve() : await resolveVisionProvider());
      vision = await provider.analyze(media.buffer, media.mimeType, { caption, catalogue });
    } catch (error) {
      const notConfigured = error instanceof VisionNotConfiguredError;
      log[notConfigured ? 'warn' : 'error']('multimodal.vision_failed', { error: errorMessage(error) });
      const base = { messageType: 'image' as const, mimeType: media.mimeType, sizeBytes: media.sizeBytes, processing: notConfigured ? ('not_configured' as const) : ('failed' as const), reason: errorMessage(error).slice(0, 160) };
      // With a caption the customer's own words still drive the conversation; the picture is just not read.
      if (caption?.trim()) return { kind: 'text', text: caption.trim(), quality: 'ok', meta: base };
      return { kind: 'reply', reply: say(lang, 'Image kidaichadhu, aana ippo adha padikka mudiyala. Enna venum-nu text-la sollunga 🙏', 'Got your image, but I cannot read images right now. Please type what you need 🙏'), meta: base };
    }
    const meta = { messageType: 'image' as const, mimeType: media.mimeType, sizeBytes: media.sizeBytes, vision: { kind: vision.kind, description: vision.description, text: vision.text.slice(0, 1000), items: vision.items, confidence: vision.confidence, provider: vision.provider, model: vision.model } };
    log.info('multimodal.image_read', { kind: vision.kind, confidence: vision.confidence, items: vision.items.length });

    if (vision.kind === 'payment_screenshot') {
      return { kind: 'reply', handoff: true, reply: say(lang, 'Payment screenshot kidaichadhu. Namma team check panni confirm pannuvanga — screenshot mattum vechu payment confirm panna maattom 🙏', 'Thanks, we received the payment screenshot. Our team will check it and confirm — a screenshot alone does not confirm a payment 🙏'), meta: { ...meta, processing: 'ok', reason: 'payment_screenshot_to_staff' } };
    }
    const lines = vision.items.map((i) => `${i.quantity ?? ''}${i.unit ? ` ${i.unit}` : ''} ${i.name}`.trim());
    if (vision.confidence < VISION_CONFIDENCE_MIN()) {
      const seen = lines.length ? lines.join(', ') : vision.description || 'something I am not sure about';
      return { kind: 'reply', reply: say(lang, `Image-la "${seen}" maadhiri theriyudhu, aana sure-ah illa. Adhu sariyaa? Enna venum-nu text-la confirm pannunga 🙏`, `The image looks like "${seen}", but I am not sure. Is that right? Please confirm in text what you need 🙏`), meta: { ...meta, processing: 'weak', reason: 'low_confidence' } };
    }
    // Hand the engine what the picture says, plus the customer's own words. The engine checks every product, price
    // and availability against the database (an item the shop does not sell is answered as such, never invented).
    const parts: string[] = [];
    if (caption?.trim()) parts.push(caption.trim());
    if (vision.kind === 'order_screenshot' || vision.kind === 'menu_screenshot') {
      if (lines.length) parts.push(lines.join(', '));
      else if (vision.text) parts.push(vision.text.slice(0, 300));
    } else if (vision.kind === 'food_photo') {
      parts.push(lines.length ? `${lines.join(', ')} irukka? price enna?` : `${vision.description} irukka?`);
    } else if (vision.text) parts.push(vision.text.slice(0, 300));
    else if (vision.description) parts.push(vision.description);
    const text = parts.join('. ').trim();
    if (!text) return { kind: 'reply', reply: say(lang, 'Image kidaichadhu. Enna venum-nu text-la sollunga 🙏', 'Got your image. Please tell me in text what you need 🙏'), meta: { ...meta, processing: 'weak', reason: 'nothing_readable' } };
    return { kind: 'text', text, quality: 'ok', meta: { ...meta, processing: 'ok' } };
  }

  /** Documents (PDF etc.): acknowledged and left for staff; extraction from documents is pending. */
  understandDocument(caption: string | undefined, mimeType: string | undefined): Understood {
    const lang = langOf(caption);
    return { kind: 'reply', handoff: true, reply: say(lang, 'Document kidaichadhu, namma team paarthu reply pannuvanga 🙏', 'Thanks, we received your document; our team will look at it and reply 🙏'), meta: { messageType: 'document', mimeType, processing: 'ok', reason: 'document_to_staff' } };
  }

  /**
   * Optional voice-note reply for a customer who sent a voice note (WHATSAPP_VOICE_REPLIES=true). Real Sarvam audio
   * only: on any failure nothing is sent and the reason is returned (the text reply was already sent).
   */
  async sendVoiceReply(to: string, text: string): Promise<{ sent: boolean; messageId?: string; reason?: string }> {
    if (process.env.WHATSAPP_VOICE_REPLIES !== 'true') return { sent: false, reason: 'disabled' };
    const languageCode = /[஀-௿]/.test(text) || detectLanguage(text).lang !== 'english' ? 'ta-IN' : 'en-IN';
    const audio = await this.sarvam.speechBytes(text, { languageCode });
    if (!audio.ok) {
      log.warn('multimodal.voice_reply_skipped', { reason: audio.error });
      return { sent: false, reason: audio.error };
    }
    try {
      const mediaId = await this.sender.uploadMedia(audio.bytes, audio.mimeType, 'reply.mp3');
      const messageId = await this.sender.sendAudio(to, mediaId);
      return { sent: true, messageId };
    } catch (error) {
      log.warn('multimodal.voice_reply_failed', { error: errorMessage(error) });
      return { sent: false, reason: errorMessage(error).slice(0, 160) };
    }
  }
}
