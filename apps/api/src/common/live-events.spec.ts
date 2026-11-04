import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onLive, publishLive } from './live-events.js';

describe('live dashboard events', () => {
  beforeAll(() => { process.env.LIVE_EVENTS_REDIS = 'false'; });
  afterAll(() => { delete process.env.LIVE_EVENTS_REDIS; });

  it('reaches only the listeners of that organization, with the customer first name only', () => {
    const a: unknown[] = []; const b: unknown[] = [];
    const offA = onLive('org_a', (e) => a.push(e));
    const offB = onLive('org_b', (e) => b.push(e));
    publishLive('org_a', { type: 'order.created', orderNumber: 'GR-1', channel: 'whatsapp', total: 220, customer: 'Ramesh Kumar' });
    expect(a).toEqual([expect.objectContaining({ type: 'order.created', orderNumber: 'GR-1', customer: 'Ramesh' })]);
    expect(b).toEqual([]);
    offA(); offB();
    publishLive('org_a', { type: 'message' });
    expect(a).toHaveLength(1);
  });
});
