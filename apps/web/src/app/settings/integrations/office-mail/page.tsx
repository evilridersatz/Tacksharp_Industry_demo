'use client';

import { PageHeader } from '@/components/shell';
import { ProviderSettings } from '@/components/integrations';
import { Card } from '@/components/ui';

export default function Page() {
  return (
    <>
      <PageHeader title="Office mail (Gmail)" crumb="Settings / Integrations" />
      <Card className="mb-4 p-4 text-[12.5px] text-body">
        <p className="font-semibold text-ink">How to connect Gmail or Google Workspace</p>
        <ol className="mt-1 list-decimal pl-5">
          <li>In Gmail: Settings → See all settings → Forwarding and POP/IMAP → turn IMAP on.</li>
          <li>In your Google account: Security → 2-Step Verification (must be on) → App passwords → create one named “Tacksharp Jarvis”.</li>
          <li>Enter the mail address and that 16-letter app password below, save, then press Test.</li>
        </ol>
        <p className="mt-2 text-muted">Jarvis only reads senders, subjects and the unread count. It never opens, marks, sends or deletes mail. Remove the app password in Google at any time to stop it.</p>
      </Card>
      <ProviderSettings provider="office_mail" />
    </>
  );
}
