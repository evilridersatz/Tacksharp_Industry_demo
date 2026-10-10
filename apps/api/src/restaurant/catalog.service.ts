import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import type { Product } from './chicken-parse.js';

const CACHE_MS = 30_000;
const MAX_PRICE = 100_000;

export type MenuItemView = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  unit: 'kg' | 'piece';
  cutOptions: string[];
  minQty: number;
  maxQty: number;
  qtyStep: number;
  available: boolean;
  imageUrl: string | null;
  aliases: string[];
  isDemo: boolean;
  categoryId: string;
  categoryName: string;
  sortOrder: number;
};

export type OutletView = {
  id: string;
  name: string;
  address: string;
  area: string | null;
  phone: string | null;
  opensAt: string;
  closesAt: string;
  prepMinutes: number;
  minOrderValue: number;
  acceptOutsideHours: boolean;
  active: boolean;
  isDemo: boolean;
};

export type Catalog = {
  categories: Array<{ id: string; name: string; sortOrder: number }>;
  items: MenuItemView[];
  outlets: OutletView[];
};

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const splitAliases = (raw: string | null) => (raw ?? '').split(',').map((a) => a.trim()).filter(Boolean);
const cutsOf = (raw: unknown) => (Array.isArray(raw) ? raw.map((c) => String(c).trim()).filter(Boolean) : []);

export function outletView(o: Prisma.OutletGetPayload<object>): OutletView {
  return {
    id: o.id,
    name: o.name,
    address: o.address,
    area: o.area,
    phone: o.phone,
    opensAt: o.opensAt,
    closesAt: o.closesAt,
    prepMinutes: o.prepMinutes,
    minOrderValue: num(o.minOrderValue),
    acceptOutsideHours: o.acceptOutsideHours,
    active: o.active,
    isDemo: o.isDemo,
  };
}

/** Products and shops of a restaurant tenant. Every query is scoped by organizationId. */
@Injectable()
export class CatalogService {
  private readonly cache = new Map<string, { at: number; value: Catalog }>();

  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string, fresh = false): Promise<Catalog> {
    const hit = this.cache.get(organizationId);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const [categories, items, outlets] = await Promise.all([
      this.prisma.menuCategory.findMany({ where: { organizationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.menuItem.findMany({ where: { organizationId }, include: { category: true }, orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.outlet.findMany({ where: { organizationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    ]);
    const value: Catalog = {
      categories: categories.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder })),
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        price: num(i.price),
        unit: i.unit === 'piece' ? 'piece' : 'kg',
        cutOptions: cutsOf(i.cutOptions),
        minQty: num(i.minQty),
        maxQty: num(i.maxQty),
        qtyStep: num(i.qtyStep),
        available: i.available,
        imageUrl: i.imageUrl,
        aliases: splitAliases(i.aliases),
        isDemo: i.isDemo,
        categoryId: i.categoryId,
        categoryName: i.category.name,
        sortOrder: i.sortOrder,
      })),
      outlets: outlets.map(outletView),
    };
    this.cache.set(organizationId, { at: Date.now(), value });
    return value;
  }

  /** Products in the shape the message parser needs (unavailable ones too, so we can say "not available today"). */
  products(catalog: Catalog): Product[] {
    return catalog.items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, aliases: i.aliases, cutOptions: i.cutOptions, available: i.available }));
  }

  invalidate(organizationId: string) {
    this.cache.delete(organizationId);
  }

  /** Dashboard edit: price per kg, availability, cuts, description, aliases. Validated on the server. */
  async updateItem(organizationId: string, itemId: string, patch: Record<string, unknown>, actor: string) {
    const item = await this.prisma.menuItem.findFirst({ where: { id: itemId, organizationId } });
    if (!item) throw new NotFoundException('Product not found');
    const data = await this.validateItemInput(organizationId, patch, false);
    const updated = await this.prisma.menuItem.update({ where: { id: item.id }, data });
    this.invalidate(organizationId);
    log.info('menu.item_updated', {
      organizationId,
      itemId,
      actor,
      fields: Object.keys(data),
      ...(data.price !== undefined ? { priceFrom: Number(item.price), priceTo: Number(data.price) } : {}),
    });
    return updated;
  }

  async createItem(organizationId: string, input: Record<string, unknown>, actor: string) {
    const data = await this.validateItemInput(organizationId, input, true);
    try {
      const created = await this.prisma.menuItem.create({
        data: { ...(data as Omit<Prisma.MenuItemUncheckedCreateInput, 'organizationId' | 'cutOptions'>), cutOptions: (data.cutOptions as string[] | undefined) ?? [], organizationId },
      });
      this.invalidate(organizationId);
      log.info('menu.item_created', { organizationId, itemId: created.id, actor });
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException('A product with this name already exists.');
      }
      throw error;
    }
  }

  private async validateItemInput(organizationId: string, input: Record<string, unknown>, creating: boolean) {
    const data: Record<string, unknown> = {};
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
    const positive = (v: unknown, label: string, max: number) => {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > max) throw new BadRequestException(`${label} must be a number between 0 and ${max}.`);
      return n;
    };

    if (input.name !== undefined || creating) {
      const name = str(input.name, 120);
      if (!name) throw new BadRequestException('Name is required.');
      data.name = name;
    }
    if (input.price !== undefined || creating) {
      const price = positive(input.price, 'Price', MAX_PRICE);
      if (Math.round(price * 100) !== price * 100) throw new BadRequestException('Price can have at most 2 decimals.');
      data.price = new Prisma.Decimal(price.toFixed(2));
    }
    if (input.unit !== undefined || creating) {
      const unit = input.unit ?? 'kg';
      if (unit !== 'kg' && unit !== 'piece') throw new BadRequestException('unit must be kg or piece.');
      data.unit = unit;
    }
    if (input.cutOptions !== undefined) {
      const raw = typeof input.cutOptions === 'string' ? input.cutOptions.split(',') : input.cutOptions;
      if (!Array.isArray(raw)) throw new BadRequestException('cutOptions must be a list.');
      data.cutOptions = raw.map((c) => String(c).trim().slice(0, 40)).filter(Boolean).slice(0, 8);
    }
    for (const key of ['minQty', 'maxQty', 'qtyStep'] as const) {
      if (input[key] !== undefined) data[key] = new Prisma.Decimal(positive(input[key], key, 1000).toFixed(3));
    }
    if (input.available !== undefined) {
      if (typeof input.available !== 'boolean') throw new BadRequestException('available must be true or false.');
      data.available = input.available;
    }
    if (input.description !== undefined) data.description = str(input.description, 500) || null;
    if (input.aliases !== undefined) data.aliases = str(input.aliases, 500) || null;
    if (input.imageUrl !== undefined) {
      const url = str(input.imageUrl, 1000);
      if (url && !/^https:\/\//.test(url)) throw new BadRequestException('Image URL must start with https://');
      data.imageUrl = url || null;
    }
    if (input.categoryId !== undefined || creating) {
      const categoryId = str(input.categoryId, 64);
      const category = categoryId ? await this.prisma.menuCategory.findFirst({ where: { id: categoryId, organizationId } }) : null;
      if (!category) throw new BadRequestException('Choose a valid category.');
      data.categoryId = category.id;
    }
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to update.');
    return data;
  }
}
