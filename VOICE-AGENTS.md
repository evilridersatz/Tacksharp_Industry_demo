# Voice agents, knowledge bases and telephony (Sarvam + Plivo)

This covers the Agent Builder, knowledge bases, the ten voice agent demos, telephony provider routing (Sarvam Voice
Agents and Plivo), and Tara's continuous voice and video conversation. Everything here runs with `DRY_RUN=true` until an
operator switches it off (see GO-LIVE.md).

## 1. Sarvam telephony: what was verified (docs.sarvam.ai, 30 Oct 2026)

| Question | Verified answer | Source |
|---|---|---|
| Inbound and outbound calls | Both supported. The call is answered by an agent **hosted on Sarvam** (an "app" with a version). Inbound needs an *inbound deployment* that links the agent to a number. Outbound uses a campaign, or the Instant Outbound API. | [Overview](https://docs.sarvam.ai/conversations/overview), [Inbound](https://docs.sarvam.ai/voice-agents/deploy/inbounds.md) |
| Number types | You can rent a number from Sarvam (shown as "Sarvam Vobiz"). KYC is required, rental lasts 30 days and auto-renews from the wallet, and a number lapses if credit runs out. Numbers starting 080 / 079 are landlines. You can also bring your own number through Exotel, Twilio, Smartflo, Pulse, Intalk, Vobiz or Plivo. | [Rent from Sarvam](https://docs.sarvam.ai/conversations/deploy/telephony/rent-from-sarvam) |
| Does buying a number enable calls? | **No.** A rented number must be KYC-approved, then assigned to an inbound deployment (for inbound) or added to a group or campaign (for outbound). | same |
| Outbound API | `POST https://apps.sarvam.ai/api/outbounds/v1/orgs/:org_id/workspaces/:workspace_id/outbounds` with header `X-API-Key`. Body: `app_config {app_id, app_version, connection_config {connection_id, agent_phone_number}}` and `user_config {user_phone_number}`, plus an optional `webhook_config`. Returns `{attempt_id}`; a bad request returns 422. | [Create outbound call](https://docs.sarvam.ai/api-reference/instant-outbound/create) |
| Webhooks | Sent **after the call ends**. Fields: `attempt_id, status (connected / no_answer / busy / failed), duration, interaction_id, failure_reason, interaction_transcript, final_agent_variables, channel_info`. Failed deliveries can be re-delivered. | [Webhook payload](https://docs.sarvam.ai/api-reference/instant-outbound/webhook-payload) |
| Webhook signature | **Not documented.** We put an HMAC token in our own webhook URL (`TELEPHONY_WEBHOOK_SECRET`). | (absence in the pages above) |
| Audio formats | Telephony audio is handled inside Sarvam. The Pulse guide sets `frequency=8000` (8 kHz). Sarvam documents no way to stream call audio to our server. | [Pulse](https://docs.sarvam.ai/conversations/deploy/telephony/pulse) |
| Custom instructions and knowledge base | Configured on the Sarvam agent. Its knowledge base accepts PDF, DOCX/DOC, CSV/TSV, TXT and MD. Storage is tier-based, and a knowledge base attached to a live agent cannot be deleted. **No public API is documented for creating or updating agents or uploading knowledge.** | [Knowledge base](https://docs.sarvam.ai/conversations/build/knowledge-base) |
| Pricing (excl. GST) | Agent: Rs 3.50 per minute pay-as-you-go (Rs 3.25 Pro, Rs 3.15 Growth, Rs 3.00 Business), billed per 60 s. Sarvam telephony: Rs 0.20 per 30 s pulse. Number: Rs 59 per 30 days. Bring-your-own telephony: no Sarvam telephony fee. | [Pricing](https://docs.sarvam.ai/voice-agents/pricing.md) |
| Limits | Pay-as-you-go: 4 concurrent calls and 20 calls per minute. Pro: 10 and 50. Growth: 30 and 150. Business: 200 and 800. A call over the limit is rejected. | same |

### Consequences, and what is blocked

1. **Replacing Plivo with Sarvam is partial by design.**
   - **On Sarvam, the conversation runs on Sarvam's own agent.** The instructions and knowledge base from our Agent Builder are therefore *not* used live on Sarvam calls. To use them on Sarvam, copy them into the Sarvam agent in Sarvam's console.
   - **Blocked:** pushing agents and knowledge to Sarvam automatically, because Sarvam documents no API for it.
   - **On Plivo, our own engine runs every turn,** so a custom agent's instructions and knowledge base are used live.
   - Plivo is therefore kept, and each agent (and each organization's default) chooses its provider.
2. **Inbound through Sarvam** is configured in Sarvam (an inbound deployment). We receive the post-call webhook and save the call, the transcript and the outcome. The per-agent webhook URL is shown on the Voice agents page.
3. **Latency on Sarvam calls** cannot be measured per stage from our side: the audio never reaches us. We record how long Sarvam takes to accept each request, and the call duration.
   - Nothing here claims Sarvam is faster than Plivo. No live measurement was possible from the build environment, because no network route to Sarvam or Plivo was available.
4. **Field names inside `webhook_config`** are collapsed in the API reference, so we send `{url}`. This must be confirmed with one live test call (Settings → Integrations → Sarvam Voice Agents → Test call).
5. **No live verification.** The build environment cannot reach Sarvam, Plivo, OpenAI or Simli. All provider behaviour is covered by tests against mocked HTTP clients that follow the documented contracts.

## 2. What was built

### Telephony abstraction (`apps/api/src/telephony/`)

**The `TelephonyProvider` interface** defines:
- `getCapabilities`;
- `initiateOutboundCall`;
- `handleInboundCall`;
- `getCallStatus`;
- `handleWebhook`.

**`SarvamTelephonyProvider`** places calls through the documented Instant Outbound API. Its webhook:
- checks the token before the body is read;
- validates the payload;
- processes each event exactly once (unique `attempt_id`);
- creates the Call record and the transcript messages.

**`PlivoTelephonyProvider`** wraps the existing, signature-verified Plivo flow. It keeps backward compatibility; nothing was removed.

**`TelephonyService`** routes each call by the agent's provider, then the organization's default. Outbound gates run in this order:
1. Confirmation.
2. Idempotency key: the same key returns the first result; a different call under the same key returns 409.
3. Agent belongs to this tenant, is active, and has outbound on.
4. E.164 number.
5. Customer belongs to this tenant.
6. Calling consent, not on do-not-contact, not opted out.
7. Calling hours.
8. Concurrency limits (organization and agent).
9. Daily limits (organization and agent).
10. One live call per customer.
11. `DRY_RUN` and the live-test-recipient gate.
12. Provider configured.

Retry and redial rules:
- **One retry,** and only when the provider certainly did not place the call (429, or the connection was never made).
- **Timeouts and 5xx are never retried.**
- **No automatic redial.**
- **Every rejection is stored** with its reason.

**Sarvam credentials are a new provider (`sarvam_telephony`)** in the encrypted per-organization credential vault, under Settings → Integrations → Sarvam Voice Agents.
- **No connection test:** Sarvam documents no read-only check.
- **Proof is a real test call** to an approved test number, with `DRY_RUN` off.

### Agent Builder (`/voice-agents`, `/voice-agents/[id]`)

The wizard has seven steps: Industry → Configure → Knowledge → Voice & phone → Test → Review → Publish. Agents are tenant-scoped, and every field is validated on the server.

| Area | What is configured or enforced |
|---|---|
| Configuration | Name, description, industry, use case, instructions, languages (Tamil, English, Tanglish), voice (speaker and pace), greeting, fallback message, knowledge base, business hours, escalation keywords and handoff, call limits, telephony provider (and the Sarvam app id and version) |
| Phone | Inbound number and outbound purpose |
| States | Draft, active, archived. Any edit clears the "tested" mark. |
| Publish requires | A test since the last edit; every document indexed; the Sarvam app id when Sarvam places calls; an inbound number that is routed to this organization and not used by another active agent |
| Audit | Every change is recorded |
| Live calls | A published agent with an inbound number answers Plivo calls to that number with its greeting and knowledge base. Outbound calls are placed from the Voice agents page (Call). |

### Knowledge base (`apps/api/src/knowledge/`)

- **Upload checks:** the file type is checked by extension *and* content (PDF, DOCX, TXT, CSV), up to 10 MB, at most 50 documents per base. Exact duplicates are refused.
- **Storage:** server-generated file names under `KNOWLEDGE_DIR/<organizationId>/<baseId>/`, with mode 600 files in mode 700 folders.
- **Processing:**
  - Status moves through uploaded → processing → indexed, or failed with the reason. The page polls until processing finishes and never shows success early.
  - Retry and delete are available.
  - A document left mid-processing by a restart is marked failed and can be retried.
- **Extraction:**
  - PDF via `unpdf`, page by page; scanned PDFs are refused with an explanation.
  - DOCX via `mammoth`.
  - TXT as is.
  - CSV rows become labelled facts.
- **Prompt-injection protection:**
  - Lines that try to instruct the AI are removed before indexing, and counted.
  - Passages reach the model inside fenced, labelled excerpts that it is told never to obey. The fence cannot be closed from inside a document.
- **Retrieval:** BM25 over the tenant's own passages. It works for Tamil script, Tanglish and English, needs no vector database and costs nothing per query. The cache is keyed by organization and base.
- **Source attribution:** every answer lists the file and page or row it came from.

### Shared agent engine (`voice-agents/agent-engine.ts`)

One engine serves the dashboard test console, the public demos and phone calls handled by custom agents. It works as follows:
- It combines the agent's instructions with the top passages and answers in the caller's language.
- Escalation keywords hand off to a person without a model call.
- Outside business hours, it gives the after-hours message.
- Without a model (or when the model fails), it answers with the best matching sentence from the knowledge base, or the fallback message. It never invents an answer.
- It records timings for retrieval, the model and the total.

### Voice agent demos (`/voice-demos`, public)

There are ten templates: retail, restaurant (the GR Chicken ordering flow), real estate, healthcare, education, automotive, banking, manufacturing / B2B, hospitality and general support.
- **Each template has:** a scenario, instructions, example questions, a sample knowledge base, languages, a chat and voice demo, and an expected outcome.
- **"Customise and publish"** creates a draft agent with the sample knowledge processed into its own base.
- **The demos are simulated:** they use sample data only, are labelled as such, call and message no one, store nothing and are rate-limited.

### Tara: continuous voice and video (`components/live-agent.tsx`)

- **Mode switch:** Chat, Voice call or Video call. The conversation history is shared across modes.
- **Microphone:** reused for the whole call, so permission is asked once. Permission errors are specific: blocked, or no device found.
- **Continuous turns:** listen → end of speech → our server's speech recognition → answer → speak → listen again.
- **Barge-in:** the caller can talk over Tara and she stops. Detection uses the echo-cancelled mic with a higher, sustained level, so her own voice does not trigger it.
- **Recovery:**
  - One quiet "Reconnecting…" retry on a network error.
  - The call pauses after repeated silence.
  - There is a mute control.
- **Speech recognition:** always our server's Sarvam recognition. The browser's built-in speech recognition is not used, so there is nothing to label.

**Video (Simli):**
- One session per start, guarded by `const videoStarting = useRef(false);`.
- **Greeting:** Tara greets automatically once connected, exactly once per session, with no Speak button. If the browser blocks autoplay, one "Start conversation" tap unlocks it.
- **Loop:** the same continuous loop and barge-in as voice. The presenter's buffer is cleared before every new reply, so audio never overlaps.
- **Status:** Connecting / Listening / Thinking / Speaking / Reconnecting / Ended.
- **When the session ends:**
  - it shows "Ended", stops the call loop and releases the mic;
  - it **never opens a new session automatically**;
  - closing the assistant stops the session.
- **Rate limit:** 4 sessions per 10 minutes per visitor. The 429 now carries CORS headers, so the visitor sees the real reason (CORS was moved before the rate limiter; a test proves it).
- Session tokens are never logged.

## 3. Database (additive migration `20261030000000_voice_agents`)

**New tables:**
- `VoiceAgent`
- `KnowledgeBase`
- `KnowledgeDocument`
- `KnowledgeChunk`
- `TelephonyCallRequest` (unique per organization + idempotency key)
- `TelephonyWebhookEvent` (unique per provider + event key)

**New columns:** `Call.agentId` (nullable) and `Call.provider` (default `plivo`).

Nothing is dropped or renamed. Existing calls keep `provider='plivo'` and no agent, so GR Chicken is unchanged.

**Back up first.** Production migration only with approval (DEPLOY.md, step 4 / step 8).

## 4. Configuration

| Setting | Needed for |
|---|---|
| `KNOWLEDGE_DIR` | Where uploads are stored. Back it up with the database. |
| `TELEPHONY_WEBHOOK_SECRET` (≥ 32 random characters) | Sarvam result webhooks. Without it, Sarvam calls are refused. |
| `TELEPHONY_ORG_MAX_CONCURRENT`, `TELEPHONY_ORG_DAILY_LIMIT` | Organization-wide outbound caps |
| `SARVAM_AGENTS_*` | Platform Sarvam account for pre-existing organizations. Others save their own credentials. |
| `OPENAI_AGENT_MODEL` (optional) | Agent replies. Without OpenAI, agents answer extractively from the knowledge base. |
| Existing: `DRY_RUN`, `LIVE_TEST_RECIPIENTS`, Plivo / Sarvam / OpenAI / Simli keys | Unchanged |

Sarvam setup, in Sarvam's console:
1. Complete KYC.
2. Rent a number, or connect your telephony provider.
3. Create the agent: paste the instructions and upload the same documents.
4. Note the `app_id` and version, the `connection_id`, and the org and workspace ids.

Then save them in Settings → Integrations → Sarvam Voice Agents, and set the agent's provider to Sarvam.

For inbound, create an inbound deployment and paste the agent's webhook URL from the Voice agents page.

The webhook URL contains a secret token, so treat it like a password:
- Only roles that manage agents can see it.
- It only lets someone post a call result for that one agent or request.
- Keep reverse-proxy access logs private, or strip query strings for `/telephony/sarvam/webhook`.

## 5. Deploy and rollback (summary; full steps in DEPLOY.md)

1. Back up the database and `KNOWLEDGE_DIR`, then run the restore drill (step 2).
2. New release directory; `npm ci`. This adds `unpdf@1.8.1` and `mammoth@1.13.0` (exact versions, MIT licence, no native code).
3. **Staging:** `npx prisma migrate deploy` (additive), then set `TELEPHONY_WEBHOOK_SECRET` and `KNOWLEDGE_DIR`, keep `DRY_RUN=true`, and switch only the staging processes.
4. Smoke tests:
   - `/voice-demos` loads;
   - `POST /demos/agents/restaurant/chat` answers from sample data;
   - Agent Builder upload → indexed;
   - an outbound call request returns `dry_run`;
   - `GET /telephony` shows the capabilities.
5. **Production only with approval** (database change, live telephony).
   - Live Sarvam: one test call to a `LIVE_TEST_RECIPIENTS` number.
   - Confirm the webhook arrives and the call shows "completed" with its transcript.

**Rollback:**
- Switch the processes back to the previous release directory. The old code ignores the new tables and columns.
- To stop all calls instantly, set `DRY_RUN=true` and restart.
- The migration does not need to be reverted (additive). If it ever must be, drop the six new tables and the two `Call` columns after a backup. No other data depends on them.

## 6. Estimated monthly provider costs (assumptions stated; provider invoices are authoritative)

| Item | Assumption | Estimate |
|---|---|---|
| Sarvam agent minutes | 1,000 min / month, pay-as-you-go Rs 3.50 / min | Rs 3,500 |
| Sarvam telephony (rented number) | 1,000 min = 2,000 × 30 s pulses × Rs 0.20 | Rs 400 |
| Sarvam number | 1 number × Rs 59 | Rs 59 |
| **Sarvam total (1,000 min)** | excl. GST | **≈ Rs 3,960** (≈ Rs 4,670 with 18% GST) |
| Plivo calls | Per your Plivo rate card (not verifiable from here) | set `PLIVO_PRICE_PER_MIN` |
| OpenAI for agent replies | Depends on model price × tokens (≈ 1–2k tokens per turn) | set `OPENAI_PRICE_*`. The usage page estimates it. |
| Knowledge base | Lexical retrieval, no embeddings or vector database | Rs 0 extra (disk only) |
| Simli video | Billed per minute by Simli; sessions are capped (600 s, 90 s idle, 4 per visitor per 10 minutes) | per your Simli plan (not verified here) |
| Public demos | Use the platform OpenAI key when set, otherwise none (extractive) | small; rate-limited 40 / min / IP |
