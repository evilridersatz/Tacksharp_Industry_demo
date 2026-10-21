/**
 * Audio helpers for the real-time call stream. Plivo streams 8 kHz G.711 μ-law both ways; Sarvam STT wants a WAV
 * file and Sarvam TTS returns one. Everything here is pure and unit-tested.
 */

export const STREAM_RATE = 8000;
/** 20 ms of 8 kHz audio. */
export const FRAME_SAMPLES = 160;

const BIAS = 0x84;
const CLIP = 32635;

/** One 16-bit PCM sample -> one μ-law byte (ITU-T G.711). */
export function linearToMulaw(sample: number): number {
  let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const MULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    t[i] = sign ? -magnitude : magnitude;
  }
  return t;
})();

export function mulawToLinear(byte: number): number {
  return MULAW_TABLE[byte & 0xff];
}

export function decodeMulaw(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_TABLE[bytes[i]];
  return out;
}

export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}

/** Mono 16-bit PCM WAV file (what Sarvam STT accepts). */
export function pcmToWav(pcm: Int16Array, sampleRate = STREAM_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Reads a PCM WAV (Sarvam TTS output): walks the chunks instead of assuming a 44-byte header, mixes stereo down,
 * and accepts 16-bit PCM and 8-bit μ-law. Throws on anything else so a bad file is noticed, not played as noise.
 */
export function parseWav(file: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (file.length < 12 || file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  let format = 0;
  let channels = 1;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    let size = file.readUInt32LE(offset + 4);
    const start = offset + 8;
    // Streaming encoders sometimes write 0 / 0xFFFFFFFF for the data size: take the rest of the file.
    if (id === 'data' && (size === 0 || size === 0xffffffff || start + size > file.length)) size = file.length - start;
    if (id === 'fmt ') {
      format = file.readUInt16LE(start);
      channels = file.readUInt16LE(start + 2);
      sampleRate = file.readUInt32LE(start + 4);
      bits = file.readUInt16LE(start + 14);
      if (format === 0xfffe && size >= 26) format = file.readUInt16LE(start + 24); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      data = file.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data || !sampleRate) throw new Error('WAV has no fmt/data chunk');
  let mono: Int16Array;
  if (format === 1 && bits === 16) {
    const frames = Math.floor(data.length / (2 * channels));
    mono = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
      mono[i] = Math.round(sum / channels);
    }
  } else if (format === 7 && bits === 8) {
    const frames = Math.floor(data.length / channels);
    mono = new Int16Array(frames);
    for (let i = 0; i < frames; i++) mono[i] = mulawToLinear(data[i * channels]);
  } else {
    throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
  }
  return { pcm: mono, sampleRate };
}

/** Linear-interpolation resampling (speech only; good enough for 16/22/24 kHz TTS down to the 8 kHz phone line). */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || pcm.length === 0) return pcm;
  const outLength = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Int16Array(outLength);
  const ratio = from / to;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    const f = pos - i0;
    out[i] = Math.round(pcm[Math.min(i0, pcm.length - 1)] * (1 - f) + pcm[i1] * f);
  }
  return out;
}

/** A Sarvam WAV as phone-line μ-law, ready for Plivo playAudio. */
export function wavToPhoneMulaw(file: Buffer): Buffer {
  const { pcm, sampleRate } = parseWav(file);
  return encodeMulaw(resample(pcm, sampleRate, STREAM_RATE));
}

/** Root-mean-square level of one frame (0..32768). */
export function rms(pcm: Int16Array, start = 0, end = pcm.length): number {
  let sum = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / n);
}

/** Milliseconds of audio in a μ-law buffer at 8 kHz. */
export const mulawMs = (bytes: number) => Math.round((bytes / STREAM_RATE) * 1000);
