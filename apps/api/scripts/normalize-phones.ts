/**
 * One-time fix for existing data: rewrites every Customer.phone to the single
 * normalized format (e.g. "919876543210") the app now uses.
 * Duplicates (same person stored twice in different formats) are REPORTED, not merged.
 *   npm run fix:phones               -> dry run (shows what would change)
 *   npm run fix:phones -- --apply    -> write changes
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';
import { normalizePhone } from '../src/common/phone.js';

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: process.env.DB_NAME ?? 'tacksharp',
  }),
});

async function main() {
  const customers = await prisma.customer.findMany({ where: { phone: { not: null } } });
  const seen = new Map<string, string>();
  let changed = 0;
  for (const c of customers) {
    const normalized = normalizePhone(c.phone);
    if (!normalized) {
      console.log(`INVALID    ${c.id}  "${c.phone}"`);
      continue;
    }
    const key = `${c.organizationId}:${normalized}`;
    const other = seen.get(key);
    if (other) {
      console.log(`DUPLICATE  ${c.id} and ${other} are both ${normalized} - merge manually`);
      continue;
    }
    seen.set(key, c.id);
    if (normalized !== c.phone) {
      console.log(`${apply ? 'UPDATED' : 'WOULD UPDATE'}  ${c.id}  "${c.phone}" -> "${normalized}"`);
      if (apply) await prisma.customer.update({ where: { id: c.id }, data: { phone: normalized } });
      changed++;
    }
  }
  console.log(`${changed} phone(s) ${apply ? 'updated' : 'need updating. Run again with -- --apply'}.`);
}

main().finally(() => prisma.$disconnect());
