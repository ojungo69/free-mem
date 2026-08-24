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
| `DecimalString` | `^(0|[1-9][0-9]*)$`; no JavaScript number conversion |
| `Sha256Hex` | exactly 64 lowercase hexadecimal characters |
| `OpaqueIdV1` | exactly 64 lowercase hexadecimal characters issued by the daemon profile below |
| `CanonicalClientIdV1` | `claude-code` or `codex-cli` |
| `SharingScopeV1` | `agent_private`, `task_shared`, `project_shared`, `personal_shared` |
| `EgressPolicyV1` | `eligible`, `local_only`, `prohibited_egress` |
| `ResumeProfileV1` | `same_agent`, `cross_agent` |
| `LegacyMigrationDispositionV1` | `migrate`, `legacy_read_only`, `quarantine` |

`local_only` may remain in daemon-owned local state but is never serialized into a resume capsule or export. It has its own
`local_only` disposition code; it is not reported as `prohibited_egress`.

`OpaqueIdProfileV1` is `{ schemaVersion: 1, algorithm: "hmac-sha-256", keyId,
outputEncoding: "lowercase_hex_256" }`. The HMAC input is domain-separated by ID kind. New-intake raw values are transformed
without persistence. Migration scratch remains memory-only for one transaction; a legacy original remains only inside its
local quarantine artifact until explicit user repair or discard. Raw values never enter successor state, checkpoint, capsule,
diagnostic, export, or egress.

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
| `captureMethod` | yes | existing `ContinuityCaptureMethod` |
| `ingestAttestation` | yes | existing intake-stamped `ContinuityIngestAttestationV1` |

`SourceIdentityV1` is resolved once per normalized source event. Persisted fields do not embed it. They retain sorted,
unique `OpaqueIdV1` source-event references instead.

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
`decision: "grant"`, exact `SubjectScopeV1`, `task_shared|project_shared|personal_shared`, a closed target, and canonical
`decidedAt`. The target is either the exact task lineage for `shared_task_projection` or the exact `canonicalFactId` for
`canonical_memory_entity`. Unknown or unauthenticated authority, wrong scope, and wrong target reject the grant.
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
watermark, and commits those side effects in the same daemon transaction. `history` and `updatedAt` remain V1 inputs for the
before/after observation only; they are not invented as successor work-state fields.

`CanonicalStateHashProfileV1` removes the envelope from the content preimage. `contentHash` is SHA-256 over RFC 8785 JCS
of exactly `schemaVersion`, `subjectScope`, `opaqueIdProfile`, `lineageSourceSummary`, `sharedTaskState`,
`agentLocalStates`, and `sensitivity`. `stateRevision` is SHA-256 over RFC 8785 JCS of
`{ domain: "free-mem/CanonicalWorkStateV2/state-revision/v1", contentHash, revision }`, where `revision` contains exactly
`parentStateRevisions`, `lineageRevisionOrdinal`, `committedByDaemonId`, `writerEpoch`, `sourceSessionId`, and
`committedAt`. Neither hash includes itself. The manifest carries a fixed vector for TypeScript/Rust parity.

### `RevisionHeadSelectionContractV1`

```text
orderingKey = "lineage_revision_ordinal"
orderedHeadStateRevision: Sha256Hex
candidateEvaluations: RevisionCandidateEvaluationV1[]
automaticResumeHeadStateRevision?: Sha256Hex
fallbackDisposition: "none" | "manual"
```

Each candidate evaluation contains `stateRevision`, `lineageRevisionOrdinal`, `isOrderedHead`,
`workspaceCompatibility: compatible|incompatible|unknown`,
`checkpointDisposition: open|accepted|superseded|retracted|unknown`,
`lineageState: single|forked|conflicted`, `resumeEligible`, and closed reason codes.

Ordinals are unique and exactly one candidate is marked as the greatest daemon-owned ordered head. Automatic resume is allowed only when that same head is compatible,
open, single, and otherwise eligible. An ineligible ordered head produces `fallbackDisposition="manual"`; it never silently
selects an older revision. Equal ordinals or multiple ordered heads are contract corruption and quarantine the selection.

## Work-state projections

### `SharedTaskStateV1`

Required fields: `sharingScope: "task_shared"`, non-empty authenticated `sharingDecisionEventIds`, `constraints`, `activeFiles`, `modifiedFiles`, `recentCommands`,
`recentTests`, `pendingOperations`, `droppedEvidence`, `repositoryState`, `sensitivity`, `egressPolicy`.
Optional fields: `goal`, `semanticResumeNote`.

The Observed/file/command/test/operation/repository/note V2 shapes preserve their V1 semantic fields, make all arrays and
properties readonly, replace every identifier/fingerprint/source-event reference with `OpaqueIdV1`, and remove
caller-owned ordering material. `sourceEventIds` are sorted unique arrays.

### `AgentLocalStateV1`

Required fields: `sharingScope: "agent_private"`, `sourceIdentityEventId`, `clientId`, `sensitivity`, `egressPolicy`.
Optional fields: `latestSubstantivePrompt`, `lastAssistantConclusion`, `nativeTodoState`, `nativePlanState`,
`hostMetadata`.

Each lane is bound to one authenticated source identity event. Another client never receives the lane automatically.

### `CanonicalWorkStateV2`

```text
schemaVersion = 2
subjectScope: TaskLineageSubjectScopeV1
opaqueIdProfile: OpaqueIdProfileV1
revision: TaskStateRevisionEnvelopeV1
lineageSourceSummary: LineageSourceSummaryV1
sharedTaskState: SharedTaskStateV1
agentLocalStates: AgentLocalStateV1[]
sensitivity: Sensitivity
```

The V1 top-level `sourceAgent`, `lastIngestSeq`, and `updatedAt` fields do not carry forward. Revision/order/audit fields
live in the envelope; source meaning lives in references and the lineage summary.

## Dropped evidence

`DroppedEvidenceSummaryV1` has total `totalRecorded`/`totalOverflowed` decimal strings and exactly one
`DroppedEvidenceReasonWindowV1` per reason (`evicted`, `orphaned_terminal`). Each reason window independently caps
`entries` at 256 and records its total counts plus oldest/latest retained lineage ordinals. Flooding one reason cannot erase
the other reason's existence or totals.

Each `DroppedEvidenceEntryV2` stores reason, source-event refs, recorded lineage ordinal, sensitivity, and only the optional
opaque operation/status/fingerprint/delivery fields needed for that reason.

## Checkpoint and capsule

### `ContinuationCheckpointV3`

Required: opaque `id`, `schemaVersion: 3`, `checkpointRevision`, `kind`, opaque `sourceSessionId`,
`checkpointCreatedBySourceEventId`, `canonicalState: CanonicalWorkStateV2`, decimal `memoryWatermark`, `contentHash`,
`sensitivity`, `createdAt`. Optional: opaque `parentCheckpointId`, `expiresAt`.

### `ResumeCapsuleV2`

The capsule contains a bounded delivery projection, not the full state:

- `schemaVersion: 2`, opaque injection/checkpoint IDs, checkpoint/work-state revisions;
- subject scope, lineage source summary, explicit checkpoint creator event;
- `ResumeDestinationV1` (`clientId`, exact version, opaque session, optional capability hash, `privateEligible`);
- `resumeProfile`, age, reconciliation status;
- shared task state;
- at most the destination client's own eligible `destinationAgentLocalState`;
- opaque selected memory IDs and bounded warnings.

Cross-agent capsules never contain the source client's Agent-local lane.

## Canonical memory

`CanonicalMemoryEntityV1` fields:

- identity/version: `schemaVersion: 1`, opaque `memoryId`, `memoryRevision`, `contentHash`;
- scope/content: `SubjectScopeV1`, kind, `normalizationProfileId`, `canonicalContent`, `canonicalFactId`;
- policy: `sharingScope`, `sharingDecisionEventIds`, sensitivity, egress policy;
- lifecycle: `active|superseded|retracted|expired`, truth state, durability;
- evidence: sorted unique `sourceEventIds` and `evidenceSnapshotIds`;
- validity/audit timestamps.

`canonicalFactId = sha256(JCS({schema, subjectScope, kind, normalizationProfileId, canonicalContent}))`.
An exact match unions evidence into the same entity and advances its revision. Semantic similarity never auto-merges.
Any entity whose sharing scope is wider than `agent_private` requires at least one authenticated
`sharingDecisionEventId`; an empty array is invalid rather than implicit consent. A `private` entity additionally requires
the destination `privateEligible` gate at delivery time.

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
(sources, destination, scope, records, sharing decisions, transitions), current V1 non-success disposition/reason, and successor expected
delivery/source/lineage/memory/retrieval/authority/downgrade outputs. Cross-references are closed and validated.
An omitted record `subjectScope` inherits the case scope; an explicit record scope is compared structurally. F7 carries
separate wrong-vault, wrong-project, and wrong-workspace records rather than a magic scope tag.

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
the capsule destination-lane equality cannot bypass restore validation.

Each `RestoreArtifactValidationRuleV1` has:

- `artifact`;
- `scopeIdentityPaths`: exact JSON-pointer/SQL-column patterns whose non-blank value and parent-scope consistency are checked;
- `isoTimestampPaths`: exact patterns validated with the frozen canonical timestamp profile;
- `crossFieldRules`: closed reason-code list for parent/embedded-state/revision/hash consistency;
- `invalidDisposition: "quarantine"`;
- `repairAuthorities: ["user"]`;
- `auditRequired: true`.

Wildcard pointer segments use `*` for every array element. Nested artifact refs are expanded in the manifest rather than
silently assumed. DurableMemory rules name `session_id`, `scope_id`, `project`, `workspace_kind`, `workspace_id`,
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
