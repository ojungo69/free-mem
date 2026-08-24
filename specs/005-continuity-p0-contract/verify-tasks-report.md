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
| T035 | Investigated — live verified | The sorted deduplicated union of committed branch, unstaged, staged, and untracked paths contains 22 paths and none is under `vendor/codemem/**` or `.github/workflows/**`, nor is it the reference reducer, actual old-shape corpus `harness/fixtures/continuity/old-shape-parity.json`, mutation script, hash generator, or v6.2 addendum. The controller-observed forbidden-path filter exited 0 with zero output. Original `🔍 PARTIAL` audit verdict remains immutable. |

## Post-review Evidence Refresh

The scorecard above is the immutable fresh-session snapshot taken before correctness/security review. After resolving the
review findings, the controller reran the affected and full gates:

- focused source-aware contract: 21 passed, 0 failed;
- schema freeze: 19 passed, 0 failed;
- full continuity suite: 354 passed, 0 failed;
- harness TypeScript: exit 0, no diagnostics;
- generated contract hashes: empty diff;
- regenerated old-shape baseline: 20 cases / 29 steps, empty diff;
- mutation gate: `実行 218 / 期待 218、生存 0`; restored baseline `pass 220 / fail 0`;
- first external-review fix snapshot before `014631b`: 13 modified tracked paths including this report, with no untracked, runtime, vendor,
  workflow, V1 reference reducer, old-shape corpus, mutation script, or hash-generator change.

### T005 durable red reproduction

To make the historical red step durable, the controller created a detached disposable worktree at `f2d1bb0`, temporarily
moved only `harness/schema/source-aware-continuity-contract.v1.json` aside there, and ran the focused test with
`--test-name-pattern='source-aware S0 machine artifacts exist before contract validation'`. It exited 1 with exactly one
failed test and the assertion `source-aware contract manifest is missing` (`pass 0 / fail 1`). The artifact was restored and
the disposable worktree removed. This proves T005's expected failure is the missing contract artifact, not parser/setup
failure; the original `VERIFIED` row now has durable supporting evidence.

## External Review Dispositions

All review output was treated as a proposal and checked against source/tests.

| Engine / round | Disposition | Source-verified result |
|---|---|---|
| Grok security 1 | Blocked by timeout | Runner exited 124 with no session/envelope; retried once on the high-risk machine paths as required. |
| Grok security 2 | Clean | `ok:true`, zero findings; session `01a033a1-0c93-7721-955d-757e960e8320`. |
| Cubic 1 — successor restore rules absent | Rejected | Manifest already contained work-state V2, checkpoint V3, capsule V2, memory V1, and SharingDecision V1 rules; inventory-derived closure passed. |
| CodeRabbit 1 — durable-memory paths need `/` | Rejected | Those entries are SQL columns, not JSON Pointers; the mixed path/column format is explicitly normative. |
| CodeRabbit 1 — remaining 14 | Accepted | Clarified F6 claim, specialized observed strings, indexed successor entities, completed enum parity, corrected report/scope commands, froze receipt identity, checkpoint/memory hashes, corruption output, private meaning, T005 evidence, S0 prohibited paths, lane keys, and opaque-ID derivation. |
| Cubic 2 — project boundary | Accepted | `project_shared` memory vector now has an exact project subject scope. |
| Cubic 2 — generic privacy precedence | Accepted | Automatic delivery rejects any record name for secret, non-eligible egress, wrong scope/source, ineligible private, missing capability, or invalid consent. |
| Cubic 2 — split continuity module | Rejected | Existing authority is one additive `continuity.ts` / one schema mirror; splitting adds re-export/ownership drift without a second runtime implementation. |
| Cubic 2 — split focused suite | Rejected | One focused bundle test intentionally verifies cross-artifact hashes/closure; splitting would duplicate setup and weaken atomic bundle review. |
| Cubic 2 — generate parity descriptors | Rejected | The independent handwritten third point is deliberate: generating it from either authority would stop detecting coordinated drift. |
| CodeRabbit 2 — `uniqueItems` | Rejected | The local schema validator rejects unsupported `uniqueItems`; exact arrays are pinned by semantic/hash and schema-freeze assertions. |
| CodeRabbit 2 — CI fetch depth | Rejected | The continuity CI checkout already uses `fetch-depth: 0`; the frozen baseline commit is available. |
| CodeRabbit 2 — Git object IDs | Accepted | Repository heads now use `GitObjectIdV1` and test both SHA-1 and SHA-256 object IDs. |
| CodeRabbit 2 — V1 history/updatedAt ambiguity | Accepted | FR-005/007 and SC-003 now distinguish V1 comparison fields from successor receipt/audit/watermark authorities. |
| CodeRabbit 2 — checklist wording | Accepted | Checklist exceptions name the mandated cross-runtime contract target rather than claiming zero technical vocabulary. |
| CodeRabbit 2 — policy-mismatched memory union | Accepted | Automatic evidence union requires an exact sharing/sensitivity/egress tuple; F4/F7 carry policy-conflict negatives. |
| CodeRabbit 2 — plan completion wording | Accepted | File-level `VERIFIED`, `SKIPPED`, live evidence, history evidence, and checked-task state are no longer conflated. |
| CodeRabbit 2 — sensitivity aggregation | Accepted | A closed max-sensitivity policy and fail-closed tests cover shared, Agent-local, canonical, and capsule projections. |
| Grok security 3 | Blocked by max-turns | No schema-conforming final result. Two trace candidates were independently source-verified and accepted: explicit `d:`/`f:` receipt namespaces and a domain-separated persisted-capsule content hash/tamper gate. No further Grok retry was run after the skill stop condition. |
| Cubic 3 — fabricated decision IDs | Accepted | Capsule and memory resolvers now load the referenced SharingDecision, verify its own ID, authenticated user authority, exact scope/target/scope level, and reject substitution. |
| CodeRabbit 3 — opaque-kind cardinality comment | Accepted | Schema now documents that 26 comes from the exact type/runtime vocabulary. |
| CodeRabbit 3 — colon paths in git grep | Accepted | Candidate parsing now uses NUL-delimited git output and one shared helper. |
| CodeRabbit 3 — checkpoint parent pairing | Accepted with supported schema form | The local validator does not support `dependentRequired`; two supported `if/then` clauses enforce both directions. |
| CodeRabbit 3 — FR-007 committedAt | Accepted | State-neutral events reuse the existing envelope/time; only semantic state changes issue a new daemon-owned time. |
| CodeRabbit 3 — all-path `local_only` denial | Accepted | Generic semantic validation covers retrieval, RPC/hint, automatic/resume, capsule/sync/export profiles independent of record names. |
| CodeRabbit 3 — scope inspection failures | Accepted | The documented gate uses `set -euo pipefail` and sequential Git writes before forbidden-path matching, so Git failures cannot become a clean result. |
| Cubic 4 — split module/suite/generated descriptors | Rejected | Same three architectural preferences as round 2; no concrete regression, and they conflict with the deliberate single-bundle/independent-parity design. |
| CodeRabbit 4 — opaque-kind cardinality comment | Accepted | Added the exact-vocabulary cardinality comment. |
| CodeRabbit 4 — colon-safe inventory paths | Accepted | NUL-delimited parsing now supports Git paths containing `:`. |
| CodeRabbit 4 — checkpoint parent dependency | Accepted with supported schema form | Bidirectional `if/then` pairing is enforced because the local validator intentionally rejects `dependentRequired`. |
| CodeRabbit 4 — FR-007 revision time | Accepted | State-neutral reuse preserves the existing envelope and time; only semantic changes issue a new one. |
| CodeRabbit 4 — local-only precedence | Accepted | FR-035, SC-015, F7, docs, and generic all-profile tests now agree. |
| CodeRabbit 4 — quickstart status handling | Accepted | Hash/old-shape failures propagate; scope matching distinguishes match 0, no-match 1, and execution errors. |

## Final simplification review

`ponytail-review` returned `Lean already. Ship.` No contract-required schema, configuration, or abstraction was removed.

## Final pre-PR verification — 2026-08-24

- Focused source-aware contract: 21 passed, 0 failed.
- Full continuity suite: 354 passed, 0 failed.
- Harness TypeScript: no diagnostics.
- Generated contract hashes: empty diff.
- Old-shape baseline: 20 cases / 29 steps, empty diff.
- Existing reducer mutation gate: 218 executed / 218 expected, 0 survivors; restored suite 220 passed, 0 failed.
- Scope gate and `git diff --check`: no forbidden path and no whitespace error.
- Whole-diff correctness/security reviews: no findings. Final `ponytail-review`: `Lean already. Ship.`

## Pull request

- [PR #133](https://github.com/ojungo69/free-mem/pull/133) uses `Refs #132`, lists the nine Continuity P0 observations without closing them, and leaves the umbrella Issue #132 open for S1–S6.

## PR #133 review follow-up

| Reviewer / finding | Disposition | Evidence / correction |
|---|---|---|
| Codacy — dynamic inventory `RegExp` | Rejected | Fixed committed inventory JSON and pinned-baseline `git grep` are the only producer/input; precompiling does not mitigate ReDoS, and a 20-literal mirror would duplicate the machine source of truth. Tracked as advisory scanner policy in #64. |
| Codacy — extract two closed-shape loops | Rejected | The trial removed 12 lines and added 13 while moving each user-story invariant away from its test; no third caller exists. |
| Codex — F0 private-only state cannot persist | Accepted | Shared projection remains grant-bearing but becomes optional; state/capsule require at least one projection, and local-only capsule is same-agent only. |
| Codex — nested field/memory provenance is not resolved | Accepted | Every shared/local nested source path is pinned; source refs resolve to authenticated identity, lane refs match client/session, and memory snapshots are hash-valid and same-memory bound. |
| Codex — dropped-evidence counters/boundaries are unchecked | Accepted | Window arithmetic, aggregate sums, empty/non-empty boundaries, and retained ordinal min/max are executable invariants with negative mutations. |
| Codex — capsule-owned `privateEligible` can self-authorize | Accepted | Eligibility moved to authenticated `SourceIdentityV1`; capsule destination and F0–F7 destination selector no longer own the boolean. |
| Security re-review — capsule hash is not parent authority | Accepted | Rehashed capsule projections must equal the resolved checkpoint/work-state revision; valid-source tampering is rejected. |
| Security re-review — local-only capsule bypasses deny precedence | Accepted | `secret`, `local_only`, and `prohibited_egress` are executable denials for every included projection, including same-agent local-only capsules. |
| Correctness re-review — omitted projection has no cross-runtime oracle | Accepted | Manifest now pins local-only state and capsule vectors; absent optional members are omitted, never encoded as `null`. |
| Correctness re-review — private test declared sensitivity without private content | Accepted | The positive fixture now contains an authenticated private observed value and a matching rehashed parent state. |
| CodeRabbit first PR attempt | Tool-limited | Manual full review was triggered as required for a 0-star public repository, but the service reported the OSS review limit. Four earlier local CodeRabbit rounds are dispositioned above; no gate or scanner scope was weakened. |
| Security re-review — private Agent-local capsule bypasses eligibility | Accepted | The authenticated destination private gate now applies to every included projection, including same-agent local-only. |
| Correctness re-review — destination/authority authentication not universal | Accepted | Every case requires the selected destination and successor authority to be the same authenticated source. |
| Security re-review — rehashed authorization metadata is accepted | Accepted | The full non-projection envelope is bound to the persisted delivery claim; incompatible reconciliation cannot produce a capsule. |
| Cubic — local-only sensitivity was not executable | Accepted | Aggregation now handles absent shared projections and rejects lowered canonical/checkpoint sensitivity. |
| Cubic — TS type allowed zero projections | Accepted | State/capsule TS mirrors are closed unions matching the JSON Schema at-least-one projection rule. |
| Cubic — destination policy fields were optional on fixture sources | Accepted | Every fixture source now carries the authenticated eligibility/capability profile; the destination remains only a source selector. |
| Cubic — split the contract models into modules | Rejected | Repeated architectural preference without a concrete correctness failure; S0 intentionally keeps one independently runnable parity gate and adds no new production/reference-model module. |
| Correctness final — ADR omitted `local_only` precedence | Accepted | The ADR precedence diagram now matches the normative all-path deny rule. |
| Security final — evidence-only sharing decision could be unauthenticated | Accepted | Every referenced sharing decision is authenticated before delivery, review-lane preservation, or canonical-memory evidence union. |
| Codex final — destination capability profile could be absent/unsupported | Accepted | Shared capsules require a capability hash resolving to `shared-task-v1`; same-agent local-only remains profile-optional. |
| Codex final — F5 lacked an independent wrong-workspace negative | Accepted | F5 now carries same-project/wrong-workspace data and all four retrieval profiles reject injected leakage. |
| Codex final — nested successor JSON was mutable in TypeScript | Accepted | Successor JSON surfaces use a recursive readonly type; `ObservedV2<{ nested: string[] }>` also rejects nested mutation in the compile-only gate. |
| Codex final — capsule trusted declared sensitivity | Accepted | Contained sensitivity is recomputed for shared/local projections before private/secret delivery policy. |
| Codex final — lineage summary was only ID-authenticated | Accepted | Restored lineage must equal the summary derived from append-only event/revision evidence; four authenticated rehash mutations fail. |
| Codex final — parent revisions were not sorted unique | Accepted | Parent revision sets are checked before hash/publication; duplicate and reordered rehash mutations fail. |
| Codex final — sharing authority was ID-only | Accepted | Resolved user-event action/scope/sharing scope/target/time payload must equal the persisted decision in shared and memory paths. |
| CodeRabbit final — memory policy tuple wording | Accepted | ADR, research, and clarification now separate fact identity from exact policy-tuple union eligibility and review-lane mismatch. |
| CodeRabbit final — checklist next-stage text was stale | Accepted | Checklist now records plan/tasks complete and PR review/merge stage while retaining Principle VI/#74. |
| CodeRabbit final — SC-020 under-described hash inputs | Accepted | SC-020 references the complete normative §14 manifest-minus-hash input set. |
| Security post-final — generic `ObservedV2<T>` preserved mutable `T` | Accepted | `ObservedV2.value` applies a recursive readonly transform to `T`; the compile-only regression instantiates a mutable nested array and proves `push` is rejected. JSON Schema keeps the existing `JsonValue` because mutability is TypeScript-only. |
| Correctness post-final — participant ordering had two authorities | Accepted | Participant refs are authenticated individually while the append-only evidence oracle remains the ordering authority: first substantive event per client, sorted by resolved client ID. A valid client-ordered/reverse-opaque-ID case passes and a reordered derived summary fails. |
| Cubic post-final — evidence paths were traversed twice | Accepted | Shared and Agent-local evidence are each enumerated once, then reused for source-reference and contained-sensitivity checks. |
| Cubic post-final — split the focused contract suite | Rejected | Repeated architectural preference without a correctness defect; one S0 suite deliberately checks the atomic cross-artifact hash/semantic bundle. |
| Ponytail post-final — redundant schema alias and one-call helpers | Accepted | Removed the validation-identical readonly JSON Schema alias and one-call lineage/parent helpers; reused the profileless source fixture. Final Ponytail re-review: `Lean already. Ship.` |
| Cubic previous final rerun | Tool timeout | The local review exceeded the five-minute window and was interrupted; it emitted an empty `issues` array with `Review interrupted`, so no clean verdict was claimed. The preceding completed Cubic round's two concrete findings were fixed and its module-split preference was explicitly rejected. |
| Cubic final — authority payload oracle was circular | Accepted | Authenticated authority events are now independently constructed fixtures; the validator compares their complete payload with the persisted decision rather than building the positive event from that decision. |
| Cubic final — lineage expectation was supplied, not derived | Accepted | The parent now carries append-only event/revision evidence; the oracle derives origin, current-revision contributor, and first substantive participant per resolved client before comparing the complete summary. |
| Cubic clean rerun | Clean | `cubic review -j` exited 0 with an empty `issues` array after both independence fixes. |
| Grok final full diff | Tool timeout | Read-only runner exited 124 before creating a session or structured result. Per the skill, one path-scoped retry followed. |
| Grok final scoped retry | Tool-limited | The retry reached max turns and returned no structured review result, so no clean verdict is claimed and no further retry was run. Its raw trace candidates were independently checked against source. |
| Grok raw candidate — checkpoint parent pairing only existed in JSON Schema | Accepted | `ContinuationCheckpointV3` is now a TypeScript union matching the schema: no parent fields or both parent ID/revision. Compile-only single-field assignments fail. |
| Grok raw candidate — recursive readonly loses optional fields | Rejected | Mapped types preserve optional modifiers; a compile-only `ObservedV2<{ nested?: string[] }>["value"] = {}` passes while nested `push` fails. |
| Grok raw candidate — JSON Schema must encode readonly | Rejected | JSON Schema has no mutability semantics; runtime shape remains `JsonValue`, while TypeScript owns recursive readonly and S1 owns clone/freeze. |
| Codex latest — private projection reused a normal grant | Accepted | `SharingDecisionV1` and the independently authenticated user event now bind required `privateConsent`; private shared/memory delivery requires `true` in addition to destination eligibility. F7 and direct capsule/memory regressions cover false/true and payload mismatch. |
| Codex latest — selected memories bypassed delivery policy | Accepted | Capsule validation requires sorted-unique selected IDs resolving to hash-valid canonical memories, then reuses sharing/source/snapshot checks and enforces scope containment, lifecycle, sensitivity, egress, private eligibility, and Agent-private isolation. |
| Codex latest — checkpoint ID was not owned by the resolved revision | Accepted | The resolved checkpoint carries independent ID and creator; capsule ID/revision/creator/work-state must all bind to it even when the attacker recomputes the capsule hash and persisted envelope. |
| Codex latest — nested ingest attestation remained mutable | Accepted | The successor identity uses a readonly legacy-attestation view; compile-only mutations of channel, time, receipt ID, and peer identity all fail while the mutable legacy event type remains unchanged. |
| Correctness/Cubic latest — selected-memory containment ignored branch identity below workspace | Accepted | Scope containment now compares an optional container `branchKey` for branch/task/session/turn scopes; a task-lineage memory on branch A cannot select into branch B or an unbranched capsule. |
| Correctness latest — private Agent-private selected memory lacked consent authority | Accepted | `SharingDecisionV1` intentionally grants only task/project/personal scopes, so private Agent-private memory remains daemon-local and is rejected from capsules even for an eligible same-agent destination. |
| Cubic latest — privateConsent required without a version bump | Rejected | `SharingDecisionV1` is introduced for the first time by this unmerged S0 PR; no persisted V1 decision exists to migrate. The field is being frozen before the first merge, while actual legacy artifacts retain their separate dispositions. |
| Cubic latest final rerun | Tool timeout | The post-fix local review was interrupted at the five-minute limit with an empty `issues` array and `Review interrupted`; no clean verdict is claimed. Its preceding concrete branch finding was fixed and independently re-reviewed clean. |
| CodeRabbit latest — DecimalString regex broke its Markdown table | Accepted | Escaped the regex alternation pipe inside the table cell without changing the normative expression; `git diff --check` remains clean. Local `markdownlint-cli2` was unavailable, so the current PR lint/check is the remote verifier. |
| Codex latest — F0–F7 collapsed event evidence to source identity | Accepted | Input record event IDs are non-empty/nonblank/sorted unique and preserved exactly in successor record evidence, canonical-memory unions, and review candidates. Removal, substitution, duplicate, blank, and unsorted mutations fail. |
| Codex latest — empty Agent-private owner passed vacuously | Accepted | Canonical memory now has a non-empty source-event tuple in TS/schema/common semantic validation; same-agent selected-memory tests cover empty, unresolved/wrong-client, and authenticated-owner cases. |
| Codex latest — hash transition tuple was only an enum set | Accepted | Checkpoint and canonical-memory profiles use exact JSON `const ["initial","parent"]`; duplicate and reversed tuples fail schema and semantic mutation checks. |
| Cubic latest — comma-bearing evidence IDs collided under `join()` | Accepted | Ordered evidence/source comparisons now use one length-and-element helper; a schema-valid one-element `event-a,event-b` versus two-element `event-a`/`event-b` mutation is rejected. |
| Cubic latest — event-evidence array logic was duplicated | Accepted | Sorted-unique and ordered-equality semantics are centralized in two small helpers and reused by record, memory-union, and review-candidate checks. |
| Correctness/security latest — fixture sharing-decision refs retained comma collision | Accepted | All sorted-unique reference checks now reuse the boundary-preserving helper; a schema-valid `a,a`/`a` decision-ID collision mutation is rejected. |
| Cubic final post-collision rerun | Clean | `cubic review -j` completed on the final working tree with an empty `issues` array. |
| Codex latest — pending-operation start event was unauthenticated | Accepted | Work-state/capsule restore paths resolve `correlation.startEventId`, require a start-phase event in operation evidence, and match the complete correlation envelope, turn-ID source, and authenticated source session; unknown, unbound, wrong-phase, optional-field, and session mutations fail after rehash. |
| Codex latest — outer/correlation operation IDs could diverge | Accepted | One shared semantic gate requires exact operation-ID equality; schema-valid rehashed mismatch is rejected and both restore manifests pin the rule. |
| Codex latest — F3 lineage was hard-coded rather than derived | Accepted | F3 origin, last contributor, canonical-client participants, and checkpoint creator are derived from authenticated ordered transitions; actor and missing-checkpoint mutations fail. |
| Codex latest — hint/manual and retrieval bypassed applicable policy | Accepted | A route-aware common helper applies authentication, scope, consent, privacy, Agent-private, secret, and egress gates to every nonlocal output; capability remains additional only for automatic/active-task routes. |
| Codex latest — memory union accepted an unconsented contributor | Accepted | Each matching-policy contributor must independently pass the exact authenticated sharing gate before entering the active union; removing the Codex contributor decision fails. |
| Codex latest — named-source expectation had no query input | Accepted | `named_source` is a closed branch with required authenticated `requestedSourceId`; outputs must belong to that source and missing/unknown/wrong/extra-selector mutations fail. |
| Codex latest — expired checkpoint collapsed to unknown | Accepted | Successor disposition/reason vocabularies now preserve `expired` and `checkpoint_expired`; valid manual fallback and wrong-reason regressions are frozen. |
| Correctness latest — current-source profile accepted another source | Accepted | `current_source` results must now belong to `destination.sourceId`; a policy-valid Claude record substituted into the Codex-current profile is rejected. |
| Ponytail latest — route-policy helper returned unused diagnostics | Accepted | Collapsed the helper to one boolean predicate and reused the existing source map for membership, authentication, and destination lookup. |
| Security latest — start binding omitted optional correlation fields | Accepted | The resolved start event now carries the complete `OperationCorrelationV2` plus `startTurnIdSource`; native ID, tool, input hash, turn, and turn-source mutations are rejected. |
| Correctness latest — start session was not bound to source identity | Accepted | The authenticated source identity session must equal the start-event and pending correlation session; a self-consistent wrong-session resolver still fails. |
| Cubic latest — pending-operation rules ran only through capsules | Accepted | A canonical-work-state semantic entrypoint now owns the shared pending-operation gate; standalone rehashed state and capsule regressions reuse it. |
| Cubic latest — memory union depended on destination delivery policy | Accepted | Union eligibility now checks contributor source authentication, exact subject scope, and contributor consent independently of the current retrieval destination; delivery policy remains route-specific. |
| Cubic latest — split the semantic test module | Rejected | Repeated architecture preference without a concrete S0 defect after the shared-entrypoint fix; the single atomic bundle gate avoids generated/shared-authority drift and adds no production module. |
| Cubic latest — Agent-private evidence could union across sources | Accepted | Union eligibility now permits Agent-private evidence only for the exact owner source; a second authenticated source with the same fact/policy tuple is rejected rather than bypassing grant authority. |
| Cubic latest — active union was compared before contributor eligibility | Accepted | Memory projection validation now filters exact-tuple records by authenticated source, scope, consent, and Agent-private locality before deriving source/evidence unions. A same-tuple unconsented contributor passes only when excluded from the active union and preserved in the typed review lane. |
| Docs latest — closed review and expiry vocabularies were under-described | Accepted | The normative contract now names `consent_or_source_locality_mismatch` for same-tuple consent/locality failures and preserves `expired` as `checkpoint_expired` with manual fallback rather than `checkpoint_unknown`. |
| CodeRabbit latest — bundle-hash prose implied an incomplete input set | Accepted | The data model now delegates to normative §14: every manifest top-level field except `contractHash` is hashed, including all profiles, policies, and observation entries. |
| CodeRabbit current — ADR/spec memory-union summaries omitted eligibility gates | Accepted | Both summaries now require exact authenticated consent per shared contributor and exact-source locality for Agent-private evidence, matching normative §8 and FR-042. |
| CodeRabbit current — canonical-state hash tuples lacked type-level parity assertions | Accepted | The two existing inline-enum entries now participate in the same TS/schema `SameSet` gate as the other hash profiles. |
| CodeRabbit current — the second review reason existed only in an in-memory mutation | Accepted | Hashed F4 now includes a same-tuple unconsented record preserved with `consent_or_source_locality_mismatch`; active evidence remains the two consented branches. |
| CodeRabbit current — shared-task grant evidence was non-empty only in JSON Schema | Accepted | `SharedTaskStateV1.sharingDecisionEventIds` is now a non-empty readonly tuple; a compile-only empty assignment fails. |
| CodeRabbit current — artifact names and versions were independent unions | Accepted | TS now uses four discriminated branches and JSON Schema pins the same four pairs with `oneOf`; a mismatched pair fails both typecheck and runtime validation. |
| CodeRabbit current — the S0 fence named only state/checkpoint | Accepted | Both task ledgers now block runtime, persistence, and migration for all four successor artifacts, including capsule and canonical memory. |
| CodeRabbit current — Markdown issue refs were parsed as headings | Partially accepted | Raw line-leading `#62`/`#132` were rewritten and the missing post-heading blank was added. The claimed missing pre-heading blank/horizontal-rule adjacency did not exist. |
| Correctness current — review candidates could be unique-fact orphans | Accepted with F7 preservation | A candidate now requires an active entity for its fact or a distinct same-fact record with a genuinely different policy tuple. Unique-fact and same-tuple-only mutations fail, while F7's pre-entity policy conflict remains valid. |
| Codex current — repository status escaped sensitivity aggregation | Accepted | `RepositoryStateSnapshotV2` now requires sensitivity and contributes it to the shared maximum; a rehashed secret repository with a normal projection is rejected. |
| Codex current — repository branch was not bound to task branch | Accepted | State and capsule validation now share exact workspace plus required-branch matching; rehashed wrong/missing repository-branch mutations fail. |
| Codex current — opaque key IDs were only nonblank and self-hashed | Accepted | State/memory restore resolves `keyId` inside the subject vault's keyring and requires at least 32-byte metadata; missing, cross-vault-only, and short keys fail after rehash. |
| Codex current — sharing level and subject scope were independent | Accepted | Grants use an exact task/project/personal level map in TS, JSON Schema, policy manifest, and semantic validation; a self-consistent project grant at vault scope cannot cross projects. |
| Codex current — F5 lacked an independent wrong-lineage record | Accepted | Hashed F5 now returns a same-workspace wrong-lineage record from project/named search while excluding it from active-task injection; scope validation is profile-aware. |
| Cubic current — standalone state omitted repository sensitivity | Accepted | Canonical-state validation now uses the same actual shared/Agent-local sensitivity inputs as capsule validation, including repository state; the standalone rehashed exploit fails. |
| Cubic current — retrieval policy used two independent booleans | Accepted | The only valid combinations are now a closed three-mode type: task with capability, task without capability, and workspace without capability. |
| Cubic current — extract the S0 semantic oracle into another module | Rejected | This repeats the module-split preference already dispositioned above. Spec 005 deliberately owns one atomic contract/hash/semantic gate and no production reference module in S0; shared policy concerns are centralized in reused pure helpers inside that gate. |
| Security current — artifact subject scopes were self-asserted | Accepted | State/memory/sharing-decision subjects now resolve to the authoritative scope registry before keyring/hash acceptance; local-only artifacts cannot be rehashed into another vault/project/lineage. |
| Docs current — hashed fixture grants retained task locators for project scope | Accepted | Fixture decisions are now scope-discriminated and project grants store only vault/project, while records retain full retrieval locators; F5 wrong-lineage uses one project-level grant boundary. |
| Correctness current — task-shared memory used the projection grant target | Accepted | Fixture consent validation now receives the intended target route explicitly: delivery uses shared projection for task records, while memory union requires the exact canonical-fact target. Both directions have regressions. |
| CodeRabbit current CLI rerun | Tool-limited | The CLI returned `rate_limit` before analysis (24-minute window; organization seat not assigned). No CLI verdict is claimed; the remote current-head full review remains the authoritative rerun. |
| CodeRabbit final current-tree CLI rerun | Clean | After the rate window elapsed, `coderabbit review --agent -t uncommitted` completed with zero issues on the current tree. |
| CodeRabbit final — wrong-phase regression also mismatched correlation | Accepted | The resolved test event now copies the mutated pending-operation correlation, so the negative case fails on `phase="terminal"` alone. |
| CodeRabbit pre-current-wave CLI rerun | Clean | `coderabbit review --agent -t uncommitted` completed with zero issues after the earlier focused fix. |
| Cubic final current-tree rerun | Clean | `cubic review -j` exited 0 with `{"issues":[]}` after every latest-wave concrete finding and the typed policy-mode simplification. |
| Correctness latest — pending operation could bind a foreign task lineage | Accepted; current tree verified | The shared state/capsule gate now requires the correlation task lineage to equal the enclosing canonical-state scope. |
| Correctness latest — state revision metadata could self-authorize | Accepted; current tree verified | State hashes are recomputed for integrity only; commit authority resolves an exact historical receipt with matching revision/hash/scope/daemon/epoch/ordinal, non-blank lease/fence, and commit-time validity. Head selection receives fully receipt-validated states and rejects missing, mismatched, mixed-scope, and all-foreign-scope candidates before ordinal comparison. |
| Correctness latest — canonical-memory parent was not resolved | Accepted; current tree verified | A child parent must resolve to an existing hash-valid, non-self revision of the same memory that the authoritative resolver proves is prior to that child. |
| CodeRabbit current-head — canonical-state hashes were not recomputed | Accepted; current tree verified | Standalone state, checkpoint, and capsule restore share the canonical state hash gate. |
| CodeRabbit current-head — dropped-evidence and duplicate Agent-local lanes bypassed standalone restore | Accepted; current tree verified | Canonical-state validation now reuses the existing dropped-evidence and Agent-local lane semantic gates; the normative prose was already sufficient. |
| CodeRabbit current-head — canonical-memory timestamp ordering was unchecked | Accepted; current tree verified | The gate enforces only `createdAt <= updatedAt` and, when both exist, `validFrom <= validTo`; no `expiresAt` ordering was invented. |
| CodeRabbit current-head — disproven memory remained capsule-deliverable | Accepted; current tree verified | `contradicted` and `confirmed_wrong` memories remain inspectable but are excluded from selected-memory capsule delivery. |
| Docs current — Phase 3 gate did not name the full successor bundle | Accepted | The authoritative spec and preflight plan now name all four successor artifacts. The S0 scope fence also protects the v6.2 addendum from accidental edits. |
| Docs current — line-leading `#13` was parsed as a heading | Accepted | The remaining raw line was rewritten as `Issue #13 Phase 3`. |
| Design audit current — seven canonical-state rules ran only through capsule projections | Accepted; current tree verified | Lineage, shared-decision, shared-source, and every Agent-local nested-source gate now run in the common canonical-state entrypoint; standalone checkpoint and capsule validation delegate to it. |
| Correctness final — capability warning ignored deny-first precedence | Accepted; current tree verified | `destination_capability_unsupported` is present exactly once only when the parent state and shared projection pass all earlier gates and capability is the sole omission reason; missing, duplicate, and spurious tokens fail. |
| Security final — head selection did not consume validated state authority | Accepted; current tree verified | The selector receives state-plus-receipt candidates, checks every receipt field and the requested exact task scope, and rejects missing/forged/mixed/all-foreign candidates before ordinal comparison. |
| Cubic final — head authority depended on a test-local receipt shape | Accepted; current tree verified | `StateCommitReceiptV1` now freezes the closed resolver evidence in TypeScript and JSON Schema, and the head-selection policy pins that schema name. |
| CodeRabbit current-tree — self-parent regression could pass on hash mismatch | Accepted; current tree verified | The self-parent case now calls the parent resolver gate directly, so the assertion cannot be satisfied by canonical-memory hash failure. |
| Cubic final — split the atomic semantic gate into modules | Rejected | This repeats the previously dispositioned architecture preference without a concrete behavior, security, or parity defect. S0 keeps one test-owned bundle gate; typed contexts and pure helpers remove the validated dependency-order risks without adding a second reference model. |
| Ponytail final | Clean after one shrink | The capsule context reuses the canonical-state context and the redundant receipt alias was removed. Final rerun: `Lean already. Ship.` |

The three-finding TDD red pass failed on the unused non-empty memory tuple assertion, absent exact transition constants,
missing event-evidence expectation fields, and the old restore rule. The implementation then restored focused/schema/type/hash
gates before whole-diff review.

The four-finding TDD red pass failed exactly on four unused readonly `@ts-expect-error` directives, missing `privateConsent`
schema fields, and three missing restore rules. The two subsequent review fixes also have isolated red evidence: restoring the
old branch-containment logic failed `true !== false`, and removing the private Agent-private denial failed the exact
`assert.ok(selectedMemoryIssues(...).length > 0)` regression. Each mutation was immediately restored. Focused contract 21/21,
schema freeze 19/19, TypeScript, and raw contract-hash regeneration then returned green before the final full review rerun.

## Current review-fix wave verification

Evidence refreshed at `2026-08-25T07:15:30+09:00` for the current uncommitted working tree over
`3bded47b7b16231a20c366fd84b76126532ea69b` (committed `2026-08-25T05:44:01+09:00`).

- Focused source-aware contract: 21 passed, 0 failed; schema freeze: 19 passed, 0 failed.
- Full continuity suite: 354 passed, 0 failed; harness TypeScript: exit 0 with no diagnostics.
- Generated contract hashes: empty diff; old-shape regeneration: 20 cases / 29 steps, empty diff.
- Existing reducer mutation gate: 218 executed / 218 expected, 0 survivors; restored suite 220 passed, 0 failed.
- Combined scope: 22 allowed paths, 0 forbidden matches; `git diff --check` has no whitespace errors.
- Independent correctness, security, and docs reviews are clean after their accepted fixes. All concrete CodeRabbit/Cubic
  findings were source-verified and fixed; Cubic's remaining module-split preference is rejected above. Final Ponytail is clean.
  The next local CodeRabbit retry is rate-limited after three completed runs, so a post-push remote full review remains required.
