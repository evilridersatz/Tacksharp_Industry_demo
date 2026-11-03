# GR Chicken on Sarvam: launch runbook (P0)

Branch `enterprise-saas-20261029`. The current production release (`/var/www/staging/releases/tacksharp-20261028-531e3d4`,
commit `531e3d4`) is left untouched; this release goes into a NEW directory and is switched only after it is verified.

## 1. Why the live agent spoke Hindi, answered off-topic and invented menu facts

| Symptom | Root cause (evidence) | Fix |
|---|---|---|
| Hindi | Language is a **Sarvam console** setting (starting language, "Languages allowed", auto-detect). Sarvam documents no API for it, so no code can force it. | Console change (section 3) + the dashboard's **Sarvam phone agent setup** shows the exact values. Our own engines never select Hindi (`AGENT_LANGUAGES` = ta, en, tanglish). |
| Irrelevant answers / invented prices or products | The Sarvam-hosted agent had **no tools**: it answered from its prompt and model knowledge. Production `531e3d4` has **no** `/telephony` module at all (`git show 531e3d4:apps/api/src/telephony/telephony.controller.ts` → does not exist). | New grounded tools `/telephony/sarvam/tools/*` (menu, item, quote, order, status, handoff, on-start context) answered from the GR Chicken database. |
| Calls not in the dashboard | `531e3d4` cannot receive `POST /telephony/sarvam/webhook` (route does not exist there). The "200" when the webhook was set came from **Sarvam's** API accepting the URL, not from our server. | Deploy this release. The webhook now also accepts the organization-level scope `inbound` (the hosted agent has no agent row here) and writes a factual summary. |
| Plivo still wired in | Ready calls, feedback calls, lead follow-up calls and the "test call" dialled Plivo. | Plivo removed; every outbound call goes through `TelephonyService` → Sarvam (section 6). |

## 2. What the tools do (all tenant-scoped, authenticated, rate-limited)

Header `x-tacksharp-org: <organizationId>` and `x-tacksharp-tool-key: HMAC(TELEPHONY_WEBHOOK_SECRET, "tools|<org>")`.
A wrong or missing key → 403; without the secret every tool refuses.

| Tool | Answers from | Never |
|---|---|---|
| `context` (on-start hook) | business name, caller's saved name, menu with prices, unavailable items, shops and hours, pickup-only, language rule | — |
| `item` | the product the caller named (English, Tanglish "naatu kozhi", Tamil "நாட்டுக்கோழி") | invents a product: "mutton" → "not on our menu" + what is available |
| `quote` | `OrdersService.quote` (stock, minimums, cuts, shop hours); returns a 30-minute HMAC-signed cart | guesses quantity / cut / pickup time: it asks |
| `order` | the signed cart, only with `confirmed=yes`; `createOrder` re-prices in a transaction (`expectedTotal`) | double-orders on retries (idempotent per call); says "placed" without an order number; charges a changed price |
| `status` | latest order of the caller | another tenant's order |
| `handoff` | a high-priority "Call back" task (one per caller per day) | — |

WhatsApp confirmation: only when the caller says yes on the call; that is recorded as messaging consent and the
existing `OrderFollowUpService` sends it (approved template outside the 24 h window, `DRY_RUN` and live-gate rules).

## 3. Sarvam console: exact changes (operator, with Sarvam access)

Open **Voice agents → Sarvam phone agent setup** in the dashboard (admins/managers). Then in the Sarvam console for
agent `GR-Chicken--187d6b05-c430`:

1. **Languages**: starting language **Tamil (ta-IN)**; languages allowed **Tamil and English only**; remove **Hindi** and
   every other language; keep auto-detect on.
2. **Instructions**: paste "Agent instructions" from the pack (copy button).
3. **On-start hook** and the six **API tools** (`get_menu`, `get_item`, `quote_order`, `place_order`, `order_status`,
   `request_callback`): URL, method, headers, body (Sarvam `@variables`) and "save reply into variables" exactly as
   listed. An org admin presses **Show the tool key** to copy it; it is hidden otherwise.
4. Pick the caller-number variable from Sarvam's variable list for `caller_phone` (Sarvam does not document its name).
5. **Post-call webhook**: the URL shown in the pack (scope `inbound`). Pause → update → resume as before.
6. Re-publish the agent version, then place one test call from an approved number (section 5).

Sarvam does not document a config API for these settings, so this pack is the source of truth; nothing is pushed
automatically.

## 4. Rotate `TELEPHONY_WEBHOOK_SECRET` (the old value was exposed)

The webhook URL token and the tool key are both derived from this secret, so rotation invalidates both at once.

```bash
# on the host, in the NEW release (never print the value)
cd "$NEW/apps/api"
NEWSECRET=$(node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))")
cp -p .env ~/backups/env-pre-rotation-$(date +%F-%H%M)
sed -i "s|^TELEPHONY_WEBHOOK_SECRET=.*|TELEPHONY_WEBHOOK_SECRET=$NEWSECRET|" .env; unset NEWSECRET
grep -c '^TELEPHONY_WEBHOOK_SECRET=' .env      # expect 1
npm run check:config                          # names only; must say the secret is set (32+ chars)
```

After the API restarts with the new secret: copy the NEW webhook URL and tool key from the dashboard pack into
Sarvam (section 3, steps 3 and 5). Calls between the restart and the console update are refused (403), never accepted
with the old token.

## 5. Deploy (new release directory; production untouched until verified)

Follow `DEPLOY.md` steps 1–7 with these specifics:

```bash
PREV=/var/www/staging/releases/tacksharp-20261028-531e3d4      # current, do not modify
SHA=<git log -1 --format=%h origin/enterprise-saas-20261029>
NEW=/var/www/staging/releases/tacksharp-$(date +%Y%m%d)-$SHA
git clone --no-checkout "$PREV" "$NEW" && git -C "$NEW" fetch origin enterprise-saas-20261029 && git -C "$NEW" checkout "$SHA"
cp -p "$PREV/apps/api/.env" "$NEW/apps/api/.env"; [ -f "$PREV/apps/web/.env.production" ] && cp -p "$PREV/apps/web/.env.production" "$NEW/apps/web/"
cd "$NEW" && npm ci && cd apps/api && npx prisma generate && npm run check:config
```

`.env` additions (names only): `TELEPHONY_WEBHOOK_SECRET` (rotated, section 4), `KNOWLEDGE_DIR` (absolute, writable,
outside the release), `CREDENTIALS_KEYS` / `CREDENTIALS_ACTIVE_KEY`, `SARVAM_AGENTS_API_KEY`, `SARVAM_AGENTS_ORG_ID`,
`SARVAM_AGENTS_WORKSPACE_ID`, `SARVAM_AGENTS_CONNECTION_ID`, `SARVAM_AGENTS_PHONE_NUMBER`. `PLIVO_*` can be deleted
(ignored; startup warns while they are present). Keep `DRY_RUN=true` until the live call test.

**Migrations (database change: backup first, DEPLOY.md step 2).** Approved by the owner on 2026-11-03 for production
(all five, after a verified backup). From `531e3d4` five are pending, all additive (no drop, rename or rewrite):
- `20261029000000_enterprise_platform`: `IntegrationCredential`, `IntegrationEvent`, defaulted `Organization` / `User` columns;
- `20261030000000_voice_agents`: knowledge bases/documents/chunks, `VoiceAgent`, `TelephonyCallRequest`, `TelephonyWebhookEvent`, nullable `Call.agentId`, and `Call.provider` (existing rows read `plivo`, which is true for them).
- `20261103000000_team_inbox`: `Conversation` inbox columns (status, priority, assignee, labels, AI on/off, hand-off
  reason/time, last customer message; defaults keep today's behaviour), `ConversationNote`, `SavedReply`;
- `20261103100000_crm`: nullable `Customer.attributes` / `stage` / `followUpAt` + indexes, `CustomerNote`;
- `20261103200000_drip`: `DripSequence`, `DripEnrollment`, `DripStepRun` (new tables only);
- `20261103300000_meta_capi`: `MetaCapiEvent` (new table only);
- `20261103400000_social_identity`: `SocialIdentity` (new table only);
- `20261103500000_workflows`: `Workflow`, `WorkflowRun` (new tables only);
- `20261103600000_mcp_keys`: `McpAccessKey` (new table only);
- `20261103700000_ai_steering`: `Conversation.aiMode` (default 'auto'), `aiGuidance`, `aiGuidanceUntil` (nullable);
- `20261103800000_agent_builder`: `AgentVersion`, `AgentTestCase` (new tables), `VoiceAgent.requireTestsToPublish`
  (default false);
- `20261103900000_subscriptions`: `BillingContract`, `Subscription`, `PlatformInvoice` (new tables only; no
  organization gets a plan, so nothing is limited until a platform admin assigns one).
  **These seven were approved by the owner on 2026-11-03 (evening)**, after the morning approval of the five above.
  Approval covers applying them; it still has to happen after the verified backup in the runbook below.
- `20261104100000_knowledge_studio`: `KnowledgeDocument.authored` (default false), `KnowledgeGap` (new table).
  Additive; written after that approval under the owner's "finish everything" instruction. **Confirm it with the owner
  before applying.**
- `20261104200000_invoice_payment_links`: nullable `PlatformInvoice.paymentLinkId` (unique) / `paymentLinkUrl` /
  `paymentLinkStatus`, `PaymentWebhookEvent` (new table). Additive; **confirm with the owner before applying.**

Historical Plivo calls, credentials and number mappings stay in the database. Drip sends nothing until a sequence is
created, activated and customers are enrolled; the inbox keeps the AI on for every existing conversation.

```bash
npx prisma migrate status && npx prisma migrate deploy && npx prisma migrate status
npm run build && cd ../web && NEXT_PUBLIC_RELEASE_ID=$SHA npm run build
# switch only the recorded API + web processes (DEPLOY.md step 5), then:
API=https://gr-api.tacksharp.in EXPECT_RELEASE=$SHA bash "$NEW/apps/api/scripts/smoke-deploy.sh"
cd "$NEW/apps/api" && GR_ORGANIZATION_ID=org_gr_chicken npm run verify:restaurant   # read-only: live menu, prices, quote (nothing ordered)
```

`verify:restaurant` calls the deployed tools with the real tool key against the real GR Chicken menu: wrong key → 403,
menu, on-start context with the no-Hindi rule, prices for "broiler" / "naatu kozhi" / "நாட்டுக்கோழி", "mutton
biryani" refused, a Tanglish quote. It places no order.

**Live call test (needs explicit approval immediately before):** approved number in `LIVE_TEST_RECIPIENTS`, customer
with calling consent, `DRY_RUN=false` only for the test, the GR Chicken Sarvam agent chosen as "agent for automatic
calls", then `npm run verify:restaurant -- --call=<number>`. Inbound: call `+918064269808`, order in Tamil, confirm,
say yes to WhatsApp; check the order, the WhatsApp delivery status and the call transcript + summary in the dashboard.

**Rollback:** `DEPLOY.md` step 7 (start the recorded `$PREV` processes). The new tables can stay; the old code ignores
them. Restore the `.env` backup if the secret was rotated, and point the Sarvam webhook back.

## 6. Plivo removal report

- Removed: `plivo` npm package; `voice/voice.service.ts` (Plivo call engine), `voice/stream/*` (Plivo audio stream),
  `voice/plivo-xml.ts`, `voice/plivo-signature.ts`, `voice/turn-dedupe.ts`, `telephony/plivo.provider.ts`,
  `restaurant/ready-call.controller.ts`; routes `/voice/answer|inbound|turn|hangup`, `/voice/ready/*`,
  `/voice/feedback/*`, `/integrations/plivo/*`; `config.plivo`; Plivo from the credential vault providers, setup
  page `/settings/integrations/plivo`, verify scripts, smoke test and marketing copy.
- Re-routed to Sarvam (`TelephonyService.placeSystemCall`, same gates as `placeCall`: consent, opt-out, DND, calling
  hours, limits, idempotency, `DRY_RUN` + live gate): lead follow-up calls, order feedback calls, `/voice/call`, the
  customer "test call". Order-ready notices go on WhatsApp (a Sarvam ready-call agent is pending).
- Kept (records only): `Call` rows with Plivo ids, `IntegrationCredential` rows with `provider='plivo'`,
  `OrganizationChannel` rows of kind `plivo_number`. Nothing is deleted.

## 7. Redis 6.0.16

BullMQ 6.3.11 requires Redis ≥ 5.0.0 (hard check) and recommends ≥ 6.2.0 (startup warning only); the 6.0.6+ code
paths are used. 6.0.16 runs the queues; it is not a launch blocker. Not verified here: local tests ran on Redis 7.0.15.
Recommendation: move to Redis 7.2 (official Redis apt repository) in a maintenance window, with an RDB snapshot first.
