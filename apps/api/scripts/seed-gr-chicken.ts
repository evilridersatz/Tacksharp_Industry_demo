/**
 * GR Chicken restaurant tenant with DEMO products, shop and the ₹50 website offer (safe to re-run;
 * never touches other tenants).
 *
 *   npm run seed:gr-chicken -w apps/api
 *
 * Products, per-kg prices and the shop address created here are marked isDemo = true: they are
 * placeholders, NOT verified GR Chicken data. Replace them on the dashboard Products page (prices,
 * cuts, availability) or edit DEMO_PRODUCTS / DEMO_SHOP below and re-run.
 *
 * Optional environment (names only, values never printed except the new website key, once):
 *   GR_ORGANIZATION_ID             default org_gr_chicken
 *   GR_ADMIN_EMAIL / GR_ADMIN_PASSWORD   dashboard login for this tenant
 *   GR_WHATSAPP_PHONE_NUMBER_ID    Meta phone_number_id of GR Chicken's WhatsApp number (routes webhooks here)
 *   GR_WHATSAPP_DISPLAY_NUMBER     the same number as customers dial it, e.g. 919876543210 (for the wa.me claim link)
 *   GR_OFFER_TEMPLATE_NAME         approved WhatsApp template that opens the offer chat outside the 24h window
 *   GR_OFFER_AMOUNT                default 50
 */
import 'dotenv/config';
import { randomBytes, createHash } from 'node:crypto';
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

const DEMO_SHOP = {
  key: 'main',
  name: 'GR Chicken Shop (Demo)',
  area: null as string | null,
  address: 'DEMO ADDRESS — replace with the verified GR Chicken shop address',
  phone: null as string | null,
  opensAt: '07:00',
  closesAt: '21:00',
  prepMinutes: 30,
};

const CURRY = 'Curry cut';
const BIRYANI = 'Biryani cut';
const FRY = 'Fry cut';
const WHOLE = 'Whole';

const DEMO_PRODUCTS: Array<{
  category: string;
  items: Array<{ name: string; price: number; unit?: 'kg' | 'piece'; cuts?: string[]; aliases: string; description?: string; minQty?: number; maxQty?: number; qtyStep?: number }>;
}> = [
  {
    category: 'Chicken',
    items: [
      { name: 'Broiler Chicken', price: 220, cuts: [CURRY, BIRYANI, FRY, WHOLE], aliases: 'broiler, broiler chicken, chicken, kozhi, koli, kozhi kari, skin chicken, கோழி, பிராய்லர், சிக்கன்', description: 'Fresh broiler, with skin' },
      { name: 'Skinless Chicken', price: 260, cuts: [CURRY, BIRYANI, FRY], aliases: 'skinless, skin less, without skin, skin illama, skin illamal, ஸ்கின்லெஸ்', description: 'Broiler, skin removed' },
      { name: 'Country Chicken', price: 450, cuts: [CURRY, BIRYANI, WHOLE], aliases: 'country, country chicken, nattu kozhi, naatu kozhi, nattu koli, naatu koli, nattukozhi, நாட்டு கோழி, நாட்டுக்கோழி', description: 'Nattu kozhi' },
      { name: 'Boneless Chicken', price: 380, aliases: 'boneless, bone less, boneless chicken, போன்லெஸ்', minQty: 0.25 },
    ],
  },
  {
    category: 'Parts',
    items: [
      { name: 'Chicken Wings', price: 240, aliases: 'wings, wing, chicken wings', minQty: 0.25 },
      { name: 'Chicken Liver', price: 160, aliases: 'liver, eeral, ஈரல், chicken liver', minQty: 0.25 },
    ],
  },
  {
    category: 'Eggs',
    items: [{ name: 'Country Eggs', price: 12, unit: 'piece', aliases: 'eggs, egg, muttai, nattu muttai, முட்டை, நாட்டு முட்டை', minQty: 1, maxQty: 60, qtyStep: 1 }],
  },
];

async function main() {
  await prisma.organization.upsert({
    where: { id: organizationId },
    create: { id: organizationId, name: 'GR Chicken', vertical: 'restaurant' },
    update: { vertical: 'restaurant' },
  });

  const shopId = `${organizationId}_outlet_${DEMO_SHOP.key}`;
  const shopData = {
    organizationId,
    name: DEMO_SHOP.name,
    area: DEMO_SHOP.area,
    address: DEMO_SHOP.address,
    phone: DEMO_SHOP.phone,
    opensAt: DEMO_SHOP.opensAt,
    closesAt: DEMO_SHOP.closesAt,
    prepMinutes: DEMO_SHOP.prepMinutes,
    minOrderValue: new Prisma.Decimal(0),
    // Demo tenant: accept pickup times at any hour so the flow can be tested; staff still confirm every order.
    acceptOutsideHours: true,
    active: true,
    isDemo: true,
  };
  const existingShop = await prisma.outlet.findUnique({ where: { id: shopId } });
  if (!existingShop) await prisma.outlet.create({ data: { id: shopId, ...shopData } });
  else if (existingShop.isDemo) await prisma.outlet.update({ where: { id: shopId }, data: shopData });

  let itemCount = 0;
  for (const [ci, c] of DEMO_PRODUCTS.entries()) {
    const category = await prisma.menuCategory.upsert({
      where: { organizationId_name: { organizationId, name: c.category } },
      create: { id: `${organizationId}_cat_${slug(c.category)}`, organizationId, name: c.category, sortOrder: ci },
      update: { sortOrder: ci },
    });
    for (const [ii, item] of c.items.entries()) {
      const existing = await prisma.menuItem.findUnique({ where: { organizationId_name: { organizationId, name: item.name } } });
      // Never overwrite a product someone has verified (isDemo false).
      if (existing && !existing.isDemo) continue;
      const data = {
        organizationId,
        categoryId: category.id,
        name: item.name,
        description: item.description ?? null,
        aliases: item.aliases,
        unit: item.unit ?? 'kg',
        cutOptions: item.cuts ?? [],
        minQty: new Prisma.Decimal(item.minQty ?? 0.5),
        maxQty: new Prisma.Decimal(item.maxQty ?? 10),
        qtyStep: new Prisma.Decimal(item.qtyStep ?? 0.25),
        isDemo: true,
        sortOrder: ii,
      };
      if (existing) await prisma.menuItem.update({ where: { id: existing.id }, data });
      else await prisma.menuItem.create({ data: { ...data, price: new Prisma.Decimal(item.price), available: true } });
      itemCount++;
    }
  }

  const amount = Number(process.env.GR_OFFER_AMOUNT ?? 50);
  await prisma.offerCampaign.upsert({
    where: { organizationId_code: { organizationId, code: 'GR50' } },
    create: {
      organizationId,
      code: 'GR50',
      name: `Website order ₹${amount} off`,
      amount: new Prisma.Decimal(amount),
      minOrderValue: new Prisma.Decimal(0),
      validDays: 7,
      templateName: process.env.GR_OFFER_TEMPLATE_NAME || null,
      active: true,
    },
    update: process.env.GR_OFFER_TEMPLATE_NAME ? { templateName: process.env.GR_OFFER_TEMPLATE_NAME } : {},
  });

  const waId = process.env.GR_WHATSAPP_PHONE_NUMBER_ID;
  if (waId) {
    await prisma.organizationChannel.upsert({
      where: { kind_externalId: { kind: 'whatsapp_phone_number_id', externalId: waId } },
      create: { organizationId, kind: 'whatsapp_phone_number_id', externalId: waId },
      update: { organizationId },
    });
  }
  const display = (process.env.GR_WHATSAPP_DISPLAY_NUMBER ?? '').replace(/\D/g, '');
  if (display) {
    await prisma.organizationChannel.deleteMany({ where: { organizationId, kind: 'whatsapp_display_number' } });
    await prisma.organizationChannel.create({ data: { organizationId, kind: 'whatsapp_display_number', externalId: display } });
  }

  // Website → offer API key. Only the hash is stored; the key is printed once, on creation.
  const hasKey = await prisma.organizationChannel.findFirst({ where: { organizationId, kind: 'website_api_key' } });
  let newKey: string | undefined;
  if (!hasKey) {
    newKey = `grk_${randomBytes(24).toString('hex')}`;
    await prisma.organizationChannel.create({ data: { organizationId, kind: 'website_api_key', externalId: createHash('sha256').update(newKey).digest('hex') } });
  }

  const email = process.env.GR_ADMIN_EMAIL;
  const password = process.env.GR_ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 10) throw new Error('GR_ADMIN_PASSWORD must be at least 10 characters.');
    const normalized = email.trim().toLowerCase();
    const other = await prisma.user.findUnique({ where: { email: normalized } });
    if (other && other.organizationId !== organizationId) throw new Error(`${normalized} already belongs to another organization; use a different GR_ADMIN_EMAIL.`);
    await prisma.user.upsert({
      where: { email: normalized },
      create: { organizationId, email: normalized, name: 'GR Chicken Admin', role: 'admin', passwordHash: await hashPassword(password) },
      update: { passwordHash: await hashPassword(password) },
    });
    console.log(`Dashboard login ready for ${normalized} (GR Chicken).`);
  } else {
    console.log('GR_ADMIN_EMAIL / GR_ADMIN_PASSWORD not set: no dashboard login created for GR Chicken.');
  }

  console.log(`Seeded GR Chicken (${organizationId}): 1 demo shop, ${itemCount} demo products, ₹${amount} offer (code GR50).`);
  if (newKey) console.log(`Website offer API key (shown once, store it in the website's server config): ${newKey}`);
  if (waId) console.log('WhatsApp business number mapped to GR Chicken.');
  if (!display) console.log('Tip: set GR_WHATSAPP_DISPLAY_NUMBER to get the wa.me claim link on the dashboard.');
  console.log('Products, prices and the shop address are DEMO data until replaced with verified client information.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
