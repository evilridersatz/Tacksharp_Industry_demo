'use client';

import Link from 'next/link';
import { ArrowRight, CreditCard, MessageCircle, PhoneCall, Store, Users } from 'lucide-react';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/industry';
import { cx } from './ui';

type Home = { channels: Array<{ id: 'whatsapp' | 'voice'; label: string; status: 'connected' | 'not_connected' | 'needs_attention' | 'incomplete'; detail: string; href: string }>; mode: { dryRun: boolean } };
type Team = { members: unknown[] };

const STATUS = {
  connected: { text: 'Connected', cls: 'bg-emerald-50 text-emerald-700' },
  needs_attention: { text: 'Needs attention', cls: 'bg-rose-50 text-rose-700' },
  incomplete: { text: 'Half set up', cls: 'bg-amber-50 text-amber-800' },
  not_connected: { text: 'Not connected', cls: 'bg-slate-100 text-slate-600' },
} as const;

/**
 * Settings at a glance: what is connected, who has access, where shop details live. Each card opens the page where
 * that is changed, so an owner never has to guess which settings page holds what.
 */
export function SettingsHub() {
  const { workspace } = useWorkspace();
  const home = useApi<Home>('/home?range=today', 60_000);
  const team = useApi<Team>(workspace?.role === 'admin' ? '/team' : null, 0);
  const ch = (id: 'whatsapp' | 'voice') => home.data?.channels.find((c) => c.id === id);
  const restaurant = workspace?.industry === 'restaurant' || workspace?.industry === 'food';
  const cards = [
    { title: 'WhatsApp', icon: MessageCircle, color: '#16a34a', bg: '#f0fdf4', href: ch('whatsapp')?.href ?? '/settings/integrations', status: ch('whatsapp')?.status, detail: ch('whatsapp')?.detail ?? 'Customers chat and order on WhatsApp.' },
    { title: 'Phone calls', icon: PhoneCall, color: '#7c3aed', bg: '#f5f3ff', href: ch('voice')?.href ?? '/settings/integrations', status: ch('voice')?.status, detail: ch('voice')?.detail ?? 'The AI answers and makes calls.' },
    { title: 'Team', icon: Users, color: '#0284c7', bg: '#f0f9ff', href: '/team', status: undefined, detail: team.data ? `${team.data.members.length} ${team.data.members.length === 1 ? 'person has' : 'people have'} access. Invite staff or change roles.` : 'Invite staff and choose what each person can do.' },
    restaurant
      ? { title: 'Shop, hours & prices', icon: Store, color: '#ea580c', bg: '#fff7ed', href: '/menu', status: undefined, detail: 'Shop address, opening hours, products and today’s prices live on Menu & stock.' }
      : { title: 'Plan & billing', icon: CreditCard, color: '#475569', bg: '#f8fafc', href: '/settings/billing', status: undefined, detail: 'Your plan, limits and invoices.' },
  ];
  return (
    <>
      {home.data && (
        <p className={cx('mb-4 flex flex-wrap items-center gap-2 rounded-[14px] border px-4 py-3 text-[13px]', home.data.mode.dryRun ? 'border-slate-200 bg-white text-body' : 'border-emerald-200 bg-emerald-50 text-emerald-900')}>
          <span className={cx('size-2.5 rounded-full', home.data.mode.dryRun ? 'bg-slate-400' : 'bg-emerald-500')} aria-hidden />
          <b>{home.data.mode.dryRun ? 'Test mode' : 'Live'}</b>
          <span>{home.data.mode.dryRun ? 'Messages and calls are checked and recorded, but nothing is sent to customers. Tacksharp switches this on when you go live.' : 'Messages and calls go to your customers.'}</span>
        </p>
      )}
      <ul className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Settings at a glance">
        {cards.map((c) => (
          <li key={c.title}>
            <Link href={c.href} className="group flex h-full flex-col rounded-[16px] border border-line bg-white p-4 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:border-slate-300">
              <span className="flex items-center gap-2.5">
                <span className="grid size-9 place-items-center rounded-[12px]" style={{ background: c.bg, color: c.color }}><c.icon className="size-[18px]" aria-hidden /></span>
                <span className="flex-1 text-[14px] font-semibold text-ink">{c.title}</span>
                {c.status && <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', STATUS[c.status].cls)}>{STATUS[c.status].text}</span>}
              </span>
              <span className="mt-2 flex-1 text-[12.5px] text-body">{c.detail}</span>
              <span className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink">Open<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden /></span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
