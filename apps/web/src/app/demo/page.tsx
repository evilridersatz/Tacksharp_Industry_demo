'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Building2, Cctv, Factory, HeartPulse, Hotel, Loader2, Shirt, ShoppingBag, UtensilsCrossed } from 'lucide-react';
import { api } from '@/lib/api';
import { switchWorkspace } from '@/lib/industry';
import { SitePage, SiteHero } from '@/components/site';

type Option = { organizationId: string; name: string; isDemo: boolean; industry: string; current: boolean; status?: string };

const DEMOS: Array<{ industry: string; t: string; icon: typeof Building2; d: string }> = [
  { industry: 'real_estate', t: 'Real estate', icon: Building2, d: 'Leads from WhatsApp, site visits, follow-up calls and pipeline.' },
  { industry: 'food', t: 'Restaurant', icon: UtensilsCrossed, d: 'Orders by WhatsApp and phone, menu, stock and kitchen status.' },
  { industry: 'textile', t: 'Textile', icon: Shirt, d: 'Catalogue, quotations, sales orders, campaigns and finance.' },
  { industry: 'retail', t: 'Retail', icon: ShoppingBag, d: 'Enquiries, sales, campaigns and stock alerts.' },
  { industry: 'manufacturing', t: 'Manufacturing', icon: Factory, d: 'Quality inspections, stock and corrective actions.' },
  { industry: 'hospital', t: 'Healthcare', icon: HeartPulse, d: 'Appointments, patient enquiries and insurance desk.' },
  { industry: 'hotel', t: 'Hotel', icon: Hotel, d: 'Reservations, rooms and guest messages.' },
  { industry: 'cctv', t: 'Vision AI', icon: Cctv, d: 'Sites, cameras, recorders, incidents and technicians.' },
];

/**
 * Demo selection. Demo workspaces hold sample data only and never message real customers. Opening one needs a login
 * with access to it (Tacksharp grants demo access); the server checks it, this page only lists what you can open.
 */
export default function DemoPage() {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Option[]>('/auth/workspaces').then((o) => { setOptions(o); setSignedIn(true); }).catch(() => setSignedIn(false));
  }, []);
  const demoFor = (industry: string) => options?.find((o) => o.isDemo && o.industry === industry);

  return (
    <SitePage>
      <SiteHero title="Open an industry demo" lead="Demo workspaces are filled with sample customers, orders and calls so you can try every screen. They are clearly labelled, and nothing in them reaches a real person." />
      <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
        {signedIn === false && (
          <p role="note" className="mb-6 rounded-[14px] bg-[#ebeaf6] px-4 py-3 text-[14.5px]">
            <Link href="/login?next=/demo" className="font-semibold underline">Log in</Link> to open the demos your account can access, or <Link href="/signup" className="font-semibold underline">create your organization</Link> and ask Tacksharp for demo access during activation.
          </p>
        )}
        {error && <p role="alert" className="mb-6 rounded-[14px] bg-rose-50 px-4 py-3 text-[14px] text-rose-800">{error}</p>}
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {DEMOS.map((d) => {
            const ws = demoFor(d.industry);
            return (
              <li key={d.industry} className="flex flex-col rounded-[18px] border border-[#16183d]/10 bg-white p-5">
                <d.icon className="size-6 text-[#0f9f6e]" aria-hidden />
                <h2 className="mt-3 text-[17px] font-bold">{d.t}</h2>
                <p className="mt-1 flex-1 text-[14px] leading-relaxed text-[#16183d]/65">{d.d}</p>
                {signedIn === null ? (
                  <span className="mt-4 text-[13px] text-[#16183d]/50">Checking access…</span>
                ) : ws ? (
                  <button disabled={busy !== null} onClick={async () => {
                    setBusy(d.industry); setError(null);
                    try { await switchWorkspace(ws.organizationId, '/'); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(null); }
                  }} className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-[10px] bg-[#16183d] text-[14px] font-semibold text-white hover:bg-[#262a63] disabled:opacity-60">
                    {busy === d.industry && <Loader2 className="size-4 animate-spin" aria-hidden />}Open {d.t.toLowerCase()} demo
                  </button>
                ) : (
                  <span className="mt-4 text-[13px] text-[#16183d]/55">{signedIn ? 'Your account has no access to this demo.' : 'Log in to open.'}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </SitePage>
  );
}
