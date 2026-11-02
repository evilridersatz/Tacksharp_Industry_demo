import { describe, expect, it, vi } from 'vitest';

process.env.WHATSAPP_ACCESS_TOKEN ||= 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'PNID_TEST';

const { WhatsAppSenderService, MediaRejectedError, MEDIA_RULES } = await import('./whatsapp-sender.service.js');
const { config } = await import('../common/config.js');

/** Meta media metadata + file, mocked (no network). */
function meta(info: Record<string, unknown>, bytes: Buffer) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown) => {
    calls.push(String(url));
    return String(url).includes('lookaside') ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp/media/x', ...info }), { status: 200 });
  }) as unknown as typeof fetch;
  const s = new WhatsAppSenderService();
  s.fetchImpl = fetchImpl;
  return { s, calls };
}

describe('WhatsApp media validation (voice notes / images)', () => {
  config.whatsapp.accessToken ||= 'test-token';
  config.whatsapp.phoneNumberId ||= 'PNID_TEST';

  it('accepts an Opus voice note within the limit and reports its real size', async () => {
    const { s } = meta({ mime_type: 'audio/ogg; codecs=opus', file_size: 1200 }, Buffer.alloc(1200, 1));
    await expect(s.downloadMedia('wamid-audio-1')).resolves.toMatchObject({ mimeType: 'audio/ogg', sizeBytes: 1200 });
  });

  it('refuses a wrong type BEFORE downloading the file', async () => {
    const { s, calls } = meta({ mime_type: 'application/pdf', file_size: 1000 }, Buffer.alloc(10));
    await expect(s.downloadMedia('wamid-doc')).rejects.toMatchObject({ reason: 'unsupported_type:application/pdf' });
    expect(calls).toHaveLength(1); // metadata only, the file was never fetched
  });

  it('refuses a file over the limit (declared or actual) and an empty file', async () => {
    const big = meta({ mime_type: 'audio/ogg', file_size: MEDIA_RULES.audio.maxBytes + 1 }, Buffer.alloc(1));
    await expect(big.s.downloadMedia('wamid-big')).rejects.toBeInstanceOf(MediaRejectedError);
    const lies = meta({ mime_type: 'image/jpeg', file_size: 10 }, Buffer.alloc(MEDIA_RULES.image.maxBytes + 1));
    await expect(lies.s.downloadMedia('wamid-img', 'image')).rejects.toMatchObject({ reason: 'too_large' });
    const empty = meta({ mime_type: 'audio/ogg', file_size: 0 }, Buffer.alloc(0));
    await expect(empty.s.downloadMedia('wamid-empty')).rejects.toMatchObject({ reason: 'empty' });
  });

  it('an image is not accepted as a voice note, and a malformed media id never reaches Meta', async () => {
    const { s, calls } = meta({ mime_type: 'image/png', file_size: 100 }, Buffer.alloc(100));
    await expect(s.downloadMedia('wamid-png', 'audio')).rejects.toMatchObject({ reason: 'unsupported_type:image/png' });
    const bad = meta({ mime_type: 'audio/ogg' }, Buffer.alloc(1));
    await expect(bad.s.downloadMedia('../../me?fields=x')).rejects.toMatchObject({ reason: 'invalid_media_id' });
    expect(bad.calls).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});
