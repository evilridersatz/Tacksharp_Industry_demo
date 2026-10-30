/**
 * Browser voice helpers shared by Tara (website assistant) and the agent consoles (demos, Agent Builder test):
 * 16 kHz WAV encoding for speech recognition, WAV -> PCM for the video presenter, and sentence splitting so the
 * first sentence plays while the rest is synthesised.
 */
/** PCM16 samples of a WAV file (the "data" chunk), for the video presenter's lip-sync. */
export function wavPcm(bytes: Uint8Array): Uint8Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const size = v.getUint32(o + 4, true);
    if (id === 'data') return bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + size));
    o += 8 + size + (size % 2);
  }
  return bytes.subarray(44);
}

/** Split a reply into speakable sentences (Tamil, English and mixed) so the first one plays while the rest are made. */
export function sentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?।\n]+[.!?।]*\s*/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && (out[out.length - 1].length < 25 || p.length < 12)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out.slice(0, 6);
}

/** 16 kHz mono 16-bit WAV from recorded float samples (what speech recognition expects). */
export function encodeWav(chunks: Float32Array[], inRate: number): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = inRate / 16000;
  const n = Math.floor(all.length / ratio);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (p: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // Average the source samples that fall into this output sample (simple anti-aliasing).
    const a = Math.floor(i * ratio), b = Math.min(all.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const x = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

