/**
 * End-to-end check of the REAL-TIME call mode (VOICE_MODE=stream) on the compiled build:
 * real HTTP server, real WebSocket, real conversation engine, real MariaDB + Redis.
 * Only the providers are fake, at their network boundary: Plivo (dial / hang up + the audio stream client),
 * Sarvam (STT returns the scripted line for each utterance; TTS returns a real 8 kHz WAV), OpenAI.
 *
 *   npm run build -w apps/api && TEST_DB_NAME=tacksharp_test node test/e2e-stream.mjs
 *
 * What it cannot tell you: real audio quality, real STT accuracy, real network latency. Timings printed here
 * are this server's own processing time only.
 */
import { createHmac } from 'node:crypto';

const PORT = 3110;
Object.assign(process.env, {
  DB_NAME: process.env.TEST_DB_NAME ?? 'tacksharp_test', DB_HOST: '127.0.0.1', REDIS_HOST: '127.0.0.1',
  PORT: String(PORT), PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  OPENAI_BASE_URL: 'http://fake-llm.test/v1', OPENAI_API_KEY: 'fake', OPENAI_REASONING_EFFORT: 'off',
  SARVAM_API_KEY: 'fake', PLIVO_AUTH_ID: 'fake', PLIVO_AUTH_TOKEN: 'fake-plivo-token', PLIVO_FROM_NUMBER: '914400000000',
  WHATSAPP_ACCESS_TOKEN: 'fake', WHATSAPP_PHONE_NUMBER_ID: 'pn1', META_PAGE_ACCESS_TOKEN: 'fake',
  FOLLOWUP_TIME_SCALE: '1000', AUTH_SECRET: 'e2e-auth-secret-0123456789abcdef0123', META_APP_SECRET: 'e2e-meta-app-secret',
  PLIVO_VALIDATE_SIGNATURE: 'true', VOICE_CALL_WINDOW_START: '0', VOICE_CALL_WINDOW_END: '24', VOICE_AUDIO_DIR: '/tmp/tacksharp-e2e-stream-audio',
  VOICE_MODE: 'stream', VOICE_END_SILENCE_MS: '700', VOICE_BARGE_IN_MS: '400', VOICE_FILLER_AFTER_MS: '1200',
});

// The app logs one JSON line per event; keep voice.turn lines to read each turn's own reply language and timings.
const turnLogs = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const text = chunk.toString();
  for (const line of text.split('\n')) if (line.includes('"event":"voice.turn"')) try { turnLogs.push(JSON.parse(line)); } catch {}
  if (process.env.E2E_VERBOSE || !text.startsWith('{"ts"')) return origWrite(chunk, ...rest);
  return true;
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// ---------- audio helpers (same maths as src/voice/stream/audio.ts, written independently) ----------
const toneWav = (ms, rate = 8000) => {
  const n = Math.round((ms / 1000) * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(5000 * Math.sin((2 * Math.PI * 300 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};
const mulaw = (s) => {
  const BIAS = 0x84; let v = Math.max(-32635, Math.min(32635, s)); const sign = v < 0 ? 0x80 : 0; if (sign) v = -v; v += BIAS;
  let e = 7; for (let m = 0x4000; (v & m) === 0 && e > 0; m >>= 1) e--; return ~(sign | (e << 4) | ((v >> (e + 3)) & 0x0f)) & 0xff;
};
/** Caller audio as 20 ms μ-law frames: 200 ms quiet, `ms` of speech, then `tail` ms quiet. */
const callerFrames = (ms, tail = 900, amp = 6000) => {
  const total = Math.round(((200 + ms + tail) / 1000) * 8000);
  const buf = Buffer.alloc(total);
  for (let i = 0; i < total; i++) {
    const t = i / 8000;
    const speaking = t >= 0.2 && t < 0.2 + ms / 1000;
    buf[i] = mulaw(speaking ? Math.round(amp * Math.sin(2 * Math.PI * 180 * t)) : Math.round((Math.random() * 2 - 1) * 40));
  }
  const frames = [];
  for (let i = 0; i < buf.length; i += 160) frames.push(buf.subarray(i, i + 160));
  return frames;
};

// ---------- fake providers ----------
const sttQueue = [];
const log = { stt: [], tts: [], llm: [], hangups: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.host === 'fake-llm.test') {
    const body = JSON.parse(init.body);
    log.llm.push(body.messages.length);
    return json({ id: 'c', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Sure, it has covered parking.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }
  if (url.host === 'api.sarvam.ai' && url.pathname === '/speech-to-text') {
    const bytes = Buffer.from(await init.body.get('file').arrayBuffer());
    const transcript = sttQueue.shift() ?? '';
    log.stt.push({ bytes, transcript, riff: bytes.toString('ascii', 0, 4) });
    return json({ transcript, language_code: /[஀-௿]/.test(transcript) ? 'ta-IN' : 'en-IN' });
  }
  if (url.host === 'api.sarvam.ai' && url.pathname === '/text-to-speech') {
    const body = JSON.parse(init.body);
    log.tts.push({ text: body.text, language: body.language_code });
    return json({ audios: [toneWav(Math.min(2500, 40 * body.text.length)).toString('base64')] });
  }
  return realFetch(input, init);
};

// ---------- app ----------
const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('../dist/app.module.js');
const { VoiceService } = await import('../dist/voice/voice.service.js');
const { PrismaService } = await import('../dist/prisma/prisma.service.js');
const { configureApp } = await import('../dist/bootstrap.js');
const { WebSocket } = await import('ws');
const app = configureApp(await NestFactory.create(AppModule, { rawBody: true, logger: ['error'] }));
await app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
const prisma = app.get(PrismaService);

function plivoSign(fullUrl, params, nonce) {
  const u = new URL(fullUrl);
  const q = [...u.searchParams.entries()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const query = q.map(([k, v]) => `${k}=${v}`).join('&');
  const empty = Object.keys(params).length === 0;
  let b = `${u.protocol}//${u.host}${u.pathname}`;
  if (query.length > 0 || !empty) b += `?${query}`;
  if (query.length > 0 && !empty) b += '.';
  b += Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha256', process.env.PLIVO_AUTH_TOKEN).update(`${b}.${nonce}`).digest('base64');
}
let cookie = '';
const post = async (path, body, form = false) => {
  const headers = { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
  if (form) {
    const nonce = Math.random().toString(36).slice(2);
    headers['x-plivo-signature-v3-nonce'] = nonce;
    headers['x-plivo-signature-v3'] = plivoSign(`${base}${path}`, body, nonce);
  }
  if (cookie) headers.cookie = cookie;
  return realFetch(`${base}${path}`, { method: 'POST', headers, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
};
{
  const ok = await post('/auth/login', { email: 'owner@tacksharp.test', password: 'correct-horse-battery' });
  cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
}

// Fake Plivo REST: dialing answers the call at once; hang-up is recorded and reported like Plivo would.
let answered;
const answeredOnce = new Promise((r) => (answered = r));
app.get(VoiceService).client = {
  calls: {
    create: async (from, to, answerUrl, opts) => {
      setTimeout(async () => {
        const u = new URL(answerUrl);
        const xml = await (await post(u.pathname + u.search, { CallUUID: 'plv-stream-1', From: from, To: to, Direction: 'outbound' }, true)).text();
        answered({ xml, hangupUrl: opts.hangupUrl });
      }, 50);
      return { requestUuid: 'req-1' };
    },
    hangup: async (uuid) => { log.hangups.push(uuid); return {}; },
  },
};

// ---------- the call ----------
const lead = await (await post('/webhooks/meta/leads/test', { name: 'Stream Test', phone: '9000077777', location: 'Porur', budget: '80 lakhs', bhk: '2' })).json();
const leadRow = await prisma.lead.findUnique({ where: { id: lead.leadId ?? lead.lead?.id ?? '' } }).catch(() => null)
  ?? await prisma.lead.findFirst({ where: { customer: { phone: '919000077777' } }, orderBy: { createdAt: 'desc' } });
const started = await (await post('/voice/call', { leadId: leadRow.id, ignoreCallWindow: true })).json();
if (!started.started) { console.log('call not started', JSON.stringify(started)); process.exit(1); }
const { xml, hangupUrl } = await answeredOnce;
const wsUrl = xml.match(/<Stream[^>]*>([^<]+)<\/Stream>/)?.[1]?.replace(/&amp;/g, '&');
check('ST1. Answer returns <Stream bidirectional, μ-law 8 kHz> with a per-call token (no <Record>)',
  Boolean(wsUrl) && /bidirectional="true"/.test(xml) && /audio\/x-mulaw;rate=8000/.test(xml) && !/<Record/.test(xml), wsUrl);

{ // a stream URL with a wrong token is refused before any audio flows
  const bad = new WebSocket(wsUrl.replace(/token=[^&]+/, 'token=forged'));
  const outcome = await new Promise((r) => { bad.on('open', () => r('open')); bad.on('error', () => r('refused')); bad.on('unexpected-response', (_q, res) => r(`http_${res.statusCode}`)); });
  check('ST2. Forged stream token → refused', outcome !== 'open', outcome);
}

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
const inbox = [];
let waiter = null;
const trace = [];
ws.on('message', (d) => { const m = JSON.parse(d.toString()); m.at = performance.now(); trace.push(`${m.event}${m.name ? ':' + m.name : ''}`); inbox.push(m); waiter?.(); });
const next = (pred, ms = 6000) => new Promise((resolve) => {
  const t0 = Date.now();
  let done = false;
  let timer;
  const finish = (v) => { done = true; clearTimeout(timer); if (waiter === tick) waiter = null; resolve(v); };
  const tick = () => {
    if (done) return;
    const i = inbox.findIndex(pred);
    if (i >= 0) return finish(inbox.splice(i, 1)[0]);
    if (Date.now() - t0 > ms) return finish(null);
    waiter = tick;
    clearTimeout(timer);
    timer = setTimeout(tick, 50);
  };
  tick();
});
const send = (m) => ws.send(JSON.stringify(m));
send({ event: 'start', sequenceNumber: 0, start: { callId: 'plv-stream-1', streamId: 'stream-1', accountId: 'acc', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } } });

const opening = await next((m) => m.event === 'checkpoint');
const openingAudio = inbox.filter((m) => m.event === 'playAudio');
check('ST3. Opening line plays over the stream right after start (μ-law 8 kHz, then a checkpoint)',
  opening?.name === 'opening' && openingAudio.length > 0 && openingAudio.every((m) => m.media.contentType === 'audio/x-mulaw' && m.media.sampleRate === 8000));
inbox.length = 0;
send({ event: 'playedStream', streamId: 'stream-1', name: 'opening' });

/** Customer says one line: audio frames go in, we wait for the reply's audio + checkpoint, then (normally) confirm playback. */
async function say(line, { ms = 900, amp = 6000, confirm = true } = {}) {
  sttQueue.push(line);
  const llmBefore = log.llm.length, logsBefore = turnLogs.length;
  const frames = callerFrames(ms, 900, amp);
  let lastFrameAt = 0;
  let cleared = null;
  for (const f of frames) {
    send({ event: 'media', streamId: 'stream-1', media: { track: 'inbound', payload: f.toString('base64') } });
    lastFrameAt = performance.now();
    if (!cleared) { await sleep(0); cleared = inbox.find((m) => m.event === 'clearAudio') ?? null; }
  }
  if (!cleared) cleared = inbox.find((m) => m.event === 'clearAudio') ?? null;
  inbox.splice(0, inbox.length, ...inbox.filter((m) => m.event !== 'clearAudio'));
  const firstAudio = await next((m) => m.event === 'playAudio', 8000);
  const cp = await next((m) => m.event === 'checkpoint', 8000);
  inbox.splice(0, inbox.length, ...inbox.filter((m) => m.event !== 'playAudio'));
  for (let i = 0; i < 40 && turnLogs.length === logsBefore; i++) await sleep(25);
  const turnLog = turnLogs.slice(logsBefore).at(-1);
  if (cp && confirm) send({ event: 'playedStream', streamId: 'stream-1', name: cp.name });
  await sleep(30);
  return { line, checkpoint: cp?.name, gotAudio: Boolean(firstAudio), firstAudioMs: firstAudio ? turnLog?.firstAudioMs ?? null : null, lang: turnLog?.ttsLanguage, turnLog, cleared, llm: log.llm.length - llmBefore };
}

const custId = (await prisma.lead.findUnique({ where: { id: leadRow.id } })).customerId;
const visits = () => prisma.siteVisit.count({ where: { customerId: custId } });
const day = (() => { const d = new Date(Date.now() + 5.5 * 3600e3 + 4 * 86400e3); return d.toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'long' }); })();
const turns = [];
turns.push(await say('வணக்கம், பேசலாம்.'));
// The AI's answer to this line is left "playing" (no playedStream): the next line is spoken over it.
turns.push(await say('I need a 2 BHK in Porur.', { confirm: false }));
turns.push(await say('Budget 60 lakhs தான்.', { amp: 9000 })); // barge-in
turns.push(await say('Site visit possible-aa?'));
turns.push(await say(`${day} morning போகலாம்.`));
const visitsBeforeYes = await visits();
const yes = await say('Yes, book it.', { confirm: false });
turns.push(yes);
const visitsAfterYes = await visits();

console.log('\n  turn                                   reply-lang  first-audio(ms, server only)  model  path');
for (const t of turns) console.log(`  ${t.line.padEnd(38)} ${String(t.lang ?? '-').padEnd(11)} ${String(t.firstAudioMs).padEnd(29)} ${String(t.llm).padEnd(6)} ${t.turnLog?.path}`);
console.log('');
check('ST4. Every customer line reached STT as a WAV built from the stream (no recording download)',
  log.stt.length === turns.length && log.stt.every((s) => s.riff === 'RIFF' && s.bytes.length > 44), `${log.stt.length} STT requests`);
check('ST5. Each turn answered with audio over the stream', turns.every((t) => t.firstAudioMs !== null), turns.map((t) => t.firstAudioMs).join(','));
check('ST6. Reply speech language follows the customer, switching inside one call',
  turns.map((t) => t.lang).join(' ') === 'ta-IN en-IN ta-IN ta-IN ta-IN en-IN', turns.map((t) => t.lang ?? '-').join(' → '));
check('ST7. Visit booked only after the explicit "Yes, book it." (same session, all rules, no model)',
  visitsBeforeYes === 0 && visitsAfterYes === 1 && turns.every((t) => t.llm === 0 && t.turnLog?.path === 'rules'), `before=${visitsBeforeYes} after=${visitsAfterYes}`);
check('ST8. Server processing per turn (end of speech detected → first audio sent) < 300 ms with fake providers',
  turns.every((t) => t.firstAudioMs < 300), `${Math.max(...turns.map((t) => t.firstAudioMs))} ms max`);
check('ST9. Barge-in: customer talks over the AI → clearAudio at once, and that line is still answered',
  turns[2].cleared?.streamId === 'stream-1' && turns[2].firstAudioMs !== null);
check('ST10. Booking turn ends the call: goodbye audio + "end" checkpoint', yes.checkpoint === 'end');
await sleep(200);
check('ST11. No hang-up before Plivo confirms the goodbye has played', log.hangups.length === 0);
send({ event: 'playedStream', streamId: 'stream-1', name: 'end' });
await sleep(300);
check('ST12. After playback confirmed → hung up through Plivo REST with the call UUID', log.hangups[0] === 'plv-stream-1', JSON.stringify(log.hangups));

{ // Latency per stage from the server's own voice.turn lines (fake providers: STT/TTS times are NOT real Sarvam times)
  const stream = turnLogs.filter((l) => l.mode === 'stream');
  const stat = (key) => {
    const v = stream.map((l) => l[key]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    if (!v.length) return '-';
    const p = (q) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
    return `p50 ${p(0.5)} / p95 ${p(0.95)} / max ${v.at(-1)} ms (n=${v.length})`;
  };
  console.log('\n  LATENCY (server-side, fake providers)');
  for (const k of ['stt', 'ai', 'tts', 'firstAudioMs', 'totalMs']) console.log(`    ${k.padEnd(13)} ${stat(k)}`);
  console.log('');
  const rules = stream.filter((l) => l.path === 'rules');
  check('ST15. No filler on any rule-answered turn', rules.length > 0 && rules.every((l) => l.filler === false), `${rules.length} rule turns`);
  check('ST16. Decision time on rule turns < 100 ms (p95)', (() => { const v = rules.map((l) => l.ai).sort((a, b) => a - b); return v[Math.ceil(0.95 * v.length) - 1] < 100; })());
}

const h = new URL(hangupUrl);
await post(h.pathname + h.search, { CallUUID: 'plv-stream-1', CallStatus: 'completed', HangupCauseName: 'Normal Hangup', Duration: '70', BillDuration: '70' }, true);
ws.close();
const callRow = await (async () => { for (let i = 0; i < 40; i++) { const c = await prisma.call.findUnique({ where: { id: started.callId } }); if (c?.endedAt) return c; await sleep(150); } return null; })();
check('ST13. Hang-up webhook closes the call row as before (outcome, turns, duration)', Boolean(callRow?.endedAt) && callRow.turns >= 6 && callRow.outcome === 'site_visit_booked', `outcome=${callRow?.outcome} turns=${callRow?.turns}`);
const msgs = await prisma.message.findMany({ where: { metadata: { path: '$.callId', equals: started.callId } } }).catch(() => []);
check('ST14. Transcript saved with the call id (dashboard call review works in stream mode)', msgs.length >= 12, `${msgs.length} messages`);

await app.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log('NOTE: providers are fakes. Real Plivo stream behaviour, Saaras accuracy, Bulbul audio and network latency: NOT VERIFIED — EXTERNAL SERVICE REQUIRED.');
process.exit(failed ? 1 : 0);
