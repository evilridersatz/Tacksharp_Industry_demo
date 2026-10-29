'use client';

import { PageHeader } from '@/components/shell';
import { ProviderSettings } from '@/components/integrations';

export default function Page() {
  return (
    <>
      <PageHeader title="WhatsApp Cloud API" crumb="Settings / Integrations" />
      <ProviderSettings provider="whatsapp" />
    </>
  );
}
