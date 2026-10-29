import { CurrentUser, Org } from '../auth/decorators.js';
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import type { SessionClaims } from '../auth/token.js';
import { PERMISSIONS, requirePermission } from '../governance/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PropertiesService } from './properties.service.js';
import { parseBhk, parseIndianBudget } from '../common/parsers.js';

@Controller('properties')
export class PropertiesController {
  constructor(
    private readonly propertiesService: PropertiesService,
    private readonly prisma: PrismaService,
  ) {}

  /** Property inventory for the dashboard (organization from the session). */
  @Get()
  async list(@Org() organizationId: string, @Query('status') status?: string, @Query('q') q?: string, @Query('page') pageRaw?: string) {
    const page = Math.max(1, Number(pageRaw) || 1);
    const where = {
      organizationId,
      ...(status && STATUSES.includes(status) ? { status } : {}),
      ...(q?.trim() ? { OR: [{ name: { contains: q.trim().slice(0, 60) } }, { location: { contains: q.trim().slice(0, 60) } }] } : {}),
    };
    const [total, rows, byStatus] = await Promise.all([
      this.prisma.property.count({ where }),
      this.prisma.property.findMany({ where, orderBy: [{ status: 'asc' }, { price: 'asc' }], skip: (page - 1) * 25, take: 25, include: { _count: { select: { SiteVisit: true } } } }),
      this.prisma.property.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
    ]);
    return { total, page, pageSize: 25, byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])), rows: rows.map((r) => ({ id: r.id, name: r.name, location: r.location, type: r.type, bhk: r.bhk, price: Number(r.price), status: r.status, siteVisits: r._count.SiteVisit, updatedAt: r.updatedAt })) };
  }

  @Post()
  async create(@Org() organizationId: string, @CurrentUser() u: SessionClaims, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.customersManage);
    const d = validProperty(body, true);
    const row = await this.prisma.property.create({ data: { organizationId, ...(d as { name: string; location: string; type: string; bhk: number; price: number }), status: d.status ?? 'available' } });
    await this.prisma.auditEvent.create({ data: { organizationId, actor: `user:${u.sub}`, entityType: 'property', entityId: row.id, action: 'property.created', data: {} } });
    return row;
  }

  @Patch(':propertyId')
  async update(@Org() organizationId: string, @CurrentUser() u: SessionClaims, @Param('propertyId') id: string, @Body() body: Record<string, unknown>) {
    requirePermission(u, PERMISSIONS.customersManage);
    const existing = await this.prisma.property.findFirst({ where: { id, organizationId } });
    if (!existing) throw new NotFoundException('Property not found');
    const d = validProperty(body, false);
    const row = await this.prisma.property.update({ where: { id }, data: d });
    await this.prisma.auditEvent.create({ data: { organizationId, actor: `user:${u.sub}`, entityType: 'property', entityId: id, action: 'property.updated', data: { fields: Object.keys(d) } } });
    return row;
  }

  @Get('search')
  search(
    @Org() organizationId: string,
    @Query('location') location?: string,
    @Query('bhk') bhk?: string,
    @Query('propertyType') propertyType?: string,
    @Query('maxBudget') maxBudget?: string,
  ) {
    return this.propertiesService.searchProperties({
      organizationId,
      location,
      bhk: parseBhk(bhk),
      propertyType,
      maxBudget: parseIndianBudget(maxBudget),
    });
  }

  @Get(':propertyId')
  async details(@Org() organizationId: string, @Param('propertyId') propertyId: string) {
    const property = await this.propertiesService.getPropertyDetails({
      organizationId,
      propertyId,
    });
    if (!property) throw new NotFoundException('Property not found');
    return property;
  }
}

const STATUSES = ['available', 'reserved', 'sold', 'on_hold'];
const TYPES = ['apartment', 'villa', 'plot', 'independent_house', 'commercial'];

function validProperty(b: Record<string, unknown> | null | undefined, create: boolean) {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  const body = b ?? {};
  const text = (k: string, max: number) => {
    if (body[k] === undefined) { if (create) errors[k] = 'Required.'; return; }
    const v = typeof body[k] === 'string' ? (body[k] as string).trim() : '';
    if (v.length < 2 || v.length > max) errors[k] = `2 to ${max} characters.`;
    else out[k] = v;
  };
  text('name', 120);
  text('location', 80);
  if (body.type !== undefined || create) { if (!TYPES.includes(String(body.type))) errors.type = `One of: ${TYPES.join(', ')}.`; else out.type = body.type; }
  if (body.bhk !== undefined || create) { const n = Number(body.bhk); if (!Number.isInteger(n) || n < 0 || n > 10) errors.bhk = '0 to 10.'; else out.bhk = n; }
  if (body.price !== undefined || create) { const n = Number(body.price); if (!Number.isFinite(n) || n <= 0 || n > 1e11) errors.price = 'A positive amount in rupees.'; else out.price = n; }
  if (body.status !== undefined) { if (!STATUSES.includes(String(body.status))) errors.status = `One of: ${STATUSES.join(', ')}.`; else out.status = body.status; }
  if (Object.keys(errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please correct the highlighted fields.', fields: errors });
  return out as { name?: string; location?: string; type?: string; bhk?: number; price?: number; status?: string };
}
