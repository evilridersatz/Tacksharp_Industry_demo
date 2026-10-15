import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../../common/config.js';
import { errorMessage, log } from '../../common/logger.js';
import { AiService } from '../../ai/ai.service.js';
import { SarvamService } from '../../sarvam/sarvam.service.js';
import { VoiceService, type CallRuntime } from '../voice.service.js';
import { FILLERS, PROMPTS } from '../voice.prompts.js';
import { validStreamToken } from '../plivo-xml.js';
import { wavToPhoneMulaw } from './audio.js';
import { DEFAULT_ENDPOINTER } from './endpointer.js';
import { DEFAULT_STREAM, StreamCall, type StreamDeps, type StreamOptions } from './stream-call.js';

export const STREAM_PATH = '/voice/stream';

/**
 * WebSocket endpoint Plivo connects to in real-time mode (VOICE_MODE=stream): wss://<PUBLIC_BASE_URL>/voice/stream.
 * Each connection is one live call; a per-call HMAC token in the URL keeps anyone else out.
 */
@Injectable()
export class VoiceStreamService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly live = new Set<StreamCall>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly voice: VoiceService,
    private readonly sarvam: SarvamService,
    private readonly ai: AiService,
  ) {}

  onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter?.getHttpServer?.() as { on?: (e: string, fn: (...a: unknown[]) => void) => void } | undefined;
    if (!server?.on) return;
    server.on('upgrade', (req: unknown, socket: unknown, head: unknown) => this.upgrade(req as IncomingMessage, socket as Duplex, head as Buffer));
    log.info('voice.stream_ready', { path: STREAM_PATH, mode: config.voice.mode });
  }

  onModuleDestroy() {
    for (const call of this.live) call.close('shutdown');
    this.wss.close();
  }

  get activeCalls() {
    return this.live.size;
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== STREAM_PATH) return; // not ours
    const callId = url.searchParams.get('callId') ?? '';
    if (!callId || !validStreamToken(callId, url.searchParams.get('token'))) {
      log.warn('voice.stream_rejected', { reason: 'bad_token' });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => void this.connect(ws, callId));
  }

  private async connect(ws: WebSocket, callId: string) {
    const rt = await this.voice.streamRuntime(callId).catch(() => undefined);
    if (!rt) {
      log.warn('voice.stream_unknown_call', { callId });
      ws.close(1008, 'unknown call');
      return;
    }
    const send = (message: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const call = new StreamCall(callId, send, this.deps(rt), streamOptions(), rt.openingUrl, rt.openingText);
    this.live.add(call);
    ws.on('message', (data) => void call.onMessage(data as Buffer).catch((error) => log.error('voice.stream_message_failed', { callId, error: errorMessage(error) })));
    ws.on('close', () => {
      call.close('socket_closed');
      this.live.delete(call);
    });
    ws.on('error', (error) => log.warn('voice.stream_socket_error', { callId, error: errorMessage(error) }));
  }

  private deps(rt: CallRuntime): StreamDeps {
    const toPhone = async (url: string | undefined | null) => {
      if (!url) return null;
      const wav = await this.sarvam.audioBytes(url);
      if (!wav) return null;
      try {
        return wavToPhoneMulaw(wav);
      } catch (error) {
        log.error('voice.stream_audio_unreadable', { callId: rt.callId, error: errorMessage(error) });
        return null;
      }
    };
    return {
      transcribe: (wav) => this.sarvam.speechToText(wav, 'turn.wav', 'audio/wav', rt.keyterms),
      understand: (transcript, sttLanguage, durationMs) => this.voice.withCallLock(rt.callId, () => this.voice.understand(rt, transcript, sttLanguage, durationMs)),
      speak: async (text, cache) => {
        const tts = await this.voice.speakForStream(rt, text, cache);
        return { audio: await toPhone(tts.url), languageCode: tts.languageCode, cached: tts.cached, attempts: tts.attempts, error: tts.error };
      },
      audioForUrl: toPhone,
      ttsFailed: async (decided, error, attempts) => {
        const fb = await this.voice.ttsFailed(rt, decided, error, attempts, 'stream');
        return { audio: await toPhone(fb.url), fallback: fb.fallback };
      },
      markReplyNotHeard: () => void this.ai.markReplyNotHeard(rt.sessionKey),
      logTurn: (decided, timings, tts) => this.voice.logTurn(rt, decided, timings, tts as Parameters<VoiceService['logTurn']>[3]),
      hangup: (reason) => this.voice.hangupLive(rt, reason),
      filler: async (english, variant) => {
        const lines = english ? FILLERS.en : FILLERS.ta;
        return toPhone((await this.sarvam.textToSpeech(lines[variant % lines.length], { cache: true })).url);
      },
      isEnglish: () => rt.english,
      isCachedLine: (text) => this.voice.isStaticLine(text),
      onStart: ({ providerCallId }) => {
        if (providerCallId && !rt.providerCallId) rt.providerCallId = providerCallId;
      },
    };
  }
}

export function streamOptions(): StreamOptions {
  return {
    ...DEFAULT_STREAM,
    bargeInMs: config.voice.bargeInMs,
    fillerAfterMs: config.voice.fillerAfterMs,
    noResponseMs: config.voice.noResponseMs,
    endpointer: { ...DEFAULT_ENDPOINTER, endSilenceMs: config.voice.streamEndSilenceMs, minLevel: config.voice.streamMinLevel },
  };
}
