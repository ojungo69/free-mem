# Tasks: Continuity P0 + source-aware shared memory S0

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/source-aware-continuity-v1.md](contracts/source-aware-continuity-v1.md)

**Tests**: TDD is required. Every red task must fail for the named missing contract/invariant before its paired green task.

**Scope fence**: No task may modify `vendor/codemem/**`, `harness/continuity/reference-model.ts`,
`harness/fixtures/continuity/old-shape-parity.json`, `harness/continuity/mutate.sh`,
`harness/contract-hashes.mjs`, or `.github/workflows/**`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: safe to execute in parallel because files and state do not overlap
- **[Story]**: maps to the numbered user story in `spec.md`

## Phase 1: Setup and authoritative dispatch

**Purpose**: Make the GitHub and repository ledgers point to the approved single-bundle S0 before schema work starts.

- [X] T001 Update GitHub Issue #132 body and labels with the spec 005 integration, S0 migration-disposition-only boundary, exact-memory identity, and consistent S1–S6 numbering; verify with `gh issue view 132 --repo ojungo69/free-mem`
- [X] T002 Create the source-aware decision record in `evidence/adr-006-source-aware-shared-memory.md` and add its index entry to `evidence/README.md`
- [X] T003 Update the S0 start gate without marking runtime work complete in `specs/001-agent-memory-core/spec.md`, `specs/001-agent-memory-core/tasks.md`, and `docs/superpowers/plans/2026-08-16-phase3-resume-preflight.md`

**Checkpoint**: #132 and every authoritative local ledger say `SourceAwareContinuityContractV1` blocks persisted
state/checkpoint, cross-agent renderer, and source-filter runtime work.

---

## Phase 2: Foundational contract-test scaffold

**Purpose**: Establish one focused executable gate before adding any successor contract definition.

- [X] T004 Create `harness/continuity/source-aware-contract.test.ts` with loaders for `continuity.schema.json`, the contract manifest, inventory manifest, and F0–F7 corpus; reference `SourceAwareContinuityContractV1` so the test is red while those artifacts are absent
- [X] T005 Run `node --experimental-strip-types --test harness/continuity/source-aware-contract.test.ts` and record the expected failure as missing source-aware contract artifacts, not a parse/setup failure
- [X] T006 Add only shared scalar/enumeration constants and their closed JSON Schema mirrors (`CanonicalClientIdV1`, sharing/egress/resume/migration enums, SHA/opaque ID patterns) in `harness/schema/continuity.ts` and `harness/schema/continuity.schema.json`; add compile-time/runtime parity mappings in `harness/continuity/schema-freeze.test.ts`
- [X] T007 Run `vendor/codemem/node_modules/.bin/tsc -p harness/tsconfig.json` and `node --experimental-strip-types --test harness/continuity/schema-freeze.test.ts`; both must pass while the focused contract test remains red only for missing successor artifacts

**Checkpoint**: Common contract vocabulary is closed and reusable; no V1 definition changed.

---

## Phase 3: User Story 1 — immutable ordered successor state (Priority: P1)

**Goal**: Freeze the successor revision/ordering/observed/operation/evidence-window primitives without implementing the reducer.

**Independent Test**: The focused test validates the revision/state primitives and `RevisionHeadSelectionContractV1`, and
kills mutations that restore mutable arrays, caller ordering, old-revision fallback, raw IDs, or a shared dropped-evidence FIFO.

- [X] T008 [US1] Add failing exact-field/version/readonly/limit assertions for `OpaqueIdProfileV1`, `SubjectScopeV1`, `TaskStateRevisionEnvelopeV1`, `RevisionHeadSelectionContractV1`, Observed/operation V2 shapes, and per-reason dropped-evidence windows in `harness/continuity/source-aware-contract.test.ts`
- [X] T009 [US1] Run the focused test and verify it fails because the named successor `$defs` and TS exports do not exist
- [X] T010 [US1] Implement the minimum readonly TS revision/observed/operation/evidence-window interfaces/constants in `harness/schema/continuity.ts` and closed JSON Schema `$defs` in `harness/schema/continuity.schema.json` exactly as `data-model.md` defines, including ordered-head/manual-fallback eligibility; leave all V1 exports byte-for-byte unchanged
- [X] T011 [US1] Extend `harness/continuity/schema-freeze.test.ts` with exact enum/const/field-set parity for the new US1 definitions and run focused schema/type tests to green
- [X] T012 [US1] Commit the US1 contract slice with sign-off: `git commit -s -m "feat(contract): freeze successor state primitives"`

**Checkpoint**: Successor state primitives are machine-readable, deterministic, immutable by contract, and V1 parity passes.

---

## Phase 4: User Story 4 — provenance-preserving cross-agent sharing (Priority: P1)

**Goal**: Freeze source identity, projection, checkpoint/capsule, canonical memory, inventory, and F0–F7 as one bundle.

**Independent Test**: F0–F7 is the exact ordered set; F0/F7 leak zero denied records, F2 never relabels,
F3 produces origin/last/participants/creator separately, F4 has one entity/two source branches, F5 has four profiles,
F6 uses authenticated source rather than caller claim, and raw IDs are never persisted/exported/egressed.

- [X] T013 [US4] Add failing TS/JSON Schema parity and F0–F7 invariant assertions for `SourceIdentityV1`, `LineageSourceSummaryV1`, `SharedTaskStateV1`, `AgentLocalStateV1`, `CanonicalWorkStateV2`, `ContinuationCheckpointV3`, `ResumeCapsuleV2`, `CanonicalMemoryEntityV1`, `RawIdentifierEvidencePolicyV1`, and `ContinuityP0ObservationContractV1` in `harness/continuity/source-aware-contract.test.ts`
- [X] T014 [US4] Run the focused test and verify failures name missing source/projection/checkpoint/capsule/memory definitions and absent F0–F7 artifacts
- [X] T015 [US4] Implement the minimum readonly TS projection/final-state/checkpoint/capsule/memory definitions/constants in `harness/schema/continuity.ts`, including `CanonicalWorkStateV2`, raw-ID policy and P0 observation/delta types, their closed `$defs` in `harness/schema/continuity.schema.json`, and exact parity mappings in `harness/continuity/schema-freeze.test.ts`
- [X] T016 [US4] Create `harness/schema/source-aware-source-inventory.v1.json` from the frozen `cdf90f39f642753a9d72297e3fad41c0deeaaafd` searches, with each candidate group carrying exactly one surface class/disposition and a reproducible result count/digest; every persisted restore target gets its own entry with `restoreValidationRequired` and schema-definition/SQL-table identity
- [X] T017 [US4] Create `harness/fixtures/continuity/source-aware-f0-f7.v1.json` with common closed case shapes, exact current V1 disposition/reason mapping, valid references, and successor expectations for all eight cases
- [X] T018 [US4] Create `harness/schema/source-aware-continuity-contract.v1.json` with artifact versions, raw schema/inventory/corpus hashes, exact F0–F7 IDs, exact 9-Issue observation/delta entries, ordered-head/manual-fallback rule, raw-ID policy, migration/restore-rule slots, opaque-ID profile, and JCS `contractHash` excluding itself
- [X] T019 [US4] Complete `harness/continuity/source-aware-contract.test.ts` reference-integrity and negative self-mutations: remove F7, remove one P0 Issue entry, authorize the F6 claim, leak a denied F7 record, remove one F4 source branch, or allow raw diagnostic/export; each mutation must be rejected
- [X] T020 [US4] Run focused test, schema-freeze test, and harness typecheck to green; regenerate `harness/contract-hashes.json` only after all three versioned JSON artifacts are stable
- [X] T021 [US4] Commit the US4 contract slice with sign-off: `git commit -s -m "feat(contract): freeze source-aware sharing"`

**Checkpoint**: Source-aware S0 is a closed, hashed, expected-current-failure contract corpus; no runtime path changed.

---

## Phase 5: User Story 2 — safe legacy restore disposition (Priority: P2)

**Goal**: Freeze migration/read-only/quarantine decisions without DDL, data rewrite, or runtime readers.

**Independent Test**: The contract manifest contains exactly one rule for all four legacy artifact kinds and every
inventory-derived persisted restore target; unresolved state/checkpoint/capsule never auto-migrates, unresolved memory never
enters automatic cross-agent delivery, and blank/invalid timestamp artifacts quarantine before use.

- [X] T022 [US2] Add failing exact-set assertions for the four legacy migration rules and every inventory entry marked persisted plus `restoreValidationRequired`; add negative mutations that add an unruled persisted artifact, remove an identity/timestamp path, accept blank scope, or allow unaudited daemon/model repair in `harness/continuity/source-aware-contract.test.ts`
- [X] T023 [US2] Run the focused test and verify it fails on incomplete migration/restore validation rules rather than unrelated fixture validation
- [X] T024 [US2] Add exact verified/unresolved migration rules plus inventory-referenced `RestoreSemanticValidationContractV1` scope-identity, ISO timestamp, cross-field, quarantine, user-authority, and audit rules to `harness/schema/source-aware-continuity-contract.v1.json`, with matching types/schema in `harness/schema/continuity.ts` and `harness/schema/continuity.schema.json`
- [X] T025 [US2] Run focused/schema/type tests to green; confirm `ResumeCapsuleV1` is always legacy-read-only when verified, invalid artifacts quarantine before reducer/selector use, and repair/rebind/discard is user-authorized plus audited
- [X] T026 [US2] Commit the US2 migration-contract slice with sign-off: `git commit -s -m "feat(contract): freeze legacy dispositions"`

**Checkpoint**: Every old artifact has one fail-closed disposition and no runtime migration exists in the diff.

---

## Phase 6: User Story 3 — enforced-limit and diagnostic vocabulary contract (Priority: P3)

**Goal**: Freeze all 12 limit policies and make excluded terminal siblings observable in the successor vocabulary.

**Independent Test**: The manifest has exactly 12 policies: `rankedCandidates=select_with_diagnostic`, the other
11 `reject`; successor diagnostics contain current codes plus `terminal_sibling_conflict`, the 9 sharing disposition codes,
and the exact P0 observation set still contains the #32/#58 policy/diagnostic deltas.

- [X] T027 [US3] Add failing exact-set assertions for 12 limit policies, `ContinuityDiagnosticCodeV2`, `SourceSharingDispositionCodeV1`, and the #32/#58 entries plus exact nine-Issue closure in `ContinuityP0ObservationContractV1` in `harness/continuity/source-aware-contract.test.ts`
- [X] T028 [US3] Run the focused test and verify it fails for missing policy/diagnostic vocabulary
- [X] T029 [US3] Add the limit-policy and diagnostic constants/types to `harness/schema/continuity.ts`, closed schema definitions to `harness/schema/continuity.schema.json`, and exact values to `harness/schema/source-aware-continuity-contract.v1.json`
- [X] T030 [US3] Run focused/schema/type tests to green and regenerate `harness/contract-hashes.json`
- [X] T031 [US3] Commit the US3 contract slice with sign-off: `git commit -s -m "feat(contract): freeze limits and diagnostics"`

**Checkpoint**: Layer C is executable as a contract and still contains no delivery/runtime implementation.

---

## Phase 7: Cross-cutting validation, review, PR, and merge

**Purpose**: Prove compatibility, scope, task truth, review quality, and remote merge readiness.

- [X] T032 Run the focused gate, full `harness/continuity/*.test.ts`, and `vendor/codemem/node_modules/.bin/tsc -p harness/tsconfig.json` as listed in `specs/005-continuity-p0-contract/quickstart.md`
- [X] T033 Regenerate to temporary files and diff `harness/contract-hashes.json` plus `harness/fixtures/continuity/old-shape-parity.json`; both diffs must be empty
- [X] T034 Run `bash harness/continuity/mutate.sh` and require executed count match plus zero surviving mutations
- [X] T035 Audit `git diff --name-only origin/main...HEAD` and require no changed path under `vendor/codemem`, `.github/workflows`, the reference reducer, old-shape corpus, mutation script, or hash generator
- [X] T036 Run the installed `speckit.verify-tasks.run` extension exactly once in a fresh verification pass; fix every phantom completion before leaving tasks checked
- [X] T037 Run the correctness/security code-review gate on the full branch diff and adopt only source-verified findings; rerun affected focused/full tests
- [ ] T038 Run Grok review plus Cubic and CodeRabbit local/PR review for this important schema/security change; resolve or explicitly reject every validated finding with evidence
- [ ] T039 Run `ponytail-review` after correctness reviews, remove only duplicated schema/config/abstraction that is not required, and rerun affected gates
- [ ] T040 Push `spec/005-continuity-p0-contract`, create a PR whose body says `Refs #132` and lists the 9 Continuity P0 issues without closing the umbrella, then record focused/full verification evidence
- [ ] T041 Monitor `gh pr checks`, unresolved review threads, CodeRabbit/Codacy/CodeQL/Sonar/Quality Gate, and apply valid review findings through the full review order until all required gates are green
- [ ] T042 Merge the PR only after required checks are green, unresolved valid threads are zero, review gates remain satisfied, and post-merge `main` plus Issue/PR states are live-verified

---

## Dependencies & Execution Order

```text
Phase 1 dispatch sync
  -> Phase 2 test scaffold/common vocabulary
  -> US1 successor state
  -> US4 source-aware bundle/corpus
  -> US2 migration dispositions
  -> US3 limits/diagnostics
  -> full validation/review/PR/merge
```

- US1 and US4 are both P1, but they write the same schema/test files and must execute sequentially in one worktree.
- US2 depends on the US4 contract manifest.
- US3 depends on the same manifest and runs after US2 to avoid concurrent edits.
- Documentation-only research was parallelizable; implementation tasks are intentionally single-writer.

## Parallel Opportunities

- T002 and T003 touch different documentation files but both carry authority decisions; keep them serial under the primary agent.
- After a red test is committed, read-only reviewers may inspect the diff in parallel.
- No `[P]` implementation task is declared because all schema stories share `continuity.ts`, `continuity.schema.json`, and the focused test.

## Implementation Strategy

### MVP

The minimum reviewable S0 is Setup + Foundation + US1 + US4. It proves the single successor bundle and F0–F7 without
runtime changes. US2/US3 must still complete before the integrated contract PR is mergeable because they are part of the
same bundle/hash.

### Commit boundaries

1. Planning/spec artifacts (before implementation).
2. US1 successor work-state schema.
3. US4 source-aware bundle/inventory/corpus.
4. US2 legacy dispositions.
5. US3 limits/diagnostics and final generated hashes/docs.
6. Review fixes, one signed commit per coherent finding batch.

## Notes

- A task is checked only after its named file and command evidence exist.
- `contract-hashes.json` is generated; never hand-edit hashes.
- F0–F7 current `unsupported/unsafe` is an expected failure disposition, not successor conformance.
- Review tools provide proposals; source, compiler, deterministic tests, and frozen requirements are authoritative.
