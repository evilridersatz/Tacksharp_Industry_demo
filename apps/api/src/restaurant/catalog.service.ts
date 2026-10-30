import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import type { Product } from './chicken-parse.js';
import { stockStatus, type StockStatus } from './inventory.js';

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
  /**
   * Can be sold right now: staff have it switched on AND (stock not tracked, or at least the minimum quantity in
   * stock). Everything that decides availability (replies, menu, quote, order) reads this one field.
   */
  available: boolean;
  /** The staff on/off switch alone (dashboard). */
  listed: boolean;
  /** Stock on hand in the product's unit; null = not tracked. */
  stockQty: number | null;
  lowStockThreshold: number | null;
  stockStatus: StockStatus;
  /** Stock numbers are demo / sample values, not counted shop inventory. */
  stockIsDemo: boolean;
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
      items: items.map((i) => {
        const status = stockStatus(i);
        return {
        id: i.id,
        name: i.name,
        description: i.description,
        price: num(i.price),
        unit: i.unit === 'piece' ? 'piece' : 'kg',
        cutOptions: cutsOf(i.cutOptions),
        minQty: num(i.minQty),
        maxQty: num(i.maxQty),
        qtyStep: num(i.qtyStep),
        available: i.available && status !== 'out',
        listed: i.available,
        stockQty: i.stockQty === null ? null : Number(i.stockQty),
        lowStockThreshold: i.lowStockThreshold === null ? null : Number(i.lowStockThreshold),
        stockStatus: status,
        stockIsDemo: i.stockIsDemo,
        imageUrl: i.imageUrl,
        aliases: splitAliases(i.aliases),
        isDemo: i.isDemo,
        categoryId: i.categoryId,
        categoryName: i.category.name,
        sortOrder: i.sortOrder,
        };
      }),
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

  /** A menu category ("Chicken", "Eggs" ...). Names are unique per organization. */
  async createCategory(organizationId: string, input: Record<string, unknown>, actor: string) {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
    if (name.length < 2) throw new BadRequestException('Give the category a name (at least 2 characters).');
    const existing = await this.prisma.menuCategory.findFirst({ where: { organizationId, name } });
    if (existing) throw new BadRequestException('A category with this name already exists.');
    const count = await this.prisma.menuCategory.count({ where: { organizationId } });
    const created = await this.prisma.menuCategory.create({ data: { organizationId, name, sortOrder: count } });
    this.invalidate(organizationId);
    log.info('menu.category_created', { organizationId, categoryId: created.id, actor });
    return created;
  }

  /** A shop / pickup point. Opening hours are IST "HH:mm"; staff still confirm every order. */
  async saveOutlet(organizationId: string, id: string | null, input: Record<string, unknown>, actor: string) {
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
    const data: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    const creating = id === null;
    if (creating || input.name !== undefined) { const v = str(input.name, 120); if (!v || v.length < 2) errors.name = 'Enter the shop name.'; else data.name = v; }
    if (creating || input.address !== undefined) { const v = str(input.address, 500); if (!v || v.length < 5) errors.address = 'Enter the shop address.'; else data.address = v; }
    if (input.area !== undefined) data.area = str(input.area, 120) || null;
    if (input.phone !== undefined) {
      const v = (str(input.phone, 30) ?? '').replace(/[\s()+-]/g, '');
      if (v && !/^\d{8,15}$/.test(v)) errors.phone = 'Digits with country code, 8 to 15 long.'; else data.phone = v || null;
    }
    for (const k of ['opensAt', 'closesAt'] as const) {
      if (input[k] !== undefined) { const v = str(input[k], 5) ?? ''; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) errors[k] = 'Time as HH:MM (24-hour).'; else data[k] = v; }
    }
    if (data.opensAt && data.closesAt && String(data.opensAt) >= String(data.closesAt)) errors.closesAt = 'Closing time must be after opening time.';
    if (input.prepMinutes !== undefined) { const n = Number(input.prepMinutes); if (!Number.isInteger(n) || n < 0 || n > 600) errors.prepMinutes = 'Minutes between 0 and 600.'; else data.prepMinutes = n; }
    if (input.active !== undefined) { if (typeof input.active !== 'boolean') errors.active = 'true or false.'; else data.active = input.active; }
    if (Object.keys(errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please correct the highlighted fields.', fields: errors });
    let row;
    if (creating) {
      const count = await this.prisma.outlet.count({ where: { organizationId } });
      row = await this.prisma.outlet.create({ data: { organizationId, sortOrder: count, ...(data as { name: string; address: string }) } });
    } else {
      const existing = await this.prisma.outlet.findFirst({ where: { id: id!, organizationId } });
      if (!existing) throw new NotFoundException('Outlet not found');
      if (!Object.keys(data).length) throw new BadRequestException('Nothing to update.');
      row = await this.prisma.outlet.update({ where: { id: existing.id }, data });
    }
    this.invalidate(organizationId);
    log.info(creating ? 'menu.outlet_created' : 'menu.outlet_updated', { organizationId, outletId: row.id, actor });
    return row;
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
