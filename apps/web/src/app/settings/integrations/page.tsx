'use client';

import { PageHeader } from '@/components/shell';
import { ProviderList } from '@/components/integrations';

export default function Page() {
  return (
    <>
      <PageHeader title="Integrations" crumb="Settings" />
      <ProviderList group="Integrations" />
    </>
  );
}
