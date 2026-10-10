import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';
import type { CatalogItem } from './order-parse.js';

const CACHE_MS = 30_000;
const MAX_PRICE = 100_000;

export type MenuItemView = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  isVeg: boolean;
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
  serviceAreas: string[];
  opensAt: string;
  closesAt: string;
  acceptsPickup: boolean;
  acceptsDelivery: boolean;
  deliveryFee: number;
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

const money = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const splitAliases = (raw: string | null) => (raw ?? '').split(',').map((a) => a.trim()).filter(Boolean);

/** Menu and outlets of a restaurant tenant. Every query is scoped by organizationId. */
@Injectable()
export class CatalogService {
  private readonly cache = new Map<string, { at: number; value: Catalog }>();

  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string, fresh = false): Promise<Catalog> {
    const hit = this.cache.get(organizationId);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const [categories, items, outlets] = await Promise.all([
      this.prisma.menuCategory.findMany({ where: { organizationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.menuItem.findMany({ where: { organizationId }, include: { category: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.outlet.findMany({ where: { organizationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    ]);
    const value: Catalog = {
      categories: categories.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder })),
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        price: money(i.price),
        isVeg: i.isVeg,
        available: i.available,
        imageUrl: i.imageUrl,
        aliases: splitAliases(i.aliases),
        isDemo: i.isDemo,
        categoryId: i.categoryId,
        categoryName: i.category.name,
        sortOrder: i.sortOrder,
      })),
      outlets: outlets.map((o) => ({
        id: o.id,
        name: o.name,
        address: o.address,
        area: o.area,
        phone: o.phone,
        serviceAreas: Array.isArray(o.serviceAreas) ? (o.serviceAreas as unknown[]).map((a) => String(a).toLowerCase().trim()).filter(Boolean) : [],
        opensAt: o.opensAt,
        closesAt: o.closesAt,
        acceptsPickup: o.acceptsPickup,
        acceptsDelivery: o.acceptsDelivery,
        deliveryFee: money(o.deliveryFee),
        minOrderValue: money(o.minOrderValue),
        acceptOutsideHours: o.acceptOutsideHours,
        active: o.active,
        isDemo: o.isDemo,
      })),
    };
    this.cache.set(organizationId, { at: Date.now(), value });
    return value;
  }

  /** Items in the shape the message parser needs. Unavailable items are included so we can say "not available today". */
  async parserCatalog(organizationId: string): Promise<CatalogItem[]> {
    const c = await this.get(organizationId);
    return c.items.map((i) => ({ id: i.id, name: i.name, categoryId: i.categoryId, categoryName: i.categoryName, aliases: i.aliases, available: i.available }));
  }

  invalidate(organizationId: string) {
    this.cache.delete(organizationId);
  }

  /** Dashboard edit: price, availability, description, image, aliases, name, category. Validated on the server. */
  async updateItem(organizationId: string, itemId: string, patch: Record<string, unknown>, actor: string) {
    const item = await this.prisma.menuItem.findFirst({ where: { id: itemId, organizationId } });
    if (!item) throw new NotFoundException('Menu item not found');
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
      const created = await this.prisma.menuItem.create({ data: { ...(data as Prisma.MenuItemUncheckedCreateInput), organizationId } });
      this.invalidate(organizationId);
      log.info('menu.item_created', { organizationId, itemId: created.id, actor });
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException('An item with this name already exists.');
      }
      throw error;
    }
  }

  private async validateItemInput(organizationId: string, input: Record<string, unknown>, creating: boolean) {
    const data: Record<string, unknown> = {};
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

    if (input.name !== undefined || creating) {
      const name = str(input.name, 120);
      if (!name) throw new BadRequestException('Name is required.');
      data.name = name;
    }
    if (input.price !== undefined || creating) {
      const price = typeof input.price === 'string' ? Number(input.price) : input.price;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > MAX_PRICE) {
        throw new BadRequestException(`Price must be a number between 1 and ${MAX_PRICE}.`);
      }
      if (Math.round(price * 100) !== price * 100) throw new BadRequestException('Price can have at most 2 decimals.');
      data.price = new Prisma.Decimal(price.toFixed(2));
    }
    if (input.available !== undefined) {
      if (typeof input.available !== 'boolean') throw new BadRequestException('available must be true or false.');
      data.available = input.available;
    }
    if (input.isVeg !== undefined) {
      if (typeof input.isVeg !== 'boolean') throw new BadRequestException('isVeg must be true or false.');
      data.isVeg = input.isVeg;
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
