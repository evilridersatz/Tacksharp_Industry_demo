# Call and WhatsApp latency: where the time goes and how to cut it

## What was measured (local, October 29, 2026)

A real webhook was posted to the running API with the test database and `DRY_RUN=true`. It went through the queue
and the worker. No AI key or provider was reachable, so this measures **our own code only**.

| Stage | p50 | p95 |
|---|---|---|
| Webhook acknowledged | 23 ms | 30 ms |
| Received → reply ready (rules path, database + queue + engine) | 27 ms | 45 ms |

**Our pipeline adds well under 0.1 s.** A slow reply is spent waiting on providers and on fixed pauses, as follows.

## Where the seconds come from

The costs below are typical ranges for these providers, not measurements from your servers. Your real figures appear in the Response times card once this is deployed.

| Channel | Stage | Typical cost | Controlled by |
|---|---|---|---|
| Voice (record mode, **the current default**) | Waiting for the caller to stop | 2 s of silence on every turn | `VOICE_SILENCE_TIMEOUT` (2) |
| | Plivo uploads the recording, then we download it | 0.3–1.5 s | Record mode only |
| | Speech to text (Sarvam) | 0.5–1.5 s | Sarvam |
| | AI reply (OpenAI) | 1–4 s; reasoning tokens dominate | `OPENAI_VOICE_REASONING_EFFORT` (defaults to `OPENAI_REASONING_EFFORT`, which is `low`) |
| | Text to speech (Sarvam), then Plivo fetches and plays it | 0.5–1.5 s | Sarvam; cached for fixed lines |
| WhatsApp | Meta delivers the webhook | usually < 1 s | Meta |
| | AI reply | 1–6 s with `low` reasoning; tools add round trips | `OPENAI_REASONING_EFFORT`, `OPENAI_MODEL` |
| | Send to Meta | 0.2–0.6 s | Meta |

## What this change does

1. **WhatsApp "read" and "typing…" at once.**
   - The customer sees the blue ticks and a typing indicator the moment we start, instead of silence until the
     reply arrives.
   - It uses Meta's read-status request with `typing_indicator`. It is best effort: it never blocks or retries the
     reply, and it is blocked while `DRY_RUN` is on.
2. **New timings that show where WhatsApp time goes.**
   - Each reply now records **Meta → webhook** delay, **queue wait**, AI time and send time.
   - They appear in the `whatsapp.latency` log line, at `GET /ai/latency`, and in the **Platform console → Service
     health → Response times** card (p50 and p95 per stage, for voice turns as well).
   - A large queue wait means the workers are not running or are overloaded (check `RUN_WORKERS` and the queue
     counts on the same page).
3. **OpenAI client reused** for organizations with their own key. Before this, a new client per turn meant a new TLS
   connection to OpenAI on every reply.

## Server settings that cut the most (apply on staging first)

These settings change call behaviour, so they are switched on the server after a test call. They are not changed
blind in code.

```bash
# 1. Real-time calls. Uses the Plivo audio stream: 0.7 s end-of-speech instead of 2 s silence, no recording
#    download, speech played sentence by sentence, the caller can interrupt.
VOICE_MODE=stream
VOICE_END_SILENCE_MS=700      # raise to 900 if callers get cut off

# 2. Less model "thinking" on calls. Check the value your model accepts first:
npm run verify:live -w apps/api -- --only=ai
OPENAI_VOICE_REASONING_EFFORT=minimal   # gpt-5 / gpt-5-mini; for gpt-5.1+ models use "none"
OPENAI_VOICE_MAX_TOKENS=300

# 3. WhatsApp: the same idea, once verified (replies stay grounded in your records either way).
OPENAI_REASONING_EFFORT=minimal

# 4. If you stay on record mode: end the caller's turn sooner (1 s is snappy; slow speakers may be cut off).
VOICE_SILENCE_TIMEOUT=1
```

Then make a test call and send test messages to an approved number. Compare **Platform console → Service health →
Response times** before and after.
