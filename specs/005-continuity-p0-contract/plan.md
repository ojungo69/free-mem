# Implementation Plan: Continuity P0 + source-aware shared memory S0

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to execute `tasks.md` task-by-task. Security/authority decisions remain with the primary
> Codex session; external implementation lanes are not used for them.

**Branch**: `spec/005-continuity-p0-contract` | **Date**: 2026-08-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-continuity-p0-contract/spec.md`

## Summary

Freeze Continuity P0 and Issue #132 as one `SourceAwareContinuityContractV1` bundle without changing product runtime.
The bundle adds additive successor definitions beside V1, a machine source inventory, explicit legacy dispositions, and an
F0–F7 expected-current-failure corpus. Existing validator, JCS, contract-hash walker, CI glob, and V1 parity gates are reused.

## Global Constraints

- S0 changes no `vendor/codemem/**`, product DB/DDL/data, reference reducer, MCP, viewer, or CI workflow.
- No dependency, source registry/factory, per-Agent DB, or per-source memory row is added.
- Current V1/V2 definitions and old-shape fixture remain byte/behavior compatible.
- Source authority comes from authenticated intake context, never caller Agent strings alone.
- `secret`, `prohibited_egress`, wrong scope, ineligible `private`, and `agent_private` are fail-closed.
- Core 1.0 automatic memory dedupe is exact canonical-content identity only; paraphrases require an explicit audited merge.
- The S0 PR uses `Refs #132`; it does not close the #132 umbrella.

## Technical Context

**Language/Version**: TypeScript on Node.js 24.16.0; JSON Schema draft 2020-12 subset supported by the local validator;
Markdown and Bash for contract/runbook artifacts.

**Primary Dependencies**: Node standard library only for new code. Existing harness modules
`schema/validate.ts`, `schema/jcs.ts`, `schema/continuity.ts`, and `contract-hashes.mjs` are reused.

**Storage**: No runtime storage change. Committed JSON is the S0 machine contract; Markdown is the normative rationale and
human-readable specification.

**Testing**: `node:test`, harness TypeScript typecheck, existing schema-freeze/old-shape tests, raw-byte hash regeneration,
existing continuity mutation gate, Spec Kit verify-tasks.

**Target Platform**: Runtime-neutral contract for TypeScript/Rust. Authoring/CI validation on Linux/WSL2 and Ubuntu 24.04.

**Project Type**: Contract harness and architecture/governance documentation in the existing single repository.

**Performance Goals**: No runtime performance claim. Deterministic validation of exactly 8 source-aware cases, 4 successor
artifact schemas, 4 legacy dispositions, and the complete frozen inventory; hash/fixture outputs are byte-stable.

**Constraints**: Existing `CONTINUITY_LIMITS`; zero wrong-vault/project/workspace or denied-state automatic delivery;
zero source relabel; zero per-Agent canonical duplicate; no raw identifier in successor exported artifacts.

**Scale/Scope**: One additive bundle, 4 artifact successors, F0–F7, one inventory manifest, one focused contract test,
canonical progress-ledger synchronization, and external Issue #132 body/label synchronization.

## Constitution Check

*GATE before Phase 0 research and re-checked after Phase 1 design.*

| Principle | Pre-design | Post-design evidence |
|---|---|---|
| I. Local-First | PASS | runtime/data remain local; cloud is not changed |
| II. Zero Incremental Cost | PASS | no dependency/provider/semantic dedupe is added |
| III. Privacy Boundary | PASS | explicit sensitivity/egress/scope precedence and zero-leak F0/F7; no external security implementation lane |
| IV. Safety Boundary | PASS | caller claims cannot grant authority; ambiguous migration quarantines or stays read-only |
| V. Deterministic Gates | PASS | closed JSON Schema, exact F0–F7 set, JCS/raw-byte hashes, mutation self-checks |
| VI. Local-Only Development | USER OVERRIDE | user explicitly authorized Issue update, PR, review resolution, and merge when gates pass; no fork/tag/release |

Principle VI conflicts with the repository's current PR workflow and is tracked by #74. The direct user authorization in this
session is narrower than a constitution change: only this branch/Issue/PR and merge after required gates/reviews.

## Phase 0: Research

Complete in [research.md](research.md):

- single bundle/artifact version relationship;
- additive successor schema strategy;
- source authority/vocabulary and provenance-reference reuse;
- exact memory identity and legacy dispositions;
- F0–F7 current disposition map;
- frozen inventory searches and semantic surface split;
- existing hash/CI reuse and S0 scope fence.

No unresolved clarification remains.

## Phase 1: Design and contracts

### Data model

[data-model.md](data-model.md) defines:

- `SourceIdentityV1`, `SubjectScopeV1`, sharing/egress profiles;
- `CanonicalWorkStateV2`, `ContinuationCheckpointV3`, `ResumeCapsuleV2`, `CanonicalMemoryEntityV1`;
- lineage source summary, revision envelope/head eligibility, shared/Agent-local projections, dropped-evidence windows;
- machine inventory/corpus/9-Issue observation shapes, `RestoreSemanticValidationContractV1`,
  `RawIdentifierEvidencePolicyV1`, and legacy state transitions.

### Normative interface

[contracts/source-aware-continuity-v1.md](contracts/source-aware-continuity-v1.md) freezes vocabulary, authority,
sharing precedence, lineage semantics, memory identity, retrieval profiles, migration, diagnostics, hash inputs, and the S0
boundary. It is a successor overlay; `resume-continuity-addendum-v6.2.md` remains unchanged as the V1 contract.

### Validation guide

[quickstart.md](quickstart.md) provides focused/full contract tests, typecheck, raw-byte hash regeneration, old-shape parity,
mutation gate, scope audit, and verify-tasks commands with expected results.

## Project Structure

### Documentation and governance

```text
specs/005-continuity-p0-contract/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── source-aware-continuity-v1.md
├── checklists/
│   └── requirements.md
└── tasks.md

evidence/
├── README.md
└── adr-006-source-aware-shared-memory.md

specs/001-agent-memory-core/
├── spec.md
└── tasks.md

docs/superpowers/plans/
└── 2026-08-16-phase3-resume-preflight.md
```

### Machine contract and tests

```text
harness/schema/
├── continuity.ts
├── continuity.schema.json
├── source-aware-continuity-contract.v1.json
└── source-aware-source-inventory.v1.json

harness/fixtures/continuity/
└── source-aware-f0-f7.v1.json

harness/continuity/
├── schema-freeze.test.ts
└── source-aware-contract.test.ts

harness/contract-hashes.json
```

### Explicitly unchanged

```text
vendor/codemem/**
harness/continuity/reference-model.ts
harness/fixtures/continuity/old-shape-parity.json
harness/continuity/mutate.sh
harness/contract-hashes.mjs
.github/workflows/**
specs/001-agent-memory-core/resume-continuity-addendum-v6.2.md
```

**Structure Decision**: Extend the existing continuity TS/JSON Schema roots additively. Store the versioned bundle and
inventory manifests beside existing schema manifests, the F0–F7 corpus beside existing continuity fixtures, and one focused
test under the existing CI glob. This is fewer files and less validator code than an independent schema root.

## Implementation sequence

1. Synchronize Issue #132 and authoritative progress ledgers with the integrated S0 boundary and S1–S6 numbering.
2. Write focused tests/negative self-mutations for the missing successor definitions, manifests, inventory, and F0–F7.
3. Add the minimum TS mirror and JSON Schema needed to make those tests pass without modifying V1 definitions.
4. Add the machine inventory, contract manifest, and exact F0–F7 corpus; regenerate only `contract-hashes.json`.
5. Add ADR/index links and finish canonical gate documentation.
6. Run focused/full gates, verify tasks once, correctness/security review, Grok/Cubic/CodeRabbit where available, then
   ponytail-review; fix only validated findings.
7. Commit/push/create PR, monitor checks and review threads, and merge only after every valid finding and required gate passes.

Detailed executable steps and commit boundaries are generated in `tasks.md` by `$speckit-tasks`.

## Interface boundaries

| Producer | Output | Consumers |
|---|---|---|
| `continuity.ts` | exact readonly TS types/enums/constants | typecheck, schema-freeze, focused test, future TS runtime |
| `continuity.schema.json` | closed successor `$defs` | local validator, focused test, future Rust conformance |
| inventory manifest | frozen search metadata/classified surfaces | focused test, bundle hash, reviewers |
| F0–F7 corpus | current dispositions + successor expectations | focused test, bundle hash, future TS/Rust implementation |
| contract manifest | hashes/versions/migration rules | focused test, reviewers, future conformance |
| restore-validation rules | exact persisted artifact/scope/timestamp/authority paths | focused test, future read boundary |
| P0 observation/delta rules | exact 9-Issue inputs/paths/current/successor values | focused test, future runtime fixtures |
| raw-ID policy | no new persistence; bounded legacy quarantine access | focused test, future intake/migration |
| progress ledger | S0 start gate | #13/#1 dispatch and later implementation plans |

## Verification strategy

- Red: focused test initially fails because successor `$defs`/manifest/corpus/observation rules are absent.
- Green: add exact TS/schema/corpus/manifest fields; every in-memory negative mutation is rejected.
- Compatibility: existing old-shape baseline and full continuity tests remain unchanged and pass.
- Drift: regenerated `contract-hashes.json` matches; contract manifest recomputes JCS hash excluding itself and covers
  inventory-derived restore closure, exact 9-Issue observations, and raw-ID policy.
- Scope: no changed path under `vendor/codemem` or `.github/workflows`; no reference reducer/old-shape corpus diff.
- Completion: every checked task maps to a committed artifact and command output through verify-tasks.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Constitution VI vs push/PR/merge | Direct user authorization plus required remote CI/review evidence | Local-only cannot exercise required GitHub checks/review threads; scope remains one branch/Issue/PR, no release |
