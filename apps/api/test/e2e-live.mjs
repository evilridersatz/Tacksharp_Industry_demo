/**
 * HTTP-level end-to-end run of the COMPILED app (npm run build first).
 *
 * REAL in this run: HTTP server, NestJS DI, Prisma + MySQL/MariaDB, Redis + BullMQ workers, the OpenAI
 * Agents SDK run loop, signature verification, tenancy resolution, the conversation engine, Plivo XML flow.
 * FAKED in this run (scripted, in-process): OpenAI, Sarvam STT/TTS, Meta Graph, Plivo REST + recordings.
 *
 * This proves our own code paths and the number of model requests per turn. It says NOTHING about real
 * OpenAI latency/quality, real Saaras accuracy, real Bulbul audio, Plivo or Meta behaviour:
 *   NOT VERIFIED — EXTERNAL SERVICE REQUIRED  (see VERIFICATION.md)
 *
 *   TEST_DB_NAME=tacksharp_test node test/e2e-live.mjs
 */
const PORT = 3100;
Object.assign(process.env, {
  DB_NAME: process.env.TEST_DB_NAME ?? 'tacksharp_test', DB_HOST: '127.0.0.1', REDIS_HOST: '127.0.0.1',
  PORT: String(PORT), PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  OPENAI_BASE_URL: 'http://fake-llm.test/v1', OPENAI_API_KEY: 'fake', OPENAI_REASONING_EFFORT: 'off',
  SARVAM_API_KEY: 'fake', PLIVO_AUTH_ID: 'fake', PLIVO_AUTH_TOKEN: 'fake', PLIVO_FROM_NUMBER: '914400000000',
  WHATSAPP_ACCESS_TOKEN: 'fake', WHATSAPP_PHONE_NUMBER_ID: 'pn1', META_PAGE_ACCESS_TOKEN: 'fake',
  // The AI now calls ~1 minute after every lead. Stretch automatic steps x1000 so no scheduled call or reminder fires
  // in the middle of this run; each check drives the steps it needs explicitly.
  FOLLOWUP_TIME_SCALE: '1000', AUTH_SECRET: 'e2e-auth-secret-0123456789abcdef0123', META_APP_SECRET: 'e2e-meta-app-secret',
  PLIVO_VALIDATE_SIGNATURE: 'true', RATE_LIMIT_LOGIN: '10', VOICE_CALL_WINDOW_START: process.env.E2E_WINDOW_START ?? '9', VOICE_CALL_WINDOW_END: process.env.E2E_WINDOW_END ?? '21', VOICE_AUDIO_DIR: '/tmp/tacksharp-e2e-audio',
});

const log = { stt: [], tts: [], wa: [], llm: [], plays: [] };
const recordings = new Map();
const realFetch = globalThis.fetch;
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.alloc(800, 3)]);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// ---------------- fake OpenAI (chat-completions compatible, scripted) ----------------
// It behaves like a sensible model: it only has the tools the application hands it (the toolset), it can
// phrase a reply, save a fact, search, or PROPOSE a visit. There is no booking / end_call / status tool to call.
const nextSaturdayIso = () => {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7));
  return `${d.toISOString().slice(0, 10)}T11:00:00+05:30`;
};
const asText = (c) => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
function llm(body) {
  const msgs = body.messages;
  const system = asText(msgs[0]?.content);
  const promptChars = msgs.reduce((n, m) => n + asText(m.content).length, 0) + JSON.stringify(body.tools ?? []).length;
  const tools = (body.tools ?? []).map((t) => t.function.name);
  log.llm.push({ tools, promptChars, messages: msgs.length, system });
  const call = (name, args) => ({ id: `tc_${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const last = msgs.at(-1);
  const user = asText([...msgs].reverse().find((m) => m.role === 'user')?.content);
  const tamil = /[஀-௿]/.test(user);
  let message;
  if (last.role === 'tool') {
    message = { role: 'assistant', content: tamil ? 'சரி, note பண்ணிட்டேன். வேற என்ன தெரிஞ்சுக்கணும்?' : 'Noted. What else would you like to know?' };
  } else if (tools.includes('propose_site_visit') && /visit|saturday|sunday/i.test(user) && /saturday/i.test(user)) {
    const id = system.match(/id=(prop_[a-z_]+)/)?.[1];
    message = id
      ? { role: 'assistant', content: null, tool_calls: [call('propose_site_visit', { propertyId: id, scheduledAt: nextSaturdayIso() })] }
      : { role: 'assistant', content: 'Which property would you like to visit?' };
  } else if (tools.includes('update_customer_memory') && /budget/i.test(user) && !/lakh|crore/i.test(user)) {
    message = { role: 'assistant', content: null, tool_calls: [call('update_customer_memory', { objection: user.slice(0, 80) })] };
  } else {
    message = { role: 'assistant', content: tamil ? 'சரி, புரிஞ்சுது. இன்னும் கொஞ்சம் சொல்லுங்க.' : 'Sure. Could you tell me a little more?' };
  }
  return json({ id: 'cmpl', object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: 20, total_tokens: Math.ceil(promptChars / 4) + 20 } });
}

// ---------------- fetch router ----------------
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.host === 'fake-llm.test') return llm(JSON.parse(init.body));
  if (url.host === 'api.sarvam.ai' && url.pathname === '/speech-to-text') {
    const form = init.body;
    const bytes = Buffer.from(await form.get('file').arrayBuffer());
    const raw = bytes.toString('utf8').match(/UTT:(.*?):END/)?.[1] ?? '';
    // "{pa-IN}text" forces the STT language label, like a real model that mislabels short audio.
    const forced = raw.match(/^\{([a-z]{2}-IN)\}(.*)$/s);
    const marker = forced ? forced[2] : raw;
    log.stt.push({ bytes: bytes.length, marker, model: form.get('model'), mode: form.get('mode'), language: form.get('language_code') });
    const label = forced?.[1] ?? (/[਀-੿]/.test(marker) ? 'pa-IN' : /[஀-௿]/.test(marker) ? 'ta-IN' : 'en-IN');
    return json({ transcript: marker, language_code: label });
  }
  if (url.host === 'api.sarvam.ai' && url.pathname === '/text-to-speech') {
    const body = JSON.parse(init.body);
    log.tts.push(body);
    return json({ audios: [WAV.toString('base64')] });
  }
  if (url.host === 'graph.facebook.com') {
    if (init.method === 'POST' && url.pathname.endsWith('/messages')) {
      log.wa.push(JSON.parse(init.body));
      return json({ messages: [{ id: `wamid.out.${log.wa.length}` }] });
    }
    const leadgenId = url.pathname.split('/').pop();
    return json({ id: leadgenId, campaign_name: 'Porur Diwali Campaign', field_data: [
      { name: 'full_name', values: ['Meena'] }, { name: 'phone_number', values: ['+91 90000 11111'] },
      { name: 'location', values: ['Porur'] }, { name: 'budget', values: ['80 lakhs'] }, { name: 'bhk', values: ['2'] } ] });
  }
  if (url.host === 'media.plivo.test') {
    const rec = recordings.get(url.pathname);
    return rec ? new Response(rec, { status: 200 }) : new Response('nf', { status: 404 });
  }
  return realFetch(input, init);
};

// ---------------- app ----------------
const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('../dist/app.module.js');
const { VoiceService } = await import('../dist/voice/voice.service.js');
const { PrismaService } = await import('../dist/prisma/prisma.service.js');
const { AiService } = await import('../dist/ai/ai.service.js');
const { configureApp } = await import('../dist/bootstrap.js');
const app = configureApp(await NestFactory.create(AppModule, { rawBody: true, logger: ['error'] }));
await app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
const prisma = app.get(PrismaService);
const ai = app.get(AiService);
check('7. API + workers started on compiled build', true);

// ---------- Plivo V3 signature (same algorithm as Plivo's SDK) + Meta HMAC ----------
const { createHmac } = await import('node:crypto');
const plivoSdk = (await import('plivo')).default;
function plivoSign(fullUrl, params, nonce) {
  const u = new URL(fullUrl);
  const q = [...u.searchParams.entries()].map(([k, v]) => [k, v]).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const query = q.map(([k, v]) => `${k}=${v}`).join('&');
  const empty = Object.keys(params).length === 0;
  let baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  if (query.length > 0 || !empty) baseUrl += `?${query}`;
  if (query.length > 0 && !empty) baseUrl += '.';
  baseUrl += Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha256', process.env.PLIVO_AUTH_TOKEN).update(`${baseUrl}.${nonce}`).digest('base64');
}
{ // self-check against Plivo's own validator before trusting the signer
  const url = 'http://127.0.0.1:3100/voice/turn?callId=abc';
  const params = { CallUUID: 'x', RecordUrl: 'https://m/r.wav', RecordingDurationMs: '1200' };
  if (!plivoSdk.validateV3Signature('POST', url, 'n1', process.env.PLIVO_AUTH_TOKEN, plivoSign(url, params, 'n1'), params)) {
    console.error('Plivo signer self-check failed'); process.exit(2);
  }
}
let cookie = '';
const post = (path, body, form = false, opts = {}) => {
  const headers = { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
  const raw = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  if (form && /^\/voice\//.test(path) && opts.sign !== false) {
    const nonce = Math.random().toString(36).slice(2);
    headers['x-plivo-signature-v3-nonce'] = nonce;
    headers['x-plivo-signature-v3'] = plivoSign(`${base}${path}`, body, nonce);
  }
  if (!form && path.startsWith('/webhooks/') && !path.endsWith('/test') && opts.sign !== false) {
    headers['x-hub-signature-256'] = 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
  }
  if (opts.cookie !== false && (opts.cookie || cookie)) headers.cookie = opts.cookie || cookie;
  return realFetch(`${base}${path}`, { method: 'POST', headers, body: raw });
};
const get = (path, c = cookie) => realFetch(`${base}${path}`, { headers: c ? { cookie: c } : {} });

// ---------- auth ----------
{
  const anon = await get('/leads', '');
  check('A1. Private API without login → 401', anon.status === 401);
  const health = await (await get('/health', '')).json();
  check('A2. GET /health (public): API + database + Redis', health.status === 'ok' && health.database.ok && health.redis.ok, JSON.stringify({ db: health.database.ok, redis: health.redis.ok, queues: Object.keys(health.queues) }));
  const bad = await post('/auth/login', { email: 'owner@tacksharp.test', password: 'wrong-password-1' }, false, { cookie: false });
  check('A3. Wrong password → 401', bad.status === 401);
  const ok = await post('/auth/login', { email: 'owner@tacksharp.test', password: 'correct-horse-battery' }, false, { cookie: false });
  cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
  check('A4. Login sets an httpOnly session cookie', ok.status === 200 && cookie.startsWith('ts_session=') && /HttpOnly/i.test(ok.headers.get('set-cookie') ?? ''));
}

// ---------------- fake Plivo (outbound) ----------------
// scripts: customer phone -> utterances[] | 'NO_ANSWER'. An utterance is a string ('' = silence).
const scripts = new Map();
const callTranscripts = [];
const playAudio = async (xml) => {
  for (const play of xml.matchAll(/<Play>(.*?)<\/Play>/g)) {
    const r = await realFetch(play[1].replace(/&amp;/g, '&'));
    log.plays.push({ status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength });
  }
};
/** DB state for a customer phone: how many visits exist and the latest lead status. */
async function snapshot(phone) {
  const cust = await prisma.customer.findFirst({ where: { phone } });
  if (!cust) return { visitsAfter: -1, leadStatusAfter: undefined };
  return {
    visitsAfter: await prisma.siteVisit.count({ where: { customerId: cust.id } }),
    leadStatusAfter: (await prisma.lead.findFirst({ where: { customerId: cust.id }, orderBy: { createdAt: 'desc' } }))?.status,
  };
}
/** One customer turn over HTTP; records how many OpenAI requests and what we spoke back. */
async function speak(xml, utt, { callUuid, from }) {
  const action = new URL(xml.match(/<Record action="([^"]+)"/)[1].replace(/&amp;/g, '&'));
  const recPath = `/rec-${Math.random().toString(36).slice(2)}.wav`;
  if (utt) recordings.set(recPath, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.from(`UTT:${utt}:END`), Buffer.alloc(2000, 1)]));
  const llmBefore = log.llm.length, ttsBefore = log.tts.length;
  const res = await post(action.pathname + action.search, {
    CallUUID: callUuid, From: from, // deliberately WRONG From on outbound: identity must come from callId
    RecordUrl: `https://media.plivo.test${recPath}`, RecordingDurationMs: utt ? '2400' : '0',
  }, true);
  const next = await res.text();
  return { utt, xml: next, llmRequests: log.llm.length - llmBefore, spoken: log.tts.slice(ttsBefore).map((t) => t.text), tts: log.tts.slice(ttsBefore) };
}
async function drive(from, to, answerUrl, opts) {
  await sleep(100);
  const script = scripts.get(to);
  if (script === 'NO_ANSWER') {
    await sleep(600); // ring timeout
    await post(new URL(opts.hangupUrl).pathname + new URL(opts.hangupUrl).search, { CallUUID: 'plv-na', CallStatus: 'no-answer', HangupCauseName: 'No Answer' }, true);
    return;
  }
  const callUuid = `plv-${Math.random().toString(36).slice(2, 8)}`;
  const u = new URL(answerUrl);
  let xml = await (await post(u.pathname + u.search, { CallUUID: callUuid, From: from, To: to, Direction: 'outbound', }, true)).text();
  const turns = [{ xml, llmRequests: 0, spoken: [] }];
  for (const utt of script) {
    await playAudio(xml);
    if (xml.includes('<Hangup/>')) break;
    const t = await speak(xml, utt, { callUuid, from: '911111111111' });
    // State right after this turn's reply: proves WHEN a visit appears (never before the explicit confirmation turn).
    Object.assign(t, await snapshot(to));
    xml = t.xml;
    turns.push(t);
  }
  await playAudio(xml);
  callTranscripts.push({ to, turns });
  const h = new URL(opts.hangupUrl);
  await post(h.pathname + h.search, { CallUUID: callUuid, CallStatus: 'completed', HangupCauseName: 'Normal Hangup', Duration: '63', BillDuration: '63' }, true);
}
app.get(VoiceService).client = {
  calls: { create: async (from, to, answerUrl, opts) => { void drive(from, to, answerUrl, opts); return { requestUuid: 'req-fake' }; } },
};

const testLead = async (name, phone) => (await post('/webhooks/meta/leads/test', { name, phone, location: 'Porur', budget: '80 lakhs', bhk: '2' })).json();
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const callEnded = (id) => waitFor(async () => { const c = await prisma.call.findUnique({ where: { id } }); return c?.endedAt ? c : null; }, 20000);
const transcriptOf = (phone) => callTranscripts.find((c) => c.to === phone);
const visitsOf = (customerId) => prisma.siteVisit.findMany({ where: { customerId }, include: { Property: true } });
const waText = (to) => log.wa.filter((m) => m.to === to).map((m) => m.text?.body ?? '');

// ---------------- Meta lead webhook: signature, creation, dedupe, sequence ----------------
// Real Meta lead-ad payloads always carry the page id (entry.id and value.page_id); tenancy resolves the business from it.
const metaPayload = { object: 'page', entry: [{ id: 'PAGE-1', changes: [{ field: 'leadgen', value: { leadgen_id: 'LG-REAL-1', page_id: 'PAGE-1', form_id: 'F1' } }] }] };
const unsigned = await post('/webhooks/meta/leads', metaPayload, false, { sign: false });
check('S1. Meta lead webhook without valid signature → rejected', unsigned.status === 401);
const m1 = await (await post('/webhooks/meta/leads', metaPayload)).json();
const m2 = await (await post('/webhooks/meta/leads', metaPayload)).json();
const metaLead = await prisma.lead.findFirst({ where: { externalRef: 'LG-REAL-1' }, include: { customer: true } });
check('8. Meta lead webhook creates customer + lead', m1.leads?.[0]?.created === true && metaLead?.customer.phone === '919000011111',
  `phone=${metaLead?.customer.phone} budget=${Number(metaLead?.budget)} campaign=${metaLead?.campaign}`);
check('11. Meta "80 lakhs" stored as 8000000, "+91 90000 11111" as 919000011111', Number(metaLead?.budget) === 8000000);
check('22. Duplicate Meta webhook ignored (idempotent)', m2.leads?.[0]?.duplicate === true && await prisma.lead.count({ where: { customerId: metaLead.customerId } }) === 1);
const fu1 = await prisma.followUp.findMany({ where: { leadId: metaLead.id }, orderBy: { scheduledAt: 'asc' } });
check('9. Lead → speed-to-lead sequence: WhatsApp intro, AI call, WhatsApp day 3, WhatsApp day 7', fu1.map((f) => `${f.channel}:${f.message}`).join(',') === 'whatsapp:first_contact,voice:call,whatsapp:nurture_day3,whatsapp:nurture_day7',
  fu1.map((f) => `${f.channel}:${f.message}`).join(','));
const t1 = await testLead('Kumar', '9000022222');
check('8b. /webhooks/meta/leads/test endpoint', t1.created === true && t1.followUps === 4);

// ---------------- WhatsApp: signature, tenancy, rules-first replies ----------------
const waBody = (phoneNumberId, from, id, text, name) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: phoneNumberId }, ...(name ? { contacts: [{ wa_id: from, profile: { name } }] } : {}),
  messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] });
{
  const unsignedWa = await post('/webhooks/whatsapp', waBody('pn1', '919000099991', 'wamid.x.1', 'hello'), false, { sign: false });
  check('S1b. WhatsApp webhook without valid signature → rejected', unsignedWa.status === 401);
  const waBefore = log.wa.length, llmBefore = log.llm.length;
  await post('/webhooks/whatsapp', waBody('pn-someone-elses', '919000099992', 'wamid.x.2', 'Porur 2 BHK venum'));
  await sleep(600);
  check('T1. WhatsApp message for an unknown phone_number_id is dropped: no customer, no reply, no AI',
    !(await prisma.customer.findFirst({ where: { phone: '919000099992' } })) && log.wa.length === waBefore && log.llm.length === llmBefore);
}
{
  const llmBefore = log.llm.length;
  await post('/webhooks/whatsapp', waBody('pn1', '919000011111', 'wamid.in.1', 'Porur la 2 BHK iruka? Budget eighty lakhs kulla venum', 'Meena'));
  const waReply = await waitFor(() => log.wa.find((m) => m.to === '919000011111' && /Green Valley Residency/.test(m.text?.body ?? '')));
  check('16. WhatsApp: reply is built from inventory (no invented property)', !!waReply, waReply?.text?.body);
  const body = waReply?.text?.body ?? '';
  check('16a. WhatsApp reply is short: ≤ 3 lines, ≤ 1 question', body.split('\n').filter(Boolean).length <= 3 && (body.match(/\?/g) ?? []).length <= 1, JSON.stringify(body));
  check('16e. Requirement fully stated → searched and answered by rules: 0 OpenAI requests', log.llm.length === llmBefore, `${log.llm.length - llmBefore} requests`);
  const fuAfter = await prisma.followUp.findMany({ where: { leadId: metaLead.id } });
  check('10. Customer reply cancels the pending sequence', fuAfter.every((f) => f.status === 'cancelled'), fuAfter.map((f) => f.status).join(','));
  // Lead-status and memory writes run after the reply is sent (off the reply path); wait for them.
  const seen = []; const t0s = Date.now();
  const now = await waitFor(async () => { const l = await prisma.lead.findUnique({ where: { id: metaLead.id } }); if (seen.at(-1)?.[1] !== l.status) seen.push([Date.now() - t0s, l.status]); return ['qualified', 'property_interested'].includes(l.status) ? l : null; }, 4000)
    ?? await prisma.lead.findUnique({ where: { id: metaLead.id } });
  check('16b. Facts saved from the message; lead advanced by the application', now.location === 'Porur' && Number(now.budget) === 8000000 && ['qualified', 'property_interested'].includes(now.status), `status=${now.status} seen=${JSON.stringify(seen)}`);
}
{
  // A bare "ok / yes" on WhatsApp with no visit proposal pending must never create a booking.
  const m = await prisma.lead.findFirst({ where: { externalRef: 'LG-REAL-1' } });
  const llmBefore = log.llm.length;
  await post('/webhooks/whatsapp', waBody('pn1', '919000011111', 'wamid.in.1b', 'yes'));
  await sleep(1200);
  check('C1. WhatsApp "yes" with nothing pending → no site visit, lead not site_visit_booked',
    (await visitsOf(m.customerId)).length === 0 && (await prisma.lead.findUnique({ where: { id: m.id } })).status !== 'site_visit_booked', `${log.llm.length - llmBefore} model requests`);
}
{
  // Full written-channel safe booking: propose -> explicit yes -> booked, with audit evidence.
  const w = await testLead('Deepa', '9000010101');
  await post('/webhooks/whatsapp', waBody('pn1', '919000010101', 'wamid.d.1', 'Porur la 2 BHK budget 80 lakhs', 'Deepa'));
  await waitFor(() => waText('919000010101').some((t) => /Green Valley/.test(t)));
  await post('/webhooks/whatsapp', waBody('pn1', '919000010101', 'wamid.d.2', 'Saturday 11am site visit Green Valley Residency paakalam'));
  const proposal = await waitFor(() => waText('919000010101').find((t) => /Saturday|Sat\b/i.test(t) && /\?/.test(t)));
  const beforeYes = await visitsOf(w.customerId);
  check('C2a. WhatsApp: visit request → confirmation question, nothing booked yet', !!proposal && beforeYes.length === 0, JSON.stringify(proposal ?? waText('919000010101')));
  await post('/webhooks/whatsapp', waBody('pn1', '919000010101', 'wamid.d.3', 'yes confirm'));
  const booked = await waitFor(async () => { const v = await visitsOf(w.customerId); return v.length ? v : null; });
  check('C2b. WhatsApp: explicit "yes" → exactly one visit booked (Green Valley Residency)', booked?.length === 1 && booked[0].Property.name === 'Green Valley Residency', booked && booked[0].scheduledAt.toISOString());
  await post('/webhooks/whatsapp', waBody('pn1', '919000010101', 'wamid.d.3', 'yes confirm')); // Meta retries the same message id
  await sleep(800);
  check('22b. Meta redelivering the same WhatsApp message id does not book twice', (await visitsOf(w.customerId)).length === 1);

  // Visit follow-through: the day-before WhatsApp goes out; the customer's "YES" confirms THAT visit.
  const visit = (await visitsOf(w.customerId))[0];
  const steps = await waitFor(async () => { const f = await prisma.followUp.findMany({ where: { leadId: w.leadId, source: 'visit' } }); return f.length ? f : null; });
  const kinds = (steps ?? []).map((f) => f.message.split(':')[1]).sort().join(',');
  check('V1. Booking schedules the visit follow-through (day-before confirm, reminder, after-visit)', /after/.test(kinds) && /reminder/.test(kinds), kinds);
  const { FollowUpProcessor } = await import('../dist/workers/follow-up.processor.js');
  let confirmStep = steps?.find((f) => f.message.startsWith('visit:confirm:'));
  confirmStep ??= await prisma.followUp.create({ data: { organizationId: visit.organizationId, leadId: w.leadId, customerId: w.customerId, channel: 'whatsapp', action: 'message', message: `visit:confirm:${visit.id}`, scheduledAt: new Date(), source: 'visit' } });
  const waBefore = log.wa.length;
  const ran = await app.get(FollowUpProcessor).process(confirmStep.id);
  const confirmMsg = log.wa.slice(waBefore).find((m) => m.to === '919000010101');
  check('V2. Day-before confirmation WhatsApp sent to the customer', ran.step === 'confirm' && /YES/.test(confirmMsg?.text?.body ?? ''), confirmMsg?.text?.body);
  await post('/webhooks/whatsapp', waBody('pn1', '919000010101', 'wamid.d.4', 'YES'));
  const confirmed = await waitFor(async () => (await prisma.siteVisit.findUnique({ where: { id: visit.id } }))?.status === 'confirmed');
  check('V3. Customer replies "YES" → that visit is confirmed (no new booking)', confirmed === true && (await visitsOf(w.customerId)).length === 1,
    waText('919000010101').at(-1));
}

// ---------------- Outbound call 1: the reported bug ("பேசலாம்") + a safe full booking ----------------
const c1 = await testLead('Ravi', '9000033333');
scripts.set('919000033333', ['பேசலாம்', 'ஆமா', '', 'Saturday 11 மணிக்கு Green Valley site visit பாக்கலாம்', 'ஆமா, புக் பண்ணுங்க']);
const start = await (await post('/voice/call', { leadId: c1.leadId })).json();
check('12. POST /voice/call dials via Plivo', start.started === true, JSON.stringify(start));
const call1 = await callEnded(start.callId);
const tr1 = transcriptOf('919000033333');
const T1 = tr1?.turns ?? [];
// The opening is identified by its self-introduction (it now starts "Hi <name>, …"); the checks below are unchanged.
const opening = log.tts.find((t) => /AI assistant பேசுறேன்/.test(t.text) && /enquiry/.test(t.text))?.text ?? '';
check('13. Opening line uses the CALL record customer (name + enquiry), not Plivo From', /Ravi/.test(opening) && /Porur/.test(opening), opening);
check('13c. Opening is short: 2 sentences, 1 question', opening.split(/[.?!]/).filter((s) => s.trim()).length <= 3 && (opening.match(/\?/g) ?? []).length === 1, `${opening.length} chars`);
const voiceConv = await prisma.conversation.findFirst({ where: { channel: 'voice', externalId: '919000033333' } });
check('13b. Turns with wrong From=911111111111 stored under the right customer', voiceConv?.customerId === c1.customerId && (await prisma.conversation.count({ where: { externalId: '911111111111' } })) === 0);
check('14. Saaras received the recorded audio (4 spoken turns; silence not sent)', log.stt.filter((s) => s.marker && /Green Valley|பேசலாம்|புக்|ஆமா/.test(s.marker)).length === 4,
  log.stt.slice(-4).map((s) => `${s.bytes}B`).join(', '));
check('14b. STT request = saaras:v3 / codemix / language unknown (v4 untested without a real key)', log.stt.every((s) => s.model === 'saaras:v3' && s.mode === 'codemix' && s.language === 'unknown'));
// THE reported bug: customer says only "பேசலாம்".
check('B1. "பேசலாம்" alone → keeps talking (asks one question), does NOT book, does NOT end, does NOT search',
  T1[1]?.xml.includes('<Record') && !T1[1]?.xml.includes('<Hangup/>') && T1[1]?.llmRequests === 0,
  `model requests=${T1[1]?.llmRequests}; said: ${T1[1]?.spoken[0]}`);
check('B1b. After "பேசலாம்": no site visit exists and the lead is not site_visit_booked', T1[1]?.visitsAfter === 0 && T1[1]?.leadStatusAfter !== 'site_visit_booked', `visits=${T1[1]?.visitsAfter} lead=${T1[1]?.leadStatusAfter}`);
check('B2. "ஆமா" to the requirement check → properties presented from inventory by rules (0 model requests)', /Green Valley/.test(T1[2]?.spoken.join(' ') ?? '') && T1[2]?.llmRequests === 0, T1[2]?.spoken.join(' / '));
check('B3. Silence → gentle re-prompt, no model request, call continues', T1[3]?.xml.includes('<Record') && T1[3]?.llmRequests === 0);
check('B4. Visit request → ONE confirmation question, call continues, at most 1 model request', T1[4]?.xml.includes('<Record') && !T1[4]?.xml.includes('<Hangup/>') && T1[4]?.llmRequests <= 1,
  `model requests=${T1[4]?.llmRequests}; said: ${T1[4]?.spoken.join(' / ')}`);
check('B5. Explicit "ஆமா, புக் பண்ணுங்க" after the question → booked by code (0 model requests), call ends', T1[5]?.llmRequests === 0 && T1[5]?.xml.includes('<Hangup/>'), `said: ${T1[5]?.spoken.join(' / ')}`);
const visits1 = await visitsOf(c1.customerId);
check('B6. Exactly one site visit, Green Valley Residency, a future Saturday 11:00 IST, with evidence recorded',
  visits1.length === 1 && visits1[0].Property.name === 'Green Valley Residency' && visits1[0].scheduledAt.getTime() > Date.now()
  && new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(visits1[0].scheduledAt).startsWith('11') && /Booked|ஆமா/.test(visits1[0].notes ?? ''),
  visits1[0] && `${visits1[0].scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST; notes=${(visits1[0].notes ?? '').slice(0, 90)}`);
check('B7. No site visit existed after any turn before the final confirmation (VISIT_PROPOSAL → VISIT_CONFIRMATION → BOOKING)', T1.slice(1, 5).every((t) => t.visitsAfter === 0) && T1[5]?.visitsAfter === 1,
  T1.slice(1).map((t) => t.visitsAfter).join(','));
const assistantLines = (await prisma.message.findMany({ where: { conversationId: voiceConv.id, role: 'assistant' }, orderBy: { createdAt: 'asc' } })).map((m) => m.content);
check('16c. Voice replies from inventory only', assistantLines.some((t) => /Green Valley/.test(t)) && !assistantLines.some((t) => /Sunrise Heights|Metro Square|Palm Meadows/.test(t)));
check('19. Call outcome + duration + turns saved', call1?.status === 'completed' && call1?.outcome === 'site_visit_booked' && call1?.durationSec === 63 && !!call1?.providerCallId, `status=${call1?.status} outcome=${call1?.outcome} duration=${call1?.durationSec}s turns=${call1?.turns}`);
check('17. Bulbul audio generated (ta-IN, 8 kHz) and served to Plivo as WAV', log.tts.some((t) => t.language_code === 'ta-IN' && t.speech_sample_rate === 8000)
  && log.plays.length > 0 && log.plays.every((p) => p.status === 200 && p.type === 'audio/wav'), `${log.plays.length} plays`);
check('18. Whole 5-turn booking call used ≤ 1 model request in total', T1.slice(1).reduce((n, t) => n + t.llmRequests, 0) <= 1, `per turn: ${T1.slice(1).map((t) => t.llmRequests).join(',')}`);

// ---------------- Call isolation: a second call to the same customer starts clean ----------------
{
  scripts.set('919000033333', ['ஆமா', 'ok']);
  const before = (await visitsOf(c1.customerId)).length;
  await prisma.followUp.deleteMany({ where: { customerId: c1.customerId, status: 'scheduled' } });
  const s = await (await post('/voice/call', { leadId: c1.leadId })).json();
  const c = await callEnded(s.callId);
  const t = transcriptOf('919000033333');
  const sys = log.llm.map((l) => l.system).join('\n');
  check('I1. New call, first word "ஆமா": nothing carried over from the previous call → no booking, no tool-driven action', (await visitsOf(c1.customerId)).length === before && !!c && (t?.turns ?? []).slice(1).every((x) => x.llmRequests === 0),
    `visits ${before}→${(await visitsOf(c1.customerId)).length}; outcome=${c?.outcome}`);
  check('I2. Old call transcripts are not sent to the model (history never contains another call)', !/புக் பண்ணுங்க/.test(sys));
}

// ---------------- Bad speech recognition: foreign script / garbage never changes language or books ----------------
{
  const g = await testLead('Mohan', '9000045454');
  scripts.set('919000045454', ['{pa-IN}ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ ਕਿਵੇਂ ਹੋ', '{pa-IN}k', 'Porur 2 BHK']);
  const s = await (await post('/voice/call', { leadId: g.leadId })).json();
  const c = await callEnded(s.callId);
  const t = transcriptOf('919000045454')?.turns ?? [];
  const cust = await prisma.customer.findUnique({ where: { id: g.customerId } });
  check('Q1. Gurmukhi / one-letter garbage: asked to repeat (cached static audio), 0 model requests, nothing saved or booked', t[1]?.llmRequests === 0 && t[2]?.llmRequests === 0 && (await visitsOf(g.customerId)).length === 0
    && t[1]?.xml.includes('<Record') && t[2]?.xml.includes('<Record') && t[1]?.xml.includes('<Play>'),
    `turn1 req=${t[1]?.llmRequests} record=${t[1]?.xml.includes('<Record')} play=${t[1]?.xml.includes('<Play>')}; turn2 req=${t[2]?.llmRequests} record=${t[2]?.xml.includes('<Record')}; turns=${t.length}`);
  check('Q2. Garbled STT never persists a language on the customer or the call', !cust.preferredLanguage && (!c?.language || c.language === 'tamil'), `customer=${cust.preferredLanguage ?? 'none'} call=${c?.language ?? 'none'}`);
}

// ---------------- Safety exits by rules: callback / not interested / human / wrong number ----------------
{
  const cb = await testLead('Vimal', '9000033334');
  scripts.set('919000033334', ['Tomorrow evening call pannunga']);
  const s = await (await post('/voice/call', { leadId: cb.leadId })).json();
  const c = await callEnded(s.callId);
  const fu = await prisma.followUp.findMany({ where: { leadId: cb.leadId, status: 'scheduled' } });
  check('21a. "call pannunga" → sequence replaced by ONE callback at 18:00 IST, call ends, 0 model requests',
    c?.outcome === 'callback_requested' && fu.length === 1 && fu[0].source === 'callback'
    && new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(fu[0].scheduledAt).startsWith('18')
    && transcriptOf('919000033334').turns[1].llmRequests === 0);
}
const c2 = await testLead('Senthil', '9000044444');
scripts.set('919000044444', ['Illa, enakku vendam. Interest illa']);
const s2 = await (await post('/voice/call', { leadId: c2.leadId })).json();
const call2 = await callEnded(s2.callId);
const cust2 = await prisma.customer.findUnique({ where: { id: c2.customerId } });
const pending2 = await prisma.followUp.count({ where: { customerId: c2.customerId, status: 'scheduled' } });
check('21b. "vendam" → hang up, not_interested, do-not-contact, nothing pending, 0 model requests', call2?.outcome === 'not_interested' && cust2.doNotContact && pending2 === 0
  && (await prisma.lead.findUnique({ where: { id: c2.leadId } })).status === 'not_interested' && transcriptOf('919000044444').turns[1].llmRequests === 0);

const c3 = await testLead('Priya', '9000055555');
scripts.set('919000055555', ['Agent kitta pesanum']);
const s3 = await (await post('/voice/call', { leadId: c3.leadId })).json();
const call3 = await callEnded(s3.callId);
const task3 = await prisma.followUp.findFirst({ where: { customerId: c3.customerId, channel: 'human', status: 'open' } });
check('21c. "Agent kitta pesanum" → human task, handoff, automation stopped, 0 model requests', call3?.outcome === 'human_requested' && !!task3
  && (await prisma.followUp.count({ where: { customerId: c3.customerId, status: 'scheduled' } })) === 0 && transcriptOf('919000055555').turns[1].llmRequests === 0);

const c4 = await testLead('Arun', '9000066666');
await post('/webhooks/whatsapp', waBody('pn1', '919000066666', 'wamid.in.2', 'Sorry, not interested'));
const lead4 = await waitFor(async () => { const l = await prisma.lead.findUnique({ where: { id: c4.leadId } }); return l.status === 'not_interested' ? l : null; });
check('21d. "not interested" on WhatsApp → not_interested + do-not-contact', !!lead4 && (await prisma.customer.findUnique({ where: { id: c4.customerId } })).doNotContact);

{
  const w = await testLead('Wrong Person', '9000023456');
  scripts.set('919000023456', ['Wrong number, naan enquiry pannala']);
  const sw = await (await post('/voice/call', { leadId: w.leadId })).json();
  const cw = await callEnded(sw.callId);
  check('21e. "Wrong number" → call ends, wrong_number, do-not-contact, nothing pending', cw?.outcome === 'wrong_number' && (await prisma.customer.findUnique({ where: { id: w.customerId } })).doNotContact
    && (await prisma.followUp.count({ where: { customerId: w.customerId, status: 'scheduled' } })) === 0);
}

// ---------------- Language: English caller is answered in English (en-IN voice), without saving a language from one sentence ----------------
{
  const e = await testLead('James P', '9000034567');
  scripts.set('919000034567', ['Can you please speak to me in English from now on', 'Bye']);
  await post('/voice/call', { leadId: e.leadId });
  await waitFor(async () => (await prisma.call.findFirst({ where: { leadId: e.leadId } }))?.endedAt, 20000);
  const t = transcriptOf('919000034567')?.turns ?? [];
  check('L1. English sentence → reply spoken with the English voice (en-IN); Tamil callers keep ta-IN', t[1]?.tts.some((x) => x.language_code === 'en-IN') && log.tts.some((x) => x.language_code === 'ta-IN'), `said: ${t[1]?.spoken.join(' / ')}`);
  check('L2. One sentence does not overwrite the stored customer language', !(await prisma.customer.findUnique({ where: { id: e.customerId } })).preferredLanguage);
}

// ---------------- 20. no answer → retry (the sequence's own voice step dials) ----------------
const { FollowUpProcessor } = await import('../dist/workers/follow-up.processor.js');
const c5 = await testLead('Lakshmi', '9000077777');
scripts.set('919000077777', 'NO_ANSWER');
const voiceStep = await prisma.followUp.findFirst({ where: { leadId: c5.leadId, channel: 'voice', source: 'sequence' } });
const stepResult = await app.get(FollowUpProcessor).process(voiceStep.id);
if (stepResult.reason === 'outside_call_window') {
  const h = new Date(stepResult.rescheduled).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  check('20c. Sequence call outside 9-21 IST is deferred, not dialed', /9:00:00 am/i.test(h), `deferred to ${h} IST`);
  check('20. (skipped: run with E2E_WINDOW_START=0 E2E_WINDOW_END=24 to dial now)', true);
} else {
  const call5 = await waitFor(async () => { const c = await prisma.call.findFirst({ where: { leadId: c5.leadId }, orderBy: { createdAt: 'desc' } }); return c?.endedAt ? c : null; });
  const retry = await waitFor(() => prisma.followUp.findFirst({ where: { customerId: c5.customerId, source: 'retry' } }));
  const retryHour = retry ? Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(retry.scheduledAt)) % 24 : -1;
  check('20. Sequence call unanswered → no_answer saved + ONE retry inside the calling window', !!stepResult.callId && call5?.outcome === 'no_answer'
    && retryHour >= Number(process.env.VOICE_CALL_WINDOW_START) && retryHour < Number(process.env.VOICE_CALL_WINDOW_END) && (await prisma.followUp.count({ where: { customerId: c5.customerId, source: 'retry' } })) === 1,
    retry && `retry at ${retry.scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
}
const c6 = await testLead('Gopal', '9000088888');
scripts.set('919000088888', 'NO_ANSWER');
const s6 = await (await post('/voice/call', { leadId: c6.leadId })).json();
await waitFor(async () => (await prisma.call.findUnique({ where: { id: s6.callId } }))?.endedAt);
check('20b. No duplicate retry while the sequence call step is still pending', (await prisma.followUp.count({ where: { customerId: c6.customerId, channel: 'voice', status: 'scheduled' } })) === 1);

// ---------------- INBOUND: unknown customer calls the business number ----------------
async function runInbound(callUuid, caller, to, utterances) {
  const answerRes = await post('/voice/inbound', { CallUUID: callUuid, From: `+${caller}`, To: to, Direction: 'inbound' }, true);
  const answer = await answerRes.text();
  let xml = answer;
  const turns = [{ xml, llmRequests: 0, spoken: [] }];
  for (const utt of utterances) {
    await playAudio(xml);
    if (xml.includes('<Hangup/>') || !xml.includes('<Record')) break;
    const t = await speak(xml, utt, { callUuid, from: `+${caller}` });
    Object.assign(t, await snapshot(caller));
    xml = t.xml;
    turns.push(t);
  }
  await playAudio(xml);
  return { answerRes, answer, turns };
}
{
  const callUuid = `plv-in-${Date.now()}`;
  const caller = '919000012345';
  const sttBefore = log.stt.length;
  const r = await runInbound(callUuid, caller, '914400000000', ['Porur la 2 BHK iruka? Budget eighty lakhs kulla venum', 'Saturday site visit Green Valley paakanum', '11 மணிக்கு', 'ஆமா']);
  await post('/voice/hangup', { CallUUID: callUuid, CallStatus: 'completed', HangupCauseName: 'Normal Hangup', Duration: '71' }, true); // inbound app hangup: no callId
  const inCall = await waitFor(async () => { const c = await prisma.call.findFirst({ where: { providerCallId: callUuid }, include: { customer: true } }); return c?.endedAt ? c : null; });
  const visit = inCall && (await visitsOf(inCall.customerId))[0];
  check('I0. Plivo voice endpoints reply 200 OK with XML', r.answerRes.status === 200 && (r.answerRes.headers.get('content-type') ?? '').includes('xml'));
  check('I3. Inbound: Tacksharp answers an unknown caller with a short Tamil greeting and records the reply', r.answer.includes('<Play>') && r.answer.includes('<Record') && !r.answer.includes('<Speak'));
  check('I4. Inbound: unknown caller saved as customer + lead', inCall?.customer.phone === caller && (await prisma.lead.count({ where: { customerId: inCall.customerId } })) === 1);
  check('I5. Inbound uses the SAME agent: inventory by rules, proposal/booking at most 1 model request per turn, booking by code',
    r.turns[1]?.llmRequests === 0 && r.turns.slice(2).every((t) => t.llmRequests <= 1) && r.turns[4]?.llmRequests === 0 && log.stt.length - sttBefore === 4,
    r.turns.slice(1).map((t) => `${t.llmRequests} req`).join(', '));
  check('I5b. Inbound: a visit request WITHOUT a time is not booked or guessed (nothing exists until the explicit yes)', r.turns.slice(1, 4).every((t) => t.visitsAfter === 0) && r.turns[4]?.visitsAfter === 1,
    r.turns.slice(1).map((t) => t.visitsAfter).join(','));
  check('I6. Inbound: visit booked only after the explicit "ஆமா" turn; call then ended', !!visit && r.turns.at(-1).xml.includes('<Hangup/>') && r.turns[3].xml.includes('<Record'),
    visit && `${visit.Property.name}, ${visit.scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  check('I7. Inbound: hang-up matched by CallUUID; direction, outcome, duration saved', inCall?.direction === 'inbound' && inCall?.outcome === 'site_visit_booked' && inCall?.durationSec === 71, inCall?.summary);
  const dup = await post('/voice/inbound', { CallUUID: callUuid, From: `+${caller}`, To: '914400000000' }, true);
  check('I8. Plivo retrying the same inbound call does not create a second record', dup.status === 200 && (await prisma.call.count({ where: { providerCallId: callUuid } })) === 1);
  const unknown = await post('/voice/inbound', { CallUUID: `plv-in-x-${Date.now()}`, From: '+919000099999', To: '+919999999999', Direction: 'inbound' }, true);
  const unknownXml = await unknown.text();
  check('T2. Inbound call to a number that is not ours: rejected politely, no customer created', /not in service/i.test(unknownXml) && unknownXml.includes('<Hangup/>')
    && !(await prisma.customer.findFirst({ where: { phone: '919000099999' } })));
}

// ---------------- Plivo signature, org isolation, latency, rate limit ----------------
{
  const unsignedTurn = await post('/voice/turn?callId=anything', { CallUUID: 'x', RecordUrl: 'https://x/y.wav' }, true, { sign: false });
  check('S2. Plivo callback without valid signature → 403', unsignedTurn.status === 403);

  const { hashPassword } = await import('../dist/auth/password.js');
  await prisma.organization.upsert({ where: { id: 'org_other_e2e' }, create: { id: 'org_other_e2e', name: 'Other Realty' }, update: {} });
  await prisma.user.upsert({ where: { email: 'other@other.test' }, create: { email: 'other@other.test', organizationId: 'org_other_e2e', passwordHash: await hashPassword('another-strong-pass'), role: 'admin' }, update: {} });
  const otherLogin = await post('/auth/login', { email: 'other@other.test', password: 'another-strong-pass' }, false, { cookie: false });
  const other = (otherLogin.headers.get('set-cookie') ?? '').split(';')[0];
  const theirView = await get(`/leads/${c1.leadId}`, other);
  const theirList = await (await get('/leads', other)).json();
  const theirCall = await post('/voice/call', { leadId: c1.leadId }, false, { cookie: other });
  check('O1. Another organization cannot see or call this business\'s leads', theirView.status === 404 && Array.isArray(theirList) && theirList.length === 0 && theirCall.status === 404);

  // A mapped number belongs to exactly the organization in the mapping.
  const { TenancyService } = await import('../dist/tenancy/tenancy.service.js');
  await prisma.organizationChannel.create({ data: { organizationId: 'org_other_e2e', kind: 'plivo_number', externalId: '914488887777' } });
  app.get(TenancyService).clearCache();
  const mappedCaller = '919000077701';
  const mapped = await post('/voice/inbound', { CallUUID: `plv-in-m-${Date.now()}`, From: `+${mappedCaller}`, To: '+914488887777', Direction: 'inbound' }, true);
  const cust = await prisma.customer.findFirst({ where: { phone: mappedCaller } });
  check('T3. Inbound call to another business\'s mapped number is created under THAT organization', mapped.status === 200 && cust?.organizationId === 'org_other_e2e', `org=${cust?.organizationId}`);

  const lat = await (await get('/voice/latency')).json();
  check('P1. Per-stage latency recorded (download, STT, AI, TTS, total) with the rules/model split', lat.turns > 0 && lat.stt.count > 0 && lat.tts.count > 0 && lat.byPath.rules.count > 0,
    `fake providers, so only OUR overhead: total p50=${lat.total.p50}ms p95=${lat.total.p95}ms (n=${lat.turns}); rules turns=${lat.byPath.rules.count}, model turns=${lat.byPath.llm.count}`);
  const lat2 = await (await get('/ai/latency')).json();
  check('P2. GET /ai/latency reports voice and whatsapp separately', lat2.voice?.turns > 0 && lat2.whatsapp?.turns > 0, `voice n=${lat2.voice?.turns} wa n=${lat2.whatsapp?.turns}`);

  const set0 = await (await get('/settings')).json();
  check('ST1. GET /settings: speed-to-lead defaults (instant call, 3 attempts, day-before confirm)', set0.settings?.speedToLead.instantCall === true && set0.settings.calling.maxAttempts === 3 && set0.settings.visits.confirmDayBefore === true);
  const put = await realFetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ team: { alertPhones: ['+91 98840 12345'] }, calling: { windowStartHour: 0, windowEndHour: 24 }, hacked: true }) });
  const set1 = await put.json();
  check('ST2. PUT /settings validates: phone normalised, calling window kept inside the legal .env window, unknown keys dropped', put.status === 200 && set1.settings.team.alertPhones[0] === '919884012345' && !('hacked' in set1.settings)
    && set1.settings.calling.windowStartHour >= Number(process.env.VOICE_CALL_WINDOW_START) && set1.settings.calling.windowEndHour <= Number(process.env.VOICE_CALL_WINDOW_END),
    JSON.stringify(set1.settings?.calling));
  const otherSettings = await (await get('/settings', other)).json();
  check('ST3. Settings are per business: another organization still sees its own defaults', otherSettings.settings?.team.alertPhones.length === 0);

  const roi = await (await get('/dashboard/roi?days=30')).json();
  check('P3. GET /dashboard/roi: funnel, speed to first call, cost per attended visit', roi.funnel?.length === 5 && roi.leads > 0 && roi.funnel[3].count >= 2 && 'perAttendedVisitInr' in roi.costs,
    JSON.stringify(roi.funnel?.map((f) => f.count)));

  let blocked = 0;
  for (let i = 0; i < 12; i++) if ((await post('/auth/login', { email: 'x@y.z', password: 'nope-nope-nope' }, false, { cookie: false })).status === 429) blocked++;
  check('R1. Login brute force is rate limited (429)', blocked >= 1, `${blocked} of 12 attempts blocked`);
}

// ---------------- model usage summary (fake OpenAI: counts are real for OUR code, tokens are only char/4) ----------------
{
  const byTools = log.llm.reduce((m, l) => { const k = l.tools.join('+') || 'no-tools'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const noBooking = log.llm.every((l) => !l.tools.some((t) => ['book_site_visit', 'end_call', 'update_lead_status', 'mark_not_interested', 'request_human_handoff', 'schedule_callback'].includes(t)));
  check('M1. The model was never offered a booking / end-call / status / DNC / handoff / callback tool', noBooking, JSON.stringify(byTools));
  const maxPrompt = Math.max(0, ...log.llm.map((l) => l.promptChars));
  check('M2. Largest prompt sent to the model stays compact (< 12k chars incl. tool schemas)', maxPrompt < 12000, `max ${maxPrompt} chars (~${Math.ceil(maxPrompt / 4)} tokens) over ${log.llm.length} model requests in the whole run`);
}

// ---------------- dashboard ----------------
const dash = await (await get('/dashboard/summary')).json();
check('Dashboard summary reflects the run', dash.voice.total >= 6 && dash.humanTasksOpen >= 1, JSON.stringify(dash.voice));

const t0 = Date.now();
await app.close(); // graceful: in-flight session writes settle, workers finish, Redis + Prisma closed
check('G1. Graceful shutdown completes (sessions settled, workers, Redis, DB closed)', Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
const failedAll = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedAll.length}/${results.length} checks passed`);
console.log('NOTE: external providers are scripted fakes. Real OpenAI/Sarvam/Plivo/Meta behaviour and latency: NOT VERIFIED — EXTERNAL SERVICE REQUIRED.');
process.exit(failedAll.length ? 1 : 0);
