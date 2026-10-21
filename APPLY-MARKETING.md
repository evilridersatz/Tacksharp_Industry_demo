# Marketing + phase3 merge onto the AWS architecture

See also PILOT-READINESS.md (migration review, live-integration checklist, roles).

Base: branch `sync/aws-gr-chicken-20261015` (commit 5435542, "Sync GR Chicken code from AWS").
This package contains every file that differs from that commit:

1. The phase3 work (textile sales, AI agents / Operations, Finance), three-way merged into the AWS code so that
   GR Chicken (restaurant vertical, `/orders`, follow-ups, voice, webhooks) keeps working unchanged.
   Textile orders moved to `/sales-orders` so they do not collide with GR Chicken's `/orders`.
2. The Marketing increment: segments, customer import with consent and suppression lists, approval-gated WhatsApp
   template campaigns, a content calendar, delivery and reply tracking, and attribution reports. It also adds
   Marketing agent tasks.

## Apply (on a copy of the AWS checkout)

```bash
# 1. back up the database first
mysqldump tacksharp > backup-$(date +%F).sql

# 2. unzip over the repo root (only the listed files are added or replaced; .env is not touched)
unzip -o tacksharp-pilot-on-aws.zip -d /path/to/tacksharp_GR_chicken

# 3. migrations — additive only, applied in order by Prisma
cd apps/api
npx prisma migrate deploy        # 20261016 textile, 20261017 agents/operations, 20261018 finance, 20261019 marketing, 20261020 pilot completion
npx prisma generate
npm run build:ai && npm run build   # (repo root scripts as before)
```

Never use `prisma db push` or `prisma migrate reset` on the AWS database.

## New / changed environment (apps/api/.env)

| Key | Needed for | Default |
|---|---|---|
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Reading your **approved** templates into the campaign editor. Read-only. | empty → you type the approved template name manually, and the preview shows the variables only |
| `DRY_RUN` | Keep it `true` until you have tested. With `true`, every campaign message is recorded as **simulated**. | `true` |
| `LIVE_TEST_RECIPIENTS` | With `DRY_RUN=false`, only these numbers receive messages; everyone else is simulated. | empty |
| `LIVE_ALLOW_ALL_CUSTOMERS` | Set to `true` only when you are ready to message real customers. | `false` |

Settings → ROI → "WhatsApp cost per message" turns on the cost estimates. When it is 0, no cost is shown.
Nothing is invented.

## Roles

`admin` and `manager` can approve campaign sends. The `marketing` role can import customers, build segments, draft
campaigns, and approve or publish content. Its campaign sends wait in the approval queue.

## Still blocked (labelled in the dashboard)

- Meta ad spend and ad ROI: the Meta app has no `ads_read` permission.
- Posting automatically to Instagram or Facebook: no social account is connected. A person posts the content and
  marks it as published.
