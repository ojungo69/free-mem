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
version, session binding, capability evidence, capture method, and ingest receipt. Caller payload values are proposals only.

The resolved identity reuses `ContinuityEventProvenanceV1`, `ContinuityIngestAttestationV1`, and the normalized source
event. It is not copied into each work-state field. Persisted artifacts keep sorted unique opaque source-event refs.

Evidence certainty never grants instruction authority. Derived/synthesized records remain traceable but cannot confirm a
boundary or raise sharing scope without the separate authority rule.

## 4. Subject scope, sharing scope, sensitivity, and egress

Subject scope and sharing scope are independent. Subject scope is the closed hierarchy
`personal_vault -> project -> workspace -> branch -> task_lineage -> session -> turn`.
Sharing scope is `agent_private | task_shared | project_shared | personal_shared`.

The decision order is fixed:

1. deny `secret` and `prohibited_egress`;
2. deny cross-`personal_vault`, project, or workspace mismatch;
3. require explicit opt-in and destination `privateEligible=true` for `private`;
4. isolate `agent_private` from every other client;
5. downgrade when destination capabilities cannot represent the record safely;
6. apply the allowed task/project/personal sharing rule;
7. apply source preference/display filters without changing identity.

Caller code may propose sharing scope but may not elevate it. Legacy `visibility=private/shared` is insufficient to assign a
new sharing scope.

## 5. Shared and Agent-local projections

`CanonicalWorkStateV2` contains one `SharedTaskStateV1` and bounded `AgentLocalStateV1[]` lanes.

- Shared task: goal, constraints, active/modified files, commands, tests, pending operations, dropped-evidence summary,
  repository state, eligible semantic note.
- Agent-local: latest prompt, last assistant conclusion, native todo/plan, host metadata.

`ResumeCapsuleV2` carries the shared projection and, only when eligible, the destination client's own Agent-local lane.
It never carries another client's Agent-local lane. The full canonical state is not embedded in a delivery capsule.

## 6. Lineage provenance

The following meanings are distinct:

- lineage origin: first authoritative lineage-establishing event;
- last contributor: event that produced the current revision;
- participants: first substantive event for each distinct canonical client;
- checkpoint creator: explicit event on the checkpoint envelope;
- field/memory evidence: source-event reference set on the value/entity.

Origin/last/participants are derived from append-only event/revision evidence. Checkpoint creator is stored explicitly.
No rule reuses an ambiguous single `sourceAgent` value for these meanings.

## 7. Revision, immutability, and evidence bounds

Published successor graphs are deeply readonly. Hashes cover canonical bytes. Lineage order uses daemon-owned
`lineageRevisionOrdinal`; caller timestamp, session-local sequence, and hash lexical order never choose a head.

Meaning-neutral events do not advance the canonical state revision/history, while event/delivery/diagnostic/watermark
transitions remain separately auditable.

The greatest daemon-owned `lineageRevisionOrdinal` is the ordered head. Resume eligibility is a separate typed evaluation
of workspace compatibility, checkpoint disposition, and lineage fork/conflict. Automatic resume is permitted only when the
ordered head itself is eligible. If it is not, the result is manual; the selector never silently falls back to an older
revision. Equal ordinals or multiple ordered heads quarantine the selection as corruption.

Dropped evidence has separate bounded windows and monotone decimal-string counters for `evicted` and
`orphaned_terminal`. One reason cannot erase the other's existence or count.

All caller identifiers/fingerprints that can reach successor state are replaced by domain-separated opaque IDs. New-intake
raw values are not persisted; a legacy raw value remains only inside its original local quarantined artifact when needed.

`RawIdentifierEvidencePolicyV1` makes that boundary exact: new-intake raw IDs are never persisted; migration scratch is
memory-only for one transaction and zeroized on commit/rollback; an original legacy artifact remains local in quarantine
until explicit user repair/discard. Only the daemon validator/migrator reads raw values. Diagnostics expose opaque metadata
only, and raw export or external egress is never permitted.

## 8. Canonical memory and evidence union

Automatic fact identity is exactly:

```text
sha256(JCS({schema, subjectScope, kind, normalizationProfileId, canonicalContent}))
```

Only exact identity matches auto-union evidence. A second source adds sorted unique source-event/evidence refs and advances
the entity revision; it does not create a per-source memory row. Semantic similarity and paraphrases remain separate until
an explicit authority records an auditable merge. Conflict, supersession, truth state, lifecycle, and validity history are
independent of dedupe.

## 9. Retrieval and delivery profiles

The contract distinguishes:

- `all_source_project` search;
- `current_source` filter;
- `named_source` filter;
- `active_task_shared` automatic injection;
- `same_agent` and `cross_agent` resume profiles.

Source filters affect result selection/display only. They never change lineage, memory identity, or revision history.

## 10. Restore semantic validation

Every persisted continuity artifact is validated once after read/schema validation and before routing, reduction, selection,
or delivery. The authoritative set is derived from source-inventory entries where `surfaceClass="persisted"` and
`restoreValidationRequired=true`; every such entry must have exactly one `RestoreSemanticValidationContractV1` rule.
The current seeds include task binding/proposal, work state/checkpoint/disposition/metadata/anchor/delivery/suppression/
selection/derived invalidation, engagement and contradiction evidence/ranges, resume capsule, and DurableMemory. A newly
inventoried persisted artifact without a rule fails the contract.

Scope IDs must be non-blank and parent/embedded scopes must agree. Every listed timestamp must be canonically valid, not
merely regex-shaped. Invalid artifacts preserve original bytes in quarantine and never reach the reducer/selector.

Repair, discard, and rebind require explicit user authority and an audit event. Daemon/model inference is forbidden. The
machine rule set is exact: deleting an artifact or a required path is a contract/hash change, not an implementation choice.

## 11. Legacy dispositions

Before the table is evaluated, schema/semantic/hash failure always quarantines the artifact.

| Artifact | Verified disposition | Unresolved disposition | Additional rule |
|---|---|---|---|
| `CanonicalWorkStateV1` | `migrate` | `quarantine` | all source refs resolve to one authenticated source; scope/order/opaque-ID material is unique |
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
- F4 one canonical memory with two source evidence branches;
- F5 the four retrieval profiles;
- F6 authenticated authority overriding caller claims;
- F7 privacy/scope/destination-capability downgrade.

The test requires the exact ordered set F0–F7, validates all references, checks case-specific invariants, and kills in-memory
mutations that remove a case, relabel a source, leak a denied record, or drop one evidence branch.

The same bundle contains `ContinuityP0ObservationContractV1` with exact entries for #46/#49/#53/#61/#62/#56/#57/#32/#58.
Each entry freezes its input, observation field/JSON path, current V1 value, successor value, and allowed delta kind. These
entries make SC-001–SC-012 executable later without claiming runtime conformance in S0.

## 14. Contract hash

`contractHash` is SHA-256 of RFC 8785 JCS over the manifest excluding `contractHash` itself. Input fields are:

- contract version and four artifact schema names/versions;
- raw-byte JSON Schema hash;
- machine inventory version/hash;
- fixture corpus version/hash and exact F0–F7 IDs;
- legacy migration rules;
- exact restore semantic-validation artifact/path/authority rules;
- revision-head ordering/eligibility rules and the exact 9-entry Continuity P0 observation/delta contract;
- raw-identifier retention/access/diagnostic/export/egress policy;
- opaque-ID profile;
- limit policy table;
- diagnostic vocabularies.

The existing `harness/contract-hashes.json` raw-byte manifest remains an independent drift gate.

## 15. S0 boundary and gates

S0 includes inventory, this normative contract/ADR, TS mirror, JSON Schema, migration disposition, F0–F7, hashes, and the
#13 Phase 3 start gate. It does not change product runtime, DB/DDL/data, reference reducer, MCP, viewer, or CI workflow.

After S0: S1 reference projections/reducer; S2 TS/Rust conformance; S3 storage/migration/checkpoints; S4 retrieval/injection/
MCP; S5 product surfaces; S6 benchmark/real-client E2E. The #132 umbrella remains open after the S0 PR.
