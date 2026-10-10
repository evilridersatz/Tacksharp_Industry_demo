/**
 * GR Chicken restaurant tenant with DEMO menu and outlets (safe to re-run; never touches other tenants).
 *
 *   npm run seed:gr-chicken -w apps/api
 *
 * Everything created here is marked isDemo = true and named "(Demo)": the prices, items and outlet
 * addresses are placeholders, NOT verified GR Chicken data. Replace them from the dashboard Menu
 * page (prices / availability) or by editing DEMO_MENU / DEMO_OUTLETS below and re-running.
 *
 * Optional environment (names only, values never printed):
 *   GR_ORGANIZATION_ID          default org_gr_chicken
 *   GR_ADMIN_EMAIL / GR_ADMIN_PASSWORD   creates or updates the dashboard login for this tenant
 *   GR_WEB_CHAT_KEY             public website-chat key (generated once if not set)
 *   GR_WHATSAPP_PHONE_NUMBER_ID maps this WhatsApp business number to GR Chicken
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { Prisma, PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: process.env.DB_NAME ?? 'tacksharp',
  }),
});

const organizationId = process.env.GR_ORGANIZATION_ID ?? 'org_gr_chicken';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const DEMO_OUTLETS = [
  {
    key: 'anna_nagar',
    name: 'GR Chicken Anna Nagar (Demo)',
    area: 'Anna Nagar',
    address: 'DEMO ADDRESS — replace with the verified Anna Nagar outlet address',
    phone: null,
    serviceAreas: ['anna nagar', 'kilpauk', 'aminjikarai', 'shenoy nagar', 'mogappair'],
    acceptsDelivery: true,
    deliveryFee: 30,
    minOrderValue: 150,
  },
  {
    key: 'velachery',
    name: 'GR Chicken Velachery (Demo)',
    area: 'Velachery',
    address: 'DEMO ADDRESS — replace with the verified Velachery outlet address',
    phone: null,
    serviceAreas: ['velachery', 'taramani', 'adambakkam', 'madipakkam', 'guindy'],
    acceptsDelivery: true,
    deliveryFee: 40,
    minOrderValue: 150,
  },
];

const DEMO_MENU: Array<{ category: string; items: Array<{ name: string; price: number; description?: string; aliases?: string; isVeg?: boolean }> }> = [
  {
    category: 'Grill & Tandoori',
    items: [
      { name: 'Grill Chicken Full', price: 480, description: 'Charcoal grilled whole chicken', aliases: 'full grill, grill full, full grill chicken, grilled chicken full' },
      { name: 'Grill Chicken Half', price: 260, description: 'Charcoal grilled half chicken', aliases: 'half grill, grill half, half grill chicken, grilled chicken half' },
      { name: 'Tandoori Chicken Half', price: 280, aliases: 'tandoori half, half tandoori' },
      { name: 'Chicken Tikka', price: 220, aliases: 'tikka' },
    ],
  },
  {
    category: 'Starters',
    items: [
      { name: 'Chicken 65', price: 180, description: 'Spicy deep-fried chicken', aliases: 'c65, chicken sixty five, 65' },
      { name: 'Pepper Chicken', price: 200, aliases: 'pepper chicken dry, chicken pepper' },
      { name: 'Chicken Lollipop', price: 190, aliases: 'lollipop, lollypop' },
    ],
  },
  {
    category: 'Biryani & Rice',
    items: [
      { name: 'Chicken Biryani', price: 220, description: 'Seeraga samba chicken biryani', aliases: 'biryani, briyani, chicken briyani, biriyani' },
      { name: 'Chicken Fried Rice', price: 170, aliases: 'fried rice, chicken rice' },
      { name: 'Egg Fried Rice', price: 140, aliases: 'egg rice' },
    ],
  },
  {
    category: 'Shawarma & Rolls',
    items: [
      { name: 'Chicken Shawarma Roll', price: 120, aliases: 'shawarma, shawarma roll, chicken shawarma' },
      { name: 'Shawarma Plate', price: 170, aliases: 'plate shawarma' },
    ],
  },
  {
    category: 'Breads',
    items: [
      { name: 'Parotta', price: 25, aliases: 'porotta, barotta, paratha' },
      { name: 'Butter Naan', price: 45, aliases: 'naan', isVeg: true },
    ],
  },
  {
    category: 'Drinks',
    items: [
      { name: 'Lime Soda', price: 50, aliases: 'lemon soda, soda', isVeg: true },
      { name: 'Soft Drink 500ml', price: 45, aliases: 'coke, pepsi, cool drink, cooldrink, soft drink', isVeg: true },
    ],
  },
];

async function main() {
  await prisma.organization.upsert({
    where: { id: organizationId },
    create: { id: organizationId, name: 'GR Chicken', vertical: 'restaurant' },
    update: { vertical: 'restaurant' },
  });

  for (const [i, o] of DEMO_OUTLETS.entries()) {
    const data = {
      organizationId,
      name: o.name,
      area: o.area,
      address: o.address,
      phone: o.phone,
      serviceAreas: o.serviceAreas,
      opensAt: '11:00',
      closesAt: '23:00',
      acceptsPickup: true,
      acceptsDelivery: o.acceptsDelivery,
      deliveryFee: new Prisma.Decimal(o.deliveryFee),
      minOrderValue: new Prisma.Decimal(o.minOrderValue),
      // Demo tenant: accept orders at any hour so the flow can be tested; staff still confirm every order.
      acceptOutsideHours: true,
      active: true,
      isDemo: true,
      sortOrder: i,
    };
    const id = `${organizationId}_outlet_${o.key}`;
    await prisma.outlet.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  let itemCount = 0;
  for (const [ci, c] of DEMO_MENU.entries()) {
    const category = await prisma.menuCategory.upsert({
      where: { organizationId_name: { organizationId, name: c.category } },
      create: { id: `${organizationId}_cat_${slug(c.category)}`, organizationId, name: c.category, sortOrder: ci },
      update: { sortOrder: ci },
    });
    for (const [ii, item] of c.items.entries()) {
      const existing = await prisma.menuItem.findUnique({ where: { organizationId_name: { organizationId, name: item.name } } });
      // Never overwrite a menu item someone has already verified (isDemo false) or edited in the dashboard.
      if (existing && !existing.isDemo) continue;
      const data = {
        organizationId,
        categoryId: category.id,
        name: item.name,
        description: item.description ?? null,
        aliases: item.aliases ?? null,
        isVeg: item.isVeg ?? false,
        isDemo: true,
        sortOrder: ii,
      };
      if (existing) await prisma.menuItem.update({ where: { id: existing.id }, data });
      else await prisma.menuItem.create({ data: { ...data, price: new Prisma.Decimal(item.price), available: true } });
      itemCount++;
    }
  }

  // Public website-chat key (public by design: it appears in the site's embed code).
  const existingKey = await prisma.organizationChannel.findFirst({ where: { organizationId, kind: 'web_chat_key' } });
  const chatKey = existingKey?.externalId ?? process.env.GR_WEB_CHAT_KEY ?? `grc_${randomBytes(12).toString('hex')}`;
  if (!existingKey) await prisma.organizationChannel.create({ data: { organizationId, kind: 'web_chat_key', externalId: chatKey } });

  const waId = process.env.GR_WHATSAPP_PHONE_NUMBER_ID;
  if (waId) {
    await prisma.organizationChannel.upsert({
      where: { kind_externalId: { kind: 'whatsapp_phone_number_id', externalId: waId } },
      create: { organizationId, kind: 'whatsapp_phone_number_id', externalId: waId },
      update: { organizationId },
    });
  }

  const email = process.env.GR_ADMIN_EMAIL;
  const password = process.env.GR_ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 10) throw new Error('GR_ADMIN_PASSWORD must be at least 10 characters.');
    const passwordHash = await hashPassword(password);
    const normalized = email.trim().toLowerCase();
    const other = await prisma.user.findUnique({ where: { email: normalized } });
    if (other && other.organizationId !== organizationId) throw new Error(`${normalized} already belongs to another organization; use a different GR_ADMIN_EMAIL.`);
    await prisma.user.upsert({
      where: { email: normalized },
      create: { organizationId, email: normalized, name: 'GR Chicken Admin', role: 'admin', passwordHash },
      update: { passwordHash },
    });
    console.log(`Dashboard login ready for ${normalized} (GR Chicken).`);
  } else {
    console.log('GR_ADMIN_EMAIL / GR_ADMIN_PASSWORD not set: no dashboard login created for GR Chicken.');
  }

  console.log(`Seeded GR Chicken (${organizationId}): ${DEMO_OUTLETS.length} demo outlets, ${itemCount} demo menu items.`);
  console.log(`Website chat: <dashboard>/chat/${chatKey}`);
  if (waId) console.log('WhatsApp business number mapped to GR Chicken.');
  console.log('All menu items and outlets are DEMO data until replaced with verified client information.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
