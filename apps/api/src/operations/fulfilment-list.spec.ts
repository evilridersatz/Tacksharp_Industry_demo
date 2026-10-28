import { describe, expect, it } from 'vitest';
import { OperationsController } from './operations.controller.js';

describe('GET /operations/fulfilment', () => {
  it('lists the NEWEST open orders (a new order is never hidden behind a backlog), oldest first', async () => {
    const t = (d: number) => new Date(Date.UTC(2026, 9, d));
    let args: { orderBy?: unknown; take?: number } = {};
    const prisma = {
      salesOrder: {
        // Prisma returns newest first for orderBy desc
        findMany: async (a: typeof args) => { args = a; return [3, 2, 1].map((d) => ({ id: `o${d}`, number: `SO-${d}`, status: 'confirmed', paymentStatus: 'pending', total: 1, customer: null, expectedDelivery: null, createdAt: t(d) })); },
      },
    };
    const inventory = { orderStock: async () => ({ fullyReserved: false, lines: [], untrackedItems: 0 }) };
    const approvals = { registerExecutor: () => undefined };
    const ctl = new OperationsController(inventory as never, approvals as never, {} as never, {} as never, prisma as never, {} as never);
    const rows = await ctl.fulfilment('org_x', { sub: 'u1', role: 'admin' } as never);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.take).toBe(100);
    expect(rows.map((r) => r.number)).toEqual(['SO-1', 'SO-2', 'SO-3']);
  });
});
