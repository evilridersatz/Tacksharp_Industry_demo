# Tacksharp

AI employees platform: one codebase, one database, several businesses (tenants). Each tenant runs one product:

| Vertical | Tenant example | What the AI does |
|---|---|---|
| `real_estate` (default) | Tacksharp Realty | Lead follow-up on WhatsApp + AI voice calls, CRM, site-visit booking |
| `restaurant` | **GR Chicken** | ₹50 website-offer claim on WhatsApp, fresh-chicken pickup orders in Tamil/Tanglish, Tamil "order ready" call, staff dashboard |

The vertical is stored on `Organization.vertical`. Incoming WhatsApp messages are routed by it in `AiService.generateResponse`; the dashboard shows the matching navigation after login.

## Architecture

```
apps/api        NestJS 12 API (Prisma 7 + MySQL/MariaDB, Redis/BullMQ workers, Plivo voice, Sarvam STT/TTS)
apps/web        Next.js 16 dashboard (React 19, Tailwind 4)
packages/ai     Agent definitions on the OpenAI Agents SDK (real estate + restaurant)
```

- **Auth / tenancy** – signed session cookie (or `Authorization: Bearer`), global guard; every query takes the organization from the session (`@Org()`), never from the request. Webhooks resolve the tenant from the receiving identifier (`OrganizationChannel`: WhatsApp phone_number_id, Plivo number, Meta page id, website API key hash).
- **Conversations** – `Conversation` / `Message` tables are shared by all verticals and channels (WhatsApp, voice, test chat).
- **LLM** – `packages/ai` configures the OpenAI SDK. `OPENAI_BASE_URL` switches to any OpenAI-compatible server (e.g. llama.cpp serving Qwen3-1.7B). The model only phrases replies; business decisions are made in application code.

## GR Chicken flow

```
1. Customer orders on the GR Chicken website (their existing site) and gets a ₹50 offer.
2. The offer chat starts on WhatsApp, three ways:
     a. customer taps the wa.me "claim ₹50 offer" link and says Hi
     b. the website calls POST /public/offers with the customer's number  ─┐ assistant sends the
     c. staff paste numbers on the dashboard Offer page                    ─┘ Tamil offer message
3. Assistant (Tanglish by default, Tamil script / English if the customer writes that way):
     "Vanakkam! GR Chicken vaangiyatharku nandri. Ungalukku ₹50 offer irukku.
      Enna chicken, ethana kg, eppadi cut, payment eppadi, eppo vandhu collect pannuveenga?"
   and collects, in any order and from natural sentences ("1.5 kg nattu kozhi biryani cut, gpay,
   naalaikku kaalaila 10 mani"): product · kg · cut · payment (cash / UPI at shop / paid online) · pickup time
4. Summary with per-kg prices, −₹50 and the total → customer says "sari" / "yes" → order created once.
5. Staff: Confirm → Start cutting → Mark ready
6. Mark ready ⇒ the assistant calls the customer in Tamil:
     "நீங்க சொன்ன மாதிரி 2 கிலோ Broiler Chicken Curry cut எல்லாம் ready-ஆ இருக்கு… எப்போ வருவீங்க?"
   listens to one reply (coming / later / cancel), notes it on the order, hangs up.
   Not answered, calling not configured or outside calling hours ⇒ the same message on WhatsApp.
7. Customer collects ⇒ staff tap Collected.
```

Code: `apps/api/src/restaurant/`

| File | What it does |
|---|---|
| `chicken-parse.ts` | Deterministic Tanglish / Tamil / English reading: products + aliases, kg (`2 kg`, `rendu kilo`, `arai kilo`, `500 g`, `1 1/2`), cuts (curry / biryani / fry / whole and their Tamil/Tanglish words), payment, pickup time (relative "30 nimishathula", "ஒரு மணி நேரத்துல"; clock times via the existing `conversation/when.ts`), intents |
| `ordering-engine.service.ts` | The conversation state machine (one per WhatsApp number): applies everything a message says, asks for the next missing detail, shows the summary, places the order only on an explicit yes |
| `replies.ts` | Every sentence the assistant writes or speaks, in Tanglish / Tamil / English |
| `orders.service.ts` | Prices, offer discount, validation (cut required, kg min/step/max, stock, shop hours, prep time, max 3 days ahead), idempotent creation, staff status changes + audit |
| `offers.service.ts` | Offer claims (link / website / staff), sending the Tamil offer message (text inside 24h, approved template outside), one discount per claim |
| `ready-notice.service.ts`, `ready-call.controller.ts` | "Order ready" Tamil call through Plivo + Sarvam (record → STT → reply), WhatsApp fallback |
| `public-offers.controller.ts` | Website → offer API (`x-api-key`) |
| `restaurant.controller.ts` | Dashboard API |

Safety rules enforced in code:

- Prices, the offer discount and totals come only from the database (`OrdersService.quote`) and are re-checked inside the order transaction; if the total changed after the customer saw it, the order is rejected, not silently re-priced.
- Only an explicit yes (`sari`, `yes`, `ok`, `confirm`, `சரி`, `ஆமா` …) places an order; any change after the summary drops the pending confirmation; a confirmation expires after 30 minutes.
- `Order(organizationId, idempotencyKey)` is unique and the offer claim is marked `claimed` with compare-and-set in the same transaction: retries, double taps and concurrent requests never create a second order or use an offer twice. A link offer is limited to one per number per campaign. Cancelling an order gives the offer back.
- A pickup time earlier than the shop can cut and pack is moved to the earliest ready time and the customer is told.
- "Already paid online" is stored as `customer_says_paid`; only staff can mark an order paid.
- The model has no tools and cannot touch orders; any model sentence quoting a price that is not in the catalogue (or the offer) is removed.
- No POS or payment gateway is integrated: orders are `posStatus = not_integrated` and wait for staff confirmation.
- Ready-call results, WhatsApp fallbacks and their failures are written to the order history; nothing is shown as delivered unless it was.

Data model (migration `20261011000000_add_restaurant_ordering`): `Organization.vertical`, `Outlet` (shop hours, prep minutes), `MenuCategory`, `MenuItem` (price per kg/piece, cut options, min/step/max qty), `OfferCampaign`, `OfferClaim`, `Order` (pickup time, discount, payment, ready-call status), `OrderItem` (kg, cut), `OrderEvent`.

## Setup

Requirements: Node 22, MySQL 8 or MariaDB 10.6+, Redis 6+.

```bash
npm run setup                       # install, generate Prisma client, build packages/ai
cp <your env file> apps/api/.env    # see "Environment" (never commit it)
npm run db:migrate:deploy           # apply migrations (existing DB: see apps/api/scripts/db-baseline.sh)
npm run seed                        # real-estate demo tenant (optional)
GR_ADMIN_EMAIL=you@example.com GR_ADMIN_PASSWORD='<10+ chars>' \
GR_WHATSAPP_PHONE_NUMBER_ID=<meta phone_number_id> GR_WHATSAPP_DISPLAY_NUMBER=91XXXXXXXXXX \
npm run seed:gr-chicken
```

`seed:gr-chicken` is safe to re-run and only touches the GR Chicken tenant. It creates **demo** products with placeholder per-kg prices (`isDemo = true`), a demo shop ("DEMO ADDRESS"), the ₹50 offer (code `GR50`, 7 days), the dashboard login, the WhatsApp number mapping and a website API key (printed once; only its hash is stored). It never overwrites a product marked verified (`isDemo = false`). Set real rates on the dashboard **Products & rates** page.

## Run locally

```bash
npm run dev        # API on http://localhost:3000 (builds packages/ai first, watch mode)
npm run dev:web    # dashboard on http://localhost:3001
```

Production-style: `npm run build`, then `npm start` (API) and `npm run start:web` (dashboard).

| What | URL |
|---|---|
| Dashboard | http://localhost:3001 (log in with the GR Chicken admin) |
| Try the WhatsApp flow without WhatsApp | Dashboard → **Test chat** (same assistant, same orders, nothing is sent) |
| API health | http://localhost:3000/health |
| API docs | none yet (no OpenAPI/Swagger in this repo); endpoints are listed below |

Local LLM (optional): run llama.cpp's server with Qwen3-1.7B on port 8080 and set `OPENAI_BASE_URL=http://127.0.0.1:8080/v1`, `OPENAI_MODEL=Qwen3-1.7B-Q4_K_M`, `OPENAI_REASONING_EFFORT=off`. Without a model, ordering still works; unusual questions get a standard help reply.

### Restaurant API

Authenticated (dashboard session):

| Method | Path | |
|---|---|---|
| GET | `/restaurant/overview?days=7` | offer funnel, orders, pickups today, ready-call results, next pickups |
| GET | `/restaurant/orders?status=active&q=` | active orders are sorted by pickup time |
| GET / PATCH | `/restaurant/orders/:id` | PATCH `{ status?, paymentStatus?, note? }`; `status: ready` triggers the ready call |
| POST | `/restaurant/orders/:id/notify-ready` | call again |
| GET / PATCH / POST | `/restaurant/menu`, `/restaurant/menu/items/:id`, `/restaurant/menu/items` | products, per-kg price, cuts, stock (create: admin) |
| GET | `/restaurant/offers` | offer, stats, claims, WhatsApp link |
| PATCH | `/restaurant/offers/campaign/:id` | amount, min order, validity, template, active (admin) |
| POST | `/restaurant/offers/send` | `{ entries: "9876543210, Priya\n…" }` — staff add customers |
| POST | `/restaurant/offers/:id/resend`, `/restaurant/offers/website-key` | retry sending; new website key (admin, shown once) |
| POST | `/restaurant/test-chat` | `{ phone, message }` — chat as a customer |
| GET / PATCH | `/restaurant/conversations[/:id]`, `/restaurant/customers[/:id]` | inbox (WhatsApp, calls, test), customers + opt-out |
| GET | `/restaurant/integrations` | WhatsApp / voice / website / LLM status, never secret values |

Public:

| Method | Path | |
|---|---|---|
| POST | `/public/offers` | header `x-api-key`; `{ phone, name?, websiteOrderId? }` → offer + WhatsApp message. Same `websiteOrderId` = same offer. Rate limited (`RATE_LIMIT_PUBLIC_API_PER_MIN`) |
| POST | `/webhooks/whatsapp` | Meta webhook (existing; signature checked when `META_APP_SECRET` is set) |
| POST | `/voice/ready/answer`, `/voice/ready/turn`, `/voice/ready/hangup` | Plivo callbacks for the ready call (Plivo signature checked when `PLIVO_VALIDATE_SIGNATURE=true`) |

## Environment

Names only. Put values in `apps/api/.env` (gitignored) or your server environment.

- Database / cache: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_SIZE`, `DATABASE_URL` (Prisma CLI only, optional), `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_TLS`
- API: `PORT`, `PUBLIC_BASE_URL` (public https — Plivo must reach it), `CORS_ORIGINS`, `AUTH_SECRET`, `TRUST_PROXY`, `RUN_WORKERS`, `NODE_ENV`, `DEFAULT_ORGANIZATION_ID`, `DEFAULT_ORGANIZATION_NAME`, `RATE_LIMIT_LOGIN`, `RATE_LIMIT_API_PER_MIN`, `RATE_LIMIT_WEBHOOK_PER_MIN`, `RATE_LIMIT_PUBLIC_API_PER_MIN`
- LLM: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `OPENAI_VOICE_MODEL`, `OPENAI_VOICE_REASONING_EFFORT`, `OPENAI_VOICE_MAX_TOKENS`, `OPENAI_TRACING`
- WhatsApp (Meta Cloud API): `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `META_APP_SECRET`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATE_LANGUAGE`, `WHATSAPP_TEMPLATE_ORDER_READY` (approved "order ready" template, `{{1}}` = order number), other templates in `apps/api/src/common/config.ts`. The offer's opening template name is set on the dashboard Offer page.
- Ready call (Plivo + Sarvam): `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER`, `PLIVO_VALIDATE_SIGNATURE`, `PLIVO_RING_TIMEOUT`, `SARVAM_API_KEY` (+ `SARVAM_TTS_*`), `VOICE_CALL_WINDOW_START`, `VOICE_CALL_WINDOW_END`, `VOICE_AUDIO_DIR`
- GR Chicken seed: `GR_ORGANIZATION_ID`, `GR_ADMIN_EMAIL`, `GR_ADMIN_PASSWORD`, `GR_WHATSAPP_PHONE_NUMBER_ID`, `GR_WHATSAPP_DISPLAY_NUMBER`, `GR_OFFER_TEMPLATE_NAME`, `GR_OFFER_AMOUNT`
- Real-estate leads: `META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID`, `META_LEAD_VERIFY_TOKEN`, `FOLLOWUP_TIME_SCALE`, `VOICE_*` (see `config.ts`)

Note: the WhatsApp sender uses one deployment-wide `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`. Running GR Chicken and another tenant on *different* WhatsApp numbers from one deployment needs per-tenant sender credentials (not built yet).

## Tests

```bash
npm run typecheck                                   # packages/ai, api, web
npm test                                            # unit tests (DB tests are skipped)
TEST_DB_NAME=tacksharp_test npm test -w apps/api    # + DB-backed integration tests against a separate test DB
npm run build                                       # api + web production builds
```

GR Chicken coverage: `apps/api/src/restaurant/chicken-parse.spec.ts` (Tanglish/Tamil kg, cuts, payment, pickup times, intents, call-reply reading, price filter) and `apps/api/test/restaurant.integration.spec.ts` (link offer → order with ₹50 off and offer used once; one-message order with a correction; Tamil script; change after summary; website/staff offers inside/outside the 24h window; website API key; concurrent confirmations; validation; ready call answered → noted; unanswered → WhatsApp; no calling setup → WhatsApp; cancel returns the offer; roles; tenant isolation).

## Known limitations

- Products, per-kg prices and the shop are **demo data** until replaced with verified GR Chicken information.
- WhatsApp needs real Meta credentials, the number mapped to GR Chicken, the webhook registered, and **approved templates** for messages outside the 24h window (offer opener, order ready). Without the offer template, website/staff offers are recorded as "not sent" and customers can still start with the link.
- The ready call needs Plivo + Sarvam credentials and a public https `PUBLIC_BASE_URL`; it is a short call (opening + one reply). Until then the ready message goes on WhatsApp.
- Understanding is rule-based (a Tamil/Tanglish product, quantity, cut, payment and time vocabulary) plus the model for phrasing unusual answers; very free-form messages get a clarifying question. Product aliases are editable per product.
- WhatsApp voice notes are transcribed by the existing Sarvam path only when `SARVAM_API_KEY` is set.
- The website integration is one call per website order (`POST /public/offers`); the website itself was not changed here.
- No POS or payment-gateway integration; "paid online" is the customer's word until staff verify it.
- Link offers cannot be tied to a specific website order (marked "not linked to a website order" for staff).
- Staff reply to customers on WhatsApp/phone directly (no in-dashboard reply box yet). Cancelling does not notify the customer.
- Order state per chat lives in process memory with a Redis copy (3 days); the API is designed to run as a single process.
