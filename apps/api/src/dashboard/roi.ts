/**
 * Speed-to-lead and ROI metrics for one business over a period, computed from plain rows so the maths is
 * unit-tested and the controller only fetches data. "Cost per attended visit" is the number a real-estate
 * client buys this product for.
 */
export type RoiLead = { id: string; createdAt: Date; source: string | null; campaign: string | null; status: string; repliedAt: Date | null };
export type RoiCall = { leadId: string | null; createdAt: Date; status: string; direction: string; durationSec: number | null };
export type RoiVisit = { leadId: string; status: string };
export type RoiCosts = { costPerLeadInr: number; voiceCostPerMinuteInr: number; whatsappCostPerMessageInr: number };

const QUALIFIED = new Set(['qualified', 'property_interested', 'site_visit', 'won']);

export function percentileOf(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Below this many cases a percentage is noise; the dashboard says "not enough data" instead of a misleading number. */
export const MIN_SAMPLE = 5;

const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const money = (n: number) => Math.round(n);

export function computeRoi(input: { leads: RoiLead[]; calls: RoiCall[]; visits: RoiVisit[]; whatsappSent: number; costs: RoiCosts }) {
  const { leads, calls, visits, costs } = input;
  const leadIds = new Set(leads.map((l) => l.id));
  const callsByLead = new Map<string, RoiCall[]>();
  for (const c of calls) {
    if (!c.leadId || !leadIds.has(c.leadId)) continue;
    callsByLead.set(c.leadId, [...(callsByLead.get(c.leadId) ?? []), c]);
  }
  const visitsByLead = new Map<string, RoiVisit[]>();
  for (const v of visits) {
    if (!leadIds.has(v.leadId)) continue;
    visitsByLead.set(v.leadId, [...(visitsByLead.get(v.leadId) ?? []), v]);
  }

  // Speed to first call: lead arrival -> first outbound AI call (seconds).
  const firstCallSec: number[] = [];
  for (const l of leads) {
    const outbound = (callsByLead.get(l.id) ?? []).filter((c) => c.direction === 'outbound');
    if (!outbound.length) continue;
    const first = Math.min(...outbound.map((c) => c.createdAt.getTime()));
    firstCallSec.push(Math.max(0, Math.round((first - l.createdAt.getTime()) / 1000)));
  }

  const per = leads.map((l) => {
    const lc = callsByLead.get(l.id) ?? [];
    const lv = visitsByLead.get(l.id) ?? [];
    const reached = lc.some((c) => c.status === 'completed') || Boolean(l.repliedAt && l.repliedAt >= l.createdAt);
    const booked = lv.length > 0;
    return {
      lead: l,
      reached,
      qualified: QUALIFIED.has(l.status) || booked,
      booked,
      attended: lv.some((v) => v.status === 'completed'),
      noShow: lv.some((v) => v.status === 'no_show') && !lv.some((v) => v.status === 'completed'),
    };
  });
  const count = (f: (x: (typeof per)[number]) => boolean) => per.filter(f).length;
  const total = leads.length;
  const reached = count((x) => x.reached);
  const qualified = count((x) => x.qualified);
  const booked = count((x) => x.booked);
  const attended = count((x) => x.attended);
  const noShows = count((x) => x.noShow);

  const connectedMinutes = Math.round(
    calls.filter((c) => c.leadId && leadIds.has(c.leadId) && c.status === 'completed').reduce((m, c) => m + (c.durationSec ?? 0), 0) / 60,
  );
  const adSpend = total * costs.costPerLeadInr;
  const voiceCost = connectedMinutes * costs.voiceCostPerMinuteInr;
  const whatsappCost = input.whatsappSent * costs.whatsappCostPerMessageInr;
  const totalCost = adSpend + voiceCost + whatsappCost;

  const groups = new Map<string, typeof per>();
  for (const x of per) {
    const key = x.lead.campaign || x.lead.source || 'unknown';
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  const byCampaign = [...groups.entries()]
    .map(([name, xs]) => ({
      name,
      leads: xs.length,
      reached: xs.filter((x) => x.reached).length,
      booked: xs.filter((x) => x.booked).length,
      attended: xs.filter((x) => x.attended).length,
      costPerAttendedInr: xs.some((x) => x.attended) ? money((xs.length * costs.costPerLeadInr) / xs.filter((x) => x.attended).length) : null,
    }))
    .sort((a, b) => b.leads - a.leads)
    .slice(0, 20);

  return {
    leads: total,
    speedToFirstCall: {
      medianSec: percentileOf(firstCallSec, 50),
      p90Sec: percentileOf(firstCallSec, 90),
      within2MinPct: rate(firstCallSec.filter((s) => s <= 120).length, firstCallSec.length),
      called: firstCallSec.length,
    },
    rates: {
      contactPct: rate(reached, total),
      qualifiedPct: rate(qualified, total),
      bookingPct: rate(booked, reached),
      showUpPct: rate(attended, attended + noShows),
    },
    /** Denominator behind each rate: null rate with 0 = nothing to measure yet; a small n = indicative only. */
    samples: {
      contact: total,
      qualified: total,
      booking: reached,
      showUp: attended + noShows,
      speed: firstCallSec.length,
      minSample: MIN_SAMPLE,
    },
    funnel: [
      { stage: 'Leads', count: total },
      { stage: 'Reached', count: reached },
      { stage: 'Qualified', count: qualified },
      { stage: 'Visit booked', count: booked },
      { stage: 'Visited', count: attended },
    ],
    costs: {
      adSpendInr: money(adSpend),
      voiceInr: money(voiceCost),
      whatsappInr: money(whatsappCost),
      totalInr: money(totalCost),
      perLeadInr: total ? money(totalCost / total) : null,
      perAttendedVisitInr: attended ? money(totalCost / attended) : null,
      inputs: costs,
    },
    usage: { connectedMinutes, whatsappSent: input.whatsappSent, calls: calls.filter((c) => c.leadId && leadIds.has(c.leadId)).length },
    byCampaign,
  };
}
