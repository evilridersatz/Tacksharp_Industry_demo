# Integrations, signup and platform administration: reference

All endpoints need a session cookie (or `Authorization: Bearer`) unless marked **public**. The organization always
comes from the session (or, for webhooks, from the provider's identifiers), **never** from a request body or query.

## Credential storage

- Model: `IntegrationCredential`, one row per organization per provider (`plivo`, `sarvam`, `openai`, `whatsapp`).
- **Secret fields are encrypted with AES-256-GCM.** The organization id and provider are bound as additional
  authenticated data, so a ciphertext copied to another row will not decrypt.
- **Keys live only in the server environment,** never in the database:
  - `CREDENTIALS_KEYS="v1:<base64 32 bytes>,v2:..."`
  - `CREDENTIALS_ACTIVE_KEY=v2`
- **Without a key, saving is refused.** Secrets are never stored unencrypted.
- **Responses carry masked hints only** (`••••3fa1`). A secret field left empty on save keeps the stored value.
- **Audit events record field names only, never values.** The audit actions are:
  - `integration.saved`, `integration.tested`, `integration.enabled`, `integration.disabled`, `integration.deleted`
  - `integration.number_mapped`, `integration.number_unmapped`
- **Saving does not mean working.** A save sets `status=untested`. Only a passing connection test sets `ok`, and
  enabling requires `ok`.
- **Platform admins see status only.** They never see secrets or hints.

### Key rotation

1. Generate a new key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. Add it to the server environment and make it active, then restart the API:
   ```
   CREDENTIALS_KEYS="v1:<old>,v2:<new>"
   CREDENTIALS_ACTIVE_KEY=v2
   ```
3. Re-encrypt every row with the new key. The command prints counts only, never secrets; add `-- --dry-run` to
   only count.
   ```bash
   npm run credentials:rotate -w apps/api
   ```
4. When it reports nothing left on `v1`, remove `v1` from `CREDENTIALS_KEYS` and restart.

## Which account a provider call uses (resolution policy)

1. **Find the organization.** It comes from the session (HTTP), from the call's or number's mapping (Plivo
   callbacks), from the WhatsApp `phone_number_id` mapping (Meta webhooks), or from the queued job's record
   (workers).
2. **Its own credentials** are used when they are saved, **enabled**, and the last connection test **passed**.
3. **Pre-existing organizations without their own credentials** keep using the deployment's environment account
   (`PLIVO_*`, `WHATSAPP_*`, `SARVAM_API_KEY`, `OPENAI_API_KEY`). This is the legacy behaviour and keeps GR Chicken
   unchanged.
4. **A self-service organization never falls back** to the platform's account. Without its own credentials the
   provider is "not configured" for it.
5. **A suspended organization gets nothing.**
6. **No path ever uses another organization's credentials.**

Where it is wired in:

| Provider | Code paths that use the organization's own account |
|---|---|
| Plivo | Outbound calls and hangup (`VoiceService`); recording download. Signature check on `/voice/*` uses the token of the organization owning the call or dialled number, and is always enforced for organizations with their own account. The GR Chicken ready-call service still uses the environment account, which is the legacy path. |
| WhatsApp | Every send and media download (`WhatsAppSenderService`). The webhook signature is accepted with the platform app secret, or with the app secret of the organization that owns the `phone_number_id`. |
| Sarvam | Speech-to-text and text-to-speech (`SarvamService`), using that organization's models and voice. |
| OpenAI | Conversation agents (`LlmRunner`) and marketing drafts, using that organization's key and validated model. |

## Endpoints

### Signup and session

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/auth/signup` | **public**, 5/hour per IP | Creates the organization (`pending_review`, `selfServe`), its settings (industry) and its first admin in one transaction, then signs them in. See notes below. |
| GET | `/auth/signup-status` | **public** | `{ enabled, emailVerification: 'not_configured', activation: 'platform_review' }` |
| POST | `/auth/forgot-password` | **public**, 5/hour per IP | Records a reset request for admins. The answer is the same for unknown emails, and nothing is emailed. |
| POST | `/auth/login` | **public**, rate-limited | Login. A suspended organization gets 403 with a clear message. |
| GET | `/auth/me` | any | Now also returns `organizationStatus`, `selfServe`, `isPlatformAdmin` and `emailVerified`. |

Notes on `/auth/signup`:
- **Body:** `organizationName`, `adminName`, `email`, `password` (12+ characters), `industry`, optional `phone`, and
  `acceptTerms: true`.
- **Refused with 409:** a duplicate email, or a duplicate organization name.
- **Refused with 400:** the honeypot field `website` was filled in.
- **No role or platform field is accepted.**

### Integrations (Settings → Integrations / AI providers)

Viewing needs `integrations.view` (admin, manager). Changes need `integrations.manage` (admin only).

| Method | Path | What |
|---|---|---|
| GET | `/integrations` | All four providers: status, effective source (`organization` / `environment` / `none`) and deployment facts (webhook URLs, signature validation, dry run, vault readiness). |
| GET | `/integrations/:provider` | One provider: masked secrets, config, fields, last test, last error, usage for 30 days. Plivo also returns routed numbers; WhatsApp also returns routing and delivery counts. |
| PUT | `/integrations/:provider` | Save. Validated per provider, including the model and voice allow-lists. Sets `status=untested`. |
| POST | `/integrations/:provider/test/:op` | A **real provider request** using the saved credentials. Ops are listed below. Limited to 20 per 10 minutes per IP. |
| POST | `/integrations/:provider/enable` | `{ enabled }`. Enabling needs a passed test. |
| DELETE | `/integrations/:provider?confirm=yes` | Delete the saved credentials. |
| GET | `/integrations/:provider/usage` | Usage and sanitized errors for 30 days. |
| POST | `/integrations/plivo/numbers` | `{ number }`: route inbound calls to this organization. The number must be verified on the organization's own Plivo account, and the first organization to claim it keeps it. |
| DELETE | `/integrations/plivo/numbers/:number` | Remove a routed number. |
| POST | `/integrations/whatsapp/route` | Route the organization's verified WhatsApp number to it. |
| POST | `/integrations/plivo/test-call/answer` and `/integrations/plivo/test-call/hangup` | **public**: Plivo callbacks for test calls, signed with the organization's own token. |

Test operations:
- **Plivo `connection`:** checks the account, then that the caller ID belongs to that account.
- **Plivo `call`:** a real call. It needs:
  - an active organization;
  - `confirm: true`;
  - `DRY_RUN=false`;
  - a destination on `LIVE_TEST_RECIPIENTS`.
- **Sarvam `connection`:** generates speech.
- **Sarvam `tts`:** generates speech from up to 300 characters of text.
- **Sarvam `stt`:** recognises an uploaded WAV of up to 2 MB, or the round trip of the sample voice.
- **OpenAI `connection`:** checks the model is available to the key, then runs a tiny completion that reports token
  usage and quota errors.
- **WhatsApp `connection`:** looks up the phone number at Meta (display number, quality) and lists the templates with
  their status.

Error codes in test results:
- `auth_failed`
- `not_found`
- `number_not_on_account`
- `model_unavailable`
- `quota`
- `rate_limited`
- `timeout`
- `network`
- `provider_error`
- `invalid_response`

Messages are scrubbed of secrets and truncated.

Cost estimates appear only when the operator sets these prices; otherwise `costEstimate: null`:
- `OPENAI_PRICE_INPUT_PER_1M` and `OPENAI_PRICE_OUTPUT_PER_1M`
- `SARVAM_TTS_PRICE_PER_10K_CHARS`
- `SARVAM_STT_PRICE_PER_HOUR`

### Platform administration (Tacksharp staff)

Every route checks `User.isPlatformAdmin` **in the database**. The flag can only be set on the server:

```bash
npm run platform:admin -w apps/api -- grant|revoke|list [email]
```

| Method | Path | What |
|---|---|---|
| GET | `/platform/overview` | Organizations by status, pending registrations, active users, provider requests in the last 24 h, health. |
| GET | `/platform/organizations?search=&status=&page=` | Search by name, id or user email. Paginated. |
| GET | `/platform/organizations/:id` | Users, guests, integration **status**, routed channels (masked), usage, recent audit events, onboarding steps (computed from records). |
| POST | `/platform/organizations/:id/activate` | `{ confirmName }`: the exact organization name is required. Marks its users verified. |
| POST | `/platform/organizations/:id/suspend` | `{ confirmName, reason }`: sessions into it stop at once and login is refused. You cannot suspend your own organization. |
| PUT | `/platform/organizations/:id/industries` | `{ allowed: string[] \| null }`: the industries this organization may choose in Settings. |
| POST | `/platform/organizations/:id/users/:userId/disable` | `{ disabled }`: disabling ends the user's sessions. |
| POST | `/platform/organizations/:id/users/:userId/reset-link` | One-time password-reset link, shown once. |
| POST | `/platform/organizations/:id/invitations` | `{ email, role }`: an invitation link. |
| GET | `/platform/audit?organizationId=&action=&page=` | Audit log across organizations. |
| GET | `/platform/usage` | Provider usage per organization and source, for 30 days. |
| GET | `/platform/failures` | Failed BullMQ jobs (summarised), failed inbound messages, rejected webhooks since the process started. |
| GET | `/platform/health` | Live checks: API, database, Redis, queue counts, storage, provider success and latency in the last hour, release id. Read-only: there are no restarts, migrations or shells. |

### Other new endpoints

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/properties?status=&q=&page=` | any | Real estate property inventory. |
| POST | `/properties` | `customers.manage` | Add a property. |
| PATCH | `/properties/:id` | `customers.manage` | Update a property (including status). |

Healthcare endpoints changed:
- `GET /hospital/appointments`, `GET /hospital/appointments/:id` and `GET /hospital/patients` now need `clinic.view`.
- Phones and visit reasons are masked for roles that cannot manage the clinic or insurance.
- Opening one appointment writes `patient_record.viewed` to the audit log.

## Roles

| Role | Scope |
|---|---|
| Platform superadmin | `User.isPlatformAdmin`. Granted by script only, never through signup. |
| Organization admin | `admin`: everything in its organization, including integrations and people. |
| Manager | `manager`: operations, sales, marketing; can view integrations but not change them. |
| Operator (new) | `operator`: day-to-day work (customers, orders, bookings, appointments, stock, incidents). No people, settings or integrations. |
| Read-only | `viewer`: the guard refuses every write; patient data is masked. |
| Department roles | sales, operations, front desk, reception, insurance, technician, finance, marketing (unchanged). |
