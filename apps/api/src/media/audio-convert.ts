import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Prepares a WhatsApp voice note for Sarvam's REST speech-to-text, which accepts OGG/Opus, MP3, AAC, AMR, M4A, WAV …
 * but only up to 30 seconds per request (docs.sarvam.ai, speech-to-text overview). With ffmpeg available, the note is
 * converted to 16 kHz mono WAV and cut into ≤ 28 s pieces (transcribed in order and joined). Without ffmpeg the
 * original bytes are used as they are (fine for notes under 30 s; a longer one fails STT and the customer is asked to
 * type). Files live in a private temp directory only while ffmpeg runs, then are deleted.
 */
export const SEGMENT_SECONDS = 28;
export const MAX_VOICE_NOTE_SECONDS = () => Number(process.env.WHATSAPP_MAX_VOICE_SECONDS) || 180;

export type SttPiece = { bytes: Buffer; mimeType: string; filename: string };
export type Prepared = { pieces: SttPiece[]; converted: boolean; durationSec?: number; reason?: string } | { tooLong: true; durationSec: number };

const EXT: Record<string, string> = { 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
export const extFor = (mime: string) => EXT[mime] ?? 'bin';

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function prepareForStt(bytes: Buffer, mimeType: string, opts: { ffmpeg?: string; ffprobe?: string } = {}): Promise<Prepared> {
  const ffmpeg = opts.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const ffprobe = opts.ffprobe ?? process.env.FFPROBE_PATH ?? 'ffprobe';
  const original: SttPiece = { bytes, mimeType, filename: `voice-note.${extFor(mimeType)}` };
  const dir = await mkdtemp(path.join(tmpdir(), 'tacksharp-voice-'));
  try {
    const input = path.join(dir, `in.${extFor(mimeType)}`);
    await writeFile(input, bytes, { mode: 0o600 });
    let durationSec: number | undefined;
    try {
      const probe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input], 10_000);
      const d = Number(probe.stdout.trim());
      if (probe.code === 0 && Number.isFinite(d)) durationSec = Math.round(d * 10) / 10;
    } catch {
      // ffprobe missing: decided by ffmpeg below
    }
    if (durationSec !== undefined && durationSec > MAX_VOICE_NOTE_SECONDS()) return { tooLong: true, durationSec };
    let r;
    try {
      r = await run(ffmpeg, ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', '16000', '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-c:a', 'pcm_s16le', path.join(dir, 'part-%03d.wav')], 60_000);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { pieces: [original], converted: false, durationSec, reason: 'ffmpeg_not_installed' };
      throw e;
    }
    if (r.code !== 0) return { pieces: [original], converted: false, durationSec, reason: `ffmpeg_failed: ${r.stderr.trim().slice(0, 160)}` };
    const parts = (await readdir(dir)).filter((f) => /^part-\d{3}\.wav$/.test(f)).sort();
    if (!parts.length) return { pieces: [original], converted: false, durationSec, reason: 'ffmpeg_no_output' };
    const pieces = await Promise.all(parts.map(async (f) => ({ bytes: await readFile(path.join(dir, f)), mimeType: 'audio/wav', filename: f })));
    return { pieces, converted: true, durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
