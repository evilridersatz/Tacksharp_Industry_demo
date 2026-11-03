# SaaS modules: team inbox, CRM, Campaign Studio, drip automation (P2); Meta Conversions API, Instagram & Messenger, Visual Workflow Studio, advanced analytics, live AI steering (P3); MCP server, advanced agent builder (P4)

One backend, one login, one tenant model, one dashboard. Every module is organization-scoped from the session, checks
permissions per action, writes audit events, and sends nothing to a customer except through the same live gate as the
rest of the product (`DRY_RUN`, approved test numbers, demo customers never contacted).

| Module | Status | Where |
|---|---|---|
| Team inbox + human hand-over | Done | `/inbox`, `apps/api/src/inbox/` |
| CRM | Done | `/contacts` (drawer → CRM panel), `apps/api/src/customers/` |
| Campaign Studio | Existed already; verified | `/marketing`, `apps/api/src/marketing/` |
| Drip automation | Done | `/drips`, `apps/api/src/drip/` |
| Advanced agent builder (P4) | Done | AI agents → an agent → Test (saved test cases) / Launch (versions), `apps/api/src/voice-agents/agent-tests.ts` |
| MCP server (P4) | Done (tested with the official MCP SDK client; not yet with a hosted AI assistant) | Settings → Integrations → MCP server, `apps/api/src/mcp/` |
| Live AI steering (P3) | Done (not for restaurant ordering) | Team inbox → Steer the AI, `apps/api/src/inbox/steering.ts` |
| Advanced analytics (P3) | Done | Reports & analytics → Advanced analytics, `apps/api/src/analytics/` |
| Visual Workflow Studio (P3) | Done | `/workflows`, `apps/api/src/workflows/` |
| Instagram & Messenger (P3) | Done for the team inbox (AI replies pending; not yet tested against Meta) | Settings → Integrations → Instagram & Messenger, `/inbox`, `apps/api/src/social/` |
| Meta Conversions API (P3) | Done (not yet tested against Meta) | Settings → Integrations → Meta Conversions API, `apps/api/src/meta-capi/` |

Migrations (additive only: new columns / tables, nothing dropped or rewritten):
`20261103000000_team_inbox`, `20261103100000_crm`, `20261103200000_drip`, `20261103300000_meta_capi`, `20261103400000_social_identity`, `20261103500000_workflows`, `20261103600000_mcp_keys`, `20261103700000_ai_steering`, `20261103800000_agent_builder`.

## Team inbox and human hand-over

- 3-pane inbox for every channel and industry: filters (status, mine / unassigned / person, priority, channel, AI off /
  hand-off, label), search (name, number, message text), counts.
- **Take over**: the AI stops for that conversation. Customer messages are stored and shown to the team but the AI is
  not run (`heldForTeam`). **Return to AI** turns it back on. An automatic AI hand-off opens a high-priority item with
  a summary of the customer's last messages, and can be auto-assigned round-robin (`settings.inbox.autoAssign`).
- Staff replies: refused when the customer opted out / is DND or the 24 h window is closed. In test mode they are saved
  as "not sent (test mode)", never shown as sent. The author is saved.
- Internal notes, labels, priority, assignment (support can assign only to themselves), saved replies, audit events.
- Roles added: `team_lead`, `support`, `analyst` (read-only). Permissions: `inbox.view`, `inbox.reply`, `inbox.manage`.
- Tests: `test/inbox.integration.spec.ts` (10), `tests/ui-inbox.py` (17).

## CRM

- Stage (new / interested / qualified / converted / lost), next follow-up date, custom attributes (up to 20; keys
  `a-z0-9_`; text / number / true-false), notes, tasks.
- Lead score 0–100 from database facts only, with its reasons (stage, recent replies, orders, consents, email, open
  lead). Opted-out, DND or lost = 0.
- Filters by stage, tag and "follow-up due". CSV export of the filtered list: this organization only, up to 5000 rows,
  formula-injection safe, audited. Possible duplicates (same email / name): listed, never merged automatically.
- Tests: `test/crm.integration.spec.ts` (6), `tests/ui-crm.py` (11).

## Campaign Studio (existing module, checked against the spec)

Segments, approved-template campaigns, preview, cost estimate, owner approval (hash of exactly what is sent),
scheduling, pause / resume / cancel, suppression list, consent filter, delivery / read status from Meta webhooks,
reply attribution, per-campaign report, content calendar. Tests: marketing integration specs, `tests/ui-marketing.py`.

## Drip automation

A sequence is up to 10 steps, each **Day N** after enrolment: a WhatsApp message (text while the 24 h window is open,
otherwise an approved template, otherwise the step is skipped) or an **AI call** (the organization's automatic-call
Sarvam agent through `placeSystemCall`, so every telephony gate applies).

- Industry starting templates: Day 0 / 1 / 3 WhatsApp, Day 5 AI call, Day 7 WhatsApp (restaurant, real estate,
  textile / retail, hospital, hotel, generic). The business edits the template before activating.
- Enrol by CRM stage, tag or customer ids. Skipped: opted out / DND, no phone, already in this sequence, or already
  running another sequence (one drip at a time per customer; enforced also by a unique key).
- Every due step re-checks the customer first and **stops** the enrolment on: opt-out, do-not-contact, CRM stage
  converted or lost, a lead marked won, an order placed after enrolment, the team taking over the conversation, or a
  reply (when "stop on reply" is on).
- Contact preferences: WhatsApp needs marketing consent or the customer having contacted the business; a call needs
  calling consent or an enquiry from the customer. Otherwise the step is skipped with the reason.
- Sending hours (IST) per sequence. A step due outside them waits for the next window.
- Safe retries: one run row per (enrolment, step) is written before sending, so a retry or a second worker never sends a
  step twice. Temporary WhatsApp errors retry after 5 / 15 / 60 minutes, then the step is marked failed and the
  sequence moves on. A send whose delivery is unknown (timeout after sending), or a run interrupted mid-send, is marked
  failed and **not repeated**. Enrolments are leased in the database, so several API instances can run the minute tick.
- Pause stops all steps of the sequence; Activate resumes them. Editing steps or hours re-times running enrolments.
- In test mode every step is recorded as **simulated** and the message is saved in the conversation labelled
  "not sent (test mode)".
- API: `GET /drips`, `GET /drips/preset`, `GET /drips/:id`, `POST /drips`, `PATCH /drips/:id`,
  `POST /drips/:id/activate|pause|enroll`, `POST /drips/enrollments/:id/stop`, `GET /drips/customer/:customerId`.
  `marketing.view` to read, `marketing.manage` to change.
- Worker: `WorkersService` runs `DripService.runDue()` every minute (only where `RUN_WORKERS=true`).
- Tests: `test/drip.integration.spec.ts` (9: full Day 0→7 run, enrolment rules, every stop reason, paused, hours,
  consent, live path with retry limit / ambiguous / interrupted, concurrency, re-timing) and `tests/ui-drips.py` (17:
  the real worker runs Day 0 within a minute).

## Meta Conversions API (P3)

Reports conversions to the business's **own** Meta dataset (pixel): there is no shared account and no environment
fallback.

- Setup (Settings → Integrations): access token (encrypted, never shown again), dataset ID, which events (Purchase and
  Lead / Purchase / Lead), optional test event code. **Test connection** reads the dataset (`GET /{pixel-id}?fields=id,name`)
  and sends no event; the integration can be enabled only after it passes. **Send test event** needs a test event code
  (the event shows only under Test events, never used for ads) and is refused while `DRY_RUN` is on.
- Events: **Purchase** when an order is completed (restaurant / food) or a sales order is delivered (textile / retail),
  with value, INR and the order number; **Lead** for each new enquiry. Recorded every minute from the last 7 days,
  newest first; `event_id` = `order:<id>` / `sales_order:<id>` / `lead:<id>` is unique per organization, and Meta also
  de-duplicates on it.
- Privacy: only SHA-256 hashes leave the server (phone normalised with country code, lower-cased email, customer id,
  country). Names, raw numbers and emails are never sent or stored in the outbox. Opted-out, do-not-contact and demo
  customers are never reported (re-checked at send time). The token goes in the request body / Authorization header,
  never in a URL.
- Delivery: batches of 100 to `POST /{pixel-id}/events`. `DRY_RUN` → "simulated", nothing sent. Network / 429 / 5xx
  retry after 5 / 15 / 60 minutes then "failed"; a rejected request is "failed" with Meta's message; events older than
  7 days are "skipped". Failed / skipped events can be retried from the log. Rows are claimed before sending
  (multi-instance safe); a row stuck after a crash is re-queued (safe because of Meta's de-duplication).
- API: `GET /meta-capi/events`, `POST /meta-capi/events/:id/retry`; credentials through `/integrations/meta_capi`.
- Tests: `test/meta-capi.integration.spec.ts` (6: setup and tests, collect / idempotency / skips, DRY_RUN, live request
  shape with hashes only, retries / rejection / opt-out / stale / manual retry, concurrency and event set, isolation)
  and `tests/ui-capi.py` (15, real worker; the passing connection test is seeded because Meta is unreachable here).
- **Not verified against Meta**: needs a real dataset, token and test event code. With `DRY_RUN=false` for the test
  only, set the test event code, press Send test event, and check Events Manager → Test events.

## Advanced agent builder (P4)

On top of the existing builder (templates, knowledge base, test chat, publish / archive):

- **Saved test cases** (step 7, Test): scripted customer conversations, up to 8 messages and 50 cases per agent, with
  checks per message: the reply must mention / must not mention phrases, must / must not hand over to a person, must
  answer from the knowledge base / the AI model / the fallback / the hand-over message. **Run all** plays them through
  the same engine, instructions, knowledge base and AI model as live conversations (nothing is sent; with a model
  configured each message is a real model call) and shows the agent's actual reply and every check. A full run counts
  as testing the agent; editing a test clears its old result.
- **Tests must pass to publish** (optional, per agent): publishing runs the saved cases and is refused with the failing
  tests named (or when there are none).
- **Versions** (step 8, Launch): every publish saves a numbered snapshot of everything that changes what the agent says
  or how it is reached (instructions, greeting, fallback, languages, voice, channels, knowledge base, hours,
  escalation, limits, Sarvam agent), with an optional note and the test summary. **Compare** a version with the current
  configuration (or another version) field by field; **Restore** puts an earlier version back as the configuration,
  which must then be tested and published again (like any edit).
- Found while testing: without an AI model, the knowledge fallback answers with the two best-matching sentences, so a
  price question can also mention another item's price. That is the existing engine's behaviour; a "must not mention"
  check now makes it visible to the business.
- API: `GET/POST /voice-agents/:id/tests`, `PATCH/DELETE /voice-agents/:id/tests/:testId`,
  `POST /voice-agents/:id/tests/run`, `GET /voice-agents/:id/versions`, `GET /voice-agents/:id/diff?from=&to=`,
  `POST /voice-agents/:id/versions/:version/restore`, `POST /voice-agents/:id/publish` (`{ note? }`),
  `PATCH /voice-agents/:id` (`{ requireTestsToPublish }`). `agents.view` to read, `agents.manage` to change.
- Tests: `src/voice-agents/agent-tests.spec.ts` (3), `test/agent-builder.integration.spec.ts` (4, real knowledge base and
  engine) and `tests/ui-agent-builder.py` (14, real Publish button); regression `ui-voice-agents` 36.
- Pending: A/B testing of versions on live traffic, scheduled test runs, test cases generated from real conversations.

## MCP server (P4)

A Model Context Protocol server so a business can connect its **own** AI assistant (any MCP client that supports
Streamable HTTP with an Authorization header) to its workspace.

- Endpoint `POST {API}/mcp` (stateless Streamable HTTP, JSON responses; batches of up to 20). Protocol versions
  2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 (the versions the official TypeScript SDK supports); an unknown
  `MCP-Protocol-Version` header → 400. `GET` / `DELETE /mcp` → 405 (no server stream, no sessions).
- Access keys (Settings → Integrations → MCP server, admins only): `tsk_mcp_…`, shown once, stored only as a SHA-256
  hash; read-only or read + write; revocable at once; last use shown. The session cookie is never accepted on `/mcp`.
  Unknown / revoked keys and suspended organizations → 401. A browser `Origin` that is not one of this deployment's
  web origins (`CORS_ORIGINS`) → 403 (DNS-rebinding protection the MCP spec requires). 120 calls a minute per key.
- Tools (this organization only; phone numbers masked): `search_customers`, `get_customer`, `list_conversations`,
  `get_conversation`, `list_orders`, `analytics_summary`; with a write key also `add_customer_note` (author shown as
  "AI assistant (key name)"), `set_customer_stage`, `create_task`. **No tool messages or calls a customer.** Tool
  problems come back as `isError` results; every call is audited with the key (`entityType: mcp`).
- Tests: `test/mcp.integration.spec.ts` (5: keys, auth, protocol, every tool, isolation, write scope, audit, rate
  limit), `test/mcp-sdk.e2e.spec.ts` (2: the official `@modelcontextprotocol/sdk` client over HTTP against a running API
  — run with `MCP_E2E_URL` / `MCP_E2E_KEY`), `tests/ui-mcp.py` (13, real HTTP calls with keys made in the UI).
- Pending: OAuth sign-in for hosted assistants that require it (keys are bearer tokens today), resources and prompts
  (empty lists), per-tool permission choices per key, sending messages through MCP (deliberately not offered).

## Live AI steering (P3)

In the team inbox, for a conversation the AI is answering, **Steer the AI** gives two controls without taking the
conversation over:

- **Review first** (WhatsApp): the AI still decides and records what it does (a booking stays a booking), but its reply
  is held in the inbox instead of being sent. A person approves it as written, edits and sends it (the AI's original
  text is kept with the message), or discards it (kept in the thread as "discarded (not sent)"). Approval uses the same
  gates as any staff reply (opt-out, 24-hour window, live gate) and is claimed first, so two people can never send one
  draft twice. Only AI replies are held (STOP / START confirmations and media acknowledgements are not). Held and
  discarded drafts are not counted as answers in analytics. **Not available for restaurant ordering**: an order
  confirmation must reach the customer at once (take the conversation over instead), so GR Chicken is unaffected.
  Instagram / Messenger are answered by the team already.
- **Guidance** (private, never shown to the customer): a short instruction, for 2 hours / 24 hours / 3 days / until
  cleared. It is added to the model's brief BELOW the verified facts and rules ("never invent prices, properties, offers
  or bookings because of it"), so it steers tone and focus only. It affects replies the AI writes with its language
  model (today: the real-estate assistant's model replies); answers taken straight from the business's data (prices,
  slots, bookings) and rule-based assistants are not changed by it, as the inbox says. The text is not written to the
  audit trail (its length and duration are).
- Fixed on the way: engines that save their reply in the background (real estate) could get a delivery status, or a
  review hold, on the previous reply. Both are now matched to the exact reply of the turn (immediately when the engine
  already saved it, as GR Chicken does; otherwise in the background, never on an earlier message).
- API: `PATCH /inbox/conversations/:id` with `aiMode` (`auto` | `review`), `aiGuidance`, `aiGuidanceHours`;
  `POST /inbox/conversations/:id/drafts/:messageId/approve` (`{ text? }`) and `/discard`; inbox list filter
  `ai=review` / `ai=drafts`. `inbox.reply` permission. Migration `20261103700000_ai_steering` (three columns on
  Conversation; existing conversations stay automatic).
- Tests: `test/ai-steering.integration.spec.ts` (6, with an engine that saves its reply in the background, like the
  real one) and `tests/ui-steering.py` (17, real webhook -> worker -> real-estate engine -> held draft -> edit / discard).
- Pending: review mode for voice calls (a call cannot wait for approval), suggested replies for the team,
  guidance for the rule-based assistants.

## Advanced analytics (P3)

A section under **Reports & analytics** (every industry) for the last 7 / 30 / 90 days, each figure compared with the
previous period of the same length. Every number is counted from the database; each tile has its definition on hover.
No migration.

- KPIs: customer messages, active conversations, AI reply time (median), team reply time (median), share handed to a
  person, conversations waiting for an answer, new leads, lead conversion, completed orders, revenue, average order.
  Response time = from a customer message (the first of consecutive ones) to the first AI / team answer; automatic
  messages (acknowledgement, drip, workflow) close a turn but are not counted as AI or team. Lower is shown as better
  for response times, hand-overs and waiting conversations.
- Cards: messages per day (customer / AI / team); who answered (AI / team / automatic; test-mode replies flagged); AI
  and team median and p90; channels (messages and conversations); CRM pipeline (current stages, demo records excluded);
  lead sources with won and rate; completed orders per day, buyers and repeat buyers; automation started in the period
  (campaign recipients, drip enrolments and stop reasons, workflow runs, Meta conversions); team (replies, open
  conversations assigned now, median reply time); busy hours (IST weekday × hour heatmap).
- `GET /analytics/advanced?days=`, `GET /analytics/advanced/export?days=` (CSV with BOM, formula-safe). Requires
  `customers.view`; organization from the session. At most 50 000 messages are read per period (the page says so when
  the cap is reached). Measured locally with ~49 000 messages in 30 days: 1.5 s (30 days), 1.7 s (90 days).
- Tests: `src/analytics/metrics.spec.ts` (4), `test/analytics-advanced.integration.spec.ts` (3: every figure checked
  exactly on seeded data, previous period, isolation, CSV) and `tests/ui-analytics.py` (10).
- Pending: scheduled e-mailed reports, custom date ranges, revenue for non-order industries (bookings, appointments,
  sales orders), cost / ROI per channel in this view (the ROI card on the overview stays the source for that).

## Visual Workflow Studio (P3)

A visual editor at `/workflows`: a trigger card, then steps connected top to bottom; a **Condition** splits into **Yes**
and **No** branches (nested up to 4 deep, 40 steps). Steps are added with the + between cards and edited in the side
panel; errors are shown on the card they belong to. Templates: welcome a new lead, thank big orders, refunds to the team.

- Triggers: new enquiry / lead, order completed, customer reaches a CRM stage (once per customer per stage), conversation
  needs a person (AI hand-over or team take-over), customer message containing a keyword. Read from the database every
  minute; only records created / changed **after activation** start a run (never history); each record starts a given
  workflow once.
- Steps: condition (CRM stage, tag, language, source, has email, WhatsApp consent, order total, trigger channel; facts
  read when the step runs), wait (1 minute to 60 days), send WhatsApp, AI call, set CRM stage, add tag, hand to the team
  (AI off, high priority, round-robin), create task, enrol in a drip sequence (must belong to this workspace).
- Messages and calls use the shared `OutreachService` (also used by drip sequences): consent, 24 h window / approved
  template, live gate (DRY_RUN = simulated, saved in the conversation as "not sent (test mode)"), opted-out customers
  skipped. A WhatsApp step marked in flight before sending is never sent twice; temporary failures retry after 5 / 15 / 60
  minutes; AI calls are idempotent per run and step.
- Versioning: every saved change is a new version; a run executes the graph snapshot it started with. Pausing holds all
  runs; activating starts from now. Runs can be stopped; each keeps a step log.
- **Test on a customer**: the saved version against one real customer — conditions on real data, messages previewed
  (would send / would skip and why), changes described, waits skipped; nothing is sent or changed.
- API: `GET/POST /workflows`, `GET/PATCH /workflows/:id`, `POST /workflows/:id/activate|pause|test`,
  `POST /workflows/runs/:runId/stop`. `marketing.view` to read, `marketing.manage` to change.
- Tests: `src/workflows/workflow-graph.spec.ts` (5), `test/workflows-studio.integration.spec.ts` (6: every trigger and step
  with real effects, waits, pause, snapshot after edit, opt-out, live sends with retry limit, interrupted send not
  repeated, test runs, stop, isolation) and `tests/ui-workflows.py` (15, real worker).
- Pending: drag-and-drop free canvas (the editor is a structured top-down flow), loops / jumps between steps,
  webhooks and integrations as steps, per-workflow analytics.

## Instagram & Messenger (P3)

Instagram Direct and Facebook Messenger messages arrive in the **team inbox** and the team replies from there.

- Setup (Settings → Integrations → Instagram & Messenger): Page access token and app secret (encrypted, never shown
  again), Facebook Page ID, optional Instagram account ID, optional automatic acknowledgement. **Test connection**
  reads the Page (`GET /{page-id}?fields=id,name,instagram_business_account`) and checks the linked Instagram account.
  **Enable** (only after a passing test) routes this Page / Instagram account to the workspace; it is refused if
  another organization already has it. **Disable / delete** removes the routing at once.
- Webhook `POST /webhooks/meta-social` (Messenger `object: page`, Instagram `object: instagram`; verify with
  `META_SOCIAL_VERIFY_TOKEN` or the WhatsApp verify token). The `X-Hub-Signature-256` signature is **always required**
  (the organization's app secret, or `META_APP_SECRET`); with no secret every delivery is refused. Unknown or disabled
  Page / account → dropped. There is no default-organization fallback.
- Each message is stored once (Meta's message id, under a per-person lock); echoes of our own sends are ignored; images,
  video, audio and files are shown as labels (`[Image]` ...) and never downloaded or stored. A customer record is
  created on first contact (no phone; `SocialIdentity` links the Meta user id, the display name is read from Meta when
  live) and the conversation opens in the inbox with the AI off and the reason shown.
- STOP / START are honoured (confirmation sent through the live gate). The optional acknowledgement goes out once after
  24 hours of silence, never to an opted-out customer.
- Staff replies: refused when the customer opted out or more than 24 hours after their last message (Meta's rule);
  sent through the Page (`POST /{page-id}/messages`, `messaging_type: RESPONSE`, token in the header). Live gate:
  `DRY_RUN` → saved but not sent; live only to ids in `LIVE_TEST_SOCIAL_IDS` until `LIVE_ALLOW_ALL_CUSTOMERS=true`;
  demo customers never. A rejected send is shown; a send with unknown delivery is marked "unknown" and never resent.
- Inbox: channel filter (WhatsApp / Instagram / Messenger / Phone), channel badges, masked Meta id, "Team only · AI on
  Messenger pending"; "Return to AI" is refused on these channels.
- Tests: `test/social.integration.spec.ts` (6) and `tests/ui-social.py` (16; real signed webhooks to the running API;
  the passing connection test is seeded because Meta is unreachable here).
- **Pending:** AI replies on Instagram / Messenger (the AI engines identify customers by phone; extending them is a
  separate change kept away from the GR Chicken launch), media download / viewing, delivery and read receipts,
  comments and story replies, the Human Agent tag (7-day window). **Not verified against Meta**: needs a Page, an app
  with `pages_messaging` / `instagram_manage_messages` and the webhook subscribed.

## Enterprise subscriptions (P4)

- Plans (`src/billing/plans.ts`): Pilot (3 team members, 1 voice agent, 3 workflows, 3 drip sequences, no MCP keys),
  Growth (15 / 5 / 25 / 25 / 3), Enterprise (unlimited members, 50 / 200 / 200 / 20). Each organization can get
  per-resource overrides (a number or unlimited). Cycles monthly / quarterly / yearly (calendar months, month end
  clamped); statuses trial / active / past_due / cancelled.
- **An organization without a subscription row has no limits.** No existing tenant (GR Chicken included) gets a plan
  from the migration, so nothing changes until Tacksharp staff assign one.
- Limits are enforced on creation only (`src/billing/entitlements.ts`, `assertPlanAllows`): team invitations (home
  users + guests + open invitations count as seats), voice agents (incl. restoring an archived one), workflows, drip
  sequences, MCP keys. Refusal: 403 `code: plan_limit` with a plain message ("Your Pilot plan allows 1 voice agents and
  1 are in use…"). Lowering a plan or cancelling never deletes or disables anything; cancelled only blocks new items.
- Platform console (staff only, `isPlatformAdmin` re-checked in the DB): **Billing** tab (`/platform/billing`):
  subscriptions, unpaid total, renewals due in 7 days, overdue invoices, plans, enterprise contracts (name, billing
  email, GSTIN validated, address). Organization page: **Subscription & invoices** card: assign / change plan, price,
  GST rate, cycle, period start, trial end, contract, overrides, notes; issue the invoice for the current period (one
  per period, numbered `TS-<year>-00001`, GST computed in paise, due in 15 days); record payment with the bank / UPI
  reference; void with a reason; renew (period moves forward one cycle, allowed from 7 days before its end).
  An overdue unpaid invoice puts the subscription in past_due; paying or voiding it returns it to active. All audited.
- Organization: **Plan & billing** (`/settings/billing`, read-only): plan, period, price, usage bars per resource,
  invoices from Tacksharp.
- **No payment gateway is connected.** Nothing is ever charged or marked paid automatically; invoices are records
  (no PDF / e-invoice IRN yet).
- Migration `20261103900000_subscriptions` (new tables only; awaiting approval).
- Tests: `src/billing/plans.spec.ts` (4), `test/billing.integration.spec.ts` (6), `tests/ui-billing.py` (23).
- **Pending:** payment gateway (Razorpay) and automatic dunning, invoice PDF / GST e-invoicing, usage-based (metered)
  pricing for calls and messages, self-service plan change.

## Not done (pending)

P3: AI replies on Instagram / Messenger, more
integrations. P4: knowledge studio; subscriptions: payment gateway, invoice PDF / e-invoicing, metered pricing. Drip: per-step A/B variants and entry triggers (enrol automatically on a stage change) are not built; enrolment
is manual (by stage, tag or customer).

## Production

Apply the migrations above after a verified backup (`GR-CHICKEN-SARVAM-LAUNCH.md` has the runbook). They only
add columns and tables. Drip sends nothing until a sequence is created, activated and customers are enrolled.
