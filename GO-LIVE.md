# Going live: switching off dry run

Every dashboard button and menu calls the real API. What keeps messages and calls from reaching real customers is
one server setting, `DRY_RUN`, plus two safety lists. The code ships with dry run **on** by default, so a fresh or
misconfigured server can never message customers by accident. You switch it off on the server, not in the code.

## The settings (in `apps/api/.env` on the AWS host)

| Setting | Dry run (today) | Live, step 1: your own numbers | Live, step 2: all consenting customers |
|---|---|---|---|
| `DRY_RUN` | `true` | `false` | `false` |
| `LIVE_TEST_RECIPIENTS` | your test numbers | your test numbers, e.g. `919800011122,919xxxxxxxxx` | keep them |
| `LIVE_ALLOW_ALL_CUSTOMERS` | unset | unset | `true` |

What each step means:
- **Dry run:** nothing is sent; replies are recorded as "simulated".
- **Live, step 1:** real WhatsApp messages and calls go **only** to the numbers on `LIVE_TEST_RECIPIENTS`. Everyone
  else is still recorded as simulated.
- **Live, step 2:** real messages and calls go to every customer who has given consent. Opt-outs (STOP) are always
  honoured.

These must also be set and correct before either live step:
- **WhatsApp:**
  - `WHATSAPP_ACCESS_TOKEN`
  - `WHATSAPP_PHONE_NUMBER_ID`
  - `WHATSAPP_VERIFY_TOKEN`
  - `META_APP_SECRET`
  - approved templates (`WHATSAPP_TEMPLATE_*`) for messages outside the 24-hour window
- **Calls:**
  - `PLIVO_AUTH_ID`
  - `PLIVO_AUTH_TOKEN`
  - `PLIVO_FROM_NUMBER`
  - `PLIVO_VALIDATE_SIGNATURE=true`
  - an HTTPS `PUBLIC_BASE_URL`
- **AI and voice:**
  - `OPENAI_API_KEY`
  - `SARVAM_API_KEY`
- `npm run check:config -w apps/api` must report no problems.

## Order

1. Deploy the release (see `DEPLOY.md`) with `DRY_RUN=true`. Run the smoke script.
2. Set `DRY_RUN=false` with **only your own numbers** in `LIVE_TEST_RECIPIENTS`, and restart the API process only.
   - Send a WhatsApp message to the business number from your phone, and check that the reply arrives.
   - Place a test call (Settings → Integrations → Plivo → Test outbound call, or `npm run verify:live -- --call=<your number>`).
   - Check **Platform console → Service health → Response times**.
3. When you are satisfied, set `LIVE_ALLOW_ALL_CUSTOMERS=true` and restart the API.
4. To stop all sending instantly at any time, set `DRY_RUN=true` and restart.

## Tara, the website and dashboard assistant

Tara is live as soon as the API has `OPENAI_API_KEY` (AI answers) and `SARVAM_API_KEY` (voice in and out). `DRY_RUN`
does not affect it: it only talks to the visitor in the browser and never messages or calls anyone.
- Without the OpenAI key it answers from built-in website answers.
- Without the Sarvam key the microphone and voice are hidden and typing works.

Optional settings:
- `OPENAI_ASSISTANT_MODEL`
- `OPENAI_ASSISTANT_REASONING_EFFORT` (for example `minimal`, once checked with `verify:live`)
- `ASSISTANT_TTS_SPEAKER` (default: the call voice)
- `ASSISTANT_TTS_PACE` (default 1.05)
- `RATE_LIMIT_ASSISTANT_PER_MIN` (default 40 per visitor IP)

## Tara's talking video presenter (Simli)

Visitors can press **Video call** in Tara's panel. A Simli presenter (a stock AI presenter, labelled as such) then
speaks every answer with lip-sync. The voice is still **ours**: our Sarvam Tamil and English voice is streamed to the
presenter at 16 kHz, so Tamil and Tanglish sound the same as on calls.

1. Create a Simli account and choose a stock presenter face. Copy its **face ID** and your **API key**.
2. Set these on the API server (the key never reaches the browser; the server issues short-lived session tokens):
   ```
   SIMLI_API_KEY=<your Simli API key>
   SIMLI_FACE_ID=<the stock presenter's face id>
   SIMLI_MAX_SESSION_SECONDS=600
   SIMLI_MAX_IDLE_SECONDS=90
   RATE_LIMIT_ASSISTANT_VIDEO_PER_10MIN=4
   ```
   - Video is billed per minute, which is why sessions are capped.
   - Video starts only when the visitor presses the button, and stops when they close Tara.
3. Video also needs `SARVAM_API_KEY`, because it uses our voice. Without Simli the button is hidden. If Simli cannot
   connect within 15 s, the visitor sees a message and Tara carries on with the animated face and voice.
4. Once connected, Tara greets the visitor by herself (once per session) and the conversation is continuous: she listens,
   answers, and listens again; the visitor can talk over her. When the session ends (time or idle limit), Tara says so
   and never opens a new paid session by herself.

## Custom voice agents and Sarvam telephony

See `VOICE-AGENTS.md` for what Sarvam supports (verified from its documentation), the Agent Builder, knowledge bases
and costs. Before going live with custom agents:
- set `TELEPHONY_WEBHOOK_SECRET` (32+ random characters) and `KNOWLEDGE_DIR` (backed up with the database);
- Plivo agents: route the agent's inbound number to the organization (Settings → Integrations → Plivo → Numbers);
- Sarvam agents: in Sarvam's console complete KYC, assign the number to an inbound deployment (inbound) or connection
  (outbound), create the agent with the same instructions and documents, then save the ids in Settings → Integrations →
  Sarvam Voice Agents and place one test call to a `LIVE_TEST_RECIPIENTS` number;
- outbound calls by agents follow the same `DRY_RUN` / `LIVE_TEST_RECIPIENTS` / `LIVE_ALLOW_ALL_CUSTOMERS` steps above,
  plus consent, do-not-contact, calling hours, idempotency and per-organization / per-agent limits.
