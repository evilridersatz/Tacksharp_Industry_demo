import { Org } from '../auth/decorators.js';
import { Body, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { LeadsService, LEAD_STATUSES, type LeadStatus } from './leads.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly followUpsService: FollowUpsService,
  ) {}

  /**
   * Manually add a lead (dashboard / CSV import / testing).
   * Starts the follow-up sequence only for a brand-new lead.
   */
  @Post()
  async createLead(
    @Org() organizationId: string,
    @Body()
    body: {
      name?: string;
      phone?: string;
      email?: string;
      language?: string;
      source?: string;
      campaign?: string;
      budget?: number | string;
      location?: string;
      bhk?: number | string;
      propertyType?: string;
      notes?: string;
      startSequence?: boolean;
    },
  ) {
    const lead = await this.leadsService.createLead({
      organizationId,
      ...body,
      source: body.source ?? 'manual',
    });

    let followUps: unknown[] = [];
    if (lead.created && body.startSequence !== false) {
      followUps = await this.followUpsService.startLeadSequence({
        organizationId,
        leadId: lead.id,
        customerId: lead.customerId,
      });
    }
    return { lead, followUps };
  }

  @Get()
  getLeads(@Org() organizationId: string) {
    return this.leadsService.getLeads(organizationId);
  }

  @Get(':leadId')
  async getLead(@Org() organizationId: string, @Param('leadId') leadId: string) {
    const detail = await this.leadsService.getLeadDetail(organizationId, leadId);
    if (!detail) throw new NotFoundException('Lead not found');
    return detail;
  }

  @Patch(':leadId/status')
  async updateLeadStatus(@Org() organizationId: string, @Param('leadId') leadId: string, @Body() body: { status: LeadStatus }) {
    if (!Object.values(LEAD_STATUSES).includes(body.status)) {
      return {
        updated: false,
        error: `Invalid lead status: ${body.status}`,
        allowedStatuses: Object.values(LEAD_STATUSES),
      };
    }
    const lead = await this.leadsService.updateLeadStatus({
      organizationId: organizationId,
      leadId,
      status: body.status,
    });
    if (!lead) return { updated: false, error: 'Lead not found' };

    if (['won', 'lost', 'not_interested', 'human_handoff'].includes(body.status)) {
      await this.followUpsService.cancelPending({
        organizationId: organizationId,
        customerId: lead.customerId,
        reason: `Lead marked ${body.status}`,
      });
    }
    return lead;
  }
}
