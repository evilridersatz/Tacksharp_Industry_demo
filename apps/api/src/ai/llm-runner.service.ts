import { Injectable, Optional } from '@nestjs/common';
import { user, assistant, type Agent, type AgentInputItem } from '@openai/agents';
import { PrismaService } from '../prisma/prisma.service.js';
import { openaiRunner } from '../integrations/openai-runner.js';
import type { Channel, TacksharpAgentContext, Toolset } from 'ai/agents/real-estate-agent.js';
import { errorMessage, log } from '../common/logger.js';
import type { SessionMessage } from '../conversation/session.js';

/**
 * Measurement for one AI turn: how many OpenAI requests, tokens, and how much of the time was
 * our own tool code rather than the model.
 */
export type AiUsageMetrics = {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  perRequest?: Array<{ endpoint?: string; inputTokens: number; outputTokens: number }>;
  toolCalls?: Array<{ name: string; ms: number }>;
  toolMs?: number;
  pureAiMs?: number;
  firstToolCallMs?: number;
};

export type LlmRun = {
  text: string;
  failed: boolean;
  aborted: boolean;
  error?: string;
  usage: AiUsageMetrics;
};

const AI_TIMEOUT_MS: Record<Channel, number> = { whatsapp: 45_000, voice: 15_000, web: 45_000 };

/** Thin wrapper around the OpenAI Agents SDK so the engine (and tests) deal with one small interface. */
@Injectable()
export class LlmRunner {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async run(args: {
    channel: Channel;
    toolset: Toolset;
    context: TacksharpAgentContext;
    history: Array<Pick<SessionMessage, 'role' | 'content'>>;
    message: string;
    maxTurns?: number;
    /**
     * The agent to run — always passed by the caller's own engine (real estate or restaurant). There is no default:
     * a missing agent must never silently become the real-estate agent (with its property tools) for another product.
     */
    agent: Agent<any>;
  }): Promise<LlmRun> {
    const { channel, context } = args;
    const items: AgentInputItem[] = args.history.map((m) => (m.role === 'user' ? user(m.content) : assistant(m.content)));
    items.push(user(args.message));

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), AI_TIMEOUT_MS[channel]);

    // One Runner per call, so concurrent calls never mix up each other's timings. The organization's own OpenAI key
    // and model when it configured one; the deployment's default otherwise; none for a self-service organization
    // without a key (the engine's non-AI fallback answers).
    const acct = await openaiRunner();
    if (!acct.runner) {
      clearTimeout(timeout);
      return { text: '', failed: true, aborted: false, error: `openai_not_configured: ${acct.reason ?? ''}`, usage: {} };
    }
    const runner = acct.runner;
    const toolStarts = new Map<string, { name: string; startedAt: number }>();
    const toolCalls: Array<{ name: string; ms: number }> = [];
    const key = (toolCall: unknown): string => {
      const t = toolCall as Record<string, unknown>;
      return typeof t.callId === 'string' ? t.callId : typeof t.id === 'string' ? t.id : 'unknown';
    };
    runner.on('agent_tool_start', (_c, _a, tool, details) => {
      toolStarts.set(key(details.toolCall), { name: tool.name, startedAt: Date.now() });
    });
    runner.on('agent_tool_end', (_c, _a, tool, _r, details) => {
      const started = toolStarts.get(key(details.toolCall));
      if (started) toolCalls.push({ name: tool.name, ms: Date.now() - started.startedAt });
    });

    const startedAt = Date.now();
    let text = '';
    let failed = false;
    let error: string | undefined;
    let usage: { requests?: number; inputTokens?: number; outputTokens?: number; requestUsageEntries?: Array<{ endpoint?: string; inputTokens: number; outputTokens: number }> } | undefined;
    try {
      const result = await runner.run(args.agent, items, {
        context,
        maxTurns: args.maxTurns ?? 4,
        signal: abort.signal,
      });
      text = String(result.finalOutput ?? '').trim();
      usage = result.runContext?.usage;
    } catch (e) {
      failed = true;
      error = errorMessage(e);
      log.error('ai.run_failed', { channel, error, aborted: abort.signal.aborted });
    } finally {
      clearTimeout(timeout);
    }

    // Usage per organization (tokens; which account served it). Never the prompt or the reply.
    if (this.prisma && acct.organizationId) {
      void this.prisma.integrationEvent
        .create({ data: { organizationId: acct.organizationId, provider: 'openai', kind: 'chat', ok: !failed, latencyMs: Date.now() - startedAt, errorCode: failed ? 'run_failed' : null, message: failed ? (error ?? '').slice(0, 300) : null, units: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || null, unitType: 'tokens', source: acct.source } })
        .catch(() => undefined);
    }
    const agentMs = Date.now() - startedAt;
    const toolMs = toolCalls.reduce((s, c) => s + c.ms, 0);
    return {
      text,
      failed,
      aborted: abort.signal.aborted,
      error,
      usage: {
        requests: usage?.requests,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        perRequest: usage?.requestUsageEntries?.map((r) => ({ endpoint: r.endpoint, inputTokens: r.inputTokens, outputTokens: r.outputTokens })),
        toolCalls,
        toolMs,
        pureAiMs: Math.max(0, agentMs - toolMs),
        firstToolCallMs: toolStarts.size ? Math.min(...[...toolStarts.values()].map((v) => v.startedAt)) - startedAt : undefined,
      },
    };
  }
}
