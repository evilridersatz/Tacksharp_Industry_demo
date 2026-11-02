'use client';

import { useState } from 'react';
import { Check, Copy, Eye, Languages } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { Button, Card, CardHeader, ErrorBanner, Skeleton } from '@/components/ui';
import { toast } from '@/components/toast';

type Tool = { name: string; description: string; method: string; url: string; headers: Record<string, string>; body: Record<string, string>; saveReplyIntoVariables: string[] };
export type ConfigPack = {
  language: { startingLanguage: string; allowedLanguages: string[]; neverAllowed: string[]; autoDetect: string; rule: string };
  instructions: string;
  onStartHook: Omit<Tool, 'name' | 'description'>;
  tools: Tool[];
  postCallWebhook: string | null;
  notes: string[];
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-[12px] font-semibold text-ink hover:bg-canvas"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => toast('Copy failed: select and copy the text instead.', 'error'))}
      aria-label={`Copy ${label}`}
    >
      {done ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />} {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * Everything the Sarvam console needs for this business's phone agent: language settings (Tamil + English, never
 * Hindi), instructions that send every fact through our tools, the tools themselves and the on-start hook. Sarvam
 * offers no API for these settings, so this pack is the source of truth an admin copies into the console.
 */
export function SarvamConfigPack({ canReveal }: { canReveal: boolean }) {
  const { data, error } = useApi<ConfigPack>('/telephony/sarvam/tools/config', 0);
  const [revealed, setRevealed] = useState<ConfigPack | null>(null);
  const pack = revealed ?? data;
  async function reveal() {
    try { setRevealed(await api.get<ConfigPack>('/telephony/sarvam/tools/config?reveal=1')); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  }
  return (
    <Card>
      <CardHeader title="Sarvam phone agent setup" subtitle="Copy these into your Sarvam agent so it answers from your live menu and prices, in Tamil or English only." />
      {error ? <ErrorBanner message={error} /> : !pack ? <Skeleton className="h-40" /> : (
        <div className="space-y-4 text-[12.5px]" data-testid="sarvam-config-pack">
          <section className="rounded-[10px] border border-line p-3">
            <p className="flex items-center gap-1.5 font-semibold text-ink"><Languages className="size-4" aria-hidden />Languages (Sarvam console → agent → Languages)</p>
            <ul className="mt-2 space-y-1 text-body">
              <li>Starting language: <b>{pack.language.startingLanguage}</b></li>
              <li>Languages allowed: <b>{pack.language.allowedLanguages.join(' and ')}</b> only</li>
              <li>Remove: <b className="text-rose-700">{pack.language.neverAllowed.join(', ')}</b></li>
              <li>Auto-detect: {pack.language.autoDetect}</li>
            </ul>
          </section>
          <section className="rounded-[10px] border border-line p-3">
            <div className="flex items-center justify-between gap-2"><p className="font-semibold text-ink">Agent instructions</p><CopyButton text={pack.instructions} label="instructions" /></div>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-2 text-[12px] text-body">{pack.instructions}</pre>
          </section>
          <section className="rounded-[10px] border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-ink">Tools and on-start hook ({pack.tools.length + 1})</p>
              <div className="flex gap-2">
                {canReveal && !revealed && <Button variant="ghost" onClick={() => void reveal()}><Eye className="size-3.5" aria-hidden />Show the tool key</Button>}
                <CopyButton text={JSON.stringify({ onStartHook: pack.onStartHook, tools: pack.tools }, null, 2)} label="tools" />
              </div>
            </div>
            {!revealed && <p className="mt-1 text-[12px] text-muted">The tool key is hidden. {canReveal ? 'Show it only when you paste it into Sarvam; it lets a caller place orders for this shop.' : 'An organization admin can show it.'}</p>}
            <ul className="mt-2 space-y-2">
              <li className="rounded-md bg-canvas p-2"><b>on-start hook</b> · {pack.onStartHook.method} <span className="break-all">{pack.onStartHook.url}</span><br /><span className="text-muted">saves: {pack.onStartHook.saveReplyIntoVariables.join(', ')}</span></li>
              {pack.tools.map((t) => (
                <li key={t.name} className="rounded-md bg-canvas p-2"><b>{t.name}</b> · {t.description}<br /><span className="break-all text-muted">{t.method} {t.url} · body: {Object.keys(t.body).join(', ') || 'none'} · saves: {t.saveReplyIntoVariables.join(', ')}</span></li>
              ))}
            </ul>
          </section>
          <section className="rounded-[10px] border border-line p-3">
            <div className="flex items-center justify-between gap-2"><p className="font-semibold text-ink">Post-call webhook (call results and transcript)</p>{revealed && pack.postCallWebhook && <CopyButton text={pack.postCallWebhook} label="webhook URL" />}</div>
            <p className="mt-1 break-all text-body">{pack.postCallWebhook ?? 'Set TELEPHONY_WEBHOOK_SECRET on the server first.'}</p>
          </section>
          <ul className="list-disc space-y-1 pl-5 text-[12px] text-amber-900">{pack.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}
