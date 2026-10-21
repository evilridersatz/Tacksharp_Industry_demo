# Live demo data (all industries)

Every demo workspace can run **live**. While the live demo is on, simulated customers, calls and records arrive every minute through the same tables and screens real data uses, so the dashboards update on their own. That covers overview KPIs, conversations, follow-ups, AI calls, handoffs, and each industry's own pages.

**Nothing is sent and nothing is real:**
- Customers are synthetic numbers in the reserved demo range (`910000…`).
- AI replies are canned demo text, so no AI provider is called.
- Follow-ups that fall due are marked *simulated*.
- Demo records are never sent, whatever `DRY_RUN` says.
- Non-demo workspaces are refused.

## Switch

- **Demo banner (every page of a demo workspace):** shows **Live demo · activity 20 s ago** or **Live demo paused**, with a *Start / Pause live demo* button. It is backed by `GET / POST /demo/live`, and only an admin or manager can switch it.
- **CCTV workspace:** the Operations center also has *Start / Stop live demo*, which drives the VisionOps feed described in `VISIONOPS.md`.
- **Seeding:** `npm run seed:industry-demos` seeds every demo workspace with the live demo **on**. Seed with `DEMO_LIVE_DEFAULT=off` to start them paused.
- **History:** the seed also replays **30 days** of the same live activity (`DEMO_SEED_HISTORY_DAYS`, default 30; `0` skips it). This makes the 7- and 30-day charts level with today instead of showing a spike. Each workspace replays in 60-minute steps, all in parallel; it takes about 6 minutes. Re-seeding replaces the earlier feed rows; it never adds to them.
- **Whole server:** `DEMO_LIVE_FEED=off` disables the live demo on a server.

The feed runs inside the Tacksharp scheduler, which is the same process as the VisionOps sweep. It runs wherever `RUN_WORKERS` is on, or with `TACKSHARP_SCHEDULER=true`. The older `VISIONOPS_SCHEDULER=true` also works. Use `TACKSHARP_SCHEDULER=true` on a staging API that keeps `RUN_WORKERS=false`. With several API processes, a Redis lock lets only one of them run each minute.

## What happens each minute

| Workspace | Live activity |
|---|---|
| All (except CCTV) | WhatsApp chats with AI replies in English, Tamil and Tanglish; new leads and lead progress; follow-ups coming due (simulated) with the upcoming list kept full; handoffs opened and picked up. |
| Real estate, textile, GR Chicken, food, hotel, hospital | AI calls: ringing / in progress (the **live** badge), then completed with a transcript and outcome; some not answered or busy. |
| GR Chicken (demo) | Orders through pending → confirmed → preparing → ready → collected; ready notices (simulated); ratings and complaints. |
| Restaurant / food | Orders by time of day; pending → confirmed → preparing → ready or out for delivery → completed; ratings; complaints. |
| Hotel | Booking requests (held, then confirmed by the front desk) within room inventory; today's check-ins (room assigned) and check-outs; housekeeping turnaround; guest ratings. |
| Hospital | Bookings on each doctor's OPD grid (no overlaps); today's patients check in, are seen, and some are no-shows; Meta campaign leads; insurance cases moving. |
| Textile / retail | Quotations (draft → sent → accepted / rejected / expired). Orders through confirmed → processing → ready to dispatch → dispatched (an invoice is issued through the real finance service) → delivered. A payment is recorded and verified (simulated evidence). Feedback is received or needs action. |
| Manufacturing | Quality inspections every few minutes (Line 3 runs worse); quality alerts become corrective-action tasks; open inspections resolved with a fix. |
| Agency | Leads from Meta, Google, the website and LinkedIn, with campaign and notes; conversations and handoffs. |
| CCTV (VisionOps) | Agent heartbeats and camera checks; faults → incidents → technician ACK → verified restoration (see `VISIONOPS.md`). |

**Catch-up after a pause.** When the live demo starts, or after a pause of 2 hours or more, the first tick replays the last ~2.5 hours in 15-minute steps. This fills "today" at once.

**Pace.** The pace is a believable small business, not a stress test. Per workspace on a busy day, that's roughly:
- 60–110 WhatsApp chats and 30–60 AI calls;
- 40–100 kitchen orders (restaurant / food);
- about 40 appointments (hospital) or about 15 hotel bookings;
- 20–50 quotations or orders (textile / retail);
- 30–40 quality inspections (manufacturing).

Arrivals are Poisson-distributed and weighted by IST time of day: quiet nights, busy late mornings and evenings. Clinic, kitchen and front-desk steps follow real hours. Stages are stamped at the moment they were due, so a replayed order is confirmed, prepared and collected at plausible times. Invoices and payments carry the replayed dates.

**Returning customers.** A customer whose last enquiry is closed or more than a week old starts a new enquiry (a new lead), as in a real CRM.

## Data volume and retention

- **Customers:** new chats come from a pool of 300 synthetic numbers per workspace, so returning customers are normal and the customer list stays bounded.
- **What gets deleted:** feed records carry ids starting `dl_` and are deleted every hour once they are older than 35 days. That keeps a full 30-day window for the charts while bounding the database. Seeded demo rows are never deleted by this.
- **Volume:** about 3,000 chats and 3,000–4,000 business records per workspace over 30 days.
- **Before and after a run:**
  - The seed refreshes the base data.
  - A test that drives the feed simulates the past hour, never the future.

## Tests

- `test/demo-live.integration.spec.ts` (needs the seeded demo workspaces in `TEST_DB_NAME`). It covers:
  - real workspaces untouched;
  - 6 hours of replayed activity plus 30 live minutes across all nine industries, with chats, leads, simulated follow-ups and calls growing (a fixed time-of-day weight keeps it independent of when it runs);
  - orders, reservations, appointments, quotations, sales orders and inspections created and moving;
  - invoices issued and payments recorded through the finance service;
  - only synthetic numbers and simulated replies;
  - retention removes only `dl_` rows older than 35 days.
- `apps/web/tests/ui-industries.py` additionally checks the demo banner's live switch.

## Not real

The chats, calls, transcripts and payments are synthetic. They show how the product behaves; they are not evidence that a WhatsApp, voice or payment provider works. Real-provider checks are listed in `VISIONOPS.md` and the deployment checklist.
