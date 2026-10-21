'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { IndustryId } from './industries';

export type Workspace = {
  organizationId: string;
  name: string;
  vertical: string;
  isDemo: boolean;
  industry: IndustryId;
  label: string;
  canChangeIndustry: boolean;
  settableIndustries: IndustryId[];
  integrations: { whatsapp: boolean; voice: boolean; ai: boolean; dryRun: boolean };
};

/**
 * The current workspace and its EFFECTIVE industry (GET /industry/workspace): a restaurant vertical is always restaurant;
 * other businesses use Settings → Industry. One shared value per tab: the shell, guards and pages all read it, but it is
 * fetched at most once a minute (in-flight requests shared) so many widgets do not multiply API calls.
 */
let value: Workspace | undefined;
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<(v: Workspace | undefined) => void>();

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = api
    .get<Workspace>('/industry/workspace')
    .then((r) => {
      value = r;
      fetchedAt = Date.now();
      listeners.forEach((l) => l(value));
    })
    .catch(() => undefined) // keep the last known value
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Drop the cached workspace (after switching workspace or changing industry). */
export function forgetWorkspace() {
  value = undefined;
  fetchedAt = 0;
}

export function useWorkspace(): { workspace: Workspace | undefined; loading: boolean } {
  const [ws, setWs] = useState<Workspace | undefined>(value);
  const [loading, setLoading] = useState(value === undefined);
  useEffect(() => {
    const l = (v: Workspace | undefined) => {
      setWs(v);
      setLoading(false);
    };
    listeners.add(l);
    if (value === undefined || Date.now() - fetchedAt > 60_000) void refresh().finally(() => setLoading(false));
    else l(value);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return { workspace: ws, loading };
}

/** Effective industry of the current workspace. */
export function useIndustry(): { industry: IndustryId | undefined; loading: boolean } {
  const { workspace, loading } = useWorkspace();
  return { industry: workspace?.industry, loading };
}

export type WorkspaceOption = {
  organizationId: string;
  name: string;
  vertical: string;
  isDemo: boolean;
  role: string;
  industry: IndustryId;
  industryLabel: string;
  current: boolean;
};

/**
 * Open another workspace the user belongs to. The server checks the membership and issues a session for that
 * organization; a full reload then drops every cached value from the previous workspace.
 */
export async function switchWorkspace(organizationId: string, then = '/') {
  await api.post('/auth/workspace', { organizationId });
  forgetWorkspace();
  window.location.href = then;
}
