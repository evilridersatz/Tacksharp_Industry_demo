import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { CustomersService, type CustomerInput } from './customers.service.js';

const int = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));

/** Customers of the logged-in workspace (organization from the session, never from the request). */
@Controller('customers')
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}

  @Get()
  list(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: Record<string, string>) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.svc.list(org, { q: q.q, consent: q.consent, source: q.source, tag: q.tag, stage: q.stage, followUpDue: q.followUpDue, page: int(q.page), pageSize: int(q.pageSize) });
  }

  /** CSV export of the filtered customers (names / phones of this workspace only). */
  @Get('export')
  async exportCsv(@Org() org: string, @CurrentUser() u: SessionClaims, @Query() q: Record<string, string>, @Res() res: Response) {
    requirePermission(u, PERMISSIONS.customersManage);
    const r = await this.svc.exportCsv(org, u, { q: q.q, consent: q.consent, source: q.source, tag: q.tag, stage: q.stage, followUpDue: q.followUpDue });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Rows', String(r.rows));
    res.setHeader('X-Truncated', String(r.truncated));
    res.send('\uFEFF' + r.csv);
  }

  @Get('duplicates')
  duplicates(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.svc.duplicates(org);
  }

  @Post()
  create(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() b: CustomerInput) {
    requirePermission(u, PERMISSIONS.customersManage);
    return this.svc.create(org, u, b ?? {});
  }

  @Get(':id')
  detail(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.svc.detail(org, id);
  }

  @Patch(':id')
  update(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: CustomerInput) {
    requirePermission(u, PERMISSIONS.customersManage);
    return this.svc.update(org, u, id, b ?? {});
  }

  @Post(':id/notes')
  note(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { body?: unknown }) {
    requirePermission(u, PERMISSIONS.customersManage);
    return this.svc.addNote(org, u, id, b?.body);
  }

  @Post(':id/tasks')
  task(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { title?: unknown; dueAt?: unknown }) {
    requirePermission(u, PERMISSIONS.customersManage);
    return this.svc.addTask(org, u, id, b ?? {});
  }

  /** One WhatsApp test message, after the user confirmed it in the dashboard. */
  @Post(':id/whatsapp-test')
  whatsappTest(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { confirm?: unknown; message?: unknown }) {
    requirePermission(u, PERMISSIONS.customersContact);
    return this.svc.whatsappTest(org, u, id, b ?? {});
  }

  @Get(':id/messages/:messageId')
  messageStatus(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Param('messageId') messageId: string) {
    requirePermission(u, PERMISSIONS.customersView);
    return this.svc.messageStatus(org, id, messageId);
  }

  /** One test call, after the user confirmed it in the dashboard. */
  @Post(':id/test-call')
  testCall(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() b: { confirm?: unknown }) {
    requirePermission(u, PERMISSIONS.customersContact);
    return this.svc.testCall(org, u, id, b ?? {});
  }
}
