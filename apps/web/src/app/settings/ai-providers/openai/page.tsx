'use client';

import { PageHeader } from '@/components/shell';
import { ProviderSettings } from '@/components/integrations';

export default function Page() {
  return (
    <>
      <PageHeader title="OpenAI" crumb="Settings / AI providers" />
      <ProviderSettings provider="openai" />
    </>
  );
}
