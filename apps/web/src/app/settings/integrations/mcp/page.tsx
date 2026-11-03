'use client';

import { useState } from 'react';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { API_URL, api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, ErrorBanner, Skeleton } from '@/components/ui';
import { Label, inputCls } from '@/components/textile';
import { toast } from '@/components/toast';

type Key = { id: string; name: string; scope: 'read' | 'write'; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type Tool = { name: string; title: string; description: string; write: boolean };
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');

/** Settings → Integrations → MCP server: access keys for the business's own AI assistant. */
export default function McpPage() {
  const keys = useApi<Key[]>('/mcp/keys', 30_000);
  const tools = useApi<Tool[]>('/mcp/tools', 0);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const endpoint = `${API_URL}/mcp`;

  const create = async () => {
    setBusy('create');
    try {
      const r = await api.post<{ key: string; name: string }>('/mcp/keys', { name, scope });
      setCreated(r);
      setName('');
      keys.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await api.post(`/mcp/keys/${id}/revoke`, {});
      toast('Key revoked: it stops working at once.');
      keys.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => toast('Copied.'), () => toast('Copy it by hand.', 'error'));

  return (
    <>
      <PageHeader title="MCP server" crumb="Settings / Integrations" />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Connect an AI assistant" subtitle="Any client that supports the Model Context Protocol over Streamable HTTP with an Authorization header." />
            <div className="space-y-2 px-5 pb-5 text-[13px] text-body">
              <p>Server URL: <code className="break-all rounded bg-slate-100 px-1.5 py-0.5 text-[12px]" data-testid="mcp-endpoint">{endpoint}</code> <button aria-label="Copy URL" className="align-middle text-muted hover:text-ink" onClick={() => copy(endpoint)}><Copy className="inline size-4" /></button></p>
              <p>Header: <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px]">Authorization: Bearer &lt;your access key&gt;</code></p>
              <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-muted">
                <li>A key works only for this workspace. Phone numbers are masked in every answer.</li>
                <li>No tool messages or calls customers: that stays with your team and the safety rules (consent, 24-hour window, test mode).</li>
                <li>Every tool call is recorded in the audit log with the key that made it. Limit: 120 calls a minute per key.</li>
              </ul>
            </div>
          </Card>
          <Card data-testid="mcp-keys">
            <CardHeader title="Access keys" subtitle="Revoke a key as soon as it is no longer needed." />
            <div className="px-5 pb-5">
              {keys.error && <ErrorBanner message={/permission/.test(keys.error) ? 'Only workspace admins can manage access keys.' : keys.error} onRetry={keys.reload} />}
              {!keys.data && !keys.error && <Skeleton className="h-20" />}
              {keys.data?.length === 0 && <p className="text-[13px] text-muted">No keys yet.</p>}
              {keys.data && keys.data.length > 0 && (
                <table className="w-full text-[12.5px]">
                  <thead className="text-muted"><tr><th className="text-left font-semibold">Name</th><th className="text-left font-semibold">Access</th><th className="text-left font-semibold">Key</th><th className="text-left font-semibold">Last used</th><th /></tr></thead>
                  <tbody>
                    {keys.data.map((k) => (
                      <tr key={k.id} className="border-t border-line" data-testid="mcp-key">
                        <td className="py-2 font-semibold text-ink">{k.name}</td>
                        <td><Badge tone={k.scope === 'write' ? 'amber' : 'sky'}>{k.scope === 'write' ? 'read + write' : 'read only'}</Badge></td>
                        <td><code className="text-[12px] text-muted">{k.prefix}…</code></td>
                        <td className="text-muted">{when(k.lastUsedAt)}</td>
                        <td className="text-right">{k.revokedAt ? <Badge tone="slate">revoked</Badge> : <Button variant="ghost" busy={busy === k.id} onClick={() => void revoke(k.id)}>Revoke</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
        </div>
        <div className="space-y-4">
          <Card className="p-5" data-testid="mcp-create">
            <h3 className="flex items-center gap-2 text-[14px] font-bold text-ink"><KeyRound className="size-4" />New access key</h3>
            <div className="mt-3 space-y-3">
              <Label text="Name (who or what uses it)"><input aria-label="Key name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Owner's Claude" /></Label>
              <Label text="Access"><select aria-label="Access" className={inputCls} value={scope} onChange={(e) => setScope(e.target.value as 'read' | 'write')}><option value="read">Read only</option><option value="write">Read + write (notes, stages, tasks)</option></select></Label>
              <Button variant="primary" busy={busy === 'create'} disabled={!name.trim()} onClick={() => void create()}><Plus className="size-4" />Create key</Button>
            </div>
            {created && (
              <div className="mt-3 rounded-[12px] border border-amber-300 bg-amber-50 p-3" data-testid="mcp-new-key">
                <p className="text-[12.5px] font-semibold text-amber-900">Copy the key for “{created.name}” now: it is shown only once.</p>
                <div className="mt-1 flex items-center gap-2"><code className="break-all text-[12px] text-ink">{created.key}</code><button aria-label="Copy key" onClick={() => copy(created.key)} className="text-muted hover:text-ink"><Copy className="size-4" /></button></div>
                <Button className="mt-2" variant="ghost" onClick={() => setCreated(null)}>I have copied it</Button>
              </div>
            )}
          </Card>
          <Card className="p-5" data-testid="mcp-tools">
            <h3 className="text-[14px] font-bold text-ink">Tools</h3>
            <ul className="mt-2 space-y-2 text-[12.5px]">
              {tools.data?.map((t) => <li key={t.name}><span className="font-semibold text-ink">{t.title}</span> {t.write && <Badge tone="amber">write key</Badge>}<p className="text-muted">{t.description}</p></li>)}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
