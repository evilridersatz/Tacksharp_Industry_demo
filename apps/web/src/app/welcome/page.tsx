'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Building2, CheckCheck, Cctv, Factory, HeartPulse, Lock, ShieldCheck, Shirt, UserCheck, UtensilsCrossed } from 'lucide-react';
import { SitePage } from '@/components/site';
import { cx } from '@/components/ui';

type Scene = {
  id: string; label: string; icon: typeof Building2; business: string;
  chat: Array<{ from: 'customer' | 'ai'; text: string }>;
  record: { title: string; rows: Array<[string, string]>; next: string };
};

/** Illustrative conversations (not customer data): what each industry's assistant does with one message. */
const SCENES: Scene[] = [
  {
    id: 're', label: 'Real estate', icon: Building2, business: 'Marina Homes',
    chat: [
      { from: 'customer', text: 'Hi, Porur la 2BHK irukka? Budget 85 lakhs.' },
      { from: 'ai', text: 'வணக்கம்! Porur-ல 2BHK, ₹82–88 L range-ல 3 options இருக்கு. Saturday site visit-க்கு 11 மணி வசதியா?' },
      { from: 'customer', text: 'Saturday 11 ok.' },
      { from: 'ai', text: 'Booked. Visit confirm பண்ண Friday evening ஒரு reminder அனுப்புறேன்.' },
    ],
    record: { title: 'Lead qualified', rows: [['Location', 'Porur'], ['Requirement', '2BHK'], ['Budget', '₹85 lakh'], ['Site visit', 'Sat, 11:00']], next: 'Reminder scheduled for Friday 6 pm' },
  },
  {
    id: 'food', label: 'Restaurant', icon: UtensilsCrossed, business: 'Fresh chicken shop',
    chat: [
      { from: 'customer', text: '1.5 kg curry cut, 6 mani ku ready pannunga' },
      { from: 'ai', text: 'Curry cut 1.5 kg, ₹420. 6 மணிக்கு Anna Nagar shop-ல ready ஆகும். Confirm பண்ணவா?' },
      { from: 'customer', text: 'Yes' },
      { from: 'ai', text: 'Order GR-1042 confirmed. Ready ஆனதும் call பண்றோம்.' },
    ],
    record: { title: 'Order confirmed', rows: [['Item', 'Curry cut × 1.5 kg'], ['Total', '₹420 (server-priced)'], ['Pickup', 'Anna Nagar, 6:00 pm'], ['Status', 'Preparing']], next: 'Ready call when staff mark it ready' },
  },
  {
    id: 'tex', label: 'Textile', icon: Shirt, business: 'Kanchi Weaves',
    chat: [
      { from: 'customer', text: 'Need 200 m cotton poplin for school uniforms, quote please' },
      { from: 'ai', text: 'Cotton poplin is ₹182.50/m. For 200 m that is ₹36,500 before tax. Shall I send a formal quotation?' },
      { from: 'customer', text: 'Send it' },
      { from: 'ai', text: 'Quotation Q-0311 is ready for your review. Our sales team will confirm stock today.' },
    ],
    record: { title: 'Quotation drafted', rows: [['Product', 'Cotton poplin'], ['Quantity', '200 m'], ['Value', '₹36,500 + tax'], ['Approval', 'Waiting for sales']], next: 'A person approves before it is sent' },
  },
  {
    id: 'hos', label: 'Healthcare', icon: HeartPulse, business: 'City Care Hospital',
    chat: [
      { from: 'customer', text: 'Dr. Meena appointment venum, tomorrow morning' },
      { from: 'ai', text: 'நாளை Dr. Meena (General Medicine) 10:30 மற்றும் 11:15 free. எது வசதி?' },
      { from: 'customer', text: '10:30' },
      { from: 'ai', text: 'Appointment request sent to reception. Confirm ஆனதும் message வரும்.' },
    ],
    record: { title: 'Appointment requested', rows: [['Doctor', 'Dr. Meena'], ['Slot', 'Tomorrow, 10:30'], ['Reception', 'To confirm'], ['Notes', 'No medical advice given']], next: 'Reception confirms; patient gets the update' },
  },
  {
    id: 'cctv', label: 'Vision AI', icon: Cctv, business: 'VisionOps NOC',
    chat: [
      { from: 'customer', text: 'Site agent: CAM-3 not reachable for 4 minutes' },
      { from: 'ai', text: 'Incident INC-1002 opened. Technician Ravi notified on WhatsApp. Escalation in 15 min if not acknowledged.' },
      { from: 'customer', text: 'ACK INC-1002' },
      { from: 'ai', text: 'Acknowledged by Ravi. Restoration check runs when the camera reports back.' },
    ],
    record: { title: 'Incident acknowledged', rows: [['Device', 'CAM-3'], ['Detected by', 'On-site agent heartbeat'], ['Assigned', 'Ravi (technician)'], ['Resolves', 'Only on a passing check']], next: 'Closes when the device is verified online' },
  },
];

export default function Welcome() {
  const [i, setI] = useState(0);
  const s = SCENES[i];
  return (
    <SitePage>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[linear-gradient(180deg,#ebeaf6_0%,rgba(235,234,246,0)_100%)]" aria-hidden />
        <div className="relative mx-auto grid max-w-[1200px] gap-12 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:pt-20 lg:pb-24">
          <div className="self-center">
            <h1 className="text-[40px] leading-[0.98] font-extrabold tracking-[-0.045em] sm:text-[60px] lg:text-[68px]">
              Your customers write in Tanglish. Your AI employee answers, books and follows up.
            </h1>
            <p className="mt-6 max-w-xl text-[17.5px] leading-relaxed text-[#16183d]/70">
              Tacksharp runs WhatsApp conversations, phone calls and back-office follow-ups for your business, turns every chat into a record your team can act on, and asks a person before anything important goes out.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="rounded-[12px] bg-[#16183d] px-5 py-3.5 text-[15px] font-semibold text-white hover:bg-[#262a63]">Create your organization</Link>
              <Link href="/demo" className="rounded-[12px] border border-[#16183d]/15 bg-white px-5 py-3.5 text-[15px] font-semibold hover:border-[#16183d]/40">See the industry demos</Link>
            </div>
            <ul className="mt-8 grid max-w-lg gap-2 text-[14px] text-[#16183d]/75">
              <li className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#0f9f6e]" aria-hidden />Each organization sees only its own data, checked on the server for every request.</li>
              <li className="flex items-start gap-2"><Lock className="mt-0.5 size-4 shrink-0 text-[#0f9f6e]" aria-hidden />Your WhatsApp, Plivo, Sarvam and OpenAI keys are encrypted and never shown again.</li>
            </ul>
          </div>

          <div>
            <div role="tablist" aria-label="Choose an industry" className="flex flex-wrap gap-1.5">
              {SCENES.map((sc, k) => {
                const Icon = sc.icon;
                return (
                  <button key={sc.id} role="tab" aria-selected={k === i} aria-controls="scene" id={`tab-${sc.id}`} onClick={() => setI(k)}
                    className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-semibold transition-colors', k === i ? 'bg-[#16183d] text-white' : 'bg-white text-[#16183d]/75 ring-1 ring-[#16183d]/10 hover:ring-[#16183d]/30')}>
                    <Icon className="size-4" aria-hidden /> {sc.label}
                  </button>
                );
              })}
            </div>
            <div id="scene" role="tabpanel" aria-labelledby={`tab-${s.id}`} className="mt-4 grid gap-3 sm:grid-cols-[1.15fr_1fr]" key={s.id}>
              <div className="overflow-hidden rounded-[22px] bg-[#0b3b2e] shadow-[0_30px_60px_-30px_rgba(22,24,61,0.55)]">
                <div className="flex items-center gap-2 bg-[#0f5a45] px-4 py-3 text-white">
                  <span className="grid size-8 place-items-center rounded-full bg-white/15 text-[12px] font-bold">{s.business.charAt(0)}</span>
                  <div className="leading-tight"><p className="text-[13.5px] font-semibold">{s.business}</p><p className="text-[11px] text-white/70">AI assistant · WhatsApp</p></div>
                </div>
                <ol className="grid gap-2 bg-[#e9e3d8] p-3 sm:min-h-[330px]" aria-label="Example conversation">
                  {s.chat.map((m, k) => (
                    <li key={k} style={{ animationDelay: `${k * 260}ms` }}
                      className={cx('max-w-[86%] rounded-[12px] px-3 py-2 text-[13.5px] leading-snug shadow-sm motion-safe:animate-[fade-up_.35s_ease-out_both]', m.from === 'customer' ? 'justify-self-end rounded-tr-[4px] bg-[#d9fdd3] text-[#111b21]' : 'justify-self-start rounded-tl-[4px] bg-white text-[#111b21]')}>
                      {m.text}
                      {m.from === 'customer' && <CheckCheck className="ml-1 inline size-3.5 text-sky-500" aria-label="read" />}
                    </li>
                  ))}
                </ol>
              </div>
              <div className="flex flex-col rounded-[22px] border border-[#16183d]/10 bg-white p-5 motion-safe:animate-[fade-up_.4s_ease-out_.9s_both]">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-[#0f9f6e]"><UserCheck className="size-4" aria-hidden /> {s.record.title}</p>
                <dl className="mt-3 grid gap-2.5 text-[13.5px]">
                  {s.record.rows.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 border-b border-[#16183d]/8 pb-2"><dt className="text-[#16183d]/55">{k}</dt><dd className="text-right font-semibold">{v}</dd></div>
                  ))}
                </dl>
                <p className="mt-auto pt-4 text-[13px] text-[#16183d]/70"><span className="font-semibold text-[#16183d]">Next:</span> {s.record.next}</p>
              </div>
            </div>
            <p className="mt-3 text-[12px] text-[#16183d]/50">Illustrative conversation. In your account these come from your own customers.</p>
          </div>
        </div>
      </section>

      <section className="border-y border-[#16183d]/8 bg-white">
        <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
          <h2 className="max-w-2xl text-[30px] leading-tight font-extrabold tracking-[-0.03em] sm:text-[40px]">From a message to finished work, with a person in charge</h2>
          <ol className="mt-10 grid gap-8 md:grid-cols-4">
            {[
              ['A customer reaches you', 'On WhatsApp or by phone, in Tamil, English or both. Voice notes and calls are transcribed.'],
              ['The assistant answers', 'Prices, stock and slots come from your records, never invented. It asks only what it still needs.'],
              ['A record appears', 'A lead, order, quotation, appointment or incident, visible to your team the moment it exists.'],
              ['Follow-ups run', 'Reminders, calls and campaigns go out on schedule. Discounts, campaigns and invoices wait for approval.'],
            ].map(([t, d], k) => (
              <li key={t} className="relative pl-12">
                <span className="absolute top-0 left-0 grid size-9 place-items-center rounded-full bg-[#16183d] text-[14px] font-bold text-white" aria-hidden>{k + 1}</span>
                <h3 className="text-[16.5px] font-bold">{t}</h3>
                <p className="mt-1.5 text-[14.5px] leading-relaxed text-[#16183d]/70">{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 className="text-[30px] leading-tight font-extrabold tracking-[-0.03em] sm:text-[40px]">Built for the businesses that call you back</h2>
            <p className="mt-4 text-[16px] leading-relaxed text-[#16183d]/70">One platform, a dashboard shaped for each industry. Pick yours at signup; the menus, records and assistant change with it.</p>
            <Link href="/solutions" className="mt-6 inline-block rounded-[10px] border border-[#16183d]/15 px-4 py-2.5 text-[14px] font-semibold hover:border-[#16183d]/40">Compare industries</Link>
          </div>
          <ul className="grid gap-px overflow-hidden rounded-[18px] bg-[#16183d]/10 sm:grid-cols-2">
            {[
              [Building2, 'Real estate', 'Leads, properties, site visits and AI follow-up calls.'],
              [UtensilsCrossed, 'Restaurants', 'WhatsApp and phone ordering, menu, stock and ready calls.'],
              [Shirt, 'Retail and textile', 'Catalogue, quotations, orders, campaigns and stock alerts.'],
              [HeartPulse, 'Healthcare', 'Appointment requests and patient enquiries, with privacy controls.'],
              [Cctv, 'Vision AI', 'Camera and recorder health, incidents and technician escalation.'],
              [Factory, 'Manufacturing', 'Quality inspections, stock, work tasks and exceptions.'],
            ].map(([Icon, t, d]) => {
              const I = Icon as typeof Building2;
              return (
                <li key={t as string} className="bg-white p-5">
                  <I className="size-5 text-[#0f9f6e]" aria-hidden />
                  <h3 className="mt-3 text-[15.5px] font-bold">{t as string}</h3>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-[#16183d]/65">{d as string}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="bg-[#16183d] text-white">
        <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2">
          <div>
            <h2 className="text-[30px] leading-tight font-extrabold tracking-[-0.03em] sm:text-[40px]">Nothing goes out by accident</h2>
            <p className="mt-4 max-w-lg text-[16px] leading-relaxed text-white/70">New organizations start in a safe setup mode. Messages and calls are recorded but not sent until your numbers, templates and test recipients are in place, and every provider connection is tested before it is used.</p>
          </div>
          <ul className="grid gap-4 text-[14.5px]">
            {[
              ['Roles that hold on the server', 'Admin, manager, operator and read-only access are enforced by the API, not by hidden buttons.'],
              ['Your accounts, your bills', 'Bring your own WhatsApp, Plivo, Sarvam and OpenAI accounts. Keys are encrypted at rest and masked on screen.'],
              ['Delivery you can trust', 'A message counts as delivered only when WhatsApp says so, never because a request was accepted.'],
              ['A full audit trail', 'Sign-ins, role changes, approvals and integration changes are recorded with who and when.'],
            ].map(([t, d]) => (
              <li key={t} className="border-l-2 border-[#f2a516] pl-4"><b className="font-semibold text-white">{t}</b><p className="mt-1 text-white/65">{d}</p></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 py-16 text-left sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-6 rounded-[24px] bg-[#ebeaf6] p-8 sm:p-12">
          <div className="max-w-xl">
            <h2 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em] sm:text-[36px]">Set up your organization today</h2>
            <p className="mt-3 text-[15.5px] text-[#16183d]/70">Create the account, choose your industry and invite your team. Tacksharp reviews each new organization and activates it before anything is sent to customers.</p>
          </div>
          <Link href="/signup" className="rounded-[12px] bg-[#16183d] px-5 py-3.5 text-[15px] font-semibold text-white hover:bg-[#262a63]">Create your organization</Link>
        </div>
      </section>
    </SitePage>
  );
}
