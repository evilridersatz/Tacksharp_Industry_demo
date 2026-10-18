# Multi-industry platform

Tacksharp now adapts to six industries: Textile & Apparel, Restaurant (GR Chicken), Real Estate, Retail & E-commerce, Manufacturing & Quality, and Marketing Agency / Business.

For each workspace, the industry decides:
- the menu
- the dashboard and analytics
- the lead pipeline
- the settings sections
- the wording
- the AI agent catalogue

The work extends the existing backend:
- one authentication system
- one agent runtime (the orchestrator and the conversation engine)
- one database

Nothing in GR Chicken's ordering flow changed.

## How the industry is decided

| Workspace | Industry |
|---|---|
| `Organization.vertical = 'restaurant'` | Always **Restaurant**. It cannot be changed: Settings refuses the change, and so does the API. |
| Any other organization | Settings → Industry: `real_estate` (the default), `textile`, `retail`, `manufacturing` or `agency`. A change is confirmed first and recorded as an `industry_changed` audit event. No records are moved, created or deleted. |

The server resolves the industry (`GET /industry/workspace`). The web registry (`apps/web/src/lib/industries.ts`) only decides presentation: menu, wording, colour and settings sections.

## Switching industries means switching workspaces

- A user can open their own organization plus any organization they have an `OrganizationMembership` for.
- `POST /auth/workspace` checks that membership and issues a new signed session for the target organization.
- Every API call stays scoped to that organization, as before.
- If the membership is removed, the session stops working within 60 seconds (`401`).
- Switching never changes ownership and never mixes tenants.

## Demo workspaces

Six demo workspaces (`org_demo_*`, `isDemo = true`) each hold their own synthetic data, with no shared records.

**What the demo seed creates (`apps/api/scripts/seed-industry-demos.ts`):**
- **Textile:** products with stock, customers, enquiries, quotations, sales orders, feedback, follow-ups and a campaign.
- **Retail:** products, orders and campaigns.
- **Restaurant:** an outlet, a menu, about 70 orders with peak hours, ratings and complaints, and conversations.
- **Real estate:** 6 Chennai projects, leads with budget, BHK and area, site visits and calls.
- **Manufacturing:** 46 inspections across 3 lines, with Line 3 deliberately worse.
- **Agency:** leads with campaigns and notes.

**Safety rules:**
- The seed refuses to run without `DEMO_SEED_CONFIRM=yes`.
- It refuses to run if any `org_demo_*` id belongs to a non-demo organization.
- It only ever writes to `org_demo_*`. It never touches GR Chicken or any live organization.
- Re-running it is safe: it wipes and recreates only the demo organizations, and keeps their user memberships.

**The AI agents playground:**
- It runs **only** in demo workspaces.
- Conversation agents use the real engine through the dashboard test channel, with a synthetic customer flagged as demo.
- Task agents run their real task on the demo records.
- Nothing is sent to WhatsApp, no call is placed and nothing is charged.

## What is real and what is not

| Area | Status |
|---|---|
| Workspace switching, tenant isolation, industry lock | Real. Server-enforced and covered by tests. |
| Dashboards (`GET /industry/dashboard`) | Real. Computed only from the workspace's own records. Demo workspaces show synthetic records, and every chart names its source. |
| Restaurant and real-estate overviews | The existing pages, unchanged. Both now also have a Reports & analytics page. |
| Textile AI assistant | Real (existing engine). |
| Real-estate AI assistant | Real (existing engine). |
| GR Chicken ordering assistant | Real (existing engine). |
| Retail, manufacturing and agency conversations | **No dedicated AI engine yet.** The assistant acknowledges the customer, creates one handoff to the team and promises nothing: no prices, stock or property talk. |
| Quality inspections (manufacturing) | Real records entered by people, with alert tasks raised by the quality alert scan. **No camera, sensor or computer-vision model is connected.** |
| Agent catalogue | Each agent names what actually runs it (conversation engine, orchestrator task, workflow or report). Agents that are not built are shown as **Not available yet**, with the reason. |
| Campaign spend / Meta ads | Not connected. Never shown. |
| Forgot password | No backend flow. The login page says to ask the workspace admin. |
| Google / Microsoft sign-in | Not offered (not configured). |

## Deploying to staging

These steps are for `/var/www/staging/tacksharp-pilot-20261017`. Run them on the server; this build was not deployed from here.

1. **Back up the database:**
   ```
   mysqldump <staging_db> > backup-$(date +%F).sql
   ```
2. **Copy in the changed files.** Unzip the package over `apps/api` and `apps/web` in the staging checkout. Do not overwrite `.env` files.
3. **Apply the migrations (approval required).** In `apps/api`:
   ```
   npx prisma migrate status
   npx prisma migrate deploy
   npx prisma generate
   ```
   `20261021000000_multi_industry` makes three additive changes:
   - it adds the column `Organization.isDemo` (default `false`, so existing organizations, GR Chicken included, are unchanged);
   - it adds the table `OrganizationMembership`;
   - it adds the table `QualityInspection`.

   Never use `prisma db push` or `migrate reset`.
4. **Build:** `npm run build` in `apps/api` and in `apps/web`.
5. **Optional: demo workspaces, staging only, never production.** In `apps/api`:
   ```
   DEMO_SEED_CONFIRM=yes DEMO_USER_PASSWORD='<12+ chars>' DEMO_GRANT_EMAILS='owner@example.com' npm run seed:industry-demos
   ```
   The password is never printed. `DEMO_GRANT_EMAILS` lets existing users switch into the demo workspaces only.
6. **Restart only the staging API and web PM2 processes**, e.g. `pm2 restart <staging-api> <staging-web>`. Keep `DRY_RUN=true`.
7. **Smoke test:**
   - Log in.
   - Open the workspace switcher and switch into each demo workspace.
   - Check `/`, `/agents` and `/analytics`.
   - In the GR Chicken workspace, confirm the menu and overview are unchanged.

## Tests

| Suite | Result |
|---|---|
| `apps/api`: `TEST_DB_NAME=<test db> npx vitest run` | 926 passing, including 14 in `test/multi-industry.integration.spec.ts` |
| `apps/web/tests/ui-industries.py` | 74 checks: login, switching across all six industries, menus, dashboards, catalogue, playground, isolation, drawer, no overflow at 320–1440 px |
| `ui-textile`, `ui-agents`, `ui-finance`, `ui-marketing`, `ui-pilot` | All passing after label updates |
