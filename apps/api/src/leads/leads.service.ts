import { Injectable } from '@nestjs/common';
import { retryTransient } from '../common/retry.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizePhone } from '../common/phone.js';
import {
  normalizeLocation,
  normalizePropertyType,
  parseBhk,
  parseIndianBudget,
} from '../common/parsers.js';

export const LEAD_STATUSES = {
  NEW: 'new',
  CONTACTED: 'contacted',
  QUALIFIED: 'qualified',
  PROPERTY_INTERESTED: 'property_interested',
  SITE_VISIT: 'site_visit',
  CALLBACK: 'callback',
  HUMAN_HANDOFF: 'human_handoff',
  NOT_INTERESTED: 'not_interested',
  WON: 'won',
  LOST: 'lost',
  // Textile pipeline (industry = textile)
  CATALOGUE_SHARED: 'catalogue_shared',
  QUOTATION_REQUESTED: 'quotation_requested',
  QUOTATION_SENT: 'quotation_sent',
  NEGOTIATION: 'negotiation',
  ORDER_CONFIRMED: 'order_confirmed',
  REPEAT_CUSTOMER: 'repeat_customer',
} as const;

export type LeadStatus = (typeof LEAD_STATUSES)[keyof typeof LEAD_STATUSES];

/** Forward-only funnel. Side statuses (callback, handoff, not_interested) are set explicitly. */
const FUNNEL: LeadStatus[] = ['new', 'contacted', 'qualified', 'property_interested', 'site_visit', 'won'];
const CLOSED: LeadStatus[] = ['won', 'lost', 'not_interested'];

/** Textile: New -> Contacted -> Qualified -> Catalogue shared -> Quotation requested -> Quotation sent -> Negotiation ->
 *  Order confirmed -> Repeat customer. Forward-only too; real-estate leads never use these stages. */
const TEXTILE_FUNNEL: LeadStatus[] = ['new', 'contacted', 'qualified', 'catalogue_shared', 'quotation_requested', 'quotation_sent', 'negotiation', 'order_confirmed', 'repeat_customer'];

function rank(status: string) {
  const r = FUNNEL.indexOf(status as LeadStatus);
  return r >= 0 ? r : TEXTILE_FUNNEL.indexOf(status as LeadStatus);
}

export function nextLeadStatus(current: string, next: LeadStatus): string {
  if (current === 'won' || current === 'lost') return current;
  // Both on the textile funnel: forward only, by textile order.
  const tc = TEXTILE_FUNNEL.indexOf(current as LeadStatus), tn = TEXTILE_FUNNEL.indexOf(next);
  if (tc >= 0 && tn >= 0 && !(FUNNEL.includes(current as LeadStatus) && FUNNEL.includes(next))) return tn > tc ? next : current;
  const nextIsFunnel = rank(next) >= 0;
  const currentIsFunnel = rank(current) >= 0;

  if (nextIsFunnel && currentIsFunnel) {
    return rank(next) > rank(current) ? next : current;
  }
  if (nextIsFunnel) {
    // Customer re-engaged after callback / handoff / not interested
    return rank(next) >= rank('qualified') ? next : current;
  }
  if (current === 'site_visit' && next === 'callback') return current;
  return next;
}

export type UpsertLeadInput = {
  organizationId: string;
  name?: string;
  phone?: string;
  email?: string;
  language?: string;
  source?: string;
  campaign?: string;
  externalRef?: string;
  budget?: number | string;
  location?: string;
  bhk?: number | string;
  propertyType?: string;
  notes?: string;
};

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create or update a customer + their active lead.
   * - Phone is normalized (one customer per person across Meta / WhatsApp / Plivo).
   * - Budget / BHK / type / location are normalized deterministically.
   * - `source` is only written when the record is first created, so later
   *   WhatsApp / voice activity never overwrites campaign attribution.
   */
  async createLead(params: UpsertLeadInput) {
    const { organizationId } = params;
    const phone = normalizePhone(params.phone);
    const budget = parseIndianBudget(params.budget);
    const bhk = parseBhk(params.bhk);
    const propertyType = normalizePropertyType(params.propertyType);
    const location = normalizeLocation(params.location);

    const requirements = {
      ...(budget !== undefined ? { budget } : {}),
      ...(bhk !== undefined ? { bhk } : {}),
      ...(propertyType !== undefined ? { propertyType } : {}),
      ...(location !== undefined ? { location } : {}),
    };

    let customer = phone
      ? await this.prisma.customer.findFirst({ where: { organizationId, phone } })
      : params.email
        ? await this.prisma.customer.findFirst({ where: { organizationId, email: params.email } })
        : null;

    if (customer) {
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          ...(params.name ? { name: params.name } : {}),
          ...(params.email ? { email: params.email } : {}),
          ...(params.language ? { language: params.language } : {}),
          ...(!customer.source && params.source ? { source: params.source } : {}),
          ...requirements,
        },
      });
    } else {
      customer = await this.prisma.customer.create({
        data: {
          organizationId,
          phone,
          name: params.name,
          email: params.email,
          language: params.language,
          source: params.source,
          ...requirements,
        },
      });
    }

    const existingLead = await this.findActiveLead(organizationId, customer.id);

    if (existingLead) {
      const lead = await this.prisma.lead.update({
        where: { id: existingLead.id },
        data: {
          ...requirements,
          ...(params.notes ? { notes: params.notes } : {}),
          ...(!existingLead.externalRef && params.externalRef ? { externalRef: params.externalRef } : {}),
          ...(!existingLead.campaign && params.campaign ? { campaign: params.campaign } : {}),
        },
        include: { customer: true },
      });
      return { ...lead, created: false };
    }

    const lead = await this.prisma.lead.create({
      data: {
        organizationId,
        customerId: customer.id,
        status: LEAD_STATUSES.NEW,
        source: params.source,
        campaign: params.campaign,
        externalRef: params.externalRef,
        notes: params.notes,
        ...requirements,
      },
      include: { customer: true },
    });
    return { ...lead, created: true };
  }

  findActiveLead(organizationId: string, customerId: string) {
    return this.prisma.lead.findFirst({
      where: { organizationId, customerId, status: { notIn: CLOSED } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Returns the active lead, creating a minimal one (without touching source) if none exists. */
  async ensureActiveLead(organizationId: string, customerId: string, source?: string) {
    const existing = await this.findActiveLead(organizationId, customerId);
    if (existing) return existing;
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    return this.prisma.lead.create({
      data: {
        organizationId,
        customerId,
        status: LEAD_STATUSES.NEW,
        source: customer?.source ?? source,
        location: customer?.location,
        budget: customer?.budget,
        bhk: customer?.bhk,
        propertyType: customer?.propertyType,
      },
    });
  }

  /** Copy the customer's latest requirements onto their active lead. */
  async syncLeadFromCustomer(organizationId: string, customerId: string) {
    const [customer, lead] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: customerId } }),
      this.findActiveLead(organizationId, customerId),
    ]);
    if (!customer || !lead) return null;
    return this.prisma.lead.update({
      where: { id: lead.id },
      data: {
        location: customer.location,
        budget: customer.budget,
        bhk: customer.bhk,
        propertyType: customer.propertyType,
      },
    });
  }

  async getLeads(organizationId: string) {
    return this.prisma.lead.findMany({
      where: { organizationId },
      include: { customer: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  /** Explicit status change (dashboard / human). No funnel rules applied. */
  async updateLeadStatus(params: { organizationId: string; leadId: string; status: LeadStatus }) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: params.leadId, organizationId: params.organizationId },
    });
    if (!lead) return null;
    return this.prisma.lead.update({
      where: { id: lead.id },
      data: { status: params.status },
      include: { customer: true },
    });
  }

  /**
   * Automation status change: applies forward-only funnel rules.
   * Compare-and-swap: the write only applies if the status is still the one the decision was based on, so two
   * concurrent writers (the AI turn qualifying a lead while the WhatsApp worker marks it contacted) can never
   * overwrite a newer status with a stale one. On a lost race the lead is read again and the rule re-applied.
   */
  async advanceLeadStatus(params: { organizationId: string; leadId: string; status: LeadStatus }) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: params.leadId, organizationId: params.organizationId },
      });
      if (!lead) return null;
      const status = nextLeadStatus(lead.status, params.status);
      if (status === lead.status) return lead;
      const swapped = await retryTransient(
        () => this.prisma.lead.updateMany({ where: { id: lead.id, organizationId: params.organizationId, status: lead.status }, data: { status } }),
        'lead.advance',
      );
      if (swapped.count === 1) return { ...lead, status };
    }
    return this.prisma.lead.findFirst({ where: { id: params.leadId, organizationId: params.organizationId } });
  }

  async advanceLeadStatusByCustomer(params: { organizationId: string; customerId: string; status: LeadStatus }) {
    const lead = await this.ensureActiveLead(params.organizationId, params.customerId);
    return this.advanceLeadStatus({ organizationId: params.organizationId, leadId: lead.id, status: params.status });
  }

  /** Everything about one lead for the CRM detail page: profile, journey, conversations, calls, visits, tasks. */
  async getLeadDetail(organizationId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, organizationId },
      include: { customer: true },
    });
    if (!lead) return null;
    const customerId = lead.customerId;
    const [followUps, calls, siteVisits, conversations, otherLeads] = await Promise.all([
      this.prisma.followUp.findMany({ where: { customerId }, orderBy: { scheduledAt: 'asc' } }),
      this.prisma.call.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.siteVisit.findMany({ where: { customerId }, orderBy: { scheduledAt: 'asc' }, include: { Property: true } }),
      this.prisma.conversation.findMany({
        where: { customerId },
        include: { Message: { orderBy: { createdAt: 'asc' }, take: 300 } },
      }),
      this.prisma.lead.findMany({
        where: { customerId, id: { not: leadId } },
        select: { id: true, status: true, createdAt: true, source: true },
      }),
    ]);
    return {
      lead,
      followUps,
      calls,
      siteVisits,
      conversations: conversations.map(({ Message, ...c }) => ({ ...c, messages: Message })),
      otherLeads,
    };
  }
}
