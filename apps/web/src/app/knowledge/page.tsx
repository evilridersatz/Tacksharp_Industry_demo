'use client';

import { useEffect, useState } from 'react';
import { BookOpen, FileText, PenLine, RefreshCw, Trash2, Upload } from 'lucide-react';
import { API_URL, ApiError, api, useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, Empty, ErrorBanner, Segmented, Skeleton, cx } from '@/components/ui';
import { Dialog, inputCls } from '@/components/textile';
import { toast } from '@/components/toast';

type BaseRow = { id: string; name: string; agents: Array<{ id: string; name: string; status: string }>; documents: number; openGaps: number };
type Doc = { id: string; filename: string; kind: string; status: string; error: string | null; chunkCount: number; charCount: number; flaggedLines: number; authored: boolean; processedAt: string | null; createdAt: string };
type Base = { id: string; name: string; documents: Doc[]; agents: Array<{ id: string; name: string; status: string }> };
type Gap = { id: string; question: string; channel: string; count: number; status: string; lastAskedAt: string };
type Hit = { text: string; filename: string; source: string; score: number };
type Tab = 'documents' | 'gaps' | 'try';

const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const ago = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATUS: Record<string, 'brand' | 'amber' | 'rose' | 'slate'> = { indexed: 'brand', processing: 'amber', uploaded: 'amber', failed: 'rose' };

/**
 * Knowledge studio: every knowledge base of the workspace, its documents (upload, typed answers, passages), the
 * questions agents could not answer (from calls and the test console), and a retrieval tester.
 */
export default function KnowledgeStudio() {
  const { data: bases, error, reload } = useApi<BaseRow[]>('/knowledge-studio', 30_000);
  const [sel, setSel] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const current = bases?.find((b) => b.id === sel) ?? bases?.[0] ?? null;

  async function create() {
    try { const b = await api.post<{ id: string }>('/knowledge-bases', { name: newName }); setNewName(''); await reload(); setSel(b.id); toast('Knowledge base created.'); } catch (e) { toast(errMsg(e), 'error'); }
  }

  return (
    <>
      <PageHeader title="Knowledge studio" crumb="AI agents" />
      {error ? <ErrorBanner message={error} onRetry={reload} /> : !bases ? <Skeleton className="h-96" /> : (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <Card className="h-fit">
            <CardHeader title="Knowledge bases" />
            <ul className="grid gap-0.5 px-2" aria-label="Knowledge bases">
              {bases.map((b) => (
                <li key={b.id}>
                  <button type="button" aria-current={current?.id === b.id ? 'true' : undefined} onClick={() => setSel(b.id)} className={cx('flex w-full items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-left text-[13px]', current?.id === b.id ? 'bg-slate-100 font-semibold text-ink' : 'text-body hover:bg-slate-50')}>
                    <span className="truncate">{b.name}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">{b.documents}{b.openGaps > 0 && <Badge tone="amber">{b.openGaps} unanswered</Badge>}</span>
                  </button>
                </li>
              ))}
            </ul>
            <form className="flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
              <label htmlFor="kb-new" className="sr-only">New knowledge base name</label>
              <input id="kb-new" className={inputCls} placeholder="New knowledge base" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Button type="submit" disabled={newName.trim().length < 2}>Add</Button>
            </form>
          </Card>
          {current ? <BaseView key={current.id} id={current.id} openGaps={current.openGaps} onChanged={reload} /> : (
            <Card><Empty icon={<BookOpen className="size-8" />} title="No knowledge base yet">Create one, then upload your menu, price list or FAQ, or type answers directly. Agents answer only from it.</Empty></Card>
          )}
        </div>
      )}
    </>
  );
}

function BaseView({ id, openGaps, onChanged }: { id: string; openGaps: number; onChanged: () => void }) {
  const { data: base, error, reload } = useApi<Base>(`/knowledge-bases/${id}`, 5_000);
  const [tab, setTab] = useState<Tab>('documents');
  const [editor, setEditor] = useState<null | { docId?: string; gapId?: string; title: string; text: string }>(null);
  const [view, setView] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gapsVersion, setGapsVersion] = useState(0);
  const refresh = async () => { await reload(); onChanged(); setGapsVersion((v) => v + 1); };

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      setBusy('upload');
      const form = new FormData();
      form.append('file', f);
      try {
        const res = await fetch(`${API_URL}/knowledge-bases/${id}/documents`, { method: 'POST', body: form, credentials: 'include' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.message ?? `Upload failed (${res.status})`);
        toast(`${f.name}: uploaded, indexing…`);
      } catch (e) { toast(`${f.name}: ${errMsg(e)}`, 'error'); }
    }
    setBusy(null);
    await refresh();
  }
  async function act(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try { await fn(); toast(done); await refresh(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  }
  async function openAnswer(docId: string) {
    try { const a = await api.get<{ title: string; text: string }>(`/knowledge-documents/${docId}/answer`); setEditor({ docId, title: a.title, text: a.text }); } catch (e) { toast(errMsg(e), 'error'); }
  }

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!base) return <Skeleton className="h-96" />;
  const indexed = base.documents.filter((d) => d.status === 'indexed').length;
  return (
    <div className="grid min-w-0 content-start gap-4">
      <Card className="min-w-0">
        <CardHeader
          title={base.name}
          subtitle={`${indexed} of ${base.documents.length} documents ready · used by ${base.agents.length ? base.agents.map((a) => a.name).join(', ') : 'no agent yet'}`}
          action={
            <span className="flex flex-wrap gap-2">
              <Button className="whitespace-nowrap" onClick={() => setEditor({ title: '', text: '' })}><PenLine className="size-4" /> Write an answer</Button>
              <label className={cx('inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] bg-brand px-3.5 text-[13px] font-semibold text-white', busy === 'upload' && 'opacity-60')}>
                <Upload className="size-4" /> Upload files
                <input type="file" className="sr-only" multiple accept=".pdf,.docx,.txt,.md,.csv" aria-label="Upload files" onChange={(e) => { void upload(e.target.files); e.currentTarget.value = ''; }} />
              </label>
            </span>
          }
        />
        <div className="px-5 pb-3">
          <Segmented<Tab> label="Knowledge studio section" value={tab} onChange={setTab} options={[{ value: 'documents', label: `Documents (${base.documents.length})` }, { value: 'gaps', label: `Unanswered (${openGaps})` }, { value: 'try', label: 'Try a question' }]} />
        </div>
      </Card>

      {tab === 'documents' && (
        <Card className="overflow-hidden">
          {base.documents.length === 0 ? <Empty icon={<FileText className="size-8" />} title="Nothing here yet">Upload a PDF, Word, text or CSV file, or write an answer. Instructions hidden in files are neutralised; agents never follow them.</Empty> : (
            <ul className="divide-y divide-line" aria-label="Documents">
              {base.documents.map((d) => (
                <li key={d.id} data-testid="kb-doc" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 text-[13px]">
                  <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                    <p className="font-semibold break-words text-ink sm:truncate">{d.filename}</p>
                    <p className="text-[12px] text-muted">{d.authored ? 'Written in the studio' : d.kind.toUpperCase()} · {d.chunkCount} passages{d.flaggedLines ? ` · ${d.flaggedLines} instruction-like lines neutralised` : ''}{d.error ? ` · ${d.error}` : ''}</p>
                  </div>
                  <Badge tone={STATUS[d.status] ?? 'slate'}>{d.status}</Badge>
                  <span className="flex gap-1.5">
                    {d.status === 'indexed' && <Button onClick={() => setView(d.id)}>Passages</Button>}
                    {d.authored && <Button onClick={() => void openAnswer(d.id)}>Edit</Button>}
                    {d.status === 'failed' && <Button busy={busy === `re-${d.id}`} onClick={() => void act(`re-${d.id}`, () => api.post(`/knowledge-documents/${d.id}/reprocess`), 'Indexing again.')}><RefreshCw className="size-4" /> Retry</Button>}
                    <Button variant="danger" aria-label={`Delete ${d.filename}`} busy={busy === `del-${d.id}`} onClick={() => void act(`del-${d.id}`, () => api.delete(`/knowledge-documents/${d.id}`), 'Deleted.')}><Trash2 className="size-4" /></Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {tab === 'gaps' && <Gaps key={gapsVersion} baseId={id} onAnswer={(g) => setEditor({ gapId: g.id, title: g.question, text: '' })} onChanged={refresh} />}
      {tab === 'try' && <TryQuestion baseId={id} />}

      <Dialog open={editor !== null} onClose={() => setEditor(null)} title={editor?.docId ? 'Edit answer' : editor?.gapId ? 'Answer this question' : 'Write an answer'} wide>
        {editor && (
          <form className="grid gap-3 text-[13px]" onSubmit={(e) => {
            e.preventDefault();
            const body = { title: editor.title, text: editor.text, ...(editor.gapId ? { gapId: editor.gapId } : {}) };
            void act('save', () => (editor.docId ? api.put(`/knowledge-documents/${editor.docId}/answer`, body) : api.post(`/knowledge-bases/${id}/answers`, body)), editor.docId ? 'Answer updated; re-indexed.' : 'Answer saved; agents use it now.').then(() => setEditor(null));
          }}>
            <label className="grid gap-1"><span className="font-semibold">Question or title</span><input className={inputCls} value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} placeholder="Do you deliver to Tambaram?" /></label>
            <label className="grid gap-1"><span className="font-semibold">Answer</span><textarea className={cx(inputCls, 'h-48 py-2')} value={editor.text} onChange={(e) => setEditor({ ...editor, text: e.target.value })} placeholder="Write the facts the agent may say: timings, prices, areas, conditions." /></label>
            <p className="text-[12px] text-muted">Write facts, not instructions: agents treat this as reference text. Include the words customers use so the question finds it.</p>
            <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEditor(null)}>Cancel</Button><Button type="submit" variant="primary" busy={busy === 'save'} disabled={editor.title.trim().length < 3 || editor.text.trim().length < 10}>Save answer</Button></div>
          </form>
        )}
      </Dialog>
      <Passages docId={view} onClose={() => setView(null)} />
    </div>
  );
}

function Gaps({ baseId, onAnswer, onChanged }: { baseId: string; onAnswer: (g: Gap) => void; onChanged: () => void }) {
  const [status, setStatus] = useState<'open' | 'answered' | 'ignored'>('open');
  const { data: gaps, error, reload } = useApi<Gap[]>(`/knowledge-gaps?knowledgeBaseId=${encodeURIComponent(baseId)}&status=${status}`, 15_000);
  async function setGap(g: Gap, s: 'ignored' | 'open') {
    try { await api.post(`/knowledge-gaps/${g.id}/status`, { status: s }); toast(s === 'ignored' ? 'Ignored.' : 'Moved back to unanswered.'); await reload(); onChanged(); } catch (e) { toast(errMsg(e), 'error'); }
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <p className="text-[12.5px] text-muted">Questions an agent answered with its “let me check” message, from real calls and the test console. Most asked first.</p>
        <Segmented label="Question status" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Unanswered' }, { value: 'answered', label: 'Answered' }, { value: 'ignored', label: 'Ignored' }]} />
      </div>
      {error ? <ErrorBanner message={error} onRetry={reload} /> : !gaps ? <Skeleton className="h-40" /> : gaps.length === 0 ? <Empty title={status === 'open' ? 'No unanswered questions' : 'Nothing here'}>{status === 'open' ? 'When an agent cannot answer from this knowledge base, the question appears here.' : null}</Empty> : (
        <ul className="divide-y divide-line border-t border-line" aria-label="Unanswered questions">
          {gaps.map((g) => (
            <li key={g.id} data-testid="kb-gap" className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px]">
              <div className="min-w-0 basis-full sm:basis-0 sm:flex-1"><p className="font-semibold break-words text-ink">{g.question}</p><p className="text-[12px] text-muted">Asked {g.count} time{g.count === 1 ? '' : 's'} · last {ago(g.lastAskedAt)} · {g.channel === 'call' ? 'on a call' : 'test console'}</p></div>
              <span className="flex gap-1.5">
                {status === 'open' && <Button variant="primary" onClick={() => onAnswer(g)}>Answer</Button>}
                {status === 'open' && <Button onClick={() => void setGap(g, 'ignored')}>Ignore</Button>}
                {status === 'ignored' && <Button onClick={() => void setGap(g, 'open')}>Restore</Button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TryQuestion({ baseId }: { baseId: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  async function go() {
    try { setHits((await api.get<{ results: Hit[] }>(`/knowledge-bases/${baseId}/search?q=${encodeURIComponent(q)}`)).results); } catch (e) { toast(errMsg(e), 'error'); }
  }
  return (
    <Card>
      <CardHeader title="Try a question" subtitle="The passages an agent would receive for this question, best first. No AI model is called." />
      <form className="flex gap-2 px-5" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <label htmlFor="kb-try" className="sr-only">Question</label>
        <input id="kb-try" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="What are your Sunday timings?" />
        <Button type="submit" variant="primary" disabled={!q.trim()}>Search</Button>
      </form>
      <div className="px-5 py-4">
        {hits === null ? null : hits.length === 0 ? <p role="status" className="text-[13px] text-amber-800">Nothing matches: an agent would give its “let me check” reply. Write an answer for it.</p> : (
          <ol className="grid gap-2" aria-label="Matching passages">
            {hits.map((h, i) => <li key={i} data-testid="kb-hit" className="rounded-[10px] border border-line p-3 text-[13px]"><p className="mb-1 text-[12px] text-muted">{h.filename}{h.source ? ` · ${h.source}` : ''} · score {h.score.toFixed(2)}</p><p className="whitespace-pre-wrap text-body">{h.text}</p></li>)}
          </ol>
        )}
      </div>
    </Card>
  );
}

function Passages({ docId, onClose }: { docId: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ document: { filename: string }; passages: Array<{ ord: number; source: string | null; text: string }> } | null>(null);
  useEffect(() => {
    setData(null);
    if (docId) api.get<typeof data>(`/knowledge-documents/${docId}/passages`).then(setData, (e) => toast(errMsg(e), 'error'));
  }, [docId]);
  return (
    <Dialog open={docId !== null} onClose={onClose} title={data ? `Passages: ${data.document.filename}` : 'Passages'} wide>
      {!data ? <Skeleton className="h-40" /> : (
        <ol className="grid max-h-[60vh] gap-2 overflow-y-auto text-[13px]" aria-label="Passages">
          {data.passages.map((p) => <li key={p.ord} data-testid="kb-passage" className="rounded-[10px] bg-slate-50 p-3"><p className="mb-1 text-[12px] text-muted">#{p.ord + 1}{p.source ? ` · ${p.source}` : ''}</p><p className="whitespace-pre-wrap">{p.text}</p></li>)}
        </ol>
      )}
    </Dialog>
  );
}
