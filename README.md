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

Data model (migrations `20261011000000_add_restaurant_ordering` and `20261012000000_restaurant_followups`, both additive): `Organization.vertical`, `Outlet` (shop hours, prep minutes), `MenuCategory`, `MenuItem` (price per kg/piece, cut options, min/step/max qty), `OfferCampaign`, `OfferClaim`, `Order` (pickup time, discount, payment, ready-call status), `OrderItem` (kg, cut), `OrderEvent`.

## Follow-ups: WhatsApp + voice (demo-ready, DRY_RUN by default)

GR Chicken is pickup, so **"delivered" = collected**: when staff mark an order *Collected*, `collectedAt` is set and follow-ups are scheduled.

| Follow-up | Channel | When | Rules |
|---|---|---|---|
| Order confirmation | WhatsApp | order created outside the chat (chat orders are confirmed in the conversation) | messaging consent |
| Status update | WhatsApp | staff confirm the order | messaging consent |
| Feedback request | WhatsApp | `FOLLOWUP_FEEDBACK_DELAY_MINUTES` (30) after collection | "Hi {name}, thank you for ordering from GR Chicken! How was your order {order}? Reply 1–5 … Reply STOP to opt out." Text inside 24h, approved template (`FOLLOWUP_FEEDBACK_TEMPLATE`) outside |
| Feedback call | Voice (Plivo + Sarvam, Tamil) | `FOLLOWUP_CALL_DELAY_MINUTES` (120) after collection | order collected, calling consent, not opted out, no feedback yet, calling hours (else rescheduled); no answer → retry after `FOLLOWUP_CALL_RETRY_MINUTES`, up to `FOLLOWUP_CALL_MAX_ATTEMPTS` |

- **Replies:** `1`–`5` (or "4 stars", ⭐⭐⭐⭐) to a feedback request is saved on the order; a WhatsApp rating cancels the pending call. **1–2 or complaint words** ("fresh-ah illa", "smell", "late", "நாத்தம்"…) open a complaint, flag the chat for staff and write an audit event; the customer's next message is saved as the complaint detail. Staff resolve it on **Follow-ups → Feedback & complaints**.
- **STOP / START:** STOP (also "stop pannunga", "நிறுத்துங்க") sets `optedOutAt`, removes messaging and calling consent and cancels every pending follow-up; offers and ready notices are blocked too. Only the customer's START re-enables messaging; staff cannot override a STOP.
- **No duplicates:** one `OrderFollowUp` row per order + purpose (unique `dedupeKey`), claimed with compare-and-set before sending, one BullMQ job per attempt (`jobId = row + attempt`), and a message that was already sent is never re-sent on retry.
- **Retries:** temporary WhatsApp errors are retried by the `restaurant-follow-up` queue with back-off up to `FOLLOWUP_SEND_MAX_ATTEMPTS`, then marked failed; 4xx errors fail at once. A sweeper re-queues due follow-ups every minute (lost jobs, restarts).
- **Delivery status:** the existing WhatsApp webhook now reads `statuses` (sent / delivered / read / failed) and updates the follow-up.
- **Records:** every message is in the conversation, every call is a `Call` row (summary, outcome) with its transcript in the voice conversation, all linked to the customer and the order.

### DRY_RUN and live testing

- `DRY_RUN=true` (default): the full workflow and queue run with mock WhatsApp and voice adapters. The exact Graph API body / call request, simulated result, transcript and errors are shown on the dashboard. Nothing is sent and no call is placed. This also applies to the ₹50 offer message and the order-ready notice.
- Live: `DRY_RUN=false` **and** the number in `LIVE_TEST_RECIPIENTS` (or `LIVE_ALLOW_ALL_CUSTOMERS=true` for production). Demo customers are never contacted, whatever the settings. Tokens are never logged or sent to the browser.
- Simulated customers: a dry-run call to a real (non-demo) customer is recorded as "no answer". Feedback is never invented for real people; scripted answers are used only for demo orders.

### Demo data

```bash
npm run seed:gr-chicken          # tenant, products, shop (once)
npm run seed:gr-chicken-demo     # 10 synthetic customers + 10 demo orders (safe to re-run)
```

Customers are named "… (Demo)" with numbers `91 00000 100NN`. Indian mobiles never start with 0, so these cannot belong to anyone. Everything is `isDemo`. Orders cover every stage: new, confirmed, preparing, ready, collected with a 5/5, collected with an open complaint, a scheduled call, an unanswered call (2 tries), a customer without call consent, and a cancelled order whose customer replied STOP. The seed never overwrites a real customer that happens to hold a demo number.

**Run the demo:** Dashboard → **Follow-ups** → *Run demo follow-up*. Pick a collected demo order and a simulated customer: replies 5 on WhatsApp, replies 2 + complaint, call happy 5/5, call complaint 2/5, no answer (retry scheduled), or STOP. The job goes through the real queue and worker; refresh shows the request, statuses, transcript, rating and complaint.

### Follow-up API

| Method | Path | |
|---|---|---|
| GET | `/restaurant/followups?status=open\|failed…&channel=&kind=&orderId=` | follow-ups with request, result, call |
| GET | `/restaurant/followups/summary` | mode (dry_run/live), counts, rating, complaints, demo orders |
| POST | `/restaurant/followups/demo-run` | `{ orderId?, scenario }` — always simulated |
| POST | `/restaurant/followups/:id/cancel` | cancel a scheduled follow-up |
| GET | `/restaurant/feedback?filter=complaints` | ratings and complaints |
| PATCH | `/restaurant/orders/:id/complaint` | `{ status: resolved\|open, note? }` |
| PATCH | `/restaurant/customers/:id` | `{ messagingConsent?, callingConsent?, doNotContact? }` |
| POST | `/voice/feedback/answer`, `/voice/feedback/turn`, `/voice/feedback/hangup` | Plivo callbacks for the live feedback call |

Reused: order status changes (`PATCH /restaurant/orders/:id`), `POST /webhooks/whatsapp` (now also delivery receipts), the WhatsApp sender, Plivo dialer + Sarvam STT/TTS, BullMQ/Redis, auth and tenant scoping.

## Phone calls, WhatsApp reliability and diagnostics (GR Chicken)

### How a restaurant call works

The organization's `vertical` (not its name) decides everything below; a real-estate organization keeps its own
opening line, leads, prompts, tools and inventory.

```
Plivo answer → VoiceService (vertical = restaurant)
  → opening: "வணக்கம் …, GR Chicken-ல இருந்து AI assistant பேசுறேன். Chicken order பண்ணணுமா…?"   (no lead is created)
  → OrderingEngine.openVoiceSession (channel "voice": same customer, same rules as WhatsApp)
customer speaks → Saaras STT (vocabulary = this shop's products, cuts, shops) → transcript gate
  → AiService → OrderingEngine (channel "voice") → spoken reply (Tamil script / English, no menus or symbols)
  → decideCallEnd(): the call ends ONLY on
       · an explicit goodbye ("bye", "சரி, வைக்கிறேன்")             endReason customer_goodbye
       · "no" / "thanks" after "anything else?" once an order was placed   done_after_order
       · asking for staff (the conversation is handed to staff)         handoff
       · 3 silent / unclear turns in a row                               no_response
       · 24 turns                                                        max_turns
     every other answer keeps the call open. A failed turn asks the customer to repeat.
hang-up → Call.endReason, turns, outcome (order_placed …), summary
```

Calls the business places to a restaurant customer (dashboard or `verify:restaurant --call`) require the customer's
calling consent, no STOP, and the same live gate as follow-ups: with `DRY_RUN=true` nothing is dialled; with
`DRY_RUN=false` only numbers in `LIVE_TEST_RECIPIENTS` (or everyone with `LIVE_ALLOW_ALL_CUSTOMERS=true`).

### One customer across WhatsApp and phone

Customer identity is per organization + phone number. A half-finished order (products, kg, cut, payment, time, shop,
offer) started on WhatsApp continues on a call and the other way round; a summary is always confirmed again on the
channel the order is placed from, and placing it clears the other channel's draft, so an old WhatsApp summary can
never become a second order. The language the customer uses is saved on the customer. Another restaurant with the
same customer number sees none of it.

### WhatsApp sending

| Situation | What happens |
|---|---|
| Meta accepted the reply | stored on the message as `accepted` (not "delivered"); receipts move it to sent / delivered / read |
| 400 bad number, 24h window closed, template missing / not approved / wrong parameters, 401 / 403, settings missing | permanent: not retried, recorded as failed |
| 429, 5xx, Meta rate-limit codes, connection refused / DNS / **connect ETIMEDOUT** (Meta never got it) | retried with exponential back-off + jitter (bounded attempts), worker rate-limited to 20 sends/s |
| timeout or reset **after** the request was sent | `unknown`: never resent automatically (the Cloud API has no idempotency key), so the customer cannot get it twice |
| the same inbound message delivered twice by Meta | processed once: stored in `InboundMessage` with a unique (organization, Meta message id) key |
| two workers pick up the same message (stalled / retried job) | only one claims it (database compare-and-set with a 2-minute lease); the other does nothing |
| crash or Redis timeout after sending | the reply is saved **before** sending and marked `sending`; a later attempt sees that and never sends again (outcome `unknown`) |
| queue (Redis) down when the webhook arrives | the message is still stored; the webhook answers 500 so Meta retries, and a 60-second sweep re-queues stored messages (gives up after 5 attempts) |
| a retry after the reply was already accepted | sends nothing |

Outside the 24h window only the exact approved template for that use is sent; template names are never guessed.

### Diagnosing "connect ETIMEDOUT"

Logs now name the dependency (`dependency: redis | database | meta_graph | plivo | sarvam`) and keep the cause
chain (`fetch failed <- connect ETIMEDOUT (… 157.240.x.x:443)`). A bare `worker.error … connect ETIMEDOUT` with
`dependency: redis` is the worker's Redis connection (ioredis wording); it is logged once a minute with a repeat count
instead of on every reconnect. `GET /health` shows database, Redis and queue state.

### Checks

```bash
npm run check:config                       # which settings are set / missing (names only, never values)
npm run verify:restaurant                  # read-only: template approval + language + variable count, Plivo
                                           # callback URLs, signature check, server, tenant
npm run verify:restaurant -- --call=98…    # + ONE real restaurant call to an approved number with calling consent
TEST_DB_NAME=tacksharp_test npm run test:restaurant   # restaurant + voice + WhatsApp suites against a test DB
```

`npm run verify:live` checks the **real-estate** product with fixed real-estate sample data (Porur, 2 BHK, Green
Valley Residency). Those answers are expected there and are not GR Chicken output; its call test refuses to run for a
restaurant user.

### Turning on Plivo signature checks

1. `PUBLIC_BASE_URL` must be the exact https URL Plivo calls (no trailing slash needed).
2. Set `PLIVO_VALIDATE_SIGNATURE=true` and restart. All `/voice/*` callbacks (calls, ready calls, feedback calls)
   then require a valid `X-Plivo-Signature-V3`. Behind a proxy the forwarded host is accepted too; the signature
   itself must still match the auth token.
3. `npm run verify:restaurant` → "Unsigned POST … is rejected" should be PASS (HTTP 403).

### Inbound message states

`InboundMessage.status`: `received` → `queued` → `processing` → `replied` (Meta **accepted** the reply — not
"delivered"; delivery receipts update the conversation message) / `reply_unknown` (sent but no answer: never resent)
/ `failed` (nothing sent: provider refused, not configured, or retries used up) / `skipped` (unsupported type).
Dashboard: **Carts, stock & messages** page; API `GET /restaurant/whatsapp-inbound?status=`.
Migration: `20261015000000_whatsapp_inbound_messages`.

## Stock (inventory)

Each product can track **stock on hand** in its own unit (kg or pieces) with a **low-stock level**
(`MenuItem.stockQty`, `lowStockThreshold`; migration `20261014000000_restaurant_inventory`). Empty stock = not
tracked = **unknown**: never treated as zero and never as available. Customers get the price and "the shop will
confirm the stock"; they can still order, and the summary says the stock is to be confirmed by the shop.

- **Customers** (WhatsApp and phone, same rules): "which chicken is available?", "how much stock?", "liver irukka?"
  are answered from the database first — products with stock, price, quantity (labelled *demo stock* when it is
  sample data). Out-of-stock products are said to be out, with only in-stock alternatives; if nothing suitable is in
  stock the customer is offered the shop staff. Asking never adds anything to the order.
- **Orders** take stock when the customer confirms (conditional update: never below zero, no overselling when two
  confirm at once) and give it back if the order is cancelled. Every change is in `InventoryMovement`; an order's
  deduction and its release each happen at most once, so repeated webhooks or clicks cannot double-count.
- **Staff**: Products & rates page shows stock and the low level; staff set counted stock there.
  API: `GET /restaurant/inventory`, `PATCH /restaurant/inventory/:id` (`stockQty`, `adjustBy`, `lowStockThreshold`;
  staff/admin), `GET /restaurant/inventory/:id/movements`. All scoped to the signed-in organization.
- **Alerts** (optional): set `STOCK_ALERT_SNS_TOPIC_ARN` (+ `AWS_REGION`, AWS credentials from the standard chain).
  One alert when a product drops to its low level, one more when it runs out; restocking resets it. Without the
  topic, alerts are skipped and logged. Only the shop's admin topic is notified, never customers.
- **Quantities are checked as soon as they are said**: wrong unit ("2 kg eggs" → sold by the piece), below the
  minimum, above the maximum, off the step (0.3 kg with 250 g steps), or more than the stock ("8 kg drumsticks" with
  6 kg → "we have only 6 kg — 6 kg or less?" plus in-stock alternatives). Nothing invalid goes into the cart.
- **Cart**: each line is priced ("500 g Boneless Chicken — ₹180"); with two or more lines the whole cart and its total
  are shown. Stock is checked again at confirmation and taken once.
- **MVP demo catalogue**: `npm run seed:demo-inventory` loads `apps/api/scripts/data/demo-inventory.json` (Whole
  Chicken ₹240/kg 20 kg, Chicken Breast ₹320/kg 8 kg, Chicken Curry Cut ₹260/kg 15 kg, Chicken Drumsticks ₹300/kg
  6 kg, Chicken Wings ₹280/kg 5 kg, Boneless Chicken ₹360/kg 7 kg, Eggs ₹8 each 120 pcs). Edit the file and re-run.
  It prints the target database (never the password), checks the schema / migration history, refuses production
  (`NODE_ENV=production` or a database name containing "prod") unless `--allow-production` **and**
  `CONFIRM_DEMO_SEED_DB=<db name>`, never deletes anything, never touches a non-demo product or staff-entered stock,
  and a second run changes nothing. Options: `--dry-run`, `--org <id>`, `--hide-other-demo-products` (marks other
  demo products not for sale; does not delete them).
- **Older demo stock**: `npm run seed:gr-chicken-demo` gives the demo products sample stock (Broiler 18 kg, Country 8 kg,
  Skinless 6 kg, Wings 4 kg, Boneless 1.5 kg = low, Chicken Liver 0 = out, Country Eggs 120 pcs). Stock that staff
  entered is never overwritten.

## Observability

- One structured log line per ordering turn, `restaurant.turn`: organization, conversation, channel, language,
  `intent`, `path` (rules / llm), `llm` status, cart size, order, end reason, duration. No message text, no phone.
- `llm` explains `aiRequests: 0`: `not_needed` (the rules answered — the normal case for ordering), `not_configured`
  (no `OPENAI_API_KEY` / `OPENAI_BASE_URL`; the help reply was used), `failed` / `empty` / `filtered_out` (asked, but
  the answer could not be used; `llmError` says why). The same fields are stored on each AI message and in `voice.turn`.
- Calls: `voice.segment` logs every speech segment with why it was accepted or rejected (`echo_of_agent_audio`,
  `short_speech_during_echo_window`, `outlastedPlayback`). A short answer said over the end of our question and
  continuing after it is accepted. A call's language changes only on a sentence of 3+ words (speech-to-text often
  writes "ok" in Tamil script); the session language is reported back for speech output.
- Dashboard **Carts, stock & messages**: active carts (WhatsApp, phone, test chat), WhatsApp inbound status, phone
  calls (status, language, end reason, transcript), recent stock movements.

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
- Stock alerts (optional): `STOCK_ALERT_SNS_TOPIC_ARN`, `AWS_REGION` (credentials from the standard AWS chain)
- Checks: `WHATSAPP_BUSINESS_ACCOUNT_ID` (template approval check), `WHATSAPP_SEND_TIMEOUT_MS`, `VERIFY_EMAIL`, `VERIFY_PASSWORD`
- Follow-ups: `DRY_RUN` (default true), `LIVE_TEST_RECIPIENTS`, `LIVE_ALLOW_ALL_CUSTOMERS`, `FOLLOWUP_FEEDBACK_DELAY_MINUTES`, `FOLLOWUP_CALL_DELAY_MINUTES`, `FOLLOWUP_CALL_MAX_ATTEMPTS`, `FOLLOWUP_CALL_RETRY_MINUTES`, `FOLLOWUP_SEND_MAX_ATTEMPTS`, `FOLLOWUP_FEEDBACK_TEMPLATE`, `FOLLOWUP_CONFIRMATION_TEMPLATE`
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

Follow-up coverage: `apps/api/src/restaurant/feedback-parse.spec.ts` (ratings, complaints, STOP/START, dry-run/live gate, WhatsApp bodies) and `apps/api/test/restaurant-followups.integration.spec.ts` (seed idempotency, scheduling, payloads, dry-run never calls providers, live only to approved numbers, duplicate prevention incl. concurrent processing, queue retry + max attempts + permanent errors, voice eligibility + calling hours, no-answer retry, complaint escalation from call and WhatsApp, STOP/START, consent, tenant isolation, demo run). There is no lint script in this repo; typecheck + tests + builds are the checks.

Calls / WhatsApp / isolation coverage: `apps/api/test/restaurant-voice.integration.spec.ts` (5-turn Tamil call that stays open until "இல்ல"; Tanglish and English callers; goodbye on turn 1; goodbye with a pending summary; silence and noise; property question on the GR Chicken line; delivery and unavailable items; consent / STOP / dry-run block dialling; real-time stream with an STT failure; WhatsApp → phone → WhatsApp continuity with no second order; cross-tenant; real-estate tenant never reaches the restaurant engine and vice versa; invented model prices dropped; price change and item unavailable after the summary; expired offer; order status; duplicate webhook; delivery receipts), `src/restaurant/voice-intents.spec.ts`, `src/voice/plivo-signature.spec.ts` (valid / invalid / missing / proxy), `src/whatsapp/whatsapp-reliability.spec.ts` (400/401/429/5xx/connect timeout/ambiguous timeout, dependency naming, log throttling), `src/workers/whatsapp-message.processor.spec.ts` (send once).

GR Chicken coverage: `apps/api/src/restaurant/chicken-parse.spec.ts` (Tanglish/Tamil kg, cuts, payment, pickup times, intents, call-reply reading, price filter) and `apps/api/test/restaurant.integration.spec.ts` (link offer → order with ₹50 off and offer used once; one-message order with a correction; Tamil script; change after summary; website/staff offers inside/outside the 24h window; website API key; concurrent confirmations; validation; ready call answered → noted; unanswered → WhatsApp; no calling setup → WhatsApp; cancel returns the offer; roles; tenant isolation).

## Known limitations

- Products, per-kg prices and the shop are **demo data** until replaced with verified GR Chicken information.
- WhatsApp needs real Meta credentials, the number mapped to GR Chicken, the webhook registered, and **approved templates** for messages outside the 24h window (offer opener, order ready). Without the offer template, website/staff offers are recorded as "not sent" and customers can still start with the link.
- The ready call needs Plivo + Sarvam credentials and a public https `PUBLIC_BASE_URL`; it is a short call (opening + one reply). Until then the ready message goes on WhatsApp.
- Restaurant phone calls (ordering by voice) were verified with mocked Plivo/Sarvam only; a real call has not been verified from this repository's test environment. Run `npm run verify:restaurant -- --call=<approved number>`.
- A WhatsApp send that times out after the request was sent is marked "delivery unknown" and not resent; staff see it in the conversation.
- Understanding is rule-based (a Tamil/Tanglish product, quantity, cut, payment and time vocabulary) plus the model for phrasing unusual answers; very free-form messages get a clarifying question. Product aliases are editable per product.
- WhatsApp voice notes are transcribed by the existing Sarvam path only when `SARVAM_API_KEY` is set.
- The website integration is one call per website order (`POST /public/offers`); the website itself was not changed here.
- No POS or payment-gateway integration; "paid online" is the customer's word until staff verify it.
- Link offers cannot be tied to a specific website order (marked "not linked to a website order" for staff).
- Staff reply to customers on WhatsApp/phone directly (no in-dashboard reply box yet). Cancelling does not notify the customer.
- Order state per chat lives in process memory with a Redis copy (3 days); the API is designed to run as a single process.
