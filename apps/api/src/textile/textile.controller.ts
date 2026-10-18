import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Org } from '../auth/decorators.js';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, can } from '../governance/permissions.js';
import { TextileService, type ProductInput, type QuotationInput } from './textile.service.js';
import type { OrderStatus, PaymentStatus, QuoteStatus } from './textile-rules.js';

const actor = (u: SessionClaims) => `user:${u.sub}`;

/**
 * Textile sales API (industry = textile). Every route needs a logged-in user; the organization always comes from the
 * session (@Org), never from the request, so one business can never read or change another's records.
 */
@Controller('textile')
export class TextileController {
  constructor(private readonly textile: TextileService) {}

  @Get('overview')
  overview(@Org() org: string, @Query('days') days?: string) {
    return this.textile.overview(org, Number(days) || 30);
  }

  // catalogue
  @Get('products')
  products(@Org() org: string, @CurrentUser() u: SessionClaims, @Query('q') q?: string, @Query('category') category?: string, @Query('active') active?: string) {
    // Unit cost is internal (margin): only people with finance.view see it.
    return this.textile.listProducts(org, { search: q, category, active: active === undefined ? undefined : active === 'true' })
      .then((rows) => (can(u.role, PERMISSIONS.financeView) ? rows : rows.map(({ unitCost: _c, ...r }) => r)));
  }
  @Post('products')
  createProduct(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: ProductInput) {
    return this.textile.createProduct(org, body ?? {}, actor(u));
  }
  @Patch('products/:id')
  updateProduct(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: ProductInput) {
    return this.textile.updateProduct(org, id, body ?? {}, actor(u));
  }

  // quotations
  @Get('quotations')
  quotations(@Org() org: string, @Query('status') status?: string) {
    return this.textile.listQuotations(org, status);
  }
  @Get('quotations/:id')
  quotation(@Org() org: string, @Param('id') id: string) {
    return this.textile.getQuotation(org, id);
  }
  @Post('quotations')
  createQuotation(@Org() org: string, @CurrentUser() u: SessionClaims, @Body() body: QuotationInput) {
    return this.textile.createQuotation(org, { ...body, origin: 'manual' }, actor(u));
  }
  @Patch('quotations/:id')
  updateQuotation(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: Partial<QuotationInput>) {
    return this.textile.updateQuotation(org, id, body ?? {}, actor(u));
  }
  @Post('quotations/:id/status')
  quotationStatus(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status: QuoteStatus }) {
    return this.textile.setQuotationStatus(org, id, body?.status, actor(u), u.role);
  }
  @Post('quotations/:id/send')
  sendQuotation(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string) {
    return this.textile.sendQuotation(org, id, actor(u));
  }
  @Post('quotations/:id/convert')
  convert(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { expectedDelivery?: string; shippingAddress?: string }) {
    return this.textile.convertToOrder(org, id, actor(u), body ?? {});
  }

  // orders
  @Get('orders')
  orders(@Org() org: string, @Query('status') status?: string) {
    return this.textile.listOrders(org, status);
  }
  @Get('orders/:id')
  order(@Org() org: string, @Param('id') id: string) {
    return this.textile.getOrder(org, id);
  }
  @Post('orders/:id/status')
  orderStatus(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { status: OrderStatus }) {
    return this.textile.setOrderStatus(org, id, body?.status, actor(u));
  }
  @Post('orders/:id/payment')
  payment(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { paymentStatus: PaymentStatus }) {
    return this.textile.setPaymentStatus(org, id, body?.paymentStatus, actor(u));
  }

  // feedback
  @Get('feedback')
  feedback(@Org() org: string, @Query('status') status?: string) {
    return this.textile.listFeedback(org, status);
  }
  @Post('feedback/:id/resolve')
  resolve(@Org() org: string, @CurrentUser() u: SessionClaims, @Param('id') id: string, @Body() body: { resolution?: string; owner?: string }) {
    return this.textile.resolveFeedback(org, id, body ?? {}, actor(u));
  }

  // one lead: buyer requirement + quotations + orders (lead page)
  @Get('leads/:leadId')
  forLead(@Org() org: string, @Param('leadId') leadId: string) {
    return this.textile.forLead(org, leadId);
  }

  // buyer requirement (salesperson edits; whitelisted fields only)
  @Patch('requirements/:leadId')
  requirement(@Org() org: string, @Param('leadId') leadId: string, @Body() body: Record<string, unknown>) {
    return this.textile.saveRequirement(org, leadId, body ?? {});
  }
}
