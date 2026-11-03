/**
 * Workflow definition (Visual Workflow Studio): one trigger, then a tree of steps. A "condition" step has a Yes and a
 * No branch (each a list of steps); every other step continues with the next one in its list. Everything here is pure
 * (validation, navigation, condition evaluation) so the engine and the tests share it.
 */

export const TRIGGERS = ['lead_created', 'order_completed', 'stage_reached', 'needs_human', 'message_keyword'] as const;
export type TriggerType = (typeof TRIGGERS)[number];
export type Trigger = { type: TriggerType; stage?: string; keywords?: string[] };

export const STEP_TYPES = ['condition', 'wait', 'send_whatsapp', 'ai_call', 'set_stage', 'add_tag', 'assign_team', 'create_task', 'enroll_drip'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const CONDITION_FIELDS = ['customer.stage', 'customer.tag', 'customer.language', 'customer.source', 'customer.has_email', 'customer.whatsapp_consent', 'order.total', 'trigger.channel'] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];
export const CONDITION_OPS = ['eq', 'neq', 'gt', 'lt', 'contains', 'is_true', 'is_false'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type Step =
  | { id: string; type: 'condition'; field: ConditionField; op: ConditionOp; value?: string; yes: Step[]; no: Step[] }
  | { id: string; type: 'wait'; minutes: number }
  | { id: string; type: 'send_whatsapp'; text?: string; templateName?: string; templateLanguage?: string }
  | { id: string; type: 'ai_call' }
  | { id: string; type: 'set_stage'; stage: string }
  | { id: string; type: 'add_tag'; tag: string }
  | { id: string; type: 'assign_team'; reason?: string }
  | { id: string; type: 'create_task'; title: string; dueInDays?: number }
  | { id: string; type: 'enroll_drip'; sequenceId: string };

export type Graph = { trigger: Trigger; steps: Step[] };
/** Position of a step: indexes into lists, with 'yes' / 'no' to enter a condition's branch, e.g. [2, 'yes', 0]. */
export type Path = Array<number | 'yes' | 'no'>;

export const MAX_STEPS = 40;
export const MAX_DEPTH = 4;
export const MAX_WAIT_MINUTES = 60 * 24 * 60; // 60 days
const STAGES = ['new', 'interested', 'qualified', 'converted', 'lost'];

/** Validates and normalises a graph. Errors are keyed by step id (or "trigger" / "steps"). */
export function validateGraph(input: unknown): { graph: Graph; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const raw = (input ?? {}) as { trigger?: Record<string, unknown>; steps?: unknown };
  const t = raw.trigger ?? {};
  const type = String(t.type ?? '') as TriggerType;
  const trigger: Trigger = { type };
  if (!(TRIGGERS as readonly string[]).includes(type)) errors.trigger = 'Choose what starts the workflow';
  if (type === 'stage_reached') {
    const stage = String(t.stage ?? '');
    if (!STAGES.slice(1).includes(stage)) errors.trigger = 'Choose the stage that starts the workflow';
    trigger.stage = stage;
  }
  if (type === 'message_keyword') {
    const kws = (Array.isArray(t.keywords) ? t.keywords : []).map((k) => String(k).trim().toLowerCase()).filter((k) => k.length >= 2 && k.length <= 40).slice(0, 10);
    if (!kws.length) errors.trigger = 'Add at least one keyword (2-40 characters)';
    trigger.keywords = [...new Set(kws)];
  }
  let count = 0;
  const ids = new Set<string>();
  const walk = (list: unknown, depth: number): Step[] => {
    if (!Array.isArray(list)) return [];
    const out: Step[] = [];
    for (const r of list) {
      const s = (r ?? {}) as Record<string, unknown>;
      count++;
      let id = typeof s.id === 'string' && /^[\w-]{1,40}$/.test(s.id) ? s.id : `s${count}`;
      while (ids.has(id)) id = `${id}_${count}`;
      ids.add(id);
      const err = (m: string) => (errors[id] ??= m);
      switch (s.type) {
        case 'condition': {
          const field = String(s.field) as ConditionField;
          const op = String(s.op) as ConditionOp;
          if (!(CONDITION_FIELDS as readonly string[]).includes(field)) err('Choose what to check');
          if (!(CONDITION_OPS as readonly string[]).includes(op)) err('Choose how to compare');
          const value = typeof s.value === 'string' ? s.value.trim().slice(0, 100) : s.value === undefined || s.value === null ? '' : String(s.value).slice(0, 100);
          if (!['is_true', 'is_false'].includes(op) && !value) err('Enter the value to compare with');
          if ((op === 'gt' || op === 'lt') && !Number.isFinite(Number(value))) err('A number is needed for greater / less than');
          if (depth >= MAX_DEPTH) err(`Conditions can be nested at most ${MAX_DEPTH} deep`);
          out.push({ id, type: 'condition', field, op, ...(value ? { value } : {}), yes: walk(s.yes, depth + 1), no: walk(s.no, depth + 1) });
          break;
        }
        case 'wait': {
          const minutes = Math.round(Number(s.minutes));
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WAIT_MINUTES) err('Wait between 1 minute and 60 days');
          out.push({ id, type: 'wait', minutes: Number.isFinite(minutes) ? minutes : 0 });
          break;
        }
        case 'send_whatsapp': {
          const text = typeof s.text === 'string' ? s.text.trim().slice(0, 1000) : '';
          const templateName = typeof s.templateName === 'string' ? s.templateName.trim() : '';
          if (!text && !templateName) err('Write a message or name an approved template');
          if (templateName && !/^[a-z0-9_]{1,512}$/.test(templateName)) err('Template names are lower-case letters, digits and _');
          const templateLanguage = typeof s.templateLanguage === 'string' && /^[a-z]{2}(_[A-Z]{2})?$/.test(s.templateLanguage) ? s.templateLanguage : undefined;
          out.push({ id, type: 'send_whatsapp', ...(text ? { text } : {}), ...(templateName ? { templateName, templateLanguage: templateLanguage ?? 'en' } : {}) });
          break;
        }
        case 'ai_call':
          out.push({ id, type: 'ai_call' });
          break;
        case 'set_stage': {
          const stage = String(s.stage ?? '');
          if (!STAGES.includes(stage)) err('Choose a stage');
          out.push({ id, type: 'set_stage', stage });
          break;
        }
        case 'add_tag': {
          const tag = String(s.tag ?? '').trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(tag)) err('Tag: letters, digits, space, - or _ (up to 40)');
          out.push({ id, type: 'add_tag', tag });
          break;
        }
        case 'assign_team': {
          const reason = typeof s.reason === 'string' ? s.reason.trim().slice(0, 200) : '';
          out.push({ id, type: 'assign_team', ...(reason ? { reason } : {}) });
          break;
        }
        case 'create_task': {
          const title = typeof s.title === 'string' ? s.title.trim().slice(0, 200) : '';
          const dueInDays = s.dueInDays === undefined || s.dueInDays === '' || s.dueInDays === null ? undefined : Math.round(Number(s.dueInDays));
          if (!title) err('Give the task a title');
          if (dueInDays !== undefined && (!Number.isFinite(dueInDays) || dueInDays < 0 || dueInDays > 365)) err('Due in 0-365 days');
          out.push({ id, type: 'create_task', title, ...(dueInDays !== undefined && Number.isFinite(dueInDays) ? { dueInDays } : {}) });
          break;
        }
        case 'enroll_drip': {
          const sequenceId = typeof s.sequenceId === 'string' ? s.sequenceId : '';
          if (!sequenceId) err('Choose a drip sequence');
          out.push({ id, type: 'enroll_drip', sequenceId });
          break;
        }
        default:
          err('Unknown step type');
      }
    }
    return out;
  };
  const steps = walk(raw.steps, 0);
  if (!steps.length && !errors.steps) errors.steps = 'Add at least one step';
  if (count > MAX_STEPS) errors.steps = `At most ${MAX_STEPS} steps`;
  return { graph: { trigger, steps }, errors };
}

/** The step at a path, or undefined. */
export function stepAt(steps: Step[], path: Path): Step | undefined {
  let list: Step[] = steps;
  let cur: Step | undefined;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (typeof p === 'number') {
      cur = list[p];
      if (!cur) return undefined;
    } else {
      if (!cur || cur.type !== 'condition') return undefined;
      list = cur[p];
      cur = undefined;
    }
  }
  return cur;
}

/**
 * Where to go after the step at `path` finished (non-condition): the next step in the same list, or, at the end of a
 * branch, the step after the condition that owns the branch (repeatedly). null = the workflow is complete.
 */
export function nextPath(steps: Step[], path: Path): Path | null {
  let p = [...path];
  for (;;) {
    const idx = p[p.length - 1] as number;
    const candidate = [...p.slice(0, -1), idx + 1];
    if (stepAt(steps, candidate)) return candidate;
    if (p.length < 3) return null; // end of the top-level list
    p = p.slice(0, -2); // leave the branch: back to the condition step
  }
}

/** Into a condition's branch: its first step, or (empty branch) whatever follows the condition. */
export function branchPath(steps: Step[], conditionPath: Path, branch: 'yes' | 'no'): Path | null {
  const first = [...conditionPath, branch, 0] as Path;
  return stepAt(steps, first) ? first : nextPath(steps, conditionPath);
}

export type Facts = {
  customer: { stage: string | null; tags: string[]; language: string | null; source: string | null; email: string | null; messagingConsent: boolean };
  order?: { total: number } | null;
  trigger?: { channel?: string | null };
};

/** Evaluates a condition against facts read from the database. Unknown facts make the comparison false. */
export function evaluate(step: Extract<Step, { type: 'condition' }>, f: Facts): boolean {
  const v = (step.value ?? '').toLowerCase();
  const get = (): string | number | boolean | string[] | null => {
    switch (step.field) {
      case 'customer.stage': return f.customer.stage ?? 'new';
      case 'customer.tag': return f.customer.tags.map((t) => t.toLowerCase());
      case 'customer.language': return f.customer.language?.toLowerCase() ?? null;
      case 'customer.source': return f.customer.source?.toLowerCase() ?? null;
      case 'customer.has_email': return Boolean(f.customer.email);
      case 'customer.whatsapp_consent': return f.customer.messagingConsent;
      case 'order.total': return f.order ? f.order.total : null;
      case 'trigger.channel': return f.trigger?.channel?.toLowerCase() ?? null;
    }
  };
  const x = get();
  if (x === null) return false;
  switch (step.op) {
    case 'is_true': return x === true;
    case 'is_false': return x === false;
    case 'eq': return Array.isArray(x) ? x.includes(v) : String(x).toLowerCase() === v;
    case 'neq': return Array.isArray(x) ? !x.includes(v) : String(x).toLowerCase() !== v;
    case 'contains': return Array.isArray(x) ? x.some((t) => t.includes(v)) : String(x).toLowerCase().includes(v);
    case 'gt': return typeof x === 'number' && x > Number(v);
    case 'lt': return typeof x === 'number' && x < Number(v);
  }
}

export function countSteps(steps: Step[]): number {
  return steps.reduce((n, s) => n + 1 + (s.type === 'condition' ? countSteps(s.yes) + countSteps(s.no) : 0), 0);
}
