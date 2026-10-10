import { describe, expect, it, vi } from 'vitest';
import { shapeChatReply, sequenceMessage } from './message-templates.js';
import { config } from '../common/config.js';
import { WhatsAppSenderService, WhatsAppWindowClosedError } from './whatsapp-sender.service.js';

describe('WhatsApp reply shaping', () => {
  it('keeps at most 3 short lines and removes markdown', () => {
    const long = '**Great!** Here are options:\n\n- Green Valley - Porur - 72 lakhs\n- Lake View - Porur - 95 lakhs\n- Sunrise - OMR - 68 lakhs\n# Which one?';
    const out = shapeChatReply(long);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).not.toMatch(/[*#`]|^-/m);
  });
  it('bounds the length without cutting a word in half', () => {
    const out = shapeChatReply('word '.repeat(300));
    expect(out.length).toBeLessThanOrEqual(480);
    expect(out.endsWith('word')).toBe(true);
  });
  it('follow-up texts are short single messages', () => {
    for (const step of ['first_contact', 'reminder', 'final', 'other']) {
      const text = sequenceMessage(step, { name: 'Ravi Kumar', location: 'Porur', bhk: 2, propertyType: null, budget: 8_000_000 } as never, 'Tacksharp Realty');
      expect(text.length).toBeLessThan(260);
      expect(text).not.toContain('\n');
    }
  });
});

describe('per-step WhatsApp templates', () => {
  const sender = new WhatsAppSenderService();
  it('each step uses its own approved template and falls back to the shared one', () => {
    const before = { ...config.whatsapp.stepTemplates };
    const shared = config.whatsapp.templateName;
    try {
      config.whatsapp.stepTemplates.first_contact = 'tpl_first';
      config.whatsapp.stepTemplates.reminder = '';
      (config.whatsapp as { templateName: string }).templateName = 'tpl_shared';
      expect(sender.templateFor('first_contact')).toBe('tpl_first');
      expect(sender.templateFor('reminder')).toBe('tpl_shared');
      expect(sender.templateFor(undefined)).toBe('tpl_shared');
    } finally {
      Object.assign(config.whatsapp.stepTemplates, before);
      (config.whatsapp as { templateName: string }).templateName = shared;
    }
  });
  it('a closed 24h window with no template configured is a clean refusal, never a free-text send', async () => {
    const before = { ...config.whatsapp.stepTemplates };
    const shared = config.whatsapp.templateName;
    try {
      Object.assign(config.whatsapp.stepTemplates, { first_contact: '', reminder: '', final: '' });
      (config.whatsapp as { templateName: string }).templateName = '';
      const send = vi.spyOn(sender, 'sendText').mockResolvedValue('x' as never);
      await expect(sender.sendWithinPolicy({ to: '919000000000', windowOpen: false, text: 'hi', templateParams: [], step: 'final' })).rejects.toBeInstanceOf(WhatsAppWindowClosedError);
      expect(send).not.toHaveBeenCalled();
    } finally {
      Object.assign(config.whatsapp.stepTemplates, before);
      (config.whatsapp as { templateName: string }).templateName = shared;
    }
  });
});
