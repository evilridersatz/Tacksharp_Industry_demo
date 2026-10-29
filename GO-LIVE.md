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
