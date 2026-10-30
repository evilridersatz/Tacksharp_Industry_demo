'use client';

import { PageHeader } from '@/components/shell';
import { ProviderSettings } from '@/components/integrations';

export default function Page() {
  return (
    <>
      <PageHeader title="Sarvam Voice Agents" crumb="Settings / Integrations" />
      <ProviderSettings provider="sarvam_telephony" />
    </>
  );
}
