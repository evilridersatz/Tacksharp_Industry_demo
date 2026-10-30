'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Car, Factory, GraduationCap, HeartPulse, Hotel, Landmark, Loader2, ShoppingBag, Headset, UtensilsCrossed, X } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { SitePage, SiteHero } from '@/components/site';
import { AgentConsole, type AgentReply } from '@/components/agent-console';

export type TemplateView = {
  key: string; industry: string; title: string; businessName: string; scenario: string; useCase: string; greeting: string;
  languages: string[]; exampleQuestions: string[]; expectedOutcome: string; instructions: string; knowledge: string;
};
const ICONS: Record<string, typeof Building2> = { retail: ShoppingBag, restaurant: UtensilsCrossed, real_estate: Building2, healthcare: HeartPulse, education: GraduationCap, automotive: Car, banking: Landmark, manufacturing: Factory, hospitality: Hotel, general_support: Headset };
const LANG: Record<string, string> = { ta: 'தமிழ்', en: 'English', tanglish: 'Tanglish' };

/**
 * Voice agent demos: ten ready-made agents on SAMPLE data, all running on the same agent engine as published
 * agents. Simulated: no call or message reaches anyone and nothing is stored.
 */
export default function VoiceDemosPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<TemplateView | null>(null);
  const [voice, setVoice] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<TemplateView[]>('/demos/agents').then(setTemplates).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api.get<{ voice: boolean }>('/assistant/status').then((s) => setVoice(Boolean(s.voice))).catch(() => setVoice(false));
  }, []);

  /** Customise and publish: signed in -> a draft agent from this template in the Agent Builder; else sign up first. */
  async function customise(t: TemplateView) {
    setBusy(true); setError(null);
    try {
      const a = await api.post<{ id: string }>('/voice-agents', { templateKey: t.key });
      router.push(`/voice-agents/${a.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.push(`/signup?next=${encodeURIComponent('/voice-demos')}`);
      else setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <SitePage>
      <SiteHero title="Voice agent demos" lead="Talk to ten ready-made AI agents in Tamil, English or Tanglish, by chat or voice. Every business, number and price here is sample data. The demos are simulated: no call is placed and nothing is stored." />
      <section className="mx-auto max-w-[1200px] px-4 py-12 sm:px-6">
        {error && <p role="alert" className="mb-6 rounded-[14px] bg-rose-50 px-4 py-3 text-[14px] text-rose-800">{error}</p>}
        {!templates ? (
          <p className="inline-flex items-center gap-2 text-[14px] text-[#16183d]/60"><Loader2 className="size-4 animate-spin" />Loading demos…</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Agent templates">
            {templates.map((t) => {
              const Icon = ICONS[t.key] ?? Headset;
              return (
                <li key={t.key} className="flex flex-col rounded-[18px] border border-[#16183d]/10 bg-white p-5" data-testid={`demo-${t.key}`}>
                  <div className="flex items-center gap-2"><Icon className="size-5 text-[#0f9f6e]" aria-hidden /><span className="text-[12px] font-semibold text-[#16183d]/55">{t.businessName}</span></div>
                  <h2 className="mt-2 text-[17px] font-bold">{t.title}</h2>
                  <p className="mt-1 text-[14px] leading-relaxed text-[#16183d]/70">{t.scenario}</p>
                  <p className="mt-2 text-[12.5px] text-[#16183d]/55">Languages: {t.languages.map((l) => LANG[l] ?? l).join(' · ')}</p>
                  <p className="mt-1 flex-1 text-[12.5px] text-[#16183d]/55">Outcome: {t.expectedOutcome}</p>
                  <div className="mt-4 flex gap-2">
                    <button onClick={() => setOpen(t)} className="inline-flex h-10 flex-1 items-center justify-center rounded-[10px] bg-[#16183d] text-[14px] font-semibold text-white hover:bg-[#262a63]">Try the demo</button>
                    <button onClick={() => void customise(t)} disabled={busy} className="inline-flex h-10 items-center justify-center rounded-[10px] border border-[#16183d]/15 px-3 text-[13.5px] font-semibold hover:bg-[#ebeaf6] disabled:opacity-50">Customise</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {open && (
        <div role="dialog" aria-modal="true" aria-label={`${open.title} demo`} className="fixed inset-0 z-[60] grid place-items-center bg-[#16183d]/50 p-3 backdrop-blur-sm" onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}>
          <div className="grid w-full max-w-[980px] gap-4 rounded-[20px] bg-white p-4 sm:p-5 lg:grid-cols-[1fr_1.1fr]">
            <div className="min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div><p className="text-[12px] font-semibold text-[#16183d]/55">{open.businessName}</p><h2 className="text-[20px] font-bold">{open.title}</h2></div>
                <button onClick={() => setOpen(null)} aria-label="Close demo" className="grid size-9 place-items-center rounded-[10px] hover:bg-[#ebeaf6] lg:hidden"><X className="size-4" /></button>
              </div>
              <p className="mt-2 text-[13.5px] text-[#16183d]/70">{open.scenario}</p>
              <h3 className="mt-4 text-[13px] font-bold">Agent instructions</h3>
              <p className="mt-1 max-h-32 overflow-y-auto rounded-[10px] bg-[#f7f8fc] p-2.5 text-[12.5px] leading-relaxed text-[#16183d]/75">{open.instructions}</p>
              <h3 className="mt-3 text-[13px] font-bold">Sample knowledge base</h3>
              <pre className="mt-1 max-h-40 overflow-y-auto rounded-[10px] bg-[#f7f8fc] p-2.5 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-[#16183d]/75">{open.knowledge}</pre>
              <p className="mt-3 text-[12.5px] text-[#16183d]/60">Expected outcome: {open.expectedOutcome}</p>
              <button onClick={() => void customise(open)} disabled={busy} className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-[10px] bg-[#0f9f6e] px-4 text-[14px] font-semibold text-white disabled:opacity-60">{busy && <Loader2 className="size-4 animate-spin" />}Customise and publish for my business</button>
            </div>
            <div className="min-w-0">
              <div className="mb-2 hidden justify-end lg:flex"><button onClick={() => setOpen(null)} aria-label="Close demo" className="grid size-9 place-items-center rounded-[10px] hover:bg-[#ebeaf6]"><X className="size-4" /></button></div>
              <AgentConsole
                key={open.key}
                greeting={open.greeting}
                examples={open.exampleQuestions}
                label="Simulated demo · sample data"
                voice={voice}
                send={(message, history) => api.post<AgentReply>(`/demos/agents/${open.key}/chat`, { message, history })}
              />
            </div>
          </div>
        </div>
      )}
    </SitePage>
  );
}
