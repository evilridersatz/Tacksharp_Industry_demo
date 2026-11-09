'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Pause, Play, Power, Save } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, ErrorBanner, Skeleton, cx } from '@/components/ui';
import { toast } from '@/components/toast';
import { FormField } from '@/components/jarvis';
import { AgentFigure, ROLE_LABEL, StatusPill, ago, errorText, inputCls } from '@/components/office';

type Mode = 'auto' | 'approval' | 'denied';
type Agent = {
  id: string; role: string; name: string; enabled: boolean; paused: boolean; breaker: string; status: string; version: number; model: string; instructions: string | null;
  canMessage: string[]; budgets: { maxStepsPerTask: number; maxToolCallsPerTask: number; maxTokensPerTask: number }; tools: Record<string, Mode>;
  purpose: string; availableTools: string[]; templateCanMessage: string[]; department: { name: string } | null;
};
type Version = { id: string; version: number; model: string; note: string | null; createdBy: string; createdAt: string; tools: Array<{ tool: string; mode: string }> };
const MANDATORY = ['send_whatsapp'];
const TOOL_HELP: Record<string, string> = {
  business_snapshot: 'Read today’s numbers', list_pending_orders: 'Read pending orders', list_low_stock: 'Read low stock', list_waiting_conversations: 'Read customers waiting for staff', list_followup_candidates: 'Read customers to follow up', list_receivables: 'Read money to collect',
  search_knowledge: 'Search the knowledge base', read_memory: 'Read verified memory', read_plan_results: 'Read the plan’s results', create_work_task: 'Create staff jobs', assign_conversation: 'Assign conversations', draft_whatsapp: 'Save message drafts',
  update_lead_stage: 'Change CRM stages', propose_memory: 'Propose memory facts', send_whatsapp: 'Send WhatsApp messages (always needs approval)',
};

export default function AgentsPage() {
  return (
    <>
      <PageHeader title="Agents" crumb="AI Office" />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Agents />
      </Suspense>
    </>
  );
}

function Agents() {
  const params = useSearchParams();
  const router = useRouter();
  const { data, error, reload } = useApi<{ items: Agent[] }>('/office/agents', 15_000);
  const selectedId = params.get('agent') ?? data?.items[0]?.id ?? null;
  const agent = data?.items.find((a) => a.id === selectedId) ?? null;
  return (
    <>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-96" /> : (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <Card className="h-fit overflow-hidden">
            <ul className="divide-y divide-line">
              {data.items.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => router.replace(`/office/agents?agent=${a.id}`, { scroll: false })} className={cx('flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50', a.id === selectedId && 'bg-slate-50')} aria-current={a.id === selectedId}>
                    <AgentFigure role={a.role} status={a.paused ? 'paused' : !a.enabled ? 'off' : a.status} size={34} />
                    <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-semibold text-ink">{a.name}</span><span className="block text-[11.5px] text-muted">{a.department?.name} · v{a.version}</span></span>
                    {!a.enabled ? <Badge>off</Badge> : a.paused ? <Badge tone="amber">paused</Badge> : null}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {agent && <AgentEditor key={`${agent.id}:${agent.version}`} agent={agent} onSaved={reload} />}
        </div>
      )}
    </>
  );
}

function AgentEditor({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const versions = useApi<{ items: Version[] }>(`/office/agents/${agent.id}/versions`, 0);
  const [f, setF] = useState({ model: agent.model, instructions: agent.instructions ?? '', canMessage: agent.canMessage, budgets: agent.budgets, tools: agent.tools, note: '' });
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { versions.reload(); }, [agent.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok); onSaved(); versions.reload(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };
  const save = () => run('save', () => api.put(`/office/agents/${agent.id}`, f), 'Saved as a new version.');
  const state = (action: string, ok: string) => run(action, () => api.post(`/office/agents/${agent.id}/${action}`), ok);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={<span className="flex items-center gap-3"><AgentFigure role={agent.role} status={agent.paused ? 'paused' : !agent.enabled ? 'off' : agent.status} size={40} />{agent.name}</span>}
        subtitle={<span className="flex flex-wrap items-center gap-2"><span>{agent.purpose}</span><StatusPill status={agent.paused ? 'paused' : !agent.enabled ? 'off' : agent.status} />{agent.breaker !== 'healthy' && <StatusPill status={agent.breaker} />}</span>}
        action={
          <div className="flex flex-wrap gap-2">
            {agent.paused ? <Button variant="primary" onClick={() => void state('resume', 'Resumed (circuit breaker reset).')} busy={busy === 'resume'}><Play className="size-4" aria-hidden /> Resume</Button> : <Button onClick={() => void state('pause', 'Paused: no steps, no tool calls.')} busy={busy === 'pause'}><Pause className="size-4" aria-hidden /> Pause</Button>}
            {agent.role !== 'ceo' && <Button onClick={() => void state(agent.enabled ? 'disable' : 'enable', agent.enabled ? 'Switched off.' : 'Switched on.')} busy={busy === 'enable' || busy === 'disable'}><Power className="size-4" aria-hidden /> {agent.enabled ? 'Switch off' : 'Switch on'}</Button>}
          </div>
        }
      />
      <div className="grid gap-4 border-t border-line px-5 py-4 md:grid-cols-2">
        <FormField label="Model">
          <select className={inputCls} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}><option value="gpt-5.4-mini">gpt-5.4-mini (cheaper)</option><option value="gpt-5.4">gpt-5.4</option></select>
        </FormField>
        <div className="grid grid-cols-3 gap-2">
          <FormField label="Steps / task"><input type="number" min={1} max={20} className={inputCls} value={f.budgets.maxStepsPerTask} onChange={(e) => setF({ ...f, budgets: { ...f.budgets, maxStepsPerTask: Number(e.target.value) } })} /></FormField>
          <FormField label="Tool calls / task"><input type="number" min={0} max={50} className={inputCls} value={f.budgets.maxToolCallsPerTask} onChange={(e) => setF({ ...f, budgets: { ...f.budgets, maxToolCallsPerTask: Number(e.target.value) } })} /></FormField>
          <FormField label="Tokens / task"><input type="number" min={2000} step={1000} className={inputCls} value={f.budgets.maxTokensPerTask} onChange={(e) => setF({ ...f, budgets: { ...f.budgets, maxTokensPerTask: Number(e.target.value) } })} /></FormField>
        </div>
        <div className="md:col-span-2">
          <FormField label="Your guidance (added after the role’s fixed rules; it cannot remove them)">
            <textarea rows={3} maxLength={1500} className="w-full rounded-[10px] border border-line bg-white px-3 py-2 text-[13.5px] outline-none focus:border-slate-400" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} placeholder="e.g. Write to customers in Tamil when they wrote in Tamil. Never mention prices." />
          </FormField>
        </div>
      </div>
      <div className="border-t border-line px-5 py-4">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Tools</h3>
        {agent.availableTools.length === 0 ? <p className="mt-1 text-[12.5px] text-muted">This role uses no tools.</p> : (
          <table className="mt-2 w-full text-[13px]">
            <thead><tr className="text-left text-[12px] text-muted"><th className="py-1 font-semibold">Tool</th><th className="py-1 font-semibold">Allowed</th></tr></thead>
            <tbody>
              {agent.availableTools.map((t) => (
                <tr key={t} className="border-t border-line">
                  <td className="py-1.5 pr-3"><code className="text-[12px] text-ink">{t}</code><span className="block text-[11.5px] text-muted">{TOOL_HELP[t] ?? ''}</span></td>
                  <td className="py-1.5">
                    <label className="sr-only" htmlFor={`tool-${t}`}>{t}</label>
                    <select id={`tool-${t}`} className={cx(inputCls, 'w-48')} value={f.tools[t] ?? 'denied'} onChange={(e) => setF({ ...f, tools: { ...f.tools, [t]: e.target.value as Mode } })}>
                      {!MANDATORY.includes(t) && <option value="auto">Yes{t.startsWith('list_') || t.startsWith('read_') || t === 'business_snapshot' || t === 'search_knowledge' ? '' : ' (supervised: on its own)'}</option>}
                      <option value="approval">Only with approval</option>
                      <option value="denied">No</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {agent.templateCanMessage.length > 0 && (
          <fieldset className="mt-4">
            <legend className="text-[12px] font-semibold uppercase tracking-wide text-muted">May message or ask</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {agent.templateCanMessage.map((r) => (
                <label key={r} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" className="size-4" checked={f.canMessage.includes(r)} onChange={(e) => setF({ ...f, canMessage: e.target.checked ? [...f.canMessage, r] : f.canMessage.filter((x) => x !== r) })} />{ROLE_LABEL[r] ?? r}</label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label htmlFor="note" className="sr-only">What changed</label>
          <input id="note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="What changed (for the history)" className={cx(inputCls, 'min-w-[200px] flex-1')} maxLength={300} />
          <Button variant="primary" onClick={() => void save()} busy={busy === 'save'}><Save className="size-4" aria-hidden /> Save as version {agent.version + 1}</Button>
        </div>
      </div>
      <div className="border-t border-line px-5 py-4">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Version history</h3>
        {!versions.data ? <Skeleton className="mt-2 h-16" /> : (
          <ul className="mt-1 divide-y divide-line">
            {versions.data.items.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]">
                <b className="text-ink">v{v.version}</b><span className="text-body">{v.model}</span><span className="text-muted">{v.note ?? ''} · {v.createdBy.replace(/^user:/, '')} · {ago(v.createdAt)}</span>
                {v.version === agent.version ? <Badge tone="brand">active</Badge> : <Button className="ml-auto" onClick={() => void run(`v${v.version}`, () => api.post(`/office/agents/${agent.id}/activate`, { version: v.version }), `Version ${v.version} is active again.`)} busy={busy === `v${v.version}`}>Activate</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
