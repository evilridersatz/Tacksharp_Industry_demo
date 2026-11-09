'use client';

import Link from 'next/link';
import { AtSign, Boxes, ExternalLink, Mail } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Button, ErrorBanner, Skeleton } from '@/components/ui';
import { Stat } from '@/components/vertical-ui';
import { SectionCard, inr, when } from '@/components/jarvis';

type Checks = {
  mail: { ok: boolean; account: string; unread: number; total: number; recent: Array<{ from: string; subject: string; at: string | null; unread: boolean }>; message: string };
  instagram: { account: { ok: boolean; username?: string; followers?: number; posts?: number; recent: Array<{ caption: string; likes: number; comments: number; at: string; link?: string }>; message: string }; waiting: Array<{ minutes: number; channel: string }> };
  erp: { ordersByStatus: Record<string, number>; stock: { tracked: number; reorder: Array<{ name: string; qty: number; unit: string; level: 'low' | 'out' }>; valueAtPrice: number }; receivables: { overdueInvoices: { count: number; amount: number }; unpaidOrdersToday: { count: number; amount: number } }; pendingOrders: Array<{ orderNumber: string; minutes: number; total: number }>; complaintsOpen: number };
};

export default function JarvisChecksPage() {
  const { data, error, reload, loading } = useApi<Checks>('/jarvis/checks', 5 * 60_000);
  const link = (href: string, label: string) => <Link href={href} className="text-[12.5px] font-semibold" style={{ color: 'var(--industry-accent)' }}>{label}</Link>;
  return (
    <>
      <PageHeader title="Mail, Instagram & ERP" crumb="Jarvis" actions={<Button onClick={reload} busy={loading}>Check again</Button>} />
      {error && !data && <ErrorBanner message={error} onRetry={reload} />}
      {!data ? <Skeleton className="h-96" /> : (
        <>
          <SectionCard title="Office mail" subtitle={data.mail.ok ? `${data.mail.account} · read-only (senders and subjects only)` : undefined} action={link('/settings/integrations/office-mail', data.mail.ok ? 'Settings' : 'Connect Gmail')}>
            {data.mail.ok ? (
              <>
                <div className="flex gap-6 px-4 pb-3 text-[13px] text-body"><span className="flex items-center gap-1.5"><Mail className="size-4" aria-hidden /><b className="text-ink">{data.mail.unread}</b> unread</span><span>{data.mail.total} in the inbox</span></div>
                {data.mail.recent.length ? (
                  <ul className="divide-y divide-line border-t border-line">{data.mail.recent.map((m, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-[13px]"><span className={m.unread ? 'font-semibold text-ink' : 'text-body'}>{m.from}</span><span className="min-w-[200px] flex-1 truncate text-body">{m.subject}</span>{m.at && <span className="text-[11.5px] text-muted">{when(m.at)}</span>}</li>
                  ))}</ul>
                ) : <p className="px-4 pb-4 text-[12.5px] text-muted">No mail in the last 7 days.</p>}
              </>
            ) : <p className="px-4 pb-4 text-[13px] text-body">{data.mail.message}</p>}
          </SectionCard>

          <SectionCard title="Instagram" subtitle={data.instagram.account.username ? `@${data.instagram.account.username}` : undefined} action={link('/settings/integrations/meta-social', 'Settings')}>
            <div className="mb-3 grid grid-cols-2 gap-3 px-4 md:grid-cols-4">
              <Stat label="Waiting for a reply" value={data.instagram.waiting.length} tone={data.instagram.waiting.length ? 'amber' : 'green'} hint={data.instagram.waiting.length ? `Longest ${Math.max(...data.instagram.waiting.map((w) => w.minutes))} min` : 'DMs and comments'} />
              {data.instagram.account.ok && <><Stat label="Followers" value={(data.instagram.account.followers ?? 0).toLocaleString('en-IN')} /><Stat label="Posts" value={data.instagram.account.posts ?? 0} /></>}
            </div>
            {data.instagram.waiting.length > 0 && <p className="px-4 pb-3 text-[12.5px]">{link('/inbox', 'Open the team inbox')}</p>}
            {data.instagram.account.ok ? (
              <ul className="divide-y divide-line border-t border-line">{data.instagram.account.recent.map((p, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 px-4 py-2 text-[13px]"><AtSign className="size-3.5 text-muted" aria-hidden /><span className="min-w-[200px] flex-1 truncate text-body">{p.caption || '(no caption)'}</span><span className="tabular text-muted">{p.likes} likes · {p.comments} comments</span>{p.link && <a href={p.link} target="_blank" rel="noreferrer" className="text-muted hover:text-ink" aria-label="Open the post"><ExternalLink className="size-3.5" /></a>}</li>
              ))}</ul>
            ) : <p className="px-4 pb-4 text-[12.5px] text-muted">{data.instagram.account.message}</p>}
          </SectionCard>

          <SectionCard title="ERP (this platform’s own data)" subtitle="Stock, money to collect and orders to act on." action={link('/menu', 'Menu & stock')}>
            <div className="mb-3 grid grid-cols-2 gap-3 px-4 md:grid-cols-4">
              <Stat label="To reorder" value={data.erp.stock.reorder.length} tone={data.erp.stock.reorder.some((r) => r.level === 'out') ? 'red' : data.erp.stock.reorder.length ? 'amber' : 'green'} hint={`${data.erp.stock.tracked} products tracked`} />
              <Stat label="Stock value" value={inr(data.erp.stock.valueAtPrice)} hint="At selling price" />
              <Stat label="Overdue invoices" value={data.erp.receivables.overdueInvoices.count} hint={inr(data.erp.receivables.overdueInvoices.amount)} />
              <Stat label="Unpaid today" value={data.erp.receivables.unpaidOrdersToday.count} hint={inr(data.erp.receivables.unpaidOrdersToday.amount)} />
            </div>
            <div className="flex flex-wrap gap-1.5 px-4 pb-3">{Object.entries(data.erp.ordersByStatus).map(([s, c]) => <Badge key={s}>{s.replace(/_/g, ' ')} · {c}</Badge>)}{!Object.keys(data.erp.ordersByStatus).length && <span className="text-[12.5px] text-muted">No orders today.</span>}</div>
            {data.erp.stock.reorder.length > 0 && (
              <ul className="divide-y divide-line border-t border-line">{data.erp.stock.reorder.map((r) => (
                <li key={r.name} className="flex items-center gap-3 px-4 py-2 text-[13px]"><Boxes className="size-3.5 text-muted" aria-hidden /><span className="flex-1 text-ink">{r.name}</span><Badge tone={r.level === 'out' ? 'rose' : 'amber'}>{r.level === 'out' ? 'Out' : `${r.qty} ${r.unit} left`}</Badge></li>
              ))}</ul>
            )}
            {(data.erp.pendingOrders.length > 0 || data.erp.complaintsOpen > 0) && <p className="border-t border-line px-4 py-3 text-[12.5px] text-body">{data.erp.pendingOrders.length} order(s) still pending · {data.erp.complaintsOpen} open complaint(s) · {link('/orders', 'Orders')}</p>}
          </SectionCard>
        </>
      )}
    </>
  );
}
