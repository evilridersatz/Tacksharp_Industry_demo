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
      { enabled: false } as any,
      {} as any,
    );

    vi.spyOn(service, 'voiceStatus').mockReturnValue({
      ready: false,
      missing: ['test configuration'],
    });

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
});
