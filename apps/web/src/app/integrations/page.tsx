'use client';

import { CheckCircle2, CircleSlash, ExternalLink, XCircle } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, CardHeader, ErrorBanner, Field, Skeleton } from '@/components/ui';
import { inr, type Outlet } from '@/lib/restaurant';

type Check = { ok: boolean; ms: number; error?: string };
type Integrations = {
  tenant: { id: string; name: string; vertical: string; createdAt: string } | null;
  outlets: Outlet[];
  health: { database: Check; redis: Check };
  llm: { provider: string; model: string | null; host?: string; configured: boolean; reachable: boolean | null; error?: string; note?: string };
  channels: {
    web: { connected: boolean; chatKey: string | null; note: string };
    whatsapp: { connected: boolean; accessTokenSet: boolean; phoneNumberIdSet: boolean; verifyTokenSet: boolean; appSecretSet: boolean; mappedToThisTenant: boolean; webhookUrl: string };
    voice: { connected: boolean; note: string };
  };
  pos: { status: string; note: string };
  payments: { status: string; note: string };
  delivery: { status: string; note: string };
};

function Status({ ok, label, neutral }: { ok: boolean | null; label: string; neutral?: boolean }) {
  if (ok === null || neutral) return <Badge tone="slate"><CircleSlash className="size-3.5" /> {label}</Badge>;
  return ok ? <Badge tone="brand"><CheckCircle2 className="size-3.5" /> {label}</Badge> : <Badge tone="rose"><XCircle className="size-3.5" /> {label}</Badge>;
}

const yes = (b: boolean) => (b ? 'Set' : 'Missing');

export default function IntegrationsPage() {
  const { data: d, error, reload } = useApi<Integrations>('/restaurant/integrations', 30_000);
  const chatUrl = d?.channels.web.chatKey && typeof window !== 'undefined' ? `${window.location.origin}/chat/${d.channels.web.chatKey}` : null;

  return (
    <>
      <PageHeader title="Settings & integrations" crumb="Settings" />
      {error && !d && <ErrorBanner message={error} onRetry={reload} />}
      {!d ? (
        <Skeleton className="h-[520px] rounded-[14px]" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Business" subtitle="Tenant settings" />
            <div className="px-5 pb-4 text-[13px]">
              <Field label="Name">{d.tenant?.name}</Field>
              <Field label="Product">{d.tenant?.vertical === 'restaurant' ? 'Restaurant ordering' : d.tenant?.vertical}</Field>
              <Field label="Outlets">{d.outlets.length}</Field>
              <Field label="Data">{d.outlets.some((o) => o.isDemo) ? <Badge tone="amber">Demo outlets & menu</Badge> : 'Verified'}</Field>
            </div>
            <ul className="border-t border-line px-5 py-3 text-[12.5px]">
              {d.outlets.map((o) => (
                <li key={o.id} className="py-1.5">
                  <b className="text-ink">{o.name}</b> <span className="text-muted">· {o.opensAt}–{o.closesAt} · {o.acceptsDelivery ? `delivery ${inr(o.deliveryFee)}` : 'pickup only'}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="System health" />
            <div className="flex flex-wrap gap-2 px-5 pb-4">
              <Status ok={d.health.database.ok} label={`Database ${d.health.database.ok ? `${d.health.database.ms} ms` : d.health.database.error ?? 'down'}`} />
              <Status ok={d.health.redis.ok} label={`Redis ${d.health.redis.ok ? `${d.health.redis.ms} ms` : d.health.redis.error ?? 'down'}`} />
            </div>
            <CardHeader title="AI model" subtitle="Used only to phrase answers to free-form questions. Prices, carts and orders never depend on it." />
            <div className="px-5 pb-4 text-[13px]">
              <Field label="Provider">{d.llm.provider}</Field>
              <Field label="Model">{d.llm.model ?? '—'}</Field>
              {d.llm.host && <Field label="Server">{d.llm.host}</Field>}
              <Field label="Status">
                <Status ok={d.llm.configured ? d.llm.reachable : false} neutral={d.llm.reachable === null} label={!d.llm.configured ? 'Not configured' : d.llm.reachable === null ? 'Key present' : d.llm.reachable ? 'Reachable' : `Unreachable${d.llm.error ? ` (${d.llm.error})` : ''}`} />
              </Field>
              {d.llm.note && <p className="mt-1 text-[12px] text-muted">{d.llm.note}</p>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Website chat" action={<Status ok={d.channels.web.connected} label={d.channels.web.connected ? 'Live' : 'Not set up'} />} />
            <div className="px-5 pb-4 text-[13px]">
              <p className="text-muted">{d.channels.web.note}</p>
              {chatUrl && (
                <>
                  <p className="mt-2 break-all rounded-[8px] bg-slate-50 px-3 py-2 font-mono text-[12px] text-ink">{chatUrl}</p>
                  <Button href={chatUrl} className="mt-2">
                    <ExternalLink className="size-4" /> Open customer chat
                  </Button>
                </>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="WhatsApp" action={<Status ok={d.channels.whatsapp.connected} label={d.channels.whatsapp.connected ? 'Connected' : 'Not connected'} />} />
            <div className="px-5 pb-4 text-[13px]">
              <Field label="Access token">{yes(d.channels.whatsapp.accessTokenSet)}</Field>
              <Field label="Phone number ID">{yes(d.channels.whatsapp.phoneNumberIdSet)}</Field>
              <Field label="Webhook verify token">{yes(d.channels.whatsapp.verifyTokenSet)}</Field>
              <Field label="App secret (signature check)">{yes(d.channels.whatsapp.appSecretSet)}</Field>
              <Field label="Number mapped to this business">{d.channels.whatsapp.mappedToThisTenant ? 'Yes' : 'No'}</Field>
              <p className="mt-2 text-[12px] text-muted">Webhook URL for Meta:</p>
              <p className="break-all font-mono text-[12px] text-ink">{d.channels.whatsapp.webhookUrl}</p>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title="Business systems" />
            <ul className="grid grid-cols-1 gap-3 px-5 pb-5 md:grid-cols-4">
              {[
                ['Voice', d.channels.voice.connected ? 'connected' : 'not_integrated', d.channels.voice.note],
                ['POS', d.pos.status, d.pos.note],
                ['Payments', d.payments.status, d.payments.note],
                ['Delivery partner', d.delivery.status, d.delivery.note],
              ].map(([name, status, note]) => (
                <li key={name} className="rounded-[12px] border border-line p-4 text-[13px]">
                  <p className="flex items-center justify-between font-semibold text-ink">
                    {name} <Status ok={null} label={status === 'not_integrated' ? 'Not integrated' : status} />
                  </p>
                  <p className="mt-1.5 text-[12.5px] text-muted">{note}</p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
