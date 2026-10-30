import { createHash } from 'node:crypto';

/**
 * Knowledge-base text handling: file validation, text extraction (PDF / DOCX / TXT / CSV), prompt-injection
 * neutralisation, chunking and BM25 retrieval. No vector database and no paid embeddings: retrieval is lexical
 * (BM25 over the tenant's own chunks), which works for Tamil script, Tanglish and English alike and costs nothing.
 */

export const KB_KINDS = ['pdf', 'docx', 'txt', 'csv'] as const;
export type KbKind = (typeof KB_KINDS)[number];
export const KB_MAX_FILE_BYTES = Number(process.env.KB_MAX_FILE_MB || 10) * 1024 * 1024;
export const KB_MAX_DOCS_PER_BASE = Number(process.env.KB_MAX_DOCS || 50);
export const KB_MAX_CHARS_PER_DOC = 400_000;
const KB_MAX_EXPANDED_BYTES = 60 * 1024 * 1024;

export class KbFileError extends Error {}

/** Decides the file kind from its name AND its bytes (a renamed executable is never accepted as a PDF). */
export function detectKind(filename: string, bytes: Buffer): KbKind {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (!bytes.length) throw new KbFileError('The file is empty.');
  if (bytes.length > KB_MAX_FILE_BYTES) throw new KbFileError(`Files can be at most ${Math.round(KB_MAX_FILE_BYTES / 1048576)} MB.`);
  const head = bytes.subarray(0, 8);
  if (ext === 'pdf') {
    if (head.subarray(0, 5).toString('latin1') !== '%PDF-') throw new KbFileError('This is not a valid PDF file.');
    return 'pdf';
  }
  if (ext === 'docx') {
    if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) throw new KbFileError('This is not a valid Word (.docx) file.');
    return 'docx';
  }
  if (ext === 'txt' || ext === 'md' || ext === 'csv') {
    if (bytes.includes(0)) throw new KbFileError('Text files must not contain binary data.');
    const text = bytes.toString('utf8');
    if (text.includes('�') && (text.match(/�/g)?.length ?? 0) > 20) throw new KbFileError('Save the file as UTF-8 text and upload it again.');
    return ext === 'csv' ? 'csv' : 'txt';
  }
  throw new KbFileError('Upload a PDF, Word (.docx), text (.txt) or CSV file.');
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export type Section = { text: string; source: string };

export async function extractSections(kind: KbKind, bytes: Buffer): Promise<Section[]> {
  switch (kind) {
    case 'pdf': {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: false });
      const pages = Array.isArray(text) ? text : [text];
      return pages.map((t, i) => ({ text: t, source: `page ${i + 1}` }));
    }
    case 'docx': {
      // Zip-bomb guard: refuse archives that expand far beyond a real document before parsing them.
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(bytes);
      let expanded = 0;
      zip.forEach((_p, f) => { expanded += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0; });
      if (expanded > KB_MAX_EXPANDED_BYTES) throw new KbFileError('This Word file expands to an unreasonable size and was refused.');
      const mammoth = (await import('mammoth')).default;
      const r = await mammoth.extractRawText({ buffer: bytes });
      return [{ text: r.value, source: 'document' }];
    }
    case 'csv': {
      const rows = parseCsv(bytes.toString('utf8'));
      if (!rows.length) return [];
      const [header, ...body] = rows;
      // Each row becomes a readable line "Column: value; Column: value" so retrieval and the model see labelled facts.
      return body
        .filter((r) => r.some((c) => c.trim()))
        .map((r, i) => ({ text: r.map((c, j) => `${(header[j] ?? `Column ${j + 1}`).trim()}: ${c.trim()}`).filter((x) => !x.endsWith(': ')).join('; '), source: `row ${i + 2}` }));
    }
    case 'txt':
      return [{ text: bytes.toString('utf8'), source: 'document' }];
  }
}

/** RFC 4180-ish CSV (quoted fields, escaped quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0]?.trim());
}

/**
 * Uploaded documents are DATA, never instructions. Lines that try to talk to the AI ("ignore previous instructions",
 * "you are now...", "system:", tool / role markup) are neutralised before indexing and counted, and the model is also
 * told to treat every excerpt as untrusted reference text (see agent-engine). Ordinary business text is untouched.
 */
const INJECTION = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your|the)\b.{0,30}\b(instructions?|rules?|prompts?|guidelines?|directions?)\b/i,
  /\byou are now\b|\bact as (an?|the)\b|\bpretend (to be|you are)\b|\bnew (instructions|persona|role)\b/i,
  /^\s*(system|assistant|developer)\s*[:>]/i,
  /<\/?(system|assistant|instructions?|tool|im_start|im_end)[^>]*>/i,
  /\b(reveal|print|show|repeat)\b.{0,30}\b(system prompt|instructions|api key|password|secret)\b/i,
  /\b(call|transfer|send|pay|refund)\b.{0,40}\b(immediately|without (asking|confirmation))\b/i,
];

export function neutralise(text: string): { text: string; flagged: number } {
  let flagged = 0;
  const out = text.split(/\r?\n/).map((line) => {
    if (INJECTION.some((r) => r.test(line))) {
      flagged++;
      return '[removed: a line that looked like an instruction to the assistant]';
    }
    return line;
  });
  return { text: out.join('\n'), flagged };
}

export function cleanText(t: string): string {
  return t
    .replace(/\u0000/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits sections into ~700-character chunks on paragraph / sentence boundaries with a small overlap, keeping the
 * source label (page / row) on every chunk for attribution.
 */
export function chunkSections(sections: Section[], size = 700, overlap = 120): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    const text = cleanText(s.text);
    if (!text) continue;
    if (text.length <= size) { out.push({ text, source: s.source }); continue; }
    const sentences = text.split(/(?<=[.!?।\n])\s+/);
    let cur = '';
    for (const sentence of sentences) {
      const parts = sentence.length > size ? sentence.match(new RegExp(`.{1,${size}}`, 'gs')) ?? [sentence] : [sentence];
      for (const p of parts) {
        if (cur && (cur + ' ' + p).length > size) {
          out.push({ text: cur.trim(), source: s.source });
          cur = cur.slice(Math.max(0, cur.length - overlap)) + ' ' + p;
        } else cur = cur ? `${cur} ${p}` : p;
      }
    }
    if (cur.trim()) out.push({ text: cur.trim(), source: s.source });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- retrieval

const STOP = new Set('a an the and or of to in on for is are was were be been it this that with as at by from what which who how when where do does did can could would should i you we they he she me my your our their about any have has had will shall not no yes please tell'.split(' '));

/** Lower-cased word tokens; Tamil script kept whole (Unicode letters + combining marks). */
export function tokens(text: string): string[] {
  return (text.toLowerCase().normalize('NFC').match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
}

/** Light English stemming (plural / -ing / -ed) so "deliveries" finds "delivery". */
function stem(t: string): string {
  if (!/^[a-z]+$/.test(t) || t.length < 5) return t;
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.endsWith('ing')) return t.slice(0, -3);
  if (t.endsWith('ed')) return t.slice(0, -2);
  if (t.endsWith('es') && /(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export type Scored<T> = T & { score: number };

/** Okapi BM25 over the given chunks (the caller passes ONLY the tenant's own knowledge base). */
export function bm25<T extends { text: string }>(query: string, chunks: T[], k = 4, minScore = 1e-6): Scored<T>[] {
  const q = [...new Set(tokens(query))];
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => tokens(c.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const k1 = 1.4;
  const b = 0.75;
  return chunks
    .map((c, i) => {
      const d = docs[i];
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
      }
      return { ...c, score };
    })
    .filter((c) => c.score >= minScore)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}
