# Contract: Slice 1 Processing Job v1

## Ownership and admission

The existing `raw_event_flush_batches` row is the only durable summary-processing job for its
immutable source/stream/sequence range. No second queue or generic job framework exists.

Capture persists before admission. One job contains at most 100 contiguous source events. Capacity
25 counts every uncompleted job (`queued`, `processing`, `failed`, and `retry_exhausted`). At
capacity, later accepted events remain durably and visibly not admitted; no event or existing job is
evicted.

Admission starts exactly at `frontier + 1` and rejects any non-contiguous selected range as
content-free `source_gap` without creating a job or advancing the frontier.

Admission freezes `admission_manifest_fingerprint`, `admission_provider_fingerprint`, source range,
and `retry_limit=3`. These fields never change, including after configuration activation or resume.
They are required for new jobs; NULL is allowed only as honest legacy-unknown admission provenance
and is never backfilled from the current manifest.

## State machine

```text
queued -> processing -> completed
                    -> failed -> queued       (automatic budget remains)
                    -> retry_exhausted
retry_exhausted -> queued                     (one validated grant)
processing -> completed                       (atomic privacy skip)
processing -> failed                          (stale-claim recovery)
```

The database spelling is `retry_exhausted`; public fixture/status evidence projects it as the
existing `retry-exhausted` string.

Timer scheduling may retry `failed` only while the automatic budget remains. `retry_exhausted`
never transitions because time passed.

## Claims, attempts, and stale workers

A claim transaction requires `queued` plus either remaining automatic budget or one unconsumed
resume grant. It consumes the grant when present, increments monotonic lifetime `attempt_count` and
`claim_generation`, copies the active attempt manifest/provider fingerprints, computes a new
`attempt_fingerprint`, and enters `processing` atomically.

The fingerprint domain is `free-mem:processing-attempt:v1\0`; inputs are job ID, immutable source
range, new attempt count, claim generation, attempt manifest fingerprint, and attempt provider
fingerprint. A completion with a stale claim generation or fingerprint commits nothing.

A changed configuration changes only the attempt fields/fingerprint. It never resets attempt count,
rewrites admission provenance, widens the source range, or silently adopts a new retry budget. A
resumed attempt that fails returns directly to `retry_exhausted` and needs another explicit grant.
The runner-owned closed output-limit recovery fault successor may change the attempt derivation limit
from 16 to 17; production setup does not expose it and admission profile/limit remains unchanged.

## ResumeSignalV1

A per-job signal has a unique ID, producer receipt ID, exact target job ID, monotonic per-job
sequence, target role `summary`, target provider fingerprint, target manifest fingerprint, and
exactly one `kind`:

- `validated_configuration_activation` (manifest/provider fingerprint must change);
- `recorded_provider_healthy_transition` (daemon-recorded unhealthy to healthy edge);
- `user_confirmed_doctor_retry`.

A valid signal creates one grant with `state=pending` only when no grant is already pending. `(job_id, producer_receipt_id)` and
`(job_id, signal_id)` are unique. The claim changes the grant to `consumed`, records
consumption time, and increments the attempt in the same transaction. Duplicate/out-of-order,
wrong-job, wrong-role, wrong-provider, unrelated-component, unchanged invalid configuration, and already-
consumed signals update only the closed last-signal disposition as durable content-free no-ops and
consume no attempt.

An otherwise-valid signal received while a grant is pending returns `grant_pending` without
inserting/consuming a signal or producer receipt and without changing sequence, grant, or attempt.
The durable producer may retry after the existing grant is consumed and its attempt terminates; no
second slot, overwrite, or hidden queue exists.

Only three durable producers exist:

- the v21 daemon imports one setup activation receipt written under the lifecycle lock and emits one
  idempotent `validated_configuration_activation` signal per matching retry-exhausted job;
- a persisted provider state edge from unhealthy to healthy emits one
  `recorded_provider_healthy_transition`; repeated probes do nothing;
- an explicit user-confirmed doctor retry RPC/CLI action emits one `user_confirmed_doctor_retry`
  for exactly the displayed job after displaying its component and fingerprints.

Setup/health receipts are global producer events; one sole-writer transaction fans each out to at
most the capacity-25 matching job set. Job state, `resume_grant_state != pending`, target role/provider/manifest, and
`incoming.sequence > preLastConsumedResumeSequence` are one CAS. Accepted signals alone set
`postLastConsumedResumeSequence=incoming.sequence` and create a grant; sequence gaps are allowed,
while equal/stale values are no-ops. Receipt IDs and unique job bindings fence crash replay. Setup never
opens the canonical database.

Changed configuration also grants exactly one claim; it does not refill the automatic retry limit.
Any fixture/result field representing budget-after-grant is therefore 1 and becomes 0 after claim.

Configuration activation, redirect recovery, and HTTPS-downgrade recovery use the one complete
repaired-remote successor's computed manifest/provider fingerprints. Healthy transition and user
retry use the computed active-base fingerprints; output-limit recovery uses the computed test-only
v2 manifest/provider binding. Free-form configuration labels are not signal authority.

Fixture and runtime evidence maps each case to its exact producer kind and target job; the kinds are not an
unordered interchangeable set. `observedTransition.lastConsumedSequence` is the post-transition
value. Every accepted transition requires `preLastConsumedSequence < signal.sequence`,
`observedTransition.lastConsumedSequence=signal.sequence`, automatic `budgetBefore=0`, `budgetAfterGrant=1`,
and `budgetAfterAttempt=0` for the consumed signal. `ignoredSignalCount=0` is required only when the
case delivers no ignored signals; an aggregate case may count stale/duplicate signals alongside one
accepted transition. Any consumed-signal mismatch is a durable no-op, not a grant.

## Atomic terminal transitions

**Memory completion** validates the live claim, exact projected source set/citations, output count,
repository identity, sensitivity, lineage, dedup/supersession, and attempt provenance. One database
transaction commits every memory/reference/index source record and completes the job. It advances
the contiguous event frontier exactly once only when `frontier_already_advanced=false`; a recovered
legacy `gave_up` range leaves it unchanged. Crash or validation failure commits none.

**Privacy skip** validates the live claim and exact all-ineligible projection. One database
transaction stores a content-free diagnostic and completes the job. It advances the frontier exactly
once only when `frontier_already_advanced=false`, with zero provider request and zero memory output.

The completed privacy skip is terminal for that source range. Configuration change does not reopen
it; a later explicit user-authorized replay contract is outside Slice 1.

Failure, retry exhaustion, output overflow, partial parse, out-of-set citation, and stale claim retain
source events and do not advance the frontier.

## Source retention

Slice 1 fixes raw-event retention disabled/0. A future non-zero policy is invalid unless purge
deletes only at/below the committed frontier, excludes every source sequence referenced by any
uncompleted job including retry-exhausted work, and never deletes accepted not-yet-admitted backlog.
Backup/restore and export/import preserve job and source provenance as defined by their boundaries.

## Legacy `gave_up`

Migration never rewinds `last_flushed_event_seq`.

- Exact complete retained range: migrate to `retry_exhausted`, mark
  `legacy_recovery_state=complete_range` and `frontier_already_advanced=true`; explicit recovery may
  commit memory but never advances the frontier again.
- Missing, non-contiguous, overlapping, or ambiguous range: mark completed with
  `completion_disposition=legacy_unrecoverable`, retain a content-free
  `missing_or_ambiguous_range` diagnostic, and create no grant. It consumes no capacity and is never
  reported as successful recovery.

No synthetic event, blind session rewind, or replay across missing ranges is permitted.

Other legacy uncompleted rows with complete sources preserve attempt count, use NULL
`legacy_unknown` admission fingerprints, migrate to retry-exhausted, and require one valid grant. The
grant populates attempt provenance only.

## Diagnostics

Job/status/doctor output contains only bounded state, reason code, counts, safe fingerprints, attempt
count, claim generation, grant state, capacity, and one closed next action (`none`,
`activate_valid_manifest`, `configure_credential`, `wait_for_capacity`, `confirm_retry`,
`restart_daemon`, or `upgrade_runtime`). It contains no event/memory content,
title, path, prompt, query, source excerpt, provider response, sentinel, or credential value.
This `nextAction` field is separate from fixture-only `expectedOperationalStatus.safeAction`; the
fixture field is an operational oracle with its own value set, not this seven-value enum.
