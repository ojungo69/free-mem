# Data Model: Slice 1 Automatic Memory Runtime

## Canonical enums

### SensitivityV1

`eligible | local_only | private | secret`

Restriction is monotonic: `secret > private > local_only > eligible`. Missing, malformed,
ambiguous, or legacy-unknown sensitivity is `secret`. A payload/provider claim cannot weaken the
first-class value.

### Provider execution

- `wireProtocol`: `anthropic_messages_v1 | openai_chat_completions_v1`
- `executionLocation`: `local | remote`
- `egressPolicy`: `on_device | explicit_remote`
- `costClass`: `local_zero | external_metered`
- `tlsPolicy`: `system | not_applicable`
- `redirectPolicy`: literal `reject`

There is no unknown active provider state. An unresolved retrieval destination may be `unknown`, but
an unknown ProviderChoice is invalid and cannot activate.

## ProviderProposalV1

The only user/harness input accepted by the Slice 1 compiler. It is closed and contains no derived
policy fields.

| Field | Rule |
|---|---|
| `version` | Literal `1` |
| `role` | Literal `summary` |
| `state` | Literal `enabled` |
| `wireProtocol` | One of the two canonical protocols |
| `modelId` | 1-256 UTF-8 bytes, no ASCII control/NUL |
| `modelRevision` | 1-128 UTF-8 bytes, no ASCII control/NUL |
| `endpointUrl` | 1-2,048 ASCII bytes; complete canonical request URL; no runtime path suffix |
| `credentialRef` | One closed `CredentialRefV1` |

Unknown fields, provider registry names, provider kinds, arbitrary headers, inline credentials,
cookies, filesystem credential paths, self-declared location/policy/cost/TLS/redirect values, and
self-declared fingerprints are rejected.

### CredentialRefV1

```text
{ kind: "none" }
{ kind: "environment", name: <^[A-Za-z_][A-Za-z0-9_]{0,127}$> }
```

Only the named environment variable may be read for request authentication. Its value is never
stored, fingerprinted, logged, displayed, or inherited from an Agent/OpenCode subscription.

### Canonical endpoint rules

- Parse with the platform URL implementation and require the serialized URL to equal the proposal
  after the documented canonicalization pass.
- Require `http:` or `https:`, a non-empty hostname, a non-root API path, and no username, password,
  fragment, or query. The path is the complete protocol endpoint.
- `127.0.0.1` and `::1` are the only local host literals. `localhost`, localhost subdomains,
  trailing-dot hostnames, other loopback spellings, wildcard/unspecified addresses, and DNS names
  that might resolve to loopback are rejected rather than guessed.
- A local literal may use HTTP (`tlsPolicy=not_applicable`) or HTTPS (`tlsPolicy=system`). Every
  non-loopback host is remote and requires HTTPS with `tlsPolicy=system`.
- For remote or local HTTPS, `NODE_TLS_REJECT_UNAUTHORIZED=0` or an equivalent supported insecure
  global bypass rejects setup activation and daemon provider start. A normal additional CA trust path
  does not disable chain/hostname verification and remains valid for the isolated runner.
- Setup after confirmation and daemon start each perform a native credential/payload-free TLS
  chain+hostname handshake to the exact host/port/SNI within
  `providerTlsPreflightTimeoutMs=5,000`. Setup failure mutates nothing or restores prior state. A
  daemon-start failure preserves writer/RPC/capture/spool-import/lexical startup and disables only
  provider/AI processing as `provider_unavailable` or `provider_tls_rejected`; local HTTP skips the
  handshake.
- `redirectPolicy=reject` is compiler-derived and request code uses manual redirect handling; no 3xx
  `Location` is followed or replayed.

## ProviderChoiceV1

The compiler output is the proposal plus only derived fields:

| Field | Rule |
|---|---|
| proposal fields | Preserved exactly after canonical validation |
| `providerFingerprint` | Computed SHA-256 fingerprint below |
| `executionLocation` | Local only for literal `127.0.0.1`/`::1`, otherwise remote |
| `egressPolicy` | `on_device` for local, `explicit_remote` for remote |
| `costClass` | `local_zero` for local, `external_metered` for remote |
| `tlsPolicy` | `system` for HTTPS, `not_applicable` only for local HTTP |
| `redirectPolicy` | Literal `reject` |

Fingerprint input is the full ProviderChoice without `providerFingerprint`, encoded as JCS and
prefixed by `free-mem:provider-choice:v1\0`. The stored value is
`sha256:<64 lowercase hexadecimal characters>` and must recompute exactly.

The deterministic test stub is not a ProviderChoice kind. Harness metadata starts the stub and
materializes an ordinary ProviderProposalV1 with a complete endpoint URL and one supported wire
protocol.

### Frozen protocol behavior

`ResourceProfileV1` fingerprints request timeout 60,000 ms, input 12,000 characters, output 4,000
tokens, response 1,048,576 bytes, and temperature 0.2. Both protocols send one system prompt and one
user prompt and reject an oversized response before JSON parse.

- `anthropic_messages_v1`: `content-type: application/json`, fixed
  `anthropic-version: 2023-06-01`, and `x-api-key` only for an environment credential; request
  `{model,max_tokens,temperature,system,messages:[{role:"user",content}]}`; response text is the
  ordered concatenation of `content[]` text blocks.
- `openai_chat_completions_v1`: `content-type: application/json` and `authorization: Bearer` only for
  an environment credential; request
  `{model,max_tokens,temperature,messages:[{role:"system",content},{role:"user",content}]}`;
  response text is `choices[0].message.content`.

`credentialRef.kind=none` emits no authentication header. Redirects, streaming, Responses API,
tier routing, arbitrary headers, tool calls, and provider fallback are outside Slice 1. Every request
uses `AbortSignal.timeout(observerRequestTimeoutMs)`.

Input length is JavaScript UTF-16 code units. Reserve 3,000 of 12,000 units for user content: clip
system to 9,000 and call `toWellFormed()`, then clip user from the start to
`max(3,000, 12,000 - clippedSystem.length)` and call `toWellFormed()`. This allocation is identical
for both protocols.

### Closed Slice 1 fixture choices

- Base remote: `openai_chat_completions_v1`,
  `https://summary.stub.invalid/v1/chat/completions`,
  `{kind:"environment",name:"FREE_MEM_SUMMARY_API_KEY"}`; compiler derives remote,
  `external_metered`, `explicit_remote`, and system TLS.
- Local derivation: `openai_chat_completions_v1`,
  `http://127.0.0.1:1234/v1/chat/completions`, `{kind:"none"}`; compiler derives local,
  `local_zero`, `on_device`, and TLS not applicable.
- Repaired remote: one complete successor manifest using
  `https://summary-repaired.stub.invalid/v1/chat/completions`, the same wire protocol/environment
  credential form, its own computed provider/manifest fingerprints, and the base manifest
  fingerprint as predecessor. Validated-
  configuration, redirect-recovery, and HTTPS-downgrade-recovery signals all target these same
  computed fingerprints; free-form `summary-config-*-v2` labels are removed.

Runner-observed provider cost is 0 because the stub is runner-owned. That observation does not
change the remote ProviderChoice's compiler-derived `external_metered` cost class.

## EffectiveCapabilityManifestV1

Immutable non-secret state compiled and activated only by setup.

| Field | Rule |
|---|---|
| `manifestVersion` | Literal `1` |
| `manifestId` | 1-128 ASCII bytes matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` |
| `configurationFingerprint` | Computed manifest fingerprint; never accepted as input |
| `baseConfigurationFingerprint` | Prior active fingerprint for a successor; absent only initially |
| `destinationPolicyMap` | Closed Claude Code/Codex local/remote entries |
| `resourceProfile` | Exact `ResourceProfileV1` below |
| `summaryProvider` | One validated ProviderChoiceV1 |
| `embeddingProvider` | `{state:"disabled", reason:"slice1_semantic_not_owned", packDegradationReason:"semantic_disabled"}` |
| `legacyDispositions` | At most 64 unique keys matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, each with `translated | ignored | overridden`; no values |

Any detected legacy `conflict` belongs to the rejected compile result, not an active manifest.
Unknown fields are rejected. Secret values, content, prompts, memory text, arbitrary headers, and
absolute project paths are prohibited.

Manifest fingerprint input is the full manifest after the provider fingerprint is populated but
without `configurationFingerprint`, encoded as JCS and prefixed by
`free-mem:effective-capability-manifest:v1\0`. The stored value is
`sha256:<64 lowercase hexadecimal characters>` and must recompute exactly.

### Storage and activation

```text
control/capabilities/
├── manifests/<configurationFingerprint>.json  # owner-only immutable generation
├── current                                     # atomic fingerprint pointer
├── last-good                                   # prior doctor-verified fingerprint
├── lifecycle.lock                              # shared setup/daemon start exclusion
└── activation-receipt.json                     # content-free next-start signal import
```

Setup compiles and displays a proposal before mutation. After confirmation it writes the immutable
generation, then publishes the current pointer and all selected Claude/Codex editor files as one
recoverable transaction using the existing snapshot/atomic-replace mechanism. An unreferenced
generation may remain after rollback; it has no authority. `last-good` changes only after a daemon
has started from and doctor has verified the new fingerprint.

The transaction first acquires the shared lifecycle lock, rechecks daemon writer/socket/health state
while held, then acquires the existing setup/spool owner lock for its full duration. Daemon start
acquires the same lifecycle lock before journal/manifest resolution and writer-lock acquisition and
releases it only after startup state is published. No path acquires the lifecycle lock after a
writer or spool lock. This fixed order removes the preflight-to-activation race.

The transaction uses one owner-only `control/capabilities/setup-transaction.json` journal. It stores
phase, intended fingerprint, target paths/hashes, and mode-0600 prestate bytes needed by the existing
snapshot restore; those bytes never enter manifest/log/evidence. Order is: journal prepared+fsynced,
editor files, immutable generation, `current` pointer last, then journal commit/removal. Same-process
failure restores in reverse. On next setup/start, a matching fully published state is finalized;
otherwise prestate is restored. Daemon provider startup rejects an unresolved/unrecoverable journal.

A running daemon blocks the first manual activation path before any mutation. Full coordinated
stop/activate/start or attach behavior is a later increment.

At daemon start:

- no `current` pointer: explicit capture-only restricted mode; no ObserverClient or RawEventSweeper;
- malformed pointer, missing generation, digest mismatch, invalid JSON/shape, or failed validation:
  startup failure before provider construction;
- valid pointer: freeze one in-memory generation and pass the same object/fingerprints to every
  doctor/status projection and later provider, scheduler, maintenance, viewer, job, and destination
  resolver. Until v21 jobs plus the complete DestinationBoundary delivery exist, runtime reports
  `pending_privacy_boundary` and keeps provider calls, AI maintenance, and RawEventSweeper disabled.

No runtime consumer rereads provider/resource env or legacy config.

## ResourceProfileV1

The one profile retains the accepted fixture envelope and closes values already used by production
RawEventSweeper/flush behavior.

| Field | Fixed value |
|---|---:|
| `profileId` | `slice1-short-run` |
| `version` | `1` (base) |
| `captureConcurrencyLimit` | 2 |
| `processingConcurrencyLimit` | 2 |
| `processingQueueCapacity` | 25 |
| `processingRetryLimit` | 3 |
| `maxMemoryItemsPerDerivation` | 16 |
| `maxSourceEventsPerJob` | 100 |
| `observerRequestTimeoutMs` | 60,000 |
| `providerTlsPreflightTimeoutMs` | 5,000 |
| `observerMaxInputChars` | 12,000 |
| `observerMaxOutputTokens` | 4,000 |
| `observerMaxResponseBytes` | 1,048,576 |
| `observerTemperature` | 0.2 |
| `workerWarmLifetimeMs` | 30,000 |
| `periodicSweepIntervalMs` | 30,000 |
| `idleFlushMs` | 120,000 |
| `eventDebounceMs` | 1,000 |
| `stuckClaimTimeoutMs` | 300,000 |
| `rawEventRetentionEnabled` | `false` |
| `rawEventRetentionMs` | 0 |
| `maxSteadyProductProcessCount` | 3 |
| `maxShortRunRssGrowthMiB` | 32 |
| `maxPendingQueueDepth` | 20 |
| `maxStorageGrowthBytes` | 1,048,576 |
| `selectionTimeBudgetMs` | 750 |
| `admittedCandidateLimit` | 32 |
| `maxRenderedBytes` | 16,384 |
| `maxSelectedItems` | 8 |
| `maxInjectedTokens` | 800 |
| `exactSessionLaneMax` | 4 |
| `lexicalLaneMax` | 8 |
| `semanticLaneMax` | 0 |
| `recencyLaneMax` | 2 |

The vertical manifest delivery compiles the provider transport and removes mutable scheduler reads,
but keeps provider calls, AI maintenance, and RawEventSweeper execution disabled as
`pending_privacy_boundary`. Schema-backed processing concurrency, capacity, retry, derivation, and
atomic completion become enforceable with the following v21 job delivery. The privacy PR then starts
the Sweeper/provider and enforces periodic/idle/debounce/stuck/source-count/retention plus Injection
Pack limits. No earlier PR claims readiness. Mutable legacy values for every field are reported as
ignored/translated/overridden and are never a fallback.

Enforcement ownership is exhaustive:

| Delivery | Fields first truthfully enforced |
|---|---|
| PR 1 | closed shape/freeze only; execution fields report pending |
| PR 2 | capture/processing concurrency, queue capacity, retry limit, max derivation count, max source events, claim timeout/recovery, retention disabled and retained-job purge safety |
| PR 3 | provider warm lifetime, periodic/idle/debounce scheduling, pack selection/candidate/render/item/token/lane limits |
| PR 6 | process count, RSS, pending-depth, and storage-growth warning thresholds as measured runner gates |

`captureConcurrencyLimit=2` is a non-blocking admission limit: at most two direct capture mutations
run concurrently and excess hook clients use the existing bounded atomic spool within their current
hard deadline. `processingConcurrencyLimit=2` is an upper bound on simultaneously claimed summary
jobs; a deployment may run one, never more than two.

### Closed output-limit recovery successor

The accepted fixture already includes one changed configuration for output overflow. Its test-only
fault contract permits exactly one successor shape: `profileId=slice1-short-run`, `version=2`, every
field byte-for-byte equal to version 1 except `maxMemoryItemsPerDerivation=17`, and a manifest
otherwise identical to the base remote destination/provider/embedding/legacy configuration with
`baseConfigurationFingerprint` equal to the active version-1 manifest. Production setup exposes no
resource-profile selector and always compiles version 1/max16. The runner may materialize the full
test successor; no other resource mutation/profile ID validates. It creates new manifest/attempt
fingerprints but never rewrites admission profile, retry limit, source range, or lifetime attempt
count.

## RepositoryIdentityV1

Repository authority is a domain-separated digest, not a display label:

```text
repo-v1:sha256:<64 lowercase hexadecimal characters>
```

Resolution uses the active local filesystem:

1. Run bounded, non-shell Git probes for the supplied cwd: `rev-parse --show-toplevel`,
   `rev-parse --path-format=absolute --git-common-dir`, and `remote get-url origin`. The probed root/
   common dir must exist and realpath successfully; caller-supplied remote text is ignored.
2. If `origin` is an HTTPS URL, `ssh://` URL, or SCP-like SSH URL, reject credentials other than an
   SSH username, lowercase the DNS host, drop only the protocol's default port, normalize repeated/
   trailing path separators, remove exactly one trailing `.git`, and form
   `remote:<host[:nondefault-port]>/<path>`. Thus supported HTTPS and SSH spellings of the same host/
   path share an identity. Invalid, file, credential-bearing HTTPS, empty-path, or unsupported remote
   forms do not become authority. Hash
   `free-mem:repository-remote:v1\0<canonical-remote>`.
3. If no supported verified `origin` exists, resolve the real Git common directory (the primary Git
   anchor for linked worktrees) from the successful probe and hash
   `free-mem:repository-anchor:v1\0<realpathed-common-dir>`.
4. If Git probes fail or neither identity source can be verified, repository identity is NULL/unknown.

All probes share one 100 ms wall-clock budget and one 8 KiB stdout/stderr cap and do not use a shell.
Successful or fallback identity is cached once per realpathed working-tree root for the daemon lifetime; the
persisted event/session identity remains stable for admitted jobs. A failed/timed-out remote probe
falls back to the already-realpathed common-dir anchor when available, otherwise unknown. Probes do
not log the raw
remote/path. A remote may still be unreachable; "verified" here means read from the current Git
repository rather than trusted from an event/request claim.

`project`, basename, cwd spelling, caller `workspaceKey`, and CLI/MCP project filters remain display
or query metadata. They never authorize private/local-only disclosure. A linked worktree and its
primary checkout share the remote identity, or the realpathed primary-anchor fallback.

## CapturedEvent persistence

`raw_events` gains:

| Field | Rule |
|---|---|
| `sensitivity` | Checked canonical enum; missing/invalid trusted write normalizes to `secret` |
| `repository_identity` | RepositoryIdentityV1 or NULL/unknown |
| `capture_manifest_fingerprint` | Active manifest at acceptance, or NULL in capture-only mode |
| `capture_state` | `accepted | quarantined` |
| `safe_error_code` | Bounded content-free code; required for quarantine |
| `payload_digest_version` | Literal `event-payload-digest-v1` |
| `payload_digest` | SHA-256 of domain plus JCS redacted canonical payload |

Existing source, stream, event ID, sequence, timestamps, and redacted payload remain. Payload fields
never override first-class columns.

Redaction failure persists a quarantined row with `sensitivity=secret`, empty payload, safe ordering
metadata, and `safe_error_code=redaction_degraded`. It survives restart and is never job/provider/
retrieval input.

Capture conversion is:

```text
redaction degraded or secret -> secret
private                      -> private
local_only                   -> local_only
otherwise                    -> eligible
```

The daemon computes repository identity from the actual cwd/Git state. Caller `projectKey` is not
authority.

### EventIdentityConflictV1

The canonical identity is repository identity plus source/stream/event ID. First acceptance stores
`payload_digest=sha256("free-mem:event-payload-digest:v1\0" || JCS(redacted canonical payload))`.
Same identity and digest is an idempotent duplicate. Same identity with a different digest never
overwrites the canonical row or returns a normal ACK; one durable conflict row/receipt records both
digests, reason `event_identity_payload_conflict`, non-success state, canonical-unchanged=true, and
memory delta 0. Replays reuse that receipt. Conflict records are content-free and inherit repository
identity/manifest provenance.

## RawEventFlushBatch as MemoryProcessingJobV1

The existing `raw_event_flush_batches` row remains the only summary job for one immutable
source/stream/sequence range. No second queue or generic job framework is added.

### Fields

| Field | Purpose |
|---|---|
| source range and extractor fields | Immutable admission source identity |
| `status` | Canonical state below |
| `admission_manifest_fingerprint` | Immutable manifest at admission; required new, NULL only for legacy unknown |
| `admission_provider_fingerprint` | Immutable provider at admission; required new, NULL only for legacy unknown |
| `retry_limit` | Automatic attempt limit frozen at admission (3) |
| `attempt_count` | Lifetime successful-claim count; monotonic, never reset |
| `claim_generation` | Monotonic stale-worker fence |
| `attempt_manifest_fingerprint` | Manifest selected for the current claim |
| `attempt_provider_fingerprint` | Provider selected for the current claim |
| `attempt_fingerprint` | Computed identity for the current claim |
| `resume_grant_id`, `resume_grant_reason` | One-shot grant identity/reason |
| `resume_grant_state`, `resume_grant_consumed_at` | `none | pending | consumed` plus consumption evidence |
| `last_resume_signal_id`, `last_resume_sequence` | Signal identity and monotonic replay fence |
| `last_resume_signal_disposition` | `accepted | duplicate | stale | wrong_role | wrong_provider | unchanged_configuration | unrelated_component` |
| `safe_error_code` | Bounded content-free failure code |
| `egress_diagnostic_json` | Version/action/reason/counts only |
| `output_count`, `observed_output_count` | Atomic derivation-limit evidence |
| `completion_disposition` | `none | memory_committed | privacy_skip | legacy_unrecoverable` |
| `legacy_recovery_state` | `not_legacy | complete_range | missing_or_ambiguous_range` |
| `frontier_already_advanced` | Marks exact legacy recovery that must not lower/advance twice |

### States and capacity

```text
queued -> processing -> completed
                    -> failed -> queued               (automatic budget remains)
                    -> retry_exhausted                 (automatic budget exhausted)
retry_exhausted -> queued                              (one valid grant)
processing -> completed                                (atomic privacy skip)
processing -> failed                                   (stale-claim recovery)
```

SQLite persistence uses `retry_exhausted`; the existing public fixture/result spelling remains
`retry-exhausted` and is a deterministic projection, not a second state.

Capacity 25 counts `queued`, `processing`, `failed`, and `retry_exhausted`. Capture persists before
admission. When full, later accepted source events remain durably not admitted and visible; no job or
event is displaced. Completed rows do not consume admission capacity.

At most 100 contiguous source events enter one job. Remaining events stay behind the same session
frontier for later admission.

New admission requires the first sequence to equal `frontier + 1` and every selected sequence to be
contiguous. A gap creates no job, does not move the frontier, and reports content-free `source_gap`;
it is not bridged by a later event.

### Claim and attempt identity

A claim transaction:

1. requires `queued` and either `attempt_count < retry_limit` or an unconsumed one-shot grant;
2. consumes the grant when present;
3. increments `attempt_count` and `claim_generation` exactly once;
4. copies the active manifest/provider fingerprints into the attempt fields;
5. computes `attempt_fingerprint` from domain
   `free-mem:processing-attempt:v1\0` plus job ID, immutable source range, new attempt count, claim
   generation, and attempt manifest/provider fingerprints;
6. enters `processing` atomically.

Changed valid configuration changes only the attempt fields/fingerprint. Admission fingerprints,
source range, retry limit, and prior attempt count remain unchanged. A resumed attempt that fails
returns directly to `retry_exhausted`; another timer attempt is not inferred from a changed limit.

Migration never backfills a legacy admission fingerprint from the currently active manifest. Legacy
uncompleted rows with complete sources retain NULL admission provenance, preserve attempt count, enter
`retry_exhausted`, and require one valid grant whose current fingerprints populate only attempt
fields. Safe projections render NULL admission as `legacy_unknown`, not a fabricated digest.

### ResumeSignalV1

One signal has unique ID, monotonic sequence, target role `summary`, target provider fingerprint,
target manifest fingerprint, and one reason:

- `validated_configuration_activation` (must change manifest or provider fingerprint);
- `recorded_provider_healthy_transition` (daemon-recorded unhealthy→healthy edge);
- `user_confirmed_doctor_retry`.

A valid signal creates one pending grant. Duplicate/out-of-order, wrong-role, wrong-provider,
unrelated-component, or unchanged invalid configuration signals are durable content-free no-ops.
The grant is consumed by at most one claim. Timer passage never creates a grant.

The only producers are durable and component-specific:

1. Setup writes a content-free activation receipt with monotonic activation sequence under the
   lifecycle lock; the next v21 daemon imports it through the sole writer and records one idempotent
   `validated_configuration_activation` signal keyed by receipt ID and fingerprints.
2. Observer health is persisted per manifest/provider; only a committed unhealthy-to-healthy edge
   emits one `recorded_provider_healthy_transition`. Repeated probes are no-ops.
3. An explicit user-confirmed doctor retry RPC/CLI command emits one
   `user_confirmed_doctor_retry` after showing the target component/job and fingerprints.

Sequence allocation, receipt import, signal insert, and grant creation are crash-idempotent. Setup
never opens the canonical database directly.

Every accepted signal, including changed configuration, has `grantCount=1`; it never resets or
refills a three-attempt budget. After claim, the grant count is 0. Success completes; failure returns
to retry-exhausted and requires another distinct valid signal.

The fixture's malformed-response configuration activation plus redirect and downgrade recovery all
use the one repaired-remote successor's computed manifest/provider fingerprints. Healthy-transition
and user-confirmed retry target the computed active base fingerprints. Output-limit recovery targets
the computed test-only version-2 manifest fingerprint without changing admission provenance.

Each recovery case has one exact signal kind/producer mapping. Accepted evidence requires
`signal.sequence=lastConsumedSequence`, automatic `budgetBefore=0`, `budgetAfterGrant=1`,
`budgetAfterAttempt=0`, and `ignoredSignalCount=0`; swapped kinds or stale sequence fields are no-ops.

### Completion transactions

**Memory completion** validates job status, claim generation/fingerprint, exact projected source
set/citations, output limit, lineage/revision/dedup/supersession invariants, and sensitivity. One
transaction commits every memory and reference, marks the job completed, and advances the
contiguous `last_flushed_event_seq` once. Any failure commits none of these.

**Privacy skip** validates the same active claim and exact all-ineligible source set. One transaction
stores a content-free diagnostic, marks completed, and advances the frontier once with zero provider
request and zero memory output.

A completed privacy skip is terminal for that admitted source range. Later configuration activation
does not silently reopen it; a separately specified user-authorized replay contract would be needed
and is outside Slice 1.

`last_flushed_event_seq` is never attempt state. Failed/retry-exhausted work retains sources and does
not move it.

### Legacy `gave_up`

Migration never lowers a session frontier. For each legacy `gave_up` row:

- if every exact source sequence still exists and the range is unambiguous, migrate to
  `retry_exhausted`, `legacy_recovery_state=complete_range`, and
  `frontier_already_advanced=true`; an explicit grant may recover memory without moving the frontier;
- otherwise mark `status=completed`, `completion_disposition=legacy_unrecoverable`, retain a
  content-free `missing_or_ambiguous_range` diagnostic, set
  `legacy_recovery_state=missing_or_ambiguous_range`, and create no grant. It consumes no capacity
  and is never projected as successful recovery.

No synthetic source, blind cursor rewind, or range spanning missing events is allowed.

## Raw-event retention

Slice 1 fixes `rawEventRetentionEnabled=false` and `rawEventRetentionMs=0`, so automatic purge does
nothing. The storage method must nevertheless encode the future safety precondition: a non-zero
policy deletes only sequences at/below the committed session frontier and excludes every sequence
referenced by an uncompleted job (`queued`, `processing`, `failed`, or `retry_exhausted`). Accepted
not-yet-admitted rows above the frontier are never purgeable. A profile cannot enable retention until
that test passes.

## EgressDiagnosticV1

Payload-free fixed shape stored on the processing job.

| Field | Values |
|---|---|
| `version` | `1` |
| `action` | `sent | projected | skipped | failed | exhausted` |
| `reason` | Closed bounded reason code |
| `destination` | `local | remote | unknown` |
| counts | considered/transmitted plus count per sensitivity; no IDs |
| `configurationFingerprint` | Safe manifest identity |
| `providerFingerprint` | Safe provider identity |
| `attemptFingerprint` | Safe attempt identity when claimed |

It contains no event/memory ID, source text, title, path, prompt, query, request/response excerpt,
sentinel, credential value, or restricted preview. Actual request/byte evidence comes from the
runner-owned stub/network boundary.

The closed `reason` values are:

```text
eligible_only | restricted_projected | all_restricted | destination_unknown |
repository_unknown | repository_mismatch | redaction_degraded |
provider_unavailable | provider_redirect_rejected | provider_tls_rejected |
provider_auth_failed | output_invalid | output_limit_exceeded |
retry_exhausted | stale_claim | missing_or_ambiguous_range | source_gap
```

The closed safe next-action values are:

```text
none | activate_valid_manifest | configure_credential | wait_for_capacity |
confirm_retry | restart_daemon | upgrade_runtime
```

## MemoryItem Slice 1 fields

`memory_items` gains:

| Field | Rule |
|---|---|
| `sensitivity` | Strongest contributing source; monotonic |
| `repository_identity` | Exact shared identity of cited sources; unknown/mixed is ineligible |
| `lineage_id` | Deterministic logical-fact identity including repository identity |
| `revision_id` | Deterministic content/profile/model revision identity |
| `revision_ordinal` | Monotonic within lineage |
| `supersedes_memory_id` | Prior same-repository revision when present |
| `derivation_key` | Deterministic retry/dedup identity |
| `source_event_ids_json` | Bounded ordered cited IDs from the projected set |
| `source_spans_json` | Bounded source anchors from the projected set |
| `manifest_fingerprint` | Attempt manifest that produced the revision |
| `provider_fingerprint` | Attempt provider that produced the revision |
| `attempt_fingerprint` | Processing attempt that committed the revision |

The fixed fixture adds `summary`, `failed_approach`, and `next_action` while retaining existing
compatible kinds.

Derivation rules:

1. Provider input contains only destination-eligible source events.
2. Provider output cites no more than the job's 100 projected event IDs/spans.
3. Each item inherits the strongest cited sensitivity and one exact repository identity.
4. Unknown/out-of-set citations, mixed repository identities, partial parse, or output count above
   the active attempt manifest's `maxMemoryItemsPerDerivation` reject the whole result.
5. Dedup/supersession is limited to the same repository identity, uses the stronger sensitivity, and
   never reactivates a tombstone. Unknown identity cannot merge into a known repository item.

## DestinationBoundaryV1

One closed trusted value is required before any content-bearing read or provider input:

| Field | Rule |
|---|---|
| `version` | Literal `1` |
| `consumer` | `summary_provider | hook_pack | daemon_get | daemon_search | daemon_pack | mcp_direct | mcp_index | viewer | maintenance | export | import | dedup` |
| `targetAgent` | `claude-code | codex | none` |
| `targetModel` | 1-256 UTF-8 byte model ID or NULL when not applicable |
| `executionLocation` | `local | remote | unknown` from frozen manifest/request context |
| `repositoryIdentity` | Verified RepositoryIdentityV1 or NULL |
| `configurationFingerprint` | Frozen daemon manifest fingerprint |
| `providerFingerprint` | Required for provider/maintenance; otherwise NULL |

The boundary is internal and cannot be created from a user project/basename filter. One pure
eligibility function and its SQL predicate apply the decision table before any row content is
materialized. This is a narrow privacy seam, not a generic policy engine.

Claude Code, Codex, and MCP always resolve to remote/unknown in Slice 1 production. Their local
process, Agent/model label, project, or RPC payload is not authority over model egress, and setup
creates no on-device Agent attestation. The `*-local` destination classes remain runner-owned
fixtures and can be selected only after the candidate-inaccessible runner verifies its loopback
consumer and binds that observation to the result; otherwise local selection is impossible.

| Destination | eligible | local_only | private | secret |
|---|---:|---:|---:|---:|
| remote or unknown | allow | deny | deny | deny |
| local + exact known repository | allow | allow | allow | deny |
| local + cross/unknown repository | allow | deny | deny | deny |

For local summary/maintenance, the boundary repository is the known source repository for the
current projected group. For hook/MCP/export/dedup, it is the verified destination/current
repository. Viewer has no repository authority in Slice 1 unless the daemon supplies a verified
identity, so its unknown boundary returns eligible content only.

Before local provider prompt construction, candidate events are stably partitioned by exact verified
repository identity. A mixed or unknown group is rejected content-free before projection; post-output
citation checks are defense in depth, not the repository-isolation boundary.

The seam covers:

- provider flush and `maintenance/ai-structured` before prompt construction, plus maintenance
  memory-role pack/report reads;
- search, recent, timeline, explain, `findByFile`, and `findByConcept` SQL candidates;
- daemon get/search/pack and MCP full-body/index/recent/timeline/explain/pack reads;
- viewer raw-event/status/usage and memory/observation/summary/prompt/artifact/safe-session
  projections;
- lexical/semantic candidates, final pack rendering, and traces;
- export serialization and import normalization;
- dedup/supersession identity matching.

The currently public extraction-replay and distill barrel exports have no production caller and are
removed. Their internal benchmark code remains test-only; any future public/runtime exposure must
accept the same DestinationBoundary before reading raw/memory rows or constructing an Observer
prompt.

## InjectionPack Slice 1 projection

The existing pack adds manifest/destination identity, semantic-disabled degradation, exact final
bytes/tokens/items, provenance, source lane, and terminal reasons.

Eligibility is resolved before title/body/preview formatting, token/byte measurement, ledger
exposure, or trace construction. A restricted omission contributes only aggregate reason/lane/
sensitivity counts and `omitted_ineligible`; it emits no ID, title, body, preview, query, path, or
source citation. Eligible injected items keep visible source and selection reasons.

Semantic candidates are rehydrated from first-class database columns and pass the same eligibility
function. `semantic_disabled` prevents use, not storage deletion.

## Export, import, backup, and diagnostics

- Schema v21 gives `user_prompts`, legacy `session_summaries`, and content-bearing `artifacts`
  first-class `sensitivity` and `repository_identity`, and gives `sessions` a canonical
  `repository_identity`. Unknown legacy values backfill to secret/unknown. Current observer summaries
  stored as memory items keep normal MemoryItem fields.
- Export requires a DestinationBoundary and emits payload version 2.0. It applies eligibility to
  every `memory_items`, `user_prompts`, and legacy `session_summaries` row before serialization.
  Restricted rows require a verified same-repository local boundary; unknown/all-project export
  includes eligible rows only.
- Exported `sessions` are referential shells for already-eligible child rows. They may contain stable
  import key, timestamps, safe display project, and repository digest, but omit `cwd`, `git_remote`,
  `git_branch`, `user`, and free-form `metadata_json`. A session with no eligible child is absent.
- Import v2 preserves and validates first-class sensitivity/repository/provenance without downgrade.
  Missing/malformed fields become `secret`/NULL. Legacy v1 content rows always import as
  `secret`/NULL regardless of project/remap labels; caller `--remap-project` remains display metadata
  and cannot authorize disclosure.
- Backup/restore preserves all first-class fields and job/source ranges because it is local durable
  state, not a disclosure surface.
- Logs, status, doctor, job records, and maintenance messages use codes/counts only. Existing
  content-excerpt warnings are removed.

## Fixed short-run plateau

The runner executes 12 identical duplicate/no-op workload windows with a complete drain and SQLite
checkpoint after each window. Windows 1-2 are warm-up; windows 3-12 must stay within every absolute
ResourceProfile ceiling. Across the final five windows (8-12), product process count is constant,
pending queue depth is zero after every drain, selected item/token counts are identical, RSS span is
at most 16 MiB, and storage span is at most 65,536 bytes. Processing concurrency never exceeds 2 and
post-teardown orphan process count is zero. Any missing sample or equality above a ceiling fails.

## Closed runner evidence additions

The accepted result and runner-evidence schemas require all 12 raw window records. Each carries
ordinal, process count, RSS MiB, drained queue depth, storage bytes, selected-item count,
injected-token count, max processing concurrency, and a completed drain/checkpoint receipt.
Remote-stub cases also carry the base/repaired hostnames, hostname-valid public CA SHA-256
fingerprint, normal chain/hostname-validation booleans, and `privateKeyCommitted=false`.

The suite contains one same-event-ID/different-payload-digest probe whose durable conflict count is
exactly one and no overwrite occurs, plus exactly 16 positive scenario observations and one
late-injection-after-model-dispatch negative. Result-observation and runner-bundle fingerprints bind
all these fields.

## Migration v20 -> v21

1. Verify a backup through the existing migration gate.
2. Begin one database transaction.
3. Add every Slice 1 column/check/index for events, memory items, user prompts, legacy session
   summaries, content-bearing artifacts, session repository identity, jobs, provenance, and diagnostics.
4. Backfill current content-bearing records conservatively: only trusted structural evidence may retain a known
   sensitivity/repository; otherwise sensitivity is `secret` and repository identity NULL.
5. Translate legacy job states, including exact `gave_up` range audit, without lowering any frontier.
6. Validate closed enums, fingerprints, source-range completeness, provenance, and references.
7. Update schema compatibility marker and `user_version` to 21.
8. Commit; on any error roll back all changes and start no provider or sweeper.

Fresh databases receive final v21 DDL directly. The generated test schema is regenerated from the
same source. Export/import and backup/restore tests prove field preservation and restrictive legacy
defaults.
