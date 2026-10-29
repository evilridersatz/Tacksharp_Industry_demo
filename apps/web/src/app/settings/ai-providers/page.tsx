'use client';

import { PageHeader } from '@/components/shell';
import { ProviderList } from '@/components/integrations';

export default function Page() {
  return (
    <>
      <PageHeader title="AI providers" crumb="Settings" />
      <ProviderList group="AI providers" />
    </>
  );
}
