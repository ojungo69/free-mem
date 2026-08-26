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
- `sensitivity`: `eligible`, `local_only`, `private`, or `secret`
- `redactedPayload`: canonical content retained for asynchronous processing after reserved, private,
  and secret spans are removed
- `payloadDigest`: `SHA-256(UTF-8("free-mem:event-payload-digest:v1\0") ||
  JCS(redactedPayload))`, without exposing its content
- `payloadDigestVersion`: immutable `event-payload-digest-v1` for the initial Alpha
- `deliveryState`: accepted, spooled, processing, committed, failed, retry-exhausted, or quarantined
- `failureReason`: bounded machine-readable reason when not committed
- `attemptCount`, `retryBudgetRemaining`: persisted retry accounting
- `lastResumeSignal`: `validated_configuration_activation`,
  `recorded_provider_healthy_transition`, or `user_confirmed_doctor_retry`, plus stable signal
  identity, target component, and relevant configuration fingerprint; absent before the first resume
- `lastConsumedResumeSequence`: monotonic per-component sequence persisted outside bounded history
- `transitionHistory`: bounded ordered entries containing from/to state, timestamp, reason, retry
  budget before/after, and resume signal

Uniqueness: `(repositoryScope, eventId)` is permanently bound to the first accepted
`payloadDigest`. Replay with the same digest is idempotent and produces at most one committed
effect. A different digest for that identity creates or reuses a durable `EventIdentityConflict`,
returns its explicit conflict receipt, and quarantines only the incoming delivery with
`event_identity_payload_conflict`; it is never a normal ACK or silent discard. The canonical event,
payload, and state remain unchanged. Digest comparison occurs after deterministic redaction and
canonical encoding; the conflicting raw payload is never persisted. Retrying the same conflicting
digest returns the same non-success receipt. The conflict record and terminal incoming-delivery
quarantine commit atomically before that receipt is returned. A sender converges by replaying the
canonical digest or uses a new event identity for corrected content; neither doctor nor a retry
replaces canonical bytes.

Spool and retry records carry `redactedPayload`, `payloadDigest`, and `payloadDigestVersion` from
first acceptance. They never recompute an old event with the current algorithm. When a same-ID
delivery arrives under a newer algorithm, conflict comparison canonicalizes it with the stored
event version first; a version change alone cannot produce a conflict. A real conflict record stores
the canonical version and both digests computed under that version.

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

Captured event kind is transport provenance and a processing trigger, not a semantic classifier.
Summary processing derives any valid MemoryItem kind from the aggregate redacted content when the
fact is supported by source evidence. A decision, failed approach, or next action is not discarded
merely because it appeared in a different transport kind.

## EventIdentityConflict

A durable, payload-free record proving that one scoped event identity arrived with different
post-redaction content.

- `conflictId`: deterministic receipt identity for scope, event ID, digest version, and the two
  digests
- `repositoryScope`, `eventId`, `payloadDigestVersion`, `canonicalPayloadDigest`,
  `conflictingPayloadDigest`
- `state`: quarantined
- `reason`: `event_identity_payload_conflict`
- `firstSeenAt`, `lastSeenAt`, `occurrenceCount`

It stores no raw or redacted payload. The record is idempotent for repeated conflicting delivery
and remains visible after the canonical event commits.

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
when its role and `providerChoiceId` match the failed job. Provider-health and doctor signals also
require the failed job's configuration fingerprint. A `validated_configuration_activation` instead
requires the same role/provider target plus the newly active, validated, changed fingerprint; the
transition atomically rebinds the job to that manifest. Unrelated summary/embedding activations and
health transitions are no-ops. Timer-only resume is prohibited.

A summary result containing more items than the active ResourceProfile's
`maxMemoryItemsPerDerivation` enters `retry-exhausted` atomically with
`memory_output_limit_exceeded` and zero remaining budget. No partial derived batch is committed;
source events and previously committed sibling lineages remain intact. Only activation of a changed,
validated profile with a larger limit or a repaired provider may rebind and requeue the job; health
and doctor signals under the unchanged limit are no-ops. Its payload-free failure metadata is
limited to error code, `jobId`, source event IDs, observed result count, and configured limit; raw
provider output, copied source content, and uncommitted derived items are forbidden.

Redirect rejection immediately records `provider_redirect_rejected` and leaves the job
`retry-exhausted` without following or retaining authority from the old `Location`. Only activation
of a changed, validated configuration fingerprint for the matching provider can requeue it; a
health transition under the unchanged redirecting configuration is a no-op.

## MemoryItem

A durable reusable output derived from one or more captured events.

- `memoryId`: stable local identity of this stored item
- `lineageId`: deterministic identity shared by every revision of one derived fact, computed from
  a versioned domain separator, repository scope, and a canonical model-independent source-fact
  anchor. The anchor contains only the minimal supporting evidence set as sorted unique event IDs
  and exact source byte spans. Fact wording, sibling-set membership, processing-batch membership,
  model output order, profile, model generation, and memory kind are forbidden as lineage inputs
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

Derived sensitivity is the most restrictive contributing source disposition in this order:
`secret > private > local_only > eligible`. Secret-bearing output is prohibited after redaction;
`private` and `local_only` never downgrade during summarization, revision, indexing, or retrieval.
Both dispositions are eligible only for same-repository on-device processing and InjectionPack
destinations; neither may reach a remote/off-host provider or renderer, even after private spans are
removed.

Deletion is terminal for retrieval and injection. It records a permanent durable tombstone for the
`lineageId`; reprocessing retained sources under any profile or model generation cannot create an
active revision for that lineage, including when a later model reclassifies the fact's `kind`.
Sibling facts with different source-fact anchors are unaffected. Superseded items remain auditable
but are ineligible for normal selection.

The persisted SourceFactAnchor registry resolves reprocessing before lineage creation. An exact
span match reuses its anchor. For the same source events, a proposed span that overlaps, contains,
or is contained by a deleted anchor is suppressed by that tombstone even when its boundaries or
semantic kind differ. Ambiguous overlap with a non-deleted anchor is quarantined for inspection;
only disjoint minimal spans may establish a new sibling anchor automatically. This conservative
coverage prevents boundary drift from bypassing deletion.

Retrying the same source events under the same processing profile and model generation reuses the
same derivation key and converges on one MemoryItem per lineage. Reprocessing under a different
profile or model-generation key may create a new revision only in the same lineage and by recording
the prior item as superseded; it never silently mutates the old derived content or bypasses a
lineage tombstone.

Each derived fact must cite a distinct minimal source span. Multiple outputs claiming the same
anchor, or an output without a stable span, quarantine the provider result rather than creating an
ordinal-based lineage.
The source-fact anchor and `lineageId` are established before semantic-kind classification.

### Lineage v1 canonicalization

`lineageId` is:

```text
SHA-256(
  UTF-8("free-mem:memory-lineage:v1\0") ||
  JCS({ repositoryScope, sourceSpans })
)
```

- `repositoryScope` is the authenticated canonical repository identity.
- `sourceSpans` is deduplicated and sorted lexicographically by `eventId`, then numerically by
  `startByte`, then `endByte`.
- Span coordinates are half-open `[startByte, endByte)` offsets into the canonical
  `redactedPayload` UTF-8 bytes.
- `startByte` and `endByte` MUST fall on UTF-8 scalar boundaries; a span that starts or ends on a
  continuation byte is invalid and quarantines the provider result.
- Profile, model generation, processing batch, fact wording, and semantic kind are absent from the
  digest input.

Fixed vectors:

| Scope and normalized spans | Expected SHA-256 |
|---|---|
| `repo-primary`; `event-a:[0,10)` | `ca6ec88cc0156199c5e08e50393dcf4ef473f62c1e0e5372e99d9d791499779f` |
| same anchor with only profile/model/kind changed | `ca6ec88cc0156199c5e08e50393dcf4ef473f62c1e0e5372e99d9d791499779f` |
| `repo-primary`; `event-a:[0,11)` | `ad0ffa99555520b5a1524908a4d08661b3054b0f0f8a1a66e08a8f2a98904378` |
| `repo-primary`; unsorted input normalized to `event-a:[0,10)`, `event-b:[4,9)` | `23274e7fbe3af129f9942e312eec51dfdc6b6825e3e38583d068254e96e2d447` |

An algorithm change creates a new versioned lineage namespace. Migration preserves all old
`(version, lineageId)` tombstones and may add an alias only after verifying the same canonical source
spans; it never silently recomputes or drops a deletion tombstone.

## ResourceProfile

A small user-facing operating envelope independent of provider choice.

- `profileId`, `version`
- capture and processing concurrency
- queue and retry limits
- exact `maxMemoryItemsPerDerivation`
- worker warm-lifetime policy
- complete InjectionPack envelope: selection time, admitted-candidate, final byte, selected-item, and
  token limits plus per-lane minimum/maximum item budgets
- storage and resource warning thresholds

Profiles are immutable once published; changing behavior creates a new version.

## ProviderChoice

The independently selected summary or embedding execution method.

- `role`: summary or embedding
- `state`: enabled or disabled
- `providerKind`: built-in local, compatible local endpoint, or explicit remote endpoint
- `modelId`, `modelRevision`
- `endpointScheme`, `endpointHost`, `credentialSource`
- `tlsCertificateValidation`: required for every remote/off-host provider
- `redirectPolicy`: `reject` for the Technical Alpha
- `executionLocation`: local or remote
- `costClass`, `egressPolicy`
- `capabilities`: supported operation and output shape
- `validationState`: unvalidated, valid, invalid, or degraded

Secret values are referenced, never included in this entity's diagnostics or fingerprint.
When `state` is disabled, provider/model/endpoint/credential fields are absent and a bounded
machine-readable disabled reason is required. Disabled is never encoded as an empty model or
unreachable endpoint.
Every remote/off-host request requires `https` on the initial connection and normal certificate
chain and hostname verification, regardless of credential use. Plain HTTP, disabled verification,
and HTTPS-to-HTTP redirect are rejected before any credentials or payload bytes are sent.

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
- provisional estimated bytes and tokens used only for candidate selection
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
- exact final-rendered bytes, destination-token count, input-candidate count, traced-candidate count,
  deadline-unprocessed count, admitted-candidate count, selected-item count, and elapsed selection
  time
- selection trace binding each candidate to its provenance, destination-policy decision,
  `sourceLane`, and exactly one terminal reason from the InjectionPack contract enumeration
- degraded capabilities and fallback reasons

The same normalized pack must render equivalent facts for both Agents even when their hook output
formats differ.

## RunnerEvidenceBundle

A bounded comparison artifact written by the reference runner in an immutable root that the
candidate cannot access. One bundle binds fixture, candidate, environment, artifact, and invocation
identity to exactly 16 positive scenario observations plus the required late-injection negative case
in suite mode.

- runner-owned latency interval endpoints and full observed lifecycle milestones
- runner-owned process, RSS, queue, and storage samples
- runner-owned effective Agent/repository/session identity and caller-claim authorization decisions
- a runner-derived fingerprint over the complete result observation, binding egress, render,
  atomicity, and conflict evidence without copying private payload into the bundle
- bundle-global unique per-run preparation receipts with path-free ASCII opaque data-directory and
  process-generation identities, observed after the prior run and within one pinned process-sample
  interval before the current run
- cold-reset observations proving zero prior product processes and an empty data directory
- warm observations proving one retained ready data directory and process generation

The result record carries only the bundle fingerprint plus inspectable copies and aggregates. Those
copies are not authoritative and must exactly match the bundle before they can affect eligibility.
The bundle contains no absolute path or private payload.

## OperationalStatus

A secret-free snapshot used by doctor and inspection surfaces.

- component: capture, spool, summary, lexical, semantic, injection, backup, or provider
- state: healthy, degraded, failed, disabled, or pending
- reason, since, pending count, last success
- safe user action
- effective manifest identity

Healthy status requires a relevant end-to-end probe; process existence alone is insufficient.
