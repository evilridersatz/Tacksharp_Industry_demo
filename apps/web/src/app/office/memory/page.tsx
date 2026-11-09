'use client';

import { useState } from 'react';
import { Check, Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Button, Card, CardHeader, Empty, ErrorBanner, Segmented, Skeleton } from '@/components/ui';
import { toast } from '@/components/toast';
import { StatusPill, ago, errorText, inputCls } from '@/components/office';

type Memory = { id: string; scope: string; text: string; source: string; author: string; status: string; version: number; pinned: boolean; expiresAt: string | null; updatedAt: string };

export default function OfficeMemoryPage() {
  const [show, setShow] = useState<'proposed' | 'verified' | 'all'>('verified');
  const { data, error, reload } = useApi<{ items: Memory[] }>(`/office/memory${show === 'all' ? '' : `?status=${show}`}`, 20_000);
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok); reload(); } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };
  return (
    <>
      <PageHeader title="Memory" crumb="AI Office" actions={<Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'verified', label: 'Verified' }, { value: 'proposed', label: 'Proposed by agents' }, { value: 'all', label: 'All' }]} />} />
      <p className="mb-4 text-[12.5px] text-muted">Facts the agents may rely on. What you add is verified at once; what an agent proposes waits here until you verify it. Agents only read verified facts.</p>
      <Card className="mb-4">
        <CardHeader title="Add a fact" />
        <form className="flex flex-wrap gap-2 px-5 pb-5" onSubmit={(e) => { e.preventDefault(); void run('add', () => api.post('/office/memory', { text, source: source || undefined }), 'Saved.').then(() => { setText(''); setSource(''); }); }}>
          <label htmlFor="fact" className="sr-only">Fact</label>
          <input id="fact" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="e.g. Sunday orders close at 1 pm" className={`${inputCls} min-w-[240px] flex-[2]`} />
          <label htmlFor="source" className="sr-only">Source</label>
          <input id="source" value={source} onChange={(e) => setSource(e.target.value)} maxLength={300} placeholder="Source (optional)" className={`${inputCls} min-w-[160px] flex-1`} />
          <Button variant="primary" type="submit" busy={busy === 'add'} disabled={text.trim().length < 3}><Plus className="size-4" aria-hidden /> Add</Button>
        </form>
      </Card>
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-64" /> : data.items.length === 0 ? <Card><Empty title="Nothing here yet" /></Card> : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {data.items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
                <div className="min-w-[220px] flex-1">
                  <p className="text-[13.5px] text-ink">{m.pinned && <Pin className="mr-1 inline size-3.5 text-muted" aria-label="Pinned" />}{m.text}</p>
                  <p className="mt-0.5 text-[11.5px] text-muted">Source: {m.source} · by {m.author.replace(/^user:/, 'a person ').replace(/^agent:/, 'agent ')} · v{m.version} · {ago(m.updatedAt)}{m.expiresAt ? ` · expires ${new Date(m.expiresAt).toLocaleDateString('en-IN')}` : ''}</p>
                </div>
                <StatusPill status={m.status === 'verified' ? 'completed' : m.status === 'proposed' ? 'pending' : 'rejected'} />
                <div className="flex gap-1.5">
                  {m.status === 'proposed' && <><Button onClick={() => void run(`v${m.id}`, () => api.put(`/office/memory/${m.id}`, { status: 'verified' }), 'Verified.')} busy={busy === `v${m.id}`}><Check className="size-4" aria-hidden /> Verify</Button><Button onClick={() => void run(`r${m.id}`, () => api.put(`/office/memory/${m.id}`, { status: 'rejected' }), 'Rejected.')} busy={busy === `r${m.id}`}><X className="size-4" aria-hidden /> Reject</Button></>}
                  <Button onClick={() => void run(`p${m.id}`, () => api.put(`/office/memory/${m.id}`, { pinned: !m.pinned }), m.pinned ? 'Unpinned.' : 'Pinned: agents read it first.')} aria-label={m.pinned ? 'Unpin' : 'Pin'}>{m.pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}</Button>
                  <Button onClick={() => { if (window.confirm('Delete this fact?')) void run(`d${m.id}`, () => api.delete(`/office/memory/${m.id}`), 'Deleted.'); }} aria-label="Delete"><Trash2 className="size-4" aria-hidden /></Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
