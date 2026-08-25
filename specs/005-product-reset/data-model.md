# Data Model: Lightweight Automatic Memory Product Reset

This is the product-level model shared by the later focused implementation slices. M0 introduces
no persisted runtime schema.

## AgentSession

Represents one observed Claude Code or Codex work period.

- `sessionId`: stable local identity
- `agent`: Claude Code or Codex
- `repositoryScope`: authenticated local repository identity
- `startedAt`, `lastActivityAt`, `endedAt`: lifecycle timestamps
- `captureState`: active, pending, complete, or degraded
- `effectiveManifestId`: configuration used for this session

Relationships: owns captured events; may produce summaries and durable memory items; may consume
multiple injection packs.

## CapturedEvent

An ordered, idempotent record of supported Agent activity.

- `eventId`: stable delivery identity
- `sessionId`: owning session
- `agentSequence`: source order when available
- `kind`: `prompt`, `tool_activity`, `tool_result`, `assistant_message`, or `session_boundary`
- `repositoryScope`: scope resolved at capture
- `sensitivity`: local-only, private, or eligible for configured processing
- `redactedPayload`: canonical content retained for asynchronous processing after reserved, private,
  and secret spans are removed
- `payloadDigest`: digest of the canonical `redactedPayload` without exposing its content
- `deliveryState`: accepted, spooled, processing, committed, failed, retry-exhausted, or quarantined
- `failureReason`: bounded machine-readable reason when not committed
- `attemptCount`, `retryBudgetRemaining`: persisted retry accounting
- `lastResumeSignal`: `validated_configuration_activation`,
  `recorded_provider_healthy_transition`, or `user_confirmed_doctor_retry`, plus stable signal
  identity, target component, and relevant configuration fingerprint; absent before the first resume
- `lastConsumedResumeSequence`: monotonic per-component sequence persisted outside bounded history
- `transitionHistory`: bounded ordered entries containing from/to state, timestamp, reason, retry
  budget before/after, and resume signal

Uniqueness: the same `eventId` in one scope produces at most one committed effect.

State transitions:

```text
accepted -> processing -> committed
accepted -> spooled -> processing -> committed
processing -> failed -> processing
failed -> retry-exhausted
retry-exhausted -> processing
accepted|processing -> quarantined
```

`retryBudgetRemaining` counts attempts that may still be started and is decremented atomically
before each attempt. `retry-exhausted` never resumes on a timer alone. Replenishment and
`lastConsumedResumeSequence` advance in one compare-and-swap; a duplicate or out-of-order signal is
a no-op even after bounded history rotates. Validated configuration activation replenishes the
budget once to the relevant newly active manifest limit. A daemon-recorded healthy transition or
user-confirmed doctor retry grants exactly one attempt, capped by that limit. CapturedEvent accepts
only signals targeted to its delivery/storage component; provider-only signals are no-ops.
`attemptCount` remains monotonic. Every transition records the signal identity, target, reason, and
retry budget before and after the transition. Retry fields survive every delivery-state transition
and are visible to doctor.

If redaction cannot produce a safe `redactedPayload`, the event is quarantined without persisting
the raw payload. Local-only content may remain only in the redacted payload and remains governed by
its sensitivity boundary.

CapturedEvent retry state applies only to event delivery/commit. Summary and embedding provider
retries use `MemoryProcessingJob`; a committed event remains committed while a derived job is
retry-exhausted.

Captured event kinds never use derived memory kinds. The conversion contract is:

- `prompt` and `session_boundary` may produce `summary`;
- `tool_activity` may produce `change`;
- `tool_result` may produce `discovery` or `failed_approach`;
- `assistant_message` may produce `decision` or `next_action`.

The fixed fixture's `kindContract` is the machine-readable mirror of this mapping.

## MemoryProcessingJob

Represents asynchronous summary or embedding work over already committed events/memories.

- `jobId`, `role`: summary or embedding
- `sourceEventIds`, `sourceMemoryIds`
- `state`: queued, processing, completed, failed, retry-exhausted, or quarantined
- `attemptCount`, `retryBudgetRemaining`, `lastFailureReason`
- `lastResumeSignal`, `lastConsumedResumeSequence`, and bounded `transitionHistory` using the same
  resume mechanics as CapturedEvent
- `providerChoiceId`, `effectiveManifestId`

A provider failure changes the job state, never the committed source event. `retry-exhausted` uses
the same durable one-time resume and budget mechanics as CapturedEvent, but a signal applies only
when its role, `providerChoiceId`, and relevant configuration fingerprint match the failed job;
unrelated summary/embedding activations and health transitions are no-ops. Timer-only resume is
prohibited.

## MemoryItem

A durable reusable output derived from one or more captured events.

- `memoryId`: stable local identity of this stored item
- `lineageId`: deterministic identity shared by every revision of one derived fact, computed from
  repository scope, ordered source event identities, memory kind, and a canonical model-independent
  source anchor; output-array ordinals are forbidden as anchors
- `revisionId`: stable identity of this content revision
- `revisionOrdinal`: monotonically increasing ordinal within one memory lineage
- `supersedesMemoryId`: prior MemoryItem replaced by this revision, when applicable
- `derivationKey`: deterministic identity derived from `lineageId`, processing profile, and summary
  model generation
- `kind`: `summary`, `decision`, `discovery`, `change`, `failed_approach`, or `next_action`
- `title`, `body`: human-inspectable content
- `sourceSessionIds`, `sourceEventIds`: provenance
- `repositoryScope`: retrieval boundary
- `sensitivity`: egress and injection boundary
- `createdAt`, `supersededAt`, `deletedAt`: lifecycle
- `processingProfile`: effective summary configuration
- `lexicalState`, `semanticState`: ready, pending, degraded, stale, or unavailable
- `semanticGenerationId`: generation that owns the active vector for this item, when present

Deletion is terminal for retrieval and injection. It records a permanent durable tombstone for the
`lineageId`; reprocessing retained sources under any profile or model generation cannot create an
active revision for that lineage. Sibling outputs with different lineage identities are unaffected.
Superseded items remain auditable but are ineligible for normal selection.

Retrying the same source events under the same processing profile and model generation reuses the
same derivation key and converges on one MemoryItem per lineage. Reprocessing under a different
profile or model-generation key may create a new revision only in the same lineage and by recording
the prior item as superseded; it never silently mutates the old derived content or bypasses a
lineage tombstone.

## ResourceProfile

A small user-facing operating envelope independent of provider choice.

- `profileId`, `version`
- capture and processing concurrency
- queue and retry limits
- worker warm-lifetime policy
- retrieval time, byte, item, and token budgets
- storage and resource warning thresholds

Profiles are immutable once published; changing behavior creates a new version.

## ProviderChoice

The independently selected summary or embedding execution method.

- `role`: summary or embedding
- `state`: enabled or disabled
- `providerKind`: built-in local, compatible local endpoint, or explicit remote endpoint
- `modelId`, `modelRevision`
- `endpointHost`, `credentialSource`
- `redirectPolicy`: `reject` for the Technical Alpha
- `executionLocation`: local or remote
- `costClass`, `egressPolicy`
- `capabilities`: supported operation and output shape
- `validationState`: unvalidated, valid, invalid, or degraded

Secret values are referenced, never included in this entity's diagnostics or fingerprint.
When `state` is disabled, provider/model/endpoint/credential fields are absent and a bounded
machine-readable disabled reason is required. Disabled is never encoded as an empty model or
unreachable endpoint.

## SemanticIndexGeneration

The authoritative provenance and lifecycle for one compatible vector space.

- `generationId`
- embedding provider, model identity, model revision, dimensions, and preprocessing profile
- immutable build-set boundary and catch-up watermark
- per-item pending, ready, failed, and deleted ledger state
- generation state: building, validating, active, stale, failed, or retired

A MemoryItem vector is ready only when its `semanticGenerationId` equals the active compatible
generation. Provider, model, revision, dimension, or preprocessing changes create a new generation;
vectors from an older generation never become ready in the new vector space by implication.

## EffectiveCapabilityManifest

The single validated result consumed by setup, runtime, and doctor.

- `manifestVersion`, `manifestId`
- selected `ResourceProfile`
- summary and embedding `ProviderChoice` snapshots
- supported Agent and platform capabilities
- effective limits and disabled capabilities
- destination-policy map keyed by supported Agent/model destination class, including execution
  location and egress policy
- explicit degradation or fallback reasons
- non-secret configuration fingerprint

Activation is atomic: proposed -> validated -> active. Invalid proposals never replace the active
manifest.

## RetrievalCandidate

A normalized candidate offered to the context compiler.

- `memoryId`, `lineageId`, `revisionId`, `revisionOrdinal`
- `sourceLane`: `exact_session`, `lexical`, `semantic`, or `recency`
- normalized relevance score and stable tie-break fields
- estimated bytes and tokens
- scope, sensitivity, and lifecycle eligibility
- semantic-index state when applicable

`RetrievalCandidate` revision fields copy the authoritative MemoryItem revision fields. Pack
selection keeps only the active revision of each lineage, deduplicates repeated candidates for that
revision, and uses `revisionOrdinal` only for stable ordering. `derivationKey` controls idempotent
creation and is never substituted for revision ordering.

## InjectionPack

The bounded, versioned product output rendered for Claude Code or Codex.

- `packVersion`, `packId`
- target Agent/model destination class, resolved destination policy, session, repository scope, and
  manifest identity
- ordered selected memories and rendered sections, each bound to its MemoryItem `revisionId`
- total bytes, tokens, and elapsed selection time
- selection trace with destination-policy decision, `sourceLane`, and inclusion or omission reasons
- degraded capabilities and fallback reasons

The same normalized pack must render equivalent facts for both Agents even when their hook output
formats differ.

## OperationalStatus

A secret-free snapshot used by doctor and inspection surfaces.

- component: capture, spool, summary, lexical, semantic, injection, backup, or provider
- state: healthy, degraded, failed, disabled, or pending
- reason, since, pending count, last success
- safe user action
- effective manifest identity

Healthy status requires a relevant end-to-end probe; process existence alone is insufficient.
