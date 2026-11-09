import type { Role } from '../agents/roles.js';
import { OBLIGING, type OutMessage } from '../agents/step-output.js';

/**
 * Rules for agent-to-agent messages (pure; the engine is the only writer of message rows, so agents never write each
 * other's state: an agent's message is an outbox entry, and the engine decides whether and how it is delivered).
 */
export type Delivery =
  | { kind: 'deliver'; message: OutMessage }
  | { kind: 'delegate'; message: OutMessage }
  | { kind: 'refuse'; message: OutMessage; reason: string; escalate: boolean };

export type MailboxState = {
  from: Role;
  /** Roles this agent may message (its configuration). */
  canMessage: Role[];
  /** Roles switched on (a message to a switched-off agent cannot be delivered). */
  enabled: Role[];
  /** Messages already in this conversation (the plan): the hop counter. */
  hops: number;
  hopCap: number;
  /** Delegation depth of the sending task. */
  depth: number;
  maxDepth: number;
  /** Roles in the sending task's ancestry, itself included (a delegation back to one of them is a loop). */
  ancestry: Role[];
};

export function route(messages: OutMessage[], s: MailboxState): Delivery[] {
  let hops = s.hops;
  return messages.map((m): Delivery => {
    if (m.to === s.from) return { kind: 'refuse', message: m, reason: 'an agent cannot message itself', escalate: false };
    if (!s.canMessage.includes(m.to)) return { kind: 'refuse', message: m, reason: `${s.from} may not message ${m.to}`, escalate: false };
    if (!s.enabled.includes(m.to)) return { kind: 'refuse', message: m, reason: `the ${m.to} agent is switched off or paused`, escalate: false };
    if (hops + 1 > s.hopCap) return { kind: 'refuse', message: m, reason: `hop cap reached (${s.hopCap} messages in this plan)`, escalate: true };
    hops += 1;
    if (!OBLIGING.includes(m.act)) return { kind: 'deliver', message: m };
    if (s.depth + 1 > s.maxDepth) return { kind: 'refuse', message: m, reason: `delegation too deep (${s.depth + 1} > ${s.maxDepth})`, escalate: true };
    if (s.ancestry.includes(m.to)) return { kind: 'refuse', message: m, reason: `delegating back to ${m.to} would make a loop`, escalate: true };
    return { kind: 'delegate', message: m };
  });
}
