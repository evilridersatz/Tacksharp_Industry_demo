'use client';

import Link from 'next/link';
import { CheckCircle2, CircleSlash, XCircle } from 'lucide-react';
import { useApi } from '@/lib/api';
import { PageHeader } from '@/components/shell';
import { Badge, Card, CardHeader, ErrorBanner, Field, Skeleton } from '@/components/ui';
import type { Outlet } from '@/lib/restaurant';

type Check = { ok: boolean; ms: number; error?: string };
type Integrations = {
  tenant: { id: string; name: string; vertical: string; createdAt: string } | null;
  outlets: Outlet[];
  health: { database: Check; redis: Check };
  llm: { provider: string; model: string | null; host?: string; configured: boolean; reachable: boolean | null; error?: string; note?: string };
  channels: {
    whatsapp: {
      connected: boolean;
      accessTokenSet: boolean;
      phoneNumberIdSet: boolean;
      verifyTokenSet: boolean;
      appSecretSet: boolean;
      mappedToThisTenant: boolean;
      displayNumberSet: boolean;
      offerTemplateSet: boolean;
      orderReadyTemplateSet: boolean;
      webhookUrl: string;
    };
    voice: { connected: boolean; missing: string[]; callingHours: string; answerUrl: string; note: string };
    website: { keyConfigured: boolean; endpoint: string };
  };
  pos: { status: string; note: string };
  payments: { status: string; note: string };
};

function Status({ ok, label, neutral }: { ok: boolean | null; label: string; neutral?: boolean }) {
  if (ok === null || neutral)
    return (
      <Badge tone="slate">
        <CircleSlash className="size-3.5" /> {label}
      </Badge>
    );
  return ok ? (
    <Badge tone="brand">
      <CheckCircle2 className="size-3.5" /> {label}
    </Badge>
  ) : (
    <Badge tone="rose">
      <XCircle className="size-3.5" /> {label}
    </Badge>
  );
}

const yes = (b: boolean) => (b ? 'Set' : 'Missing');

export default function IntegrationsPage() {
  const { data: d, error, reload } = useApi<Integrations>('/restaurant/integrations', 30_000);
  return (
    <>
      <PageHeader title="Settings & integrations" crumb="Settings" />
      {error && !d && <ErrorBanner message={error} onRetry={reload} />}
      {!d ? (
        <Skeleton className="h-[520px] rounded-[14px]" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="WhatsApp" subtitle="The offer chat and the order conversation" action={<Status ok={d.channels.whatsapp.connected} label={d.channels.whatsapp.connected ? 'Connected' : 'Not connected'} />} />
            <div className="px-5 pb-4 text-[13px]">
              <Field label="Access token">{yes(d.channels.whatsapp.accessTokenSet)}</Field>
              <Field label="Phone number ID">{yes(d.channels.whatsapp.phoneNumberIdSet)}</Field>
              <Field label="Webhook verify token">{yes(d.channels.whatsapp.verifyTokenSet)}</Field>
              <Field label="App secret (signature check)">{yes(d.channels.whatsapp.appSecretSet)}</Field>
              <Field label="Number mapped to GR Chicken">{d.channels.whatsapp.mappedToThisTenant ? 'Yes' : 'No'}</Field>
              <Field label="Number for the claim link">{d.channels.whatsapp.displayNumberSet ? 'Set' : 'Missing'}</Field>
              <Field label="Offer template (outside 24h)">{d.channels.whatsapp.offerTemplateSet ? 'Set' : <Link href="/offers" className="text-brand">Missing — set on Offer</Link>}</Field>
              <Field label="Order-ready template (outside 24h)">{d.channels.whatsapp.orderReadyTemplateSet ? 'Set' : 'Missing'}</Field>
              {!d.channels.whatsapp.orderReadyTemplateSet && <p className="text-right font-mono text-[11px] break-all text-faint">WHATSAPP_TEMPLATE_ORDER_READY</p>}
              <p className="mt-2 text-[12px] text-muted">Webhook URL for Meta:</p>
              <p className="break-all font-mono text-[12px] text-ink">{d.channels.whatsapp.webhookUrl}</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Order-ready calls" subtitle="Tamil voice call when staff mark an order Ready" action={<Status ok={d.channels.voice.connected} label={d.channels.voice.connected ? 'On' : 'Off'} />} />
            <div className="px-5 pb-4 text-[13px]">
              <p className="text-body">{d.channels.voice.note}</p>
              {d.channels.voice.missing.length > 0 && (
                <p className="mt-2 text-[12.5px] text-[#b45309]">
                  Missing: <span className="font-mono">{d.channels.voice.missing.join(', ')}</span>
                </p>
              )}
              <Field label="Calling hours">{d.channels.voice.callingHours}</Field>
              <p className="mt-2 text-[12px] text-muted">Plivo answer URL (set automatically per call):</p>
              <p className="break-all font-mono text-[12px] text-ink">{d.channels.voice.answerUrl}</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Website → offer" action={<Status ok={d.channels.website.keyConfigured} label={d.channels.website.keyConfigured ? 'Key set' : 'No key'} />} />
            <div className="px-5 pb-4 text-[13px]">
              <p className="text-body">The GR Chicken website posts each order's customer to:</p>
              <p className="mt-1 break-all font-mono text-[12px] text-ink">{d.channels.website.endpoint}</p>
              <Link href="/offers" className="mt-2 inline-block text-[12.5px] font-semibold text-brand">
                Keys and example →
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader title="System" />
            <div className="flex flex-wrap gap-2 px-5 pb-3">
              <Status ok={d.health.database.ok} label={`Database ${d.health.database.ok ? `${d.health.database.ms} ms` : d.health.database.error ?? 'down'}`} />
              <Status ok={d.health.redis.ok} label={`Redis ${d.health.redis.ok ? `${d.health.redis.ms} ms` : d.health.redis.error ?? 'down'}`} />
            </div>
            <div className="px-5 pb-4 text-[13px]">
              <Field label="AI model">{d.llm.provider}{d.llm.model ? ` · ${d.llm.model}` : ''}</Field>
              {d.llm.host && <Field label="Server">{d.llm.host}</Field>}
              <Field label="Model status">
                <Status ok={d.llm.configured ? d.llm.reachable : false} neutral={d.llm.reachable === null} label={!d.llm.configured ? 'Not configured' : d.llm.reachable === null ? 'Key present' : d.llm.reachable ? 'Reachable' : `Unreachable${d.llm.error ? ` (${d.llm.error})` : ''}`} />
              </Field>
              <p className="mt-1 text-[12px] text-muted">The model only phrases answers to unusual questions. Products, kg, cuts, prices, the offer and orders never depend on it.</p>
              <Field label="Business">{d.tenant?.name}</Field>
              <Field label="Shops">{d.outlets.map((o) => `${o.name} (${o.opensAt}–${o.closesAt})`).join(', ')}</Field>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title="Business systems" />
            <ul className="grid grid-cols-1 gap-3 px-5 pb-5 md:grid-cols-2">
              {[
                ['POS', d.pos.status, d.pos.note],
                ['Payments', d.payments.status, d.payments.note],
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
