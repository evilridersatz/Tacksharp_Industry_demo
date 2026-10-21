# Tacksharp pilot readiness

- **Branch:** `feature/marketing-on-aws`. It is based on `sync/aws-gr-chicken-20261015` (commit 5435542) and nothing is committed yet.
- **What it adds on top of the AWS code:** phase3 (textile sales, the four AI agents, Operations, Finance), Marketing, and the pilot-completion increment.
- **DRY_RUN:** must stay `true` until the checklist below is complete.

## 1. Database migrations (approval required before AWS)

All six migrations are additive and idempotent (`IF NOT EXISTS`). None changes or deletes existing rows, and none touches the GR Chicken tables.

So far they have been applied **only to the local test database**. Their status on the AWS database is unknown from here. Before deploying, check it on the server with `npx prisma migrate status`.

| Migration | Adds |
|---|---|
| `20261016000000_add_textile_sales` | Textile catalogue, requirements, quotations (+ items), sales orders (+ items), feedback |
| `20261017000000_add_agents_operations` | Agent tasks and their events, approvals, work tasks, audit events, inventory balances, stock movements |
| `20261018000000_add_finance` | Invoices (+ items), payments |
| `20261019000000_add_marketing` | `Customer.tags` (nullable JSON); marketing segments, campaigns, campaign recipients, content items |
| `20261020000000_pilot_completion` | `SalesOrder.dispatchedAt / courier / trackingRef` and `TextileProduct.unitCost` (all nullable); content revisions, collection notes, expenses |
| `20261021000000_multi_industry` | `Organization.isDemo` (default false); organization memberships (workspace switching); quality inspections (manufacturing). See `MULTI-INDUSTRY.md`. |

**Risks and how they are handled:**
- The `ALTER TABLE` statements add nullable columns only. On MariaDB they are fast and leave existing data unchanged.
- The new foreign keys reference `Organization`, `Customer`, `SalesOrder`, `Invoice` and `ContentItem`. The migrations must therefore run in date order, which Prisma does.

**Procedure on AWS:**
1. `mysqldump tacksharp > backup-$(date +%F).sql`
2. `npx prisma migrate deploy`
3. `npx prisma generate`
4. Rebuild and restart.

Never use `prisma db push` or `prisma migrate reset`.

## 2. Live-integration checklist (keep `DRY_RUN=true` until every item is done)

| Item | Status in this build | What to do |
|---|---|---|
| Meta app permissions | Checked live (`GET /me/permissions`). Agent Centre → Integrations shows the result. | `ads_read` is needed only for future ad reporting. No ad spend is shown either way. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Not set means the campaign editor can't list approved templates. | Set it in `.env` on the server. |
| Approved WhatsApp templates | Campaigns can use only templates Meta has approved. Reminders and receipts sent outside the 24-hour window are skipped unless a step template is set. | Get these approved in Meta: a marketing template; `WHATSAPP_TEMPLATE_TEXTILE_INVOICE` (payment reminder); `WHATSAPP_TEMPLATE_TEXTILE_PAYMENT` (receipt); plus the existing quote, order and feedback templates. |
| Webhook verification | The signature is verified with `META_APP_SECRET`. Production refuses to start without it. | Confirm the webhook URL and verify token in Meta. |
| Test recipient allowlist | `LIVE_TEST_RECIPIENTS` | Put the owner's and staff phones here for the first live run. Keep `LIVE_ALLOW_ALL_CUSTOMERS=false`. |
| Voice (Plivo + Sarvam) | Unchanged from the AWS build. | No change. |
| Payment provider / bank feed | **Not connected.** Payments are verified manually, with evidence. Bank-statement matching is read-only. | None for the pilot. A provider adapter is the next step (see `finance/payment-provider.ts`). |
| Accounting (Tally / Zoho) | **Not connected.** | None. |
| AI model | Optional. Without it, Marketing drafts use templates and are labelled as such. | `OPENAI_API_KEY` or `OPENAI_BASE_URL` (as the assistant already uses). |
| Health check | `GET /health` reports API, database, Redis and queues. | Watch it after the deploy. |

## 3. Roles

| Role | Can | Cannot |
|---|---|---|
| `admin` | Everything | – |
| `manager` | Approve campaign sends, shortage decisions and stock corrections | – |
| `finance` | Verify payments, approve and send reminders, record expenses, set unit costs | – |
| `marketing` | Draft, segment, import, approve content | Approve a campaign send |
| `sales` | Record payments, promises and disputes | Approve reminders or shortage decisions |
| `operations` | Receive stock and dispatch | – |

## 4. Known limits for the pilot

- STOP / START (real estate and textile; GR Chicken keeps its own flow):
  - A customer who replies STOP is opted out at once.
  - Every scheduled follow-up, queued campaign message and payment reminder is cancelled, and open reminder approvals are withdrawn.
  - AI calls are refused.
  - The customer gets a fixed confirmation, never a sales reply.
  - START lifts the opt-out only for a customer who had opted out. For anyone else it is an ordinary message.
  - A STOP is never counted as a reply to a campaign.
- Profit is not computed. Gross margin is shown only for invoice lines whose product has a unit cost, with its coverage percentage.
- Courier tracking numbers are recorded and sent to the customer, but they are not followed.
- Model usage is stored for Marketing drafts only. Usage by the conversation assistant is in the API logs.
