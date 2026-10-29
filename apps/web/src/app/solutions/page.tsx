'use client';

import Link from 'next/link';
import { Building2, Cctv, Factory, HeartPulse, ShoppingBag, UtensilsCrossed } from 'lucide-react';
import { SitePage, SiteHero } from '@/components/site';

/** What each industry dashboard contains today. "In development" items are said so, not shown as working. */
const INDUSTRIES = [
  { icon: Building2, t: 'Real estate', who: 'Developers, brokers and channel partners', has: ['Leads and enquiries with budget, location and BHK captured from chat', 'Property inventory', 'AI follow-up messages and calls', 'Site visits with reminders and confirmations', 'Conversion and pipeline analytics', 'WhatsApp campaign performance'], dev: [] },
  { icon: UtensilsCrossed, t: 'Restaurants and food', who: 'Meat shops, cloud kitchens, restaurants', has: ['WhatsApp and phone ordering with server-calculated prices', 'Menu and stock management', 'Outlets and pickup times', 'Order follow-ups and ready calls', 'Customer enquiries and handoff to staff', 'Revenue analytics'], dev: [] },
  { icon: ShoppingBag, t: 'Retail and textile', who: 'Shops, wholesalers, textile traders', has: ['Customer enquiries and catalogue answers', 'Quotations and sales orders', 'WhatsApp campaigns with approval', 'Customer follow-ups and feedback', 'Inventory with low-stock alerts'], dev: [] },
  { icon: Factory, t: 'Manufacturing', who: 'Plants and workshops', has: ['Quality inspections and results', 'Inventory and stock movements', 'Work tasks for operations', 'Exceptions and corrective actions'], dev: ['Production line overview from machine data (needs a plant data connection)'] },
  { icon: HeartPulse, t: 'Healthcare', who: 'Hospitals and clinics', has: ['Appointment requests and confirmations', 'Patient enquiries handled without giving medical advice', 'Follow-ups and reminders', 'Operational reporting', 'Reception and insurance desk roles with restricted access'], dev: [] },
  { icon: Cctv, t: 'Vision AI and CCTV', who: 'Security integrators and multi-site operators', has: ['Camera and recorder inventory per site', 'Device connectivity from on-site agents', 'Monitoring events and incidents', 'Technician notifications and escalation', 'Agent and service health'], dev: ['Object detection results are shown only when a working camera, stream or inference service supplies them'] },
];

export default function SolutionsPage() {
  return (
    <SitePage>
      <SiteHero title="A dashboard shaped for your industry" lead="Choose your industry when you sign up. The menu, records and assistant match the way your business works. Admins can switch industry later if the plan allows it." />
      <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
        <div className="grid gap-px overflow-hidden rounded-[22px] bg-[#16183d]/10 md:grid-cols-2">
          {INDUSTRIES.map((x) => (
            <article key={x.t} className="bg-white p-7">
              <div className="flex items-center gap-3"><x.icon className="size-6 text-[#0f9f6e]" aria-hidden /><h2 className="text-[20px] font-bold tracking-[-0.01em]">{x.t}</h2></div>
              <p className="mt-1 text-[14px] text-[#16183d]/55">{x.who}</p>
              <ul className="mt-4 grid gap-1.5 text-[14.5px] text-[#16183d]/80">
                {x.has.map((h) => <li key={h} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#0f9f6e]" aria-hidden />{h}</li>)}
              </ul>
              {x.dev.length > 0 && (
                <ul className="mt-3 grid gap-1.5 text-[13.5px] text-[#16183d]/60">
                  {x.dev.map((h) => <li key={h} className="flex gap-2"><span className="mt-1.5 shrink-0 rounded-full bg-[#f2a516]/20 px-1.5 text-[11px] font-semibold text-[#8a5a00]">In development</span>{h}</li>)}
                </ul>
              )}
            </article>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/signup" className="rounded-[12px] bg-[#16183d] px-5 py-3.5 text-[15px] font-semibold text-white hover:bg-[#262a63]">Create your organization</Link>
          <Link href="/demo" className="rounded-[12px] border border-[#16183d]/15 px-5 py-3.5 text-[15px] font-semibold hover:border-[#16183d]/40">Open a demo</Link>
        </div>
      </section>
    </SitePage>
  );
}
