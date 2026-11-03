'use client';

import { PageHeader } from '@/components/shell';
import { ProviderSettings } from '@/components/integrations';
import { SocialAiCard } from '@/components/social-ai';

export default function Page() {
  return (
    <>
      <PageHeader title="Instagram & Messenger" crumb="Settings / Integrations" />
      <ProviderSettings provider="meta_social" />
      <SocialAiCard />
    </>
  );
}
