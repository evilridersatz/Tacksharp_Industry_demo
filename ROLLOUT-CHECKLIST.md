# Production rollout checklist (branch `enterprise-saas-20261029`)

One ordered list for the person doing the rollout. Tick each box; **stop at any "STOP"** and do not improvise. The
details behind each step are in `DEPLOY.md` (generic steps) and `GR-CHICKEN-SARVAM-LAUNCH.md` (GR Chicken, Sarvam,
migrations). Nothing here prints a secret: commands show names, counts and statuses only.

## This server (checked read-only on 2026-11-03)

| | |
|---|---|
| Host | AWS Lightsail, Mumbai (ap-south-1), `43.204.240.13`, user `ubuntu`, Ubuntu 22.04, t3.small (2 GB RAM + 4 GB swap) |
| Node / npm | 22 / 10 (fine) |
| Disk | 58 GB, 36 GB free (fine) |
| ffmpeg | installed (4.4.2) |
| Redis | 6.0.16 (the job library recommends 6.2+; works, upgrade later as a separate change) |
| Live release folder (`PREV`) | `/var/www/staging/releases/tacksharp-20261028-531e3d4`, **code `f5c64e6`** (updated in place; the folder name is out of date). Rollback target = this folder as it is. |
| Live processes | pm2 **9 `tacksharp-gr-chicken`** (API, settings from `apps/api/.env`, `DRY_RUN=false`, runs the background jobs) and pm2 **10 `tacksharp-gr-dashboard`** (web, `.next/standalone/apps/web/server.js`). Uptime 3 days, 0 unstable restarts. |
| Database | `tacksharp` on `127.0.0.1`; migrations applied up to `20261030000000_voice_agents` (`migrate status`: up to date) |
| Other processes | pm2 5 / 8 (`tacksharp-platform-*-new-test`, same folder, port 3314, **same live database, `DRY_RUN=false`**, no background jobs) and pm2 0 / 1 (old 22-Oct test release). Not touched by this rollout; owner to decide whether to stop them (`pm2 stop 5 8 0 1`, reversible), because the test copy works on real customer data. |
| `.env` note | Has a stale `DATABASE_URL` (other user). The app ignores it (uses `DB_*`); only the migration tool reads it. Remove that line in the NEW release's `.env` (step 3). |

GR Chicken is **already live** (`DRY_RUN=false`). Keep it that way in the new release: switching it on would stop real
follow-ups. Everything new (drips, workflows, Instagram, payment links, plans) does nothing until someone sets it up.

The live folder is never modified; the new release goes into a new directory and is switched only after it is verified.

## 0. Before you start (people and access)

- [ ] SSH to the AWS host, with permission to run `pm2` for the API and web processes.
- [ ] The owner is reachable for the two sign-offs below (database change, first live send).
- [ ] Sarvam console access for agent `GR-Chicken--187d6b05-c430` (section 7).
- [ ] Meta Business / developer app access for the Page and Instagram account (section 8), if Instagram & Messenger
      goes live now.
- [ ] Razorpay dashboard access (section 9), if online payment goes live now. Otherwise skip section 9: invoices are
      paid by bank transfer / UPI and recorded by staff.
- [ ] A maintenance note to the GR Chicken team: about 10 minutes when the processes switch (step 5).

## 1. Discover (read-only)

- [ ] `pm2 ls`: write down the exact API and web process names, scripts, args and ports (`DEPLOY.md` step 1).
- [ ] Note `PREV=/var/www/staging/releases/tacksharp-20261028-531e3d4` (code `f5c64e6`); pm2 9 and 10 run from it.

## 2. Backup (STOP if any check fails)

- [ ] `DEPLOY.md` step 2 against the **production** database: `mysqldump --single-transaction ...`.
- [ ] `gzip -t` passes; the file size is reasonable; the `CREATE TABLE` count looks right.
- [ ] Restore drill into a scratch database, compare a few row counts, drop the scratch database.
- [ ] Copy the backup **off the server** too, and back up `apps/api/.env`.
- **STOP** if the backup is missing, empty, fails `gzip -t` or the drill fails. No verified backup, no migration.

## 3. New release directory

- [ ] `GR-CHICKEN-SARVAM-LAUNCH.md` section 5: clone into `NEW=/var/www/.../tacksharp-<date>-<sha>`, check out the
      branch's latest commit, copy `.env` from `PREV`, `npm ci`, `npx prisma generate`.
- [ ] Add to `apps/api/.env` (names only; values from the owner / password manager):
  - [ ] `TELEPHONY_WEBHOOK_SECRET`: a **new** 32+ character value (section 4 of the launch runbook; the old one was
        exposed).
  - [ ] `KNOWLEDGE_DIR`: absolute path **outside** the release, writable, included in backups.
  - [ ] `CREDENTIALS_KEYS` / `CREDENTIALS_ACTIVE_KEY` (organizations' own provider credentials).
  - [ ] `SARVAM_AGENTS_*` (5 values) if Tacksharp's own Sarvam account places calls.
  - [ ] Optional: `META_SOCIAL_VERIFY_TOKEN`, `LIVE_TEST_SOCIAL_IDS` (section 8).
  - [ ] Optional: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (section 9).
  - [ ] Invoices: `PLATFORM_LEGAL_NAME`, `PLATFORM_GSTIN`, `PLATFORM_ADDRESS`, `PLATFORM_BILLING_EMAIL`.
  - [ ] `DRY_RUN`: keep today's value (`false` on this server: GR Chicken is live). Delete `PLIVO_*` (ignored now).
  - [ ] Delete the stale `DATABASE_URL` line: `sed -i '/^DATABASE_URL=/d' "$NEW/apps/api/.env"` (the migration tool
        then uses the same `DB_*` login as the app).
- [x] ffmpeg installed (4.4.2).
- [ ] `cd "$NEW/apps/api" && npm run check:config` shows **no required setting missing**. Read every WARN line.
- **STOP** if `check:config` exits with a missing required setting.

## 4. Database migrations (owner sign-off: approved 2026-11-03)

- [ ] `npx prisma migrate status` lists **exactly these 13** as not yet applied (and nothing else; this database
      already has everything up to `20261030000000_voice_agents`):

  `20261103000000_team_inbox`,
  `20261103100000_crm`, `20261103200000_drip`, `20261103300000_meta_capi`, `20261103400000_social_identity`,
  `20261103500000_workflows`, `20261103600000_mcp_keys`, `20261103700000_ai_steering`,
  `20261103800000_agent_builder`, `20261103900000_subscriptions`, `20261104100000_knowledge_studio`,
  `20261104200000_invoice_payment_links`, `20261104300000_drip_variants`.

  All are additive (new tables, nullable or defaulted columns); none drops, renames or rewrites data.
- **STOP** if the list differs (an older migration pending, or a "failed" / "modified" migration). Ask before acting.
- [ ] `npx prisma migrate deploy`, then `npx prisma migrate status` says the schema is up to date.

## 5. Build, pre-flight and switch (all FOUR processes; done this way on 2026-11-03)

The dashboards call `platform-api.tacksharp.in` (pm2 `tacksharp-platform-api-new-test`, port 3314, no background jobs)
and `gr-api.tacksharp.in` (pm2 `tacksharp-gr-chicken`, port 3001) takes the webhooks and runs the jobs. Both dashboards
(`grchicken.tacksharp.in` :3002, `platform.tacksharp.in` :3114) share one build. Switch the four together.

- [ ] `export NODE_OPTIONS=--max-old-space-size=1280`, then from `$NEW`:
      `NEXT_PUBLIC_API_URL=https://platform-api.tacksharp.in NEXT_PUBLIC_RELEASE_ID=$SHA npm run build`; copy
      `apps/web/.next/static` and `apps/web/public` into `apps/web/.next/standalone/apps/web/` (standalone layout).
- [ ] Save each process's settings from `pm2 jlist` into two owner-only process files in `~/rollout`, one pointing at
      `$NEW` and one at `$PREV` (rollback). **The file names must end in `.config.js`** (e.g. `new.config.js`,
      `prev.config.js`): pm2 runs any other name as a plain script, which on 2026-11-03 left nothing serving for two
      minutes. Remove pm2-level settings that would override the new `.env` (it was `TELEPHONY_WEBHOOK_SECRET` on the
      platform API).
- [ ] **Pre-flight** (no customer impact): start the new API on port 3401 with `RUN_WORKERS=false`, `DRY_RUN=true` and
      the new dashboard on 3402; `/health` must show the new release, database and Redis ok; `/login` must be 200;
      then delete the two pre-flight processes.
- [ ] **Protected switch**: delete the four, start `new.config.js`, wait up to 60 s for 3001 / 3314 health and
      3002 / 3114 `/login`; on success `pm2 save`, otherwise delete them and start `prev.config.js` automatically.
      Never `pm2 restart all`; never touch the old 22-Oct test processes.

## 6. Verify (read-only; nothing is sent)

- [ ] `API=https://gr-api.tacksharp.in EXPECT_RELEASE=$SHA bash "$NEW/apps/api/scripts/smoke-deploy.sh"`: every line
      passes (health, release id, 401 / 403 on unsigned or wrong-token webhooks, Plivo route gone).
- [ ] `GR_ORGANIZATION_ID=org_gr_chicken npm run verify:restaurant`: menu, prices, Tamil / Tanglish quote, "mutton
      biryani" refused. It places no order.
- [ ] Browser: `DEPLOY.md` step 6 checks 1 to 3, plus: Knowledge studio opens; Plan & billing opens; the platform
      console (Billing tab) opens for a platform admin.
- **STOP and roll back** (section 11) if any check fails.

## 7. Sarvam console (GR Chicken voice)

- [ ] `GR-CHICKEN-SARVAM-LAUNCH.md` section 3: languages Tamil + English only (Hindi removed), instructions, on-start
      hook and the six tools, post-call webhook. Copy the **new** URL and tool key from the dashboard (Voice agents →
      Sarvam phone agent setup) after the secret rotation.
- [ ] Re-publish the Sarvam agent version.

## 8. Meta: Instagram & Messenger (optional now)

- [ ] Meta app → Webhooks: callback `https://gr-api.tacksharp.in/webhooks/meta-social`, verify token =
      `META_SOCIAL_VERIFY_TOKEN` (or the WhatsApp verify token).
- [ ] Subscribe the Page fields `messages`, `message_deliveries`, `message_reads`, `message_reactions`; the Instagram
      fields `messages`, `messaging_seen`, `message_reactions`, `comments`.
- [ ] App permissions: `pages_messaging`, `instagram_manage_messages`, `instagram_manage_comments` (for comment
      replies). Human Agent permission only if 7-day replies are wanted (then turn on "Human Agent replies" in the
      settings, never before Meta approves it).
- [ ] In the dashboard: Settings → Integrations → Instagram & Messenger: save the Page token, app secret, Page ID,
      Instagram account ID; **Test connection**; **Enable**. Optionally choose the AI agent (a published agent).
- [ ] With `DRY_RUN=true`: message the Page from a test account; it appears in the Team inbox; the reply is recorded
      as "not sent (test mode)".

## 9. Razorpay (optional now)

- [ ] Start with **test-mode** keys (`rzp_test_...`); `check:config` says which kind is set.
- [ ] Razorpay dashboard → Webhooks: URL `https://gr-api.tacksharp.in/webhooks/razorpay`, the same secret as
      `RAZORPAY_WEBHOOK_SECRET`, events `payment_link.paid`, `payment_link.partially_paid`, `payment_link.expired`,
      `payment_link.cancelled`.
- [ ] Payment links are refused while `DRY_RUN=true` (this server is live, so they work); test on a test invoice of a test
      organization: create the link, pay it in Razorpay test mode, confirm the invoice turns **paid** with the
      `razorpay:pay_...` reference. Only then switch to live keys.

## 10. First live tests of the new release (owner approval immediately before)

This server is already live (`DRY_RUN=false`), so nothing is switched on here: the tests below use the new features
for the first time, with approved numbers / accounts only.

- [ ] Check (do not widen) `LIVE_TEST_RECIPIENTS` (WhatsApp, calls) and `LIVE_TEST_SOCIAL_IDS` (Instagram /
      Messenger). Whether `LIVE_ALLOW_ALL_CUSTOMERS` is already `true` on this server: read it, do not change it.
- [ ] Run the live call test (`GR-CHICKEN-SARVAM-LAUNCH.md` section 5, "Live call test"), the inbound call in Tamil,
      and one WhatsApp confirmation, from an approved number.
- [ ] Check in the dashboard: the order, the WhatsApp delivery status, the call transcript and summary.
- [ ] Opening to all customers (`LIVE_ALLOW_ALL_CUSTOMERS=true`) is a separate owner decision.

## 11. Rollback

- [ ] `DEPLOY.md` step 7: start `tacksharp-gr-chicken` and `tacksharp-gr-dashboard` again from `$PREV` (code
      `f5c64e6`). The new tables stay (the old code ignores them).
- [ ] Restore the `.env` backup if the secret was rotated; point the Sarvam webhook back.
- [ ] Restoring the database backup only with the owner's approval.

## 12. After

- [ ] Keep `$PREV` until production has run cleanly for a day.
- [ ] Note the release id, the time of each step and any WARN from `check:config` in the release log.
