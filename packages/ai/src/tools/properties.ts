import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { TacksharpAgentContext } from '../types.js';
import { ctx, safe } from './helpers.js';

export const searchProperties = tool({
  name: 'search_properties',
  description:
    'Search the business inventory when the customer changes what they want (another area, BHK, type or budget). maxBudget is in rupees (80 lakhs = 8000000). Only properties returned here may be mentioned.',
  parameters: z.object({
    location: z.string().optional(),
    bhk: z.number().int().positive().optional(),
    propertyType: z.string().optional(),
    maxBudget: z.number().positive().optional(),
  }),
  async execute(query, runContext?: RunContext<TacksharpAgentContext>) {
    const c = ctx(runContext);
    return safe(() => c.searchProperties(query));
  },
});

/**
 * The model can only PROPOSE. The application validates the property, date and time, stores a
 * pending proposal and returns the exact confirmation question. Booking happens later, in code,
 * and only when the customer's next message is an explicit yes.
 */
export const proposeSiteVisit = tool({
  name: 'propose_site_visit',
  description:
    'Propose a site visit when the customer wants to visit AND you know the property (from VERIFIED PROPERTIES) AND the date AND the time they asked for. scheduledAt is ISO-8601 with +05:30, resolved from NOW. This does NOT book anything; the system will ask the customer to confirm. If the date or time is missing, do not call this - ask for it.',
  parameters: z.object({
    propertyId: z.string().min(1),
    scheduledAt: z.string().datetime({ offset: true }),
  }),
  async execute(input, runContext?: RunContext<TacksharpAgentContext>) {
    const c = ctx(runContext);
    try {
      const result = await c.proposeSiteVisit(input);
      c.replyOverride = result.reply;
      // The tool result is the final reply (the agent stops at this tool), so no second model request is needed.
      return result.reply;
    } catch (error) {
      c.replyOverride = undefined;
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
