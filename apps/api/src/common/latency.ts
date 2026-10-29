/**
 * Rolling per-stage latency for voice turns (last 500 turns, in memory).
 * Used for P50 / P95 reporting; every turn is also in the structured logs.
 */
export type TurnTimings = {
  downloadMs?: number;
  sttMs?: number;
  aiMs?: number;
  /** ms spent in the two blocking DB writes between the AI reply and TTS starting (Call + Customer updates). */
  postAiDbMs?: number;
  ttsMs?: number;
  totalMs: number;
  /** Count of separate OpenAI requests this turn made (from the Agents SDK's usage tracking). */
  aiRequests?: number;
  /** ms spent inside tool calls (our own DB code) during the AI step, summed. */
  toolMs?: number;
  /** aiMs minus toolMs — the closest available estimate of pure OpenAI time without streaming. */
  pureAiMs?: number;
  /** ms from the AI step starting to its first tool call, when at least one tool was called. */
  firstToolCallMs?: number;
  /** ms spent sending the reply (WhatsApp Cloud API call). */
  sendMs?: number;
  /** WhatsApp: time between our webhook receiving the message and a worker starting on it (queue wait). */
  queueWaitMs?: number;
  /** WhatsApp: the customer's send time (Meta timestamp, 1 s resolution) to our webhook receiving it. */
  providerDelayMs?: number;
  /** Which path produced the reply: deterministic rules (no model) or the language model. */
  path?: 'rules' | 'llm';
};

export type LatencyChannel = 'voice' | 'whatsapp';

const MAX = 500;
const samplesByChannel: Record<LatencyChannel, TurnTimings[]> = { voice: [], whatsapp: [] };

export function recordTurn(t: TurnTimings, channel: LatencyChannel = 'voice') {
  const list = samplesByChannel[channel];
  list.push(t);
  if (list.length > MAX) list.shift();
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function latencyStats(channel: LatencyChannel = 'voice') {
  const samples = samplesByChannel[channel];
  const stage = (key: keyof TurnTimings) => {
    const values = samples.map((s) => s[key]).filter((v): v is number => typeof v === 'number');
    return { p50: percentile(values, 50), p95: percentile(values, 95), count: values.length };
  };
  const total = (path: 'rules' | 'llm') => {
    const values = samples.filter((s) => s.path === path).map((s) => s.totalMs);
    return { p50: percentile(values, 50), p95: percentile(values, 95), count: values.length };
  };
  return {
    channel,
    turns: samples.length,
    send: stage('sendMs'),
    queueWait: stage('queueWaitMs'),
    providerDelay: stage('providerDelayMs'),
    /** Total latency split by whether the reply came from rules (no model request) or the model. */
    byPath: { rules: total('rules'), llm: total('llm') },
    download: stage('downloadMs'),
    stt: stage('sttMs'),
    ai: stage('aiMs'),
    postAiDb: stage('postAiDbMs'),
    tts: stage('ttsMs'),
    total: stage('totalMs'),
    // Breaks the "ai" stage above down further: how much was OpenAI itself vs. our own tool/DB code.
    aiRequests: stage('aiRequests'),
    toolMs: stage('toolMs'),
    pureAi: stage('pureAiMs'),
    firstToolCall: stage('firstToolCallMs'),
  };
}

/** P50 / P95 for every channel (GET /ai/latency). Voice totals exclude time Plivo spends before calling our webhook. */
export function latencyByChannel() {
  return { voice: latencyStats('voice'), whatsapp: latencyStats('whatsapp') };
}

export function resetLatency() {
  samplesByChannel.voice.length = 0;
  samplesByChannel.whatsapp.length = 0;
}
