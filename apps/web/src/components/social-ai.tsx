'use client';

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { ApiError, api, useApi } from '@/lib/api';
import { Badge, Button, Card, CardHeader, Skeleton } from './ui';
import { inputCls } from './textile';
import { toast } from './toast';

type S = { connected: boolean; enabled: boolean; aiAgentId: string | null; current: { id: string; name: string; status: string } | null; agents: Array<{ id: string; name: string; knowledgeBaseId: string | null }>; active: boolean };

/** Instagram & Messenger: which published agent answers customers (none = the team answers everything). */
export function SocialAiCard() {
  const { data: s, error, reload } = useApi<S>('/social/ai', 0);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return null;
  if (!s) return <Skeleton className="h-40" />;
  const value = pick ?? s.aiAgentId ?? '';
  async function save(agentId: string | null) {
    setBusy(true);
    try { await api.put('/social/ai', { agentId }); toast(agentId ? 'The agent now answers Instagram and Messenger.' : 'AI replies off: the team answers.'); setPick(null); await reload(); }
    catch (e) { toast(e instanceof ApiError || e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(false); }
  }
  return (
    <Card className="mt-4" data-testid="social-ai">
      <CardHeader title="AI replies" subtitle="Choose a published agent to answer Instagram and Messenger messages from its knowledge base. Leave it off and your team answers everything in the inbox." action={s.active ? <Badge tone="brand">AI answering</Badge> : <Badge tone="slate">Team only</Badge>} />
      <div className="grid gap-3 px-5 pb-5 text-[13px]">
        {!s.connected ? <p className="text-muted">Save and enable the connection above first.</p> : (
          <>
            {s.aiAgentId && !s.active && <p role="alert" className="rounded-[10px] bg-amber-50 px-3 py-2 text-amber-900">The chosen agent ({s.current?.name ?? 'deleted'}) is no longer published, so the team answers. Publish it again or choose another.</p>}
            <label className="grid gap-1 sm:max-w-md"><span className="font-semibold">Agent</span>
              <select className={inputCls} value={value} onChange={(e) => setPick(e.target.value)}>
                <option value="">None: the team answers</option>
                {s.agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.knowledgeBaseId ? '' : ' (no knowledge base)'}</option>)}
              </select>
            </label>
            {!s.agents.length && <p className="text-muted">No published agent yet. Create and publish one in Voice agents (it needs a knowledge base and a test).</p>}
            <ul className="grid gap-1 text-[12.5px] text-muted">
              <li>• Answers only from the agent&apos;s instructions and knowledge base; questions it cannot answer go to the team and appear in the Knowledge studio.</li>
              <li>• A customer asking for a person, or sending a photo or file, is handed to the team. STOP is always honoured.</li>
              <li>• Per conversation in the inbox: take over, review replies first, or give the AI private guidance.</li>
            </ul>
            <div><Button variant="primary" busy={busy} disabled={value === (s.aiAgentId ?? '')} onClick={() => void save(value || null)}><Bot className="size-4" /> Save</Button></div>
          </>
        )}
      </div>
    </Card>
  );
}
