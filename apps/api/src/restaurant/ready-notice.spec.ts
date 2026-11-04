import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeRedis } = vi.hoisted(() => {
  const locks = new Map<string, string>();

  return {
    fakeRedis: {
      set: vi.fn(async (key: string, token: string) => {
        if (locks.has(key)) return null;
        locks.set(key, token);
        return 'OK';
      }),
      eval: vi.fn(async (_script: string, _count: number, key: string, token: string) => {
        if (locks.get(key) === token) {
          locks.delete(key);
          return 1;
        }
        return 0;
      }),
    },
  };
});

vi.mock('../queues/queues.js', () => ({ queueRedis: fakeRedis }));

import { ReadyNoticeService } from './ready-notice.service.js';

describe('ReadyNoticeService duplicate protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes concurrent ready requests only once for the same order', async () => {
    const order: any = {
      id: 'order-test-1',
      status: 'ready',
      readyNotice: null,
      customerId: 'customer-test-1',
      customerPhone: '919000000001',
      channel: 'test',
      conversationId: null,
    };

    const orders = {
      getOrder: vi.fn(async () => ({ ...order })),
    };

    const prisma = {
      customer: {
        findFirst: vi.fn(async () => ({
          phone: order.customerPhone,
          isDemo: true,
          optedOutAt: null,
        })),
      },
    };

    const service = new ReadyNoticeService(
      prisma as any,
      orders as any,
      {} as any,
      {} as any,
    );

    const notification = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.readyNotice = 'whatsapp_sent';
    });

    (service as any).whatsapp = notification;

    await Promise.all([
      service.notify('org-test-1', order.id),
      service.notify('org-test-1', order.id),
    ]);

    expect(notification).toHaveBeenCalledTimes(1);
    expect(fakeRedis.set.mock.calls.length).toBeGreaterThan(2);
    expect(fakeRedis.eval).toHaveBeenCalledTimes(2);
    expect(orders.getOrder).toHaveBeenCalledTimes(2);
  });

  it('calls the customer with the phone agent first; WhatsApp only when the call cannot be placed', async () => {
    const prev = { dry: process.env.DRY_RUN, all: process.env.LIVE_ALLOW_ALL_CUSTOMERS };
    process.env.DRY_RUN = 'false'; process.env.LIVE_ALLOW_ALL_CUSTOMERS = 'true';
    try {
      const order: any = { id: 'o-2', orderNumber: 'GR-1', status: 'ready', readyNotice: null, customerId: 'c-2', customerName: 'Kumar', customerPhone: '919000000002', channel: 'voice', conversationId: null, total: 440, language: null, outlet: { name: 'GR Chicken Shop' }, items: [{ name: 'Broiler Chicken', quantity: 2, unit: 'kg', cut: 'Curry cut' }] };
      const recorded: any[] = [];
      const orders = { getOrder: vi.fn(async () => ({ ...order })), recordReadyNotice: vi.fn(async (_o: string, _id: string, u: any) => { recorded.push(u); }) };
      const prisma = { customer: { findFirst: vi.fn(async () => ({ phone: order.customerPhone, isDemo: false, optedOutAt: null })) } };
      const telephony = { placeSystemCall: vi.fn(async () => ({ started: true, requestId: 'r1' })) };
      const service = new ReadyNoticeService(prisma as any, orders as any, {} as any, {} as any, telephony as any);
      const wa = vi.fn(async () => undefined);
      (service as any).whatsapp = wa;
      await service.notify('org-2', order.id);
      expect(telephony.placeSystemCall).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'order_ready', customerId: 'c-2', variables: expect.objectContaining({ order_number: 'GR-1' }) }));
      expect(recorded[0]).toMatchObject({ readyNotice: 'calling' });
      // The agent opens with the ready message for THIS order, in the customer's language (Tamil by default).
      const call = (telephony.placeSystemCall.mock.calls[0] as any[])[0];
      expect(call.overrides.initialLanguage).toBe('Tamil');
      expect(call.overrides.initialBotMessage).toContain('ready');
      expect(call.overrides.initialBotMessage).toContain('G R 1');
      expect(wa).not.toHaveBeenCalled();
      // The call is refused (e.g. no calling consent): the ready message goes on WhatsApp, with the reason.
      telephony.placeSystemCall.mockResolvedValueOnce({ started: false, reason: 'no_calling_consent' } as any);
      await service.notify('org-2', order.id, { force: true });
      expect(wa).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no_calling_consent'));
    } finally {
      if (prev.dry === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = prev.dry;
      if (prev.all === undefined) delete process.env.LIVE_ALLOW_ALL_CUSTOMERS; else process.env.LIVE_ALLOW_ALL_CUSTOMERS = prev.all;
    }
  });
});
