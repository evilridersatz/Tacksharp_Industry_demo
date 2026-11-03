'use client';

import { PageHeader } from '@/components/shell';
import { ProviderSettings } from '@/components/integrations';

export default function Page() {
  return (
    <>
      <PageHeader title="Meta Conversions API" crumb="Settings / Integrations" />
      <ProviderSettings provider="meta_capi" />
    </>
  );
}
