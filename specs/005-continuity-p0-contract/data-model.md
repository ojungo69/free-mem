# Data Model: SourceAwareContinuityContractV1

**Date**: 2026-08-24  
**Spec**: [spec.md](spec.md)  
**Normative contract**: [contracts/source-aware-continuity-v1.md](contracts/source-aware-continuity-v1.md)

## Contract bundle

| Bundle | Included artifact | Previous artifact |
|---|---|---|
| `SourceAwareContinuityContractV1` | `CanonicalWorkStateV2` | `CanonicalWorkStateV1` |
| same bundle | `ContinuationCheckpointV3` | `ContinuationCheckpointV2` |
| same bundle | `ResumeCapsuleV2` | `ResumeCapsuleV1` |
| same bundle | `CanonicalMemoryEntityV1` | legacy DurableMemory row |

The bundle hash covers the JSON Schema, machine inventory, F0–F7 corpus, artifact/version list, migration rules,
restore semantic-validation rules, opaque-ID profile, limit policies, and diagnostic vocabulary. Artifact version numbers
remain independent.

## Common scalar contracts

| Name | Contract |
|---|---|
| `DecimalString` | `^(0\|[1-9][0-9]*)$`; no JavaScript number conversion |
| `Sha256Hex` | exactly 64 lowercase hexadecimal characters |
| `OpaqueIdV1` | exactly 64 lowercase hexadecimal characters issued by the daemon profile below |
| `CanonicalClientIdV1` | `claude-code` or `codex-cli` |
| `SharingScopeV1` | `agent_private`, `task_shared`, `project_shared`, `personal_shared` |
| `EgressPolicyV1` | `eligible`, `local_only`, `prohibited_egress` |
| `ResumeProfileV1` | `same_agent`, `cross_agent` |
| `LegacyMigrationDispositionV1` | `migrate`, `legacy_read_only`, `quarantine` |

`local_only` may remain in daemon-owned local state but is never emitted through retrieval, RPC, hint/manual, automatic
injection, `active_task_shared`, `same_agent`, `cross_agent`, capsule, sync, or export. It has its own `local_only`
disposition code; it is not reported as `prohibited_egress`.

`OpaqueIdProfileV1` is `{ schemaVersion: 1, algorithm: "hmac-sha-256", keyId,
outputEncoding: "lowercase_hex_256" }`. The HMAC input is domain-separated by ID kind. New-intake raw values are transformed
without persistence. Migration scratch remains memory-only for one transaction; a legacy original remains only inside its
local quarantine artifact until explicit user repair or discard. Raw values never enter successor state, checkpoint, capsule,
diagnostic, export, or egress.

`OpaqueIdConformanceProfileV1` freezes the derivation: resolve `keyId` from the personal-vault keyring (minimum 32-byte
key), then compute `lowerhex(HMAC-SHA-256(key, UTF8(JCS({domain, kind, value}))))`. `domain` is exactly
`free-mem/OpaqueIdV1/v1`; `kind` comes from the closed ID-kind vocabulary; `value` is I-JSON. The manifest contains a public
conformance key/vector only for TS/Rust parity, never a production key. New source-identity receipt/peer IDs use this opaque
form too.

## Source identity and references

### `SourceIdentityV1`

| Field | Required | Rule |
|---|---:|---|
| `clientId` | yes | closed `CanonicalClientIdV1` vocabulary |
| `clientVersion` | yes | exact non-blank client version from authenticated adapter context |
| `adapterId` | yes | authenticated manifest ID, not caller payload |
| `adapterVersion` | yes | exact authenticated manifest version |
| `sessionId` | yes | `OpaqueIdV1` |
| `deviceId` | no | `OpaqueIdV1`; only when authenticated binding exists |
| `capabilityHash` | no | `Sha256Hex` |
| `privateEligible` | yes | daemon-resolved destination policy; never accepted from a capsule/caller claim |
| `captureMethod` | yes | existing `ContinuityCaptureMethod` |
| `ingestAttestation` | yes | fully readonly intake-stamped `ContinuityIngestAttestationV1` view |

`SourceIdentityV1` is resolved once per normalized source event. Persisted fields do not embed it. They retain sorted,
unique `OpaqueIdV1` source-event references instead. Private eligibility is read from this authenticated identity at delivery;
`ResumeDestinationV1` cannot self-authorize it.
A shared capsule requires its destination capability hash to resolve to a profile containing `shared-task-v1`; only a
same-agent local-only capsule may omit the hash.

### `LineageSourceSummaryV1`

| Field | Meaning |
|---|---|
| `lineageOriginSourceEventId` | first authoritative event establishing the lineage |
| `lastContributingSourceEventId` | authoritative event that produced the current revision |
| `participantSourceEventIds` | first substantive event for each distinct canonical client, sorted by resolved client ID |

Checkpoint creator is not inferred from this summary; `ContinuationCheckpointV3` carries its own creator event ref.

## Subject scope

`SubjectScopeV1` is a closed discriminated union. Every narrower scope includes the complete parent chain.

| `kind` | Required IDs |
|---|---|
| `personal_vault` | `personalVaultId` |
| `project` | `personalVaultId`, `projectId` |
| `workspace` | previous + `workspaceId` |
| `branch` | previous + `branchKey` |
| `task_lineage` | vault/project/workspace + optional `branchKey` + `taskLineageId` |
| `session` | task-lineage chain + `sessionId` |
| `turn` | session chain + `turnId` |

All IDs are `OpaqueIdV1`. Sharing scope is a separate field and never changes subject identity.

### `SharingDecisionV1`

A persisted sharing grant contains `schemaVersion: 1`, opaque decision/authority event IDs, `authorityKind: "user"`,
`decision: "grant"`, exact `SubjectScopeV1`, `task_shared|project_shared|personal_shared`, a closed target, required
`privateConsent: boolean`, and canonical
`decidedAt`. The target is either the exact task lineage for `shared_task_projection` or the exact `canonicalFactId` for
`canonical_memory_entity`. Unknown or unauthenticated authority, wrong scope, and wrong target reject the grant.
The resolved user-event payload must exactly match action, subject/sharing scope, target, private consent, and decision time; matching only
`authoritySourceEventId` is insufficient.
Private shared/memory delivery requires `privateConsent=true`; destination eligibility alone is not user consent.
`SharedTaskStateV1` and `CanonicalMemoryEntityV1` store sorted-unique decision IDs; order/duplicates are semantic-invalid
because these arrays participate in canonical hashes.

## Revision envelope

`TaskStateRevisionEnvelopeV1` contains:

- `stateRevision` and `contentHash`: `Sha256Hex`;
- `parentStateRevisions`: bounded, sorted unique `Sha256Hex[]`;
- `lineageRevisionOrdinal`: daemon-owned `DecimalString` global to the lineage;
- `committedByDaemonId`: `OpaqueIdV1`;
- `writerEpoch`: daemon-owned `DecimalString`;
- `sourceSessionId`: `OpaqueIdV1`;
- `committedAt`: canonical ISO-Z timestamp used for display/audit, not ordering.

Ordering uses `lineageRevisionOrdinal`; selection eligibility remains a separate gate.

`StateNeutralTransitionPolicyV1` freezes the #46 authority split. A semantic no-op is `ledger_only`: it reuses the canonical
revision, inserts the receipt exactly once, records bounded diagnostic/audit coverage, advances the separate event-store
watermark, and commits those side effects in the same daemon transaction. Receipt identity uses adapter delivery ID first
and canonical fingerprint fallback in separate `d:`/`f:` keyspaces, unique per task-lineage event store. Exact retries return
the existing receipt; key/evidence collisions quarantine. `history` and `updatedAt` remain V1 inputs for the
before/after observation only; they are not invented as successor work-state fields.

`CanonicalStateHashProfileV1` removes the envelope from the content preimage. `contentHash` is SHA-256 over RFC 8785 JCS
of `schemaVersion`, `subjectScope`, `opaqueIdProfile`, `lineageSourceSummary`, optional `sharedTaskState`,
`agentLocalStates`, and `sensitivity`; absence omits the member rather than writing `null`. `stateRevision` is SHA-256 over RFC 8785 JCS of
`{ domain: "free-mem/CanonicalWorkStateV2/state-revision/v1", contentHash, revision }`, where `revision` contains exactly
`parentStateRevisions`, `lineageRevisionOrdinal`, `committedByDaemonId`, `writerEpoch`, `sourceSessionId`, and
`committedAt`. Neither hash includes itself. The manifest carries shared and local-only fixed vectors for TypeScript/Rust parity.

### `RevisionHeadSelectionContractV1`

```text
orderingKey = "lineage_revision_ordinal"
orderedHeadStateRevision: Sha256Hex
candidateEvaluations: RevisionCandidateEvaluationV1[]
automaticResumeHeadStateRevision?: Sha256Hex
fallbackDisposition: "none" | "manual" | "quarantine"
corruptionReasonCodes?: RevisionSelectionCorruptionReasonV1[]
```

Each candidate evaluation contains `stateRevision`, `lineageRevisionOrdinal`, `isOrderedHead`,
`workspaceCompatibility: compatible|incompatible|unknown`,
`checkpointDisposition: open|accepted|superseded|retracted|expired|unknown`,
`lineageState: single|forked|conflicted`, `resumeEligible`, and closed reason codes.

Ordinals are unique and exactly one candidate is marked as the greatest daemon-owned ordered head. Automatic resume is allowed only when that same head is compatible,
open, single, and otherwise eligible. An ineligible ordered head produces `fallbackDisposition="manual"`; it never silently
selects an older revision. Duplicate state revisions/ordinals, zero or multiple ordered heads, a mismatched head reference,
or a non-greatest marked head produce `fallbackDisposition="quarantine"` plus exact corruption reason codes. Corruption is
never represented as ordinary manual fallback.

## Work-state projections

### `SharedTaskStateV1`

Required fields: `sharingScope: "task_shared"`, non-empty authenticated `sharingDecisionEventIds`, `constraints`, `activeFiles`, `modifiedFiles`, `recentCommands`,
`recentTests`, `pendingOperations`, `droppedEvidence`, `repositoryState`, `sensitivity`, `egressPolicy`.
Optional fields: `goal`, `semanticResumeNote`.

The shared projection sensitivity is the maximum of every contained value. Each Agent-local lane applies the same rule to
its contents, and `CanonicalWorkStateV2.sensitivity` is the maximum of every present projection. A mismatch quarantines
before restore/delivery; implementations never choose one conflicting declaration silently.
`ContinuationCheckpointV3.sensitivity` must equal its embedded canonical state's maximum sensitivity.

The Observed/file/command/test/operation/repository/note V2 shapes preserve their V1 semantic fields, make all arrays and
properties recursively readonly through `ReadonlyJsonValue`, replace every identifier/fingerprint/source-event reference with `OpaqueIdV1`, and remove
caller-owned ordering material. `sourceEventIds` are sorted unique arrays.

### `AgentLocalStateV1`

Required fields: `sharingScope: "agent_private"`, `sourceIdentityEventId`, `clientId`, `sessionId`, `sensitivity`, `egressPolicy`.
Optional fields: `latestSubstantivePrompt`, `lastAssistantConclusion`, `nativeTodoState`, `nativePlanState`,
`hostMetadata`.

Each lane is keyed by `(clientId, sessionId)` and bound to one authenticated source identity event resolving to the same
pair. Canonical state permits at most one lane per key; duplicates quarantine. A capsule contains zero or one lane, and its
client/session must both equal the destination or the capsule is rejected.

Every pending operation has matching outer/correlation `operationId` values. Its authenticated
`correlation.startEventId` is a start-phase event present in that operation's sorted-unique `sourceEventIds`, with matching
complete `OperationCorrelationV2`, `startTurnIdSource`, and authenticated source-identity session; an unbound, wrong-phase,
or mismatched event quarantines the state/capsule.

### `CanonicalWorkStateV2`

```text
schemaVersion = 2
subjectScope: TaskLineageSubjectScopeV1
opaqueIdProfile: OpaqueIdProfileV1
revision: TaskStateRevisionEnvelopeV1
lineageSourceSummary: LineageSourceSummaryV1
sharedTaskState?: SharedTaskStateV1
agentLocalStates: AgentLocalStateV1[]
sensitivity: Sensitivity
```

At least one projection is required: either a granted shared projection or one Agent-local lane. The shared field remains
grant-bearing when present; private-only F0 state omits it instead of storing an empty or fabricated grant list.

The V1 top-level `sourceAgent`, `lastIngestSeq`, and `updatedAt` fields do not carry forward. Revision/order/audit fields
live in the envelope; source meaning lives in references and the lineage summary.

## Dropped evidence

`DroppedEvidenceSummaryV1` has total `totalRecorded`/`totalOverflowed` decimal strings and exactly one
`DroppedEvidenceReasonWindowV1` per reason (`evicted`, `orphaned_terminal`). Each reason window independently caps
`entries` at 256 and records its total counts plus oldest/latest retained lineage ordinals. Within a window,
`totalRecorded = totalOverflowed + entries.length`; summary totals equal the window sums. Non-empty windows require boundaries
equal to the retained entry ordinal minimum/maximum, and empty windows omit both. Flooding one reason cannot erase the other
reason's existence or totals.

Each `DroppedEvidenceEntryV2` stores reason, source-event refs, recorded lineage ordinal, sensitivity, and only the optional
opaque operation/status/fingerprint/delivery fields needed for that reason.

## Checkpoint and capsule

### `ContinuationCheckpointV3`

Required: opaque `id`, `schemaVersion: 3`, `checkpointRevision`, `kind`, opaque `sourceSessionId`,
`checkpointCreatedBySourceEventId`, `canonicalState: CanonicalWorkStateV2`, decimal `memoryWatermark`, `contentHash`,
`sensitivity`, `createdAt`. Optional: opaque `parentCheckpointId`, matching `parentCheckpointRevision`, `expiresAt`.

`CheckpointHashProfileV1` computes `contentHash` as SHA-256 of RFC 8785 JCS over exactly `schemaVersion`, `kind`,
`sourceSessionId`, `checkpointCreatedBySourceEventId`, `canonicalState`, `memoryWatermark`, `sensitivity`, `createdAt`, and
optional `expiresAt`. The ID, parent link, and both hashes are excluded. `checkpointRevision` hashes
`{domain:"free-mem/ContinuationCheckpointV3/checkpoint-revision/v1", checkpointId:id, transition, contentHash}`. Initial
creation uses `transition:{kind:"initial"}`. A child requires both `parentCheckpointId` and `parentCheckpointRevision` and
uses `transition:{kind:"parent",parentCheckpointId,parentCheckpointRevision}`. The manifest pins both vectors.

### `ResumeCapsuleV2`

The capsule contains a bounded delivery projection, not the full state:

- `schemaVersion: 2`, `contentHash`, opaque injection/checkpoint IDs, checkpoint/work-state revisions;
- subject scope, lineage source summary, explicit checkpoint creator event;
- `ResumeDestinationV1` (required authenticated `sourceIdentityEventId`, `clientId`, exact version, opaque session,
  capability hash required for shared delivery and optional for same-agent local-only); the reference must resolve to the
  same client/session/capability profile and private eligibility even when no Agent-local lane is included; exact client
  version, supported capability IDs, or eligibility cannot be inferred from client ID;
- `resumeProfile`, age, reconciliation status;
- optional granted shared task state;
- at most the destination client's own eligible `destinationAgentLocalState`;
- opaque selected memory IDs and bounded warnings.

Selected memory IDs are sorted unique and each resolves to a hash-valid `CanonicalMemoryEntityV1`. Before delivery, each
resolved entity must pass subject-scope containment, sharing authority (including private consent), active lifecycle,
sensitivity/egress, destination private eligibility, and Agent-private client isolation. Unknown or ineligible IDs reject the
capsule; the capsule hash only protects the selection and is not delivery authority.
Because `SharingDecisionV1` deliberately grants only task/project/personal sharing scopes, a private `agent_private` memory
has no grantable consent authority and remains daemon-local rather than entering a capsule.

Resolving `checkpointRevision` must yield the same `checkpointId`, creator event, and embedded work-state revision carried by
the capsule. A self-consistent persisted envelope with a mismatched checkpoint identity is rejected.

At least one shared/local projection is required. A capsule with only the destination Agent-local lane is same-agent only;
cross-agent capsules require the shared projection and never contain the source client's Agent-local lane. Matching client ID
with an old/different session is also rejected; the source identity event, lane key, and destination must agree on both values.

`ResumeCapsuleHashProfileV1` computes SHA-256 over RFC 8785 JCS of
`{domain:"free-mem/ResumeCapsuleV2/content/v1",capsule}` where `capsule` contains every present V2 field except
`contentHash`; absent optional projections are omitted rather than encoded as `null`.
Restore recomputes this hash, resolves both referenced checkpoint/work-state revisions, and requires included projections to
equal the resolved work-state projections. Non-projection envelope fields must equal the persisted delivery claim, and an
incompatible reconciliation cannot produce a capsule; recomputing the public hash cannot authorize changed content or policy.
The manifest pins shared and local-only cross-runtime vectors.

## Canonical memory

`CanonicalMemoryEntityV1` fields:

- identity/version: `schemaVersion: 1`, opaque `memoryId`, `memoryRevision`, `contentHash`;
- scope/content: `SubjectScopeV1`, kind, `normalizationProfileId`, `canonicalContent`, `canonicalFactId`;
- policy: `sharingScope`, `sharingDecisionEventIds`, sensitivity, egress policy;
- lifecycle: `active|superseded|retracted|expired`, truth state, durability;
- evidence: non-empty sorted unique `sourceEventIds` resolving to authenticated sources and `evidenceSnapshotIds` resolving to
  hash-valid snapshots bound to this `memoryId`;
- validity/audit timestamps.

`canonicalFactId = sha256(JCS({schema, subjectScope, kind, normalizationProfileId, canonicalContent}))`.
An exact fact match unions evidence only when `sharingScope`, `sensitivity`, and `egressPolicy` also match exactly, then
advances the same entity revision. Every shared contributor has exact authenticated consent; Agent-private evidence unions
only within the same exact source and never across sources. A policy/consent/source-locality mismatch stays outside the active canonical entity as a typed
`SourceAwareMemoryReviewCandidateV1` preserving the record/fact IDs and exact policy tuple;
its reason is `policy_tuple_mismatch` for a different tuple or `consent_or_source_locality_mismatch` for an otherwise matching
tuple that fails contributor consent or exact Agent-private source locality.
It never widens delivery or forces a per-Agent duplicate. Semantic similarity never auto-merges.
Any entity whose sharing scope is wider than `agent_private` requires at least one authenticated
`sharingDecisionEventId`; an empty array is invalid rather than implicit consent. A `private` entity additionally requires
the destination `privateEligible` gate at delivery time.

For the identity preimage, `schema` is the literal `CanonicalMemoryEntityV1`. `CanonicalMemoryHashProfileV1.contentHash`
hashes the exact fact/policy/lifecycle projection and excludes `memoryId`, revision fields, evidence refs, and audit times.
`memoryRevision` hashes `{domain:"free-mem/CanonicalMemoryEntityV1/memory-revision/v1", memoryId, transition,
contentHash, revision}` where `revision` is the sorted decision/source/evidence refs plus `createdAt`/`updatedAt`. Initial
creation uses `{kind:"initial"}`; later revisions require `parentMemoryRevision` and use
`{kind:"parent",parentMemoryRevision}`. Adding evidence therefore advances `memoryRevision` without changing fact
identity or `contentHash`. Both checkpoint and memory hash profiles freeze the exact ordered transition tuple
`["initial", "parent"]`; duplicates and reversal are invalid. The manifest pins both transitions.

## Machine inventory and F0–F7 corpus

### `SourceIdentityInventoryV1`

Contains `inventoryVersion`, baseline commit, frozen searches (ID, `partition|snapshot`, regex, include/exclude paths,
result count/digest), ordered candidate rules, and semantic entries. `partition` is reserved for the ambiguous
`sourceAgent` vocabulary: every hit matches exactly one owner/supporting rule, and runtime/schema hits cannot be supporting.
The broader 4,095 non-`sourceAgent` hits remain immutable discovery snapshots instead of becoming thousands of fake
one-line surfaces. Entries carry ID, locus, semantic term, current meaning, authority, one surface class, one disposition,
successor target, migration condition, `restoreValidationRequired`, optional schema definition/SQL table, and notes.

### `SourceAwareContractCorpusV1`

Contains `corpusVersion: 1`, bundle ID, and exactly eight ordered unique F0–F7 cases. Each case has common input
(sources, destination selector, scope, records, sharing decisions, transitions), current V1 non-success disposition/reason, and successor expected
delivery/source/lineage/memory/retrieval/authority/downgrade outputs. Cross-references are closed and validated.
Every input record has non-empty, nonblank, sorted-unique `sourceEvidenceIds`. Successor record evidence preserves that exact
array, canonical-memory expectations preserve the sorted union, and review candidates preserve the originating record array;
source identity alone cannot stand in for event-level evidence.
Destination `privateEligible` and `capabilityIds` live on the authenticated source/profile selected by `destination.sourceId`;
the destination selector has no detached authority fields.
An omitted record `subjectScope` inherits the case scope; an explicit record scope is compared structurally. F7 carries
separate wrong-vault, wrong-project, and wrong-workspace records rather than a magic scope tag.
The `named_source` expectation alone requires `requestedSourceId`; it resolves to an authenticated input source and every
returned record belongs to that source. `current_source` results all belong to `destination.sourceId`.

### `ContinuityP0ObservationContractV1`

Contains exactly one entry for each of `46,49,53,61,62,56,57,32,58`. Every entry has `caseId`, `issueNumber`,
versioned input or fixture input reference, `observationKind`, downstream stage, and one or more `BehaviorDeltaEntryV1`
records with `jsonPathOrField`, `currentV1`, `successor`, and `deltaKind`.

The closed delta kinds are `no_op_state_stable`, `published_bytes_immutable`, `daemon_ordered_head`,
`overflow_summary_visible`, `raw_identifier_absent`, `invalid_scope_quarantined`, `invalid_timestamp_quarantined`,
`limit_policy_enforced`, and `terminal_sibling_diagnostic`.

### `RawIdentifierEvidencePolicyV1`

```text
schemaVersion = 1
newIntakePersistence = "none"
migrationScratch = "memory_only"
scratchRetention = "transaction"
quarantinedArtifactRetention = "until_user_repair_or_discard"
allowedRawReaders = ["daemon_validator", "daemon_migrator"]
rawDiagnostics = "never"
rawExport = "never"
externalEgress = "prohibited"
postTransaction = "zeroize"
```

New IDs are transformed without persisting the raw value. A legacy original remains only in its local quarantine artifact;
the migration scratch copy is memory-only and zeroized on commit or rollback.

## Restore semantic validation contract

`RestoreSemanticValidationContractV1` contains `schemaVersion: 1` and one exact rule for every machine inventory entry with
`surfaceClass="persisted"` and `restoreValidationRequired=true`. The rule references the inventory entry ID, so adding a
persisted artifact without a validation rule fails the contract test. Current required seeds include task binding/proposal,
work state/checkpoint/disposition/metadata/anchor/delivery/suppression/selection/derived invalidation, engagement and
contradiction evidence/ranges, resume capsule, and DurableMemory; the inventory-derived closure is authoritative rather than
a hand-maintained count. The four successor artifacts and persisted sharing-decision authority are inventory entries too, so their scope/hash/sharing semantics and
the capsule destination-lane/capability equality, destination private eligibility, authority payload, lineage derivation,
parent ordering, and nested provenance cannot bypass restore validation.

Each `RestoreArtifactValidationRuleV1` has:

- `artifact`;
- `scopeIdentityPaths`: exact JSON-pointer/SQL-column patterns whose non-blank value and parent-scope consistency are checked;
- `isoTimestampPaths`: exact patterns validated with the frozen canonical timestamp profile;
- `crossFieldRules`: closed reason-code list for parent/embedded-state/revision/hash consistency;
- `invalidDisposition: "quarantine"`;
- `repairAuthorities: ["user"]`;
- `auditRequired: true`.

Wildcard pointer segments use `*` for every array element. Nested shared and Agent-local source-event refs are expanded in the
manifest and resolved to authenticated identities; Agent-local refs must match the lane client/session. Canonical-memory
snapshot refs resolve to hash-valid snapshots bound to the same memory. DurableMemory rules name `session_id`, `scope_id`, `project`, `workspace_kind`, `workspace_id`,
`created_at`, `updated_at`, and `deleted_at`; legacy visibility/source fields cannot establish scope authority.

The focused test derives the exact artifact set from inventory, requires non-empty identity/timestamp coverage where
applicable, one invalid disposition, user-only repair authority, and negative self-mutations that mark a new persisted
artifact without a rule, remove a timestamp path, accept blank scope, or allow unaudited model/daemon repair.

## Migration state transitions

```text
legacy artifact
  -> schema/semantic/hash invalid -> quarantine
  -> source + scope + chain + explicit sharing authority uniquely verified
       -> state/checkpoint/memory -> migrate
       -> capsule -> legacy_read_only
  -> evidence unresolved
       -> state/checkpoint -> quarantine
       -> capsule -> quarantine
       -> memory -> legacy_read_only
```

`legacy_read_only` allows local search/inspection but never automatic cross-agent full injection. Repair/rebind/merge requires
explicit authority and an audit event.

V1 source provenance never counts as consent. A `CanonicalWorkStateV1` can migrate to a shared V2 projection only when a
separate explicit authenticated sharing decision can be reconstructed; otherwise its unresolved disposition is quarantine.
