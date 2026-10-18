import { config } from '../common/config.js';
import { describeError } from '../common/errors.js';
import { log } from '../common/logger.js';

export type ApprovedTemplate = {
  name: string;
  language: string;
  category: string;
  body: string;
  /** Number of {{n}} variables in the body. */
  variables: number;
  /** IMAGE when the template has an image header (the campaign then needs a header image link). */
  header: 'IMAGE' | 'TEXT' | 'VIDEO' | 'DOCUMENT' | null;
};

export type TemplateList = { configured: boolean; reason?: string; templates: ApprovedTemplate[] };

let cache: { at: number; value: TemplateList } | undefined;

/**
 * APPROVED templates of the WhatsApp Business Account, from Meta (read-only). Without WHATSAPP_BUSINESS_ACCOUNT_ID /
 * WHATSAPP_ACCESS_TOKEN the list is empty with the reason: campaigns can then only be drafted and simulated.
 */
export async function approvedTemplates(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<TemplateList> {
  if (cache && now - cache.at < 5 * 60_000) return cache.value;
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '';
  if (!waba || !config.whatsapp.accessToken) return { configured: false, reason: 'Set WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN to load your approved templates from Meta.', templates: [] };
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${waba}/message_templates?fields=name,language,status,category,components&limit=200`, {
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as { data?: Array<{ name: string; language: string; status: string; category: string; components?: Array<{ type: string; format?: string; text?: string }> }>; error?: { message?: string } };
    if (!res.ok) return { configured: true, reason: `Meta returned ${res.status}: ${data.error?.message ?? 'error'}`, templates: [] };
    const templates = (data.data ?? [])
      .filter((t) => t.status === 'APPROVED')
      .map((t) => {
        const body = t.components?.find((c) => c.type === 'BODY')?.text ?? '';
        const header = t.components?.find((c) => c.type === 'HEADER')?.format ?? null;
        return { name: t.name, language: t.language, category: t.category, body, variables: new Set(body.match(/\{\{\d+\}\}/g) ?? []).size, header: header as ApprovedTemplate['header'] };
      });
    const value = { configured: true, templates };
    cache = { at: now, value };
    return value;
  } catch (error) {
    log.warn('marketing.templates_failed', { error: describeError(error) });
    return { configured: true, reason: `Could not reach Meta: ${describeError(error).slice(0, 120)}`, templates: [] };
  }
}

export function clearTemplateCache() {
  cache = undefined;
}
