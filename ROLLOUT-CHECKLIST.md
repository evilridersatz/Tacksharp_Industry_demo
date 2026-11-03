# Production rollout checklist (branch `enterprise-saas-20261029`)

One ordered list for the person doing the rollout. Tick each box; **stop at any "STOP"** and do not improvise. The
details behind each step are in `DEPLOY.md` (generic steps) and `GR-CHICKEN-SARVAM-LAUNCH.md` (GR Chicken, Sarvam,
migrations). Nothing here prints a secret: commands show names, counts and statuses only.

Current production: release `/var/www/staging/releases/tacksharp-20261028-531e3d4` (commit `531e3d4`). It is never
modified; the new release goes into a new directory and is switched only after it is verified.

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
- [ ] Note `PREV=/var/www/staging/releases/tacksharp-20261028-531e3d4` and confirm the processes run from it.

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
  - [ ] Keep `DRY_RUN=true`. Delete `PLIVO_*` (ignored now).
- [ ] `which ffmpeg` (voice notes longer than 30 s); install it if missing.
- [ ] `cd "$NEW/apps/api" && npm run check:config` shows **no required setting missing**. Read every WARN line.
- **STOP** if `check:config` exits with a missing required setting.

## 4. Database migrations (owner sign-off: approved 2026-11-03 for all fifteen)

- [ ] `npx prisma migrate status` lists **exactly these 15** as not yet applied (and nothing else):

  `20261029000000_enterprise_platform`, `20261030000000_voice_agents`, `20261103000000_team_inbox`,
  `20261103100000_crm`, `20261103200000_drip`, `20261103300000_meta_capi`, `20261103400000_social_identity`,
  `20261103500000_workflows`, `20261103600000_mcp_keys`, `20261103700000_ai_steering`,
  `20261103800000_agent_builder`, `20261103900000_subscriptions`, `20261104100000_knowledge_studio`,
  `20261104200000_invoice_payment_links`, `20261104300000_drip_variants`.

  All are additive (new tables, nullable or defaulted columns); none drops, renames or rewrites data.
- **STOP** if the list differs (an older migration pending, or a "failed" / "modified" migration). Ask before acting.
- [ ] `npx prisma migrate deploy`, then `npx prisma migrate status` says the schema is up to date.

## 5. Build and switch (only the two recorded processes)

- [ ] `npm run build` (API), then the web build with `NEXT_PUBLIC_RELEASE_ID=$SHA` (`DEPLOY.md` step 5).
- [ ] `pm2 delete <api>` and start it from `$NEW` with `RELEASE_ID=$SHA`; the same for `<web>`. `pm2 save`.
      Never `pm2 restart all`.
- [ ] `pm2 logs <api> --lines 60 --nostream`: startup completes, no errors, the Plivo warning only if `PLIVO_*` remain.

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
- [ ] Payment links are refused while `DRY_RUN=true`; test this together with section 10, on a test invoice of a test
      organization: create the link, pay it in Razorpay test mode, confirm the invoice turns **paid** with the
      `razorpay:pay_...` reference. Only then switch to live keys.

## 10. First live sends (owner approval immediately before)

- [ ] Approved numbers / accounts only: `LIVE_TEST_RECIPIENTS` (WhatsApp, calls), `LIVE_TEST_SOCIAL_IDS`
      (Instagram / Messenger). `LIVE_ALLOW_ALL_CUSTOMERS` stays `false`.
- [ ] `DRY_RUN=false`, restart only the API, run the live call test (`GR-CHICKEN-SARVAM-LAUNCH.md` section 5, "Live
      call test"), the inbound call in Tamil, and one WhatsApp confirmation.
- [ ] Check in the dashboard: the order, the WhatsApp delivery status, the call transcript and summary.
- [ ] Opening to all customers (`LIVE_ALLOW_ALL_CUSTOMERS=true`) is a separate owner decision.

## 11. Rollback

- [ ] `DEPLOY.md` step 7: start the recorded `$PREV` processes again. The new tables stay (the old code ignores them).
- [ ] Restore the `.env` backup if the secret was rotated; point the Sarvam webhook back.
- [ ] Restoring the database backup only with the owner's approval.

## 12. After

- [ ] Keep `$PREV` until production has run cleanly for a day.
- [ ] Note the release id, the time of each step and any WARN from `check:config` in the release log.
