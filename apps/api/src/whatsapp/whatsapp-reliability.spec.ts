import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
process.env.WHATSAPP_ACCESS_TOKEN ??= 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID ??= '1234567890';
process.env.DRY_RUN = 'false';
const { WhatsAppSenderService, WhatsAppAmbiguousSendError, WhatsAppPermanentError, WhatsAppTransientError, classifyWhatsAppFailure } = await import('./whatsapp-sender.service.js');
const { ErrorThrottle, dependencyOf, describeError, isAmbiguousNetworkFailure, isConnectFailure } = await import('../common/errors.js');

/** Node fetch failures look like this: "fetch failed" with the real reason in cause. */
const fetchFailed = (cause: Record<string, unknown>) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(String(cause.message)), cause) });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function sender(fetchImpl: (...a: any[]) => Promise<Response>) {
  const s = new WhatsAppSenderService();
  s.fetchImpl = vi.fn(fetchImpl) as unknown as typeof fetch;
  return s;
}

describe('global dry-run guard', () => {
  it('blocks the provider request when DRY_RUN is enabled', async () => {
    const previous = process.env.DRY_RUN;
    process.env.DRY_RUN = 'true';
    const fetchMock = vi.fn(async () => json(200, { messages: [{ id: 'should-not-send' }] }));
    try {
      const s = sender(fetchMock);
      const err = await s.sendText('919000000001', 'dry-run safety test').catch((e) => e);
      expect(err).toBeInstanceOf(WhatsAppPermanentError);
      expect(err.message).toContain('DRY_RUN is on');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = previous;
    }
  });
});

describe('WhatsApp send failures: retry only when it is safe', () => {
  it('success returns the provider message id (accepted, not "delivered")', async () => {
    const s = sender(async () => json(200, { messages: [{ id: 'wamid.OK' }] }));
    expect(await s.sendText('919000000001', 'hi')).toBe('wamid.OK');
  });

  it('HTTP 400 (bad number / closed 24h window / wrong template) and 401 / 403 are permanent: never retried', async () => {
    for (const [status, code] of [[400, 131047], [400, 132001], [401, 190], [403, 10]] as const) {
      const s = sender(async () => json(status, { error: { message: 'nope', code } }));
      const err = await s.sendText('919000000001', 'hi').catch((e) => e);
      expect(err, `${status}/${code}`).toBeInstanceOf(WhatsAppPermanentError);
      expect(err).toBeInstanceOf(UnrecoverableError); // BullMQ stops retrying
    }
  });

  it('rate limits and server errors are retryable (429, 5xx, Meta throughput codes sent as 400)', async () => {
    for (const [status, code] of [[429, 4], [500, 1], [503, 2], [400, 130429], [400, 131056]] as const) {
      const s = sender(async () => json(status, { error: { message: 'slow down', code } }, { 'retry-after': '3' }));
      const err = await s.sendText('919000000001', 'hi').catch((e) => e);
      expect(err, `${status}/${code}`).toBeInstanceOf(WhatsAppTransientError);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
    }
    expect(classifyWhatsAppFailure(408)).toBe('retryable');
    expect(classifyWhatsAppFailure(404)).toBe('permanent');
  });

  it('connect ETIMEDOUT (Meta never got the request) is retryable and names the dependency', async () => {
    const s = sender(async () => {
      throw fetchFailed({ message: 'connect ETIMEDOUT 157.240.1.1:443', code: 'ETIMEDOUT', syscall: 'connect', address: '157.240.1.1', port: 443 });
    });
    const err = await s.sendText('919000000001', 'hi').catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppTransientError);
    expect(err.message).toContain('not sent');
    expect(err.message).toContain('connect ETIMEDOUT');
    expect(dependencyOf(err)).toBe('meta_graph');
  });

  it('a timeout AFTER sending is "delivery unknown": never retried, so the customer cannot get the reply twice', async () => {
    for (const thrown of [
      Object.assign(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      fetchFailed({ message: 'read ECONNRESET', code: 'ECONNRESET', syscall: 'read' }),
      fetchFailed({ message: 'other side closed', code: 'UND_ERR_SOCKET' }),
    ]) {
      const s = sender(async () => {
        throw thrown;
      });
      const err = await s.sendText('919000000001', 'hi').catch((e) => e);
      expect(err).toBeInstanceOf(WhatsAppAmbiguousSendError);
      expect(err).toBeInstanceOf(UnrecoverableError);
      expect(err.ambiguous).toBe(true);
    }
  });
});

describe('which dependency failed (the "connect ETIMEDOUT" diagnosis)', () => {
  it('a bare "connect ETIMEDOUT" from a worker is the Redis connection (ioredis wording)', () => {
    const redisTimeout = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect', errorno: 'ETIMEDOUT' });
    expect(isConnectFailure(redisTimeout)).toBe(true);
    expect(dependencyOf(redisTimeout, 'redis')).toBe('redis');
  });

  it('missing WhatsApp settings are a permanent configuration error tagged meta_graph (not "database")', async () => {
    const s = new WhatsAppSenderService();
    const { config } = await import('../common/config.js');
    const saved = config.whatsapp.accessToken;
    (config.whatsapp as any).accessToken = '';
    const err = await s.sendText('919000000001', 'hi').catch((e) => e);
    (config.whatsapp as any).accessToken = saved;
    expect(err).toBeInstanceOf(WhatsAppPermanentError);
    expect(dependencyOf(new Error('WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing'))).toBe('meta_graph');
    expect(dependencyOf(new Error('ER_ACCESS_DENIED_ERROR: Access denied for user'))).toBe('database');
  });

  it('database, Meta and Sarvam errors are told apart', () => {
    expect(dependencyOf(new Error('(conn:-1, no: 45028, SQLState: HY000) pool timeout: failed to retrieve a connection'))).toBe('database');
    expect(dependencyOf(new Error('WhatsApp API 503: Service unavailable (code 2)'))).toBe('meta_graph');
    expect(dependencyOf(new Error('Sarvam STT 429: rate limited'))).toBe('sarvam');
  });

  it('describeError keeps the cause chain that "fetch failed" hides', () => {
    const e = fetchFailed({ message: 'getaddrinfo ENOTFOUND graph.facebook.com', code: 'ENOTFOUND', syscall: 'getaddrinfo' });
    expect(describeError(e)).toBe('fetch failed <- getaddrinfo ENOTFOUND graph.facebook.com');
    expect(isConnectFailure(e)).toBe(true);
    expect(isAmbiguousNetworkFailure(e)).toBe(false);
  });

  it('repeated identical worker errors are logged once per window, with a count (no log storm)', () => {
    let t = 0;
    const throttle = new ErrorThrottle(60_000, () => t);
    const err = new Error('connect ETIMEDOUT');
    expect(throttle.report('worker.error', err, {}, 'redis')).toBe(true);
    for (let i = 0; i < 50; i++) expect(throttle.report('worker.error', err, {}, 'redis')).toBe(false);
    t = 61_000;
    expect(throttle.report('worker.error', err, {}, 'redis')).toBe(true);
    expect(throttle.report('worker.error', new Error('connect ECONNREFUSED 127.0.0.1:6379'), {}, 'redis')).toBe(true); // a different error is logged
  });
});
