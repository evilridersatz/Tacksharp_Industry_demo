# Tacksharp AI Office

A CEO agent turns an owner's instruction into a plan of tasks for specialist agents (Operations, Sales, Customer
Support, Reporting, QA; Finance, Marketing, HR and Research as switchable templates). A MySQL state machine, driven by
the `office-task` BullMQ queue, runs the tasks. **Models only propose** (a plan, tool calls, a final JSON); this code
decides every state change.

## Flow

1. `POST /office/plans` — the CEO returns a plan as JSON; `agents/planner.ts` validates it (roles, dependencies,
   loops) and always adds a final Reporting task. A cost estimate is attached (`engine/budget.ts`).
2. `POST /office/plans/:id/run` — the plan's tasks and dependencies are written in one transaction; tasks without
   dependencies are queued. (Autonomous mode starts within budget without this click.)
3. The worker claims a task (row update with a lease), checks the kill switches, deadline, plan budget and daily budget,
   then runs **one bounded step** (`agents/model-port.ts`): the agent sees only the tools its configuration allows.
4. Every tool call goes through `tools/registry.ts`: schema validation, per-task and per-minute limits, the approval
   policy (`tools/contract.ts → policyFor`), an idempotency key (task + tool + arguments) and an audit row.
   `send_whatsapp` always needs a person's approval (`MANDATORY_APPROVAL`), in every mode.
5. When the agent reports `done`, the task is **verified** (`engine/office-engine.service.ts → verify`): write tools'
   verifiers re-check the database; reports must trace every number to the snapshot or task results; other work goes
   to the QA agent. Unverifiable work ends in `needs_review`, never in `completed`.
6. Completing a task releases its dependents; when every task is finished the plan stores the report with the measured
   cost and the exceptions.

## Guarantees

| Rule | Where |
| --- | --- |
| Only the engine changes a task's status, through allowed transitions | `engine/task-state.ts`, `transition()` |
| Budgets (US$, tokens, steps, tool calls, deadline, daily US$) checked before each model call | `engine/budget.ts`, `planBudget()` |
| A retried task never repeats a write; a sensitive call with unknown outcome is never repeated | `OfficeToolCall` unique key, `running → unknown` |
| Worker crash → lease expires → task retried once, then dead-lettered | `sweep()`, `afterFailure()` |
| Messages: speech acts, hop cap per plan, delegation depth cap, no delegation back into the ancestry | `messaging/mailbox.ts` |
| Circuit breaker per agent: healthy → steering → constrained → stopped | `engine/breaker.ts` |
| Organization from the session only; every query scoped by `organizationId` | `office.controller.ts`, all services |
| Text from customers / documents wrapped as `<data>` and never put in system instructions | `tools/contract.ts → untrusted` |

## Business events

Existing products already announce changes on the live bus (`publishLive`). A tap (`engine/office.worker.ts`) records
some of them as versioned events (`order.created.v1`, `order.updated.v1`, `call.ended.v1`, `alert.raised.v1`) in
`OfficeEvent`; workflows subscribe by type and version. Products never call Office code.

## Credits

Several coordination ideas come from **Munder Difflin** (MIT, Copyright 2026 Chaitanya Giri,
https://github.com/HarnessMD/munder-difflin): speech-act messages with a hop counter, single-writer mailboxes, a
supervisor that adjudicates, the graduated circuit-breaker ladder and the secret broker. No code or art assets were
copied; the pixel-art tiles bundled with Munder Difflin are under a separate LimeZu licence and are not used here.
