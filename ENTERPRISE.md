# Enterprise SaaS platform: audit, what was built, what remains

**Branch:** `enterprise-saas-20261029`. It is based on the verified release `531e3d4` (`security-deps-20261028`).

**Not deployed.** The build workspace has no SSH key, no AWS credentials and no network route to the Tacksharp
servers. Nothing here has run on staging or production.

## Phase A: audit of the existing repository (before this branch)

| Area | Found | Gap against the brief |
|---|---|---|
| Authentication | Signed session cookie (HMAC, 7 days), scrypt passwords, login rate limit, global guard that re-reads user, role and membership from the database, read-only `viewer`, invitation and reset links | No public signup, no organization lifecycle, no platform superadmin, no forgot-password path |
| Tenancy | Organization from the session only; workspace switch checks membership; webhooks resolve the tenant from `OrganizationChannel` | No suspension; no per-organization limit on industries |
| Settings | One JSON document per organization (`OrganizationSettings`) | Provider credentials only in the server `.env`, shared by every organization |
| Integrations | Plivo, WhatsApp, Sarvam and OpenAI wired through environment variables; GR Chicken's `/integrations` page shows set / missing flags | No per-organization credentials, no encrypted storage, no connection tests from the dashboard (except the demo "Check connections") |
| Industries | Ten industry definitions with their own menus and dashboards (real estate, GR Chicken restaurant, food, hotel, hospital, textile, retail, manufacturing, agency, CCTV / VisionOps) | Real estate had no property inventory screen; healthcare patient endpoints had no permission check |
| Operations | `/health` (database, Redis, two queues), release id | No staff-only console for organizations, failures, usage or audit |
| Website | Login, invite and privacy pages only | No marketing site, pricing, docs, terms or demo selection |
| Deployment | Manual PM2 release directories (`DEPLOY.md`), smoke script | Unchanged; still unverified on AWS |

## What this branch adds

1. **Self-service signup.**
   - `/signup` creates the organization, its industry settings and its first organization admin in one database
     transaction.
   - Validation runs on the server; passwords need 12+ characters; throwaway email domains and a honeypot are
     refused; duplicate emails and organization names are refused.
   - Signup is rate-limited to 5 per hour per IP and cannot grant platform rights.
   - New organizations start as `pending_review`. Activation by a platform admin is the verification step, because
     no email provider is configured.
2. **Organization lifecycle.**
   - Organization status can be `active`, `pending_review` or `suspended`.
   - Suspension ends every session into that organization within seconds and refuses login with a clear message.
   - A platform admin can limit which industries an organization may choose.
3. **Roles.**
   - Platform superadmin is a database flag, set only by `npm run platform:admin`.
   - New `operator` role.
   - New `integrations.view` and `integrations.manage` permissions, enforced on the server.
4. **Encrypted credential vault.**
   - AES-256-GCM with a key ring kept outside the database. Organization and provider are bound into each
     ciphertext.
   - Only masked hints are returned. Audit events record field names only.
   - `npm run credentials:rotate` re-encrypts rows to a new key; this was tested end to end.
5. **Provider settings pages.** Four pages, all using the same real API:
   - **Settings → Integrations → Plivo:** credentials, webhook URLs, signature-validation status, inbound number
     routing (each number verified on the organization's own account), and a gated real test call.
   - **Settings → Integrations → WhatsApp:** number check, template status, webhook facts, routing, and delivery
     counts from Meta receipts only.
   - **Settings → AI providers → Sarvam:** models, language and voice; generate speech; recognise speech from an
     upload or a round trip.
   - **Settings → AI providers → OpenAI:** allow-listed models; model availability and token usage; quota errors.
   - Every page has save, test, enable / disable, refresh, delete with confirmation, and usage and errors for 30 days.
6. **Runtime resolution.** Calls, WhatsApp sends, speech and model turns use the organization's own account once it
   is tested and enabled. Existing organizations, GR Chicken included, keep the environment accounts. Self-service
   organizations never fall back to the platform's accounts. See `INTEGRATIONS.md`.
7. **Platform console** (`/platform`, staff only):
   - organization search and status;
   - activate and suspend, both requiring the organization name typed back;
   - permitted industries;
   - users: disable / enable, reset link, invitation;
   - integration status (no secrets);
   - onboarding steps computed from records;
   - service health: API, database, Redis, every queue, storage, provider latency;
   - failed jobs, failed inbound messages and rejected webhooks;
   - usage per organization;
   - cross-organization audit log.
8. **Healthcare privacy.**
   - Appointment and patient endpoints now require `clinic.view`.
   - Phone numbers and visit reasons are masked for roles that only view.
   - Opening a patient record is written to the audit log.
9. **Real estate properties.** A property inventory page plus list, create and update endpoints (permission-checked
   and audited).
10. **Public website.**
    - Pages: `/welcome`, `/product`, `/solutions`, `/pricing`, `/docs`, `/demo`, `/signup`, `/forgot-password`,
      `/terms`, `/privacy`.
    - Responsive and keyboard-accessible, with reduced motion respected.
    - The landing page has an interactive, clearly labelled example conversation per industry.
11. **Design-system additions.** Toast notifications, the pending-activation banner, a platform link for staff, and
    more precise active-menu highlighting.
12. **Fixes found on the way.**
    - The VisionOps live test did not `await` fault injection (a race).
    - The ui-agents and ui-marketing test fixes from the previous branch are carried over.

## Verification (local, test database `tacksharp_merge`; provider requests mocked in automated tests only)

All test results are listed in the final report for this branch. In brief:
- API typecheck and build pass; web typecheck and build pass.
- The API suite and every browser suite, including the new `ui-enterprise.py`, pass.
- **Live provider verification: none.** Provider hosts are not reachable from this workspace, and no real credentials
  were used.
- The browser suite shows a Plivo connection test reporting `network: Could not reach the provider`, honestly, as a
  failure.

## Not done / remaining risks

- **Not deployed** to staging or production. Production needs, with approval:
  - a database backup;
  - the additive migration `20261029000000_enterprise_platform`;
  - `CREDENTIALS_KEYS`;
  - a platform admin grant.
- **Live provider tests.** Plivo, WhatsApp, Sarvam and OpenAI connection tests have only been exercised against
  mocks and an unreachable network. They need real credentials on staging.
- **Email.** No email provider: there is no email verification and no emailed reset links. Activation and
  admin-issued links replace them.
- **GR Chicken's ready-call service** (`ReadyNoticeService`) still uses the environment Plivo account. That is
  intended, since GR Chicken is on the environment account, but it is not yet per-organization.
- **Rejected-webhook list** in the platform console is in memory: it resets when the API restarts. The log remains
  the record.
- **Manufacturing production overview** from machine data, and **Vision AI detections**, are marked "in
  development" on the website. They need a plant data connection or inference service.
- **Real estate campaign performance.** The marketing module is not enabled for the real estate industry, so it is
  not linked there.
- **Pricing and terms pages need your sign-off.** Plans show "Quoted at activation" (no list prices were provided),
  and the terms of service were written to match how the product works. Both need commercial and legal review
  before publishing.
- **Remaining dependency advisories** are unchanged: multer via NestJS, which needs a NestJS 12.3 upgrade, plus
  moderate / low advisories.
- **There is no WebSocket channel.** Live data uses the existing polling (10–30 s) with refresh controls, which is
  adequate at current scale.
