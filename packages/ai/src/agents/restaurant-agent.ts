import { Agent } from '@openai/agents';
import type { Channel } from '../types.js';
import { configureClient, modelSettings } from './real-estate-agent.js';

/**
 * Restaurant (food ordering) assistant.
 *
 * SAFETY MODEL: this agent has NO tools. It only phrases an answer to a free-form question the
 * application's rules could not answer, from the VERIFIED MENU and OUTLETS the application puts in
 * the brief. Carts, prices, totals, order creation, payment and order status are handled entirely
 * by application code (apps/api/src/restaurant). The application also removes any reply sentence
 * that mentions a price not on the verified menu.
 */
export type RestaurantAgentContext = {
  organizationName: string;
  channel: Channel;
  nowText: string;
  /** Verified menu, outlets and the customer's current cart, rendered by the application. */
  brief: string;
};

function instructions(c: RestaurantAgentContext): string {
  return `You are the AI ordering assistant of ${c.organizationName}, a chicken restaurant in Chennai, chatting on ${
    c.channel === 'web' ? 'the website' : 'WhatsApp'
  }.
NOW: ${c.nowText}

${c.brief}

RULES
- 1-3 short lines. Answer the customer's question directly, then point them back to ordering.
- Mention ONLY items, prices, outlets and timings listed above. Never invent dishes, prices, offers, discounts, delivery times or availability.
- You cannot add items to the cart, take payment, confirm, cancel or change orders. To order, the customer types items with quantities (e.g. "2 chicken biryani"); to finish they type "checkout".
- Never say an order is placed, paid, accepted by the restaurant or out for delivery.
- If you do not know, say a staff member can help and that they can type "talk to staff".
- If asked, say you are an AI assistant. Reply in the customer's language (English or Tanglish).`;
}

const agents = new Map<string, Agent<RestaurantAgentContext>>();

export function getRestaurantAgent(channel: Channel): Agent<RestaurantAgentContext> {
  configureClient();
  const existing = agents.get(channel);
  if (existing) return existing;
  const agent = new Agent<RestaurantAgentContext>({
    name: `Tacksharp Restaurant Agent (${channel})`,
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    modelSettings: modelSettings(process.env.OPENAI_REASONING_EFFORT || 'low'),
    instructions: (runContext) => instructions(runContext.context),
    tools: [],
  });
  agents.set(channel, agent);
  return agent;
}

/** True when a model is configured (OpenAI key or a local OpenAI-compatible server such as llama.cpp). */
export function llmConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL);
}
