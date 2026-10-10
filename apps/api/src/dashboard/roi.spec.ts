import { describe, expect, it } from 'vitest';
import { computeRoi } from './roi.js';

const t0 = new Date('2026-10-05T05:00:00Z');
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);
const lead = (id: string, extra: Partial<{ status: string; campaign: string; repliedAt: Date }> = {}) =>
  ({ id, createdAt: t0, source: 'meta_lead_ads', campaign: extra.campaign ?? 'Diwali', status: extra.status ?? 'new', repliedAt: extra.repliedAt ?? null });

describe('ROI metrics', () => {
  const data = {
    leads: [lead('a', { status: 'site_visit' }), lead('b', { status: 'qualified' }), lead('c', { repliedAt: at(600) }), lead('d', { campaign: 'Pongal' })],
    calls: [
      { leadId: 'a', createdAt: at(60), status: 'completed', direction: 'outbound', durationSec: 180 },
      { leadId: 'b', createdAt: at(90), status: 'completed', direction: 'outbound', durationSec: 120 },
      { leadId: 'c', createdAt: at(70), status: 'no_answer', direction: 'outbound', durationSec: null },
      { leadId: 'd', createdAt: at(7200), status: 'no_answer', direction: 'outbound', durationSec: null },
      { leadId: 'zzz', createdAt: at(10), status: 'completed', direction: 'outbound', durationSec: 999 }, // another period's lead: ignored
    ],
    visits: [{ leadId: 'a', status: 'completed' }, { leadId: 'b', status: 'no_show' }],
    whatsappSent: 10,
    costs: { costPerLeadInr: 400, voiceCostPerMinuteInr: 5, whatsappCostPerMessageInr: 1 },
  };
  const r = computeRoi(data);

  it('speed to first call from lead arrival', () => {
    expect(r.speedToFirstCall).toEqual({ medianSec: 70, p90Sec: 7200, within2MinPct: 75, called: 4 });
  });
  it('funnel: reached = answered a call OR replied on WhatsApp', () => {
    expect(r.funnel.map((f) => f.count)).toEqual([4, 3, 2, 2, 1]);
    expect(r.rates).toEqual({ contactPct: 75, qualifiedPct: 50, bookingPct: 66.7, showUpPct: 50 });
  });
  it('cost per attended visit = ad spend + voice minutes + WhatsApp, over visits that happened', () => {
    expect(r.usage.connectedMinutes).toBe(5);
    expect(r.costs).toMatchObject({ adSpendInr: 1600, voiceInr: 25, whatsappInr: 10, totalInr: 1635, perAttendedVisitInr: 1635, perLeadInr: 409 });
  });
  it('per campaign, biggest first', () => {
    expect(r.byCampaign.map((c) => [c.name, c.leads, c.attended])).toEqual([['Diwali', 3, 1], ['Pongal', 1, 0]]);
  });
  it('no data -> no fake numbers', () => {
    const empty = computeRoi({ leads: [], calls: [], visits: [], whatsappSent: 0, costs: data.costs });
    expect(empty.rates).toEqual({ contactPct: null, qualifiedPct: null, bookingPct: null, showUpPct: null });
    expect(empty.costs.perAttendedVisitInr).toBeNull();
    expect(empty.speedToFirstCall.medianSec).toBeNull();
    expect(empty.samples).toMatchObject({ contact: 0, booking: 0, showUp: 0, speed: 0 });
  });
  it('every rate carries its denominator so the dashboard can tell "no data" from "too few to judge"', () => {
    expect(r.samples).toEqual({ contact: 4, qualified: 4, booking: 3, showUp: 2, speed: 4, minSample: 5 });
  });
});
