import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { TacksharpAgentContext } from '../types.js';
import { ctx, safe } from './helpers.js';

export const updateCustomerMemory = tool({
  name: 'update_customer_memory',
  description:
    'Save a fact the customer explicitly stated in THEIR LAST MESSAGE and that is not already in KNOWN (name, area, budget, BHK, type, timeline, objection). Pass budget and bhk as spoken ("80 lakhs", "2BHK"). Never guess.',
  parameters: z.object({
    name: z.string().optional(),
    location: z.string().optional(),
    budget: z.string().optional().describe('As spoken, e.g. "80 lakhs", "1 crore"'),
    bhk: z.string().optional().describe('As spoken, e.g. "2BHK"'),
    propertyType: z.string().optional().describe('Apartment | Villa | Plot | House | Commercial'),
    purchaseTimeline: z.string().optional().describe('e.g. "within 3 months"'),
    objection: z.string().optional().describe('Customer concern, e.g. "price too high"'),
  }),
  async execute(update, runContext?: RunContext<TacksharpAgentContext>) {
    const c = ctx(runContext);
    return safe(() => c.updateCustomerMemory(update));
  },
});
