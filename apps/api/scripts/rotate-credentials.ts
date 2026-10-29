/**
 * Re-encrypt every stored provider credential with the ACTIVE key (key rotation). Run on the server with its .env:
 *
 *   1. Generate a key:   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   2. Add it:           CREDENTIALS_KEYS="v1:<old>,v2:<new>"   CREDENTIALS_ACTIVE_KEY=v2   (restart the API)
 *   3. Re-encrypt:       npm run credentials:rotate            (add -- --dry-run to only count)
 *   4. When it reports 0 rows left on old keys, remove v1 from CREDENTIALS_KEYS and restart.
 *
 * Never prints secrets: only counts, organization ids and providers.
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';
import { open, parseKeyring, seal } from '../src/integrations/vault.js';

const dryRun = process.argv.includes('--dry-run');
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
  const ring = parseKeyring(process.env.CREDENTIALS_KEYS ?? '', process.env.CREDENTIALS_ACTIVE_KEY ?? '');
  if (ring.problem || !ring.active) throw new Error(ring.problem ?? 'No active key');
  const rows = await prisma.integrationCredential.findMany({ where: { secretCiphertext: { not: null }, NOT: { keyVersion: ring.active } } });
  console.log(`${rows.length} credential(s) not yet on key "${ring.active}".${dryRun ? ' (dry run)' : ''}`);
  let done = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const secrets = open(ring, r.organizationId, r.provider, { ciphertext: r.secretCiphertext ?? undefined, iv: r.secretIv ?? undefined, tag: r.secretTag ?? undefined, keyVersion: r.keyVersion ?? undefined });
      if (dryRun) { done++; continue; }
      const s = seal(ring, r.organizationId, r.provider, secrets);
      // Optimistic: only if nobody saved new credentials meanwhile.
      const u = await prisma.integrationCredential.updateMany({ where: { id: r.id, keyVersion: r.keyVersion }, data: { secretCiphertext: s.ciphertext, secretIv: s.iv, secretTag: s.tag, keyVersion: s.keyVersion } });
      done += u.count;
    } catch (e) {
      failed++;
      console.error(`  could not re-encrypt ${r.organizationId}/${r.provider}: ${(e as Error).name}${(e as Error).name === 'VaultUnavailableError' ? ` (${(e as Error).message})` : ''}`);
    }
  }
  console.log(`${dryRun ? 'Readable' : 'Re-encrypted'}: ${done}. Failed: ${failed}.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
