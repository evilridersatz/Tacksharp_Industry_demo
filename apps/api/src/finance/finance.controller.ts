import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { FinanceService } from './finance.service.js';
import { CollectionsService } from './collections.service.js';
import { UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

const who = (u: SessionClaims) => `user:${u.sub}`;

/** Finance API. Organization from the session; every action permission-checked here and again in the service. */
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly collections: CollectionsService,
  ) {}

  @Get('overview')
  overview(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('days') days?: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.finance.overview(org, Number(days) || 30);
  }

  @Get('invoices')
  invoices(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('status') status?: string, @Query('orderId') orderId?: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.finance.listInvoices(org, { status, orderId });
  }

  @Get('invoices.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="invoices.csv"')
  csv(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.finance.exportInvoicesCsv(org);
  }

  @Get('invoices/:id')
  invoice(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.finance.getInvoice(org, id);
  }

  @Post('invoices')
  create(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { orderId?: string; taxPercent?: number | null; dueDays?: number; notes?: string }) {
    requirePermission(u, PERMISSIONS.createInvoice);
    return this.finance.createInvoice(org, String(body?.orderId ?? ''), who(u), body ?? {});
  }

  @Post('invoices/:id/status')
  status(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; reason?: string; dueDate?: string }) {
    return this.finance.setInvoiceStatus(org, id, String(body?.status ?? ''), u, body ?? {});
  }

  @Get('payments')
  payments(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('status') status?: string, @Query('invoiceId') invoiceId?: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.finance.listPayments(org, { status, invoiceId });
  }

  /** Record a payment (always "pending verification"). Sales may record what a customer says they paid. */
  @Post('payments')
  record(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { invoiceId?: string; amount?: number; method?: string; reference?: string; transactionId?: string; paidAt?: string; source?: string; notes?: string }) {
    requirePermission(u, PERMISSIONS.recordPayment);
    return this.finance.recordPayment(org, body ?? {}, who(u));
  }

  @Post('payments/:id/verify')
  verify(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { evidence?: string }) {
    return this.finance.verifyPayment(org, id, u, body?.evidence);
  }

  @Post('payments/:id/reject')
  reject(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.finance.rejectPayment(org, id, u, body?.reason);
  }

  @Post('payments/:id/reverse')
  reverse(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { reason?: string }) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.finance.requestReversal(org, id, u, body?.reason);
  }

  @Get('receivables')
  receivables(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.finance.receivables(org);
  }

  // ---------------------------------------------------------------- collections

  @Get('invoices/:id/collections')
  collectionNotes(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.collections.notes(org, id);
  }

  /** contact / promise / dispute / outcome. Sales may record what the customer said. */
  @Post('invoices/:id/collections')
  addCollectionNote(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { type?: string; note?: string; promisedAmount?: number; promisedDate?: string }) {
    requirePermission(u, PERMISSIONS.recordPayment);
    return this.collections.addNote(org, id, body ?? {}, u);
  }

  @Post('collections/:id/status')
  collectionStatus(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status?: string; note?: string }) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.collections.setNoteStatus(org, id, String(body?.status ?? ''), u, body?.note);
  }

  /** Prepare a payment reminder. Sent only after approval (finance.send_reminder); a holder approves by requesting. */
  @Post('invoices/:id/reminder')
  reminder(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.collections.requestReminder(org, id, u);
  }

  @Get('invoices/:id/reminder-check')
  reminderCheck(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.collections.reminderBlocker(org, id).then((blocker) => ({ eligible: !blocker, blocker }));
  }

  /** Bank statement (CSV / XLSX) matched against recorded payments. Read-only; never verifies. */
  @Post('statement/match')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  matchStatement(@Org() org: string, @CurrentUser() u: SessionClaims, @UploadedFile() file: { originalname?: string; buffer?: Buffer } | undefined) {
    requirePermission(u, PERMISSIONS.verifyPayment);
    return this.collections.matchStatement(org, file, u);
  }

  // ---------------------------------------------------------------- expenses + profitability

  @Get('expenses')
  expenses(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('from') from?: string, @Query('to') to?: string, @Query('category') category?: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.collections.expenses(org, { from, to, category });
  }

  @Post('expenses')
  recordExpense(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: { spentOn?: string; category?: string; amount?: number; vendor?: string; reference?: string; notes?: string; confirmDuplicate?: boolean }) {
    requirePermission(u, PERMISSIONS.manageExpenses);
    return this.collections.recordExpense(org, body ?? {}, u);
  }

  @Post('expenses/:id/void')
  voidExpense(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { reason?: string }) {
    requirePermission(u, PERMISSIONS.manageExpenses);
    return this.collections.voidExpense(org, id, body?.reason, u);
  }

  @Get('unit-costs')
  unitCosts(@Org() org: string, @CurrentUser() u: SessionClaims) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.collections.unitCosts(org);
  }

  @Post('unit-costs/:productId')
  setUnitCost(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('productId') productId: string, @Body() body: { unitCost?: number | null }) {
    requirePermission(u, PERMISSIONS.manageExpenses);
    return this.collections.setUnitCost(org, productId, body?.unitCost, u);
  }

  @Get('profitability')
  profitability(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('days') days?: string) {
    requirePermission(u, PERMISSIONS.financeView);
    return this.collections.profitability(org, Number(days) || 30);
  }
}
