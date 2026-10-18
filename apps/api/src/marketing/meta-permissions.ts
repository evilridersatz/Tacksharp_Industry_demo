import { config } from '../common/config.js';
import { describeError } from '../common/errors.js';

export type MetaPermissions = {
  /** true = Meta answered; false = no token or Meta could not be reached (then nothing is claimed). */
  checked: boolean;
  granted: string[];
  adsRead: boolean | null;
  reason?: string;
  checkedAt: string;
};

let cache: { at: number; ttl: number; value: MetaPermissions } | undefined;
const remember = (now: number, value: MetaPermissions, ttl: number) => ((cache = { at: now, ttl, value }), value);

/**
 * Which permissions the configured Meta token actually has (GET /me/permissions), read-only and cached 10 minutes.
 * Ad spend / ROI is shown only when `ads_read` is granted AND an ads integration is built - today none is, so the
 * dashboard says "permission granted, ad reporting not built" rather than inventing numbers.
 */
export async function metaPermissions(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<MetaPermissions> {
  if (cache && now - cache.at < cache.ttl) return cache.value;
  const token = config.meta.pageAccessToken || config.whatsapp.accessToken;
  const at = new Date(now).toISOString();
  if (!token) return { checked: false, granted: [], adsRead: null, reason: 'No Meta access token is configured.', checkedAt: at };
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${config.whatsapp.apiVersion}/me/permissions`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ permission: string; status: string }>; error?: { message?: string } };
    if (!res.ok) return remember(now, { checked: false, granted: [], adsRead: null, reason: `Meta returned ${res.status}: ${body.error?.message ?? 'error'}`.slice(0, 200), checkedAt: at }, 2 * 60_000);
    const granted = (body.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission);
    return remember(now, { checked: true, granted, adsRead: granted.includes('ads_read'), checkedAt: at }, 10 * 60_000);
  } catch (e) {
    // Failures are remembered briefly so a dashboard poll does not call Meta every few seconds.
    return remember(now, { checked: false, granted: [], adsRead: null, reason: `Could not reach Meta: ${describeError(e).slice(0, 120)}`, checkedAt: at }, 2 * 60_000);
  }
}

export function adSpendStatus(p: MetaPermissions): { status: 'blocked' | 'unknown' | 'not_built'; note: string } {
  if (p.checked && p.adsRead) return { status: 'not_built', note: 'ads_read is granted, but ad-spend reporting is not built yet: no spend or ROI is shown.' };
  if (p.checked) return { status: 'blocked', note: 'ads_read is NOT granted to the Meta token: no ad spend, campaign IDs or ROI are shown.' };
  return { status: 'unknown', note: `Meta permissions could not be checked (${p.reason ?? 'unknown'}): no ad spend or ROI is shown.` };
}

export function clearMetaPermissionCache() {
  cache = undefined;
}
