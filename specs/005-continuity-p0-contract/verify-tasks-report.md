# Verify Tasks Report: Continuity P0 + source-aware shared memory S0

- **Date**: 2026-08-24
- **Scope**: `all`
- **Git base**: `origin/main`
- **Completed tasks inspected**: 35 (`T001`–`T035`)
- **Changed-file scope**: pre-report snapshot of 21 branch files plus the existing uncommitted `tasks.md` edit; this report
  did not exist yet and was therefore not counted as an untracked file
- **Repository**: not shallow

> ⚠️ **FRESH SESSION ADVISORY**: For maximum reliability, run `/speckit.verify-tasks`
> in a **separate** agent session from the one that performed `/speckit.implement`.
> The implementing agent's context biases it toward confirming its own work.

The asymmetric error model was applied: a doubtful completion is flagged even when the likely explanation is benign.

## Summary Scorecard

| Verdict | Count |
|---|---:|
| ✅ VERIFIED | 23 |
| 🔍 PARTIAL | 2 |
| ⚠️ WEAK | 0 |
| ❌ NOT_FOUND | 0 |
| ⏭️ SKIPPED | 10 |
| **Total** | **35** |

## Flagged Items

### T034 — 🔍 PARTIAL

| T034 | 🔍 PARTIAL | The existing mutation script is present, but no referenced file appears in the `all` changed-file set, so the claimed execution is not proven by diff evidence. |

**Task**: Run `bash harness/continuity/mutate.sh` and require executed-count agreement plus zero surviving mutations.

| Layer | Result | Evidence |
|---|---|---|
| 1 — File existence | positive | `harness/continuity/mutate.sh` exists. |
| 2 — Git diff cross-reference | negative | `harness/continuity/mutate.sh` is absent from `origin/main...HEAD`, the working-tree diff, and untracked files. |
| 3 — Content pattern | not_applicable | The task names a shell command, not a declaration expected inside the script. |
| 4 — Dead code | not_applicable | A directly executed shell gate does not require an import/call site. |
| 5 — Semantic assessment | not run | The cascade stops semantic promotion after a mechanical negative. The script was inspected but not rerun because it temporarily overwrites tracked source/fixture files, outside this audit's report-only write fence. |

**Evidence gap**: No durable command output or changed artifact proves that the mutation run completed with matching counts and zero survivors.

### T035 — 🔍 PARTIAL

| T035 | 🔍 PARTIAL | The forbidden paths exist and the scoped diff is empty, but the generic diff layer treats “none of the referenced paths changed” as negative. |

**Task**: Audit `git diff --name-only origin/main...HEAD` and require no forbidden runtime, vendor, workflow, reference-model, old-shape, mutation-script, or hash-generator change.

| Layer | Result | Evidence |
|---|---|---|
| 1 — File existence | positive | `vendor/codemem`, `.github/workflows`, `harness/continuity/reference-model.ts`, `harness/fixtures/continuity/old-shape-parity.json`, `harness/continuity/mutate.sh`, and `harness/contract-hashes.mjs` exist. |
| 2 — Git diff cross-reference | negative | None of those paths appears in `origin/main...HEAD` or the working-tree/untracked scope. This is the task's desired state, but remains a mechanical negative under the mandated cascade. |
| 3 — Content pattern | not_applicable | The task is a scope assertion, not a symbol/content assertion. |
| 4 — Dead code | not_applicable | No application symbol is introduced. |
| 5 — Semantic assessment | not run | The cascade stops semantic promotion after a mechanical negative. Supplemental command evidence: the forbidden-path diff exited 0 with no output. |

**Evidence gap**: Generic Layer 2 cannot distinguish “implementation file missing from the diff” from “forbidden path correctly unchanged.”

## Verified Items

| Task | Verdict | Summary |
|---|---|---|
| T002 | ✅ VERIFIED | ADR and evidence index exist, are branch changes, and record the single source-aware bundle decision. |
| T003 | ✅ VERIFIED | All three authoritative ledgers exist, changed, and keep runtime work gated on S0 completion. |
| T004 | ✅ VERIFIED | Focused test exists, changed, loads all required artifacts, and references the successor bundle. |
| T005 | ✅ VERIFIED | The focused test contains explicit missing-artifact assertions; current focused gate passes 12/12 after artifacts were added. |
| T006 | ✅ VERIFIED | Shared vocabulary and closed schema mirrors exist in changed files; parity/type tests reference them. |
| T007 | ✅ VERIFIED | `tsc`, schema-freeze, and focused gates are runnable; current typecheck is clean and schema-freeze passes 19/19. |
| T008 | ✅ VERIFIED | Exact US1 field/version/limit assertions exist in the changed focused test. |
| T010 | ✅ VERIFIED | TS and JSON Schema additions are additive-only (2,034 insertions, no removals), readonly/closed, and match the data model. |
| T011 | ✅ VERIFIED | Schema-freeze contains successor enum/const/field parity and passes 19/19. |
| T013 | ✅ VERIFIED | Exact US4 field/schema and F0–F7 assertions exist in the changed focused test. |
| T015 | ✅ VERIFIED | Projection, state, checkpoint, capsule, memory, raw-ID, and observation definitions exist and are parity-checked. |
| T016 | ✅ VERIFIED | Inventory exists, changed, pins baseline `cdf90f39…`, and its four search counts/digests are recomputed by the passing focused test. |
| T017 | ✅ VERIFIED | Corpus exists, changed, validates, and contains the exact ordered F0–F7 set with closed references. |
| T018 | ✅ VERIFIED | Manifest exists, changed, contains four artifact versions, exact case/issue sets, policies/rules, and a recomputable JCS hash. |
| T019 | ✅ VERIFIED | Required negative self-mutations are present and pass in the focused gate. |
| T020 | ✅ VERIFIED | Focused/schema/type gates pass and regenerated `contract-hashes.json` compares byte-for-byte equal. |
| T022 | ✅ VERIFIED | Exact migration/restore closure assertions and the required fail-closed mutations are present. |
| T024 | ✅ VERIFIED | Four legacy rules plus all 18 inventory-derived restore rules exist in manifest, TS, and closed schema. |
| T027 | ✅ VERIFIED | Exact 12-limit, diagnostic, sharing-code, and #32/#58 assertions exist. |
| T029 | ✅ VERIFIED | Limit/diagnostic types, closed schema definitions, and exact manifest values exist in branch-changed files. |
| T030 | ✅ VERIFIED | Focused/schema/type gates pass and committed raw-byte hashes regenerate without diff. |
| T032 | ✅ VERIFIED | Full continuity gate passes 345/345 and harness typecheck emits no diagnostics. |
| T033 | ✅ VERIFIED | Raw-byte hash regeneration is empty; full tests include passing old-shape parity against the unchanged pinned corpus. |

## Unassessable Items

These tasks name external operations, historical red runs, or commit actions but no local file path. All five defined layers are therefore `not_applicable`; `SKIPPED` is not a failure.

| Task | Verdict | Summary |
|---|---|---|
| T001 | ⏭️ SKIPPED | External Issue update has no local artifact path. Supplemental live read showed Issue #132 open with the S0 reconciliation, exact-memory identity, S1–S6 order, and expected labels. |
| T009 | ⏭️ SKIPPED | Historical focused red run names no local file path in the task line. |
| T012 | ⏭️ SKIPPED | Commit action names no local file path; supplemental history contains the exact signed US1 commit. |
| T014 | ⏭️ SKIPPED | Historical focused red run names no local file path in the task line. |
| T021 | ⏭️ SKIPPED | Commit action names no local file path; supplemental history contains the exact signed US4 commit. |
| T023 | ⏭️ SKIPPED | Historical focused red run names no local file path in the task line. |
| T025 | ⏭️ SKIPPED | Command-only validation names no local file path in the task line. |
| T026 | ⏭️ SKIPPED | Commit action names no local file path; supplemental history contains the exact signed US2 commit. |
| T028 | ⏭️ SKIPPED | Historical focused red run names no local file path in the task line. |
| T031 | ⏭️ SKIPPED | Commit action names no local file path; supplemental history contains the exact signed US3 commit. |

## Verification Evidence

- `node --experimental-strip-types --test harness/continuity/source-aware-contract.test.ts`: 12 passed, 0 failed.
- `node --experimental-strip-types --test harness/continuity/schema-freeze.test.ts`: 19 passed, 0 failed.
- `vendor/codemem/node_modules/.bin/tsc -p harness/tsconfig.json`: exit 0, no diagnostics.
- `node --experimental-strip-types --test harness/continuity/*.test.ts`: 345 passed, 0 failed.
- `cmp -s harness/contract-hashes.json <(node harness/contract-hashes.mjs)`: exit 0.
- Forbidden-path diff: exit 0, no output.
- Audit commands introduced no additional worktree change; the pre-existing uncommitted edit remains limited to `specs/005-continuity-p0-contract/tasks.md` before this report was written.

## Walkthrough Log

| Task | Disposition | Evidence |
|---|---|---|
| T034 | Investigated — live verified | Controller-observed execution in this worktree completed successfully: `実行 218 / 期待 218、生存 0`; restored baseline then passed `220 / 220` with `fail 0`. Original `🔍 PARTIAL` audit verdict remains immutable. |
| T035 | Investigated — live verified | The complete `origin/main...HEAD` list contains 21 paths and none is under `vendor/codemem/**` or `.github/workflows/**`, nor is it the reference reducer, actual old-shape corpus `harness/fixtures/continuity/old-shape-parity.json`, mutation script, or hash generator. The controller-observed forbidden-path filter also exited 0 with zero output. Original `🔍 PARTIAL` audit verdict remains immutable. |

## Post-review Evidence Refresh

The scorecard above is the immutable fresh-session snapshot taken before correctness/security review. After resolving the
review findings, the controller reran the affected and full gates:

- focused source-aware contract: 19 passed, 0 failed;
- schema freeze: 19 passed, 0 failed;
- full continuity suite: 352 passed, 0 failed;
- harness TypeScript: exit 0, no diagnostics;
- generated contract hashes: empty diff;
- regenerated old-shape baseline: 20 cases / 29 steps, empty diff;
- mutation gate: `実行 218 / 期待 218、生存 0`; restored baseline `pass 220 / fail 0`;
- current external-review fix scope: 13 modified tracked paths including this report, with no untracked, runtime, vendor,
  workflow, V1 reference reducer, old-shape corpus, mutation script, or hash-generator change.

### T005 durable red reproduction

To make the historical red step durable, the controller created a detached disposable worktree at `f2d1bb0`, temporarily
moved only `harness/schema/source-aware-continuity-contract.v1.json` aside there, and ran the focused test with
`--test-name-pattern='source-aware S0 machine artifacts exist before contract validation'`. It exited 1 with exactly one
failed test and the assertion `source-aware contract manifest is missing` (`pass 0 / fail 1`). The artifact was restored and
the disposable worktree removed. This proves T005's expected failure is the missing contract artifact, not parser/setup
failure; the original `VERIFIED` row now has durable supporting evidence.
