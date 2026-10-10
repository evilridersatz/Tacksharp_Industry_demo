# Tacksharp

AI employees platform: one codebase, one database, several businesses (tenants). Each tenant runs one product:

| Vertical | Tenant example | What the AI does |
|---|---|---|
| `real_estate` (default) | Tacksharp Realty | Lead follow-up on WhatsApp + AI voice calls, CRM, site-visit booking |
| `restaurant` | **GR Chicken** (MVP) | Menu questions and food ordering on the website chat and WhatsApp, staff dashboard for orders |

The vertical is stored on `Organization.vertical`. Incoming messages are routed by it in `AiService.generateResponse`; the dashboard shows the matching navigation after login.

## Architecture

```
apps/api        NestJS 12 API (Prisma 7 + MySQL/MariaDB, Redis/BullMQ workers)
apps/web        Next.js 16 dashboard (React 19, Tailwind 4) + public website chat
packages/ai     Agent definitions on the OpenAI Agents SDK (real estate + restaurant)
```

- **Auth / tenancy** – signed session cookie (or `Authorization: Bearer`), global guard; every query takes the organization from the session (`@Org()`), never from the request. Webhooks resolve the tenant from the receiving identifier (`OrganizationChannel`: WhatsApp phone_number_id, Plivo number, Meta page id, website chat key).
- **Conversations** – `Conversation` / `Message` tables are shared by all verticals and channels.
- **LLM** – `packages/ai` configures the OpenAI SDK. `OPENAI_BASE_URL` switches to any OpenAI-compatible server (e.g. llama.cpp serving Qwen3-1.7B) using the Chat Completions API. The model only phrases replies; business decisions are made in application code.

### Restaurant ordering (GR Chicken)

```
Website chat (/chat/<key>) ──► POST /public/chat/:key/messages ─┐
WhatsApp ─► /webhooks/whatsapp ─► queue ─► worker ─► AiService ─┤
                                                                ▼
                                      OrderingEngine (apps/api/src/restaurant)
                     order-parse.ts  ── items, quantities, intents (deterministic)
                     OrdersService   ── prices, totals, validation, idempotent create
                     CatalogService  ── menu + outlets (DB)
                     restaurant agent (no tools) ── phrases free-form answers only
```

Flow: menu / item search → cart (server-side, per thread) → outlet → pickup or delivery (+ service area, address) → contact number (website only) → summary with server-computed total → customer replies **YES** → order created exactly once → staff confirm and progress it in the dashboard → customer can ask "order status".

Safety rules enforced in code:

- Prices and totals come only from the database (`OrdersService.quote`), re-checked inside the order transaction; if the total changed after the customer saw it, the order is rejected, not silently re-priced.
- Only an explicit yes (`yes`, `confirm`, `ok`, `place order`, …) places an order; changing the cart drops the pending confirmation; a confirmation expires after 30 minutes.
- `Order(organizationId, idempotencyKey)` is unique: retries, double taps and concurrent requests return the same order.
- A dish we do not sell ("mutton biryani") or an item only asked about ("do you have chicken 65?") is never added to the cart.
- The model has no tools and cannot touch carts or orders; any model sentence quoting a price that is not on the menu is removed.
- No POS, payment or delivery API is integrated. Orders are labelled `posStatus = not_integrated`, payment is cash on delivery / pay at outlet, and only staff can mark an order paid. Replies say the order is *waiting for the outlet to confirm*.
- Status changes follow fixed transitions (`pending → confirmed → preparing → ready → out_for_delivery → completed`, cancel from any active state), use compare-and-set, and are written to `OrderEvent` with the acting user. Users with role `viewer` cannot change anything.

Data model added by migration `20261011000000_add_restaurant_ordering`: `Organization.vertical`, `Outlet`, `MenuCategory`, `MenuItem`, `Order`, `OrderItem`, `OrderEvent`.

## Setup

Requirements: Node 22, MySQL 8 or MariaDB 10.6+, Redis 6+.

```bash
npm run setup                       # install, generate Prisma client, build packages/ai
cp <your env file> apps/api/.env    # see "Environment" (never commit it)
npm run db:migrate:deploy           # apply migrations (existing DB: see apps/api/scripts/db-baseline.sh)
npm run seed                        # real-estate demo tenant (optional)
GR_ADMIN_EMAIL=you@example.com GR_ADMIN_PASSWORD='<10+ chars>' npm run seed:gr-chicken
```

`seed:gr-chicken` is safe to re-run and only touches the GR Chicken tenant. It creates **demo** outlets and menu items (`isDemo = true`, names end in "(Demo)", addresses say "DEMO ADDRESS"), a public website-chat key, the dashboard login, and optionally maps a WhatsApp number. It never overwrites an item that has been marked verified (`isDemo = false`). Replace demo prices in the dashboard Menu page or edit `DEMO_MENU` / `DEMO_OUTLETS` in `apps/api/scripts/seed-gr-chicken.ts`.

## Run locally

```bash
npm run dev        # API on http://localhost:3000 (builds packages/ai first, watch mode)
npm run dev:web    # dashboard on http://localhost:3001
```

Production-style: `npm run build`, then `npm start` (API) and `npm run start:web` (dashboard).

| What | URL |
|---|---|
| Dashboard | http://localhost:3001 (log in with the GR Chicken admin) |
| Website chat (customers) | http://localhost:3001/chat/&lt;chat key&gt; (printed by the seed; also on *Settings & integrations*) |
| API health | http://localhost:3000/health |
| API docs | none yet (no OpenAPI/Swagger in this repo); endpoints are listed below |

Local LLM (optional): run llama.cpp's server with Qwen3-1.7B on port 8080 and set `OPENAI_BASE_URL=http://127.0.0.1:8080/v1`, `OPENAI_MODEL=Qwen3-1.7B-Q4_K_M`, `OPENAI_REASONING_EFFORT=off`. Without any model configured, ordering still works; free-form questions get a standard help reply.

### Restaurant API

Authenticated (dashboard session):

| Method | Path | |
|---|---|---|
| GET | `/restaurant/overview?days=7` | KPIs, status counts, channels, recent orders/conversations |
| GET | `/restaurant/orders?status=&q=&outletId=` | `status` also accepts `active` |
| GET / PATCH | `/restaurant/orders/:id` | PATCH `{ status?, paymentStatus?, note? }` |
| GET | `/restaurant/menu` | categories, items, outlets |
| PATCH / POST | `/restaurant/menu/items/:id`, `/restaurant/menu/items` | validated price / availability edits; create is admin only |
| GET / PATCH | `/restaurant/conversations`, `/restaurant/conversations/:id` | PATCH `{ status: active \| human_handoff \| closed }` |
| GET / PATCH | `/restaurant/customers`, `/restaurant/customers/:id` | PATCH `{ doNotContact }` (marketing opt-out) |
| GET | `/restaurant/integrations` | channel / LLM / POS / payment status, never secret values |

Public (rate limited per IP, `RATE_LIMIT_PUBLIC_CHAT_PER_MIN`, default 40/min):

| Method | Path | |
|---|---|---|
| GET | `/public/chat/:key` | business name, demo flag |
| POST | `/public/chat/:key/messages` | `{ sessionId (16–64 chars), message }` → `{ reply, step, cart, order }` |

Existing: `POST /ai/chat` (authenticated test chat for any tenant), `POST /webhooks/whatsapp`, `GET /health`.

## Environment

Names only. Put values in `apps/api/.env` (gitignored) or your server environment.

- Database / cache: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_SIZE`, `DATABASE_URL` (Prisma CLI only, optional), `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_TLS`
- API: `PORT`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, `AUTH_SECRET`, `TRUST_PROXY`, `RUN_WORKERS`, `NODE_ENV`, `DEFAULT_ORGANIZATION_ID`, `DEFAULT_ORGANIZATION_NAME`, `RATE_LIMIT_LOGIN`, `RATE_LIMIT_API_PER_MIN`, `RATE_LIMIT_WEBHOOK_PER_MIN`, `RATE_LIMIT_PUBLIC_CHAT_PER_MIN`
- LLM: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `OPENAI_VOICE_MODEL`, `OPENAI_VOICE_REASONING_EFFORT`, `OPENAI_VOICE_MAX_TOKENS`, `OPENAI_TRACING`
- WhatsApp (Meta Cloud API): `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `META_APP_SECRET`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATE_NAME` (+ step templates, see `apps/api/src/common/config.ts`)
- GR Chicken seed: `GR_ORGANIZATION_ID`, `GR_ADMIN_EMAIL`, `GR_ADMIN_PASSWORD`, `GR_WEB_CHAT_KEY`, `GR_WHATSAPP_PHONE_NUMBER_ID`
- Real-estate voice / leads: `PLIVO_*`, `SARVAM_*`, `VOICE_*`, `META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID`, `META_LEAD_VERIFY_TOKEN`, `FOLLOWUP_TIME_SCALE` (see `config.ts`)

Note: the WhatsApp sender currently uses one deployment-wide `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`. Running GR Chicken and another tenant on *different* WhatsApp numbers from one deployment needs per-tenant sender credentials (not built yet).

## Tests

```bash
npm run typecheck                                   # packages/ai, api, web
npm test                                            # unit tests (DB tests are skipped)
TEST_DB_NAME=tacksharp_test npm test -w apps/api    # + DB-backed integration tests against a separate test DB
npm run build                                       # api + web production builds
```

Restaurant coverage: `apps/api/src/restaurant/order-parse.spec.ts` (parsing, intents, hours, order numbers, price filter) and `apps/api/test/restaurant.integration.spec.ts` (full web and WhatsApp ordering, totals, idempotency incl. concurrent confirmations, validation, unknown dishes, cart change after summary, tenant isolation, status transitions + audit, routing, no-model fallback).

## Known limitations

- Menu, prices and outlets for GR Chicken are **demo data** until replaced with verified client information.
- No POS, payment-gateway or delivery-partner integration; staff enter orders into the outlet POS manually.
- WhatsApp needs real Meta credentials, the business number mapped to the tenant, and the webhook registered; outbound messages fail (and are dead-lettered) without them.
- Voice ordering is not built for restaurants; a call to a restaurant tenant gets a polite "order on WhatsApp or website" reply.
- Campaign sending is intentionally disabled (needs WhatsApp, an approved marketing template and recorded opt-in).
- Customer opt-in for promotions is not captured; only opt-outs (`doNotContact`) can be recorded.
- When staff flag a conversation for a human, the AI keeps answering menu/order questions; staff reply via WhatsApp or phone (no in-dashboard reply box yet).
- Order cancellation by staff does not notify the customer automatically.
- Cart and checkout state live in process memory with a Redis copy (24 h); the API is designed to run as a single process.
