# Essential SaaS modules (P2): team inbox, CRM, Campaign Studio, drip automation

One backend, one login, one tenant model, one dashboard. Every module is organization-scoped from the session, checks
permissions per action, writes audit events, and sends nothing to a customer except through the same live gate as the
rest of the product (`DRY_RUN`, approved test numbers, demo customers never contacted).

| Module | Status | Where |
|---|---|---|
| Team inbox + human hand-over | Done | `/inbox`, `apps/api/src/inbox/` |
| CRM | Done | `/contacts` (drawer → CRM panel), `apps/api/src/customers/` |
| Campaign Studio | Existed already; verified | `/marketing`, `apps/api/src/marketing/` |
| Drip automation | Done | `/drips`, `apps/api/src/drip/` |

Migrations (additive only: new columns / tables, nothing dropped or rewritten):
`20261103000000_team_inbox`, `20261103100000_crm`, `20261103200000_drip`.

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

## Not done (pending)

P3: Visual Workflow Studio, Instagram / Messenger, Meta Conversions API, live AI steering, advanced analytics, more
integrations. P4: MCP server, advanced agent builder and versioning, knowledge studio, enterprise subscriptions and
billing. Drip: per-step A/B variants and entry triggers (enrol automatically on a stage change) are not built; enrolment
is manual (by stage, tag or customer).

## Production

Apply the three migrations above after a verified backup (`GR-CHICKEN-SARVAM-LAUNCH.md` has the runbook). They only
add columns and tables. Drip sends nothing until a sequence is created, activated and customers are enrolled.
