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
  const where = c.channel === 'voice' ? 'on a phone call' : c.channel === 'web' ? 'on the website' : 'on WhatsApp';
  return `You are the AI ordering assistant of ${c.organizationName}, a fresh chicken shop in Chennai (raw chicken by the kg, cut to order, pickup at the shop), talking to a customer ${where}.
NOW: ${c.nowText}

${c.brief}

RULES
- ${c.channel === 'voice' ? '1-2 short spoken sentences in natural Chennai Tamil written in Tamil script (English words in English letters). No lists, symbols or emoji.' : '1-3 short lines.'} Answer the customer's question directly, then point them back to ordering.
- Mention ONLY products, prices, cuts, shops and timings listed above. Never invent products, prices, offers, discounts, stock, delivery, ready times or availability. There is no delivery: orders are collected at the shop.
- You cannot add items, take payment, confirm, cancel or change orders. To order, the customer just says which chicken, how many kg, which cut, how they will pay and when they will collect; the application confirms.
- Never say an order is placed, paid, ready or accepted by the shop.
- If you do not know, say the shop staff can help (the customer can ${c.channel === 'voice' ? 'ask to speak to staff' : 'send "staff"'}).
- If asked, say you are an AI assistant. Reply in the customer's language (Tamil, Tanglish or English).`;
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
