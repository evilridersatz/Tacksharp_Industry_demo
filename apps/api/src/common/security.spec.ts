import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { signSession, verifySession, readCookie } from '../auth/token.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { config, productionProblems } from './config.js';
import { createRateLimiter } from './rate-limit.js';
import { verifyMetaSignature } from './meta-signature.js';
import { isPermanentWhatsAppError } from '../whatsapp/whatsapp-sender.service.js';
import { latencyStats, percentile, recordTurn, resetLatency } from './latency.js';
import { buildCallSummary } from '../voice/call-summary.js';
import { inboundCallReason, inboundOpening } from '../voice/voice.prompts.js';
import { SarvamService } from '../sarvam/sarvam.service.js';

const SECRET = 'test-secret-that-is-long-enough-000000';
const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('session tokens', () => {
  it('round-trips claims', () => {
    const t = signSession({ sub: 'u1', org: 'o1', role: 'admin', exp: future() }, SECRET);
    expect(verifySession(t, SECRET)).toMatchObject({ sub: 'u1', org: 'o1' });
  });
  it('rejects tampering, wrong secret, expiry and garbage', () => {
    const t = signSession({ sub: 'u1', org: 'o1', role: 'admin', exp: future() }, SECRET);
    const [v, payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u1', org: 'OTHER', role: 'admin', exp: future() })).toString('base64url');
    expect(verifySession(`${v}.${forged}.${sig}`, SECRET)).toBeNull();
    expect(verifySession(t, 'another-secret-000000000000000000000')).toBeNull();
    expect(verifySession(signSession({ sub: 'u', org: 'o', role: 'a', exp: 1 }, SECRET), SECRET)).toBeNull();
    expect(verifySession(`${v}.${payload}`, SECRET)).toBeNull();
    expect(verifySession('nonsense', SECRET)).toBeNull();
    expect(verifySession(undefined, SECRET)).toBeNull();
  });
  it('reads the session cookie', () => {
    expect(readCookie('a=1; ts_session=abc.def; b=2', 'ts_session')).toBe('abc.def');
    expect(readCookie(undefined, 'ts_session')).toBeUndefined();
  });
});

describe('passwords', () => {
  it('hashes and verifies; rejects wrong and short passwords', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct-horse-battery', h)).toBe(true);
    expect(await verifyPassword('wrong-password-123', h)).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow();
  });
});

describe('AuthGuard (every route private unless @Public)', () => {
  const ctx = (headers: Record<string, string>, isPublic = false) => {
    const req: Record<string, unknown> = { headers };
    const reflector = { getAllAndOverride: () => isPublic } as never;
    const context = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) } as never;
    return { guard: new AuthGuard(reflector), context, req };
  };
  const token = () => signSession({ sub: 'u1', org: 'org-a', role: 'admin', exp: future() }, config.auth.secret);

  it('allows public routes without a token', () => {
    const { guard, context } = ctx({}, true);
    expect(guard.canActivate(context)).toBe(true);
  });
  it('blocks private routes without a valid token', () => {
    const { guard, context } = ctx({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    const bad = ctx({ authorization: 'Bearer v1.x.y' });
    expect(() => bad.guard.canActivate(bad.context)).toThrow(UnauthorizedException);
  });
  it('accepts a Bearer token or the session cookie and exposes the organization', () => {
    const a = ctx({ authorization: `Bearer ${token()}` });
    expect(a.guard.canActivate(a.context)).toBe(true);
    expect(a.req.auth).toMatchObject({ org: 'org-a' });
    const b = ctx({ cookie: `ts_session=${token()}` });
    expect(b.guard.canActivate(b.context)).toBe(true);
  });
});

describe('production start-up check', () => {
  const good = {
    NODE_ENV: 'production',
    AUTH_SECRET: 'x'.repeat(40),
    META_APP_SECRET: 'm',
    PLIVO_VALIDATE_SIGNATURE: 'true',
    PUBLIC_BASE_URL: 'https://app.tacksharp.ai/api',
    DB_PASSWORD: 'strong-db-password',
    OPENAI_API_KEY: 'k',
    SARVAM_API_KEY: 'k',
    PLIVO_AUTH_ID: 'k',
    PLIVO_AUTH_TOKEN: 'k',
    PLIVO_FROM_NUMBER: '914400000000',
    WHATSAPP_ACCESS_TOKEN: 'k',
    WHATSAPP_PHONE_NUMBER_ID: '1',
    WHATSAPP_VERIFY_TOKEN: 'k',
  };
  it('passes with safe settings and is skipped outside production', () => {
    expect(productionProblems(good)).toEqual([]);
    expect(productionProblems({ NODE_ENV: 'development' })).toEqual([]);
  });
  it('refuses unsafe settings', () => {
    expect(productionProblems({ ...good, AUTH_SECRET: 'short' })).toHaveLength(1);
    expect(productionProblems({ ...good, META_APP_SECRET: '' })).toHaveLength(1);
    expect(productionProblems({ ...good, PLIVO_VALIDATE_SIGNATURE: 'false' })).toHaveLength(1);
    expect(productionProblems({ ...good, PUBLIC_BASE_URL: 'https://abc.ngrok-free.app' })).toHaveLength(1);
    expect(productionProblems({ ...good, DB_PASSWORD: 'password' })).toHaveLength(1);
  });
  it('also refuses a missing provider key, a local base URL and accelerated follow-ups', () => {
    expect(productionProblems({ ...good, OPENAI_API_KEY: '' })[0]).toContain('OPENAI_API_KEY');
    expect(productionProblems({ ...good, PLIVO_FROM_NUMBER: undefined })[0]).toContain('PLIVO_FROM_NUMBER');
    expect(productionProblems({ ...good, PUBLIC_BASE_URL: 'https://localhost:3000' })).toHaveLength(1);
    expect(productionProblems({ ...good, PUBLIC_BASE_URL: 'https://192.168.1.5' })).toHaveLength(1);
    expect(productionProblems({ ...good, FOLLOWUP_TIME_SCALE: '0.01' })).toHaveLength(1);
    // names only: the error text never contains a value
    expect(JSON.stringify(productionProblems({ ...good, SARVAM_API_KEY: '' }))).not.toContain('strong-db-password');
  });
});

describe('rate limiting', () => {
  function run(limiter: ReturnType<typeof createRateLimiter>, path: string, ip: string) {
    const res = { statusCode: 200, headers: {} as Record<string, unknown>, setHeader(k: string, v: unknown) { this.headers[k] = v; }, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
    let passed = false;
    limiter({ path, ip } as never, res as never, () => (passed = true));
    return { passed, status: res.statusCode };
  }
  it('blocks login brute force per IP and resets after the window', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter(() => now);
    for (let i = 0; i < config.rateLimit.loginPerWindow; i++) expect(run(limiter, '/auth/login', '1.1.1.1').passed).toBe(true);
    expect(run(limiter, '/auth/login', '1.1.1.1')).toEqual({ passed: false, status: 429 });
    expect(run(limiter, '/auth/login', '2.2.2.2').passed).toBe(true); // other IP unaffected
    now += 5 * 60_000 + 1;
    expect(run(limiter, '/auth/login', '1.1.1.1').passed).toBe(true);
  });
  it('gives webhooks a separate, larger budget', () => {
    const limiter = createRateLimiter(() => 0);
    for (let i = 0; i < config.rateLimit.apiPerMinute; i++) run(limiter, '/leads', '3.3.3.3');
    expect(run(limiter, '/leads', '3.3.3.3').status).toBe(429);
    expect(run(limiter, '/voice/turn', '3.3.3.3').passed).toBe(true);
  });
});

describe('Meta webhook signature', () => {
  it('accepts a correct X-Hub-Signature-256 and rejects others', () => {
    const original = config.whatsapp.appSecret;
    (config.whatsapp as { appSecret: string }).appSecret = 'meta-app-secret';
    try {
      const body = Buffer.from('{"object":"whatsapp_business_account"}');
      const sig = 'sha256=' + createHmac('sha256', 'meta-app-secret').update(body).digest('hex');
      expect(() => verifyMetaSignature(body, sig)).not.toThrow();
      expect(() => verifyMetaSignature(body, 'sha256=' + '0'.repeat(64))).toThrow(UnauthorizedException);
      expect(() => verifyMetaSignature(body, undefined)).toThrow(UnauthorizedException);
      expect(() => verifyMetaSignature(Buffer.from('tampered'), sig)).toThrow(UnauthorizedException);
    } finally {
      (config.whatsapp as { appSecret: string }).appSecret = original;
    }
  });
});

describe('retry classification', () => {
  it('treats 4xx as permanent except 408/429; 5xx is retried', () => {
    expect(isPermanentWhatsAppError(400)).toBe(true);
    expect(isPermanentWhatsAppError(404)).toBe(true);
    expect(isPermanentWhatsAppError(429)).toBe(false);
    expect(isPermanentWhatsAppError(408)).toBe(false);
    expect(isPermanentWhatsAppError(500)).toBe(false);
  });
});

describe('latency P50 / P95', () => {
  it('computes percentiles per stage', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    resetLatency();
    for (let i = 1; i <= 20; i++) recordTurn({ sttMs: i * 10, aiMs: i * 100, ttsMs: 50, totalMs: i * 200 });
    const s = latencyStats();
    expect(s.turns).toBe(20);
    expect(s.ai.p50).toBe(1000);
    expect(s.total.p95).toBe(3800);
    expect(s.download.count).toBe(0);
  });

  it('reports OpenAI request count, tool time and pure-AI time separately (Phase 0 instrumentation)', () => {
    resetLatency();
    for (let i = 1; i <= 10; i++) {
      recordTurn({
        aiMs: 2000,
        postAiDbMs: i * 5,
        aiRequests: i <= 5 ? 1 : 3, // half the turns call no tools (1 request), half chain 2 tools (3 requests)
        toolMs: i <= 5 ? 0 : 400,
        pureAiMs: i <= 5 ? 2000 : 1600,
        firstToolCallMs: i <= 5 ? undefined : 250,
        totalMs: 2500,
      });
    }
    const s = latencyStats();
    expect(s.aiRequests.p50).toBe(1);
    expect(s.toolMs.p95).toBe(400);
    expect(s.pureAi.p50).toBeLessThan(2000); // confirms tool-chaining turns show less "pure" OpenAI time once tool time is subtracted
    expect(s.firstToolCall.count).toBe(5); // only present on turns that actually called a tool
    expect(s.postAiDb.p50).toBeGreaterThan(0);
  });
});

describe('call summary for the business owner', () => {
  it('is built from saved facts only', () => {
    const text = buildCallSummary({
      direction: 'outbound',
      outcome: 'site_visit_booked',
      language: 'ta-IN',
      customer: { location: 'Porur', bhk: 2, propertyType: 'Apartment', budget: 8_000_000 },
      siteVisit: { propertyName: 'Green Valley Residency', scheduledAt: new Date('2026-10-04T05:30:00Z') },
    });
    expect(text).toContain('AI called the customer. Site visit booked.');
    expect(text).toContain('2 BHK Apartment in Porur, budget up to 80 lakhs');
    expect(text).toContain('Green Valley Residency');
    expect(text).toContain('Tamil / Tanglish');
    expect(buildCallSummary({ direction: 'inbound', outcome: 'no_answer', customer: {} })).toBe('Customer called in. Not answered.');
  });
});

describe('voice language', () => {
  const sarvam = new SarvamService();
  it('speaks Tamil voice for Tamil / Tanglish-in-Tamil-script replies and English voice for English', () => {
    expect(sarvam.languageFor('சரி, Porur-ல 2 BHK apartment இருக்கு.')).toBe('ta-IN');
    expect(sarvam.languageFor('வணக்கம்!')).toBe('ta-IN');
    expect(sarvam.languageFor('Sure, there is a 2 BHK in Porur. Shall I book a visit?')).toBe('en-IN');
  });
  it('inbound greeting uses the caller name when known; reason never assumes a follow-up', () => {
    expect(inboundOpening('Tacksharp Realty', 'Ravi Kumar')).toContain('வணக்கம் Ravi');
    expect(inboundOpening('Tacksharp Realty')).not.toContain('undefined');
    expect(inboundCallReason({ name: null, location: null, bhk: null, propertyType: null, budget: null })).toContain('new customer called');
    expect(inboundCallReason({ name: 'Ravi', location: 'Porur', bhk: 2, propertyType: null, budget: 8_000_000 }, 'qualified')).toContain('called the business number');
  });
});

vi.restoreAllMocks();
