import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { KnowledgeService } from './knowledge.service.js';
import { KB_MAX_FILE_BYTES } from './text.js';

@Controller()
export class KnowledgeController {
  constructor(private readonly kb: KnowledgeService) {}

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
}
