# Deploying Tacksharp to AWS (staging, then production)

**Status:** this has never been run. The build workspace has no SSH key, no real AWS credentials and no network
route to the tacksharp hosts. Every path below that is not marked "from the repo" must be confirmed in step 1
before it is used.

The repo has **no** CI workflow, PM2 ecosystem file, Nginx or systemd config, or deploy script. The only documented
facts (from the repo docs, never verified) are:
- staging directory `/var/www/staging/tacksharp-pilot-20261017`;
- staging API on PM2 port **3103**, web on **3102**;
- `https://platform-api.tacksharp.in` and `https://platform.tacksharp.in`.

## What to deploy

| Branch | Commit | Contents |
|---|---|---|
| `visionops-staging-integration-20261019` | see `git log -1` | Features plus this runbook and the smoke script |
| `security-deps-20261028` | on top of the release branch | **Recommended for staging:** the same, plus the dependency security fixes |

Migrations pending against a database at the pre-October-28 schema, from the repo, all **additive**:
- `20261028000000_demo_sessions`: creates table `DemoSession`.
- `20261028100000_team_access`: creates table `UserInvitation`, and adds nullable `User.disabledAt` and `User.sessionsRevokedAt`.

Neither drops, renames or rewrites anything. `prisma migrate status` on the host decides what is actually pending.
If it lists more (for example `20261023000000_visionops`), read those files too before applying.

---

## Step 0. LOCAL: confirm what you are deploying

```bash
git fetch origin
git log -1 --format='%h %s' origin/security-deps-20261028      # note the short SHA
git diff --stat origin/visionops-staging-integration-20261019 origin/security-deps-20261028   # deps only
```

## Step 1. LOCAL → AWS HOST: connect and discover (read-only)

```bash
ssh -i <your-key.pem> <user>@<staging-host>      # e.g. ubuntu@<lightsail/ec2 public IP>
```

On the AWS host:

```bash
pm2 ls
for n in $(pm2 jlist | python3 -c "import json,sys;[print(p['name']) for p in json.load(sys.stdin)]"); do
  pm2 describe "$n" | grep -E "^│ (name|status|script path|script args|exec cwd|interpreter args)" ; done
sudo ss -ltnp | grep -E ':(3000|3001|3102|3103)\b'          # which process owns which port
sudo nginx -T 2>/dev/null | grep -nE 'server_name|proxy_pass' # which domain → which port
```

Record:
- the **staging API** and **staging web** process names and their `exec cwd`, which becomes `PREV` below;
- the **production** process names and their `exec cwd`. Do not touch these until step 8.

## Step 2. AWS HOST: back up and verify the backup (before anything changes)

```bash
cd "$PREV/apps/api"
set -a; . ./.env; set +a                          # loads DB_* into this shell only; nothing is printed
echo "target database: $DB_NAME on $DB_HOST"       # CONFIRM this is the STAGING database
B=~/backups/staging-$(date +%F-%H%M).sql.gz; mkdir -p ~/backups
mysqldump --single-transaction --routines --triggers -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" | gzip > "$B"
gzip -t "$B" && ls -lh "$B"                        # must be non-trivial in size
zcat "$B" | grep -c 'CREATE TABLE'                 # roughly the number of tables
# Restore drill (proves the backup is usable), into a scratch database, then drop the scratch copy:
mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" -e "CREATE DATABASE restore_check_$(date +%s)"
# zcat "$B" | mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" restore_check_<ts>   && compare row counts, then DROP it
cp -p .env ~/backups/env-staging-$(date +%F-%H%M)
```

**Restore procedure** (only with approval):
```bash
zcat <backup>.sql.gz | mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME"
```
Then restart the previous release.

Stop here if the backup is missing, empty, or fails `gzip -t`.

## Step 3. AWS HOST: new release directory (the current one is untouched)

```bash
SHA=<short SHA from step 0>
NEW=/var/www/staging/tacksharp-$(date +%Y%m%d-%H%M)-$SHA
git -C "$PREV" fetch origin security-deps-20261028
git clone --no-checkout "$PREV" "$NEW" && git -C "$NEW" checkout "$SHA" && git -C "$NEW" log -1 --oneline
cp -p "$PREV/apps/api/.env" "$NEW/apps/api/.env"
[ -f "$PREV/apps/web/.env.production" ] && cp -p "$PREV/apps/web/.env.production" "$NEW/apps/web/"
cd "$NEW" && npm ci && npm run build:ai
cd apps/api && npx prisma generate && npm run check:config     # must report no problems
```

Before going further, confirm `apps/api/.env` has:
- `NODE_ENV=production`
- `META_APP_SECRET`
- `PLIVO_VALIDATE_SIGNATURE=true`
- `AUTH_SECRET` (32+ characters)
- an HTTPS `PUBLIC_BASE_URL`
- `DRY_RUN=true`
- `RUN_WORKERS` set as on the current staging

`check:config` lists problems by name only, never values.

## Step 4. AWS HOST: migrations (staging database, after step 2)

```bash
cd "$NEW/apps/api"
npx prisma migrate status                      # review the pending list
cat prisma/migrations/20261028000000_demo_sessions/migration.sql prisma/migrations/20261028100000_team_access/migration.sql
npx prisma migrate deploy
npx prisma migrate status                      # expect "Database schema is up to date"
```

## Step 5. AWS HOST: build and switch ONLY the two staging processes

```bash
cd "$NEW/apps/api" && npm run build
cd "$NEW/apps/web" && NEXT_PUBLIC_RELEASE_ID=$SHA npm run build
# Use the exact names / scripts / args recorded in step 1:
pm2 delete <staging-api> && cd "$NEW/apps/api" && RELEASE_ID=$SHA pm2 start dist/main.js --name <staging-api>
pm2 delete <staging-web> && cd "$NEW/apps/web" && pm2 start node_modules/.bin/next --name <staging-web> -- start -p 3102
pm2 save && pm2 ls
pm2 logs <staging-api> --lines 60 --nostream | grep -E 'startup|error|tenancy' | head -40
```

Never run `pm2 restart all`.

## Step 6. LOCAL: smoke tests (read-only; nothing sent or written)

```bash
API=https://<staging api> WEB=https://<staging web> EXPECT_RELEASE=$SHA bash apps/api/scripts/smoke-deploy.sh
# with a login check (password read silently, never in history):
read -rs SMOKE_PASSWORD; export SMOKE_EMAIL=<your admin email> SMOKE_PASSWORD
API=... WEB=... EXPECT_RELEASE=$SHA bash apps/api/scripts/smoke-deploy.sh; unset SMOKE_PASSWORD
```

The script expects:
- `/health` ok, with database, Redis and `release.id` matching;
- `401` for unauthenticated requests;
- WhatsApp verify with a wrong token → `403`;
- unsigned and badly signed WhatsApp webhooks → `401`;
- an unsigned Plivo callback → `403`;
- `/login` and `/invite` load, and the web release matches;
- with a login: a switch into someone else's workspace is refused.

Then check by hand in the browser (staging):

1. **Industries:** log in and use **Switch workspace** across all ten industries. Each shows its own menu and overview,
   and each overview's range selector changes its charts.
2. **Invitations:**
   - In the Hotel demo workspace, open **Team & access** and create a **viewer** link for a second email.
   - Open the link in a private window and set a password. Confirm you land in Hotel only, see "Read-only", and that
     a save is refused.
   - Reuse the link: it should be refused.
   - **Remove** the viewer: the private window's next action asks you to log in.
   - Create another link and **Revoke** it: opening it should be refused.
3. **Providers (read-only):** open **Data & APIs**, press **Check connections**, and expect WhatsApp and Plivo to show
   **Connected**. Any other result names the real problem.
4. **Shared-number routing (`DRY_RUN=true`):**
   - Start a demo session for your own number (it must be in `LIVE_TEST_RECIPIENTS`). Send "hi" to the shared
     WhatsApp number; it should appear in that workspace's conversations, with the reply recorded as not sent.
   - Switch the dashboard elsewhere and send again: the message still goes to the session's workspace.
   - End the session: the next message reaches the number's owner.

**Live sends:** only with written approval, set `DRY_RUN=false` with your own numbers in `LIVE_TEST_RECIPIENTS` and
an approved WhatsApp template, and repeat step 4 with the confirmed WhatsApp test and test call from the tester's
record.

## Step 7. AWS HOST: rollback (staging)

```bash
pm2 delete <staging-api> && cd "$PREV/apps/api" && pm2 start <recorded script> --name <staging-api> -- <recorded args>
pm2 delete <staging-web> && cd "$PREV/apps/web" && pm2 start <recorded script> --name <staging-web> -- <recorded args>
pm2 save
```

The new tables and columns can stay, because the previous code ignores them. Restoring the step-2 backup needs approval.

## Step 8. Production (only after step 6 passes, and with explicit approval for the database change)

Repeat steps 1–7 against the **production** processes, directory and database:

1. Discover the production `PREV`, process names and ports. Never reuse the staging names.
2. Take the production backup. Verify `gzip -t`, its size and the restore drill, and keep it off the server too.
   **No verified backup means no migration.**
3. Use a new release directory, for example `/var/www/production/tacksharp-<date>-<sha>`. Run `check:config` with
   the production `.env`.
4. Run `prisma migrate status`, then `migrate deploy` **with sign-off**, then `migrate status` again.
5. Switch only the production API and web processes.
6. Run `smoke-deploy.sh` against production, plus the manual checks 1–3. Run check 4 only with an approved test
   number.
7. Keep `$PREV` until production has run cleanly for a day. Roll back as in step 7.
