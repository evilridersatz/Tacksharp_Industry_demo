import OpenAI from 'openai';
import {
  Agent,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTracingDisabled,
  type ModelSettings,
} from '@openai/agents';

import type { Channel, TacksharpAgentContext } from '../types.js';
import { buildInstructions } from './instructions.js';
import { updateCustomerMemory } from '../tools/customer.js';
import { searchProperties, proposeSiteVisit } from '../tools/properties.js';

export * from '../types.js';

/*
 * Model configuration (all via .env):
 *   OPENAI_MODEL              default model for WhatsApp            (default gpt-5.4-mini)
 *   OPENAI_VOICE_MODEL        model for phone calls                 (default = OPENAI_MODEL)
 *   OPENAI_REASONING_EFFORT   for reasoning models: none|minimal|low|medium (default low). Set "off" for non-reasoning models.
 *   OPENAI_VOICE_REASONING_EFFORT                                    (default = OPENAI_REASONING_EFFORT)
 *   OPENAI_VOICE_MAX_TOKENS   output cap for phone replies, reasoning included (default 500)
 *   OPENAI_BASE_URL           set to use a local OpenAI-compatible server (llama.cpp / Qwen).
 *                             Switches the SDK to the Chat Completions API automatically.
 */
let configured = false;
function configureClient() {
  if (configured) return;
  configured = true;

  if (process.env.OPENAI_BASE_URL) {
    setDefaultOpenAIClient(
      new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY || 'local',
      }),
    );
    setOpenAIAPI('chat_completions');
  }
  if (process.env.OPENAI_TRACING !== 'true') {
    setTracingDisabled(true);
  }
}

function modelSettings(effort: string | undefined, maxTokens?: number): ModelSettings {
  const base: ModelSettings = { parallelToolCalls: true, ...(maxTokens ? { maxTokens } : {}) };
  if (!effort || effort === 'off') return base;
  return {
    ...base,
    reasoning: { effort: effort as NonNullable<NonNullable<ModelSettings['reasoning']>['effort']> },
  };
}

/**
 * Which tools the model sees depends on the conversation state (decided by the application):
 *   none       - plain reply, ONE model request (qualification, confirmation, small talk)
 *   memory     - the application's rules found nothing to save; let the model capture a fact
 *   discussion - properties shown: may refine the search or propose a visit
 *   proposal   - the customer wants a visit: may only propose
 * Every toolset that contains propose_site_visit stops the run at that tool, so a proposal is
 * still a single model request.
 */
export type Toolset = 'none' | 'memory' | 'discussion' | 'discussion_memory' | 'proposal';

const TOOLS = {
  none: [],
  memory: [updateCustomerMemory],
  discussion: [searchProperties, proposeSiteVisit],
  discussion_memory: [updateCustomerMemory, searchProperties, proposeSiteVisit],
  proposal: [proposeSiteVisit],
} as const;

const agents = new Map<string, Agent<TacksharpAgentContext>>();

export function getRealEstateAgent(channel: Channel, toolset: Toolset = 'none'): Agent<TacksharpAgentContext> {
  configureClient();
  const cacheKey = `${channel}:${toolset}`;
  const existing = agents.get(cacheKey);
  if (existing) return existing;

  const baseModel = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const baseEffort = process.env.OPENAI_REASONING_EFFORT || 'low';
  const isVoice = channel === 'voice';
  const tools = [...TOOLS[toolset]];

  const agent = new Agent<TacksharpAgentContext>({
    name: `Tacksharp Real Estate Agent (${cacheKey})`,
    model: isVoice ? process.env.OPENAI_VOICE_MODEL || baseModel : baseModel,
    // Voice: a spoken reply is one or two short sentences, so the output is capped (reasoning tokens count too, so the
    // cap is generous: OPENAI_VOICE_MAX_TOKENS, default 500). Lower OPENAI_VOICE_REASONING_EFFORT (e.g. minimal) for
    // speed once verified with your model via `npm run verify:live`.
    modelSettings: isVoice
      ? modelSettings(process.env.OPENAI_VOICE_REASONING_EFFORT || baseEffort, Number(process.env.OPENAI_VOICE_MAX_TOKENS) || 500)
      : modelSettings(baseEffort),
    instructions: (runContext) => buildInstructions(runContext.context),
    tools,
    ...(tools.some((t) => t.name === 'propose_site_visit')
      ? { toolUseBehavior: { stopAtToolNames: ['propose_site_visit'] } }
      : {}),
  });

  agents.set(cacheKey, agent);
  return agent;
}
