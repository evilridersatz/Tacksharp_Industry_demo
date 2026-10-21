import { describe, expect, it } from 'vitest';
import { isTransientDbError, retryTransient } from './retry.js';

const conflict = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), { code: 'P2034' });

describe('retryTransient', () => {
  it('recognises write conflicts and deadlocks, nothing else', () => {
    expect(isTransientDbError(conflict())).toBe(true);
    expect(isTransientDbError(new Error('Deadlock found when trying to get lock'))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('x'), { meta: { code: '1213' } }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
  it('repeats a transient failure and returns the result', async () => {
    let calls = 0;
    const out = await retryTransient(async () => { if (++calls < 3) throw conflict(); return 'ok'; }, 'test');
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });
  it('gives up after 3 tries and rethrows the original error', async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls++; throw conflict(); }, 'test')).rejects.toMatchObject({ code: 'P2034' });
    expect(calls).toBe(3);
  });
  it('never repeats a non-transient error (no double side effects)', async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls++; throw new Error('boom'); }, 'test')).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});
