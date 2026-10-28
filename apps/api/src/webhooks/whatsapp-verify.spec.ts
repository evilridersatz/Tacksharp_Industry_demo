import { describe, expect, it } from 'vitest';
import { config } from '../common/config.js';
import { WhatsAppController } from './whatsapp.controller.js';

describe('WhatsApp webhook verification (GET)', () => {
  const ctl = new WhatsAppController({} as never);
  it('echoes the challenge only for the configured verify token', () => {
    const saved = config.whatsapp.verifyToken;
    config.whatsapp.verifyToken = 'right-token';
    try {
      expect(ctl.verifyWebhook('subscribe', 'right-token', '12345')).toBe('12345');
      expect(() => ctl.verifyWebhook('subscribe', 'wrong', '12345')).toThrow(/verification failed/);
      expect(() => ctl.verifyWebhook('unsubscribe', 'right-token', '12345')).toThrow();
      config.whatsapp.verifyToken = '';
      expect(() => ctl.verifyWebhook('subscribe', '', '12345')).toThrow(); // no token configured: never verifies
    } finally {
      config.whatsapp.verifyToken = saved;
    }
  });
});
