# Source-Aware Continuity Contract V1

**Status**: Normative S0 contract; runtime unimplemented  
**Bundle ID**: `SourceAwareContinuityContractV1`  
**Applies to**: Core 1.0 Claude Code / Codex CLI continuity and DurableMemory

## 1. Version bundle

This contract freezes one bundle/hash containing:

- `CanonicalWorkStateV2`;
- `ContinuationCheckpointV3`;
- `ResumeCapsuleV2`;
- `CanonicalMemoryEntityV1`;
- `SourceIdentityInventoryV1`;
- `SourceAwareContractCorpusV1` with exactly F0–F7;
- legacy migration rules, opaque-ID profile, limit policies, and diagnostic vocabularies.

The existing V1/V2 artifacts remain readable under their legacy contracts. This document does not mutate their meaning.

## 2. Canonical vocabulary

Core 1.0 `CanonicalClientIdV1` is closed to `claude-code` and `codex-cli`.

| Current value | Canonicalization condition | Result without that condition |
|---|---|---|
| `claude` | authenticated Claude adapter manifest and exact version binding | unverified; no automatic cross-agent authority |
| `codex` | authenticated Codex adapter manifest and exact version binding | unverified; no automatic cross-agent authority |
| `claude-code` | same authenticated binding | unverified caller claim |
| `codex-cli` | same authenticated binding | unverified caller claim |
| provider/model name | never a client alias | retained as generation identity only |
| unknown/future client | versioned vocabulary + conformance required | manual inspection/downgrade |

`actor` is human/local-account identity, `device` is host/sync identity, `session` is execution/subject scope,
`origin_source` is a producer marker, and raw/retrieval `source` is a channel label. None is coding-client authority.

## 3. Source authority

Intake resolves `SourceIdentityV1` from authenticated peer context, adapter manifest, ingest channel, exact client/adapter
version, session binding, capability evidence, daemon-owned private-eligibility policy, capture method, and ingest receipt.
Caller payload values are proposals only.

A shared capsule requires a non-blank destination `capabilityHash` resolving to an authenticated profile that contains
`shared-task-v1`. Missing/unknown/unsupported profiles downgrade or reject before delivery. A same-agent local-only capsule
may omit the capability hash because no foreign shared projection is serialized.

The resolved identity reuses `ContinuityEventProvenanceV1`, a fully readonly `ContinuityIngestAttestationV1` view, and the normalized source
event. It is not copied into each work-state field. Persisted artifacts keep sorted unique opaque source-event refs.

Evidence certainty never grants instruction authority. Derived/synthesized records remain traceable but cannot confirm a
boundary or raise sharing scope without the separate authority rule.

The inventory freezes broad discovery snapshots by count/hash, while the high-risk `sourceAgent` search uses an exact-one
partition into semantic owners or documentation/test/fixture/tooling support. Normative schema and runtime hits cannot be
classified as support. This keeps the proof closed without pretending each generic `source` or `model` access is a separate
semantic surface.

## 4. Subject scope, sharing scope, sensitivity, and egress

Subject scope and sharing scope are independent. Subject scope is the closed hierarchy
`personal_vault -> project -> workspace -> branch -> task_lineage -> session -> turn`.
Sharing scope is `agent_private | task_shared | project_shared | personal_shared`.
Here `private` means the closed `Sensitivity` value, while `agent_private` is a `SharingScopeV1` value; they are independent.
The destination identity's authenticated `privateEligible` value gates a `sensitivity="private"` record only after an
explicit sharing grant. A capsule does not carry an authoritative eligibility boolean, and eligibility never makes an
`agent_private` record deliverable to another client.

The decision order is fixed:

1. deny `secret`, `local_only`, and `prohibited_egress` on every non-daemon-local path (retrieval, RPC, hint/manual,
   automatic injection, `active_task_shared`, `same_agent`, `cross_agent`, capsule, sync, and export); `local_only` remains
   usable only inside daemon-owned local state;
2. deny cross-`personal_vault`, project, or workspace mismatch;
3. require authenticated `SharingDecisionV1.privateConsent=true` and resolved destination
   `SourceIdentityV1.privateEligible=true` for private shared/memory delivery;
4. isolate `agent_private` from every other client;
5. downgrade when destination capabilities cannot represent the record safely;
6. apply the allowed task/project/personal sharing rule;
7. apply source preference/display filters without changing identity.

Caller code may propose sharing scope but may not elevate it. Legacy `visibility=private/shared` is insufficient to assign a
new sharing scope.

`SharingDecisionV1` is the only grant authority: explicit user authority event, exact subject scope, exact target,
required `privateConsent`, and
`grant` action. The target is a task-lineage shared projection or a canonical fact. Unknown, unauthenticated, wrong-scope,
or wrong-target decisions reject. The resolved authority event payload must exactly equal the persisted action, subject scope,
sharing scope, target, private consent, and decision time; ID membership alone is not authority. Private shared/memory delivery
requires consent `true`; eligibility alone is insufficient. Referenced decision IDs must already be sorted
and unique on input; duplicate or out-of-order refs are rejected before hashing/publication and are never normalized into acceptance.

## 5. Shared and Agent-local projections

`CanonicalWorkStateV2` contains zero or one `SharedTaskStateV1` plus bounded `AgentLocalStateV1[]` lanes, and at least one
projection must exist. This permits F0 private-only state without fabricating sharing consent. A present shared projection
has a non-empty `sharingDecisionEventIds` set whose events resolve to authenticated sharing authority; sensitivity and
private eligibility do not substitute for consent.

- Shared task: goal, constraints, active/modified files, commands, tests, pending operations, dropped-evidence summary,
  repository state, eligible semantic note.
- Agent-local: latest prompt, last assistant conclusion, native todo/plan, host metadata.

Agent-local lanes are keyed by `(clientId, sessionId)`, unique in canonical state, and bound through
`sourceIdentityEventId` to the same authenticated pair. Duplicate lanes quarantine. A capsule carries zero or one lane and
rejects it unless both client and session match the destination.

Every pending operation's outer/correlation operation IDs match. Its `correlation.startEventId` resolves to an authenticated
start-phase event present in that operation's evidence and matching the complete correlation envelope, `startTurnIdSource`,
and authenticated source-identity session.

Sensitivity uses the closed order `normal < private < secret`. Every present shared or Agent-local projection declares the
maximum of its contained values; canonical state declares the maximum across its present projections, and a capsule derives
the maximum of what it includes. A checkpoint must match its embedded canonical-state maximum. Any mismatch quarantines
before delivery instead of lowering sensitivity.

`ResumeCapsuleV2` carries zero or one granted shared projection and zero or one destination-client Agent-local lane, with at
least one present. A capsule without a shared projection is same-agent only; cross-agent delivery requires a granted shared
projection. It never carries another client's Agent-local lane. The full canonical state is not embedded in a delivery
capsule. The destination always carries `sourceIdentityEventId`; restore rejects unless it resolves to the same authenticated
client, exact client version, session, required supported capability profile for shared delivery, and daemon-owned private
eligibility. Capability hash remains optional only for same-agent local-only capsules.
Every selected memory ID is sorted unique, resolves to a hash-valid canonical memory, and passes the same subject-scope,
sharing/private-consent, lifecycle, sensitivity, egress, destination-eligibility, and Agent-private isolation gates before
delivery.
A private `agent_private` memory has no grantable `SharingDecisionV1` target and therefore remains daemon-local; destination
eligibility cannot make it capsule-deliverable.

## 6. Lineage provenance

The following meanings are distinct:

- lineage origin: first authoritative lineage-establishing event;
- last contributor: event that produced the current revision;
- participants: first substantive event for each distinct canonical client, ordered by resolved canonical client ID;
- checkpoint creator: explicit event on the checkpoint envelope;
- field/memory evidence: source-event reference set on the value/entity.

Origin/last/participants are derived from append-only event/revision evidence. Checkpoint creator is stored explicitly.
Restore compares the complete summary with that evidence; merely authenticating the supplied IDs is insufficient. No rule
reuses an ambiguous single `sourceAgent` value for these meanings.

Every nested shared-field source-event array is sorted unique and resolves to authenticated source identities. Agent-local
field refs additionally resolve to the enclosing lane's exact client/session. Canonical-memory source refs follow the same
authenticated rule and are non-empty; evidence-snapshot refs resolve to existing hash-valid snapshots bound to the same memory entity.
Unresolved, unauthenticated, ID-mismatched, or lane-mismatched references quarantine even when artifact hashes were recomputed.

## 7. Revision, immutability, and evidence bounds

Published successor graphs use recursively readonly `ReadonlyJsonValue`; nested objects/arrays are not mutable through the
TypeScript contract. S1 publication still owns runtime clone/freeze. `contentHash` is SHA-256 over RFC 8785 JCS of the declared non-revision
`CanonicalWorkStateV2` projection; an absent optional `sharedTaskState` member is omitted rather than encoded as `null`.
`stateRevision` hashes the fixed domain, that `contentHash`, and the six non-hash revision
metadata fields; neither preimage includes its own digest. The manifest pins shared and local-only/omitted-member vectors as
cross-language oracles. Lineage order uses daemon-owned
`lineageRevisionOrdinal`; caller timestamp, session-local sequence, and hash lexical order never choose a head.
`parentStateRevisions` is sorted unique before hash/publication; duplicates or reordered equivalent sets quarantine.

Checkpoint and canonical-memory hashes use separate domain strings and manifest vectors. Checkpoint content excludes its
ID/parent/revision fields; initial and parent transitions bind checkpoint ID, content hash, and both parent ID/revision when
present. Memory content excludes identity/revision/evidence metadata; memory revision binds memory ID, content hash,
sorted evidence metadata, and either an initial or parent-memory-revision transition. `canonicalFactId` remains the separate
exact-fact identity hash with schema literal `CanonicalMemoryEntityV1`.
Both profiles require the exact ordered `transitionKinds=["initial","parent"]`; duplicate or reversed members are invalid.
Resume capsules use their own domain-separated hash over every present field except `contentHash`; absent optional projection
members are omitted rather than encoded as `null`; the manifest pins a local-only capsule vector. Restore resolves the named
checkpoint revision to the same checkpoint ID and creator event, then requires its work-state revision and every serialized
shared/local projection to equal the corresponding resolved
work-state projection. All remaining envelope fields must equal the persisted delivery claim (injection/checkpoint/state IDs,
scope/lineage/destination, profile, age, reconciliation, selected memories, and warnings). A body-only or authorization-field
mutation remains rejected even after an attacker recomputes the public capsule hash; `reconciliation="incompatible"` cannot
produce a delivery capsule.

Meaning-neutral events do not advance the canonical state revision/history, while event/delivery/diagnostic/watermark
transitions remain separately auditable. `StateNeutralTransitionPolicyV1` names the four classifications and fixes
`ledger_only` to `reuse_revision + insert_once + record_bounded + advance` in one daemon transaction; no undefined successor
`history` or `updatedAt` field is required. The receipt key is `adapterDeliveryId` when present, otherwise the canonical
fingerprint, under the versioned `d:`/`f:` keyspace. Uniqueness is per task-lineage event store. An identical retry returns
the existing receipt; the same key with different canonical evidence quarantines instead of overwriting.

The greatest daemon-owned `lineageRevisionOrdinal` is the ordered head. Resume eligibility is a separate typed evaluation
of workspace compatibility, checkpoint disposition, and lineage fork/conflict. Automatic resume is permitted only when the
ordered head itself is eligible. If it is not, the result is manual; the selector never silently falls back to an older
revision. Duplicate revisions/ordinals, zero or multiple ordered heads, a mismatched head reference, or a non-greatest
marked head use the third `fallbackDisposition="quarantine"` variant with exact corruption reason codes.
`checkpointDisposition="expired"` is a known ineligible state with reason `checkpoint_expired` and manual fallback; it is
never collapsed into `checkpoint_unknown`.

Dropped evidence has separate bounded windows and decimal-string counters for `evicted` and `orphaned_terminal`. Per window,
`totalRecorded = totalOverflowed + retained entries`; top-level totals equal the window sums. A non-empty window carries
oldest/latest boundaries equal to the minimum/maximum retained lineage ordinal, while an empty window carries neither.
One reason cannot erase the other's existence or count.

All caller identifiers/fingerprints that can reach successor state are replaced by domain-separated opaque IDs. New-intake
raw values are not persisted; a legacy raw value remains only inside its original local quarantined artifact when needed.

Opaque IDs use the closed manifest profile:
`lowerhex(HMAC-SHA-256(vaultKey(keyId), UTF8(JCS({domain:"free-mem/OpaqueIdV1/v1",kind,value}))))`.
The key is resolved from the personal-vault keyring and is at least 32 bytes; `kind` is closed and the public test key/vector
is conformance-only. Ingest receipt and peer identity IDs inside `SourceIdentityV1` are opaque under the same profile.

`RawIdentifierEvidencePolicyV1` makes that boundary exact: new-intake raw IDs are never persisted; migration scratch is
memory-only for one transaction and zeroized on commit/rollback; an original legacy artifact remains local in quarantine
until explicit user repair/discard. Only the daemon validator/migrator reads raw values. Diagnostics expose opaque metadata
only, and raw export or external egress is never permitted.

## 8. Canonical memory and evidence union

Automatic fact identity is exactly:

```text
sha256(JCS({schema, subjectScope, kind, normalizationProfileId, canonicalContent}))
```

Only exact identity **and exact policy tuple** (`sharingScope`, `sensitivity`, `egressPolicy`) matches auto-union evidence.
A shared contributor with the same tuple and its own exact authenticated sharing grant adds sorted unique source-event/evidence
refs and advances the entity revision. Agent-private evidence may union only within the same exact source; it never crosses
sources without a grantable sharing scope. Unconsented or cross-source private evidence remains outside the active union. The union does
not create a per-source memory row. Policy-mismatched evidence is preserved as a typed
`SourceAwareMemoryReviewCandidateV1` with its record ID, fact ID, exact policy tuple, and `policy_tuple_mismatch`; it cannot
broaden or weaken the active entity's delivery policy without explicit audited user resolution. Evidence matching an active
policy tuple but failing contributor consent or exact Agent-private source locality is preserved with
`consent_or_source_locality_mismatch`. Semantic similarity and paraphrases remain separate until
an explicit authority records an auditable merge. Conflict, supersession, truth state, lifecycle, and validity history are
independent of dedupe.

## 9. Retrieval and delivery profiles

The contract distinguishes:

- `all_source_project` search;
- `current_source` filter;
- `named_source` filter with an explicit authenticated `requestedSourceId`;
- `active_task_shared` automatic injection;
- `same_agent` and `cross_agent` resume profiles.

Source filters affect result selection/display only. They never change lineage, memory identity, or revision history.
`current_source` results belong to the destination source; named-source results belong to the explicit requested source.
Every non-daemon-local output applies source/destination authentication, scope, sharing consent, Agent-private isolation,
private eligibility, secret, and egress gates. Capability support is additionally required for automatic and
`active_task_shared`; a valid hint/manual downgrade may omit that capability but may not bypass the other gates.

## 10. Restore semantic validation

Every persisted continuity artifact is validated once after read/schema validation and before routing, reduction, selection,
or delivery. The authoritative set is derived from source-inventory entries where `surfaceClass="persisted"` and
`restoreValidationRequired=true`; every such entry must have exactly one `RestoreSemanticValidationContractV1` rule.
The current seeds include task binding/proposal, work state/checkpoint/disposition/metadata/anchor/delivery/suppression/
selection/derived invalidation, engagement and contradiction evidence/ranges, resume capsule, and DurableMemory. A newly
inventoried persisted artifact without a rule fails the contract. The closure also includes all four successor artifacts and
the persisted `SharingDecisionV1` authority event;
in particular, `ResumeCapsuleV2` requires its optional Agent-local lane to match `destination.clientId`.

Scope IDs must be non-blank and parent/embedded scopes must agree. Every listed timestamp must be canonically valid, not
merely regex-shaped. The successor work-state/capsule rules enumerate every nested field source ref; canonical-memory rules
also resolve same-memory hash-valid evidence snapshots. Invalid artifacts preserve original bytes in quarantine and never
reach the reducer/selector.

Repair, discard, and rebind require explicit user authority and an audit event. Daemon/model inference is forbidden. The
machine rule set is exact: deleting an artifact or a required path is a contract/hash change, not an implementation choice.

## 11. Legacy dispositions

Before the table is evaluated, schema/semantic/hash failure always quarantines the artifact.

| Artifact | Verified disposition | Unresolved disposition | Additional rule |
|---|---|---|---|
| `CanonicalWorkStateV1` | `migrate` | `quarantine` | all source refs resolve to one authenticated source; scope/order/opaque-ID material is unique; every shared projection has separate explicit authenticated sharing authority |
| `ContinuationCheckpointV2` | `migrate` | `quarantine` | embedded state passes; creator and scope/hash chain are unique |
| `ResumeCapsuleV1` | `legacy_read_only` | `quarantine` | same-agent manual/hint-only; never automatic full/cross-agent |
| legacy DurableMemory | `migrate` | `legacy_read_only` | source evidence, scope, sharing authority, normalization profile all unique |

`legacy_read_only` permits local search/inspection but never automatic cross-agent full injection. Repair, rebind, or merge
requires explicit authority and an audit event.

## 12. Limit policies and diagnostics

`rankedCandidates` is the only selection limit: select the top five and emit a diagnostic with the omitted count. The other
11 frozen limits are capacity limits and reject overflow without silently dropping content.

`ContinuityDiagnosticCodeV2` includes the current diagnostic vocabulary plus `terminal_sibling_conflict`; this records every
sibling excluded by identity conflict. `SourceSharingDispositionCodeV1` is closed to:

```text
agent_private
private_not_eligible
secret
local_only
prohibited_egress
scope_mismatch
destination_capability_unsupported
source_unverified
legacy_read_only
```

## 13. F0–F7 corpus

The versioned corpus records current V1 as `unsupported` or `unsafe`; this is not a successful conformance result. Successor
expectations cover:

- F0 Agent-local isolation;
- F1 shared task visibility;
- F2 immutable provenance;
- F3 multi-Agent lineage;
- F4 one canonical memory with two consented source evidence branches, plus one same-tuple unconsented review candidate;
- F5 the four retrieval profiles;
- F6 authenticated authority overriding caller claims (`source_unverified` refers to the unverified caller client-ID claim,
  not to the authenticated intake source);
- F7 privacy/scope/destination-capability downgrade.

The test requires the exact ordered set F0–F7, validates all references, checks case-specific invariants, and kills in-memory
mutations that remove a case, relabel a source, leak a denied record, or drop one evidence branch.
F3 origin, last contributor, canonical-client participants, and checkpoint creator are derived from its authenticated ordered
transition history rather than copied from expected output.
Each record's event-level evidence is non-empty, nonblank, sorted unique, and preserved exactly in successor record evidence;
memory unions carry the sorted event union and review candidates retain their record's exact evidence IDs.

The same bundle contains `ContinuityP0ObservationContractV1` with exact entries for #46/#49/#53/#61/#62/#56/#57/#32/#58.
Each entry freezes its input, observation field/JSON path, current V1 value, successor value, and allowed delta kind. These
entries make SC-001–SC-012 executable later without claiming runtime conformance in S0.

## 14. Contract hash

`contractHash` is SHA-256 of RFC 8785 JCS over every top-level manifest field except `contractHash` itself. The following
bullets group that complete input set; they do not define a narrower subset:

- contract version, JSON Schema file identifier/raw-byte hash, and four artifact schema names/versions;
- machine inventory file identifier/version/hash;
- fixture corpus file identifier/version/hash and exact F0–F7 IDs;
- legacy migration rules;
- exact restore semantic-validation artifact/path/authority rules;
- canonical state/checkpoint/memory/capsule hash preimages and vectors, revision-head ordering/eligibility/corruption
  rules, and the exact 9-entry Continuity P0 observation/delta contract;
- raw-identifier retention/access/diagnostic/export/egress policy;
- sharing-decision user authority, exact scope/target, invalid disposition, and sorted-unique reference policy;
- state-neutral transition, Agent-local lane, and sensitivity-aggregation policies;
- opaque-ID derivation profile, closed kind vocabulary, and public conformance vector;
- limit policy table;
- diagnostic vocabularies.

The existing `harness/contract-hashes.json` raw-byte manifest remains an independent drift gate.

## 15. S0 boundary and gates

S0 includes inventory, this normative contract/ADR, TS mirror, JSON Schema, migration disposition, F0–F7, hashes, and the
#13 Phase 3 start gate. It does not change product runtime, DB/DDL/data, reference reducer, MCP, viewer, or CI workflow.

After S0: S1 reference projections/reducer; S2 TS/Rust conformance; S3 storage/migration/checkpoints; S4 retrieval/injection/
MCP; S5 product surfaces; S6 benchmark/real-client E2E. The #132 umbrella remains open after the S0 PR.
