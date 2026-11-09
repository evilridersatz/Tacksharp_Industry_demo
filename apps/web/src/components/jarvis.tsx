'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCheck, Info, Siren, Square, Volume2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardHeader, Empty, cx } from '@/components/ui';
import { toast } from '@/components/toast';

export type Period = { orders: number; revenue: number; cancelled: number; byChannel: Record<string, number>; calls: number; callMinutes: number; failedCalls: number; newCustomers: number };
export type Snapshot = {
  at: string; today: Period; yesterday: Period; last7: Period; sameTimeLastWeek: number;
  topItems: Array<{ name: string; qty: number; unit: string; revenue: number }>;
  topCustomers: Array<{ name: string; phone: string; orders: number; spend: number }>;
  stock: { tracked: number; low: Array<{ name: string; qty: number; unit: string; level: 'low' | 'out' }> };
  pendingOrders: Array<{ orderNumber: string; minutes: number; total: number }>;
  unpaidToday: { count: number; amount: number };
  handoffs: Array<{ minutes: number; channel: string; reason: string | null }>;
  instagramWaiting: Array<{ minutes: number; channel: string }>;
  failedCallsLastHour: number;
  overdue: { count: number; amount: number };
  feedback: { rated: number; average: number | null; complaintsOpen: number };
};
export type MonitorId = 'low_stock' | 'handoff_waiting' | 'pending_orders' | 'missed_calls' | 'sales_drop' | 'instagram_waiting' | 'mail_unread' | 'usage_budget';
export type JarvisSettings = {
  digest: { on: boolean; hour: number; minute: number };
  monitors: Record<MonitorId, { on: boolean; threshold: number }>;
  monitorEveryMin: number;
  rates: { sarvamAgentPerMin: number; simliPerMin: number; openaiPer1kTokens: number; whatsappPerMsg: number };
  dailyBudget: number;
};
export type JarvisAlert = { id: string; monitor: MonitorId; severity: 'info' | 'warning' | 'critical'; title: string; detail: string; href: string; at: string; resolved?: boolean };
export type Overview = {
  snapshot: Snapshot;
  digest: { headline: string; lines: string[] };
  lastDigest: { at: string; date: string; headline: string; lines: string[]; source: string } | null;
  alerts: JarvisAlert[];
  settings: JarvisSettings;
  monitorInfo: Record<MonitorId, { label: string; unit: string; help: string }>;
};

export const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
export const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Reads lines aloud with the phone agent's voice (one request per sentence; stop any time). */
export function SpeakButton({ lines }: { lines: string[] }) {
  const [playing, setPlaying] = useState(false);
  const stop = useRef<() => void>(() => undefined);
  useEffect(() => () => stop.current(), []);
  const play = async () => {
    let cancelled = false;
    let audio: HTMLAudioElement | null = null;
    stop.current = () => { cancelled = true; audio?.pause(); setPlaying(false); };
    setPlaying(true);
    try {
      for (const line of lines) {
        if (cancelled) break;
        const r = await api.post<{ audioBase64: string }>('/business-assistant/tts', { text: line.slice(0, 450) });
        if (cancelled) break;
        audio = new Audio(`data:audio/wav;base64,${r.audioBase64}`);
        await new Promise<void>((res) => { audio!.onended = () => res(); audio!.onerror = () => res(); void audio!.play().catch(() => res()); });
      }
    } catch (e) {
      toast(`Could not read it aloud: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      if (!cancelled) setPlaying(false);
    }
  };
  return playing
    ? <Button onClick={() => stop.current()}><Square className="size-4" aria-hidden /> Stop</Button>
    : <Button onClick={() => void play()} disabled={!lines.length}><Volume2 className="size-4" aria-hidden /> Listen</Button>;
}

const SEV = { critical: { tone: 'rose', icon: Siren, label: 'Critical' }, warning: { tone: 'amber', icon: AlertTriangle, label: 'Warning' }, info: { tone: 'sky', icon: Info, label: 'Info' } } as const;

export function AlertList({ alerts, onResolved, empty = 'No open alerts. Jarvis checks again on its own.' }: { alerts: JarvisAlert[]; onResolved?: () => void; empty?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!alerts.length) return <Empty icon={<CheckCheck className="size-5" />} title="All clear">{empty}</Empty>;
  const resolve = async (id: string) => {
    setBusy(id);
    try { await api.post(`/jarvis/alerts/${encodeURIComponent(id)}/resolve`); onResolved?.(); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } finally { setBusy(null); }
  };
  return (
    <ul className="flex flex-col divide-y divide-line">
      {alerts.map((a) => {
        const s = SEV[a.severity];
        const Icon = s.icon;
        return (
          <li key={a.id} className={cx('flex flex-wrap items-start gap-3 px-4 py-3', a.resolved && 'opacity-60')}>
            <Icon className={cx('mt-0.5 size-4 shrink-0', a.severity === 'critical' ? 'text-rose-600' : a.severity === 'warning' ? 'text-amber-600' : 'text-sky-600')} aria-hidden />
            <div className="min-w-[200px] flex-1">
              <p className="text-[13.5px] font-semibold text-ink">{a.title}</p>
              <p className="mt-0.5 text-[12.5px] text-body">{a.detail}</p>
              <p className="mt-1 text-[11.5px] text-muted">{when(a.at)} · <Badge tone={s.tone}>{s.label}</Badge>{a.resolved && <> · done</>}</p>
            </div>
            <div className="flex items-center gap-2">
              <Link href={a.href} className="text-[12.5px] font-semibold" style={{ color: 'var(--industry-accent)' }}>Open</Link>
              {!a.resolved && onResolved && <Button className="h-8" busy={busy === a.id} onClick={() => void resolve(a.id)}>Mark done</Button>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function SectionCard({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader title={title} subtitle={subtitle} action={action} />
      {children}
    </Card>
  );
}

/** A labelled input for the Jarvis settings forms. */
export function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-muted">{label}</span>
      {children}
    </label>
  );
}
