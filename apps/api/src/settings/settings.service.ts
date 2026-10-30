import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { errorMessage, log } from '../common/logger.js';
import { DEFAULT_SETTINGS, sanitizeSettings, type TenantSettings } from './tenant-settings.js';

const CACHE_MS = 30_000;

/** Per-organization automation settings (one JSON row per organization, defaults for anything missing). */
@Injectable()
export class SettingsService {
  private readonly cache = new Map<string, { at: number; value: TenantSettings }>();

  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string): Promise<TenantSettings> {
    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value = DEFAULT_SETTINGS;
    try {
      const row = await this.prisma.organizationSettings.findUnique({ where: { organizationId } });
      if (row) value = sanitizeSettings(row.data, DEFAULT_SETTINGS);
    } catch (error) {
      // A read failure must not stop calls or messages: run on defaults, and do not cache the failure.
      log.error('settings.read_failed', { organizationId, error: errorMessage(error) });
      return DEFAULT_SETTINGS;
    }
    this.cache.set(organizationId, { at: Date.now(), value });
    return value;
  }

  /** Partial update from the dashboard: merged over the current settings, validated, stored. */
  async update(organizationId: string, patch: unknown): Promise<TenantSettings> {
    const current = await this.get(organizationId);
    const next = sanitizeSettings(patch, current);
    // Keys owned by other modules (telephony provider choice) live in the same document: keep them.
    const stored = (await this.prisma.organizationSettings.findUnique({ where: { organizationId } }))?.data as Record<string, unknown> | undefined;
    const data = { ...next, ...(stored?.telephony ? { telephony: stored.telephony } : {}) };
    await this.prisma.organizationSettings.upsert({
      where: { organizationId },
      create: { organizationId, data: data as never },
      update: { data: data as never },
    });
    this.cache.set(organizationId, { at: Date.now(), value: next });
    log.info('settings.updated', { organizationId });
    return next;
  }

  clearCache() {
    this.cache.clear();
  }
}
