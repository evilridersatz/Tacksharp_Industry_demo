# Tacksharp — GR Chicken (full source)

Complete source: NestJS API (`apps/api`), Next.js dashboard (`apps/web`), AI package (`packages/ai`), all tests.
This version: WhatsApp messages answered exactly once (durable inbound table), MVP demo catalogue seed, immediate
stock / unit / quantity checks with alternatives, priced cart with running total, unknown stock never claimed,
voice echo-window and language fixes, per-turn logs that explain `aiRequests: 0`, and a new dashboard page
"Carts, stock & messages". Details: `README.md`.

## Update an existing installation (keeps your data and settings)

```bash
cp <old folder>/apps/api/.env  Tacksharp-GR-Chicken/apps/api/.env     # keep your settings
cd Tacksharp-GR-Chicken
npm install
npm run db:generate
npm run build:ai
npx prisma migrate status --schema apps/api/prisma/schema.prisma      # see what is pending
npm run db:migrate:deploy        # additive: 20261015000000_whatsapp_inbound_messages (+ earlier ones if missing)
npm run seed:demo-inventory -- --dry-run      # shows target DB + what would change; writes nothing
npm run seed:demo-inventory                   # demo catalogue (refuses production; never deletes)
npm run build
npm run dev                      # API       -> http://localhost:3000  (stop the old one first)
npm run dev:web                  # Dashboard -> http://localhost:3001
```

Optional: `npm run seed:demo-inventory -- --hide-other-demo-products` marks the older demo products (Broiler,
Country, Skinless, Liver, Country Eggs) not for sale, so the bot offers only the new catalogue. Nothing is deleted.

Checks: `npm run check:config`, `npm run verify:restaurant`.

## Tests (never contact anyone)

```bash
npm test                                            # unit tests
TEST_DB_NAME=tacksharp_test npm test -w apps/api    # everything, on a SEPARATE test database (needs MySQL + Redis)
```
