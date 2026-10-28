# Tacksharp launch runbook

This release adds secure per-workspace sharing and the shared-number demo sessions, and patches Next.js. The steps
below were **not** run from the build workspace, which has no access to the AWS host. The repository has no CI
workflow; deployment is the manual PM2 release-directory procedure.

## Access model (existing roles plus a read-only viewer)

| Who | Access | Allowed |
|---|---|---|
| Workspace admin | The workspace(s) they belong to | Everything in that workspace. **Team & access:** invite, change roles, remove, issue reset links. |
| Manager | Assigned workspace | Operations, sales, marketing, contact tests and demo sessions. Cannot manage people. |
| Staff roles (sales, operations, front_desk, reception, insurance, technician, finance, marketing) | Assigned workspace | Their module, as before. |
| **viewer** (new) | Assigned workspace | Read-only. Every write is refused by the API guard; the dashboard shows "Read-only". |
| Customer user | Their own organization | Their role's operations. |

There is no global administrator role. A person sees only workspaces where they are a home user or a member.
Switching to any other workspace returns `403`. Every API query is scoped to the session's workspace on the server.

### Sharing one industry with someone

1. Sign in as an admin of that industry's workspace, for example "Demo · Marina Bay Residency".
2. Open **Setup → Team & access**. Enter their email, choose **viewer** (read-only demo) or a working role, and
   press **Create invitation link**.
3. Copy the link (`https://<dashboard>/invite#…`) and send it to that person privately.
   - **No email provider is configured**, so nothing is emailed.
   - The link is shown once, works once and expires (72 h; `INVITE_EXPIRY_HOURS`). A newer link replaces older ones.
4. They open it and set their own password (at least 12 characters), or confirm their existing account's password.
   They land in that workspace and see no other.
5. To end their access, press **Remove**. Their open sessions stop at once and they can't log in again. Role
   changes also apply at once.

**Password reset:** an admin presses **Reset link** next to a home member. The link is single-use and lasts 2 h
(`RESET_LINK_EXPIRY_HOURS`). Using it signs out every other session of that account. An admin can't reset the
password of a guest from another workspace; only that person's home workspace admin can.

Security details:
- Tokens are 32 random bytes. Only their SHA-256 hash is stored.
- The token is kept in the URL fragment, which is never sent to the server or written to logs, and is removed from
  the address bar once read.
- Link endpoints use the login rate limit.
- Every action is written to the audit log.
- There are no shared or hard-coded passwords.

## Deploy (staging first)

```bash
# On the AWS host. Record the current state first.
pm2 ls; pm2 describe <staging-api> | grep -E "exec cwd|script|status"; pm2 describe <staging-web> | grep -E "exec cwd|script|status"
PREV=<exec cwd of the staging API minus /apps/api>
SHA=<pushed commit>
NEW=/var/www/staging/tacksharp-$(date +%Y%m%d-%H%M)-${SHA:0:7}
git -C "$PREV" fetch origin visionops-staging-integration-20261019
git clone --no-checkout "$PREV" "$NEW" && git -C "$NEW" checkout "$SHA"
cp -p "$PREV/apps/api/.env" "$NEW/apps/api/.env"; cp -p "$PREV/apps/api/.env" ~/env-backup-$(date +%F-%H%M)
cd "$NEW" && npm ci && npm run build:ai
cd apps/api && npx prisma generate

# Database: backup, verify, then apply the additive migrations (approval required)
mysqldump --single-transaction <db> > ~/backup-$(date +%F-%H%M).sql && ls -lh ~/backup-*.sql | tail -1
npx prisma migrate status     # expect pending: 20261028000000_demo_sessions, 20261028100000_team_access
npx prisma migrate deploy     # one new table each + two NULLABLE User columns; nothing dropped or rewritten
npx prisma migrate status     # expect: up to date

REL=$(git rev-parse --short HEAD); npm run build
cd ../web && NEXT_PUBLIC_RELEASE_ID=$REL npm run build

# Switch ONLY the two staging processes (use the script / args recorded above)
pm2 delete <staging-api> && cd "$NEW/apps/api" && RELEASE_ID=$REL pm2 start dist/main.js --name <staging-api>
pm2 delete <staging-web> && cd "$NEW/apps/web" && pm2 start node_modules/.bin/next --name <staging-web> -- start -p 3102
pm2 save
```

Required `.env` values. They are checked at startup when `NODE_ENV=production`, and the API refuses to start
without them:
- `AUTH_SECRET` (32+ characters)
- `META_APP_SECRET`
- `PLIVO_VALIDATE_SIGNATURE=true`
- an HTTPS `PUBLIC_BASE_URL`
- a real `DB_PASSWORD`
- the provider keys

Keep `DRY_RUN=true` until a controlled live demo is approved.

## Smoke test (staging, then production)

1. `curl -s https://<api>/health`: `status: ok`, `release.id` equals `$REL`, database and redis ok.
2. Sign in as an admin. **Switch workspace** across the ten industries; each shows its own menu and overview.
3. **Team & access:** create a viewer link for yourself (a second email), open it in a private window, and set a
   password.
   - Check that you land in that workspace, see only it, see "Read-only", and that a save is refused.
   - Remove the viewer: the private window gets "Please log in" on its next action.
4. **Data & APIs → Check connections:** WhatsApp and Plivo should show **Connected**. If not, the card shows the
   real reason.
5. Follow the shared-number demo check in `SHARED-NUMBER-DEMO.md`.

## Rollback

Restart the two processes from `$PREV`. The new tables and nullable columns can stay, because the previous code
ignores them. A full schema revert means restoring the verified backup, which needs approval.

## Known open items

- **form-data / request (critical, via the Plivo SDK):** the only fix is a major Plivo SDK upgrade, which needs a
  separate tested change.
- **high (mariadb / mysql2 / multer / body-parser / prisma / zod / @nestjs/platform-express):** non-breaking fixes
  are available. Run `npm audit fix --omit=dev` on a branch, then rerun all suites.
- **Email delivery:** not configured. Invitation and reset links are shared manually by the admin.
