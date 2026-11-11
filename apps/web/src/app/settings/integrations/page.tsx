'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/shell';
import { ChannelSummary, ProviderList } from '@/components/integrations';

/** One place for every connection: what customers can use, then each provider with its real status and next step. */
export default function Page() {
  return (
    <>
      <PageHeader title="Connections" crumb="Settings" />
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
        <section aria-labelledby="mcp-h" className="grid gap-3">
          <h2 id="mcp-h" className="text-[15px] font-semibold text-ink">AI assistants (MCP)</h2>
          <Link href="/settings/integrations/mcp" data-testid="integration-mcp" className="group flex flex-col rounded-[var(--radius-card)] border border-line bg-white p-5 shadow-[var(--shadow-card)] hover:shadow-md md:max-w-[50%]">
            <h3 className="text-[15px] font-semibold text-ink">MCP server</h3>
            <p className="mt-0.5 text-[12.5px] text-muted">Let your own AI assistant (any MCP client) read customers, conversations, orders and analytics, and add notes, stages and tasks, with an access key you control.</p>
            <span className="mt-3 text-[13px] font-semibold text-brand group-hover:underline">Manage access keys →</span>
          </Link>
        </section>
        <p className="text-[12.5px] text-muted">CRM and other external systems: not available as an integration yet. Customers can be added from a CSV file under Customers.</p>
      </div>
    </>
  );
}
