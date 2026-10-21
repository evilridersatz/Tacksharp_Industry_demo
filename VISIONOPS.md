# Tacksharp VisionOps: CCTV health & downtime monitoring

**Centralized CCTV Monitoring | Manage All Sites from 1 Screen**

VisionOps is a new workspace industry (`cctv`) inside the existing Tacksharp Phase 3 monorepo. It is not a separate app.

- **Who uses it:** a CCTV installer, AMC provider or integrator monitors the cameras and DVR/NVRs of all its customers' sites from one dashboard.
- **How it works:** it detects faults, opens one incident per fault and follows up with technicians on WhatsApp. It closes an incident only on fresh monitoring evidence, and produces uptime and SLA reports.

## What was reused

| Existing piece | Used for |
|---|---|
| Auth guard, `@Org()` scoping, workspace switcher | Every VisionOps route is private and organization-scoped. Agent routes are public but token-authenticated. |
| Governance permissions | New `monitoring.view` / `monitoring.operate` / `monitoring.manage` permissions and a new `technician` role. Manager gets `monitoring.*`; operations gets view and operate. |
| Tenant settings (sanitised JSON) | New `monitoring` section: thresholds, quiet hours, escalation, cost, plans. Edited in Settings. |
| Industry registry (API and web) | Menu, Operations-center home, agent catalogue (11 agents), dashboard, Data & APIs inventory (13 tables), scenario runner (9 scenarios). |
| AI entry point (`AiService`) | WhatsApp messages to a `cctv` workspace go to the technician assistant (rules only). |
| WhatsApp sender, DRY_RUN live gate (`liveGate`), delivery receipts | Alerts are SIMULATED under DRY_RUN, for demo numbers and for numbers that are not approved. Live sends use the existing sender; Meta delivery receipts update alert status. |
| Workers service | A 60-second VisionOps sweep runs only when `RUN_WORKERS` is on. On staging (workers off) use **Run checks now**. |
| Rate limiter, `@Public()` | `/monitoring/agent/*`: 120 requests/min per IP, token required. |
| Demo seed (guarded, idempotent) | New demo workspace `org_demo_cctv`. |
| Test harness (vitest + MySQL test DB, Playwright UI suite) | 20 new API tests; the UI suite now covers 10 workspaces. |

There was **no existing camera / NVR / RTSP / ONVIF code**.

## Data model (migration `20261023000000_visionops`, additive only)

- The `Organization` (tenant) is the CCTV provider.
- `MonitoringCustomer` is one of the provider's clients: Organization → Customers → Sites → Recorders and Cameras → Health events → Incidents → Timeline and Notifications.

| Table | Purpose |
|---|---|
| `MonitoringCustomer` | Client company, contact, opt-in for resolution reports |
| `MonitoringSite` | Site code, address, GPS, monitoring mode (`local_agent` / `cloud`), internet status |
| `RecorderDevice`, `CameraDevice` | Inventory, monitoring method, **capabilities** (what can really be proven), live status counters |
| `MonitoringAgent`, `AgentHeartbeat` | Local agents: sha256 token hash only, heartbeats, queue depth, 4G backup flag |
| `HealthEvent` | Every check result. Idempotent per sender event id; `replayed` marks events sent late from an offline queue. |
| `DowntimeIncident` | Number, fault category, severity, state machine timestamps, evidence, reopen count, escalation level. A unique `openKey` gives one active incident per device + fault. |
| `IncidentTimelineEvent` | Audit trail of everything that happened |
| `NotificationAttempt` | Every WhatsApp / voice message: idempotency key, status, attempts, cost estimate, simulated flag |
| `SiteTechnician` | Technicians, supervisors, managers; shifts, on-call, WhatsApp consent |
| `ServiceContract` | AMC / warranty / monitoring contracts with SLA restore and response targets |
| `SiteUptimeSnapshot` | Daily uptime per site, for reporting history |

**Camera usernames, passwords and RTSP URLs are never stored in the cloud.** They stay in the site agent's local config.

- An address entered in the UI is refused if it contains credentials.
- Event details are scrubbed (`rtsp://[redacted]`, `password=[redacted]`).
- IP addresses are shown masked (`192.168.•.22`).

## Deterministic rules (no model decides a device status)

These are the defaults; each is set in **Settings → Camera monitoring rules**.

**Detecting a fault**
- **Debounce:** a fault is confirmed after **3 consecutive failed checks spanning at least 180 s**. Fewer failures leave the device "degraded" with no incident.
- **One incident per device + fault:** this is enforced by the database through a unique open key. Repeated failures and replayed batches only update `lastCheckedAt`.
- **Correlation:**
  - When an NVR is unreachable, one *critical* incident covers every camera behind it.
  - Camera failures behind that NVR are folded into it.
  - Camera incidents already open are merged into it (closed with "merged into INC-…").
- **Severity:**
  - Recorder down or site network down = critical.
  - Recording failure, a silent agent, or a critical camera = high.
  - A normal camera, a stream problem, a disk warning, or an internet outage while monitoring continues = medium.
  - Stale cloud data = low.

**Silence and outages**
- **Stale telemetry:** when no heartbeat arrives for 10 min, the site's devices become **UNKNOWN (never "offline")** and one *agent offline* incident opens.
- **Internet outage while monitoring continues:**
  - The agent keeps monitoring and queues its events locally.
  - On reconnect, the queued events are applied in observed order, and duplicates are ignored.
  - The agent incident resolves after heartbeats with an empty queue.
  - The root cause is recorded automatically: *"Site internet outage: the local agent kept monitoring and synced N queued events"*, or *"the agent stopped reporting"* if nothing was queued.
  - An agent with a 4G backup can report "broadband down" directly. That opens an *internet outage* incident and the cameras keep being checked.

**Recording**
- Recording is checked only on devices whose recorder reports it (capability `recording`).
- A reachable camera is **never** shown as recording.
- Recording proof older than 2 h becomes "not confirmed".

**Restoration and recurrence**
- **Restoration:** an incident is resolved only after **3 consecutive fresh successful checks** after the failure.
- **"Fixed" from a technician or dashboard user:** moves the incident to RESTORATION_CHECK. It resolves immediately only if those checks already exist. A failure during the check resets the incident to its previous state.
- **Reopen:** the same fault within 30 min of resolution reopens the incident (`reopenCount`) instead of creating a duplicate.

**Incident states:** OPEN → ACKNOWLEDGED → ASSIGNED → IN_PROGRESS → RESTORATION_CHECK → RESOLVED → CLOSED. Closing requires RESOLVED.

## WhatsApp follow-up (dry-run by default)

1. **Alert.** The alert goes to the site's technician on shift, or to on-call people outside shifts. If no technician is available, it goes to the supervisor. Example: *"Camera CAM-014 at Chennai Warehouse has been unreachable for 5 minutes. Incident INC-1042 is open (medium). Please reply "ACK INC-1042"…"*
2. **Technician replies on WhatsApp.** The rules-only assistant understands English and Tanglish / Tamil words:
   - `ACK` / `ok` / `seri` / `paakuren` → acknowledged and assigned.
   - `HELP INC-…` → safe first checks. The assistant states that it cannot control devices remotely.
   - `reached site` → IN_PROGRESS.
   - `fixed INC-… <note>` → restoration check, with the note recorded as root cause.
   - `status` → the technician's open incidents.
   - A customer contact who messages gets a read-only status of their sites.
3. **Escalation.** If nobody acknowledges in 15 min, the incident goes to the supervisor (L1), then to the manager (L2) after 30 more minutes. Voice escalation is off by default; when enabled it is reported as needing provider verification, never faked.
4. **Restoration.** The technician gets: *"CAM-014 is responding again. Restoration … verified by 3 consecutive successful checks. Incident duration: 18 minutes."* Opted-in customers get a resolution summary.
5. **Delivery controls:**
   - Every message has an idempotency key and is rate-limited to 12 per incident per hour.
   - Transient failures retry with backoff.
   - Quiet hours (22:00–07:00 IST) defer non-critical alerts; critical alerts still reach on-call people.
   - Consent and opt-out are respected.
   - Cost is estimated per message at the configured rate.
   - Meta delivery receipts set the status to delivered, read or failed.

## Monitoring modes

- **Mode A, cloud:** TCP checks of explicitly configured `host:port` targets on cloud-mode sites ("Run cloud checks").
  - There is no scanning.
  - Private and loopback addresses are refused unless `MONITORING_ALLOW_PRIVATE_TARGETS=true`.
  - Demo sites are refused because their addresses are synthetic.
- **Mode B, local agent** (`apps/monitoring-agent/agent.mjs`, Node 20+, no dependencies):
  - Checks only the configured devices: TCP reachability, RTSP OPTIONS (no video is pulled), an optional vendor health URL, and the site gateway.
  - Uses an append-only JSONL queue and syncs oldest-first in batches.
  - Sends heartbeats with queue depth.
  - Verifies signed updates (Ed25519 manifest plus sha256).
  - Registering an agent shows its token **once**; it can be rotated or revoked.
  - Endpoints:
    - `POST /monitoring/agent/heartbeat`. A `sentAt` more than 10 min from server time is refused (replay protection).
    - `POST /monitoring/agent/events`. Up to 1000 events per batch, validated.
    - `GET /monitoring/agent/config`. Device list without credentials.
- **Mode C, outage resilience:** described above. Live WhatsApp is **not promised** when every path at the site is down; alerts wait on the agent until a path returns.

## Dashboard (web, `cctv` workspaces)

**Product families.** One login and one API serve both products. The workspace switcher groups the workspaces a user belongs to under **Tacksharp AI Agents** (the nine existing industries) and **Tacksharp VisionOps** (`cctv` workspaces), and the brand line follows the selected workspace. Access is per workspace (organization membership) plus the `monitoring.*` permissions, so VisionOps can be granted without the agent workspaces and the other way round. Existing routes are unchanged.

| Page | Shows |
|---|---|
| **Operations center** (`/`) | Status board: cameras online / offline / unknown, active incidents, not acknowledged, sites with an outage. A health tile per site, "Needs attention", service levels (uptime, mean time to acknowledge and restore), availability trend, incident trend, downtime by site, root causes, weekly response times. |
| **Incidents** | Filters, CSV export. Detail with timeline, WhatsApp previews, first checks, evidence, and actions (acknowledge / assign / start / mark fixed / close / note). |
| **Sites** | Schematic map placed by GPS (no map tiles), health filters, cards. Detail with recorders, agent heartbeat, contract, technicians, camera grid, incidents. |
| **Cameras & recorders** | Recorder strip; inventory with search, filters, sorting (most failed checks, longest without a successful check, code), last successful check and last checked, pagination, CSV. Camera detail with recent checks, what the monitoring can prove, maintenance mode. |
| **Technicians & agents** | Technicians (roles, shifts, on-call), local agents (register / rotate / revoke, generated config), customers / sites / devices setup, contracts. |
| **WhatsApp alerts** | Every message with status; simulated vs live counts; live cost. |
| **Uptime & SLA reports** | Date range, by customer (SLA breaches against contract targets), by site, incidents; CSV. |
| **Plans & cost** | Configurable plans (Basic ₹30, Service desk ₹45, SLA & AMC ₹60 per camera per month, all editable) and an operating-cost estimator. The estimator uses editable assumptions plus measured incidents per camera; the ₹30 price is **not** assumed to be profitable. |

Uptime counts camera-minutes. A recorder or network outage counts every affected camera. Time while an agent was silent is **unknown** and is excluded from the percentage, never counted as up.

## Demo data (`org_demo_cctv`, "Demo · SecureEye CCTV Services")

| | |
|---|---|
| Customers | 3: Chennai Warehousing (warehouse), FreshMart Supermarkets (retail), Lotus Multispeciality Clinic (hospital) |
| Sites | 5. Four use a local agent, one is cloud-checked |
| Recorders | 5 NVR/DVR (Hikvision, CP Plus, Dahua, Uniview; capabilities differ per model) |
| Cameras | 50 |
| Technicians | 8 (5 site technicians, 1 on-call, 1 supervisor, 1 manager) |
| Contracts | 4 (one expiring in 20 days) |
| Agents | 4, with 48 heartbeats |
| Health events | 128 |
| Incidents | 50: 40 resolved over 30 days plus 10 current (open, acknowledged, assigned, in progress, restoration check, resolved, reopened, merged) |
| Timeline events | 305 |
| WhatsApp previews | 173 (simulated) |
| Uptime snapshots | 150 |

**Current conditions shown in the demo:**
- CAM-014 offline while its NVR is reachable (in progress).
- FreshMart Anna Nagar NVR down (critical, 10 cameras).
- Sriperumbudur agent silent (devices unknown, escalated to the supervisor).
- FreshMart Velachery on 4G backup (internet outage), with a recording failure, a disk warning and an intermittent camera.

**Scenario runner** (Setup → Scenario runner): 9 scenarios run the real engine on a labelled "Scenario Lab" site. The lab is reset each run and excluded from fleet KPIs and reports.

1. End to end
2. Camera offline with the DVR reachable
3. Entire NVR offline
4. Internet outage with monitoring continuing
5. Agent disconnected, then replay
6. Intermittent camera (no false alarm)
7. Recording failure
8. Recovery, then recurrence (reopen)
9. Unacknowledged escalation

## Live data

**Production (real customers).** Data arrives only from real sources, in real time:
- **Local site agent** (`apps/monitoring-agent`, one per site): register it under *Technicians & agents* (the token is shown once), put the token and the site's camera / NVR addresses in its local `agent.config.json`, run it as a service. It sends a heartbeat and its checks every minute over HTTPS to `/monitoring/agent/*`; during an internet outage it keeps checking and queues locally, then replays in order.
- **Cloud checks** for cloud-mode sites: devices with `monitoringMethod = cloud_tcp` and a public `host:port` are probed every minute by the scheduler. Private / loopback targets are refused, including hostnames that resolve to them.
- The dashboard shows **Live / Delayed / No live data** from the newest heartbeat or check, refreshes every 10 s while data flows, and guides an empty workspace to agent setup.

**VisionOps scheduler** (every minute: live demo feed → cloud checks → sweep for silent agents, escalations and due alerts → hourly retention). It runs wherever `RUN_WORKERS` is on (the old home of the sweep). `VISIONOPS_SCHEDULER=true` turns it on in an API that keeps `RUN_WORKERS=false` (staging); `VISIONOPS_SCHEDULER=false` turns it off. With several API processes a Redis lock lets one of them run each minute. Alerts stay behind the existing gate: `DRY_RUN=true` simulates everything, and demo incidents are never sent whatever `DRY_RUN` says.

**Retention.** Raw health checks older than *Settings → Keep raw health checks* (default 90 days; demo workspaces 3 days) and heartbeats older than 30 days are deleted hourly in batches. Incidents, timelines, notifications and uptime history are kept.

**Live demo feed (demo workspaces only).** *Start live demo* on the Operations center plays the demo's site agents:
- **Each minute:** heartbeats plus camera, NVR, storage, stream, recording and internet checks, all sent through the same engine a real agent's calls reach.
- **New faults:** one appears now and then (camera, NVR, storage, stream, recording, internet with 4G backup, or an agent power cut with a local queue and replay).
- **Technician side:** a simulated technician answers on WhatsApp through the real technician assistant: `ACK`, then `reached site`, then `fixed <cause>`. One incident in five is acknowledged late, so escalation shows.
- **Repairs:** an incident resolves only after fresh successful checks. A supervisor closes it 20 minutes later (simulated).

Demo pace: acknowledgement in 1–4 minutes, repairs in 7–20 minutes. The feed refuses non-demo workspaces and non-demo devices, and only `POST /monitoring/live-demo` can switch it (a settings save cannot). `VISIONOPS_DEMO_FEED=off` disables it on a server.

## Deploy to staging

These steps were not run from here: the staging hosts are not reachable from the build workspace.

1. Record the current commit and `pm2 ls`. Back up the database: `mysqldump <staging_db> > backup-$(date +%F-%H%M).sql`.
2. Copy in the changed files over `apps/api`, `apps/web` and `apps/monitoring-agent`. Never overwrite `.env`.
3. **Apply the migration (approval required)** in `apps/api`: `npx prisma migrate status`, then `npx prisma migrate deploy`, then `npx prisma generate`. It applies `20261023000000_visionops`, which only creates tables.
4. Build: `npm run build` in `apps/api` and `apps/web`.
5. Optional, staging only:
   ```
   DEMO_SEED_CONFIRM=yes DEMO_SEED_DATABASE=<staging DB_NAME> DEMO_USER_PASSWORD='<12+ chars>' DEMO_GRANT_EMAILS='you@example.com' npm run seed:industry-demos
   ```
6. Restart only the verified staging processes:
   - Check them first with `pm2 describe <name>`: the API is on port 3103, the web on port 3102.
   - Then run `pm2 restart <staging-api> <staging-web>`. Never use `pm2 restart all`.
   - Keep `DRY_RUN=true` and `RUN_WORKERS=false`. Add `VISIONOPS_SCHEDULER=true` to the staging API's environment so monitoring and the live demo run every minute (alerts stay simulated).
7. Smoke test:
   - `https://platform-api.tacksharp.in/health`.
   - Log in, switch to "Demo · SecureEye CCTV Services", and check the Operations center, Incidents, Sites, Cameras and Reports.
   - Press **Start live demo**: within a minute the board shows **Live** and "Last data … s ago"; within a few minutes incidents move (acknowledged → in progress → restoration check → resolved).
   - Run the scenario runner.
   - Check that GR Chicken and the other workspaces are unchanged.

**Rollback:**
1. Restore the previous build and restart the two staging processes.
2. You can leave the new tables in place: the previous code never reads them.
3. A full revert means restoring the step-1 backup, which needs approval.

## Tests

- **API:** `test/visionops.integration.spec.ts` (17 tests), `test/visionops-agent.integration.spec.ts` (4 tests) and `test/visionops-live.integration.spec.ts` (8 tests: demo feed refuses real workspaces; ticks through the real engine; injected camera fault → ACK → fixed → verified, all simulated even with DRY_RUN=false; agent power cut → UNKNOWN + queue replay; 4G internet outage; feed off; retention; cloud-check DNS guard and scheduler switches). Together they cover:
  - the vertical slice, debounce, deduplication, folding and merging, reopen;
  - a silent agent followed by replay, the 4G internet outage, escalation timing, quiet hours;
  - capabilities, validation and scrubbing, agent auth and token rotation, tenant isolation;
  - concurrency (exactly one incident), uptime maths, cloud-check guard;
  - rules and permissions, the agent offline queue and resend duplicates, live TCP and RTSP checks, signed updates.
- **UI:** `apps/web/tests/ui-industries.py` covers the cctv menu, a status board matching the API, site tiles, every VisionOps page with data, a scenario-created incident acknowledged and "marked fixed" from the dashboard (it waits for evidence), no credentials in responses, and no overflow at 320–1280 px.
- **Run the API tests with no API server attached to the test database.** A running server's workers pick up the tests' follow-ups.

## Not verified / limitations (stated, not hidden)

- **No real camera, NVR or ONVIF device was available here.**
  - The agent's TCP and RTSP checks were tested against local test servers only.
  - Vendor recording and storage adapters (Hikvision ISAPI, Dahua, CP Plus) are **not implemented**: those capabilities come only from an adapter you add.
  - Without one, recording shows as "not verifiable".
- ONVIF discovery is not implemented. The agent checks only devices listed in its config, by design.
- **Live WhatsApp** needs `DRY_RUN=false`, an approved alert template for messages outside the 24-hour window, and approved test numbers. Delivery receipts are wired but not verified against Meta here.
- **Voice escalation** is off and needs Plivo / Sarvam verification. It is never simulated as a real call.
- **Signed agent updates:** verification is implemented; publishing, hosting and the installer are not.
- **The cloud cannot alert while the site has no internet path at all.** A local 4G backup on the agent is the supported way to alert during a broadband outage.
- **Competitor products** named in the brief (Tentosoft, Sieora, CheckCam, VisionX, Slinai) were **not reviewed**. The feature set follows the brief's list, so no claim of uniqueness is made.
- **Pricing:** ₹30 per camera per month is a configurable plan price. Profitability must be measured with the cost estimator's real inputs.
