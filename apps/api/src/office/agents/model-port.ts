import { Agent, MaxTurnsExceededError, tool } from '@openai/agents';
import { openaiRunner } from '../../integrations/openai-runner.js';
import { runInProviderScope } from '../../integrations/provider-scope.js';
import { configureClient, modelSettings } from 'ai/agents/real-estate-agent.js';
import type { JsonSchema } from '../tools/contract.js';

export type Usage = { tokensIn: number; tokensOut: number; cachedIn: number; requests: number };
export type StepTool = { name: string; description: string; schema: JsonSchema; invoke(args: unknown): Promise<string> };
export type StepRequest = {
  organizationId: string;
  model: string;
  instructions: string;
  input: string;
  tools: StepTool[];
  /** Model turns allowed in this step (each tool round-trip is a turn). */
  maxTurns: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Checked after every tool round: true ends the step at once (a tool asked for approval, a budget broke). */
  shouldStop: () => boolean;
};
export type StepResponse = { text: string; usage: Usage; turnsExhausted: boolean; stopped: boolean };

/**
 * The only door to a language model. The engine never lets a model act directly: the model sees the tools below,
 * every tool call goes back through the office registry, and its final text is parsed and checked by code.
 */
export interface ModelPort {
  run(req: StepRequest): Promise<StepResponse>;
}

export class NoModelError extends Error {}

/** OpenAI Agents SDK, with the organization's own key (or the deployment's), one bounded run per step. */
export class OpenAIModelPort implements ModelPort {
  async run(req: StepRequest): Promise<StepResponse> {
    return runInProviderScope(req.organizationId, async () => {
      const acct = await openaiRunner();
      if (!acct.runner) throw new NoModelError('No AI model is configured for this workspace (Integrations → OpenAI).');
      configureClient();
      let stopped = false;
      const agent = new Agent({
        name: 'Office agent',
        model: req.model,
        modelSettings: { ...modelSettings('low', req.maxOutputTokens), parallelToolCalls: false },
        instructions: req.instructions,
        tools: req.tools.map((t) =>
          tool({ name: t.name, description: t.description, parameters: t.schema as never, strict: false, execute: async (args: unknown) => t.invoke(args) }),
        ),
        toolUseBehavior: (_ctx, results) => {
          if (req.shouldStop()) {
            stopped = true;
            return { isFinalOutput: true, isInterrupted: undefined, finalOutput: JSON.stringify({ status: 'blocked', summary: 'Stopped by the office engine.', last: results.map((r) => r.tool.name) }) } as never;
          }
          return { isFinalOutput: false, isInterrupted: undefined } as never;
        },
      });
      const usageOf = (u: { inputTokens?: number; outputTokens?: number; requests?: number; inputTokensDetails?: Array<Record<string, number>> } | undefined): Usage => ({
        tokensIn: u?.inputTokens ?? 0,
        tokensOut: u?.outputTokens ?? 0,
        cachedIn: (u?.inputTokensDetails ?? []).reduce((a, d) => a + (d.cached_tokens ?? 0), 0),
        requests: u?.requests ?? 0,
      });
      try {
        const r = await acct.runner.run(agent, req.input, { maxTurns: req.maxTurns, signal: AbortSignal.timeout(req.timeoutMs) });
        return { text: String(r.finalOutput ?? ''), usage: usageOf(r.runContext?.usage), turnsExhausted: false, stopped };
      } catch (e) {
        if (e instanceof MaxTurnsExceededError) {
          const u = (e as { state?: { _context?: { usage?: Parameters<typeof usageOf>[0] } } }).state?._context?.usage;
          return { text: '', usage: usageOf(u), turnsExhausted: true, stopped };
        }
        throw e;
      }
    });
  }
}
