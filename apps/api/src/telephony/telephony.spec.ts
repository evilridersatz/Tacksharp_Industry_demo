import { afterEach, describe, expect, it, vi } from 'vitest';
import { sarvamOutboundCall } from '../integrations/provider-clients.js';
import { verifyWebhookToken, webhookToken } from './webhook-token.js';
import { SarvamTelephonyProvider, transcriptLines } from './sarvam.provider.js';

const acct = { apiKey: 'sv-agents-secret-key', orgId: 'org1', workspaceId: 'ws1', connectionId: 'conn1', agentPhoneNumber: '918000000001' };
const SECRET = 'x'.repeat(40);
const saved = process.env.TELEPHONY_WEBHOOK_SECRET;
afterEach(() => { if (saved === undefined) delete process.env.TELEPHONY_WEBHOOK_SECRET; else process.env.TELEPHONY_WEBHOOK_SECRET = saved; });

describe('Sarvam outbound request (mocked HTTP; no call is placed)', () => {
  it('uses the documented endpoint, X-API-Key, E.164 numbers and returns the attempt id', async () => {
    let call: any;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => { call = { url, headers: init?.headers, body: JSON.parse(String(init?.body)) }; return new Response(JSON.stringify({ attempt_id: 'att-1' }), { status: 200 }); });
    const r = await sarvamOutboundCall(fetchImpl, acct, { appId: 'app-9', appVersion: 2, to: '919876543210', webhookUrl: 'https://x.test/hook?t=1', variables: { customer_name: 'Arun' } });
    expect(r).toMatchObject({ ok: true, attemptId: 'att-1' });
    expect(call.url).toBe('https://apps.sarvam.ai/api/outbounds/v1/orgs/org1/workspaces/ws1/outbounds');
    expect(call.headers['X-API-Key']).toBe(acct.apiKey);
    expect(call.body).toEqual({ app_config: { app_id: 'app-9', app_version: 2, connection_config: { connection_id: 'conn1', agent_phone_number: '+918000000001' }, agent_variables: { customer_name: 'Arun' } }, user_config: { user_phone_number: '+919876543210' }, webhook_config: { url: 'https://x.test/hook?t=1' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('never retries by itself; marks only "certainly not placed" failures retryable; scrubs the key', async () => {
    const f422 = vi.fn(async () => new Response(JSON.stringify({ detail: `bad app ${acct.apiKey}` }), { status: 422 }));
    const r1 = await sarvamOutboundCall(f422, acct, { appId: 'a', appVersion: 1, to: '919876543210' });
    expect(r1).toMatchObject({ ok: false, retryable: false });
    expect(r1.message).not.toContain(acct.apiKey);
    expect(f422).toHaveBeenCalledTimes(1);
    const f429 = vi.fn(async () => new Response('{}', { status: 429 }));
    expect(await sarvamOutboundCall(f429, acct, { appId: 'a', appVersion: 1, to: '919876543210' })).toMatchObject({ ok: false, retryable: true, errorCode: 'rate_limited' });
    const f500 = vi.fn(async () => new Response('{}', { status: 502 }));
    expect(await sarvamOutboundCall(f500, acct, { appId: 'a', appVersion: 1, to: '919876543210' })).toMatchObject({ ok: false, retryable: false });
    const fTimeout = vi.fn(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
    expect(await sarvamOutboundCall(fTimeout, acct, { appId: 'a', appVersion: 1, to: '919876543210' })).toMatchObject({ ok: false, retryable: false, errorCode: 'timeout' });
  });
});

describe('telephony webhook token (Sarvam does not sign webhooks)', () => {
  it('HMAC over org and scope; wrong org / scope / token rejected; no secret = fail closed', () => {
    const t = webhookToken('orgA', 'req1', SECRET)!;
    expect(verifyWebhookToken('orgA', 'req1', t, SECRET)).toBe(true);
    expect(verifyWebhookToken('orgB', 'req1', t, SECRET)).toBe(false);
    expect(verifyWebhookToken('orgA', 'req2', t, SECRET)).toBe(false);
    expect(verifyWebhookToken('orgA', 'req1', t.slice(0, -1) + '0', SECRET)).toBe(t.endsWith('0'));
    expect(verifyWebhookToken('orgA', 'req1', undefined, SECRET)).toBe(false);
    expect(webhookToken('orgA', 'req1', 'short')).not.toBeNull();
    delete process.env.TELEPHONY_WEBHOOK_SECRET;
    expect(webhookToken('orgA', 'req1')).toBeNull();
    expect(verifyWebhookToken('orgA', 'req1', t)).toBe(false);
  });
  it('an invalid token is refused before the body is used', async () => {
    process.env.TELEPHONY_WEBHOOK_SECRET = SECRET;
    const prisma: any = { telephonyWebhookEvent: { create: vi.fn() } };
    const p = new SarvamTelephonyProvider(prisma);
    expect(await p.handleWebhook({ query: { org: 'orgA', scope: 'r1', t: 'nope' }, body: { attempt_id: 'x', status: 'connected' }, headers: {} })).toMatchObject({ accepted: false, reason: 'invalid_token' });
    expect(prisma.telephonyWebhookEvent.create).not.toHaveBeenCalled();
  });
  it('capabilities are honest about what Sarvam hosts', async () => {
    const p = new SarvamTelephonyProvider({} as any);
    const c = await p.getCapabilities('org-without-creds');
    expect(c).toMatchObject({ provider: 'sarvam', configured: false, conversation: 'provider_hosted_agent', knowledgeSource: 'provider_console', webhookAuth: 'url_hmac_token' });
    expect(c.verifiedFrom.every((u) => u.startsWith('https://docs.sarvam.ai/'))).toBe(true);
  });
});

describe('transcript parsing', () => {
  it('accepts arrays of turns or a plain string', () => {
    expect(transcriptLines([{ role: 'agent', content: 'Vanakkam' }, { speaker: 'user', text: 'broiler venum' }, { role: 'user', content: '' }])).toEqual([{ role: 'assistant', content: 'Vanakkam' }, { role: 'user', content: 'broiler venum' }]);
    expect(transcriptLines('hello')).toEqual([{ role: 'assistant', content: 'hello' }]);
    expect(transcriptLines(null)).toEqual([]);
  });
});
