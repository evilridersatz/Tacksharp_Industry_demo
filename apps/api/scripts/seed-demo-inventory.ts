/**
 * DEMO inventory for the MVP: the products, prices and stock in scripts/data/demo-inventory.json, for one
 * restaurant organization (default org_gr_chicken).
 *
 *   npm run seed:demo-inventory -w apps/api                      apply
 *   npm run seed:demo-inventory -w apps/api -- --dry-run         show what would change, write nothing
 *   ... -- --org org_other                                       another restaurant organization
 *   ... -- --hide-other-demo-products                            mark OTHER demo products not-for-sale (never deletes)
 *
 * Safe by design:
 *  - Prints the target database (host, port, name, user — never the password) before doing anything.
 *  - Checks the schema has the inventory columns/tables, and the migration history when it is recorded.
 *  - Refuses a production target (NODE_ENV=production, or a database name containing "prod") unless BOTH
 *    --allow-production is passed AND CONFIRM_DEMO_SEED_DB equals the database name.
 *  - Repeatable: the same file applied twice changes nothing the second time (no duplicate products or movements).
 *  - Preserves data: never deletes; a product with isDemo = false (real / edited by staff) is never touched;
 *    stock that staff entered (stockIsDemo = false) is never overwritten. Every stock change is an
 *    InventoryMovement with reason "demo_seed".
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { Prisma, PrismaClient } from '@prisma/client';
import { alertLevel, stockStatus } from '../src/restaurant/inventory.js';

export type DemoProduct = { name: string; category: string; price: number; unit: 'kg' | 'piece'; stock: number | null; lowStockAt?: number; minQty?: number; maxQty?: number; qtyStep?: number; cuts?: string[]; aliases?: string };
export type DemoInventory = { categories: Array<{ name: string; sortOrder?: number }>; products: DemoProduct[] };

export const INVENTORY_MIGRATION = '20261014000000_restaurant_inventory';

export function loadDemoInventory(path = join(dirname(fileURLToPath(import.meta.url)), 'data', 'demo-inventory.json')): DemoInventory {
  const data = JSON.parse(readFileSync(path, 'utf8')) as DemoInventory;
  validateDemoInventory(data);
  return data;
}

/** The file is edited by hand: reject anything that would put a nonsense price or stock into the database. */
export function validateDemoInventory(data: DemoInventory) {
  const errors: string[] = [];
  const cats = new Set(data.categories?.map((c) => c.name));
  const names = new Set<string>();
  for (const p of data.products ?? []) {
    const at = `product "${p.name}"`;
    if (!p.name?.trim()) errors.push('a product has no name');
    if (names.has(p.name)) errors.push(`${at} is listed twice`);
    names.add(p.name);
    if (!cats.has(p.category)) errors.push(`${at}: category "${p.category}" is not in categories`);
    if (!(p.unit === 'kg' || p.unit === 'piece')) errors.push(`${at}: unit must be "kg" or "piece"`);
    if (!(typeof p.price === 'number' && p.price > 0 && p.price < 100_000)) errors.push(`${at}: price must be a positive number`);
    if (p.stock !== null && !(typeof p.stock === 'number' && p.stock >= 0 && p.stock <= 100_000)) errors.push(`${at}: stock must be 0–100000 or null (unknown)`);
    if (p.unit === 'piece' && p.stock !== null && !Number.isInteger(p.stock)) errors.push(`${at}: piece stock must be a whole number`);
    if ((p.minQty ?? 0.5) > (p.maxQty ?? 10)) errors.push(`${at}: minQty is above maxQty`);
  }
  if (!data.products?.length) errors.push('no products');
  if (errors.length) throw new Error(`demo-inventory.json is not valid:\n - ${errors.join('\n - ')}`);
}

export type Target = { host: string; port: number; database: string; user: string };
export const targetFromEnv = (env = process.env): Target => ({ host: env.DB_HOST ?? 'localhost', port: Number(env.DB_PORT ?? 3306), database: env.DB_NAME ?? 'tacksharp', user: env.DB_USER ?? 'root' });

/** Refuse production unless explicitly allowed twice (flag + the database name typed out). */
export function productionGuard(target: Target, opts: { allowProduction?: boolean }, env = process.env): string | null {
  const production = env.NODE_ENV === 'production' || /prod/i.test(target.database);
  if (!production) return null;
  if (opts.allowProduction && env.CONFIRM_DEMO_SEED_DB === target.database) return null;
  return `Refusing to seed DEMO inventory into what looks like a production database (${target.database}${env.NODE_ENV === 'production' ? ', NODE_ENV=production' : ''}). If you really mean it, pass --allow-production AND set CONFIRM_DEMO_SEED_DB=${target.database}.`;
}

/** The schema must have the inventory columns; the migration history is checked too when it is recorded. */
export async function checkSchema(client: PrismaClient): Promise<{ ok: boolean; problems: string[]; history: string }> {
  const problems: string[] = [];
  const cols = await client.$queryRaw<Array<{ c: string }>>`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'MenuItem'`;
  const have = new Set(cols.map((r) => r.c));
  for (const c of ['stockQty', 'lowStockThreshold', 'stockIsDemo', 'stockAlertLevel']) if (!have.has(c)) problems.push(`MenuItem.${c} is missing`);
  const tables = await client.$queryRaw<Array<{ t: string }>>`SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('InventoryMovement', '_prisma_migrations')`;
  const tableSet = new Set(tables.map((r) => r.t));
  if (!tableSet.has('InventoryMovement')) problems.push('table InventoryMovement is missing');
  let history = 'not recorded in this database (no _prisma_migrations table) — schema checked directly';
  if (tableSet.has('_prisma_migrations')) {
    const rows = await client.$queryRaw<Array<{ done: number | bigint; rolled: number | bigint }>>`SELECT finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rolled FROM _prisma_migrations WHERE migration_name = ${INVENTORY_MIGRATION}`;
    const applied = rows.some((r) => Number(r.done) === 1 && Number(r.rolled) === 0);
    history = applied ? `${INVENTORY_MIGRATION} applied` : `${INVENTORY_MIGRATION} NOT applied`;
    if (!applied) problems.push(`migration ${INVENTORY_MIGRATION} is not applied (run: npx prisma migrate deploy)`);
  }
  if (problems.length) problems.push('Run the migrations first: npx prisma migrate status / npx prisma migrate deploy');
  return { ok: problems.length === 0, problems, history };
}

export type SeedChange = { product: string; action: 'created' | 'updated' | 'unchanged' | 'skipped' | 'hidden'; note?: string };

export async function seedDemoInventory(client: PrismaClient, opts: { organizationId: string; data?: DemoInventory; dryRun?: boolean; hideOtherDemoProducts?: boolean; now?: Date }) {
  const data = opts.data ?? loadDemoInventory();
  validateDemoInventory(data);
  const org = await client.organization.findUnique({ where: { id: opts.organizationId } });
  if (!org) throw new Error(`Organization ${opts.organizationId} does not exist. Create it first (npm run seed:gr-chicken), or pass --org.`);
  if (org.vertical !== 'restaurant') throw new Error(`Organization ${opts.organizationId} is not a restaurant (vertical=${org.vertical}). Nothing was changed.`);
  const now = opts.now ?? new Date();
  const changes: SeedChange[] = [];
  const dec = (n: number) => new Prisma.Decimal(n.toFixed(3));

  const categoryIds = new Map<string, string>();
  for (const c of data.categories) {
    const existing = await client.menuCategory.findUnique({ where: { organizationId_name: { organizationId: org.id, name: c.name } } });
    if (existing) categoryIds.set(c.name, existing.id);
    else if (!opts.dryRun) categoryIds.set(c.name, (await client.menuCategory.create({ data: { organizationId: org.id, name: c.name, sortOrder: c.sortOrder ?? 0 } })).id);
    else categoryIds.set(c.name, `(new ${c.name})`);
  }

  for (const [index, p] of data.products.entries()) {
    const existing = await client.menuItem.findUnique({ where: { organizationId_name: { organizationId: org.id, name: p.name } } });
    if (existing && !existing.isDemo) {
      changes.push({ product: p.name, action: 'skipped', note: 'a real (non-demo) product has this name — left unchanged' });
      continue;
    }
    const fields = {
      price: new Prisma.Decimal(p.price.toFixed(2)),
      unit: p.unit,
      cutOptions: (p.cuts ?? []) as Prisma.InputJsonValue,
      minQty: dec(p.minQty ?? (p.unit === 'piece' ? 1 : 0.5)),
      maxQty: dec(p.maxQty ?? (p.unit === 'piece' ? 60 : 10)),
      qtyStep: dec(p.qtyStep ?? (p.unit === 'piece' ? 1 : 0.25)),
      aliases: p.aliases ?? null,
    };
    const wantStock = p.stock === null ? null : dec(p.stock);
    const wantLow = p.lowStockAt === undefined ? null : dec(p.lowStockAt);
    // Stock staff entered is real: only empty or demo stock is (re)set.
    const stockWritable = !existing || existing.stockQty === null || existing.stockIsDemo;
    const stockChanges = stockWritable && !(existing && sameDec(existing.stockQty, wantStock) && sameDec(existing.lowStockThreshold, wantLow));
    const fieldChanges = !existing || !sameDec(existing.price, fields.price) || existing.unit !== fields.unit || JSON.stringify(existing.cutOptions) !== JSON.stringify(fields.cutOptions) || !sameDec(existing.minQty, fields.minQty) || !sameDec(existing.maxQty, fields.maxQty) || !sameDec(existing.qtyStep, fields.qtyStep) || (existing.aliases ?? null) !== fields.aliases || !existing.available;
    if (!fieldChanges && !stockChanges) {
      changes.push({ product: p.name, action: 'unchanged', note: stockWritable ? undefined : 'stock entered by staff — kept' });
      continue;
    }
    changes.push({ product: p.name, action: existing ? 'updated' : 'created', note: !stockWritable ? 'stock entered by staff — kept' : undefined });
    if (opts.dryRun) continue;
    const minQty = fields.minQty;
    const status = stockStatus({ stockQty: wantStock, lowStockThreshold: wantLow, minQty });
    const stockData = stockChanges ? { stockQty: wantStock, lowStockThreshold: wantLow, stockIsDemo: wantStock !== null, stockUpdatedAt: now, stockAlertLevel: alertLevel(status) } : {};
    await client.$transaction(async (tx) => {
      const item = existing
        ? await tx.menuItem.update({ where: { id: existing.id }, data: { ...fields, available: true, ...stockData } })
        : await tx.menuItem.create({ data: { organizationId: org.id, categoryId: categoryIds.get(p.category)!, name: p.name, isDemo: true, available: true, sortOrder: index + 1, description: 'Demo product (sample price and stock)', ...fields, ...stockData } });
      if (stockChanges && wantStock !== null) {
        await tx.inventoryMovement.create({ data: { organizationId: org.id, menuItemId: item.id, delta: wantStock.minus(existing?.stockQty ?? 0), balanceAfter: wantStock, reason: 'demo_seed', actor: 'seed:demo-inventory' } });
      }
    });
  }

  if (opts.hideOtherDemoProducts) {
    const others = await client.menuItem.findMany({ where: { organizationId: org.id, isDemo: true, available: true, name: { notIn: data.products.map((p) => p.name) } } });
    for (const o of others) {
      changes.push({ product: o.name, action: 'hidden', note: 'other demo product — marked not for sale (not deleted)' });
      if (!opts.dryRun) await client.menuItem.update({ where: { id: o.id }, data: { available: false } });
    }
  } else {
    const others = await client.menuItem.count({ where: { organizationId: org.id, isDemo: true, available: true, name: { notIn: data.products.map((p) => p.name) } } });
    if (others) changes.push({ product: `${others} other demo product(s)`, action: 'unchanged', note: 'still for sale; pass --hide-other-demo-products to mark them not for sale' });
  }
  return { organizationId: org.id, changes };
}

function sameDec(a: Prisma.Decimal | null | undefined, b: Prisma.Decimal | null | undefined) {
  if (a == null || b == null) return a == null && b == null;
  return new Prisma.Decimal(a).equals(b);
}

// ------------------------------------------------------------------------------------------- CLI
if (process.argv[1] && /seed-demo-inventory\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const orgArg = args[args.indexOf('--org') + 1];
  const organizationId = args.includes('--org') && orgArg ? orgArg : process.env.GR_ORGANIZATION_ID ?? 'org_gr_chicken';
  const target = targetFromEnv();
  console.log(`Target database: ${target.database} on ${target.host}:${target.port} as ${target.user} (password not shown)`);
  console.log(`Organization: ${organizationId}${flag('--dry-run') ? '   [DRY RUN — nothing will be written]' : ''}`);
  const refused = productionGuard(target, { allowProduction: flag('--allow-production') });
  if (refused) {
    console.error(refused);
    process.exit(2);
  }
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: target.host, port: target.port, user: target.user, password: process.env.DB_PASSWORD ?? 'password', database: target.database }) });
  (async () => {
    const schema = await checkSchema(prisma);
    console.log(`Migration history: ${schema.history}`);
    if (!schema.ok) {
      console.error(`Schema not ready:\n - ${schema.problems.join('\n - ')}`);
      process.exitCode = 3;
      return;
    }
    const r = await seedDemoInventory(prisma, { organizationId, dryRun: flag('--dry-run'), hideOtherDemoProducts: flag('--hide-other-demo-products') });
    for (const c of r.changes) console.log(`  ${c.action.padEnd(9)} ${c.product}${c.note ? ` — ${c.note}` : ''}`);
    console.log('All seeded products and stock are DEMO data (isDemo / stockIsDemo), shown as demo on the dashboard and to customers.');
  })()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
