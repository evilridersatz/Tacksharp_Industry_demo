import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, effectiveCallWindow, isHotLead, nextRetryAt, sanitizeSettings, timelineDays } from './tenant-settings.js';
import { teamAlert, visitMessage, visitTimeLabel } from '../automation/automation-messages.js';
import { sequenceMessage } from '../whatsapp/message-templates.js';
import { speedToLeadSequence, visitIdOf } from '../follow-ups/follow-up-plan.js';

const ist = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000);
const istHourOf = (d: Date) => Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(d)) % 24;

describe('tenant settings: validation', () => {
  it('defaults are the speed-to-lead product defaults', () => {
    expect(DEFAULT_SETTINGS.speedToLead).toEqual({ instantCall: true, callDelayMinutes: 1 });
    expect(DEFAULT_SETTINGS.calling.maxAttempts).toBe(3);
    expect(DEFAULT_SETTINGS.nurture.followUpDays).toEqual([3, 7]);
  });
  it('merges a partial update over the current settings and drops unknown keys', () => {
    const s = sanitizeSettings({ speedToLead: { callDelayMinutes: 5 }, hacker: { x: 1 } } as never, DEFAULT_SETTINGS);
    expect(s.speedToLead).toEqual({ instantCall: true, callDelayMinutes: 5 });
    expect((s as never as Record<string, unknown>).hacker).toBeUndefined();
    expect(s.calling).toEqual(DEFAULT_SETTINGS.calling);
  });
  it('clamps numbers and refuses an inverted calling window', () => {
    const s = sanitizeSettings({ calling: { maxAttempts: 99, windowStartHour: 22, windowEndHour: 8 }, speedToLead: { callDelayMinutes: -4 } });
    expect(s.calling.maxAttempts).toBe(6);
    expect([s.calling.windowStartHour, s.calling.windowEndHour]).toEqual([9, 20]);
    expect(s.speedToLead.callDelayMinutes).toBe(0);
  });
  it('normalises team phones, drops junk, and only keeps http(s) map links', () => {
    const s = sanitizeSettings({
      team: { alertPhones: ['+91 98840 12345', '98840 12345', 'abc', ''] },
      visits: { sites: { prop_a: { address: ' 12 Main Rd, Porur ', mapUrl: 'javascript:alert(1)' }, prop_b: { mapUrl: 'https://maps.google.com/?q=13,80' }, 'bad id!': { address: 'x' } } },
    });
    expect(s.team.alertPhones).toEqual(['919884012345']);
    expect(s.visits.sites).toEqual({ prop_a: { address: '12 Main Rd, Porur' }, prop_b: { mapUrl: 'https://maps.google.com/?q=13,80' } });
  });
  it('a template name must be a plain Meta template id', () => {
    expect(sanitizeSettings({ team: { alertTemplate: 'site_visit_alert' } }).team.alertTemplate).toBe('site_visit_alert');
    expect(sanitizeSettings({ team: { alertTemplate: 'x"; drop' } }).team.alertTemplate).toBe('');
  });
});

describe('tenant settings: calling rules', () => {
  it('a stored window never exceeds the legal window, so the Settings page shows what really applies', () => {
    const s = sanitizeSettings({ calling: { windowStartHour: 0, windowEndHour: 24 } });
    expect(s.calling.windowStartHour).toBeGreaterThanOrEqual(9);
    expect(s.calling.windowEndHour).toBeLessThanOrEqual(21);
  });
  it('a business window can only narrow the deployment window', () => {
    expect(effectiveCallWindow(sanitizeSettings({ calling: { windowStartHour: 10, windowEndHour: 19 } }))).toEqual({ start: 10, end: 19 });
    const wide = effectiveCallWindow(sanitizeSettings({ calling: { windowStartHour: 0, windowEndHour: 24 } }));
    expect(wide.start).toBeGreaterThanOrEqual(9);
    expect(wide.end).toBeLessThanOrEqual(21);
  });
  it('retry cadence: +30 min after the first miss, next day 11:00 IST after the second, none after the last', () => {
    const now = ist(2026, 10, 9, 12, 0);
    expect(nextRetryAt(1, now, DEFAULT_SETTINGS)!.getTime() - now.getTime()).toBe(30 * 60_000);
    const second = nextRetryAt(2, now, DEFAULT_SETTINGS)!;
    expect(second.toISOString()).toBe(ist(2026, 10, 10, 11, 0).toISOString());
    expect(nextRetryAt(3, now, DEFAULT_SETTINGS)).toBeUndefined();
  });
  it('a retry that would land after hours moves into the next morning window', () => {
    const late = ist(2026, 10, 9, 19, 50);
    expect(istHourOf(nextRetryAt(1, late, DEFAULT_SETTINGS)!)).toBe(9);
  });
  it('speed-to-lead sequence: WhatsApp now, call after the delay, then nurture days', () => {
    expect(speedToLeadSequence(DEFAULT_SETTINGS).map((x) => `${x.channel}:${x.step}@${x.afterMinutes}`)).toEqual([
      'whatsapp:first_contact@0', 'voice:call@1', 'whatsapp:nurture_day3@4320', 'whatsapp:nurture_day7@10080',
    ]);
  });
});

describe('hot leads', () => {
  it('reads the customer timeline into days, and unknown is never hot', () => {
    expect(timelineDays('immediately')).toBe(7);
    expect(timelineDays('within 3 months')).toBe(90);
    expect(timelineDays('2 weeks')).toBe(14);
    expect(timelineDays('this month')).toBe(30);
    expect(timelineDays('someday')).toBeUndefined();
    expect(timelineDays(null)).toBeUndefined();
  });
  it('hot = buying within the limit AND a matching property was shown', () => {
    expect(isHotLead(DEFAULT_SETTINGS, { timeline: 'immediately', matchingPropertyShown: true })).toBe(true);
    expect(isHotLead(DEFAULT_SETTINGS, { timeline: 'immediately', matchingPropertyShown: false })).toBe(false);
    expect(isHotLead(DEFAULT_SETTINGS, { timeline: 'within 3 months', matchingPropertyShown: true })).toBe(false);
    expect(isHotLead(sanitizeSettings({ hotLead: { enabled: false } }), { timeline: 'immediately', matchingPropertyShown: true })).toBe(false);
  });
});

describe('automation messages', () => {
  const at = ist(2026, 10, 10, 11, 0);
  it('visit time reads like a person writes it', () => {
    expect(visitTimeLabel(at)).toBe('Sat 10 Oct, 11:00 AM');
  });
  it('the day-before message asks for one explicit reply', () => {
    const t = visitMessage('confirm', { customerName: 'Ravi Kumar', propertyName: 'Green Valley Residency', scheduledAt: at });
    expect(t).toContain('Hi Ravi');
    expect(t).toContain('Green Valley Residency');
    expect(t).toContain('"YES"');
  });
  it('the reminder carries the address and map link only when the business set them', () => {
    const withSite = visitMessage('reminder', { customerName: null, propertyName: 'Green Valley', scheduledAt: at, address: '12 Main Rd', mapUrl: 'https://maps.example/x' });
    expect(withSite).toContain('Address: 12 Main Rd');
    expect(withSite).toContain('Location: https://maps.example/x');
    expect(visitMessage('reminder', { customerName: null, propertyName: 'Green Valley', scheduledAt: at })).not.toContain('Address');
  });
  it('team alert has what the salesperson needs, and a one-line form for the approved template', () => {
    const a = teamAlert({ kind: 'booked', customerName: 'Ravi', phone: '919000033333', propertyName: 'Green Valley Residency', propertyArea: 'Porur', scheduledAt: at, location: 'Porur', bhk: 2, budget: 8_000_000, timeline: 'immediately', bookedVia: 'AI call', campaign: 'Diwali' });
    expect(a.text.split('\n')[0]).toBe('New site visit booked by Tacksharp AI');
    expect(a.text).toContain('+919000033333');
    expect(a.text).toContain('Green Valley Residency (Porur), Sat 10 Oct, 11:00 AM');
    expect(a.text).toContain('2 BHK');
    expect(a.oneLine).not.toContain('\n');
  });
  it('first WhatsApp says the call is coming now, or in the morning after hours', () => {
    expect(sequenceMessage('first_contact', { name: 'Ravi', location: 'Porur', bhk: 2, propertyType: null, budget: null } as never, 'Org', { callingNow: true })).toContain('oru nimishathula');
    expect(sequenceMessage('first_contact', { name: 'Ravi', location: 'Porur', bhk: 2, propertyType: null, budget: null } as never, 'Org', { callingMorning: true })).toContain('Kaalaila');
    expect(sequenceMessage('missed_call', null, 'Org')).toContain('connect aagala');
  });
  it('follow-up messages name the visit they belong to', () => {
    expect(visitIdOf('visit:reminder:abc-123')).toBe('abc-123');
    expect(visitIdOf('alert:booked:abc-123')).toBe('abc-123');
    expect(visitIdOf('alert:hot:lead1')).toBeUndefined();
    expect(visitIdOf('first_contact')).toBeUndefined();
  });
});

describe('settings API access', () => {
  it('only an admin can change settings; the organization comes from the session', async () => {
    const { SettingsController } = await import('./settings.controller.js');
    const calls: string[] = [];
    const service = { get: async () => DEFAULT_SETTINGS, update: async (org: string) => { calls.push(org); return DEFAULT_SETTINGS; } };
    const ctrl = new SettingsController(service as never);
    await expect(ctrl.update('org_a', { sub: 'u1', org: 'org_a', role: 'agent', exp: 0 }, {})).rejects.toThrow(/admin/);
    await ctrl.update('org_a', { sub: 'u1', org: 'org_a', role: 'admin', exp: 0 }, { organizationId: 'org_b' });
    expect(calls).toEqual(['org_a']);
  });
});

describe('repeat detection', () => {
  it('same question with a different opener is a repeat; different content with the same closing question is not', async () => {
    const { similarReply } = await import('../ai/conversation-engine.service.js');
    expect(similarReply('Okay. What is your budget range?', 'Got it. What is your budget range?')).toBe(true);
    expect(similarReply('Which day and time suit you?', 'Which day and time suit you?')).toBe(true);
    expect(similarReply('Porur: Green Valley Residency, 72 lakhs. Site visit?', 'Guduvanchery: Green Acres Plots, 35 lakhs. Site visit?')).toBe(false);
    expect(similarReply('What is your budget range?', 'Which area are you looking in?')).toBe(false);
  });
});
