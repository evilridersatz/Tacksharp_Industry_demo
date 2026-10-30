'use client';

import { PageHeader } from '@/components/shell';
import { ChannelSummary, ProviderList } from '@/components/integrations';

/** One place for every connection: what customers can use, then each provider with its real status and next step. */
export default function Page() {
  return (
    <>
      <PageHeader title="Integrations" crumb="Connections" />
      <div className="grid gap-6">
        <ChannelSummary />
        <section aria-labelledby="ch-h" className="grid gap-3">
          <h2 id="ch-h" className="text-[15px] font-semibold text-ink">WhatsApp and voice calling</h2>
          <ProviderList group="Integrations" />
        </section>
        <section aria-labelledby="ai-h" className="grid gap-3">
          <h2 id="ai-h" className="text-[15px] font-semibold text-ink">AI providers</h2>
          <p className="-mt-2 text-[12.5px] text-muted">The language model and the speech recognition and voices your assistant uses.</p>
          <ProviderList group="AI providers" />
        </section>
        <p className="text-[12.5px] text-muted">CRM and other external systems: not available as an integration yet. Customers can be added from a CSV file under Customers.</p>
      </div>
    </>
  );
}
