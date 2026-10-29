'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';
import { SitePage, SiteHero } from '@/components/site';

/**
 * Plans by scope. Prices are agreed at activation (no list price is published yet, so none is shown here).
 * Provider usage is billed by the providers to the customer's own accounts.
 */
const PLANS = [
  { name: 'Pilot', for: 'One team trying one channel', items: ['One industry dashboard', 'WhatsApp assistant on your number', 'Team access with admin, operator and read-only roles', 'Approval queue and audit log', 'Setup help during activation'] },
  { name: 'Growth', for: 'A business running daily on Tacksharp', items: ['Everything in Pilot', 'Voice calls with Sarvam voices', 'Back-office agents and campaigns', 'More locations and numbers', 'Usage and error reporting per provider'], featured: true },
  { name: 'Enterprise', for: 'Groups and multi-site operators', items: ['Everything in Growth', 'Several organizations under one contract', 'Vision AI monitoring for many sites', 'Custom industry modules', 'Deployment and security review'] },
];

export default function PricingPage() {
  return (
    <SitePage>
      <SiteHero title="Pay for the plan, bring your own provider accounts" lead="Plans are priced when we activate your organization, based on the plan and number of locations. WhatsApp, Plivo, Sarvam and OpenAI bill you directly for what you use, so there is no markup on messages, minutes or tokens." />
      <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
        <div className="grid gap-5 lg:grid-cols-3">
          {PLANS.map((p) => (
            <article key={p.name} className={p.featured ? 'rounded-[22px] bg-[#16183d] p-7 text-white' : 'rounded-[22px] border border-[#16183d]/10 bg-white p-7'}>
              <h2 className="text-[22px] font-extrabold tracking-[-0.02em]">{p.name}</h2>
              <p className={p.featured ? 'mt-1 text-[14px] text-white/65' : 'mt-1 text-[14px] text-[#16183d]/60'}>{p.for}</p>
              <p className="mt-5 text-[15px] font-semibold">Quoted at activation</p>
              <ul className="mt-5 grid gap-2.5 text-[14.5px]">
                {p.items.map((i) => <li key={i} className="flex gap-2"><Check className={p.featured ? 'mt-0.5 size-4 shrink-0 text-[#f2a516]' : 'mt-0.5 size-4 shrink-0 text-[#0f9f6e]'} aria-hidden />{i}</li>)}
              </ul>
              <Link href="/signup" className={p.featured ? 'mt-7 block rounded-[12px] bg-white px-4 py-3 text-center text-[14.5px] font-semibold text-[#16183d] hover:bg-[#ebeaf6]' : 'mt-7 block rounded-[12px] border border-[#16183d]/15 px-4 py-3 text-center text-[14.5px] font-semibold hover:border-[#16183d]/40'}>Create an account</Link>
            </article>
          ))}
        </div>
        <div className="mt-12 grid gap-8 md:grid-cols-2">
          <div>
            <h2 className="text-[20px] font-bold">How usage is billed</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-[#16183d]/70">Each provider account you connect is yours, billed by that provider. Tacksharp records the requests it makes for you (tests, model turns, calls) and shows them per provider in Settings. Cost estimates appear only where your administrator has set the provider&apos;s prices; the provider invoice is always the final figure.</p>
          </div>
          <div>
            <h2 className="text-[20px] font-bold">Before you pay anything</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-[#16183d]/70">You can create the organization, explore its dashboard, invite your team and test your provider connections while the account is being reviewed. Messages and calls to customers start only after activation and your own setup.</p>
          </div>
        </div>
      </section>
    </SitePage>
  );
}
