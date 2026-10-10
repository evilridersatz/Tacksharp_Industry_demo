import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';

export type ChannelKind = 'whatsapp_phone_number_id' | 'plivo_number' | 'meta_page_id' | 'web_chat_key';
export type Vertical = 'real_estate' | 'restaurant';

const CACHE_MS = 60_000;

/**
 * Resolves which organization an inbound webhook belongs to, from the identifier the provider sent
 * (never from the body of a customer message).
 *
 *  1. an OrganizationChannel row (multi-tenant);
 *  2. otherwise the identifier configured in this deployment's own environment
 *     (WHATSAPP_PHONE_NUMBER_ID / PLIVO_FROM_NUMBER) maps to DEFAULT_ORGANIZATION_ID, so a
 *     single-business installation works without any extra setup;
 *  3. anything else is unknown: the caller must reject it. Traffic for an unknown number is never
 *     silently attached to the default organization.
 */
@Injectable()
export class TenancyService {
  private readonly cache = new Map<string, { at: number; organizationId: string | null }>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(kind: ChannelKind, rawExternalId: string | null | undefined): Promise<string | undefined> {
    const externalId = this.canonical(kind, rawExternalId);
    if (!externalId) return undefined;

    const cacheKey = `${kind}:${externalId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.organizationId ?? undefined;

    let organizationId: string | null = null;
    try {
      const row = await this.prisma.organizationChannel.findUnique({ where: { kind_externalId: { kind, externalId } } });
      organizationId = row?.organizationId ?? null;
    } catch (error) {
      // A database problem is not "unknown number": do not cache, let the env-configured fallback still work.
      log.error('tenancy.lookup_failed', { kind, error: errorMessage(error) });
    }
    if (!organizationId && externalId === this.configured(kind)) organizationId = config.defaultOrganizationId;
    // Lead-ad webhooks: a deployment with no page configured and no page mappings at all is single-tenant.
    if (!organizationId && kind === 'meta_page_id' && !config.meta.pageId) {
      try {
        if ((await this.prisma.organizationChannel.count({ where: { kind } })) === 0) organizationId = config.defaultOrganizationId;
      } catch (error) {
        log.error('tenancy.lookup_failed', { kind, error: errorMessage(error) });
      }
    }

    this.cache.set(cacheKey, { at: Date.now(), organizationId });
    if (!organizationId) log.warn('tenancy.unknown_identifier', { kind, id: externalId.slice(-4).padStart(externalId.length, '*') });
    return organizationId ?? undefined;
  }

  private readonly verticals = new Map<string, { at: number; vertical: Vertical }>();

  /** Which product a tenant runs (real estate lead follow-up or restaurant ordering). Unknown -> real_estate. */
  async vertical(organizationId: string): Promise<Vertical> {
    const hit = this.verticals.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.vertical;
    try {
      const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { vertical: true } });
      const vertical: Vertical = org?.vertical === 'restaurant' ? 'restaurant' : 'real_estate';
      this.verticals.set(organizationId, { at: Date.now(), vertical });
      return vertical;
    } catch (error) {
      log.error('tenancy.vertical_lookup_failed', { organizationId, error: errorMessage(error) });
      return 'real_estate';
    }
  }

  /** Test / admin helper: forget cached lookups after a mapping changes. */
  clearCache() {
    this.cache.clear();
    this.verticals.clear();
  }

  private canonical(kind: ChannelKind, raw: string | null | undefined): string | undefined {
    const value = (raw ?? '').trim();
    if (!value) return undefined;
    if (kind === 'plivo_number') return normalizePhone(value);
    return value;
  }

  private configured(kind: ChannelKind): string | undefined {
    if (kind === 'whatsapp_phone_number_id') return config.whatsapp.phoneNumberId || undefined;
    if (kind === 'plivo_number') return normalizePhone(config.plivo.fromNumber);
    if (kind === 'meta_page_id') return config.meta.pageId || undefined;
    return undefined;
  }
}
