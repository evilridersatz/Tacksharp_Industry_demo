export const AGENT_NAMES = ['marketing', 'sales', 'finance', 'operations'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export type TaskStatus = 'PENDING' | 'RUNNING' | 'NEEDS_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type Trigger = 'event' | 'user' | 'schedule' | 'handoff';

/** Typed tools. An agent can only call the tools listed for it in AGENTS (checked on the server for every call). */
export type ToolName =
  | 'catalogue.read'
  | 'inventory.read'
  | 'inventory.reserve'
  | 'inventory.release'
  | 'inventory.dispatch'
  | 'orders.read'
  | 'quotations.read'
  | 'leads.read'
  | 'invoices.read'
  | 'invoices.write'
  | 'payments.read'
  | 'worktask.create'
  | 'segments.read'
  | 'campaigns.read'
  | 'campaigns.write'
  | 'campaigns.send'
  | 'content.write'
  | 'quality.read';

export type Handoff = { kind: string; input: Record<string, unknown>; reason: string; entity?: { type: string; id: string } };

export type HandlerOutcome =
  | { status: 'completed'; summary: string; result: Record<string, unknown>; handoffs?: Handoff[] }
  | {
      status: 'needs_approval';
      action: string;
      reason: string;
      payload: Record<string, unknown>;
      requiredPermission: string;
      entity: { type: string; id: string };
    };

export type AgentContext = {
  organizationId: string;
  taskId: string;
  agent: AgentName;
  actor: string;
  /** True when this run follows an approved request for this task. */
  approved: boolean;
  /** Runs `fn` only if this agent may use `tool`; records the call in the task history. */
  tool<T>(tool: ToolName, fn: () => Promise<T>, note?: string): Promise<T>;
  note(message: string, data?: Record<string, unknown>): Promise<void>;
};

export type TaskKind<I extends Record<string, unknown> = Record<string, unknown>> = {
  kind: string;
  agent: AgentName;
  label: string;
  description: string;
  /** Can a person start it from the Agent Centre (otherwise: events / handoffs only). */
  userRunnable: boolean;
  /** Validate and normalise untrusted input (from a request, an event or another agent). */
  parse(raw: unknown): I;
  /** The business record the task is about, for the dashboard. */
  entity?(input: I): { type: string; id: string } | undefined;
  run(ctx: AgentContext, input: I): Promise<HandlerOutcome>;
  timeoutMs?: number;
  maxAttempts?: number;
};

export type AgentDefinition = {
  name: AgentName;
  label: string;
  purpose: string;
  tools: ToolName[];
  /** What is built and running now vs. planned - shown as-is in the Agent Centre (no pretending). */
  implemented: string[];
  notYetBuilt: string[];
};
