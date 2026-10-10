import crypto from 'node:crypto';
import { config } from '../common/config.js';

export function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** <Play> the Sarvam audio, or fall back to Plivo's English <Speak> if TTS failed. */
export function sayXml(audioUrl: string, fallbackEnglish: string) {
  if (audioUrl) return `<Play>${escapeXml(audioUrl)}</Play>`;
  return `<Speak voice="WOMAN" language="en-US">${escapeXml(fallbackEnglish)}</Speak>`;
}

/**
 * Records the customer's reply and posts it to /voice/turn.
 * `timeout` = seconds of silence that ends the turn.
 * maxLength stays under Sarvam REST's 30s limit.
 */
export function recordXml(callId: string) {
  const action = `${config.publicBaseUrl}/voice/turn?callId=${encodeURIComponent(callId)}`;
  return `<Record action="${escapeXml(action)}" method="POST" fileFormat="wav" maxLength="${config.plivo.maxTurnSec}" timeout="${config.plivo.silenceTimeoutSec}" playBeep="false" redirect="true" />`;
}

export function response(inner: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${inner}\n</Response>`;
}

export const HANGUP = '<Hangup/>';

/** Per-call token in the stream URL: only a call we answered can open its audio stream. */
export function streamToken(callId: string) {
  return crypto.createHmac('sha256', config.auth.secret).update(`voice-stream:${callId}`).digest('base64url').slice(0, 32);
}

export function validStreamToken(callId: string, token: string | null | undefined) {
  const expected = Buffer.from(streamToken(callId));
  const given = Buffer.from(String(token ?? ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** wss:// URL of the real-time audio stream for one call (same host and path prefix as the webhooks). */
export function streamUrl(callId: string) {
  const base = config.publicBaseUrl.replace(/^http/i, 'ws');
  return `${base}/voice/stream?callId=${encodeURIComponent(callId)}&token=${streamToken(callId)}`;
}

/**
 * Real-time mode: Plivo streams the caller's audio to us and plays what we send back (8 kHz μ-law both ways).
 * keepCallAlive: the call stays up for as long as the stream does; we hang up through the REST API.
 */
export function streamXml(callId: string) {
  return `<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" streamTimeout="${config.plivo.maxCallSec}">${escapeXml(streamUrl(callId))}</Stream>`;
}
