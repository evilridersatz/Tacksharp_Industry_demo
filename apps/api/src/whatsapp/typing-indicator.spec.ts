import { describe, expect, it, vi } from 'vitest';

process.env.DRY_RUN = 'false';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'PNID_TEST';

const { WhatsAppSenderService } = await import('./whatsapp-sender.service.js');
const { config } = await import('../common/config.js');

describe('WhatsApp read receipt + typing indicator', () => {
  it('posts status=read with a typing indicator for the customer message (no recipient_type)', async () => {
    config.whatsapp.accessToken ||= 'test-token';
    config.whatsapp.phoneNumberId ||= 'PNID_TEST';
    const s = new WhatsAppSenderService();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    s.fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await s.markReadWithTyping('wamid.IN1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/messages$/);
    expect(calls[0].body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1', typing_indicator: { type: 'text' } });
  });

  it('is blocked like every provider request in dry run', async () => {
    process.env.DRY_RUN = 'true';
    try {
      const s = new WhatsAppSenderService();
      s.fetchImpl = vi.fn() as unknown as typeof fetch;
      await expect(s.markReadWithTyping('wamid.IN2')).rejects.toThrow(/DRY_RUN/);
      expect(s.fetchImpl).not.toHaveBeenCalled();
    } finally {
      process.env.DRY_RUN = 'false';
    }
  });
});
