import { describe, expect, it } from 'vitest';
import { OrderSessionStore, type OrderSession } from './order-session.store.js';

/** In-memory stand-in for the shared Redis (GET / SET with NX+PX / compare-and-delete), as two API instances see it. */
function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    async get(k: string) { return data.get(k) ?? null; },
    async set(k: string, v: string, ...args: unknown[]) {
      if (args.includes('NX') && data.has(k)) return null;
      data.set(k, v);
      return 'OK';
    },
    async del(k: string) { return data.delete(k) ? 1 : 0; },
    async eval(_lua: string, _n: number, k: string, token: string) { if (data.get(k) === token) { data.delete(k); return 1; } return 0; },
  };
}
const session = (key: string, lines: OrderSession['lines'], updatedAt: string): OrderSession =>
  ({ v: 2, key, organizationId: 'org', channel: 'whatsapp', phone: '91900', lang: 'tanglish', lines, greeted: true, step: 'collecting', history: [], updatedAt }) as OrderSession;

describe('order sessions across two API instances (shared Redis)', () => {
  it('an instance never answers from its own older memory copy: the shared copy is read first', async () => {
    const redis = fakeRedis();
    const a = new OrderSessionStore(); a.useRedis(redis);
    const b = new OrderSessionStore(); b.useRedis(redis);
    await a.save(session('k', [{ itemId: 'eggs', quantity: 8 }], ''));
    expect((await b.get('k'))?.lines).toEqual([{ itemId: 'eggs', quantity: 8 }]); // b caches it
    const fromA = (await a.get('k'))!;
    fromA.lines = [];
    await new Promise((r) => setTimeout(r, 5));
    await a.save(fromA); // "No eggs" handled on instance A
    expect((await b.get('k'))?.lines).toEqual([]); // b does not resurrect the removed eggs from its memory
  });

  it('two instances handling the same customer at once run one turn after the other', async () => {
    const redis = fakeRedis();
    const a = new OrderSessionStore(); a.useRedis(redis);
    const b = new OrderSessionStore(); b.useRedis(redis);
    const order: string[] = [];
    const turn = (name: string) => async () => { order.push(`${name}:start`); await new Promise((r) => setTimeout(r, 60)); order.push(`${name}:end`); };
    await Promise.all([a.withLock('k', turn('A')), b.withLock('k', turn('B'))]);
    expect(order).toEqual(order[0] === 'A:start' ? ['A:start', 'A:end', 'B:start', 'B:end'] : ['B:start', 'B:end', 'A:start', 'A:end']);
    expect(redis.data.size).toBe(0); // lock released
  });

  it('without Redis it still works (memory only)', async () => {
    const s = new OrderSessionStore(); s.useRedis(null);
    await s.save(session('k', [{ itemId: 'eggs', quantity: 2 }], ''));
    expect((await s.get('k'))?.lines).toEqual([{ itemId: 'eggs', quantity: 2 }]);
    expect(await s.withLock('k', async () => 42)).toBe(42);
  });
});
