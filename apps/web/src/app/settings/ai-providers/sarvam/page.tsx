'use client';

import { PageHeader } from '@/components/shell';
import { ProviderSettings } from '@/components/integrations';

export default function Page() {
  return (
    <>
      <PageHeader title="Sarvam AI" crumb="Settings / AI providers" />
      <ProviderSettings provider="sarvam" />
    </>
  );
}
