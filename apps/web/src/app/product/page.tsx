'use client';

import Link from 'next/link';
import { Bot, ClipboardCheck, Gauge, KeyRound, MessageSquare, PhoneCall, ShieldCheck, Users } from 'lucide-react';
import { SitePage, SiteHero } from '@/components/site';

const PARTS = [
  { icon: MessageSquare, t: 'WhatsApp assistant', d: 'Answers customers on your WhatsApp Business number in Tamil, English or a mix. Voice notes are transcribed. Prices, stock and slots come from your records; it never invents an offer.' },
  { icon: PhoneCall, t: 'Voice calls', d: 'Calls leads back, confirms visits and tells customers their order is ready, through your own Plivo number with Sarvam voices. Calls respect your calling hours and opt-outs.' },
  { icon: Bot, t: 'Back-office agents', d: 'Sales, operations, marketing and finance agents draft quotations, reserve stock, prepare campaigns and payment reminders. Anything that commits money or reaches many customers waits for a person.' },
  { icon: Gauge, t: 'A dashboard per industry', d: 'Real estate sees leads and site visits; a restaurant sees orders and its menu; a hospital sees appointments. Same login, same data rules, different work.' },
  { icon: Users, t: 'Team and access', d: 'Invite people by link, choose admin, manager, operator or read-only access, and remove access instantly. Roles are checked by the server on every request.' },
  { icon: KeyRound, t: 'Your provider accounts', d: 'Connect your own WhatsApp, Plivo, Sarvam and OpenAI accounts. Keys are encrypted at rest, masked on screen and tested before use. You see usage and errors per provider.' },
  { icon: ClipboardCheck, t: 'Approvals and audit', d: 'Discounts, campaigns, invoices and stock corrections go through an approval queue. Every sign-in, change and approval is recorded.' },
  { icon: ShieldCheck, t: 'Safe by default', d: 'New organizations run in a recording-only mode until numbers, templates and test recipients are set up. Delivery counts only when WhatsApp confirms it.' },
];

export default function ProductPage() {
  return (
    <SitePage>
      <SiteHero title="Everything an AI employee needs to do real work" lead="Tacksharp connects your customer channels, your records and your team. The assistant does the routine work; your people see everything and approve what matters." />
      <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
        <ul className="grid gap-x-10 gap-y-10 md:grid-cols-2">
          {PARTS.map((p) => (
            <li key={p.t} className="flex gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-[#ebeaf6]"><p.icon className="size-5" aria-hidden /></span>
              <div><h2 className="text-[18px] font-bold tracking-[-0.01em]">{p.t}</h2><p className="mt-1.5 text-[15px] leading-relaxed text-[#16183d]/70">{p.d}</p></div>
            </li>
          ))}
        </ul>
      </section>
      <section className="border-t border-[#16183d]/8 bg-white">
        <div className="mx-auto grid max-w-[1200px] gap-8 px-4 py-14 sm:px-6 md:grid-cols-[1fr_1fr]">
          <div>
            <h2 className="text-[28px] font-extrabold tracking-[-0.03em]">What we will not pretend</h2>
            <p className="mt-3 text-[15.5px] leading-relaxed text-[#16183d]/70">An integration shows as connected only after a real test against the provider passes. A module that is not built yet is marked unavailable instead of showing sample numbers. Demo workspaces are labelled and never message real customers.</p>
          </div>
          <div className="flex flex-wrap content-start gap-3 md:justify-end">
            <Link href="/signup" className="rounded-[12px] bg-[#16183d] px-5 py-3.5 text-[15px] font-semibold text-white hover:bg-[#262a63]">Create your organization</Link>
            <Link href="/docs" className="rounded-[12px] border border-[#16183d]/15 px-5 py-3.5 text-[15px] font-semibold hover:border-[#16183d]/40">Read the setup guide</Link>
          </div>
        </div>
      </section>
    </SitePage>
  );
}
