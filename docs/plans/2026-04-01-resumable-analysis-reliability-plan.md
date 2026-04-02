# Resumable Analysis Reliability Plan (v2, post-review)

Date: 2026-04-01  
Status: Revised draft for external review  
Scope: Modal analysis resume behavior after provider/LLM failures

This v2 incorporates external review findings and adds concrete mechanisms for:

- rollback scope safety
- watchdog/manual resume race control
- billing invariants and post-processing race hardening
- clear UX flow for paused jobs

---

## 1) Problem Statement

The system is expected to continue from failure point. Current production behavior can appear as "restart from scratch" because partial results may be removed after fatal errors.

Observed incident shape:

- OpenRouter quota error (`HTTP 403`, `FATAL_LLM`)
- worker emitted `ANALYSES_ROLLBACK_OK` with large `deletedCount`
- rerun showed lower progress baseline despite earlier progress

---

## 2) Confirmed Findings

1. **Destructive rollback exists for non-benchmark worker exceptions** and causes progress loss.
2. **`forceRecalculate` is reusable across retries** unless explicitly consumed.
3. **Failure classification is heuristic-heavy** and not robust enough for policy routing.
4. **No same-job resume endpoint**; current retry actions often create new jobs.
5. **Watchdog does not classify by failure type** (only heartbeat-based logic today).
6. **Progress route is DB-backed for modal** and reflects persisted work.
7. **Hidden rollback-scope hazard:** current rollback helper operates on rows with `jobId IS NULL`; this is unsafe if future logic assumes run-level ownership for primary analysis rows.
8. **`totalCommits` drift risk** across retries is real and needs deterministic semantics.

---

## 3) Target Behavior

For resumable failures (especially quota), the system must:

1. Preserve successful `CommitAnalysis` rows.
2. Resume without reprocessing already persisted commits.
3. Keep billing strictly correct and idempotent.
4. Prevent duplicate modal triggers from watchdog/manual overlap.
5. Present explicit paused/resume UX.

---

## 4) Design Principles

1. **No destructive rollback for resumable failures.**
2. **Idempotent state transitions (`CAS`/conditional updates).**
3. **Single execution lease owner (`acquire_job` remains gatekeeper).**
4. **Billing invariants are non-negotiable.**
5. **MVP minimizes schema changes; hardening can add typed fields.**

---

## 5) Proposed Architecture Changes

## 5.1 Failure taxonomy

Normalize worker failures into:

- `TRANSIENT`
- `EXTERNAL_QUOTA`
- `CONFIG_FATAL`

Implementation rules:

- classify by structured status/code/payload where possible
- remove broad substring-only fatal logic
- emit explicit job event code for class (for watchdog policy in MVP)

## 5.2 Rollback semantics and row ownership

### MVP decision

- For **primary analysis jobs**, disable time-based rollback delete for `TRANSIENT` and `EXTERNAL_QUOTA`.
- Keep benchmark rollback isolated as-is.

### Safety note from review

Current rollback helper targets `jobId IS NULL` rows, which is unsafe for per-run ownership assumptions.  
Therefore in MVP, primary-analysis rollback is not used for resumable failures.

### Future hardening

If targeted rollback is still required later, introduce explicit run ownership for primary rows (typed field), then rollback by ownership key, not by timestamp + `jobId IS NULL`.

## 5.3 Resume semantics (same job, MVP scope)

MVP supports same-job resume for **quota pauses only**.

- no new `AnalysisJob` row
- no new reserve step
- preserve `llmConfigSnapshot` by default for deterministic continuation
- do not increment `retryCount` on manual resume (this counter remains reserved for watchdog auto-retries)
- track manual resume attempts via event code (`MANUAL_RESUME_REQUESTED` / `MANUAL_RESUME_ACCEPTED`) in MVP

Operational decisions:

- **creditsReserved:** reused, not recreated
- **scope drift:** resume must use original launch scope envelope (do not silently expand to fresh commits)
- **config drift:** default to original snapshot for resume; "fresh rerun" remains separate action
- **attempt accounting:** `retryCount` is watchdog-only; manual resume is event-tracked to avoid `maxRetries` blocking user-driven recovery

## 5.4 `forceRecalculate` one-shot

MVP choice: **field mutation**.

- apply delete once
- immediately clear/consume `forceRecalculate` for that job
- retries/resume of same job must not re-delete analyses

## 5.5 Watchdog policy by failure class

- auto-retry only `TRANSIENT`
- do not auto-retry `EXTERNAL_QUOTA`
- `CONFIG_FATAL` stays terminal

MVP can implement this via event code + existing status (no enum migration required).

## 5.6 Concrete concurrency guard (watchdog vs manual resume)

Use conditional updates and trigger-claim tokenization.

### Resume endpoint protocol

1. `UPDATE ... WHERE id=? AND status IN (eligible-paused-statuses)` to `PENDING`, clear lock/error fields.
2. If update count is `0` -> return conflict (already resumed or state changed).
3. Trigger modal through shared trigger helper that first claims trigger slot:
   - `UPDATE ... SET modalCallId='triggering:<uuid>' WHERE id=? AND status='PENDING' AND modalCallId IS NULL`
   - only claimant calls modal
   - replace placeholder with real `modalCallId` on success

### Watchdog protocol

Use the same trigger helper and the same claim condition; no direct blind trigger calls.

### Trigger placeholder TTL (non-blocking trigger safety)

The `modalCallId='triggering:<uuid>'` placeholder must not block future triggers forever.

MVP rule set:

1. If modal trigger call fails before real call ID is written, clear placeholder immediately (best effort).
2. Add watchdog cleanup for stale placeholders:
   - condition: `status='PENDING' AND modalCallId LIKE 'triggering:%' AND updatedAt < now() - TRIGGER_CLAIM_TTL_MS`
   - action: set `modalCallId = NULL`, emit `TRIGGER_PLACEHOLDER_CLEARED`.
3. Keep `TRIGGER_CLAIM_TTL_MS` conservative (for example 60-120s) and configurable.

## 5.7 `totalCommits` deterministic semantics

Define `totalCommits` as denominator for current active run plan, not cumulative across retries.

MVP requirement:

- reset/recompute deterministically at run acquisition
- avoid repeated additive increments for identical repo pass

## 5.8 Billing invariants and post-processing race hardening

Enforce and monitor these invariants:

1. `creditsConsumed <= creditsReserved`
2. `creditsConsumed + creditsReleased <= creditsReserved`
3. on terminal states: `creditsReserved - creditsConsumed - creditsReleased == 0`

Hardening actions:

- make post-processing debit step resumable without double debit risk
- persist debit progress atomically per batch checkpoint
- add reconciliation check/alert for invariant #3

## 5.9 UX flow (required for rollout)

### Order detail

- show explicit paused state for quota (`Paused: provider quota`)
- show action buttons:
  - `Resume same run` (same job)
  - `Fresh rerun` (new job, optional admin path)

### Orders list

- include paused badge/count so users can find blocked analyses

### User expectation copy

- `Resume` continues preserved progress
- `Fresh rerun` starts clean policy path

---

## 6) Phased Rollout

## Phase 0 - Instrumentation and policy lock

- add normalized failure-class event codes
- document rollback scope hazard and current safety assumptions
- define explicit UX copy and support runbook

Exit criteria:

- diagnostics shows failure class and pause reason
- agreed state mapping and support workflow
- approved status mapping table (Appendix A) for backend + UI

## Phase 1 - MVP (no broad schema migration)

Deliverables:

- robust failure classification in worker
- no rollback for `TRANSIENT`/`EXTERNAL_QUOTA` primary analysis
- same-job resume endpoint for quota
- one-shot `forceRecalculate`
- watchdog policy split via failure-class event codes
- concrete CAS-based trigger guard shared by watchdog and resume endpoint

Exit criteria:

- quota failure preserves partial analyses
- resume continues from preserved progress
- no duplicate trigger side effects
- no second reserve on same-job resume

## Phase 2 - Billing and counter hardening

Deliverables:

- deterministic `totalCommits` behavior on retries
- post-processing debit race hardening
- invariant checks + reconciliation alerts/cron
- terminal path audit for release guarantees (fail/cancel/resume branches)

Exit criteria:

- billing invariants hold across fail/resume/cancel
- counters stable under repeated retries/resumes

## Phase 3 - Optional typed schema hardening

Optional but recommended for maintainability:

- typed `failureClass`, `pausedAt`, `pauseReason` fields
- remove string-parsing dependency from watchdog logic

Exit criteria:

- watchdog policy uses typed fields only
- diagnostics and operations are simpler and less fragile

---

## 7) File-Level Change Map

- `packages/modal/worker.py`
  - structured failure classification
  - rollback gating by class
  - one-shot `forceRecalculate`
  - deterministic `totalCommits` handling entrypoint

- `packages/modal/db.py`
  - remove/contain unsafe primary-analysis rollback usage for resumable failures
  - helper updates needed by one-shot force logic
  - terminal bookkeeping hooks if required

- `packages/server/src/app/api/cron/analysis-watchdog/route.ts`
  - failure-class aware retry policy
  - shared trigger-claim protocol
  - post-processing debit checkpoint/race hardening

- `packages/server/src/app/api/orders/[id]/progress/route.ts`
  - preserve persisted-work-first progress semantics
  - expose paused reason fields needed by UI

- `packages/server/src/app/api/orders/[id]/jobs/[jobId]/resume/route.ts` (new)
  - same-job resume API

- `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`
  - paused/resume/fresh-rerun UX

---

## 8) Test Matrix (expanded)

### Unit/contract

- quota error -> `EXTERNAL_QUOTA`, no rollback
- transient error -> retryable, no rollback
- config fatal -> terminal policy path
- `forceRecalculate` applies once per job
- resume endpoint is idempotent (`UPDATE count`-based)
- trigger helper claims once under concurrent callers
- stale `triggering:*` placeholders are cleaned by TTL logic and do not block re-trigger

### Integration

- partial analysis + quota pause + same-job resume -> completes without redoing persisted commits
- watchdog trigger + manual resume race -> one effective trigger claim
- stale placeholder + re-trigger path -> claim becomes available after TTL cleanup
- `forceRecalculate` + resume -> no second delete
- progress API during resume shows persisted baseline (not reset to 0)
- resume after partial post-processing debit -> no double debit
- benchmark failure path remains isolated

### Billing integrity

- invariant checks #1/#2/#3 pass under:
  - normal completion
  - quota pause then resume
  - cancel from paused/running
  - terminal fatal

---

## 9) Risks and Mitigations

- **Duplicate modal invocation due to race**  
  Mitigation: shared trigger-claim protocol with conditional update.

- **Ambiguous user intent (resume vs rerun)**  
  Mitigation: explicit dual-action UX and user-facing copy.

- **MVP string/event coupling fragility**  
  Mitigation: strict event code contract now, typed schema in Phase 3.

- **Billing drift under repeated partial post-processing**  
  Mitigation: checkpointed debit progress + invariant reconciliation.

---

## 10) Review-Driven Decisions

1. **Enum expansion for quota in MVP:** not required.
2. **Partial data on config-fatal:** preserve by default unless proven unsafe.
3. **Same-job resume scope in MVP:** quota only.
4. **Runtime billing assertions:** enforce invariants #1/#2/#3 with alerting.
5. **`forceRecalculate` implementation in MVP:** field mutation (consume flag).

---

## 11) Success Criteria

Successful rollout means:

- quota failures do not erase already computed analysis progress
- resume continues from preserved work on same job
- no duplicate charge or stuck reservation after fail/resume/cancel
- watchdog/manual actions do not produce conflicting active runs
- support can diagnose and resolve paused jobs without DB forensics

---

## 12) Appendix A - MVP Status Mapping

| Job status | Order status | UI state | Primary user action |
|---|---|---|---|
| `RUNNING` | `PROCESSING` | Running | Wait / Cancel |
| `PENDING` (fresh launch) | `PROCESSING` | Launching | Wait |
| `FAILED_RETRYABLE` + non-quota class | `PROCESSING` or transient error surface | Retrying automatically | Wait |
| `FAILED_RETRYABLE` + `EXTERNAL_QUOTA` event code | `PROCESSING` (or mapped paused label) | Paused by provider quota | Resume same run / Fresh rerun |
| `FAILED_FATAL` (`CONFIG_FATAL`) | `FAILED` | Failed (action required) | Fix config, then rerun |
| `LLM_COMPLETE` | `PROCESSING` | Post-processing | Wait |
| `COMPLETED` | `COMPLETED` | Completed | View results |
| `CANCELLED` | `READY_FOR_ANALYSIS` or `COMPLETED` (if historical metrics exist) | Cancelled | Start new analysis |

Notes:

- In MVP, quota pause is identified by event/error classification, not a dedicated enum.
- If product decides to expose explicit order-level paused status later, move mapping to typed schema in Phase 3.

