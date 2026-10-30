# The business owner's experience

This describes how the dashboard serves a non-technical owner. Every status comes from the server, and nothing is shown
as working unless the server has proof that it works.

## Home (`/`)

The Home page shows the following, in this order:
1. **Welcome.** It explains what Tacksharp does and shows the business name, industry, today's date and the sending
   mode (test mode or live). It ends with **one next action**: the first incomplete setup step.
2. **Needs your attention.** Each problem is described in plain English with a button that fixes it. Examples: the
   account is waiting for activation, a channel failed its test, there is no active agent, calls or call requests
   failed, a document could not be read, customer consent is missing.
3. **Results for Today / Last 7 days / Last 30 days.** Each figure is compared with the previous period:
   - customer messages received;
   - conversations handled;
   - calls completed;
   - new leads (where the industry has leads);
   - orders received (chicken shop);
   - follow-ups completed.

   Where there is no data, the page says so instead of showing a number. Below the figures is a daily chart of
   customer messages and calls in India time, refreshed every minute.
4. **Setup checklist.** It covers seven steps:
   - business profile;
   - AI agent;
   - communication channels;
   - customer data;
   - consent and calling permissions;
   - a test conversation or call;
   - production readiness.

   Each step is shown as *Complete*, *Action required*, *In progress* or *Blocked*, with an action button. A step is
   never green when it is incomplete.
5. **Recent activity.** Leads, calls, call requests that were not placed, orders and setup changes, each linked to
   its page.
6. **The industry's detailed dashboard,** unchanged (for example the restaurant or real-estate overview).

Source: `GET /home?range=today|7d|30d`, which reads only the signed-in organization's own records.

## When a channel counts as "connected"

| Shown as | When |
|---|---|
| Connected | The organization's own account passed a connection test and is enabled. For pre-existing workspaces only: Tacksharp's account is in use **and** this workspace's number is routed to it. |
| Needs attention | The last connection test failed. |
| Configuration incomplete | Details are saved but required fields are missing, the connection is untested, or it is tested but switched off. |
| Not connected | Nothing has been set up. |

A server variable existing is never shown as "connected".

## Navigation

Every industry uses the same sections, in a fixed order:
1. Home
2. AI Agents
3. Customers & Leads
4. Conversations
5. Orders & Business Activity
6. Analytics
7. Integrations
8. Settings

Each industry keeps its own pages and labels. They are placed into these sections centrally (`standardNav` in
`apps/web/src/lib/industries.ts`), so the rest of the dashboard needs no per-industry changes.

## GR Chicken / Chicken Shop

- **Where to find it.** It is a card under *Restaurants & Food Service*, both at signup and in the setup guide.
- **What choosing it does.** The workspace runs the GR Chicken ordering engine: products by the kg, cuts, shops,
  pickup orders, order tracking and ready calls.
- **Switching later.** An existing workspace can switch to it only if it is a new self-service workspace with no
  customers, leads or orders yet. The switch is recorded in the audit log.
- **Setting up the menu.** A new chicken shop adds its categories, products and per-kg prices, and its shops
  (address, opening hours, preparation time), from **Menu & stock**.
- **Order statuses.** These come from the existing order engine: pending, confirmed, preparing, ready, completed and
  cancelled. The orders page shows each order's status. Customer enquiries that have not become an order are in
  Conversations.

## AI agent wizard (`/voice-agents/[id]`)

The wizard has eight steps:
1. **Purpose.** Only actions the platform supports can be chosen. WhatsApp updates are labelled as not available for
   custom agents.
2. **Business.** The business name, the industry, a description and service area, and working hours.
3. **Assistant.** Name, tone, languages, greeting and the fallback answer. Instructions, handover rules and voice
   settings sit under **Advanced settings**.
4. **Knowledge.** Upload documents and track each one until it is indexed.
5. **Channels.** Truthful channel status, and the choice of voice provider and phone numbers.
6. **Safety.** The server's own checks, explained in plain English:
   - provider configured;
   - a Sarvam agent id, when Sarvam handles the calls;
   - the inbound number routed to this workspace;
   - customers who agreed to calls;
   - calling hours;
   - limits;
   - live sending.
7. **Test.**
   - **Test conversation:** chat or voice; nothing is sent.
   - **Real test call:** never automatic. You choose the customer, the destination number is displayed, and you
     must confirm explicitly. The server then applies every gate.
8. **Launch.** The page says either "Your assistant is ready to launch." or "Your assistant is not ready yet." and
   lists exactly what is missing. Publish stays disabled until nothing required is missing.

The checklist comes from `GET /telephony/agents/:id/readiness`.

## Other pages

- **Integrations** (`/settings/integrations`) has three parts:
  - **What your customers can use:** the same status as the Home page.
  - **Provider cards:** each shows a plain status, what is missing, the last successful test and one action:
    Connect, Configure, Test, Enable or Repair.
  - **AI providers** sit on the same page. CRM integrations are not available, and the page says so.
- **System health** (`/settings/diagnostics`):
  - Everyone sees plain-language status: the application, business data, background work, channels, AI assistant
    and sending mode.
  - Admins also see sanitised technical details: release, timings, queues, last provider errors and refused call
    requests with their reasons.
  - It is read-only and never restarts anything.
- **Customers.** Consent labels read *consent recorded*, *consent not recorded*, *Contact opted out* and *Do not
  contact*. A number on the test list is never treated as consent.
- **Calls.** Failed or blocked calls say why in plain English, for example: "The customer's calling consent has not
  been recorded.", "The call was blocked by your calling hours.", "Test mode is on: no real call was placed." The raw
  code is in an expandable *Technical details* line.
