'use client';

import { PageHeader } from '@/components/shell';
import { ProviderSettings } from '@/components/integrations';

export default function Page() {
  return (
    <>
      <PageHeader title="Plivo voice" crumb="Settings / Integrations" />
      <ProviderSettings provider="plivo" />
    </>
  );
}
