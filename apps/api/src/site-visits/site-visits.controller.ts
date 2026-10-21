import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Org } from '../auth/decorators.js';
import { SITE_VISIT_STATUSES, type SiteVisitStatus, SiteVisitsService } from './site-visits.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { errorMessage, log } from '../common/logger.js';

type VisitRow = { id?: string; organizationId?: string; leadId?: string; customerId?: string; scheduledAt?: Date; status?: string };

/** organizationId always comes from the logged-in user, never from the request. */
@Controller('site-visits')
export class SiteVisitsController {
  constructor(
    private readonly siteVisitsService: SiteVisitsService,
    private readonly followUps: FollowUpsService,
  ) {}

  /** Visits booked by staff get the same reminders and team alert as AI bookings. Never fails the booking. */
  private async followThrough<T>(result: T): Promise<T> {
    const v = result as VisitRow;
    if (v?.id && v.organizationId && v.leadId && v.customerId && v.scheduledAt && ['scheduled', 'confirmed'].includes(v.status ?? '')) {
      await this.followUps
        .scheduleVisitFollowThrough({ id: v.id, organizationId: v.organizationId, leadId: v.leadId, customerId: v.customerId, scheduledAt: new Date(v.scheduledAt) })
        .catch((error) => log.error('sitevisit.follow_through_failed', { siteVisitId: v.id, error: errorMessage(error) }));
    }
    return result;
  }

  @Post()
  async createSiteVisit(
    @Org() organizationId: string,
    @Body() body: { leadId: string; customerId?: string; propertyId: string; scheduledAt: string; status?: SiteVisitStatus; notes?: string },
  ) {
    return this.followThrough(await this.siteVisitsService.createSiteVisit({
      organizationId,
      leadId: body.leadId,
      customerId: body.customerId,
      propertyId: body.propertyId,
      scheduledAt: body.scheduledAt,
      status: body.status,
      notes: body.notes,
    }));
  }

  @Post('book-by-phone')
  async bookByCustomerPhone(
    @Org() organizationId: string,
    @Body() body: { phone: string; propertyId: string; scheduledAt: string; notes?: string },
  ) {
    return this.followThrough(await this.siteVisitsService.bookByCustomerPhone({
      organizationId,
      phone: body.phone,
      propertyId: body.propertyId,
      scheduledAt: body.scheduledAt,
      notes: body.notes,
    }));
  }

  @Get()
  getSiteVisits(@Org() organizationId: string) {
    return this.siteVisitsService.getSiteVisits(organizationId);
  }

  @Get(':siteVisitId')
  getSiteVisit(@Org() organizationId: string, @Param('siteVisitId') siteVisitId: string) {
    return this.siteVisitsService.getSiteVisit(organizationId, siteVisitId);
  }

  @Patch(':siteVisitId/status')
  async updateStatus(@Org() organizationId: string, @Param('siteVisitId') siteVisitId: string, @Body() body: { status: SiteVisitStatus }) {
    if (!Object.values(SITE_VISIT_STATUSES).includes(body?.status)) {
      throw new BadRequestException(`Invalid site visit status: ${body?.status}`);
    }
    const updated = await this.siteVisitsService.updateStatus({ organizationId, siteVisitId, status: body.status });
    if (body.status === 'cancelled' && (updated as VisitRow)?.customerId) {
      await this.followUps.cancelStaleVisitSteps(organizationId, (updated as VisitRow).customerId!).catch(() => undefined);
    }
    return updated;
  }
}
