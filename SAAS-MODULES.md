# SaaS modules: team inbox, CRM, Campaign Studio, drip automation (P2); Meta Conversions API, Instagram & Messenger (P3)

One backend, one login, one tenant model, one dashboard. Every module is organization-scoped from the session, checks
permissions per action, writes audit events, and sends nothing to a customer except through the same live gate as the
rest of the product (`DRY_RUN`, approved test numbers, demo customers never contacted).

| Module | Status | Where |
|---|---|---|
| Team inbox + human hand-over | Done | `/inbox`, `apps/api/src/inbox/` |
| CRM | Done | `/contacts` (drawer → CRM panel), `apps/api/src/customers/` |
| Campaign Studio | Existed already; verified | `/marketing`, `apps/api/src/marketing/` |
| Drip automation | Done | `/drips`, `apps/api/src/drip/` |
| Instagram & Messenger (P3) | Done for the team inbox (AI replies pending; not yet tested against Meta) | Settings → Integrations → Instagram & Messenger, `/inbox`, `apps/api/src/social/` |
| Meta Conversions API (P3) | Done (not yet tested against Meta) | Settings → Integrations → Meta Conversions API, `apps/api/src/meta-capi/` |

Migrations (additive only: new columns / tables, nothing dropped or rewritten):
`20261103000000_team_inbox`, `20261103100000_crm`, `20261103200000_drip`, `20261103300000_meta_capi`, `20261103400000_social_identity`.

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

## Not done (pending)

P3: Visual Workflow Studio, AI replies on Instagram / Messenger, live AI steering, advanced analytics, more
integrations. P4: MCP server, advanced agent builder and versioning, knowledge studio, enterprise subscriptions and
billing. Drip: per-step A/B variants and entry triggers (enrol automatically on a stage change) are not built; enrolment
is manual (by stage, tag or customer).

## Production

Apply the five migrations above after a verified backup (`GR-CHICKEN-SARVAM-LAUNCH.md` has the runbook). They only
add columns and tables. Drip sends nothing until a sequence is created, activated and customers are enrolled.
