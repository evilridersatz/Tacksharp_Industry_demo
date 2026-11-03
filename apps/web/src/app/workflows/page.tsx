'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDown, ArrowUp, Bot, CheckCircle2, Clock, FlaskConical, GitBranch, ListChecks, MessageCircle, Pause, Phone, Play, Plus, Save, Tag, Trash2, UserRoundCheck, Workflow as WorkflowIcon, Zap,
} from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, Empty, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Label, inputCls } from '@/components/textile';
import { toast } from '@/components/toast';
import type { Tone } from '@/lib/format';

// ------------------------------------------------------------------------------------------------ model (mirrors the API)
type TriggerType = 'lead_created' | 'order_completed' | 'stage_reached' | 'needs_human' | 'message_keyword';
type Trigger = { type: TriggerType; stage?: string; keywords?: string[] };
type Step = { id: string; type: StepType; [k: string]: unknown; yes?: Step[]; no?: Step[] };
type StepType = 'condition' | 'wait' | 'send_whatsapp' | 'ai_call' | 'set_stage' | 'add_tag' | 'assign_team' | 'create_task' | 'enroll_drip';
type Graph = { trigger: Trigger; steps: Step[] };
type Path = Array<number | 'yes' | 'no'>;
type Wf = { id: string; name: string; description: string | null; status: 'draft' | 'active' | 'paused'; graph: Graph; version: number; stepCount?: number; runs?: Record<string, number> };
type LogEntry = { stepId: string; type: string; result: string; detail?: string; at: string };
type Run = { id: string; version: number; status: string; test: boolean; triggerKey: string; customer: { id: string; name: string | null } | null; resumeAt: string | null; lastError: string | null; log: LogEntry[]; createdAt: string };
type Detail = Wf & { runs: Run[] };

const TRIGGERS: Array<{ value: TriggerType; label: string; help: string }> = [
  { value: 'lead_created', label: 'New enquiry / lead', help: 'A new lead is created (any channel).' },
  { value: 'order_completed', label: 'Order completed', help: 'An order is collected / completed.' },
  { value: 'stage_reached', label: 'Customer reaches a CRM stage', help: 'Once per customer per stage.' },
  { value: 'needs_human', label: 'Conversation needs a person', help: 'The AI handed over, or the team took over.' },
  { value: 'message_keyword', label: 'Customer message contains a keyword', help: 'Case-insensitive; any of the keywords.' },
];
const STEP_META: Record<StepType, { label: string; icon: ReactNode; tone: string }> = {
  condition: { label: 'Condition', icon: <GitBranch className="size-4" />, tone: 'border-violet-300 bg-violet-50' },
  wait: { label: 'Wait', icon: <Clock className="size-4" />, tone: 'border-slate-300 bg-slate-50' },
  send_whatsapp: { label: 'Send WhatsApp', icon: <MessageCircle className="size-4" />, tone: 'border-emerald-300 bg-emerald-50' },
  ai_call: { label: 'AI call', icon: <Phone className="size-4" />, tone: 'border-sky-300 bg-sky-50' },
  set_stage: { label: 'Set CRM stage', icon: <CheckCircle2 className="size-4" />, tone: 'border-amber-300 bg-amber-50' },
  add_tag: { label: 'Add tag', icon: <Tag className="size-4" />, tone: 'border-amber-300 bg-amber-50' },
  assign_team: { label: 'Hand to the team', icon: <UserRoundCheck className="size-4" />, tone: 'border-rose-300 bg-rose-50' },
  create_task: { label: 'Create task', icon: <ListChecks className="size-4" />, tone: 'border-amber-300 bg-amber-50' },
  enroll_drip: { label: 'Enrol in drip', icon: <WorkflowIcon className="size-4" />, tone: 'border-emerald-300 bg-emerald-50' },
};
const FIELDS = [
  ['customer.stage', 'CRM stage'], ['customer.tag', 'Tag'], ['customer.language', 'Language'], ['customer.source', 'Source'],
  ['customer.has_email', 'Has an email'], ['customer.whatsapp_consent', 'WhatsApp consent'], ['order.total', 'Order total (₹)'], ['trigger.channel', 'Channel of the trigger'],
] as const;
const OPS = [['eq', 'is'], ['neq', 'is not'], ['gt', 'greater than'], ['lt', 'less than'], ['contains', 'contains'], ['is_true', 'is yes'], ['is_false', 'is no']] as const;
const STAGES = ['new', 'interested', 'qualified', 'converted', 'lost'];
const STATUS_TONE: Record<string, Tone> = { active: 'brand', paused: 'amber', draft: 'slate', completed: 'violet', running: 'sky', waiting: 'sky', failed: 'rose', stopped: 'slate' };
const RESULT_TONE: Record<string, string> = { simulated: 'bg-amber-50 text-amber-900', sent: 'bg-emerald-50 text-emerald-800', done: 'bg-emerald-50 text-emerald-800', yes: 'bg-violet-50 text-violet-800', no: 'bg-violet-50 text-violet-800', skipped: 'bg-slate-100 text-muted', failed: 'bg-rose-50 text-rose-700', retry: 'bg-sky-50 text-sky-800', waiting: 'bg-sky-50 text-sky-800', would_send: 'bg-emerald-50 text-emerald-800', would_change: 'bg-emerald-50 text-emerald-800', would_skip: 'bg-slate-100 text-muted' };
const fitCls = inputCls.replace('w-full', '');
const uid = () => `s${Math.random().toString(36).slice(2, 8)}`;
const pathKey = (p: Path) => p.join('.');

const TEMPLATES: Array<{ name: string; graph: Graph }> = [
  {
    name: 'Welcome a new lead',
    graph: {
      trigger: { type: 'lead_created' },
      steps: [
        { id: uid(), type: 'send_whatsapp', text: 'Hi {name}, thanks for contacting {business}! How can we help you today?' },
        { id: uid(), type: 'wait', minutes: 1440 },
        { id: uid(), type: 'condition', field: 'customer.stage', op: 'eq', value: 'new', yes: [{ id: uid(), type: 'ai_call' }, { id: uid(), type: 'create_task', title: 'Follow up the new lead', dueInDays: 1 }], no: [] },
      ],
    },
  },
  {
    name: 'Thank big orders',
    graph: {
      trigger: { type: 'order_completed' },
      steps: [{ id: uid(), type: 'condition', field: 'order.total', op: 'gt', value: '1000', yes: [{ id: uid(), type: 'add_tag', tag: 'big spender' }, { id: uid(), type: 'send_whatsapp', text: 'Thank you {name} for your order with {business}! We look forward to serving you again.' }], no: [] }],
    },
  },
  {
    name: 'Refunds go to the team',
    graph: { trigger: { type: 'message_keyword', keywords: ['refund', 'complaint'] }, steps: [{ id: uid(), type: 'assign_team', reason: 'Refund / complaint: please answer' }, { id: uid(), type: 'create_task', title: 'Resolve the refund / complaint', dueInDays: 0 }] },
  },
];

// ------------------------------------------------------------------------------------------------ tree helpers (immutable)
function listAt(steps: Step[], parent: Path): Step[] {
  let list = steps;
  for (let i = 0; i < parent.length; i += 2) {
    const s = list[parent[i] as number];
    list = (s?.[parent[i + 1] as 'yes' | 'no'] as Step[]) ?? [];
  }
  return list;
}
function updateList(steps: Step[], parent: Path, fn: (l: Step[]) => Step[]): Step[] {
  if (!parent.length) return fn(steps);
  const [i, br, ...rest] = parent as [number, 'yes' | 'no', ...Path];
  return steps.map((s, j) => (j === i ? { ...s, [br]: updateList((s[br] as Step[]) ?? [], rest, fn) } : s));
}
function stepAtPath(steps: Step[], p: Path): Step | undefined {
  return listAt(steps, p.slice(0, -1))[p[p.length - 1] as number];
}
function blank(type: StepType): Step {
  const id = uid();
  switch (type) {
    case 'condition': return { id, type, field: 'customer.stage', op: 'eq', value: 'qualified', yes: [], no: [] };
    case 'wait': return { id, type, minutes: 60 };
    case 'send_whatsapp': return { id, type, text: 'Hi {name}, ' };
    case 'set_stage': return { id, type, stage: 'interested' };
    case 'add_tag': return { id, type, tag: 'vip' };
    case 'create_task': return { id, type, title: 'Follow up', dueInDays: 1 };
    case 'enroll_drip': return { id, type, sequenceId: '' };
    default: return { id, type };
  }
}
function summary(s: Step): string {
  switch (s.type) {
    case 'condition': return `If ${FIELDS.find((f) => f[0] === s.field)?.[1] ?? s.field} ${OPS.find((o) => o[0] === s.op)?.[1] ?? s.op}${s.value !== undefined && !['is_true', 'is_false'].includes(String(s.op)) ? ` "${s.value}"` : ''}`;
    case 'wait': { const m = Number(s.minutes); return m % 1440 === 0 ? `${m / 1440} day(s)` : m % 60 === 0 ? `${m / 60} hour(s)` : `${m} minute(s)`; }
    case 'send_whatsapp': return String(s.text || (s.templateName ? `Template ${s.templateName}` : 'No message yet'));
    case 'ai_call': return 'The automatic-call Sarvam agent calls the customer';
    case 'set_stage': return `Stage → ${s.stage}`;
    case 'add_tag': return `Tag "${s.tag}"`;
    case 'assign_team': return String(s.reason || 'AI off, open for the team, round-robin');
    case 'create_task': return `${s.title}${s.dueInDays !== undefined ? ` · due in ${s.dueInDays} day(s)` : ''}`;
    case 'enroll_drip': return s.sequenceId ? 'Drip sequence chosen' : 'Choose a sequence';
  }
}

// ------------------------------------------------------------------------------------------------ page
export default function WorkflowsPage() {
  const list = useApi<Wf[]>('/workflows', 20_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<Graph | null>(null);
  const [newName, setNewName] = useState('');
  useEffect(() => {
    if (!selected && !creating && list.data?.length) setSelected(list.data[0].id);
  }, [list.data, selected, creating]);

  const start = (t: { name: string; graph: Graph } | null) => {
    setSelected(null);
    setNewName(t ? t.name : '');
    setCreating(t ? structuredClone(t.graph) : { trigger: { type: 'lead_created' }, steps: [] });
  };

  return (
    <>
      <PageHeader title="Workflow studio" crumb="Customers & Leads" actions={<Button variant="primary" onClick={() => start(null)}><Plus className="size-4" />New workflow</Button>} />
      <p className="mb-4 max-w-3xl text-[13px] text-muted">
        Build automations visually: a trigger, then steps and Yes / No branches. Messages and calls follow the same consent and safety rules as the rest
        of Tacksharp (in test mode they are recorded as <b>simulated</b>). Test a workflow on a real customer before activating it: a test run sends and changes nothing.
      </p>
      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <div className="space-y-3 self-start">
          <Card className="p-2" data-testid="wf-list">
            {list.loading && !list.data && <Skeleton className="h-24" />}
            {list.data?.length === 0 && <Empty icon={<WorkflowIcon className="size-5" />} title="No workflows yet">Start from a template below.</Empty>}
            {list.data?.map((w) => (
              <button key={w.id} onClick={() => { setCreating(null); setSelected(w.id); }} className={cx('w-full rounded-[10px] px-3 py-2 text-left hover:bg-slate-50', selected === w.id && 'bg-slate-100')}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-[13.5px] font-semibold text-ink">{w.name}</span><Badge tone={STATUS_TONE[w.status]}>{w.status}</Badge></div>
                <div className="mt-0.5 text-[12px] text-muted">{TRIGGERS.find((t) => t.value === w.graph.trigger.type)?.label} · {w.stepCount} steps · v{w.version}</div>
              </button>
            ))}
          </Card>
          <Card className="p-3">
            <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-muted">Templates</p>
            {TEMPLATES.map((t) => <button key={t.name} onClick={() => start(t)} className="block w-full rounded-[8px] px-2 py-1.5 text-left text-[13px] text-body hover:bg-slate-50">{t.name}</button>)}
          </Card>
        </div>
        <div className="min-w-0">
          {creating && (
            <Studio
              key="new"
              initial={{ id: '', name: newName, description: null, status: 'draft', graph: creating, version: 0 }}
              onSaved={(id) => { setCreating(null); setSelected(id); list.reload(); }}
            />
          )}
          {!creating && selected && <Existing key={selected} id={selected} onChanged={list.reload} />}
        </div>
      </div>
    </>
  );
}

function Existing({ id, onChanged }: { id: string; onChanged: () => void }) {
  const d = useApi<Detail>(`/workflows/${id}`, 15_000);
  const [tab, setTab] = useState<'design' | 'runs'>('design');
  if (d.error) return <ErrorBanner message={d.error} onRetry={d.reload} />;
  if (!d.data) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-3">
      <Segmented label="View" value={tab} onChange={setTab} options={[{ value: 'design', label: 'Design' }, { value: 'runs', label: `Runs (${d.data.runs.length})` }]} />
      {tab === 'design' ? <Studio initial={d.data} onSaved={() => { d.reload(); onChanged(); }} /> : <Runs runs={d.data.runs} onChanged={d.reload} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ studio (canvas + inspector)
function Studio({ initial, onSaved }: { initial: Wf; onSaved: (id: string) => void }) {
  const [name, setName] = useState(initial.name);
  const [graph, setGraph] = useState<Graph>(initial.graph);
  const [sel, setSel] = useState<Path | 'trigger' | null>('trigger');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const isNew = !initial.id;
  const drips = useApi<Array<{ id: string; name: string; status: string }>>('/drips', 0);

  const change = (g: Graph) => { setGraph(g); setDirty(true); };
  const setSteps = (fn: (steps: Step[]) => Step[]) => change({ ...graph, steps: fn(graph.steps) });
  const insert = (parent: Path, index: number, type: StepType) => {
    setSteps((steps) => updateList(steps, parent, (l) => [...l.slice(0, index), blank(type), ...l.slice(index)]));
    setSel([...parent, index]);
  };
  const remove = (p: Path) => { setSteps((steps) => updateList(steps, p.slice(0, -1), (l) => l.filter((_, i) => i !== p[p.length - 1]))); setSel(null); };
  const move = (p: Path, dir: -1 | 1) => {
    const i = p[p.length - 1] as number;
    setSteps((steps) => updateList(steps, p.slice(0, -1), (l) => { const j = i + dir; if (j < 0 || j >= l.length) return l; const c = [...l]; [c[i], c[j]] = [c[j], c[i]]; return c; }));
    setSel([...p.slice(0, -1), i + dir]);
  };
  const patch = (p: Path, values: Record<string, unknown>) => setSteps((steps) => updateList(steps, p.slice(0, -1), (l) => l.map((s, i) => (i === p[p.length - 1] ? { ...s, ...values } : s))));

  const act = useCallback(async (k: string, fn: () => Promise<unknown>, ok: string, after?: (r: any) => void) => {
    setBusy(k);
    try {
      const r = await fn();
      toast(ok);
      after?.(r);
    } catch (e) {
      const errs = e instanceof ApiError ? ((e.body as { errors?: Record<string, string> } | undefined)?.errors ?? {}) : {};
      setErrors(errs);
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  }, []);

  const save = () => {
    setErrors({});
    return act('save', () => (isNew ? api.post<Wf>('/workflows', { name, graph }) : api.patch<Wf>(`/workflows/${initial.id}`, { name, graph })), isNew ? 'Saved as a draft. Test it, then activate.' : 'Saved. New runs use this version; running ones finish on theirs.', (r: Wf) => { setDirty(false); onSaved(r.id); });
  };
  const selected = sel && sel !== 'trigger' ? stepAtPath(graph.steps, sel) : undefined;

  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_340px]">
      <Card className="min-w-0 p-4" data-testid="wf-studio">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input aria-label="Workflow name" className={cx(fitCls, 'w-72 font-semibold')} placeholder="Workflow name" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
          {!isNew && <Badge tone={STATUS_TONE[initial.status]}>{initial.status}</Badge>}
          {!isNew && <span className="text-[12px] text-muted">v{initial.version}{dirty ? ' · unsaved changes' : ''}</span>}
          {errors.name && <span className="text-[12px] font-semibold text-rose-700">{errors.name}</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="primary" busy={busy === 'save'} onClick={() => void save()}><Save className="size-4" />Save</Button>
            {!isNew && (initial.status === 'active'
              ? <Button busy={busy === 'pause'} onClick={() => void act('pause', () => api.post(`/workflows/${initial.id}/pause`, {}), 'Paused: runs hold until you activate it again.', () => onSaved(initial.id))}><Pause className="size-4" />Pause</Button>
              : <Button busy={busy === 'activate'} disabled={dirty} title={dirty ? 'Save first' : undefined} onClick={() => void act('activate', () => api.post(`/workflows/${initial.id}/activate`, {}), 'Active. New records from now on start it (checked every minute).', () => onSaved(initial.id))}><Play className="size-4" />Activate</Button>)}
          </div>
        </div>
        {errors.steps && <p className="mb-2 text-[12.5px] font-semibold text-rose-700">{errors.steps}</p>}
        <div className="overflow-x-auto pb-2">
          <div className="mx-auto flex min-w-fit flex-col items-center" data-testid="wf-canvas">
            <button onClick={() => setSel('trigger')} data-testid="wf-trigger" className={cx('w-72 rounded-[14px] border-2 bg-white px-4 py-3 text-left shadow-sm', sel === 'trigger' ? 'border-brand' : 'border-brand/40', errors.trigger && 'border-rose-400')}>
              <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-wide text-brand"><Zap className="size-4" />When</div>
              <div className="mt-1 text-[13.5px] font-semibold text-ink">{TRIGGERS.find((t) => t.value === graph.trigger.type)?.label}</div>
              {graph.trigger.type === 'stage_reached' && <div className="text-[12px] text-muted">Stage: {graph.trigger.stage ?? '—'}</div>}
              {graph.trigger.type === 'message_keyword' && <div className="text-[12px] text-muted">Keywords: {(graph.trigger.keywords ?? []).join(', ') || '—'}</div>}
              {errors.trigger && <div className="mt-1 text-[12px] font-semibold text-rose-700">{errors.trigger}</div>}
            </button>
            <Branch steps={graph.steps} parent={[]} sel={sel} setSel={setSel} errors={errors} insert={insert} depth={0} />
            <div className="mt-1 rounded-full border border-line bg-slate-50 px-3 py-1 text-[11.5px] font-semibold text-muted">End</div>
          </div>
        </div>
      </Card>
      <div className="space-y-3">
        <Card className="p-4" data-testid="wf-inspector">
          {sel === 'trigger' && <TriggerEditor trigger={graph.trigger} onChange={(t) => change({ ...graph, trigger: t })} />}
          {selected && sel && sel !== 'trigger' && (
            <StepEditor step={selected} error={errors[selected.id]} drips={drips.data ?? []} onPatch={(v) => patch(sel, v)} onRemove={() => remove(sel)} onMove={(d) => move(sel, d)} />
          )}
          {!sel && <p className="text-[13px] text-muted">Select the trigger or a step to edit it. Use + between steps to add one.</p>}
        </Card>
        {!isNew && <TestRun id={initial.id} dirty={dirty} />}
      </div>
    </div>
  );
}

function Connector({ onAdd, label }: { onAdd: (t: StepType) => void; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-4 w-px bg-line" />
      <button aria-label={label} onClick={() => setOpen((o) => !o)} className="grid size-6 place-items-center rounded-full border border-line bg-white text-muted shadow-sm hover:border-brand hover:text-brand"><Plus className="size-3.5" /></button>
      {open && (
        <div role="menu" className="absolute top-11 z-10 w-52 rounded-[12px] border border-line bg-white p-1 shadow-lg">
          {(Object.keys(STEP_META) as StepType[]).map((t) => (
            <button key={t} role="menuitem" onClick={() => { setOpen(false); onAdd(t); }} className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[13px] text-body hover:bg-slate-50">{STEP_META[t].icon}{STEP_META[t].label}</button>
          ))}
        </div>
      )}
      <div className="h-4 w-px bg-line" />
    </div>
  );
}

function Branch({ steps, parent, sel, setSel, errors, insert, depth }: { steps: Step[]; parent: Path; sel: Path | 'trigger' | null; setSel: (p: Path) => void; errors: Record<string, string>; insert: (parent: Path, index: number, t: StepType) => void; depth: number }) {
  // Cards get narrower inside branches so a Yes / No pair fits side by side (deeper nesting scrolls sideways).
  const width = depth === 0 ? 'w-72' : depth === 1 ? 'w-52' : 'w-44';
  const where = parent.length ? `in the ${parent[parent.length - 1]} branch` : '';
  return (
    <div className="flex flex-col items-center">
      <Connector label={`Add a step at position 1 ${where}`.trim()} onAdd={(t) => insert(parent, 0, t)} />
      {steps.map((s, i) => {
        const p = [...parent, i] as Path;
        const active = sel !== 'trigger' && sel !== null && pathKey(sel) === pathKey(p);
        return (
          <Fragment key={s.id}>
            <button onClick={() => setSel(p)} data-testid={`wf-step-${s.id}`} className={cx(width, 'rounded-[14px] border px-3.5 py-2.5 text-left shadow-sm', STEP_META[s.type].tone, active && 'ring-2 ring-brand', errors[s.id] && 'border-rose-400 ring-1 ring-rose-300')}>
              <div className="flex items-center gap-2 text-[12.5px] font-bold text-ink">{STEP_META[s.type].icon}{STEP_META[s.type].label}</div>
              <div className="mt-0.5 line-clamp-2 text-[12.5px] text-body">{summary(s)}</div>
              {errors[s.id] && <div className="mt-1 text-[12px] font-semibold text-rose-700">{errors[s.id]}</div>}
            </button>
            {s.type === 'condition' ? (
              <div className="flex flex-col items-center">
                <div className="h-4 w-px bg-line" />
                <div className="flex gap-4 rounded-[16px] border border-dashed border-violet-200 px-3 pb-3 pt-2">
                  {(['yes', 'no'] as const).map((br) => (
                    <div key={br} className="flex flex-col items-center" data-testid={`wf-branch-${s.id}-${br}`}>
                      <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase', br === 'yes' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800')}>{br}</span>
                      <Branch steps={(s[br] as Step[]) ?? []} parent={[...p, br]} sel={sel} setSel={setSel} errors={errors} insert={insert} depth={depth + 1} />
                    </div>
                  ))}
                </div>
                <Connector label={`Add a step after step ${i + 1} ${where}`.trim()} onAdd={(t) => insert(parent, i + 1, t)} />
              </div>
            ) : (
              <Connector label={`Add a step after step ${i + 1} ${where}`.trim()} onAdd={(t) => insert(parent, i + 1, t)} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function TriggerEditor({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
  return (
    <div className="space-y-3">
      <h3 className="text-[14px] font-bold text-ink">Trigger</h3>
      <Label text="Starts when"><select aria-label="Trigger" className={inputCls} value={trigger.type} onChange={(e) => onChange({ type: e.target.value as TriggerType, ...(e.target.value === 'stage_reached' ? { stage: 'qualified' } : {}), ...(e.target.value === 'message_keyword' ? { keywords: [] } : {}) })}>{TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Label>
      <p className="text-[12px] text-muted">{TRIGGERS.find((t) => t.value === trigger.type)?.help} Only records created after you activate the workflow start it; each record starts it once.</p>
      {trigger.type === 'stage_reached' && <Label text="Stage"><select aria-label="Trigger stage" className={inputCls} value={trigger.stage} onChange={(e) => onChange({ ...trigger, stage: e.target.value })}>{STAGES.slice(1).map((s) => <option key={s} value={s}>{s}</option>)}</select></Label>}
      {trigger.type === 'message_keyword' && <Label text="Keywords (comma separated)"><input aria-label="Keywords" className={inputCls} value={(trigger.keywords ?? []).join(', ')} onChange={(e) => onChange({ ...trigger, keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })} /></Label>}
    </div>
  );
}

function StepEditor({ step, error, drips, onPatch, onRemove, onMove }: { step: Step; error?: string; drips: Array<{ id: string; name: string; status: string }>; onPatch: (v: Record<string, unknown>) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const v = (k: string) => (step[k] === undefined || step[k] === null ? '' : String(step[k]));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-[14px] font-bold text-ink">{STEP_META[step.type].icon}{STEP_META[step.type].label}</h3>
        <div className="ml-auto flex gap-1">
          <button aria-label="Move up" onClick={() => onMove(-1)} className="rounded p-1 text-muted hover:bg-slate-100"><ArrowUp className="size-4" /></button>
          <button aria-label="Move down" onClick={() => onMove(1)} className="rounded p-1 text-muted hover:bg-slate-100"><ArrowDown className="size-4" /></button>
          <button aria-label="Delete step" onClick={onRemove} className="rounded p-1 text-muted hover:bg-rose-50 hover:text-rose-700"><Trash2 className="size-4" /></button>
        </div>
      </div>
      {error && <p role="alert" className="text-[12.5px] font-semibold text-rose-700">{error}</p>}
      {step.type === 'condition' && (
        <>
          <Label text="Check"><select aria-label="Condition field" className={inputCls} value={v('field')} onChange={(e) => onPatch({ field: e.target.value })}>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Label>
          <Label text="Is"><select aria-label="Condition operator" className={inputCls} value={v('op')} onChange={(e) => onPatch({ op: e.target.value })}>{OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Label>
          {!['is_true', 'is_false'].includes(v('op')) && <Label text="Value"><input aria-label="Condition value" className={inputCls} value={v('value')} onChange={(e) => onPatch({ value: e.target.value })} /></Label>}
          <p className="text-[12px] text-muted">Facts are read from the database when the step runs. Unknown facts count as No.</p>
        </>
      )}
      {step.type === 'wait' && (
        <Label text="Wait (minutes)"><input aria-label="Wait minutes" type="number" min={1} className={inputCls} value={v('minutes')} onChange={(e) => onPatch({ minutes: Number(e.target.value) })} /><span className="mt-1 block text-[12px] text-muted">60 = an hour, 1440 = a day (up to 60 days).</span></Label>
      )}
      {step.type === 'send_whatsapp' && (
        <>
          <Label text="Message"><textarea aria-label="WhatsApp message" rows={4} className={cx(inputCls, 'h-auto py-2')} value={v('text')} onChange={(e) => onPatch({ text: e.target.value })} /></Label>
          <Label text="Approved template (optional)"><input aria-label="Template name" className={inputCls} value={v('templateName')} onChange={(e) => onPatch({ templateName: e.target.value })} /></Label>
          <p className="text-[12px] text-muted">{'{name}'} and {'{business}'} are filled in. Free text only inside the customer&apos;s 24-hour window; after that the template, otherwise the step is skipped. Needs WhatsApp consent or the customer having written to you.</p>
        </>
      )}
      {step.type === 'ai_call' && <p className="text-[12.5px] text-muted">Your automatic-call Sarvam agent calls the customer, inside calling hours and only with calling consent or an enquiry.</p>}
      {step.type === 'set_stage' && <Label text="Stage"><select aria-label="Stage" className={inputCls} value={v('stage')} onChange={(e) => onPatch({ stage: e.target.value })}>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Label>}
      {step.type === 'add_tag' && <Label text="Tag"><input aria-label="Tag" className={inputCls} value={v('tag')} onChange={(e) => onPatch({ tag: e.target.value })} /></Label>}
      {step.type === 'assign_team' && <Label text="Reason shown to the team"><input aria-label="Hand-over reason" className={inputCls} value={v('reason')} onChange={(e) => onPatch({ reason: e.target.value })} /><span className="mt-1 block text-[12px] text-muted">Turns the AI off for the conversation, opens it with high priority and assigns it round-robin.</span></Label>}
      {step.type === 'create_task' && (
        <>
          <Label text="Task"><input aria-label="Task title" className={inputCls} value={v('title')} onChange={(e) => onPatch({ title: e.target.value })} /></Label>
          <Label text="Due in (days)"><input aria-label="Due in days" type="number" min={0} className={inputCls} value={v('dueInDays')} onChange={(e) => onPatch({ dueInDays: e.target.value === '' ? undefined : Number(e.target.value) })} /></Label>
        </>
      )}
      {step.type === 'enroll_drip' && (
        <Label text="Drip sequence"><select aria-label="Drip sequence" className={inputCls} value={v('sequenceId')} onChange={(e) => onPatch({ sequenceId: e.target.value })}><option value="">Choose…</option>{drips.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.status})</option>)}</select></Label>
      )}
    </div>
  );
}

function TestRun({ id, dirty }: { id: string; dirty: boolean }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const found = useApi<{ rows: Array<{ id: string; name: string | null; phone: string | null }> }>(debounced.length >= 2 ? `/customers?${new URLSearchParams({ q: debounced, pageSize: '5' })}` : null, 0);
  const [customer, setCustomer] = useState<{ id: string; name: string | null } | null>(null);
  const [result, setResult] = useState<{ status: string; log: LogEntry[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!customer) return;
    setBusy(true);
    try {
      setResult(await api.post(`/workflows/${id}/test`, { customerId: customer.id }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-testid="wf-test">
      <h3 className="flex items-center gap-2 text-[14px] font-bold text-ink"><FlaskConical className="size-4" />Test on a customer</h3>
      <p className="mb-2 text-[12px] text-muted">Runs the saved version with this customer&apos;s real data. Nothing is sent or changed; waits are skipped.{dirty ? ' Save first to test your changes.' : ''}</p>
      <input aria-label="Find a customer" className={inputCls} placeholder="Name or number" value={q} onChange={(e) => { setQ(e.target.value); setCustomer(null); }} />
      {!customer && found.data && (
        <ul className="mt-1 rounded-[10px] border border-line">
          {found.data.rows.map((c) => <li key={c.id}><button className="w-full px-3 py-1.5 text-left text-[13px] hover:bg-slate-50" onClick={() => { setCustomer(c); setQ(c.name ?? c.phone ?? c.id); }}>{c.name ?? 'Customer'} <span className="text-faint">{c.phone ? `••••${c.phone.slice(-4)}` : ''}</span></button></li>)}
          {found.data.rows.length === 0 && <li className="px-3 py-1.5 text-[12.5px] text-muted">No match</li>}
        </ul>
      )}
      <Button className="mt-2" variant="primary" busy={busy} disabled={!customer || dirty} onClick={() => void go()}><Bot className="size-4" />Run test</Button>
      {result && <ol className="mt-3 space-y-1.5" data-testid="wf-test-log">{result.log.map((l, i) => <LogLine key={i} l={l} />)}</ol>}
    </Card>
  );
}

function LogLine({ l }: { l: LogEntry }) {
  const meta = STEP_META[l.type as StepType];
  return (
    <li className="flex items-start gap-2 text-[12.5px]">
      <span className="mt-0.5 text-muted">{meta?.icon}</span>
      <span className="min-w-0 flex-1"><span className="font-semibold text-ink">{meta?.label ?? l.type}</span>{l.detail && <span className="text-muted"> · {l.detail}</span>}</span>
      <span className={cx('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', RESULT_TONE[l.result] ?? 'bg-slate-100 text-muted')}>{l.result.replace('_', ' ')}</span>
    </li>
  );
}

function Runs({ runs, onChanged }: { runs: Run[]; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const live = useMemo(() => runs, [runs]);
  const stop = async (id: string) => {
    setBusy(id);
    try {
      await api.post(`/workflows/runs/${id}/stop`, {});
      toast('Run stopped.');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  if (!live.length) return <Card className="p-5 text-[13px] text-muted">No runs yet. Runs start when the workflow is active and its trigger happens.</Card>;
  return (
    <Card className="p-4" data-testid="wf-runs">
      <ul className="divide-y divide-line">
        {live.map((r) => (
          <li key={r.id} className="py-2" data-testid="wf-run">
            <div className="flex flex-wrap items-center gap-2">
              <button className="text-left text-[13px] font-semibold text-ink hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>{r.customer?.name ?? 'No customer'}</button>
              <Badge tone={STATUS_TONE[r.status] ?? 'slate'}>{r.status}</Badge>
              {r.test && <Badge tone="violet">test</Badge>}
              <span className="text-[12px] text-muted">v{r.version} · {new Date(r.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{r.status === 'waiting' && r.resumeAt ? ` · resumes ${new Date(r.resumeAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</span>
              <span className="text-[12px] text-faint">{r.log.length} step(s)</span>
              {['running', 'waiting'].includes(r.status) && !r.test && <Button className="ml-auto" variant="ghost" busy={busy === r.id} onClick={() => void stop(r.id)}>Stop</Button>}
            </div>
            {r.lastError && <p className="text-[12px] text-rose-700">{r.lastError}</p>}
            {open === r.id && <ol className="mt-2 space-y-1.5 pl-1">{r.log.map((l, i) => <LogLine key={i} l={l} />)}</ol>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
