/**
 * Creates the default organization and sample Chennai properties (safe to re-run).
 *   npm run seed -w apps/api
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';
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

const organizationId = process.env.DEFAULT_ORGANIZATION_ID ?? 'org_real_estate_001';
const organizationName = process.env.DEFAULT_ORGANIZATION_NAME ?? 'Tacksharp Realty';

const properties = [
  { id: 'prop_porur_green_valley', name: 'Green Valley Residency', location: 'Porur', type: 'Apartment', bhk: 2, price: 7_200_000 },
  { id: 'prop_porur_lake_view', name: 'Lake View Towers', location: 'Porur', type: 'Apartment', bhk: 3, price: 9_500_000 },
  { id: 'prop_omr_sunrise', name: 'Sunrise Heights', location: 'OMR', type: 'Apartment', bhk: 2, price: 6_800_000 },
  { id: 'prop_tambaram_palm', name: 'Palm Meadows', location: 'Tambaram', type: 'Villa', bhk: 3, price: 12_500_000 },
  { id: 'prop_velachery_metro', name: 'Metro Square', location: 'Velachery', type: 'Apartment', bhk: 2, price: 8_400_000 },
  { id: 'prop_guduvanchery_plot', name: 'Green Acres Plots', location: 'Guduvanchery', type: 'Plot', bhk: 0, price: 3_500_000 },
];

async function main() {
  await prisma.organization.upsert({
    where: { id: organizationId },
    create: { id: organizationId, name: organizationName },
    update: { name: organizationName },
  });
  for (const p of properties) {
    await prisma.property.upsert({
      where: { id: p.id },
      create: { ...p, organizationId },
      update: {},
    });
  }
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    const passwordHash = await hashPassword(password);
    await prisma.user.upsert({
      where: { email },
      create: { organizationId, email, name: process.env.ADMIN_NAME ?? 'Admin', passwordHash, role: 'admin' },
      update: { passwordHash, name: process.env.ADMIN_NAME ?? 'Admin', organizationId },
    });
    console.log(`Dashboard login ready for ${email}.`);
  } else {
    console.log('No ADMIN_EMAIL / ADMIN_PASSWORD in .env: no dashboard login created (use "npm run user:create").');
  }
  console.log(`Seeded organization "${organizationName}" (${organizationId}) and ${properties.length} properties.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
