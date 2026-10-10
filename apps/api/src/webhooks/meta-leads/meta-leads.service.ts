import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LeadsService } from '../../leads/leads.service.js';
import { FollowUpsService } from '../../follow-ups/follow-ups.service.js';
import { config } from '../../common/config.js';
import { TenancyService } from '../../tenancy/tenancy.service.js';
import { errorMessage, log } from '../../common/logger.js';

type MetaLead = {
  id: string;
  created_time?: string;
  campaign_name?: string;
  ad_name?: string;
  form_id?: string;
  field_data?: Array<{ name?: string; values?: string[] }>;
};

const FIELD_ALIASES = {
  name: ['full_name', 'full name', 'fullname', 'name', 'first_name', 'first name'],
  phone: ['phone_number', 'phone number', 'phone', 'mobile', 'mobile number', 'mobile_number', 'whatsapp_number'],
  email: ['email', 'email address', 'email_address'],
  location: ['location', 'city', 'preferred location', 'preferred_location', 'area', 'locality'],
  budget: ['budget', 'budget range', 'budget_range', 'property budget', 'your_budget'],
  bhk: ['bhk', 'bedrooms', 'number of bedrooms', 'configuration'],
  propertyType: ['property type', 'property_type', 'type'],
};

@Injectable()
export class MetaLeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadsService: LeadsService,
    private readonly followUpsService: FollowUpsService,
    private readonly tenancy: TenancyService,
  ) {}

  private async fetchLead(leadgenId: string): Promise<MetaLead> {
    if (!config.meta.pageAccessToken) throw new Error('META_PAGE_ACCESS_TOKEN is missing');
    const url =
      `https://graph.facebook.com/${config.meta.graphVersion}/${leadgenId}` +
      `?fields=field_data,campaign_name,ad_name,form_id,created_time` +
      `&access_token=${encodeURIComponent(config.meta.pageAccessToken)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Meta lead lookup failed ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data as MetaLead;
  }

  private pick(fields: Record<string, string>, names: string[]) {
    for (const name of names) {
      if (fields[name]) return fields[name];
    }
    return undefined;
  }

  async processWebhook(body: any) {
    const results: unknown[] = [];
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field !== 'leadgen' || !change?.value?.leadgen_id) continue;
        const leadgenId = String(change.value.leadgen_id);
        // The organization comes from the Facebook page that owns the form (signed payload), not from lead data.
        const organizationId = await this.tenancy.resolve('meta_page_id', String(change?.value?.page_id ?? entry?.id ?? ''));
        if (!organizationId) {
          log.warn('meta_lead.unknown_page', { leadgenId });
          results.push({ leadgenId, error: 'unknown_page' });
          continue;
        }
        try {
          results.push(await this.handleLead(leadgenId, undefined, organizationId));
        } catch (error) {
          log.error('meta_lead.failed', { leadgenId: change.value.leadgen_id, error: errorMessage(error) });
          results.push({ leadgenId: change.value.leadgen_id, error: errorMessage(error) });
        }
      }
    }
    return { success: true, processed: results.length, leads: results };
  }

  /** Also used by POST /webhooks/meta/leads/test to simulate a lead locally. */
  async handleLead(leadgenId: string, simulated?: MetaLead, organizationId = config.defaultOrganizationId) {

    const duplicate = await this.prisma.lead.findFirst({ where: { organizationId, externalRef: leadgenId } });
    if (duplicate) {
      log.info('meta_lead.duplicate', { leadgenId, leadId: duplicate.id });
      return { leadgenId, leadId: duplicate.id, duplicate: true };
    }

    const metaLead = simulated ?? (await this.fetchLead(leadgenId));
    const fields: Record<string, string> = {};
    for (const field of metaLead.field_data ?? []) {
      const name = String(field?.name ?? '').trim().toLowerCase();
      const value = field?.values?.[0];
      if (name && value != null) fields[name] = String(value);
    }

    const phone = this.pick(fields, FIELD_ALIASES.phone);
    if (!phone) log.warn('meta_lead.no_phone', { leadgenId });

    let lead;
    try {
      lead = await this.leadsService.createLead({
        organizationId,
        name: this.pick(fields, FIELD_ALIASES.name),
        phone,
        email: this.pick(fields, FIELD_ALIASES.email),
        location: this.pick(fields, FIELD_ALIASES.location),
        budget: this.pick(fields, FIELD_ALIASES.budget), // "80 lakhs" -> 8000000 (parsed in LeadsService)
        bhk: this.pick(fields, FIELD_ALIASES.bhk),
        propertyType: this.pick(fields, FIELD_ALIASES.propertyType),
        source: 'meta_lead_ads',
        campaign: metaLead.campaign_name ?? metaLead.ad_name ?? metaLead.form_id,
        externalRef: leadgenId,
        notes: `Meta Lead ID: ${leadgenId}`,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { leadgenId, duplicate: true };
      }
      throw error;
    }

    // A new enquiry means they want to be contacted again.
    await this.prisma.customer.update({ where: { id: lead.customerId }, data: { doNotContact: false } });

    const followUps = lead.customer.phone
      ? await this.followUpsService.startLeadSequence({ organizationId, leadId: lead.id, customerId: lead.customerId })
      : [];

    log.info('meta_lead.processed', { leadgenId, leadId: lead.id, created: lead.created, followUps: followUps.length });
    return { leadgenId, leadId: lead.id, customerId: lead.customerId, created: lead.created, followUps: followUps.length };
  }
}
