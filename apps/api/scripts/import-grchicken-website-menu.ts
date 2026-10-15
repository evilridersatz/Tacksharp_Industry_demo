import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: process.env.DB_NAME ?? 'tacksharp_grchicken',
  }),
});

const organizationId = process.env.GR_ORGANIZATION_ID ?? 'org_gr_chicken';

const catalogue = [
  {
    category: 'Broiler Chicken',
    items: [
      { name: 'Chicken Curry Cut', aliases: 'chicken curry cut, curry cut chicken, கோழி கறி துண்டுகள்', unit: 'kg' },
      { name: 'Whole Chicken', aliases: 'whole chicken, full chicken, முழு கோழி', unit: 'kg' },
      { name: 'Boneless Chicken', aliases: 'boneless chicken, boneless, எலும்பில்லா கோழி', unit: 'kg' },
      { name: 'Chicken Leg Pieces', aliases: 'chicken leg, leg pieces, கோழி கால் துண்டுகள்', unit: 'kg' },
      { name: 'Chicken Wings', aliases: 'chicken wings, wings', unit: 'kg' },
      { name: 'Chicken Liver', aliases: 'chicken liver, liver, ஈரல்', unit: 'kg' },
    ],
  },
  {
    category: 'Speciality birds',
    items: [
      { name: 'Country Chicken / நாட்டுக்கோழி', aliases: 'country chicken, nattu kozhi, நாட்டுக்கோழி', unit: 'kg' },
      { name: 'Kadaknath / கருங்கோழி', aliases: 'kadaknath, karungkozhi, கருங்கோழி', unit: 'kg' },
      { name: 'Quail / காடை', aliases: 'quail, kaadai, காடை', unit: 'kg' },
      { name: 'Turkey / வான்கோழி', aliases: 'turkey, vaan kozhi, வான்கோழி', unit: 'kg' },
    ],
  },
  {
    category: 'Eggs',
    items: [
      { name: 'Country Chicken Eggs / நாட்டுக்கோழி முட்டை', aliases: 'country eggs, country chicken eggs, நாட்டுக்கோழி முட்டை', unit: 'piece' },
      { name: 'Farm Eggs / முட்டை', aliases: 'farm eggs, eggs, egg, முட்டை', unit: 'piece' },
    ],
  },
];

async function main() {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });

  if (!org) {
    throw new Error(
      `Organization ${organizationId} does not exist. Run the existing GR Chicken tenant seed first.`,
    );
  }

  // Remove unverified demo prices and hide demo items until prices are confirmed.
  // Verified (isDemo=false) products are not changed by this operation.
  await prisma.menuItem.updateMany({
    where: { organizationId, isDemo: true },
    data: { price: new Prisma.Decimal(0), available: false },
  });

  let inserted = 0;
  let updatedDemo = 0;
  let preservedVerified = 0;

  for (const [categoryIndex, group] of catalogue.entries()) {
    const category = await prisma.menuCategory.upsert({
      where: {
        organizationId_name: { organizationId, name: group.category },
      },
      create: {
        organizationId,
        name: group.category,
        sortOrder: categoryIndex,
      },
      update: { sortOrder: categoryIndex },
    });

    for (const [itemIndex, item] of group.items.entries()) {
      const existing = await prisma.menuItem.findUnique({
        where: {
          organizationId_name: { organizationId, name: item.name },
        },
      });

      if (existing && !existing.isDemo) {
        // Never overwrite a price or settings someone has verified.
        preservedVerified++;
        continue;
      }

      const data = {
        organizationId,
        categoryId: category.id,
        name: item.name,
        description: 'Listed on the official GR Chicken website. Price requires confirmation.',
        aliases: item.aliases,
        unit: item.unit,
        cutOptions: [] as Prisma.InputJsonValue,
        minQty: new Prisma.Decimal(item.unit === 'piece' ? 1 : 0.5),
        maxQty: new Prisma.Decimal(item.unit === 'piece' ? 60 : 10),
        qtyStep: new Prisma.Decimal(item.unit === 'piece' ? 1 : 0.25),
        price: new Prisma.Decimal(0),
        available: false,
        isDemo: true,
        sortOrder: itemIndex,
      };

      if (existing) {
        await prisma.menuItem.update({
          where: { id: existing.id },
          data,
        });
        updatedDemo++;
      } else {
        await prisma.menuItem.create({ data });
        inserted++;
      }
    }
  }

  console.log('GR Chicken website catalogue import completed.');
  console.log(`Organization: ${organizationId}`);
  console.log(`New products: ${inserted}`);
  console.log(`Demo products updated: ${updatedDemo}`);
  console.log(`Verified products preserved: ${preservedVerified}`);
  console.log('Unverified-price products are unavailable until prices are confirmed.');
}

main()
  .catch((error) => {
    console.error('Menu import failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
