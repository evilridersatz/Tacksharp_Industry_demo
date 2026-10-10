/**
 * Create or reset a dashboard login.
 *   npm run user:create -- email@business.com "Strong password here" "Name" [organizationId]
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';

const [email, password, name, org] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run user:create -- email password "Name" [organizationId]');
  process.exit(1);
}
const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: process.env.DB_NAME ?? 'tacksharp',
  }),
});
const organizationId = org ?? process.env.DEFAULT_ORGANIZATION_ID ?? 'org_real_estate_001';

hashPassword(password)
  .then((passwordHash) =>
    prisma.user.upsert({
      where: { email: email.toLowerCase() },
      create: { email: email.toLowerCase(), name, passwordHash, organizationId, role: 'admin' },
      update: { passwordHash, name, organizationId },
    }),
  )
  .then((u) => console.log(`Login ready: ${u.email} (organization ${u.organizationId})`))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
