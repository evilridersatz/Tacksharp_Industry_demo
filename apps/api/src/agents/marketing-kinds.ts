import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MarketingService } from '../marketing/marketing.service.js';
import { CONTENT_CHANNELS, MARKETING_PERMISSIONS, OCCASIONS } from '../marketing/marketing.service.js';
import type { TaskKind } from './agent-types.js';

type Deps = { prisma: PrismaService; marketing: MarketingService };

const obj = (raw: unknown) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const id = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !/^[\w-]{6,64}$/.test(v)) throw new BadRequestException(`${name} is required`);
  return v;
};
const optId = (v: unknown) => (typeof v === 'string' && /^[\w-]{6,64}$/.test(v) ? v : undefined);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const OCCASION_LABEL: Record<string, string> = {
  diwali: 'Diwali', pongal: 'Pongal', wedding: 'Wedding season', new_arrivals: 'New arrivals', clearance: 'Clearance sale', aadi_sale: 'Aadi sale', other: 'Special offer',
};

type Product = { id: string; name: string; fabricCategory: string; colour: string | null; composition: string | null; price: unknown; priceApproved: boolean; priceUnit: string; stockStatus: string; imageUrls: unknown };

/** One product line for a draft: a price is only shown when it is approved on the catalogue. */
export function productPitch(p: Product): string {
  const bits = [p.name, p.colour, p.composition].filter(Boolean).join(', ');
  const price = p.priceApproved && p.price !== null && p.price !== undefined ? ` - ₹${Number(p.price)}/${p.priceUnit}` : '';
  return `${bits}${price}`;
}
const firstImage = (v: unknown) => (Array.isArray(v) ? v.map(String).find((u) => /^https:\/\//.test(u)) ?? null : null);

/**
 * Marketing agent tasks. The agent drafts (briefs, campaign drafts, content calendars) and reports; it never sends.
 * Sending a campaign is a request that waits for a person with marketing.approve_campaign, and is bound to the exact
 * content that was approved.
 */
export function buildMarketingKinds({ prisma, marketing }: Deps): TaskKind[] {
  const pickProducts = async (organizationId: string, productIds?: string[]) =>
    prisma.textileProduct.findMany({
      where: { organizationId, active: true, ...(productIds?.length ? { id: { in: productIds } } : { stockStatus: { in: ['in_stock', 'low'] } }) },
      orderBy: [{ stockStatus: 'asc' }, { updatedAt: 'desc' }],
      take: productIds?.length ? 10 : 3,
      select: { id: true, name: true, fabricCategory: true, colour: true, composition: true, price: true, priceApproved: true, priceUnit: true, stockStatus: true, imageUrls: true },
    });

  const campaignBrief: TaskKind<{ occasion: string; segmentId?: string; productIds?: string[]; offer: string; name: string }> = {
    kind: 'marketing.campaign_brief',
    agent: 'marketing',
    label: 'Draft a campaign',
    description: 'Writes a campaign brief and a WhatsApp draft from the catalogue (approved prices only) for a segment. A person picks the approved template, reviews and asks for approval.',
    userRunnable: true,
    parse: (raw) => {
      const r = obj(raw);
      const occasion = (OCCASIONS as readonly string[]).includes(String(r.occasion)) ? String(r.occasion) : 'new_arrivals';
      const productIds = Array.isArray(r.productIds) ? r.productIds.map(optId).filter((x): x is string => !!x).slice(0, 10) : undefined;
      return { occasion, segmentId: optId(r.segmentId), productIds, offer: text(r.offer, 200), name: text(r.name, 120) };
    },
    async run(ctx, input) {
      const products = await ctx.tool('catalogue.read', () => pickProducts(ctx.organizationId, input.productIds));
      const segment = input.segmentId ? await ctx.tool('segments.read', () => prisma.marketingSegment.findFirst({ where: { id: input.segmentId, organizationId: ctx.organizationId } })) : null;
      if (input.segmentId && !segment) throw new BadRequestException('Segment not found');
      const label = OCCASION_LABEL[input.occasion];
      const lines = products.map(productPitch);
      const unpriced = products.filter((p) => !p.priceApproved).length;
      const name = input.name || `${label} - ${new Date().toISOString().slice(0, 10)}`;
      // Template variables a typical marketing template takes: {{1}} customer name, {{2}} the highlight, {{3}} the offer.
      const highlight = lines.length ? lines.join('; ').slice(0, 450) : `our ${label.toLowerCase()} collection`;
      const brief = {
        occasion: input.occasion, offer: input.offer || null, productIds: products.map((p) => p.id), products: lines,
        message: `Vanakkam {{name}}! ${label} at {{shop}}: ${highlight}.${input.offer ? ` ${input.offer}.` : ''} Reply to this message to see photos or ask for a quotation.`,
        callToAction: 'Reply on WhatsApp for photos / quotation',
        draftedBy: 'marketing agent (catalogue template, no AI model call)',
        notes: [unpriced ? `${unpriced} product(s) have no approved price, so no price is mentioned for them.` : null, 'Choose an APPROVED WhatsApp template and map its variables before asking for approval.'].filter(Boolean),
      };
      const draft = await ctx.tool('campaigns.write', () =>
        marketing.createCampaign(ctx.organizationId, {
          name, occasion: input.occasion, objective: `${label}: replies, enquiries and quotations`, segmentId: segment?.id ?? null, brief,
          templateParams: ['{{name}}', highlight, input.offer || label], headerImageUrl: products.map((p) => firstImage(p.imageUrls)).find(Boolean) ?? null,
        }, ctx.actor, { taskId: ctx.taskId }), `Draft campaign "${name}"`);
      return {
        status: 'completed',
        summary: `Draft campaign "${name}" with ${products.length} product(s)${segment ? ` for segment ${segment.name}` : ' (choose a segment)'} - needs an approved template and approval before anything is sent`,
        result: { campaignId: draft.id, name, products: lines, segment: segment?.name ?? null, status: draft.status, brief },
      };
    },
  };

  const contentPlan: TaskKind<{ days: number; channels: string[]; occasion: string; startDate: string; language: string }> = {
    kind: 'marketing.content_plan',
    agent: 'marketing',
    label: 'Plan content calendar',
    description: 'Drafts posts, captions and Reels scripts for the coming days from APPROVED catalogue facts (AI when configured, otherwise templates). Drafts only: a person edits, approves, posts and marks them published.',
    userRunnable: true,
    timeoutMs: 300_000,
    maxAttempts: 1,
    parse: (raw) => {
      const r = obj(raw);
      const channels = (Array.isArray(r.channels) ? r.channels.map(String) : ['whatsapp_status', 'instagram']).filter((c) => (CONTENT_CHANNELS as readonly string[]).includes(c)).slice(0, 4);
      const start = typeof r.startDate === 'string' && !Number.isNaN(new Date(r.startDate).getTime()) ? new Date(r.startDate) : new Date(Date.now() + 86_400_000);
      return {
        days: Math.min(31, Math.max(3, Math.round(Number(r.days) || 14))), channels: channels.length ? channels : ['whatsapp_status'],
        occasion: (OCCASIONS as readonly string[]).includes(String(r.occasion)) ? String(r.occasion) : 'new_arrivals', startDate: start.toISOString().slice(0, 10),
        language: ['english', 'tamil', 'tanglish'].includes(String(r.language)) ? String(r.language) : 'english',
      };
    },
    async run(ctx, input) {
      const products = await ctx.tool('catalogue.read', () =>
        prisma.textileProduct.findMany({ where: { organizationId: ctx.organizationId, active: true, stockStatus: { not: 'out_of_stock' } }, orderBy: { updatedAt: 'desc' }, take: 12, select: { id: true } }));
      const label = OCCASION_LABEL[input.occasion];
      const start = new Date(`${input.startDate}T10:00:00`);
      const created: Array<{ id: string; title: string; channel: string; plannedFor: string; source: string }> = [];
      const sources: Record<string, number> = {};
      let n = 0;
      for (let d = 0; d < input.days && created.length < 16; d += 2) {
        for (const channel of input.channels) {
          const product = products.length ? products[n % products.length] : undefined;
          const kind = channel === 'whatsapp_broadcast' ? 'broadcast' : channel === 'instagram' && n % 3 === 2 ? 'reel_script' : 'caption';
          const r = await ctx.tool('content.write', () =>
            marketing.aiDraft(ctx.organizationId, { kind, language: input.language, productIds: product ? [product.id] : [], occasion: label, channel, plannedFor: new Date(start.getTime() + d * 86_400_000).toISOString() }, ctx.actor),
            `Draft ${kind} (${channel})`);
          created.push({ id: r.item.id, title: r.item.title, channel: r.item.channel, plannedFor: r.item.plannedFor, source: r.source });
          sources[r.source] = (sources[r.source] ?? 0) + 1;
          n++;
        }
      }
      return {
        status: 'completed',
        summary: `${created.length} draft post(s) for ${input.days} days on ${input.channels.join(', ')} (${Object.entries(sources).map(([k, v]) => `${v} ${k}`).join(', ')}) - review and approve them in Marketing → Content calendar`,
        result: { created, sources, note: 'AI drafts use only approved catalogue facts; unsupported claims are removed. Nothing is posted automatically: no social account is connected.' },
      };
    },
  };

  const requestSend: TaskKind<{ campaignId: string }> = {
    kind: 'marketing.request_campaign_send',
    agent: 'marketing',
    label: 'Request campaign send',
    description: 'Checks a draft campaign (template, segment, consent, estimate) and asks for approval to send it. Sends only after approval, and only the approved content.',
    userRunnable: true,
    parse: (raw) => ({ campaignId: id(obj(raw).campaignId, 'campaignId') }),
    entity: (i) => ({ type: 'campaign', id: i.campaignId }),
    timeoutMs: 120_000,
    maxAttempts: 1,
    async run(ctx, { campaignId }) {
      if (!ctx.approved) {
        const p = await ctx.tool('campaigns.read', () => marketing.prepareAgentSend(ctx.organizationId, campaignId, ctx.taskId), 'Check the campaign and estimate the audience');
        return {
          status: 'needs_approval',
          action: 'marketing.campaign_send',
          reason: `Send "${p.name}" to ${p.estimate.eligible} customer(s) with marketing consent (${p.estimate.mode})${p.estimate.estimatedCost !== null ? `, about ₹${p.estimate.estimatedCost}` : ''}.`,
          payload: { campaignId, hash: p.hash, expectedRecipients: p.estimate.eligible, estimatedCost: p.estimate.estimatedCost, preview: p.preview },
          requiredPermission: MARKETING_PERMISSIONS.approveCampaign,
          entity: { type: 'campaign', id: campaignId },
        };
      }
      const c = await ctx.tool('campaigns.read', () => prisma.marketingCampaign.findFirst({ where: { id: campaignId, organizationId: ctx.organizationId }, select: { approvedHash: true } }));
      if (!c?.approvedHash) throw new BadRequestException('The campaign is no longer waiting for approval');
      const approvalId = (await prisma.agentTask.findUnique({ where: { id: ctx.taskId }, select: { approvalId: true } }))?.approvalId ?? null;
      const r = await ctx.tool('campaigns.send', () => marketing.launch(ctx.organizationId, campaignId, { hash: c.approvedHash!, approvalId }), 'Start the approved campaign');
      return {
        status: 'completed',
        summary: `Campaign started: ${r.recipients} recipient(s)${r.simulated ? ' - DRY_RUN, all simulated (nothing sent)' : ''}`,
        result: r,
      };
    },
  };

  const campaignReport: TaskKind<{ campaignId: string }> = {
    kind: 'marketing.campaign_report',
    agent: 'marketing',
    label: 'Campaign report',
    description: 'Delivery, replies and the enquiries, quotations and orders that followed a campaign. Order value is recorded, not verified revenue; no ad spend.',
    userRunnable: true,
    parse: (raw) => ({ campaignId: id(obj(raw).campaignId, 'campaignId') }),
    entity: (i) => ({ type: 'campaign', id: i.campaignId }),
    async run(ctx, { campaignId }) {
      const r = await ctx.tool('campaigns.read', () => marketing.report(ctx.organizationId, campaignId), 'Campaign recipients and the leads / quotations / orders credited to them');
      return {
        status: 'completed',
        summary: `${r.name}: ${r.sent} sent, ${r.delivered} delivered, ${r.replied} replied, ${r.leads} lead(s), ${r.quotations} quotation(s), ${r.orders} order(s)${r.simulated ? ' (simulated campaign)' : ''}`,
        result: r as unknown as Record<string, unknown>,
      };
    },
  };

  return [campaignBrief, contentPlan, requestSend, campaignReport] as unknown as TaskKind[];
}
