'use client';

import { IndustryDashboard } from '@/components/industry-dashboard';
import { useWorkspace } from '@/lib/industry';
import { industryDef } from '@/lib/industries';

/** Reports & analytics for every industry: the same server-computed dashboard, labelled for the workspace's industry. */
export default function AnalyticsPage() {
  const { workspace } = useWorkspace();
  const def = industryDef(workspace?.industry);
  const title = def.nav.flatMap((g) => g.items).find((i) => i.href === '/analytics')?.label ?? 'Reports & analytics';
  return <IndustryDashboard title={workspace ? title : 'Reports & analytics'} analytics />;
}
