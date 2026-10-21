import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../common/config.js';
import { normalizePhone } from '../common/phone.js';
import { errorMessage, log } from '../common/logger.js';

export type ChannelKind = 'whatsapp_phone_number_id' | 'plivo_number' | 'meta_page_id' | 'web_chat_key';
export type Vertical = 'real_estate' | 'restaurant';

/**
 * The organization's product could not be determined (database unreachable, organization missing). Callers must
 * fail the turn (retry / "please say that again"), never guess: guessing "real_estate" is how a GR Chicken customer
 * got property questions while the database was timing out.
 */
export class TenantResolutionError extends Error {
  constructor(message: string, readonly organizationId: string) {
    super(message);
    this.name = 'TenantResolutionError';
  }
}

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
export class TenancyService implements OnApplicationBootstrap {
  private readonly cache = new Map<string, { at: number; organizationId: string | null }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Startup: say loudly when this deployment's number falls back to the default organization while a restaurant exists. */
  async onApplicationBootstrap() {
    try {
      const report = await this.mappingReport();
      const restaurants = await this.prisma.organization.count({ where: { vertical: 'restaurant' } });
      for (const r of report) {
        if (!r.configured || r.via !== 'default_fallback') continue;
        log.warn('tenancy.unmapped_number', {
          kind: r.kind,
          number: r.masked,
          routedTo: r.organizationId,
          vertical: r.vertical,
          ...(restaurants > 0 && r.vertical !== 'restaurant'
            ? { warning: `Not mapped to any organization: messages/calls to it reach the ${r.vertical} assistant of DEFAULT_ORGANIZATION_ID. If it is GR Chicken's number, map it (npm run seed:gr-chicken with GR_WHATSAPP_PHONE_NUMBER_ID / GR_PLIVO_NUMBER).` }
            : {}),
        });
      }
    } catch (error) {
      log.warn('tenancy.mapping_check_failed', { error: errorMessage(error) });
    }
  }

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
    if (!organizationId && externalId === this.configured(kind)) {
      // Single-tenant convenience: this deployment's own number belongs to DEFAULT_ORGANIZATION_ID unless a
      // channel row says otherwise. Logged, because a GR Chicken number left unmapped lands in the default
      // (real-estate) organization this way — see mappingReport() and the startup warning.
      organizationId = config.defaultOrganizationId;
      log.warn('tenancy.default_fallback', { kind, organizationId });
    }
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

  /**
   * Which product a tenant runs (real estate lead follow-up or restaurant ordering), from the organization row.
   * Fails closed: a database error or a missing organization throws TenantResolutionError instead of defaulting
   * to real estate. (The earlier default sent GR Chicken turns to the real-estate engine whenever this lookup
   * failed, e.g. during a database connect timeout.)
   */
  async vertical(organizationId: string): Promise<Vertical> {
    const hit = this.verticals.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.vertical;
    let org: { vertical: string | null } | null;
    try {
      org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { vertical: true } });
    } catch (error) {
      log.error('tenancy.vertical_lookup_failed', { organizationId, dependency: 'database', error: errorMessage(error) });
      // A stale cached answer is still the right product; only with none at all do we refuse.
      if (hit) return hit.vertical;
      throw new TenantResolutionError(`Could not load organization ${organizationId}: ${errorMessage(error)}`, organizationId);
    }
    if (!org) throw new TenantResolutionError(`Unknown organization ${organizationId}`, organizationId);
    const vertical: Vertical = org.vertical === 'restaurant' ? 'restaurant' : 'real_estate';
    this.verticals.set(organizationId, { at: Date.now(), vertical });
    return vertical;
  }

  /**
   * Where this deployment's own WhatsApp number and Plivo number are routed, and how: by a channel row (explicit)
   * or by the DEFAULT_ORGANIZATION_ID fallback. Shown on startup and on the dashboard so an unmapped GR Chicken
   * number (customers reaching the real-estate assistant) is visible. Identifiers are masked.
   */
  async mappingReport(): Promise<Array<{ kind: ChannelKind; configured: boolean; masked?: string; organizationId?: string; via?: 'channel' | 'default_fallback'; vertical?: Vertical | 'unknown' }>> {
    const out = [];
    for (const kind of ['whatsapp_phone_number_id', 'plivo_number'] as const) {
      const id = this.configured(kind);
      if (!id) {
        out.push({ kind, configured: false });
        continue;
      }
      const row = await this.prisma.organizationChannel.findUnique({ where: { kind_externalId: { kind, externalId: id } } });
      const organizationId = row?.organizationId ?? config.defaultOrganizationId;
      const vertical = await this.vertical(organizationId).catch(() => 'unknown' as const);
      out.push({ kind, configured: true, masked: id.slice(-4).padStart(id.length, '*'), organizationId, via: row ? ('channel' as const) : ('default_fallback' as const), vertical });
    }
    return out;
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
