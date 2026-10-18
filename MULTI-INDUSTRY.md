# Multi-industry platform (Phase 3)

Tacksharp adapts to nine industries, each a separate workspace with its own menu, dashboard, pipeline, settings, wording and AI-agent catalogue:

| Industry id | Label | AI assistant |
|---|---|---|
| `restaurant` | GR Chicken Restaurant | Existing GR Chicken ordering engine (kg / cuts, Tamil / Tanglish). **Unchanged.** |
| `food` | Restaurant & Food Ordering (general) | New food-ordering agent: menu, sizes, add-ons, pickup / delivery zones, order status, complaints. |
| `hotel` | Hotel & Room Booking | New booking agent: dates, guests, rooms, live availability and price, hold → confirm, cancel / reschedule, FAQs. |
| `hospital` | Hospital & Healthcare | New front-desk agent: department / doctor routing, real free slots, reschedule / cancel, insurance status (read-only), emergency escalation. Never diagnoses, prescribes or decides insurance. |
| `real_estate` | Real Estate | Existing engine. |
| `textile` | Textile & Apparel | Existing engine. |
| `retail` | Retail & E-commerce | Acknowledge + human handoff. |
| `manufacturing` | Manufacturing & Quality | Acknowledge + human handoff; quality inspections are records entered by people. |
| `agency` | Marketing Agency / Business | Acknowledge + human handoff. |

**Maritime / other industries:** no maritime (or any other) industry exists in the code, schema, settings or docs, so none was invented.

Everything runs on the existing backend:
- one authentication system
- one agent runtime
- one database
- one follow-up worker

GR Chicken's ordering flow, menu and services were not modified. Regression tests cover them.

## How the industry is decided

| Workspace | Industry |
|---|---|
| `Organization.vertical = 'restaurant'` | Always **GR Chicken Restaurant**. It cannot be changed (both Settings and the API refuse). |
| Any other organization | Settings → Industry. The change is confirmed first and recorded as an `industry_changed` audit event. No records move. |

Routing works as follows:
- `AiService` sends `food`, `hotel` and `hospital` workspaces to `VerticalAssistant`.
- GR Chicken stays on `OrderingEngine`.
- Everything else stays on the conversation engine.

Conversation state for the new agents lives in the `AgentSession` table.

## The backend is the source of truth

The agents never invent prices, availability, slots or approvals. They always call the service layer.

**Food ordering**
- Every price is re-quoted on the server (variant, add-ons, per-item tax, packing, zone fee, minimum order).
- Stock is decremented inside the order transaction.
- Orders are idempotent per `(organizationId, idempotencyKey)`.

**Hotel**
- Availability is counted under a `SELECT … FOR UPDATE` lock on the room type, so concurrent bookings cannot oversell.
- Rates resolve as seasonal, then weekend (Fri / Sat), then base.
- Pending bookings hold the room until `holdMinutes`.
- The free-cancellation window is measured from check-in time (IST).
- Deposits are recorded as **SIMULATED** in DRY_RUN / demo workspaces. Otherwise staff verify them.

**Hospital**
- Slots come from the doctor's schedule grid, minus leave, minus booked slots, with a 30-minute lead time.
- Booking takes a lock on the doctor.
- A patient cannot hold two appointments with the same doctor on the same day.

**Insurance**
- Policy numbers are masked to the last 4 characters.
- Insurer decisions can be recorded only by a user with `insurance.record_decision` and must include the insurer's reference.
- An approved amount can never exceed the requested amount.
- The assistant only reports status and chases missing documents.

## Follow-ups (simulation only)

These follow-ups are `FollowUp` rows with the sources `food`, `booking`, `appointment` and `insurance`:
- order confirmation, ready and feedback messages
- booking reminders and abandoned-enquiry nudges
- appointment reminders
- insurance document chasers

The existing worker executes them:
- Each step re-checks the record at send time; for example, a cancelled booking gets no reminder.
- Under `DRY_RUN=true`, the worker writes a message labelled **SIMULATED** and marks the step `simulated`.
- STOP / opt-out cancels them all.

## Dashboards, data and scenario tools

**Dashboards** (`GET /industry/dashboard`)
- Food: orders, kitchen queue, revenue, top items, zones.
- Hotel: arrivals, departures, occupancy, ADR, RevPAR, deposits.
- Hospital: OPD load by department and doctor, no-shows, insurance pipeline.

**Data & APIs page** (`/demo-data`, served by `GET /industry/data`)
- One row per database table, filtered to the current workspace.
- Each row shows the count, a status breakdown, three sample records and the API endpoint the dashboard reads.

**Scenario runner** (`/scenarios`, served by `POST /industry/scenarios/run`)
- Drives the real assistants end to end with a synthetic customer.
- Each step reports one of: passed, failed, blocked by missing configuration, simulated successfully, or needs real-provider verification.
- It runs **only in demo workspaces**; live workspaces get `403`.

## Demo workspaces and the seed

There are nine demo workspaces (`org_demo_*`, `isDemo = true`).

**Seed command** (staging / test only, never production), run in `apps/api`:
```
DEMO_SEED_CONFIRM=yes DEMO_SEED_DATABASE=<the DB_NAME you mean> \
DEMO_USER_PASSWORD='<12+ chars>' DEMO_GRANT_EMAILS='owner@example.com' \
npm run seed:industry-demos
```

**Safety guards**
- The seed refuses to run unless `DEMO_SEED_CONFIRM=yes` is set **and** `DEMO_SEED_DATABASE` equals the database it is connected to.
- It refuses if any `org_demo_*` id belongs to a non-demo organization.
- It writes only to `org_demo_*` workspaces.
- It never runs at startup, build or deploy.
- It never prints the password.

**Idempotency**
- Records use stable ids with upserts, so a rerun leaves the counts unchanged (verified).
- `DEMO_SEED_RESET=yes` is a one-off option that deletes the demo workspaces' own records first, for example after an older seed.

All names, phone numbers (`91999…`), patients, policies and insurers are synthetic.

### Synthetic records per workspace

These counts come from `GET /industry/data` on the test database. They include a few extra records created by test scenario runs (named "Scenario …").

| Workspace | Total | Main entities |
|---|---|---|
| Food (Spice Route Kitchen) | 589 | 66 orders, 292 order status events, 14 menu items, 4 categories, 2 outlets, 34 customers, 38 leads, 12 conversations / 94 messages, 27 follow-ups |
| Hotel (Marina Bay Residency) | 537 | 56 reservations, 4 room types, 23 rooms, 12 seasonal rates, 44 guests, 48 enquiries, 11 conversations / 76 messages, 47 follow-ups, 216 audit events |
| Hospital (Sunrise Multispeciality) | 645 | 88 appointments, 9 doctors, 7 departments, 18 insurance cases, 44 patients, 48 leads, 11 conversations / 64 messages, 39 follow-ups, 317 audit events |
| GR Chicken sample shop | 360 | 64 orders, 128 order events, 18 GR order follow-ups, 7 menu items, 30 customers, 11 conversations / 44 messages |
| Real estate | 153 | 6 projects, 13 site visits, 20 AI call records (simulated), 32 leads, 23 follow-ups |
| Textile | 180 | 12 products, 18 quotations, 4 sales orders, 32 leads, 23 follow-ups, 1 campaign / 20 recipients |
| Retail | 197 | 10 products, 18 sales orders, 7 feedback records, 32 leads, 27 follow-ups, 1 campaign / 20 recipients |
| Manufacturing | 124 | 46 quality inspections (Line 3 deliberately worse), 9 agent task runs, 4 team tasks, 14 leads |
| Agency | 136 | 30 leads, 5 campaigns / 20 recipients, 27 follow-ups |

## What is real and what is not

| Area | Status |
|---|---|
| Ordering, booking, appointment and insurance workflows; locks; idempotency; permissions | Real and covered by tests |
| Dashboards and the Data & APIs page | Real, computed only from the workspace's own records |
| WhatsApp sends, voice calls and follow-ups in development | **Simulated** (`DRY_RUN=true`, workers off on staging) |
| Payments / deposits | Simulated or staff-verified. **No payment gateway is connected.** |
| Insurance submission to insurers / TPAs | **Not connected.** Decisions are recorded manually, with the insurer's reference. |
| Outbound voice for food / hotel / hospital; missed-call callbacks | Catalogued as **Not available yet** |
| Plivo / Sarvam real calls, WhatsApp delivery receipts, Meta lead webhook | **Need real-provider verification** on staging |

## Deploying to staging

These steps are for `/var/www/staging/tacksharp-pilot-20261017`. This build was **not** deployed from here, because the staging hosts are unreachable from the build workspace.

1. **Back up:**
   ```
   mysqldump <staging_db> > backup-$(date +%F-%H%M).sql
   ```
2. **Copy in the changed files** over `apps/api` and `apps/web`. Do not overwrite `.env`.
3. **Apply the migrations (approval required).** In `apps/api`, run `npx prisma migrate status`, then `npx prisma migrate deploy`, then `npx prisma generate`. Both migrations are additive:
   - `20261021000000_multi_industry` adds:
     - `Organization.isDemo`
     - `OrganizationMembership`
     - `QualityInspection`
   - `20261022000000_food_hotel_hospital` adds:
     - nullable / defaulted columns on `MenuItem`, `Order` and `OrderItem`
     - new tables `AgentSession`, `RoomType`, `Room`, `RoomRate`, `Reservation`, `Department`, `Doctor`, `Appointment` and `InsuranceCase`

   Never use `prisma db push` or `migrate reset`.
4. **Build:** run `npm run build` in `apps/api` and in `apps/web`.
5. **Optional: run the seed command above**, on staging only.
6. **Restart only the staging processes.** First run `pm2 describe <name>` to confirm each one is the staging API (port 3103) or the staging web (port 3102). Then run `pm2 restart <staging-api> <staging-web>`. Never `pm2 restart all`. Keep `RUN_WORKERS=false` and `DRY_RUN=true`.
7. **Smoke test:**
   - `https://platform-api.tacksharp.in/health`
   - log in at `https://platform.tacksharp.in`
   - switch into each demo workspace and open Overview, the module pages, Data & APIs and the Scenario runner
   - in GR Chicken, confirm the menu and overview are unchanged

## Rollback

1. Restore the previous `apps/api` and `apps/web` build directories, or check out the previous release.
2. Restart the two staging processes, using the same PM2 check as in step 6.
3. You can leave the migrations in place. They are additive, and the old code ignores the new columns and tables.
4. To fully revert the schema, restore the step-1 backup. This is a database restore and needs approval.
5. To remove only the demo data, delete the `org_demo_*` organizations' records on staging. This is a destructive operation and needs explicit approval.

## Tests

| Suite | Result |
|---|---|
| `apps/api`: `TEST_DB_NAME=<test db> npx vitest run` | **945 / 945** passing (39 files), including 19 in `verticals.integration.spec.ts` and 14 in `multi-industry.integration.spec.ts` |
| `apps/web/tests/api-sweep.py` | **50 / 50**: every read API in each demo workspace, counts matched against the inventory, all scenarios, live workspace refuses scenarios |
| `apps/web/tests/ui-industries.py` | **119 / 119**: nine industries, menus, KPIs, module pages, catalogue, isolation, drawer, no overflow at 320–1440 px |
| `ui-textile` / `ui-agents` / `ui-finance` / `ui-marketing` / `ui-pilot` | 29 / 25 / 22 / 21 / 17, all passing |

Run the API tests with no API server attached to the same test database. A running server's worker picks up the tests' follow-ups and makes about a dozen workflow tests fail intermittently.
