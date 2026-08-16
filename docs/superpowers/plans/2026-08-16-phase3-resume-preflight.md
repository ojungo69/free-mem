# Phase 3 Resume Preflight Implementation Plan

> **Execution rule:** use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Each checkbox is a verification boundary. Do not start Phase 3 product tables/RPC until this contract work and #1 Stage 0 are complete.

**Goal:** Prove exact Claude/Codex delivery capability and freeze one runtime-neutral contract for task state, boundaries, pending side effects, checkpoints, claim/delivery, workspace reconciliation, resume selection, capsule safety, durable-memory history, quality reports, and doctor output.

**Toolchain:** Node.js 24.16.0, pnpm 11.8.0, TypeScript via Node type stripping, `node:test`, JSON Schema, isolated real-CLI rigs.

## Constraints

- Preserve all Phase 1 sole-writer, spool, auth, redaction, backup, and fail-open invariants.
- Use synthetic repos/data and isolated HOME/config directories for real-CLI evidence.
- Unknown native behavior stays unknown; source inspection cannot promote it.
- No generation/vector/cloud dependency is required for preflight.
- TS and Rust must consume identical schemas, fixtures, and report hashes.
- `off` disables every automatic delivery, including compact.

## Planned files

Modify:

- `harness/schema/capability.{ts,schema.json}`
- `harness/assemble.ts`
- `harness/rig/{rig.sh,claude-settings-template.json,codex-config-template.toml}`
- `harness/matrix/{claude,codex}.json` (generated)
- `harness/README.md`
- `specs/001-agent-memory-core/tasks.md`
- `.github/workflows/ci.yml`

Create:

- `harness/schema/continuity.{ts,schema.json}`
- `harness/schema/memory-history.{ts,schema.json}`
- `harness/continuity/*.test.ts`
- `harness/continuity/{reference-model,run-preflight}.ts`
- `harness/phase3-preflight.mjs`
- `harness/fixtures/continuity/*.json`
- `harness/fixtures/memory-history/*.json`
- exact Claude/Codex prompt-aware and compact fixtures/raw captures
- `benchmarks/behavioral/contract.schema.json`
- `benchmarks/behavioral/fixtures/deterministic/resume-core.json`
- `evidence/phase3-preflight-{capability,contract}.md`

---

## Task 1 — Extend exact-version capability evidence

- [ ] Add `ResumeDeliveryStrategy`:

```ts
type ResumeDeliveryStrategy =
  | "native_prompt_gate"
  | "session_start_full"
  | "next_prompt_synthesized"
  | "manual_only";
```

- [ ] Add matrix fields:

```ts
resumeDeliveryStrategy: ResumeDeliveryStrategy;
promptDeliveryBeforeModel: CapabilityEvidence;
compactSingleDelivery: CapabilityEvidence;
capabilityHashInputs: string[];
```

- [ ] RED test: empty matrix resolves to `manual_only`; new evidence fields are unknown.
- [ ] RED test: reject half-proven synthesized prompt delivery.
- [ ] `next_prompt_synthesized` requires both `promptDeliveryBeforeModel` and `promptAwareInjection` to be synthesized by the same exact-version real-CLI fixture/evidence hash.
- [ ] `session_start_full` allows native or synthesized SessionStart only with real-CLI evidence.
- [ ] Mirror closed enums/required fields in JSON Schema.
- [ ] Regenerate matrices without manually editing generated JSON.

Commands:

```bash
node --experimental-strip-types --test harness/continuity/capability-contract.test.ts
node --experimental-strip-types harness/assemble.ts --self-test
node --experimental-strip-types harness/assemble.ts harness/fixtures/claude harness/matrix/claude.json
node --experimental-strip-types harness/assemble.ts harness/fixtures/codex harness/matrix/codex.json
```

Expected before Tasks 2–3: no Agent is better than its currently proven SessionStart strategy; compact remains unknown.

---

## Task 2 — Capture Claude prompt-aware and compact behavior

- [ ] Isolate `HOME`, `CLAUDE_CONFIG_DIR`, repo, hooks, transcript, and memory paths.
- [ ] Prompt-boundary fixture uses different hint/full tokens and proves full context is model-visible before the first assistant/tool action.
- [ ] Compact fixture proves checkpoint evidence precedes compact completion, restore reaches the model exactly once, and duplicate hook retry does not duplicate it.
- [ ] Failure path returns empty context without blocking Claude.
- [ ] Store exact binary version, command, event names, transcript hash, evidence hash, and limitations.
- [ ] Use dispositions `proven`, `unsupported`, or `unknown_after_test`; never infer support.
- [ ] Regenerate Claude capability matrix.

---

## Task 3 — Capture Codex prompt-aware, compact, and native identity behavior

- [ ] Isolate `CODEX_HOME`, HOME, repo, hooks, transcript, and memory paths.
- [ ] Prove prompt-boundary visibility before the first assistant/tool action, not hook stdout alone.
- [ ] Prove compact save/restore/exactly-one delivery or preserve unknown/unsupported.
- [ ] Run multiple turns plus restart to test usable stable native session identity.
- [ ] Record exact Codex event names rather than translating them into Claude names.
- [ ] Regenerate Codex capability matrix.

---

## Task 4 — Freeze continuity types and JSON Schema

Create `harness/schema/continuity.ts` and a closed JSON Schema defining at minimum:

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ResumeMode = "smart" | "always" | "hint_only" | "compact_only" | "off";
type ResumeDeliveryBoundary = "session_start" | "first_user_prompt" | "post_compact" | "manual";
type CapabilityTestDisposition = "not_run" | "proven" | "unsupported" | "unknown_after_test";
type ContractPreflightState = "incomplete" | "complete";
```

Also define:

- `NormalizedContinuityEvent`
- `Observed<T>` / `CanonicalWorkStateV1` / `PendingOperation`
- `TaskBoundaryProposalV1` / `TaskBoundaryDecisionV1` / `SessionTaskBinding`
- `ContinuationCheckpointV2`
- `CheckpointMetadataV1`
- `CheckpointDispositionEvent` / `CheckpointDispositionProjection`
- `DispositionAuthorityContextV1`
- `CheckpointAnchorV1`
- `EngagementEvidence` / `ContradictionEvidenceV1` / `EngagementEvaluationContextV1`
- `CheckpointDeliveryAttempt`
- every `DeliveryCommandV1` variant with `attemptId`
- `WorkspaceReconciliationReport`
- `ResumeThresholdProfileV1`
- `RankedResumeCandidateV1`
- `ResumeSelectionDecisionV1` including `boundary`
- `ResumeCapsuleV1`
- `OwnedInjectionLedgerEntry` / `CaptureStripResult`
- `ResumeQualityReportV1`
- `ContinuityDoctorReportV1`

Shared limits:

```ts
const CONTINUITY_LIMITS = {
  hintTokens: 120,
  fullCapsuleTokens: 700,
  promptMemoryTokens: 700,
  combinedTokens: 1500,
  absoluteTokens: 1800,
  capsulePayloadBytes: 32768,
  wrapperBytes: 36864,
  jsonDepth: 12,
  stringUtf8Bytes: 8192,
  arrayItems: 256,
  objectKeys: 128,
  rankedCandidates: 5,
} as const;
```

- [ ] Runtime validators reject unknown keys, invalid timestamps/decimals/enums, non-JSON values, excessive depth/size, invalid scores, and version mismatch.
- [ ] JSON Schema uses the same constants and `additionalProperties:false`.
- [ ] Contract tests emit schema/fixture SHA-256 values for TS/Rust parity.

---

## Task 5 — Implement task-state, duplicate no-op, and boundary decisions

Reference interfaces:

```ts
reduceTaskWorkState(previous, event, idempotencyLedger): TaskStateReductionResult
finalizeAbandonedState(state, event): CanonicalWorkStateV1
proposeTaskBoundary(state, event): TaskBoundaryProposalV1 | null
confirmTaskBoundaryAtomically(binding, proposal, decision): {
  previousBinding: SessionTaskBinding;
  newBinding: SessionTaskBinding;
  proposal: TaskBoundaryProposalV1;
}
rejectTaskBoundary(binding, proposal, decision): {
  binding: SessionTaskBinding;
  proposal: TaskBoundaryProposalV1;
}
```

Fixtures/tests:

- [ ] Crash after operation start => `unknown / verify_first`.
- [ ] Dangerous/external operations => `never_auto`.
- [ ] Reapply the same logical event x10 => byte-identical state, same revision/hash/history, one idempotency record. Dedupe occurs before revision allocation.
- [ ] Late trustworthy terminal event creates a new revision without rewriting the unknown revision.
- [ ] Heuristic goal shift creates only a proposal.
- [ ] Confirm validates proposal/session/binding revisions and atomically replaces the primary binding.
- [ ] Reject keeps the old binding.
- [ ] Stale confirm/reject, competing proposals, and cross-session decisions leave the old lineage unchanged.

---

## Task 6 — Implement fail-closed workspace reconciliation

Reference interface:

```ts
reconcileWorkspace(checkpoint, currentEvidence): WorkspaceReconciliationReport
```

Fixtures cover `exact`, `fast_forward_compatible`, `stale_but_usable`, `requires_verification`, `incompatible`, and incomplete/unknown evidence.

Rules:

```text
repository/workspace mismatch -> incompatible
unreadable required evidence or unknown ancestry -> requires_verification
unproven branch/worktree relation -> requires_verification
diverged HEAD + affected file drift -> requires_verification
pending migration/external side effect -> requires_verification
checkpoint HEAD ancestor + affected files unchanged -> fast_forward_compatible
classified low-risk drift only -> stale_but_usable
all applicable checks positively match -> exact
otherwise -> requires_verification
```

- [ ] `exact` is never a default/fallthrough.
- [ ] Stale/verification capsule wording converts imperative actions into verification suggestions.

---

## Task 7 — Implement lineage-aware disposition, initial claim, source-verified engagement, and atomic acceptance

Reference interfaces:

```ts
projectCheckpointDisposition(
  events: CheckpointDispositionEvent[],
  lookup: (id: string) => CheckpointMetadataV1 | null,
  authority: DispositionAuthorityContextV1,
): CheckpointDispositionProjection

claimCheckpointAtomically(input): {
  attempt: CheckpointDeliveryAttempt;
  projection: CheckpointDispositionProjection;
}

transitionDeliveryAttempt(
  attempt: CheckpointDeliveryAttempt,
  command: Exclude<DeliveryCommandV1, { kind: "accept" }>,
): CheckpointDeliveryAttempt

acceptDeliveryAttemptAtomically(input: {
  attempt: CheckpointDeliveryAttempt;
  dispositionEvents: CheckpointDispositionEvent[];
  checkpointLookup: (id: string) => CheckpointMetadataV1 | null;
  authority: DispositionAuthorityContextV1;
  command: Extract<DeliveryCommandV1, { kind: "accept" }>;
  evaluation: EngagementEvaluationContextV1;
}): {
  attempt: CheckpointDeliveryAttempt;
  projection: CheckpointDispositionProjection;
  appendedEvent: CheckpointDispositionEvent;
}
```

Required tests:

- [ ] Daemon/runtime supersede succeeds only when checkpoint metadata proves same lineage.
- [ ] Cross-lineage supersede requires explicit user-authoritative context.
- [ ] Missing related metadata fails closed.
- [ ] Initial claim validates open projection, no active unexpired attempt, destination session/binding, explicit delivery boundary, mode, capability, selection decision, and reconciliation; attempt+projection commit together.
- [ ] 100-way claim race produces one winner.
- [ ] Every post-claim command rejects mismatched `attemptId`, revision, fence, or session.
- [ ] Engagement weights/anchors are fixed by the addendum.
- [ ] Evidence is revalidated from actual normalized source events: kind, success, ordering, destination turn, and checkpoint anchor linkage.
- [ ] Failed, unknown, unrelated, out-of-window, or fabricated labels score zero.
- [ ] Explicit rejection, confirmed other task, incompatible workspace, and invalidating runtime evidence block acceptance.
- [ ] Atomic acceptance appends accepted disposition and advances projection+attempt together.
- [ ] Accepted attempt/open checkpoint projection is impossible.

---

## Task 8 — Implement explicit-boundary selection and capsule lifecycle

Reference interfaces:

```ts
selectResumeAction(input): ResumeSelectionDecisionV1
renderResumeCapsule(capsule, sensitivityPolicy): RenderedCapsule
parseAndStripOwnedResumeCapsules(text, ownedLedger): CaptureStripResult
```

Initial threshold fixture:

```text
profileId=resume-v1-preflight
fullResumeMinScore=0.75
hintMinScore=0.35
ambiguityMargin=0.08
maxCandidates=5
```

- [ ] Decision includes `boundary`, dataset/profile, mode, strategy, capability hash, ranked candidates, scores/margin, confidence, reasons, selected checkpoint, and fallback.
- [ ] Cross-product fixtures include each mode × capability × delivery boundary.
- [ ] The same `compact_only` state yields `none` at `session_start` and possible full only at proven `post_compact`.
- [ ] Low score => none; medium => hint/list; close candidates within margin => candidate list; low/unknown confidence => no full; incompatible/manual-only => no full; verification-required => verification capsule at most.
- [ ] Unknown/unsupported capability never produces automatic full.
- [ ] `always` and `compact_only` remain capability-gated.
- [ ] Normal/private/secret selection follows addendum sensitivity rules before hashing/rendering.
- [ ] Structural limits are enforced; JSON is stable-sorted and `<`, `>`, `&` escaped.
- [ ] Mode-aware invalid/oversized fallback is tested.
- [ ] Capture verifies owned ID/hash/bytes/schema and rejects unknown, malformed, nested, mismatched, and unsupported capsules without blocking the Agent.
- [ ] Render→capture round-trip cannot create a DurableMemory candidate.

---

## Task 9 — Implement durable-memory history and evidence-preserving dedupe

Define append-only ADD/UPDATE/SUPERSEDE/RETRACT revision events, temporal validity/invalidation, source links, and presentation-level consolidation preference.

Tests:

- [ ] Stale expected revision is rejected.
- [ ] Prior events are immutable.
- [ ] Invalidated fact remains historical but is excluded/down-ranked from current retrieval.
- [ ] Derived observation retains all source memory/event IDs.
- [ ] Removing source evidence violates the reference invariant.
- [ ] `preferConsolidated=true` suppresses duplicates in output only; source records remain retrievable.

---

## Task 10 — Implement one normative quality-report contract

`benchmarks/behavioral/contract.schema.json` is the machine authority for `ResumeQualityReportV1`.

- [ ] Zero-tolerance counters are numeric and complete.
- [ ] Behavioral metrics are `number | "unsupported"` only where applicability manifest permits.
- [ ] A required Phase/Release metric marked unsupported fails the gate.
- [ ] Report includes runtime/commit, capability hash, fixture version, schema hashes, all resume metrics, token counts, task completion, and claude-mem deltas.
- [ ] Reference, TS, Rust, and public claude-mem adapters consume the same fixture format.
- [ ] Sorted fixture execution produces byte-identical reports across repeated runs.

Commands:

```bash
node --experimental-strip-types harness/continuity/run-preflight.ts --out /tmp/a.json
node --experimental-strip-types harness/continuity/run-preflight.ts --out /tmp/b.json
cmp /tmp/a.json /tmp/b.json
```

---

## Task 11 — Connect preflight states, doctor, evidence, tasks, and CI

- [ ] Record each required capability scenario as `not_run`, `proven`, `unsupported`, or `unknown_after_test`.
- [ ] Contract preflight is complete only when no required scenario is `not_run`, artifacts exist, and every runtime-neutral fixture passes.
- [ ] Unsupported/unknown permits generic/manual implementation but forces automatic-strategy/Tier downgrade.
- [ ] Add P3P tasks and barriers to `tasks.md`:

```text
#1 Stage 0 + all scenarios dispositioned + contract fixtures green
  -> generic Phase 3 implementation may start

exact strategy capability proven
  -> that Agent/version may enable automatic strategy

release E2E + #8 non-inferiority
  -> Tier A / Core 1.0 claim
```

- [ ] Add `doctor continuity --json` fixture with exact version/hash, scenario dispositions, strategy, mode, threshold/dataset, last boundary/selection reasons, reconciliation, active attempt/lease, unknown pending count, preflight/unmet gates, and schema/fixture/report hashes.
- [ ] Prove doctor omits raw prompts, commands, private/secret values, and capsule content.
- [ ] Write evidence files with exact commands, versions, commits, hashes, dispositions, failures, and synthetic fixture links.
- [ ] After ten deterministic runs, add CI for contract tests, report completeness, zero counters, doctor schema, and byte reproducibility.

## Final verification

```bash
cd vendor/codemem
corepack pnpm install --frozen-lockfile
corepack pnpm run build
CI=true corepack pnpm run check
cd ../..
node --experimental-strip-types --test harness/continuity/*.test.ts
node --experimental-strip-types harness/continuity/run-preflight.ts --out /tmp/phase3-preflight.json
git diff --check
```

Expected:

- Existing Phase 1 suite remains green.
- Every deterministic fixture passes.
- Every zero-tolerance counter is zero.
- Every required metric is numeric and present.
- Unknown capability remains visible and downgraded.
- Reports are byte-reproducible.
- No production continuity implementation exists before #1 chooses the runtime.
