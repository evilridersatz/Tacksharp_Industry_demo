import { describe, expect, it, vi } from 'vitest';
import { TenancyService, TenantResolutionError } from './tenancy.service.js';
import { AiService } from '../ai/ai.service.js';

function tenancy(findUnique: (...a: any[]) => Promise<unknown>) {
  return new TenancyService({ organization: { findUnique: vi.fn(findUnique) } } as any);
}

describe('tenant product (vertical) resolution fails closed', () => {
  it('restaurant and real-estate organizations resolve from their own row', async () => {
    expect(await tenancy(async () => ({ vertical: 'restaurant' })).vertical('org_gr')).toBe('restaurant');
    expect(await tenancy(async () => ({ vertical: 'real_estate' })).vertical('org_re')).toBe('real_estate');
  });

  it('a database error is NOT treated as real estate (the old fallback sent GR Chicken turns to the property assistant)', async () => {
    const t = tenancy(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    await expect(t.vertical('org_gr')).rejects.toBeInstanceOf(TenantResolutionError);
  });

  it('a known answer survives a later database hiccup (cached), an unknown organization is refused', async () => {
    let fail = false;
    const t = tenancy(async ({ where }: any) => {
      if (fail) throw new Error('pool timeout');
      return where.id === 'org_gr' ? { vertical: 'restaurant' } : null;
    });
    expect(await t.vertical('org_gr')).toBe('restaurant');
    fail = true;
    (t as any).verticals.get('org_gr').at = 0; // cache expired
    expect(await t.vertical('org_gr')).toBe('restaurant');
    fail = false;
    await expect(t.vertical('org_missing')).rejects.toThrow('Unknown organization');
  });

  it('AiService never hands a turn to the real-estate engine when the product cannot be determined', async () => {
    const reEngine = { generate: vi.fn() };
    const ordering = { generate: vi.fn() };
    const ai = new AiService(reEngine as any, { vertical: async () => Promise.reject(new TenantResolutionError('db down', 'org_gr')) } as any, ordering as any);
    await expect(ai.generateResponse({ organizationId: 'org_gr', channel: 'whatsapp', phone: '919000000001', message: '1 kg chicken' } as any)).rejects.toBeInstanceOf(TenantResolutionError);
    expect(reEngine.generate).not.toHaveBeenCalled();
    expect(ordering.generate).not.toHaveBeenCalled();
  });
});
