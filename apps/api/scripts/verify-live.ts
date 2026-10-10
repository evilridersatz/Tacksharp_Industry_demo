/**
 * Tacksharp LIVE verification — tests the REAL providers with YOUR keys (from apps/api/.env).
 * Keys never leave your machine. Writes verify-output/verify-report.md (no secrets) to share.
 *
 *   npm run verify:live                                  # AI, Sarvam, WhatsApp, Plivo, Meta, server checks
 *   npm run verify:live -- --only=ai,sarvam              # just some sections
 *   npm run verify:live -- --call=9876543210             # + a REAL outbound AI call to your phone
 *   npm run verify:live -- --inbound                     # + wait for YOU to call the business number
 *   npm run verify:live -- --whatsapp-to=9876543210      # + send one real WhatsApp (template) to your phone
 *   npm run verify:live -- --audio-dir=./my-recordings   # + your own phone recordings (name.wav + name.txt)
 *
 * Costs (approx.): AI tests a few rupees; Sarvam tests a few rupees; a test call = normal Plivo + AI usage.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run, user, type AgentInputItem } from '@openai/agents';
import { getRealEstateAgent, type Channel, type TacksharpAgentContext, type TurnActions } from 'ai/agents/real-estate-agent.js';
import { normalizePhone } from '../src/common/phone.js';
import { parseIndianBudget } from '../src/common/parsers.js';
import { nowInIst } from '../src/common/time.js';
import { percentile } from '../src/common/latency.js';

// ---------------------------------------------------------------- setup
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : 'true'];
  }),
);
const only = args.only ? new Set(String(args.only).split(',')) : null;
const want = (s: string) => !only || only.has(s);
const OUT = path.resolve(process.cwd(), 'verify-output');
const env = process.env;

// Overridable only so the script itself can be tested offline; never set these in normal use.
const SARVAM = env.VERIFY_SARVAM_BASE ?? 'https://api.sarvam.ai';
const GRAPH = env.VERIFY_GRAPH_BASE ?? 'https://graph.facebook.com';
const PLIVO = env.VERIFY_PLIVO_BASE ?? 'https://api.plivo.com';

type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
const report: Array<{ section: string; status: Status; name: string; detail?: string }> = [];
const lines: string[] = [];
let section = '';
function head(title: string) {
  section = title;
  console.log(`\n=== ${title} ===`);
  lines.push(`\n## ${title}\n`);
}
function note(text: string) {
  console.log(`   ${text}`);
  lines.push(`${text}\n`);
}
function result(status: Status, name: string, detail?: string) {
  report.push({ section, status, name, detail });
  const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️', SKIP: '⏭️' }[status];
  console.log(`${icon} ${status.padEnd(4)} ${name}${detail ? `  — ${detail}` : ''}`);
  lines.push(`- ${icon} **${status}** ${name}${detail ? ` — ${detail}` : ''}`);
}
const mask = (p?: string | null) => (p ? `${'*'.repeat(Math.max(0, p.length - 4))}${p.slice(-4)}` : '');
const ms = (t: number) => `${Math.round(t)} ms`;
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}
async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}
const errText = (b: any) => (typeof b === 'string' ? b.slice(0, 200) : JSON.stringify(b?.error ?? b).slice(0, 200));

// ---------------------------------------------------------------- 1. AI
// The model no longer decides business actions (booking, opt-out, hand-off, callbacks, ending calls): the
// application does, from the customer's words and the server-side state. This section therefore checks what
// the model STILL does with your real OpenAI key: phrase short replies in the right language, save facts,
// search only verified inventory, propose (never book) a visit, and never claim an action - and how many
// OpenAI requests each turn costs.
type Expect = (calls: ToolCall[], reply: string, run: { requests: number }) => string | null; // null = pass
type ToolCall = { name: string; args: any };
type Toolset = 'none' | 'memory' | 'discussion' | 'discussion_memory' | 'proposal';
type Case = { id: string; channel: Channel; toolset: Toolset; say: string; brief?: string; expect: Expect; why: string; maxRequests: number };

const tool = (calls: ToolCall[], name: string) => calls.find((c) => c.name === name);
const budgetOf = (calls: ToolCall[]) => {
  const m = tool(calls, 'update_customer_memory');
  return m?.args?.budget !== undefined ? parseIndianBudget(m.args.budget) : undefined;
};
const tamil = /[஀-௿]/;
const nextSaturday = () => {
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const add = (6 - ist.getUTCDay() + 7) % 7 || 7;
  ist.setUTCDate(ist.getUTCDate() + add);
  return ist.toISOString().slice(0, 10);
};
const claimsAction = /\b(booked|confirmed|scheduled)\b.*\b(visit|slot)\b|\bvisit\b.*\b(booked|confirmed|scheduled)\b|book பண்ணிட்டேன்|confirm பண்ணிட்டேன்/i;
const VERIFIED = [
  'VERIFIED PROPERTIES (mention only these):',
  '1) id=prop_porur_green_valley | Green Valley Residency | Porur | 2 BHK | 72.0 lakhs',
  '2) id=prop_porur_lake_view | Lake View Towers | Porur | 3 BHK | 95.0 lakhs',
].join('\n');
const briefOf = (state: string, known: string, next: string, props = VERIFIED) => `STATE: ${state}\nKNOWN: ${known}\n${next}\n${props}`;

const CASES: Case[] = [
  {
    id: 'memory-timeline', channel: 'whatsapp', toolset: 'discussion_memory', maxRequests: 2,
    say: 'Naan 3 months kulla vaanganum, Chennai la work panren',
    brief: briefOf('PROPERTY_DISCUSSION', 'Area: Porur; Budget: up to 80.0 lakhs; BHK: 2', 'NEXT QUESTION: none, qualification is complete.'),
    why: 'Saves a stated fact through the one memory tool', expect: (c) => (tool(c, 'update_customer_memory') ? null : 'update_customer_memory not called'),
  },
  {
    id: 'budget-lakh-short', channel: 'whatsapp', toolset: 'memory', maxRequests: 2,
    say: 'Budget 80L, OMR side, 3 bedroom flat',
    brief: briefOf('QUALIFICATION', 'nothing yet', 'NEXT QUESTION (ask only this, one question): location', 'VERIFIED PROPERTIES: none shown yet. Do not mention any property.'),
    why: 'Short-form budget "80L" parsed', expect: (c) => (budgetOf(c) === 8_000_000 ? null : `budget parsed as ${budgetOf(c)}`),
  },
  {
    id: 'search-on-change', channel: 'voice', toolset: 'discussion', maxRequests: 2,
    say: 'Velachery la 2 BHK 90 lakhs kulla iruka?',
    brief: briefOf('PROPERTY_DISCUSSION', 'Area: Porur; Budget: up to 80.0 lakhs; BHK: 2', 'NEXT QUESTION: none, qualification is complete.'),
    why: 'Searches verified inventory when the customer changes the request', expect: (c) => (tool(c, 'search_properties') ? null : 'search_properties not called'),
  },
  {
    id: 'propose-not-book', channel: 'voice', toolset: 'proposal', maxRequests: 1,
    say: 'Green Valley Residency Saturday 11 mani-ku visit pannalaam',
    brief: briefOf('VISIT_PROPOSAL', 'Area: Porur; Budget: up to 80.0 lakhs; BHK: 2', 'NEXT QUESTION: none, qualification is complete.'),
    why: 'Proposes (does not book) the right property and time; the run stops at the tool (1 request)',
    expect: (c, _r, run) => {
      const p = tool(c, 'propose_site_visit');
      if (!p) return 'propose_site_visit not called';
      if (p.args?.propertyId !== 'prop_porur_green_valley') return `propertyId=${p.args?.propertyId}`;
      if (!String(p.args?.scheduledAt ?? '').startsWith(`${nextSaturday()}T11:00`)) return `scheduledAt=${p.args?.scheduledAt}`;
      return run.requests === 1 ? null : `${run.requests} requests (expected 1: the run stops at the tool)`;
    },
  },
  {
    id: 'no-invented-property', channel: 'whatsapp', toolset: 'discussion', maxRequests: 2,
    say: 'Anna Nagar la 4 BHK villa 30 lakhs ku iruka?',
    brief: briefOf('PROPERTY_DISCUSSION', 'Area: Porur; BHK: 2', 'NEXT QUESTION: none, qualification is complete.', 'VERIFIED PROPERTIES: none shown yet. Do not mention any property.'),
    why: 'When nothing is verified it must not invent a property',
    expect: (c, r) => (/residency|towers|heights|meadows|square|enclave|apartments\b/i.test(r) && !tool(c, 'search_properties') ? `mentioned a property without searching: "${r.slice(0, 80)}"` : null),
  },
  {
    id: 'never-claims-booking', channel: 'voice', toolset: 'discussion', maxRequests: 2,
    say: 'Seri, Green Valley Saturday morning pannidunga',
    brief: briefOf('PROPERTY_DISCUSSION', 'Area: Porur; Budget: up to 80.0 lakhs; BHK: 2', 'NEXT QUESTION: none, qualification is complete.'),
    why: 'Even when pushed, the reply never says a visit is booked/confirmed (only the system can)',
    expect: (_c, r) => (claimsAction.test(r) ? `claimed an action: "${r.slice(0, 90)}"` : null),
  },
  {
    id: 'english-reply', channel: 'voice', toolset: 'none', maxRequests: 1,
    say: 'Can you explain the price difference between the two options?',
    brief: briefOf('PROPERTY_DISCUSSION', 'Area: Porur; Budget: up to 80.0 lakhs; BHK: 2', 'NEXT QUESTION: none, qualification is complete.'),
    why: 'Plain English question gets an English reply in ONE request', expect: (_c, r, run) => (tamil.test(r) ? `replied in Tamil: "${r.slice(0, 60)}"` : run.requests === 1 ? null : `${run.requests} requests`),
  },
  {
    id: 'tamil-reply', channel: 'voice', toolset: 'none', maxRequests: 1,
    say: 'Lake View Towers-ல parking வசதி இருக்கா?',
    brief: briefOf('PROPERTY_DISCUSSION', 'Area: Porur; Budget: up to 95.0 lakhs; BHK: 3', 'NEXT QUESTION: none, qualification is complete.'),
    why: 'Tamil speaker gets Tamil script in ONE request', expect: (_c, r, run) => (!tamil.test(r) ? `replied without Tamil: "${r.slice(0, 60)}"` : run.requests === 1 ? null : `${run.requests} requests`),
  },
  {
    id: 'short-voice', channel: 'voice', toolset: 'none', maxRequests: 1,
    say: 'Green Valley la ready to move ah? Price negotiable ah?',
    brief: briefOf('PROPERTY_DISCUSSION', 'Area: Porur; Budget: up to 80.0 lakhs; BHK: 2', 'NEXT QUESTION: none, qualification is complete.'),
    why: 'Voice reply stays short (≤ 30 words) and asks at most one question',
    expect: (_c, r) => (r.split(/\s+/).length > 30 ? `${r.split(/\s+/).length} words` : (r.match(/[?？]/g)?.length ?? 0) > 1 ? 'more than one question' : null),
  },
];

const FAKE_INVENTORY = [
  { id: 'prop_porur_green_valley', name: 'Green Valley Residency', location: 'Porur', type: 'Apartment', bhk: 2, price: 7_200_000, priceText: '72.0 lakhs' },
  { id: 'prop_omr_sunrise', name: 'Sunrise Heights', location: 'OMR', type: 'Apartment', bhk: 2, price: 6_800_000, priceText: '68.0 lakhs' },
  { id: 'prop_velachery_metro', name: 'Metro Square', location: 'Velachery', type: 'Apartment', bhk: 2, price: 8_400_000, priceText: '84.0 lakhs' },
];

async function testAi() {
  head('1. AI agent (real OpenAI model)');
  if (!env.OPENAI_API_KEY && !env.OPENAI_BASE_URL) return result('SKIP', 'OPENAI_API_KEY not set — NOT VERIFIED — EXTERNAL SERVICE REQUIRED');
  note(`Model: ${env.OPENAI_MODEL || 'gpt-5.4-mini'} (voice: ${env.OPENAI_VOICE_MODEL || env.OPENAI_MODEL || 'gpt-5.4-mini'}), reasoning ${env.OPENAI_REASONING_EFFORT || 'low'}`);
  const priceIn = Number(env.VERIFY_PRICE_INPUT_PER_M ?? 0.75);
  const priceOut = Number(env.VERIFY_PRICE_OUTPUT_PER_M ?? 4.5);
  const usd2inr = Number(env.VERIFY_USD_INR ?? 84);
  const latencies: number[] = [];
  const requests: number[] = [];
  let inTok = 0, outTok = 0, passed = 0;

  for (const tc of CASES) {
    const calls: ToolCall[] = [];
    const actions: TurnActions = {};
    const now = nowInIst();
    const context: TacksharpAgentContext = {
      organizationId: 'verify',
      organizationName: 'Tacksharp Realty',
      channel: tc.channel,
      phone: '919000000000',
      nowText: now.text,
      nowIso: now.iso,
      brief: tc.brief ?? briefOf('QUALIFICATION', 'nothing yet', 'NEXT QUESTION (ask only this, one question): location', 'VERIFIED PROPERTIES: none shown yet. Do not mention any property.'),
      styleLine: tc.channel === 'voice' ? 'Natural Chennai spoken Tamil written in TAMIL SCRIPT, not formal; keep English words in English letters. No markdown, emoji or symbols.' : 'Tanglish in English letters, short and friendly.',
      actions,
      updateCustomerMemory: async (u) => (calls.push({ name: 'update_customer_memory', args: u }), { updated: true, saved: u }),
      searchProperties: async (q) => {
        calls.push({ name: 'search_properties', args: q });
        const max = parseIndianBudget(q.maxBudget as number | undefined);
        const found = FAKE_INVENTORY.filter(
          (p) => (!q.location || p.location.toLowerCase().includes(String(q.location).toLowerCase())) && (!q.bhk || p.bhk === q.bhk) && (!max || p.price <= max),
        );
        return { count: found.length, properties: found };
      },
      proposeSiteVisit: async (i) => (calls.push({ name: 'propose_site_visit', args: i }), { ok: true, reply: 'Site visit confirm பண்ணட்டுமா?' }),
    };
    try {
      const items: AgentInputItem[] = [user(tc.say)];
      const [res, t] = await timed(() => run(getRealEstateAgent(tc.channel, tc.toolset), items, { context, maxTurns: 4 }));
      latencies.push(t);
      const usage = res.runContext?.usage;
      inTok += usage?.inputTokens ?? 0;
      outTok += usage?.outputTokens ?? 0;
      const reqs = usage?.requests ?? 0;
      requests.push(reqs);
      const reply = String(context.replyOverride ?? res.finalOutput ?? '').trim();
      const problem = tc.expect(calls, reply, { requests: reqs }) ?? (reqs > tc.maxRequests ? `${reqs} OpenAI requests (limit ${tc.maxRequests})` : null);
      if (!problem) passed++;
      result(problem ? 'FAIL' : 'PASS', `${tc.id}: ${tc.why}`, `${ms(t)} · ${reqs} req · "${tc.say}" → ${calls.map((c) => c.name).join(', ') || 'no tool'} · "${reply.slice(0, 90)}"${problem ? ` · ${problem}` : ''}`);
    } catch (e) {
      result('FAIL', `${tc.id}: ${tc.why}`, `error: ${e instanceof Error ? e.message : e}`);
    }
  }
  const n = latencies.length || 1;
  const costUsd = (inTok / 1e6) * priceIn + (outTok / 1e6) * priceOut;
  note(`\n**AI summary:** ${passed}/${CASES.length} passed · model latency P50 ${ms(percentile(latencies, 50) ?? 0)} / P95 ${ms(percentile(latencies, 95) ?? 0)} · requests per turn P50 ${percentile(requests, 50)} / max ${Math.max(0, ...requests)}`);
  note(`Tokens per turn: ~${Math.round(inTok / n)} in / ${Math.round(outTok / n)} out · est. ₹${((costUsd / n) * usd2inr).toFixed(3)} per AI turn (prices: $${priceIn}/$${priceOut} per M tokens, ₹${usd2inr}/$ — override with VERIFY_PRICE_* / VERIFY_USD_INR). Most turns in a real call are answered by rules with NO model request.`);
}

// ---------------------------------------------------------------- 2. Sarvam
const SPEECH: Array<{ text: string; keys: string[] }> = [
  { text: 'Porur-ல 2 BHK இருக்கா? Budget எண்பது lakhs-க்குள்ள வேணும்.', keys: ['porur|போரூர்', 'bhk|பிஎச்கே|பி எச் கே', 'budget|பட்ஜெட்', 'lakh|லட்ச|லாக்'] },
  { text: 'Saturday evening site visit பண்ணலாமா?', keys: ['saturday|சாட்டர்டே|சனி', 'site|சைட்', 'visit|விசிட்'] },
  { text: 'எனக்கு apartment தான் வேணும், villa வேண்டாம்.', keys: ['apartment|அபார்ட்மென்ட்', 'villa|வில்லா', 'வேண்டாம்|வேணாம்|vendam'] },
  { text: 'Tomorrow evening call பண்ணுங்க, இப்போ busy-ஆ இருக்கேன்.', keys: ['tomorrow|டுமாரோ|நாளைக்கு', 'call|கால்', 'busy|பிசி'] },
  { text: 'Agent கிட்ட பேசணும்.', keys: ['agent|ஏஜென்ட்', 'பேசணும்|பேசனும்|pesanum'] },
  { text: 'I am looking for a three bedroom flat in OMR.', keys: ['three|3', 'bedroom', 'flat', 'omr|o m r'] },
  { text: 'வேண்டாம், already வாங்கிட்டேன்.', keys: ['வேண்டாம்|வேணாம்', 'already|ஆல்ரெடி', 'வாங்கிட்டேன்|வாங்கிட்டோம்'] },
  { text: 'Velachery-ல ready to move flat இருக்கா?', keys: ['velachery|வேளச்சேரி', 'ready|ரெடி', 'flat|பிளாட்|ஃப்ளாட்'] },
];

function keyHits(transcript: string, keys: string[]) {
  const t = transcript.toLowerCase();
  return keys.filter((k) => k.split('|').some((alt) => t.includes(alt.toLowerCase()))).length;
}

async function sarvamTts(text: string, sampleRate = Number(env.SARVAM_TTS_SAMPLE_RATE ?? 8000)) {
  const r = await getJson(`${SARVAM}/text-to-speech`, {
    method: 'POST',
    headers: { 'api-subscription-key': env.SARVAM_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model: env.SARVAM_TTS_MODEL ?? 'bulbul:v3',
      speaker: env.SARVAM_TTS_SPEAKER ?? 'ishita',
      language_code: /[\u0B80-\u0BFF]/.test(text) ? 'ta-IN' : 'en-IN',
      pace: Number(env.SARVAM_TTS_PACE ?? 1),
      speech_sample_rate: sampleRate,
      output_audio_codec: 'wav',
    }),
  });
  if (!r.ok || !r.body?.audios?.[0]) throw new Error(`TTS ${r.status}: ${errText(r.body)}`);
  return Buffer.from(r.body.audios[0], 'base64');
}

async function sarvamStt(audio: Buffer, model: string, mode: string | null, language: string, keyterms?: string[]) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  if (mode) form.append('mode', mode);
  form.append('language_code', language);
  if (keyterms?.length) form.append('keyterms', JSON.stringify(keyterms));
  const r = await getJson(`${SARVAM}/speech-to-text`, { method: 'POST', headers: { 'api-subscription-key': env.SARVAM_API_KEY! }, body: form });
  if (!r.ok) throw new Error(`STT ${r.status}: ${errText(r.body)}`);
  return { transcript: String(r.body?.transcript ?? ''), language: r.body?.language_code as string | undefined };
}

async function testSarvam() {
  head('2. Sarvam speech (real Bulbul TTS → Saaras STT)');
  if (!env.SARVAM_API_KEY) return result('SKIP', 'SARVAM_API_KEY not set');
  await fs.mkdir(path.join(OUT, 'audio'), { recursive: true });
  note('Bulbul speaks each sentence (8 kHz phone audio), then each Saaras setup transcribes it. Generated audio is saved in verify-output/audio so you can listen.');
  note('Note: synthetic speech is cleaner than a real phone line — also run --audio-dir with your own recordings.');

  const audios: Buffer[] = [];
  const ttsTimes: number[] = [];
  for (const [i, s] of SPEECH.entries()) {
    try {
      const [a, t] = await timed(() => sarvamTts(s.text));
      audios.push(a);
      ttsTimes.push(t);
      await fs.writeFile(path.join(OUT, 'audio', `sample-${i + 1}.wav`), a);
    } catch (e) {
      result('FAIL', `Bulbul TTS: "${s.text}"`, e instanceof Error ? e.message : String(e));
      return;
    }
  }
  result('PASS', `Bulbul TTS (${env.SARVAM_TTS_MODEL ?? 'bulbul:v3'}, speaker ${env.SARVAM_TTS_SPEAKER ?? 'ishita'})`, `${audios.length} clips · P50 ${ms(percentile(ttsTimes, 50)!)} / P95 ${ms(percentile(ttsTimes, 95)!)}`);

  const keyterms = (env.SARVAM_STT_KEYTERMS ?? 'Porur,OMR,Velachery,Tambaram,BHK').split(',').map((k) => k.trim()).filter(Boolean);
  const setups = [
    { name: 'saaras:v3 · codemix · auto language (current default)', model: 'saaras:v3', mode: 'codemix', lang: 'unknown' },
    { name: 'saaras:v3 · codemix · ta-IN', model: 'saaras:v3', mode: 'codemix', lang: 'ta-IN' },
    { name: 'saaras:v4 · codemix · auto language', model: 'saaras:v4', mode: 'codemix', lang: 'unknown' },
    { name: 'saaras:v4 · codemix · auto + keyterms', model: 'saaras:v4', mode: 'codemix', lang: 'unknown', keyterms },
    { name: 'saaras:v4 · no mode · auto language', model: 'saaras:v4', mode: null, lang: 'unknown' },
  ];
  const summary: string[] = [];
  for (const setup of setups) {
    let hits = 0, total = 0;
    const times: number[] = [];
    const samples: string[] = [];
    let error: string | null = null;
    for (const [i, s] of SPEECH.entries()) {
      try {
        const [r, t] = await timed(() => sarvamStt(audios[i], setup.model, setup.mode, setup.lang, setup.keyterms));
        times.push(t);
        hits += keyHits(r.transcript, s.keys);
        total += s.keys.length;
        if (i < 2) samples.push(`"${r.transcript}"`);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    if (error) {
      result(setup.model === 'saaras:v3' ? 'FAIL' : 'WARN', setup.name, `not accepted: ${error}`);
      summary.push(`| ${setup.name} | not accepted | — |`);
      continue;
    }
    const acc = Math.round((hits / total) * 100);
    result(acc >= 80 ? 'PASS' : 'WARN', setup.name, `key words recognised ${acc}% · P50 ${ms(percentile(times, 50)!)} / P95 ${ms(percentile(times, 95)!)} · e.g. ${samples.join(' / ')}`);
    summary.push(`| ${setup.name} | ${acc}% | ${ms(percentile(times, 95)!)} |`);
  }
  note('\n| Setup | Key words recognised | STT P95 |\n|---|---|---|\n' + summary.join('\n'));
  note('Keep saaras:v3 unless a v4 row is clearly better here AND on your own recordings.');

  if (args['audio-dir']) {
    const dir = path.resolve(String(args['audio-dir']));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.wav'));
    note(`\nYour recordings (${files.length} files from ${dir}):`);
    for (const f of files) {
      const expected = await fs.readFile(path.join(dir, f.replace(/\.wav$/, '.txt')), 'utf8').catch(() => '');
      const audio = await fs.readFile(path.join(dir, f));
      try {
        const [r, t] = await timed(() => sarvamStt(audio, env.SARVAM_STT_MODEL ?? 'saaras:v3', env.SARVAM_STT_MODE ?? 'codemix', env.SARVAM_STT_LANGUAGE ?? 'unknown'));
        result('PASS', `Your recording ${f}`, `${ms(t)} · heard "${r.transcript}"${expected ? ` · expected "${expected.trim()}"` : ''}`);
      } catch (e) {
        result('FAIL', `Your recording ${f}`, e instanceof Error ? e.message : String(e));
      }
    }
  }
}

// ---------------------------------------------------------------- 3. WhatsApp
async function testWhatsApp() {
  head('3. WhatsApp Cloud API');
  const v = env.WHATSAPP_API_VERSION ?? 'v23.0';
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return result('SKIP', 'WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set');
  const auth = { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` };
  const num = await getJson(`${GRAPH}/${v}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`, { headers: auth });
  if (!num.ok) return result('FAIL', 'Token + phone number ID', errText(num.body));
  result('PASS', 'Token + phone number ID', `${num.body.verified_name ?? ''} ${mask(String(num.body.display_phone_number ?? '').replace(/\D/g, ''))} · quality ${num.body.quality_rating ?? 'n/a'}`);

  if (!env.WHATSAPP_TEMPLATE_NAME) {
    result('WARN', 'Approved template', 'WHATSAPP_TEMPLATE_NAME not set — first contact to new leads cannot be sent on WhatsApp');
  } else if (!env.WHATSAPP_BUSINESS_ACCOUNT_ID) {
    result('WARN', `Template "${env.WHATSAPP_TEMPLATE_NAME}"`, 'set WHATSAPP_BUSINESS_ACCOUNT_ID in .env to check its approval status and category');
  } else {
    const t = await getJson(`${GRAPH}/${v}/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?name=${encodeURIComponent(env.WHATSAPP_TEMPLATE_NAME)}&fields=name,status,category,language`, { headers: auth });
    const tpl = t.body?.data?.find((x: any) => x.name === env.WHATSAPP_TEMPLATE_NAME && (!env.WHATSAPP_TEMPLATE_LANGUAGE || x.language === env.WHATSAPP_TEMPLATE_LANGUAGE)) ?? t.body?.data?.[0];
    if (!t.ok || !tpl) result('FAIL', `Template "${env.WHATSAPP_TEMPLATE_NAME}"`, t.ok ? 'not found' : errText(t.body));
    else
      result(
        tpl.status === 'APPROVED' ? (tpl.category === 'UTILITY' ? 'PASS' : 'WARN') : 'FAIL',
        `Template "${tpl.name}" (${tpl.language})`,
        `status ${tpl.status} · category ${tpl.category}${tpl.category === 'MARKETING' ? ' (≈7.5× the cost of UTILITY)' : ''}`,
      );
  }

  if (args['whatsapp-to']) {
    const to = normalizePhone(String(args['whatsapp-to']));
    if (!to || !env.WHATSAPP_TEMPLATE_NAME) return result('SKIP', 'Send test message', 'needs a valid --whatsapp-to and WHATSAPP_TEMPLATE_NAME');
    const params = Number(env.WHATSAPP_TEMPLATE_PARAMS ?? 1);
    const values = ['Test', 'a 2 BHK in Porur'].slice(0, params);
    const s = await getJson(`${GRAPH}/${v}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name: env.WHATSAPP_TEMPLATE_NAME, language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en' }, ...(params ? { components: [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }] } : {}) },
      }),
    });
    result(s.ok ? 'PASS' : 'FAIL', `Send template to ${mask(to)}`, s.ok ? 'sent — check your phone, then reply to test the AI' : errText(s.body));
  }
}

// ---------------------------------------------------------------- 4. Plivo
async function testPlivo() {
  head('4. Plivo');
  if (!env.PLIVO_AUTH_ID || !env.PLIVO_AUTH_TOKEN) return result('SKIP', 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not set');
  const auth = { Authorization: 'Basic ' + Buffer.from(`${env.PLIVO_AUTH_ID}:${env.PLIVO_AUTH_TOKEN}`).toString('base64') };
  const acct = await getJson(`${PLIVO}/v1/Account/${env.PLIVO_AUTH_ID}/`, { headers: auth });
  if (!acct.ok) return result('FAIL', 'Credentials', errText(acct.body));
  result('PASS', 'Credentials', `account ${acct.body.name ?? ''} · credit ${acct.body.cash_credits ?? '?'} · ${acct.body.account_type ?? ''}`);
  if (Number(acct.body.cash_credits) < 5) result('WARN', 'Low Plivo credit', `${acct.body.cash_credits}`);

  const from = normalizePhone(env.PLIVO_FROM_NUMBER);
  if (!from) return result('FAIL', 'PLIVO_FROM_NUMBER', 'not set or invalid');
  const n = await getJson(`${PLIVO}/v1/Account/${env.PLIVO_AUTH_ID}/Number/${from}/`, { headers: auth });
  if (!n.ok) return result('FAIL', `Number ${mask(from)} on this account`, errText(n.body));
  result('PASS', `Number ${mask(from)} on this account`, `voice ${n.body.voice_enabled ?? '?'} · ${n.body.number_type ?? ''}`);

  const appId = String(n.body.application ?? '').split('/').filter(Boolean).pop();
  if (!appId) return result('FAIL', 'Inbound application', 'no Plivo application linked to this number — inbound calls will not reach Tacksharp');
  const app = await getJson(`${PLIVO}/v1/Account/${env.PLIVO_AUTH_ID}/Application/${appId}/`, { headers: auth });
  if (!app.ok) return result('FAIL', 'Inbound application', errText(app.body));
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const answerOk = app.body.answer_url === `${base}/voice/inbound`;
  const hangupOk = app.body.hangup_url === `${base}/voice/hangup`;
  result(answerOk ? 'PASS' : 'FAIL', 'Plivo Answer URL', `${app.body.answer_url ?? 'missing'}${answerOk ? '' : ` (should be ${base}/voice/inbound)`}`);
  result(hangupOk ? 'PASS' : 'FAIL', 'Plivo Hangup URL', `${app.body.hangup_url ?? 'missing'}${hangupOk ? '' : ` (should be ${base}/voice/hangup — without it inbound calls get no outcome)`}`);
}

// ---------------------------------------------------------------- 5. Meta Lead Ads
async function testMeta() {
  head('5. Meta Lead Ads');
  if (!env.META_PAGE_ACCESS_TOKEN) return result('SKIP', 'META_PAGE_ACCESS_TOKEN not set');
  const v = env.META_GRAPH_API_VERSION ?? 'v23.0';
  const me = await getJson(`${GRAPH}/${v}/me?fields=id,name&access_token=${encodeURIComponent(env.META_PAGE_ACCESS_TOKEN)}`);
  if (!me.ok) return result('FAIL', 'Page access token', errText(me.body));
  result('PASS', 'Page access token', `page "${me.body.name}"`);
  const forms = await getJson(`${GRAPH}/${v}/${me.body.id}/leadgen_forms?fields=name,status&limit=10&access_token=${encodeURIComponent(env.META_PAGE_ACCESS_TOKEN)}`);
  result(forms.ok ? 'PASS' : 'WARN', 'Lead forms readable', forms.ok ? `${forms.body?.data?.length ?? 0} forms: ${(forms.body?.data ?? []).map((f: any) => `${f.name} (${f.status})`).join(', ').slice(0, 160)}` : errText(forms.body));
  const subs = await getJson(`${GRAPH}/${v}/${me.body.id}/subscribed_apps?access_token=${encodeURIComponent(env.META_PAGE_ACCESS_TOKEN)}`);
  const leadgen = (subs.body?.data ?? []).some((a: any) => (a.subscribed_fields ?? []).includes('leadgen'));
  result(leadgen ? 'PASS' : 'FAIL', 'Page subscribed to "leadgen" webhook', leadgen ? 'yes' : 'no app subscribed to leadgen — new leads will not arrive');
  if (!env.META_APP_SECRET) result('WARN', 'META_APP_SECRET', 'not set — webhook signatures are not checked');
}

// ---------------------------------------------------------------- 6. Server + live calls
let cookie = '';
const api = (p: string) => `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}${p}`;

async function login() {
  const email = env.VERIFY_EMAIL ?? env.ADMIN_EMAIL;
  const password = env.VERIFY_PASSWORD ?? env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('set VERIFY_EMAIL / VERIFY_PASSWORD (or ADMIN_EMAIL / ADMIN_PASSWORD) in .env');
  const res = await fetch(api('/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
}
const authed = (p: string, init: RequestInit = {}) => getJson(api(p), { ...init, headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) } });

async function testServer() {
  head('6. Your server (public URL)');
  if (!env.PUBLIC_BASE_URL) return result('SKIP', 'PUBLIC_BASE_URL not set');
  if (!env.PUBLIC_BASE_URL.startsWith('https://')) result('WARN', 'PUBLIC_BASE_URL', 'not https — Plivo/Meta need HTTPS in production');
  try {
    const [h, t] = await timed(() => getJson(api('/health')));
    result(h.ok && h.body?.status === 'ok' ? 'PASS' : 'FAIL', 'GET /health over the internet', `${ms(t)} · db ${h.body?.database?.ok} · redis ${h.body?.redis?.ok} · failed jobs ${(h.body?.queues?.followUp?.failed ?? 0) + (h.body?.queues?.whatsapp?.failed ?? 0)}`);
  } catch (e) {
    return result('FAIL', 'GET /health over the internet', `unreachable: ${e instanceof Error ? e.message : e}`);
  }
  const unsigned = await getJson(api('/voice/turn?callId=verify'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'CallUUID=x' });
  result(unsigned.status === 403 ? 'PASS' : 'WARN', 'Plivo endpoints reject unsigned requests', `HTTP ${unsigned.status}${unsigned.status === 403 ? '' : ' (set PLIVO_VALIDATE_SIGNATURE=true)'}`);
  const anon = await getJson(api('/leads'));
  result(anon.status === 401 ? 'PASS' : 'FAIL', 'Private API needs login', `HTTP ${anon.status}`);
  try {
    await login();
    result('PASS', 'Dashboard login', 'ok');
  } catch (e) {
    result('FAIL', 'Dashboard login', e instanceof Error ? e.message : String(e));
  }
}

async function waitForCall(find: () => Promise<any | null>, label: string, maxMs = 6 * 60_000) {
  const deadline = Date.now() + maxMs;
  let last = '';
  while (Date.now() < deadline) {
    const c = await find();
    if (c) {
      const state = `${c.status}${c.outcome ? ` / ${c.outcome}` : ''}`;
      if (state !== last) console.log(`   … ${label}: ${state}`);
      last = state;
      if (c.endedAt) return c;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

async function reportCall(callId: string, label: string) {
  const d = await authed(`/voice/calls/${callId}`);
  const call = d.body?.call;
  if (!call) return result('FAIL', label, 'call record not found');
  const answered = Boolean(call.answeredAt);
  result(answered && call.turns > 0 ? 'PASS' : 'FAIL', label, `${call.direction} · ${call.status} · outcome ${call.outcome ?? '—'} · ${call.durationSec ?? 0}s · ${call.turns} turns · language ${call.language ?? '—'}`);
  if (call.summary) note(`Summary: ${call.summary}`);
  note('Transcript:\n' + (d.body.transcript ?? []).map((m: any) => `> **${m.role === 'user' ? 'Customer' : 'AI'}:** ${m.content}`).join('\n'));
}

async function latencyReport() {
  const l = await authed('/voice/latency');
  if (!l.ok || !l.body?.turns) return note('No voice turns recorded yet.');
  const row = (n: string, s: any) => `| ${n} | ${s.p50 ?? '—'} | ${s.p95 ?? '—'} | ${s.count} |`;
  note(['\n**Real voice latency per turn (ms, since the API last started):**', '| Stage | P50 | P95 | n |', '|---|---|---|---|',
    row('Download recording', l.body.download), row('Saaras STT', l.body.stt), row('AI', l.body.ai), row('Bulbul TTS', l.body.tts), row('**Total (customer stops → reply starts)**', l.body.total)].join('\n'));
  const p95 = l.body.total.p95;
  if (p95) result(p95 <= 3000 ? 'PASS' : 'WARN', 'Voice P95 under ~3 s', `${p95} ms (+ Plivo silence detection ${env.VOICE_SILENCE_TIMEOUT ?? 2} s before this)`);
}

async function testOutboundCall() {
  head('7. REAL outbound AI call');
  const phone = normalizePhone(String(args.call));
  if (!phone) return result('FAIL', 'Outbound call', 'invalid --call number');
  if (!cookie) await login();
  const lead = await authed('/leads', { method: 'POST', body: JSON.stringify({ phone, name: 'Live Test', location: 'Porur', budget: '80 lakhs', bhk: '2', source: 'verify', startSequence: false }) });
  if (!lead.ok) return result('FAIL', 'Create test lead', errText(lead.body));
  note(`Calling ${mask(phone)} now. Answer, then say for example:`);
  note('1) "Haan sollunga, Porur la 2 BHK iruka?"  2) "Saturday 11 mani site visit pannalaama?"  3) "Seri, thanks, bye"');
  const start = await authed('/voice/call', { method: 'POST', body: JSON.stringify({ leadId: lead.body.lead.id }) });
  if (!start.body?.started) return result('FAIL', 'Dial', JSON.stringify(start.body));
  const call = await waitForCall(async () => (await authed(`/voice/calls/${start.body.callId}`)).body?.call ?? null, 'outbound call');
  if (!call) return result('FAIL', 'Outbound call', 'did not finish within 6 minutes');
  await reportCall(call.id, 'Outbound call end to end (Plivo → Saaras → AI → Bulbul)');
}

async function testInboundCall() {
  head('8. REAL inbound call');
  if (!cookie) await login();
  const since = Date.now();
  note(`Now call ${mask(normalizePhone(env.PLIVO_FROM_NUMBER))} from your phone. Say e.g. "Velachery la 2 BHK iruka?", then "Saturday site visit pannalaama?", then "bye". Waiting up to 6 minutes…`);
  const call = await waitForCall(async () => {
    const list = await authed('/voice/calls');
    return (list.body ?? []).find((c: any) => c.direction === 'inbound' && new Date(c.createdAt).getTime() >= since - 5000) ?? null;
  }, 'inbound call');
  if (!call) return result('FAIL', 'Inbound call', 'no inbound call arrived — check the Plivo Answer URL (section 4)');
  await reportCall(call.id, 'Inbound call end to end (customer → Plivo → AI → customer)');
}

// ---------------------------------------------------------------- main
async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log('Tacksharp live verification — real providers, your keys stay on this machine.');
  if (want('ai')) await testAi();
  if (want('sarvam')) await testSarvam();
  if (want('whatsapp')) await testWhatsApp();
  if (want('plivo')) await testPlivo();
  if (want('meta')) await testMeta();
  if (want('server')) await testServer();
  if (args.call) await testOutboundCall().catch((e) => result('FAIL', 'Outbound call', String(e?.message ?? e)));
  if (args.inbound) await testInboundCall().catch((e) => result('FAIL', 'Inbound call', String(e?.message ?? e)));
  if ((args.call || args.inbound) && cookie) await latencyReport();

  const count = (s: Status) => report.filter((r) => r.status === s).length;
  const header = [
    '# Tacksharp live verification report',
    `Run: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · node ${process.version}`,
    `**${count('PASS')} passed · ${count('FAIL')} failed · ${count('WARN')} warnings · ${count('SKIP')} skipped**`,
    'No API keys, tokens or full phone numbers are included. Safe to share.',
  ].join('\n\n');
  const file = path.join(OUT, 'verify-report.md');
  await fs.writeFile(file, `${header}\n${lines.join('\n')}\n`);
  console.log(`\n${count('PASS')} passed · ${count('FAIL')} failed · ${count('WARN')} warnings · ${count('SKIP')} skipped`);
  console.log(`Report: ${file}  (send this file — it contains no secrets)`);
  process.exit(count('FAIL') ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
