import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { requirePermission } from '../governance/permissions.js';
import { MARKETING_PERMISSIONS as P, MarketingService, type CampaignInput, type ContentInput } from './marketing.service.js';

type Upload = { originalname?: string; buffer?: Buffer; size?: number };
const who = (u: SessionClaims) => `user:${u.sub}`;
const upload = () => FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

/**
 * Marketing API. The organization always comes from the session; every route is permission-checked on the server:
 * marketing.view (read), marketing.manage (lists, segments, drafts, content), marketing.approve_campaign /
 * marketing.approve_content (approval decisions, through the central approval queue).
 */
@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('overview')
  overview(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, P.view);
    return this.marketing.overview(org, u);
  }

  @Get('templates')
  templates(@CurrentUser() u: SessionClaims) {
    requirePermission(u, P.view);
    return this.marketing.templates();
  }

  // ---------------------------------------------------------------- customers

  @Get('customers')
  customers(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('q') q?: string, @Query('tag') tag?: string, @Query('consent') consent?: string) {
    requirePermission(u, P.view);
    return this.marketing.customers(org, { q, tag, consent });
  }

  @Patch('customers/:id')
  updateCustomer(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { tags?: string[]; marketingConsent?: boolean }) {
    requirePermission(u, P.manage);
    return this.marketing.updateCustomer(org, id, body ?? {});
  }

  /** multipart: file + tags + commit ("true" saves; otherwise only the validation preview) + consentConfirmed. */
  @Post('customers/import')
  @UseInterceptors(upload())
  importCustomers(@Org() org: string, @CurrentUser() u: SessionClaims, @UploadedFile() file: Upload | undefined, @Body() body: { tags?: string; commit?: string; consentConfirmed?: string }) {
    requirePermission(u, P.manage);
    return this.marketing.importCustomers(org, file, body ?? {});
  }

  @Post('customers/suppression')
  @UseInterceptors(upload())
  suppression(@Org() org: string, @CurrentUser() u: SessionClaims, @UploadedFile() file: Upload | undefined) {
    requirePermission(u, P.manage);
    return this.marketing.importSuppression(org, file);
  }

  // ---------------------------------------------------------------- segments

  @Get('segments')
  segments(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, P.view);
    return this.marketing.segments(org);
  }

  @Post('segments/preview')
  previewSegment(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { rules?: unknown }) {
    requirePermission(u, P.view);
    return this.marketing.previewAudience(org, body?.rules);
  }

  @Post('segments')
  saveSegment(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { id?: string; name?: string; description?: string; rules?: unknown }) {
    requirePermission(u, P.manage);
    return this.marketing.saveSegment(org, body ?? {}, who(u));
  }

  @Delete('segments/:id')
  deleteSegment(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.manage);
    return this.marketing.deleteSegment(org, id);
  }

  // ---------------------------------------------------------------- campaigns

  @Get('campaigns')
  campaigns(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('status') status?: string) {
    requirePermission(u, P.view);
    return this.marketing.list(org, status);
  }

  @Post('campaigns')
  createCampaign(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: CampaignInput) {
    requirePermission(u, P.manage);
    return this.marketing.createCampaign(org, body ?? {}, who(u));
  }

  @Get('campaigns/:id')
  campaign(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.view);
    return this.marketing.detail(org, id);
  }

  @Patch('campaigns/:id')
  updateCampaign(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: CampaignInput) {
    requirePermission(u, P.manage);
    return this.marketing.updateCampaign(org, id, body ?? {});
  }

  @Get('campaigns/:id/preview')
  preview(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.view);
    return this.marketing.preview(org, id);
  }

  @Get('campaigns/:id/estimate')
  estimate(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.view);
    return this.marketing.estimate(org, id);
  }

  /** The confirmation step: asks for approval (or approves, for someone holding marketing.approve_campaign). */
  @Post('campaigns/:id/request-send')
  requestSend(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { confirm?: boolean; expectedRecipients?: number }) {
    requirePermission(u, P.manage);
    return this.marketing.requestSend(org, id, u, body ?? {});
  }

  @Post('campaigns/:id/withdraw')
  withdraw(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.manage);
    return this.marketing.withdraw(org, id, who(u));
  }

  @Post('campaigns/:id/pause')
  pause(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.manage);
    return this.marketing.pause(org, id);
  }

  /** Resuming sends again: it needs the campaign approval permission. */
  @Post('campaigns/:id/resume')
  resume(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.approveCampaign);
    return this.marketing.resume(org, id);
  }

  @Post('campaigns/:id/cancel')
  cancel(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.manage);
    return this.marketing.cancel(org, id, who(u));
  }

  @Get('campaigns/:id/report')
  report(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.view);
    return this.marketing.report(org, id);
  }

  @Get('performance')
  performance(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('days') days?: string) {
    requirePermission(u, P.view);
    return this.marketing.performance(org, Math.min(365, Math.max(1, Number(days) || 90)));
  }

  // ---------------------------------------------------------------- content calendar

  @Get('content')
  content(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('from') from?: string, @Query('to') to?: string) {
    requirePermission(u, P.view);
    return this.marketing.settleContentApprovals(org).then(() => this.marketing.content(org, { from, to }));
  }

  @Post('content')
  createContent(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: ContentInput & { status?: 'idea' | 'draft' }) {
    requirePermission(u, P.manage);
    return this.marketing.createContent(org, body ?? {}, who(u), body?.status === 'idea' ? 'idea' : 'draft');
  }

  @Patch('content/:id')
  updateContent(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: ContentInput) {
    requirePermission(u, P.manage);
    return this.marketing.updateContent(org, id, body ?? {}, who(u));
  }

  /** AI (or template) draft from approved catalogue facts: new item, or a new revision of an existing one. */
  @Post('content/ai-draft')
  aiDraft(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { contentId?: string; kind?: string; language?: string; productIds?: string[]; offer?: string; occasion?: string; channel?: string; plannedFor?: string }) {
    requirePermission(u, P.manage);
    return this.marketing.aiDraft(org, body ?? {}, who(u));
  }

  @Get('content/:id/revisions')
  revisions(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.view);
    return this.marketing.revisions(org, id);
  }

  @Post('content/:id/revisions/:revisionId/restore')
  restore(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Param('revisionId') revisionId: string) {
    requirePermission(u, P.manage);
    return this.marketing.restoreRevision(org, id, revisionId, who(u));
  }

  @Get('ai-usage')
  aiUsage(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, P.view);
    return this.marketing.aiUsage(org);
  }

  @Post('content/:id/request-approval')
  requestContentApproval(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.manage);
    return this.marketing.requestContentApproval(org, id, u);
  }

  @Post('content/:id/published')
  published(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { note?: string }) {
    requirePermission(u, P.manage);
    return this.marketing.markPublished(org, id, who(u), body?.note);
  }

  @Post('content/:id/cancel')
  cancelContent(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, P.manage);
    return this.marketing.cancelContent(org, id, who(u));
  }
}
