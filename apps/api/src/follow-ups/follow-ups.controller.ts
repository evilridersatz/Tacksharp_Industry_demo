import { Org } from '../auth/decorators.js';
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { FollowUpsService, type CreateFollowUpInput } from './follow-ups.service.js';

@Controller('follow-ups')
export class FollowUpsController {
  constructor(private readonly followUpsService: FollowUpsService) {}

  @Post()
  create(@Org() organizationId: string, @Body() body: Omit<CreateFollowUpInput, 'organizationId'>) {
    return this.followUpsService.create({ ...body, organizationId });
  }

  /** Start the automatic sequence for an existing lead (testing / re-engage). */
  @Post('sequence/:leadId')
  async startSequence(@Org() organizationId: string, @Param('leadId') leadId: string, @Body() body: { customerId: string }) {
    const lead = await this.followUpsService.findLead(organizationId, leadId);
    return this.followUpsService.startLeadSequence({
      organizationId,
      leadId,
      customerId: lead.customerId,
    });
  }

  @Get()
  findAll(@Org() organizationId: string, @Query('channel') channel?: string, @Query('status') status?: string) {
    return this.followUpsService.findAll(organizationId, { channel, status });
  }

  @Get(':followUpId')
  findOne(@Org() organizationId: string, @Param('followUpId') followUpId: string) {
    return this.followUpsService.findOne(organizationId, followUpId);
  }

  @Patch(':followUpId/cancel')
  cancel(@Org() organizationId: string, @Param('followUpId') followUpId: string, @Body() body: { reason?: string }) {
    return this.followUpsService.cancel(organizationId, followUpId, body?.reason);
  }

  /** Mark a human task (handoff / callback without time) as done. */
  @Patch(':followUpId/complete')
  complete(@Org() organizationId: string, @Param('followUpId') followUpId: string) {
    return this.followUpsService.completeTask(organizationId, followUpId);
  }
}
