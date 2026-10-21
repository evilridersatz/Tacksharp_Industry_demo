# Live workspaces: customers, consent-gated contact tests, release check

## What was wrong

1. **A live (non-demo) workspace had no customer management.**
   - The API had no customer endpoints: customers existed only as a side effect of WhatsApp chats, leads or seeds.
   - Most industry menus had no page for customers. Textile's "Customer database" and retail's "Customers" went to the marketing audience tab.
   - So a new real workspace showed empty lists and no way to add anyone.
2. **Nothing on screen said whether you were looking at demo data or a live workspace**, apart from the banner inside demo workspaces.
3. **Voice safety gap.**
   - `POST /voice/call` placed a call with no confirmation and no calling-consent check.
   - By default it ignored the calling window (`ignoreCallWindow` defaulted to `true`).
   - The voice service itself did not refuse under `DRY_RUN` or for demo customers.
4. **Nothing showed which release is running**, so a deploy could not be verified. Today the live API's uptime shows the latest commit is not deployed.
5. **VisionOps incident numbers could collide (pre-existing bug).**
   - Numbers were `INC-<1001 + row count>`. After incidents were removed (a scenario reset deletes a site's incidents), the count pointed at numbers still in use.
   - The six retries then all collided, and scenarios failed with "Could not allocate an incident number".
   - Fix: the number is now the highest one in use + 1.
   - Regression test: `visionops.integration.spec.ts` › "incident numbers stay unique…". It fails on the old code and passes now.

## What changed

### API: `apps/api/src/customers/` (new module, existing tables only, no migration)

| Endpoint | Permission | What it does |
|---|---|---|
| `GET /customers?q=&consent=&page=&pageSize=` | `customers.view` | Search by name, phone digits or email. Filter by consent: `messaging`, `calling`, `none` or `opted_out`. Paged, at most 100 per page. Current workspace only. |
| `POST /customers` | `customers.manage` | Validates name, phone (normalised to country code + number), email, language and tags. Granting consent requires `consentSource`. A duplicate phone returns `409` with the existing id. Inherits `isDemo` from the workspace. Audited. |
| `GET /customers/:id` | `customers.view` | Returns the record, its history (enquiries, chats, calls, follow-ups, orders, reservations, appointments, audit) and `contactReadiness`. |
| `PATCH /customers/:id` | `customers.manage` | Edits the record. `optedOut: true` clears both consents. Opting back in requires new consent. Audited. |
| `POST /customers/:id/whatsapp-test` | `customers.contact` | Requires `{confirm: true}`. Result is `blocked`, `simulated` or `accepted`; see "Contact tests" below. |
| `GET /customers/:id/messages/:messageId` | `customers.view` | Delivery status of a test message: `accepted`, then `sent`, `delivered`, `read` or `failed` from webhooks. |
| `POST /customers/:id/test-call` | `customers.contact` | Requires `{confirm: true}`. Result is `blocked`, `not_placed` or `started`, with the calling window respected. |

**Roles:**
- admin and manager: all three customer permissions.
- sales, front desk, reception and marketing: view and manage.
- operations, insurance and finance: view.
- technician: none.
- Only admin and manager can run live contact tests.

### Contact tests

The order of checks, for both the WhatsApp test and the test call:

1. **Confirmation.** Without `confirm: true` the API returns `400`.
2. **Blockers.** The result is `blocked`, with reasons, if any of these apply:
   - no phone number;
   - the customer opted out or is marked do-not-contact;
   - no consent for that channel;
   - the provider is not configured.
3. **Live gate** (the same `liveGate` the follow-up workers use). The result is `simulated` / `not_placed` if any of these apply:
   - `DRY_RUN` is on;
   - the workspace or customer is demo;
   - the number is not on `LIVE_TEST_RECIPIENTS` (unless `LIVE_ALLOW_ALL_CUSTOMERS=true`).

   A simulated WhatsApp test is stored as a message marked `[TEST · SIMULATED]`. Nothing reaches a provider.
4. **WhatsApp outside the 24-hour window.** The approved template is used. If no template is configured, the result is `blocked`; it is not sent as free text.
5. **Success.**
   - **WhatsApp:** shown only as "accepted by Meta". The message stores the provider id (`externalId`). Delivery receipts from the webhook move it to delivered, read or failed, and the page polls for that.
   - **Calls:** a started call shows on the AI calls page.

Every outcome is audited.

### Voice hardening

- `VoiceService.startOutboundCall` returns `not_live` and dials nothing when `DRY_RUN` is not exactly `false`, or when the customer is demo. This covers every caller: AI calls page, lead page, follow-ups and the new test call.
- `POST /voice/call` now needs `confirm: true`, and checks calling consent and the live gate.
- The calling window now applies unless the caller explicitly sends `ignoreCallWindow: true`.
- The calls page and the lead page ask for confirmation first.

### Web

- **New `/contacts` page.** It appears in the menu of every agent industry and uses the industry's own wording:
  - hotel: Guests;
  - hospital: Patient contacts;
  - real estate: Buyers & contacts;
  - manufacturing: Customer contacts;
  - agency: Clients & contacts;
  - textile, retail and food: Customers.

  GR restaurant and CCTV menus are unchanged.
- **What the page offers:**
  - search, consent filter and paging;
  - add or edit with field errors and a consent-source question;
  - opt-out;
  - history;
  - a contact-readiness card that says **LIVE** or **not live (reason)** before any action, with confirmation dialogs that say whether something real will happen.
- **Badge next to every page title:** "Live workspace" (green) or "Demo data" (amber).
- **Overview card for an empty live workspace:** "Live workspace — no customers yet … Nothing here is sample data", with Add a customer, Import a list and Connect WhatsApp. No demo data is ever seeded into it.

### Release check

- `GET /health` now returns `release: { id: $RELEASE_ID, startedAt, dryRun }`.
- Every page carries `<meta name="tacksharp-release" content="$NEXT_PUBLIC_RELEASE_ID">`.

## Tests

| Suite | Result (local, test DB `tacksharp_merge`, DRY_RUN=true) |
|---|---|
| `apps/api/test/customers.integration.spec.ts` (new, 8 tests) | 8/8 |
| API full suite `npx vitest run` (44 files) | 991/991 |
| `apps/api/test/visionops.integration.spec.ts` new numbering test | fails on the old code, passes with the fix |
| `ui-industries.py` | 160/160 (switcher check now waits for hydration; camera card wraps at 320 px) |
| `api-sweep.py` | 68/68 (was 60/68: incident-number collisions) |
| `ui-textile` / `ui-agents` / `ui-finance` / `ui-pilot` / `ui-marketing` | 29/29 · 25/25 · 22/22 · 17/17 · 21/21 (marketing needs workers on, DRY_RUN on) |

**What the new API tests cover:**
- add, with validation, normalisation and duplicate `409`;
- the same number in another workspace is a separate customer;
- list, search, filters and paging;
- edit and history;
- cross-workspace read and edit returns `404`;
- opt-out and re-consent;
- WhatsApp test: confirmation; blocked without consent; simulated under DRY_RUN and for unapproved numbers; blocked with the window closed and no template; accepted only for an approved number; delivery receipt to `delivered`; another workspace cannot read the status;
- demo workspace never live;
- test call: confirmation, consent, `not_placed`, `started` with `ignoreCallWindow: false`;
- the voice service refuses under DRY_RUN and for demo customers, and Plivo is never called;
- role permissions.

**Running the UI test:** `ui-contacts.py` needs the provider variables set; placeholders are fine because DRY_RUN blocks every provider request. Without them the contact buttons are correctly disabled as "not configured".

## Deploy to staging (new release directory, keep the previous one)

These commands were **not** run from the build workspace, which has no access to the AWS host. Run them on the server. Replace `<…>` after checking the values.

```bash
# 0. Find what runs now (record the output)
pm2 ls
pm2 describe <staging-api> | grep -E "exec cwd|script path|script args|status"    # expect port 3103
pm2 describe <staging-web> | grep -E "exec cwd|script path|script args|status"    # expect port 3102
PREV=<exec cwd of the API, minus /apps/api>        # e.g. /var/www/staging/tacksharp-pilot-20261017
curl -s https://platform-api.tacksharp.in/health ; echo

# 1. New release directory from the reviewed commit (does not touch $PREV)
SHA=<commit to deploy>
NEW=/var/www/staging/tacksharp-$(date +%Y%m%d-%H%M)-${SHA:0:7}
git -C "$PREV" fetch origin visionops-staging-integration-20261019
git clone --no-checkout "$PREV" "$NEW" && git -C "$NEW" checkout "$SHA"
cp -p "$PREV/apps/api/.env" "$NEW/apps/api/.env"                       # secrets stay on the server
[ -f "$PREV/apps/web/.env.production" ] && cp -p "$PREV/apps/web/.env.production" "$NEW/apps/web/"
cp -p "$PREV/apps/api/.env" ~/env-backup-api-$(date +%F-%H%M)          # config backup

# 2. Install and build
cd "$NEW" && npm ci && npm run build:ai
cd apps/api && npx prisma generate
npx prisma migrate status        # STOP here if it lists pending migrations: they need approval first
REL=$(git rev-parse --short HEAD)
npm run build
cd ../web && NEXT_PUBLIC_RELEASE_ID=$REL npm run build

# 3. Switch ONLY the two staging processes to the new directory
#    (use the script / args recorded in step 0; the usual ones are shown)
pm2 delete <staging-api>
cd "$NEW/apps/api" && RELEASE_ID=$REL DRY_RUN=true RUN_WORKERS=false PORT=3103 pm2 start dist/main.js --name <staging-api>
pm2 delete <staging-web>
cd "$NEW/apps/web" && pm2 start node_modules/.bin/next --name <staging-web> -- start -p 3102
pm2 save

# 4. Verify the live service is the new release
curl -s https://platform-api.tacksharp.in/health        # release.id == $REL, dryRun: true
curl -s https://platform.tacksharp.in/login | grep -o 'tacksharp-release" content="[^"]*'
#    then log in → home (live) workspace → Customers: add a test customer with YOUR number,
#    Send WhatsApp test → must say "Simulated, not sent: DRY_RUN is on"; a demo workspace shows "Demo data".
```

Check the `.env` of the previous release for `PORT`, `DRY_RUN` and `RUN_WORKERS`. Whatever it sets wins over defaults, so keep the values it already has.

**Rollback** (the previous release directory is untouched):

```bash
pm2 delete <staging-api> && cd "$PREV/apps/api" && pm2 start <recorded script> --name <staging-api> -- <recorded args>
pm2 delete <staging-web> && cd "$PREV/apps/web" && pm2 start <recorded script> --name <staging-web> -- <recorded args>
pm2 save && curl -s https://platform-api.tacksharp.in/health
```

No schema change, so nothing to undo in the database.

**Going live with real sends later** is a separate, explicit decision:
- set `DRY_RUN=false`;
- set `LIVE_TEST_RECIPIENTS` to your own numbers first;
- configure the WhatsApp template.

This deploy keeps `DRY_RUN=true`.
