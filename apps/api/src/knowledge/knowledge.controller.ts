import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { KnowledgeService } from './knowledge.service.js';
import { KnowledgeStudioService } from './knowledge-studio.service.js';
import { KB_MAX_FILE_BYTES } from './text.js';

@Controller()
export class KnowledgeController {
  constructor(
    private readonly kb: KnowledgeService,
    private readonly studio: KnowledgeStudioService,
  ) {}

  @Get('knowledge-bases')
  list(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.kb.listBases(org);
  }

  @Post('knowledge-bases')
  create(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { name?: unknown }) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.kb.createBase(org, body?.name);
  }

  @Get('knowledge-bases/:id')
  get(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.kb.getBase(org, id);
  }

  @Delete('knowledge-bases/:id')
  remove(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.kb.deleteBase(org, id);
  }

  /** Multipart upload (field "file"). Type is checked by extension AND content; size is capped before buffering. */
  @Post('knowledge-bases/:id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: KB_MAX_FILE_BYTES, files: 1, fields: 5 } }))
  upload(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @UploadedFile() file: { originalname?: string; buffer?: Buffer } | undefined) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.kb.upload(org, id, file, `user:${u.sub}`);
  }

  /** Try retrieval: which passages would the agent see for this question? */
  @Get('knowledge-bases/:id/search')
  async search(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Query('q') q?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    await this.kb.getBase(org, id);
    return { results: await this.kb.search(org, id, String(q ?? '').slice(0, 300), 5) };
  }

  @Get('knowledge-documents/:id')
  doc(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.kb.document(org, id);
  }

  @Post('knowledge-documents/:id/reprocess')
  @HttpCode(200)
  reprocess(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.kb.reprocess(org, id, `user:${u.sub}`);
  }

  @Delete('knowledge-documents/:id')
  removeDoc(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.kb.deleteDocument(org, id, `user:${u.sub}`);
  }

  // ------------------------------------------------------------------------------------------- knowledge studio
  @Get('knowledge-studio')
  overview(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.studio.overview(org);
  }

  @Get('knowledge-documents/:id/passages')
  passages(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.studio.passages(org, id);
  }

  @Get('knowledge-documents/:id/answer')
  answer(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.studio.answer(org, id);
  }

  /** A typed answer (a text document marked authored); `gapId` marks that unanswered question as answered. */
  @Post('knowledge-bases/:id/answers')
  writeAnswer(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { title?: unknown; text?: unknown; gapId?: unknown }) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.studio.writeAnswer({ sub: u.sub, org: u.org }, id, body ?? {});
  }

  @Put('knowledge-documents/:id/answer')
  editAnswer(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { title?: unknown; text?: unknown }) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.studio.editAnswer({ sub: u.sub, org: u.org }, id, body ?? {});
  }

  @Get('knowledge-gaps')
  gaps(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('knowledgeBaseId') knowledgeBaseId?: string, @Query('status') status?: string) {
    requirePermission(u, PERMISSIONS.agentsView);
    return this.studio.gaps(org, { knowledgeBaseId, status });
  }

  @Post('knowledge-gaps/:id/status')
  @HttpCode(200)
  gapStatus(@CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status?: unknown }) {
    requirePermission(u, PERMISSIONS.agentsManage);
    return this.studio.setGapStatus({ sub: u.sub, org: u.org }, id, body?.status);
  }
}
