# One WhatsApp number and one Plivo number for all ten industry demos

## How it works

The platform already runs every industry as its own workspace (organization) with its own dashboard, AI agent,
data and permissions. The dashboard's **Switch workspace** changes the signed-in session's organization on the
server (`POST /auth/workspace`, membership checked). Every API query takes the organization from that session,
never from the request.

Inbound messages and calls are routed by the **receiving number**. `TenancyService.resolve` maps the WhatsApp
`phone_number_id` or the dialled Plivo number to **one** organization: the number's owner. The webhook payload
signed by Meta, and the `To` of the call, decide this; the dashboard selection never does.

**Demo sessions** (new) make one shared number serve every industry:

1. An admin or manager opens the industry workspace to demonstrate and goes to **Setup → Data & APIs → Live demo on
   the shared number**.
2. They pick an **approved test number** (`LIVE_TEST_RECIPIENTS`), choose WhatsApp and/or voice, confirm the tester
   agreed, and press **Start demo session**.
3. While the session is active, that tester's WhatsApp messages and calls to the shared number are answered by
   **this workspace's agent** and stored **only in this workspace**.
4. Everyone else who writes to or calls the shared number reaches the number's owner, exactly as before.
   - With `DEMO_SHARED_NUMBER_STRICT=true`, they are not answered at all. Their message is recorded as
     `skipped`, and a caller hears "please ask your presenter to start a demo session".

### Routing rules (deterministic)

| Rule | Why |
|---|---|
| A session key is the approved phone plus the shared number's owner (`hubOrganizationId`) plus the channel. | A tester writing to some other business's number is unaffected. |
| There is one active session per phone. Starting one in another workspace ends the previous one, and both workspaces' audit logs record it. | There is never a choice between two industries for one message. |
| The binding is read from the database for every message or call. | Switching the dashboard to another workspace never moves an existing session. |
| Sessions expire (`DEMO_SESSION_HOURS`, default 4, maximum 24). | Old bindings never linger. |
| Conversations, calls and messages keep the workspace they were stored in. | History is never reassigned. |
| An outbound call carries its `callId` in Plivo's answer, turn and hangup URLs. | Each call keeps the industry it started in. |
| A redelivered webhook is recognised by Meta's global message id across workspaces. | It is never answered twice, even if the binding changed in between. |
| Delivery receipts go to the owner and to workspaces bound to that recipient, matched by provider message id. | Status shown for a demo message is the real receipt. |

### Safety (unchanged and enforced)

- **Who can be bound:** only phones on `LIVE_TEST_RECIPIENTS`. A real customer can never be bound, and the API returns `400`.
- **Who can start or end sessions:** admins and managers (`customers.contact`). Anyone with `customers.view` can see them.
- **The tester's record:** stored in the demo workspace as a **real** contact (`isDemo=false`, `source=demo_session`). Consent comes from the admin's confirmation, recorded in the audit log as `approved_test_recipient`.
- **Sending:** goes through the existing live gate:
  - `DRY_RUN` on means nothing is sent or dialled;
  - the approved-recipient check;
  - consent and opt-out;
  - calling hours;
  - an approved template outside WhatsApp's 24-hour window.

  Synthetic demo records are still never contacted.
- **Test messages and test calls:** are started from the tester's record (**Send test / call**) and need a confirmation dialog.
- **"Check connections":** makes read-only requests to Meta (phone-number info) and Plivo (account info), and sends nothing. Each result is shown as Connected, Authentication failed, Provider unavailable or Not configured.

## Which agent answers (existing, unchanged)

| Industry (Settings → industry / Organization.vertical) | WhatsApp agent | Voice |
|---|---|---|
| real_estate | Conversation engine (lead qualification, site visits) | Same engine |
| textile | Conversation engine, textile mode (catalogue, quotations) | Same; opening "your fabric and saree enquiry" (new) |
| retail / manufacturing / agency | Conversation engine, generic mode | Same; industry opening (new) |
| food / hotel / hospital | Vertical agents (orders, bookings, OPD appointments) | Engine; industry opening (new) |
| cctv | VisionOps technician / status agent | Industry opening (new) |
| restaurant (GR Chicken) | Ordering engine | Ordering engine (Tamil) |

Before this change, outbound calls in every non-restaurant workspace opened with "calling about your property
enquiry". They now use the workspace's industry.

## Configuration (server `.env`)

| Variable | Meaning |
|---|---|
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | The one shared WhatsApp Cloud API number (existing). |
| `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER` | The one shared Plivo number (existing). |
| `LIVE_TEST_RECIPIENTS` | Comma-separated approved tester phones (existing). The only phones that can be bound. |
| `DRY_RUN` | `true` means everything is simulated. Set `false` only for an approved live demo. |
| `WHATSAPP_TEMPLATE_NAME` | An approved template, needed to start a chat outside the 24-hour window. |
| `META_APP_SECRET` | **Required in production:** verifies Meta webhook signatures. |
| `PLIVO_VALIDATE_SIGNATURE=true` | **Required in production:** verifies Plivo callback signatures. |
| `DEMO_SESSION_HOURS` | Session length, 1–24 hours (default 4). |
| `DEMO_SHARED_NUMBER_STRICT` | `true` means senders without a session are not answered. Use it only when the shared number is a dedicated demo line, not a real business's number. |

## Deploy (staging)

This is additive: one new table (`DemoSession`), one new API module, a card on an existing page, and wording
changes for voice. The steps are the same as in `LIVE-WORKSPACES.md` (new release directory, restart only the two
staging processes). One extra step:

```bash
cd "$NEW/apps/api"
npx prisma migrate status            # shows 20261028000000_demo_sessions as pending
mysqldump <staging_db> > ~/backup-$(date +%F-%H%M).sql
npx prisma migrate deploy            # creates the DemoSession table only (approval required)
```

**Rollback:** start the previous release directory. The `DemoSession` table can stay, because older code ignores
it. Dropping it needs approval.

## Verify on staging (manual, with approval)

1. `GET /health`: `release.id` is the new commit.
2. Log in, switch to a demo workspace (for example Hotel), open **Data & APIs**, and press **Check connections**.
   Both providers should show **Connected**. If not, the card shows the real reason.
3. Start a session for your own approved number. Send "hi" from that phone to the shared WhatsApp number.
   - With `DRY_RUN=true`, the conversation appears in **Guest conversations** of the hotel workspace, and the reply
     is recorded as not sent.
   - With `DRY_RUN=false` (approved live demo), the hotel agent replies on WhatsApp, and the delivery status follows
     Meta's receipts.
4. Switch the dashboard to Textile and send another message: it still goes to Hotel. Start a Textile session: the
   next message goes to Textile, and the Hotel session shows "replaced".
5. Call the shared Plivo number from the bound phone: the call appears in that workspace's **AI calls**.
6. End the session: your next message reaches the number's owner again.
