/**
 * Grant or revoke PLATFORM superadmin (Tacksharp staff) for an EXISTING user. This is the only way to create one:
 * public signup and organization admins can never grant it. Run on the server, with the server's .env:
 *
 *   npm run platform:admin -- grant  you@tacksharp.in
 *   npm run platform:admin -- revoke you@tacksharp.in
 *   npm run platform:admin -- list
 *
 * Every change is written to the audit log of the user's organization. Sessions of a revoked admin lose platform
 * access on their next request (the flag is read from the database on every platform request).
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';

const [action, emailArg] = process.argv.slice(2);
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
  if (action === 'list') {
    const rows = await prisma.user.findMany({ where: { isPlatformAdmin: true }, select: { email: true, organizationId: true, disabledAt: true } });
    for (const r of rows) console.log(`${r.email}  (${r.organizationId})${r.disabledAt ? '  DISABLED' : ''}`);
    if (!rows.length) console.log('No platform admins.');
    return;
  }
  if (!['grant', 'revoke'].includes(action ?? '') || !emailArg) {
    console.error('Usage: npm run platform:admin -- grant|revoke <email>   |   npm run platform:admin -- list');
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with that email. Create the login first (npm run user:create -- ${email} "<password>" "<name>" org_tacksharp_platform).`);
    process.exit(1);
  }
  const grant = action === 'grant';
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: grant } }),
    prisma.auditEvent.create({ data: { organizationId: user.organizationId, actor: 'script:platform-admin', entityType: 'user', entityId: user.id, action: grant ? 'platform_admin.granted' : 'platform_admin.revoked', data: {} } }),
  ]);
  console.log(`${grant ? 'Granted' : 'Revoked'} platform admin for ${email}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
