# WhatsApp multimodal: voice notes, images, documents (P1)

One shared service (`apps/api/src/media/`) used by every industry. It turns media into text for the industry's own
engine, so for GR Chicken every product, price and availability is checked by the ordering engine against the
database. The service itself never answers a product or price question.

## Flow

```
Meta webhook (signed, x-hub-signature-256) → inbound row keyed by Meta message id (dedupe) → BullMQ job
  → worker claims the row (one reply per message; bounded retries; dead-letter after the last attempt)
  → audio:  download (authenticated Meta media API) → MIME + size check → ffmpeg: 16 kHz mono WAV in ≤ 28 s pieces
            → Sarvam STT per piece → quality gate → text → industry engine (GR Chicken: ordering engine, DB prices)
            → text reply (always) → optional Sarvam TTS voice note (WHATSAPP_VOICE_REPLIES=true; real audio only)
  → image:  download → MIME + size check → vision model (kind, OCR text, items, confidence) →
            payment screenshot → staff (never "verified"); low confidence → shown back for confirmation;
            otherwise caption + read items → industry engine (catalogue check; unknown items are not invented)
  → document: acknowledged, conversation handed to staff (extraction pending)
  → conversation message: content + metadata.media {messageType, mimeType, sizeBytes, processing, reason,
            transcription, sttLanguage, durationSec, vision{kind, confidence, description, items}}
```

## Files

| File | What |
|---|---|
| `src/media/multimodal.service.ts` | `understandAudio`, `understandImage`, `understandDocument`, `sendVoiceReply` |
| `src/media/audio-convert.ts` | ffmpeg conversion and 28 s segmentation; too-long refusal; works without ffmpeg for notes < 30 s |
| `src/media/vision.provider.ts` | Configurable vision provider (OpenAI-compatible, organization's OpenAI credentials), strict JSON parsing |
| `src/whatsapp/whatsapp-sender.service.ts` | `downloadMedia` (validated), `uploadMedia`, `sendAudio` |
| `src/sarvam/sarvam.service.ts` | `speechBytes`: Sarvam `POST /text-to-speech/stream` with `output_audio_codec: mp3`; MP3 verified |
| `src/workers/whatsapp-message.processor.ts` | Wires it into the existing queue worker |
| `src/webhooks/whatsapp.service.ts` | Reads `image` / `document` / caption / MIME from the webhook |
| `apps/web/src/components/conversation.tsx` | Inbox badges: voice note, image (kind, confidence), document, AI voice reply |

## Limits and safety

- Allowed MIME: audio `ogg, opus, mpeg, mp4, aac, amr, wav`; images `jpeg, png, webp`. Sizes: audio 16 MB, images 5 MB
  (`WHATSAPP_MAX_AUDIO_BYTES`, `WHATSAPP_MAX_IMAGE_BYTES`). Checked on Meta's metadata before download and on the bytes.
- Voice notes up to `WHATSAPP_MAX_VOICE_SECONDS` (180). Sarvam REST STT takes 30 s per request, hence the pieces.
- Media bytes are never stored. Conversion files exist in a private temp directory only while ffmpeg runs.
- Tenant isolation: the worker runs in the organization's provider scope (its own WhatsApp / OpenAI / Sarvam
  credentials), the catalogue hint is that organization's products only, messages are saved in its conversation.
- Consent: replies follow the existing WhatsApp rules (customer-initiated, 24 h window; STOP respected).
- No fabricated audio: a TTS error, rate limit or non-MP3 answer sends nothing extra; the text reply already went.
- An image never confirms a payment or authenticity.

## Configuration

`VISION_PROVIDER` (`openai` | `none`), `VISION_MODEL`, `VISION_CONFIDENCE_MIN` (0.6), `WHATSAPP_VOICE_REPLIES`
(`false`), `WHATSAPP_MAX_VOICE_SECONDS` (180), `FFMPEG_PATH` / `FFPROBE_PATH`. `npm run check:config` lists them.
Production host: `sudo apt-get install -y ffmpeg` (check: `ffmpeg -version`).

## Tests

- `test/whatsapp-multimodal.integration.spec.ts` (real worker, real GR ordering engine, real MySQL; Meta media, Sarvam
  and the vision model faked, with a real OGG/Opus file made by ffmpeg): Tamil voice price from the DB; a Tanglish voice
  order completed by voice and saved (₹440); unclear speech; refused media; order screenshot; unknown food not
  invented; low confidence; payment screenshot to staff; vision not configured; document; voice reply only with real
  audio; duplicate processing.
- `src/media/multimodal.spec.ts`: ffmpeg conversion / segmentation / too long / no ffmpeg; vision request shape and
  parsing; Sarvam stream TTS request and failure modes; WhatsApp media upload + audio send request shape, DRY_RUN block.
- `src/whatsapp/media-validation.spec.ts`; UI `apps/web/tests/ui-multimodal.py` (inbox badges).

## Not verified here (needs production credentials and approval)

Real inbound voice note / image from a phone, real Sarvam STT/TTS, a real OpenAI vision call, and a real audio reply
delivered by WhatsApp. Run them once deployed: send a Tamil voice note and an order screenshot to the GR Chicken number
from an approved test phone, with `DRY_RUN=false` for that test only.

## Pending

Document text extraction (PDF), image storage for staff viewing (deliberately not stored today), other vision
providers, per-organization voice-reply setting in the dashboard (environment switch today).
