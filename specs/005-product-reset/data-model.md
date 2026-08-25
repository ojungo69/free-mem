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
- `payloadDigest`: identity material without exposing secret content
- `deliveryState`: accepted, spooled, processing, committed, failed, retry-exhausted, or quarantined
- `failureReason`: bounded machine-readable reason when not committed
- `attemptCount`, `retryBudgetRemaining`: persisted retry accounting
- `lastResumeSignal`: `validated_configuration_activation`,
  `recorded_provider_healthy_transition`, `user_confirmed_doctor_retry`, or absent
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

`retry-exhausted` never resumes on a timer alone. The only legal resume signals are an explicitly
validated provider/configuration activation, a successful provider-health transition recorded by
the daemon, or a user-confirmed retry from doctor. Every transition records the reason and retry
budget; poisoned work cannot loop automatically after exhaustion. Retry fields and transition
history survive every delivery-state transition and are visible to doctor.

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
- `lastResumeSignal` and bounded `transitionHistory` using the same machine values as CapturedEvent
- `providerChoiceId`, `effectiveManifestId`

A provider failure changes the job state, never the committed source event. `retry-exhausted`
resumes only after validated configuration activation, a daemon-recorded healthy provider
transition, or user-confirmed doctor retry; timer-only resume is prohibited.

## MemoryItem

A durable reusable output derived from one or more captured events.

- `memoryId`: stable local identity
- `revisionId`: stable identity of this content revision
- `revisionOrdinal`: monotonically increasing ordinal within one memory lineage
- `supersedesMemoryId`: prior MemoryItem replaced by this revision, when applicable
- `derivationKey`: deterministic identity derived from the ordered source event identities, memory
  kind, processing profile, and summary model generation
- `kind`: summary, decision, discovery, change, failed approach, or next action
- `title`, `body`: human-inspectable content
- `sourceSessionIds`, `sourceEventIds`: provenance
- `repositoryScope`: retrieval boundary
- `sensitivity`: egress and injection boundary
- `createdAt`, `supersededAt`, `deletedAt`: lifecycle
- `processingProfile`: effective summary configuration
- `lexicalState`, `semanticState`: ready, pending, degraded, stale, or unavailable
- `semanticGenerationId`: generation that owns the active vector for this item, when present

Deletion is terminal for retrieval and injection. Superseded items remain auditable but lose normal
selection priority.

Retrying the same source events under the same processing profile and model generation reuses the
same derivation key and converges on one MemoryItem. Reprocessing under a different key may create a
new item only by recording the prior item as superseded; it never silently mutates the old derived
content.

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

- `memoryId`, `revisionId`, `revisionOrdinal`
- source lane: exact session, lexical, semantic, or recency
- normalized relevance score and stable tie-break fields
- estimated bytes and tokens
- scope, sensitivity, and lifecycle eligibility
- semantic-index state when applicable

`RetrievalCandidate` revision fields copy the authoritative MemoryItem revision fields. Pack
deduplication and tie-breaking use `revisionId` and `revisionOrdinal`; `derivationKey` controls
idempotent creation and is never substituted for revision ordering.

## InjectionPack

The bounded, versioned product output rendered for Claude Code or Codex.

- `packVersion`, `packId`
- target Agent, session, repository scope, and manifest identity
- ordered selected memories and rendered sections, each bound to its MemoryItem `revisionId`
- total bytes, tokens, and elapsed selection time
- selection trace with inclusion and omission reasons
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
