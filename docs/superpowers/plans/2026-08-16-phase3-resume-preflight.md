# Phase 3 Resume Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Execute each checkbox as a verification boundary.

**Goal:** Freeze and mechanically validate the exact Agent capability, typed task state, pending-operation safety, immutable checkpoint history, initial claim CAS, deterministic engagement/acceptance, workspace reconciliation, safe capsule lifecycle, selection wire contract, durable-memory history, quality report, and doctor output required before Phase 3 product implementation begins.

**Architecture:** Extend the isolated real-CLI harness first. Implement a dependency-free, runtime-language-neutral contract and deterministic reference model under `harness/`. Do not add production continuity tables, RPC routes, or hook behavior until #1 selects the runtime. TypeScript and Rust candidates must later consume identical schemas, fixtures, and expected reports.

**Tech Stack:** Node.js 24.16.0, TypeScript executed with Node type stripping, `node:test`, JSON Schema, shell-isolated Claude/Codex rigs, existing `harness/assemble.ts`, GitHub Actions.

## Global constraints

- Exact toolchain: Node.js `24.16.0`, Corepack pnpm `11.8.0`.
- Linux/WSL2 remains the authoritative Phase 1 target until a later support gate.
- Do not add generation, embedding, rerank, sync, Chroma, Python, Redis, or Postgres dependencies.
- Do not weaken Phase 1 sole-writer, spool, redaction, peer-auth, backup, or fail-open invariants.
- Do not implement production Phase 3 tables or RPC routes before #1 Stage 0/1 selects the runtime architecture.
- Unobserved native CLI capabilities remain `unknown`; source inspection alone cannot promote them.
- Real CLI capture uses synthetic repositories/data, isolated HOME/config directories, and `AGENT_MEMORY_INTERNAL_RUN=1`.
- `resume_mode=off` means no automatic hint or injection, including compact recovery.
- Exact capability proof and selected mode are intersected. A permissive mode never overrides unknown/unsupported capability.
- Deterministic critical invariants must be 100% green.
- Any copied code must pass #10 provenance/license review. This plan uses original implementation based on public architectural patterns.

---

## File map

### Existing files to modify

- `harness/schema/capability.ts`
- `harness/schema/capability.schema.json`
- `harness/assemble.ts`
- `harness/rig/rig.sh`
- `harness/rig/claude-settings-template.json`
- `harness/rig/codex-config-template.toml`
- `harness/matrix/claude.json` (generated only)
- `harness/matrix/codex.json` (generated only)
- `harness/README.md`
- `specs/001-agent-memory-core/tasks.md`
- `.github/workflows/ci.yml`

### New files

- `harness/schema/continuity.ts`
- `harness/schema/continuity.schema.json`
- `harness/schema/memory-history.ts`
- `harness/schema/memory-history.schema.json`
- `harness/continuity/capability-contract.test.ts`
- `harness/continuity/contract.test.ts`
- `harness/continuity/reference-model.ts`
- `harness/continuity/reference-model.test.ts`
- `harness/continuity/memory-history.test.ts`
- `harness/continuity/run-preflight.ts`
- `harness/phase3-preflight.mjs`
- `harness/fixtures/continuity/*.json`
- `harness/fixtures/memory-history/*.json`
- `harness/fixtures/claude/{prompt-aware-resume,compact-resume}.json`
- `harness/fixtures/codex/{prompt-aware-resume,compact-resume}.json`
- `harness/fixtures/{claude,codex}/raw/*`
- `benchmarks/behavioral/contract.schema.json`
- `benchmarks/behavioral/fixtures/deterministic/resume-core.json`
- `evidence/phase3-preflight-capability.md`
- `evidence/phase3-preflight-contract.md`

---

## Task 1: Extend exact-version capability evidence

**Files:**
- Modify: `harness/schema/capability.ts`
- Modify: `harness/schema/capability.schema.json`
- Modify: `harness/assemble.ts`
- Create: `harness/continuity/capability-contract.test.ts`

**Produces:**

```ts
export type ResumeDeliveryStrategy =
  | "native_prompt_gate"
  | "session_start_full"
  | "next_prompt_synthesized"
  | "manual_only";
```

`AdapterCapabilities` additionally exposes:

```ts
resumeDeliveryStrategy: ResumeDeliveryStrategy;
promptDeliveryBeforeModel: CapabilityEvidence;
compactSingleDelivery: CapabilityEvidence;
capabilityHashInputs: string[];
```

- [ ] **1.1 Write RED default and consistency tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { emptyMatrix, validateResumeCapabilityConsistency } from "../schema/capability.ts";

test("empty matrix fails closed", () => {
  const matrix = emptyMatrix("test-cli 1.0.0");
  assert.equal(matrix.resumeDeliveryStrategy, "manual_only");
  assert.equal(matrix.promptDeliveryBeforeModel.value, "unknown");
  assert.equal(matrix.compactSingleDelivery.value, "unknown");
});

test("rejects half-proven synthesized prompt delivery", () => {
  const matrix = emptyMatrix("test-cli 1.0.0");
  matrix.promptDeliveryBeforeModel = synthesizedEvidence("fixture-a");
  assert.throws(() => validateResumeCapabilityConsistency(matrix), /synthesized prompt evidence/);
});
```

Expected: FAIL because fields/functions do not exist.

- [ ] **1.2 Add fields and conservative defaults**

`emptyMatrix()` returns `manual_only`, two unknown evidence objects, and an empty hash-input list. Extend `CaptureFixture.highLevel` with optional proof fields; absence remains unknown.

- [ ] **1.3 Define synthesized consistency**

`next_prompt_synthesized` is valid only when:

- `promptDeliveryBeforeModel.value === "synthesized"`;
- `promptAwareInjection.value === "synthesized"`;
- both refer to the same exact native version and same real-CLI fixture/evidence hash.

If only one side is synthesized or evidence hashes differ, schema/runtime validation fails. It does not silently fall back.

- [ ] **1.4 Implement strategy resolution**

```ts
function resolveResumeDeliveryStrategy(matrix: AdapterCapabilities): ResumeDeliveryStrategy {
  validateResumeCapabilityConsistency(matrix);
  if (matrix.promptDeliveryBeforeModel.value === "native") return "native_prompt_gate";
  if (
    matrix.promptDeliveryBeforeModel.value === "synthesized" &&
    matrix.promptAwareInjection.value === "synthesized"
  ) return "next_prompt_synthesized";
  if (
    matrix.sessionStartInjection.value === "native" ||
    matrix.sessionStartInjection.value === "synthesized"
  ) return "session_start_full";
  return "manual_only";
}
```

SessionStart synthesized evidence also requires real-CLI E2E and an evidence hash.

- [ ] **1.5 Mirror in JSON Schema**

Require all fields, closed enums, and a schema-level conditional or runtime validator for synthesized-pair consistency. New objects use `additionalProperties: false`.

- [ ] **1.6 Regenerate current matrices**

```bash
node --experimental-strip-types harness/assemble.ts --self-test
node --experimental-strip-types harness/assemble.ts harness/fixtures/claude harness/matrix/claude.json
node --experimental-strip-types harness/assemble.ts harness/fixtures/codex harness/matrix/codex.json
```

Expected before Tasks 2–3: no better than `session_start_full`; compact single delivery remains unknown.

- [ ] **1.7 Commit**

```bash
git add harness/schema/capability.ts harness/schema/capability.schema.json harness/assemble.ts harness/continuity/capability-contract.test.ts harness/matrix
 git commit -m "test: extend resume capability evidence contract"
```

---

## Task 2: Capture Claude prompt-aware and compact behavior

**Files:**
- Modify: `harness/rig/rig.sh`
- Modify: `harness/rig/claude-settings-template.json`
- Create: `harness/fixtures/claude/prompt-aware-resume.json`
- Create: `harness/fixtures/claude/compact-resume.json`
- Create: `harness/fixtures/claude/raw/claude-prompt-aware-resume.jsonl`
- Create: `harness/fixtures/claude/raw/claude-compact-resume.jsonl`

- [ ] **2.1 Add a RED prompt-boundary scenario**

Use distinct tokens:

```text
SESSION_HINT_TOKEN_1d5c
PROMPT_FULL_TOKEN_a0e7
```

The child Agent must echo visible context before any tool call. SessionStart exposes only the hint; first UserPromptSubmit exposes the full token before first assistant/tool action.

- [ ] **2.2 Implement isolated capture**

Use scratch `HOME`, `CLAUDE_CONFIG_DIR`, and Git repository. Save hook stdin/stdout and transcript. Never read user configuration, plugins, repositories, or memory data.

- [ ] **2.3 Add compact single-delivery scenario**

Use `COMPACT_CHECKPOINT_92b1` and `COMPACT_RESTORE_470a`. Assert persistence before compact completion, exactly one restore token, duplicate retry dedupe, and empty-context fail-open on capture failure.

- [ ] **2.4 Record exact disposition**

Record exact version, command, timestamp, source events, transcript hash, evidence hash, and limitations. Use `unsupported` only after positive disproof; inconclusive result becomes `unknown_after_test`.

- [ ] **2.5 Regenerate and commit**

```bash
node --experimental-strip-types harness/assemble.ts harness/fixtures/claude harness/matrix/claude.json
git add harness/rig harness/fixtures/claude harness/matrix/claude.json
 git commit -m "test: capture Claude resume delivery capabilities"
```

---

## Task 3: Capture Codex prompt-aware, compact, and identity behavior

**Files:**
- Modify: `harness/rig/rig.sh`
- Modify: `harness/rig/codex-config-template.toml`
- Create: `harness/fixtures/codex/prompt-aware-resume.json`
- Create: `harness/fixtures/codex/compact-resume.json`
- Create: `harness/fixtures/codex/raw/codex-prompt-aware-resume.jsonl`
- Create: `harness/fixtures/codex/raw/codex-compact-resume.jsonl`

- [ ] **3.1 Add prompt-boundary RED test**

Require model-visible evidence before first assistant/tool action, not hook stdout alone.

- [ ] **3.2 Run under isolated `CODEX_HOME`**

Use exact stable binary and synthetic repository. Record trust-prompt behavior separately from MCP behavior.

- [ ] **3.3 Add compact/dedupe assertions**

Record actual Codex boundary names. Do not translate them into Claude event names.

- [ ] **3.4 Test native session identity**

Run two turns plus restart. Mark stable identity proven only with positive evidence.

- [ ] **3.5 Regenerate and commit**

```bash
node --experimental-strip-types harness/assemble.ts harness/fixtures/codex harness/matrix/codex.json
git add harness/rig harness/fixtures/codex harness/matrix/codex.json
 git commit -m "test: capture Codex resume delivery capabilities"
```

---

## Task 4: Freeze continuity types, validators, and JSON Schema

**Files:**
- Create: `harness/schema/continuity.ts`
- Create: `harness/schema/continuity.schema.json`
- Create: `harness/continuity/contract.test.ts`
- Create: `harness/fixtures/continuity/valid-work-state.json`
- Create: `harness/fixtures/continuity/invalid-work-state.json`

**Required exported contracts:**

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ResumeMode = "smart" | "always" | "hint_only" | "compact_only" | "off";
export type ReconciliationStatus = "exact" | "fast_forward_compatible" | "stale_but_usable" | "requires_verification" | "incompatible";
export type CapabilityTestDisposition = "not_run" | "proven" | "unsupported" | "unknown_after_test";
export type ContractPreflightState = "incomplete" | "complete";
```

Also define and validate:

- `NormalizedContinuityEvent`
- `BoundaryProposal`
- `CurrentWorkspaceEvidence`
- `CanonicalWorkStateV1`
- `ContinuationCheckpointV2`
- `CheckpointDispositionEvent/Projection`
- `CheckpointDeliveryAttempt`
- `WorkspaceReconciliationReport`
- `ResumeThresholdProfileV1`
- `RankedResumeCandidateV1`
- `ResumeSelectionDecisionV1`
- `ResumeCapsuleV1`
- `OwnedInjectionLedgerEntry`
- `CaptureStripResult`
- `ContinuityDoctorReportV1`

Shared serializer constants:

```ts
export const CONTINUITY_LIMITS = {
  hintTokens: 120,
  fullCapsuleTokens: 700,
  promptMemoryTokens: 700,
  combinedTokens: 1500,
  absoluteTokens: 1800,
  capsulePayloadBytes: 32_768,
  wrapperBytes: 36_864,
  jsonDepth: 12,
  stringUtf8Bytes: 8_192,
  arrayItems: 256,
  objectKeys: 128,
  rankedCandidates: 5,
} as const;
```

- [ ] **4.1 Write RED contract tests**

Reject unknown keys, non-JSON values, invalid timestamps, invalid decimals, out-of-range scores, excessive depth/items/strings, and mismatched schema versions.

- [ ] **4.2 Implement strict assertions**

`assertCanonicalWorkStateV1`, `assertContinuationCheckpointV2`, `assertDeliveryAttempt`, `assertReconciliationReport`, `assertResumeSelectionDecisionV1`, `assertResumeCapsuleV1`, and `assertContinuityDoctorReportV1`.

- [ ] **4.3 Mirror closed JSON Schema**

Use `$defs`, `const` versions, `additionalProperties: false`, and exact shared limits.

- [ ] **4.4 Pin schema/fixture hashes**

Print SHA-256 values; TS and Rust reports must use identical hashes.

- [ ] **4.5 Commit**

```bash
git add harness/schema/continuity* harness/continuity/contract.test.ts harness/fixtures/continuity
 git commit -m "spec: freeze typed continuity contract"
```

---

## Task 5: Build task-state, dedupe, and pending-operation reference logic

**Files:**
- Create: `harness/continuity/reference-model.ts`
- Create: `harness/continuity/reference-model.test.ts`
- Create: `harness/fixtures/continuity/pending-command-crash.json`
- Create: `harness/fixtures/continuity/task-boundary-proposal.json`
- Create: `harness/fixtures/continuity/duplicate-event-noop.json`

**Interfaces:**

```ts
reduceTaskWorkState(previous, event, idempotencyLedger): TaskStateReductionResult
finalizeAbandonedState(state, event): CanonicalWorkStateV1
proposeTaskBoundary(state, event): BoundaryProposal | null
confirmTaskBoundary(binding, proposal, event): SessionTaskBinding
```

- [ ] **5.1 Write RED ambiguous-operation test**

Crash after command start creates `unknown / verify_first`.

- [ ] **5.2 Write explicit duplicate no-op test**

Reapply the same `adapterDeliveryId` or canonical fingerprint ten times. After the first application:

- returned state is byte-identical;
- content hash and state revision are unchanged;
- no new history revision is created;
- idempotency ledger contains one logical event.

The dedupe check occurs before revision allocation.

- [ ] **5.3 Implement immutable revisions and late terminal correction**

A later trustworthy terminal event creates a new revision changing unknown to succeeded/failed while prior revision remains unchanged.

- [ ] **5.4 Implement proposal/confirmation without premature lineage change**

Proposal alone preserves original lineage. Confirmation creates the new binding. Rejection leaves original state intact.

- [ ] **5.5 Commit**

```bash
git add harness/continuity/reference-model* harness/fixtures/continuity
 git commit -m "test: model task state idempotency and pending operations"
```

---

## Task 6: Build fail-closed workspace reconciliation

**Files:**
- Modify: `harness/continuity/reference-model.ts`
- Modify: `harness/continuity/reference-model.test.ts`
- Create: `harness/fixtures/continuity/reconcile-{exact,fast-forward,stale,verify,incompatible,unknown}.json`

**Interface:**

```ts
reconcileWorkspace(checkpoint, current): WorkspaceReconciliationReport
```

- [ ] **6.1 Write one RED test per status**

Cover exact, fast-forward, stale, verification-required, incompatible, and incomplete/unknown evidence.

- [ ] **6.2 Implement fail-closed aggregation**

```ts
if (repositoryIdMismatch || workspaceIdMismatch) return incompatible;
if (requiredEvidenceUnreadable || ancestryUnknown) return requires_verification;
if (branchOrWorktreeMismatch && safeRelationshipNotProven) return requires_verification;
if (divergedHead && affectedFileChanged) return requires_verification;
if (pendingMigrationOrExternalSideEffect) return requires_verification;
if (checkpointHeadAncestor && affectedFilesUnchanged) return fast_forward_compatible;
if (onlyClassifiedLowRiskDrift) return stale_but_usable;
if (allRequiredChecksPositivelyMatch) return exact;
return requires_verification;
```

Never use `exact` as fallback.

- [ ] **6.3 Test safe wording downgrade**

Stale/verification capsules render verification suggestions rather than imperative destructive actions.

- [ ] **6.4 Commit**

```bash
git add harness/continuity harness/fixtures/continuity/reconcile-*.json
 git commit -m "test: define fail-closed workspace reconciliation"
```

---

## Task 7: Build initial claim CAS, deterministic engagement, and atomic acceptance

**Files:**
- Modify: `harness/continuity/reference-model.ts`
- Modify: `harness/continuity/reference-model.test.ts`
- Create: `harness/fixtures/continuity/claim-race.json`
- Create: `harness/fixtures/continuity/wrong-resume-dismiss.json`
- Create: `harness/fixtures/continuity/engage-then-accept.json`
- Create: `harness/fixtures/continuity/invalid-accepted-attempt-open-checkpoint.json`

**Interfaces:**

```ts
claimCheckpointAtomically(input): {
  attempt: CheckpointDeliveryAttempt;
  projection: CheckpointDispositionProjection;
}

transitionDeliveryAttempt(attempt, commandWithoutAccept): CheckpointDeliveryAttempt
scoreEngagementEvidence(evidence): EngagementScoreResult
acceptDeliveryAttemptAtomically(input): {
  attempt: CheckpointDeliveryAttempt;
  projection: CheckpointDispositionProjection;
  appendedEvent: CheckpointDispositionEvent;
}
```

- [ ] **7.1 Write initial-claim RED race test**

One transaction verifies expected checkpoint projection, open state, no active unexpired attempt, destination session, mode, capability, and reconciliation; then creates attempt/fence and active-claim projection. In a 100-way race exactly one wins.

- [ ] **7.2 Write engagement scoring tests**

Use contract weights:

```text
explicit_accept=1.00
manual_resume_tool=1.00
explicit_continue_prompt=0.35
related_file_action=0.35
related_command=0.40
related_test=0.50
related_todo_progress=0.40
```

Validate score range, unique `(kind, sourceEventId)` counting, checkpoint-anchor linkage, success requirement, 30-minute/lease window, and contradiction events.

- [ ] **7.3 Enforce engaged and accepted thresholds**

- engaged: one linked item score `>=0.35`;
- automatic accepted: cumulative `>=0.80`, at least two distinct kinds, at least one successful runtime kind, no contradiction;
- explicit user/manual acceptance: score `1.00`, atomic sub-transitions allowed.

Agent prose alone contributes no explicit acceptance.

- [ ] **7.4 Implement atomic acceptance**

Validate attempt and open projection, append accepted disposition tied to attempt, clear active claim, update projection and attempt together. Partial output is impossible.

- [ ] **7.5 Test stale fence and invalid mixed state**

Reject delayed old-fence commands and any accepted attempt/open checkpoint projection.

- [ ] **7.6 Commit**

```bash
git add harness/continuity harness/fixtures/continuity/*claim*.json harness/fixtures/continuity/*accept*.json harness/fixtures/continuity/*resume*.json
 git commit -m "test: freeze claim engagement and acceptance semantics"
```

---

## Task 8: Build selection wire contract and complete capsule lifecycle

**Files:**
- Modify: `harness/continuity/reference-model.ts`
- Modify: `harness/continuity/reference-model.test.ts`
- Create: `harness/fixtures/continuity/resume-mode-capability-matrix.json`
- Create: `harness/fixtures/continuity/selection-{single,close,low-confidence,incompatible,manual}.json`
- Create: `harness/fixtures/continuity/adversarial-capsule.json`
- Create: `harness/fixtures/continuity/capsule-capture-strip.json`
- Create: `harness/fixtures/continuity/capsule-sensitivity.json`

**Interfaces:**

```ts
selectResumeAction(input): ResumeSelectionDecisionV1
renderResumeCapsule(capsule, sensitivityPolicy): RenderedCapsule
parseAndStripOwnedResumeCapsules(text, ownedLedger): CaptureStripResult
```

- [ ] **8.1 Implement dataset-versioned thresholds**

Initial fixture profile:

```text
profileId=resume-v1-preflight
fullResumeMinScore=0.75
hintMinScore=0.35
ambiguityMargin=0.08
maxCandidates=5
```

- [ ] **8.2 Test deterministic selection wire output**

Every decision includes dataset version, profile ID, capability hash, mode, strategy, ranked candidates, reason codes, top score/margin, confidence band, action, and fallback reason.

- [ ] **8.3 Test no-guess fallback**

Top below hint => none; medium => hint; top/second within margin => candidate list; low/unknown confidence => no full; incompatible/manual-only => no full; requires-verification => verification capsule at most.

- [ ] **8.4 Test mode × capability cross-product**

Unknown/unsupported capability never yields automatic full. `always` and `compact_only` remain capability-gated. `off` produces no automatic context.

- [ ] **8.5 Test structural and sensitivity limits**

Enforce the shared limits from Task 4. Normal fields may pass. Private fields require explicit policy and `privateEligible=true`. Secret fields are always omitted from automatic context. Hash/bytes are computed after omission/redaction.

- [ ] **8.6 Test adversarial rendering and mode-aware fallback**

Payload includes closing tags, script text, ampersands, oversized/deep values, secret/private strings. Verify escaping and the fallback table:

- smart/always: valid hint only if mode/capability permits;
- hint_only: hint only;
- compact_only: empty + diagnostic on invalid compact capsule;
- off: empty only.

- [ ] **8.7 Test capture strip and self-ingestion**

Cover valid owned capsule, unknown ID, hash/byte mismatch, unsupported schema, malformed/nested wrapper, repeated copies, and round-trip exclusion from memory extraction.

- [ ] **8.8 Commit**

```bash
git add harness/continuity harness/fixtures/continuity/selection-*.json harness/fixtures/continuity/*capsule*.json harness/fixtures/continuity/resume-mode-capability-matrix.json
 git commit -m "test: freeze selection and resume capsule lifecycle"
```

---

## Task 9: Freeze durable-memory revision and evidence-preserving dedupe

**Files:**
- Create: `harness/schema/memory-history.ts`
- Create: `harness/schema/memory-history.schema.json`
- Create: `harness/continuity/memory-history.test.ts`
- Create: `harness/fixtures/memory-history/add-update-supersede-retract.json`
- Create: `harness/fixtures/memory-history/temporal-invalidation.json`
- Create: `harness/fixtures/memory-history/derived-observation-source-links.json`
- Create: `harness/fixtures/memory-history/prefer-consolidated-pack.json`

**Interfaces:**

```ts
projectMemoryHistory(events): MemoryHistoryProjection
selectEvidencePreservingPack(input): MemoryPackSelection
```

- [ ] **9.1 Test append-only history**

ADD/UPDATE/SUPERSEDE/RETRACT creates deterministic projections without mutating prior events. Stale expected revisions fail.

- [ ] **9.2 Test temporal invalidation**

Old fact remains historical but is excluded/down-ranked from current retrieval after invalidation.

- [ ] **9.3 Test source linkage**

Derived observation retains every source memory/event ID. Reference invariant rejects source deletion.

- [ ] **9.4 Test presentation dedupe**

`preferConsolidated=true` suppresses duplicate supporting facts only in output; records remain individually retrievable.

- [ ] **9.5 Commit**

```bash
git add harness/schema/memory-history* harness/continuity/memory-history.test.ts harness/fixtures/memory-history
 git commit -m "test: freeze durable memory history and evidence-preserving dedupe"
```

---

## Task 10: Add single normative quality-report schema and #8 Tier 1 contract

**Files:**
- Create: `benchmarks/behavioral/contract.schema.json`
- Create: `benchmarks/behavioral/fixtures/deterministic/resume-core.json`
- Create: `harness/continuity/run-preflight.ts`
- Create: `harness/phase3-preflight.mjs`

**Normative type:**

```ts
type MetricValue = number | "unsupported";

interface ResumeQualityReportV1 {
  contractVersion: 1;
  runtimeId: string;
  runtimeCommit: string;
  capabilityHash: string;
  fixtureVersion: string;
  schemaHashes: Record<string, string>;
  deterministic: {
    scenarios: number;
    passed: number;
    duplicateFullInjection: number;
    wrongScopeResume: number;
    incompatibleAutoResume: number;
    unsafeUnknownReplay: number;
    earlyAcceptance: number;
    acceptedAttemptOpenCheckpoint: number;
    staleFenceMutation: number;
    capsuleBoundaryEscape: number;
    malformedCapsuleTrusted: number;
    sourceEvidenceDeleted: number;
  };
  behavioral: {
    wrongResumeRate: MetricValue;
    unnecessaryHintRate: MetricValue;
    candidateSelectionAccuracy: MetricValue;
    criticalStateRecall: MetricValue;
    fabricatedStateRate: MetricValue;
    staleFieldRate: MetricValue;
    reExplanationTurns: MetricValue;
    reExplanationTokens: MetricValue;
    firstUsefulActionMs: MetricValue;
    taskCompletionSuccessRate: MetricValue;
    hintTokens: MetricValue;
    fullCapsuleTokens: MetricValue;
    claudeMemBaselineDelta: Record<string, MetricValue>;
  };
}
```

- [ ] **10.1 Write RED report validation**

Reject missing fields, wrong numeric/unsupported types, missing zero counters, or undeclared unsupported metrics.

- [ ] **10.2 Define unsupported semantics**

Schema allows `unsupported` only for behavioral metrics. A manifest declares applicability. A phase/release gate fails when a required metric is missing or unsupported. Zero counters are always numeric.

- [ ] **10.3 Implement stable runner**

Sort fixture IDs, validate all contracts, run reference models, compare expected output, and emit canonical JSON.

- [ ] **10.4 Make fixtures adapter-neutral**

Reference, TS, Rust, and equivalent public claude-mem adapters consume the same format. Unsupported comparisons are explicit, never zero.

- [ ] **10.5 Prove reproducibility**

```bash
node --experimental-strip-types harness/continuity/run-preflight.ts --out /tmp/a.json
node --experimental-strip-types harness/continuity/run-preflight.ts --out /tmp/b.json
cmp /tmp/a.json /tmp/b.json
```

- [ ] **10.6 Commit**

```bash
git add benchmarks/behavioral harness/continuity/run-preflight.ts harness/phase3-preflight.mjs
 git commit -m "test: add normative resume quality report"
```

---

## Task 11: Connect preflight states, doctor, evidence, and CI

**Files:**
- Modify: `harness/README.md`
- Modify: `specs/001-agent-memory-core/tasks.md`
- Modify: `.github/workflows/ci.yml`
- Create: `evidence/phase3-preflight-capability.md`
- Create: `evidence/phase3-preflight-contract.md`
- Create: `harness/fixtures/continuity/doctor-report.json`

- [ ] **11.1 Separate test completion from proven capability**

Evidence records each required scenario as `not_run`, `proven`, `unsupported`, or `unknown_after_test`.

- Contract preflight is complete only when no required scenario is `not_run` and every runtime-neutral contract passes.
- Unsupported/unknown-after-test permits generic/manual implementation but forces strategy/Tier downgrade.
- Automatic Agent/version strategy is enabled only for proven capability.
- Core 1.0/Tier A requires exact release scenarios and #8 quality gates.

- [ ] **11.2 Add P3P-01 through P3P-15 to `tasks.md`**

Barrier:

```text
#1 Stage 0 decision
  + all required capability scenarios executed/dispositioned
  + typed schema/reference/selection/memory-history/report/doctor gates
  -> generic Phase 3 implementation may start

exact automatic Agent strategy
  -> corresponding capability proven

Core 1.0 / Tier A
  -> release E2E + #8 non-inferiority pass
```

P3P-15 remains open until selected TS/Rust runtime consumes the same fixture set.

- [ ] **11.3 Implement `doctor continuity --json` conformance fixture**

Report contains exact version/hash, capability dispositions, selected strategy, mode, threshold/dataset, last decision reasons, reconciliation, active attempt/lease summary, unknown pending count, preflight state/unmet gates, and schema/report hashes. It contains no raw prompt/command/private/secret/capsule content.

- [ ] **11.4 Document commands and evidence**

```bash
node --experimental-strip-types --test harness/continuity/*.test.ts
node --experimental-strip-types harness/continuity/run-preflight.ts --out evidence/phase3-preflight-report.json
```

Evidence includes exact commands, versions, commits, schema/fixture hashes, pass/fail counts, dispositions, rejected assumptions, and synthetic raw-fixture links.

- [ ] **11.5 Add CI after stability proof**

After ten consecutive deterministic runs, CI validates all fixtures, complete report schema, zero counters, required metric applicability, doctor output, and byte reproducibility.

- [ ] **11.6 Self-review complete addendum coverage**

Verify coverage for:

- synthesized capability consistency;
- duplicate-event no-op;
- task-boundary proposal/confirmation;
- pending operation safety;
- fail-closed reconciliation;
- initial claim and atomic acceptance;
- engagement weights/window/contradictions;
- mode × capability;
- limits, sensitivity, and fallback;
- selection threshold/low-confidence candidate list;
- capture-strip/self-ingestion;
- memory revision/temporal/source/dedupe;
- quality report/unsupported semantics;
- preflight-state separation;
- doctor output;
- #8 Core 1.0 authority.

- [ ] **11.7 Commit**

```bash
git add harness/README.md specs/001-agent-memory-core/tasks.md .github/workflows/ci.yml evidence/phase3-preflight-* harness/fixtures/continuity/doctor-report.json
 git commit -m "ci: gate Phase 3 on complete resume preflight"
```

---

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
node -e 'const r=require("/tmp/phase3-preflight.json"); if(r.deterministic.passed!==r.deterministic.scenarios) process.exit(1)'
```

Expected:

- existing Phase 1 suite remains green;
- every deterministic fixture passes;
- every zero-tolerance counter is zero;
- every normative metric is present or explicitly unsupported only where allowed;
- unproven capability cells remain visible;
- reports are byte-reproducible;
- no production continuity code exists before #1 chooses the runtime.

## Execution order

1. Tasks 1–3 determine actual Claude/Codex capabilities.
2. Tasks 4–8 freeze continuity state, claim, selection, and capsule contracts.
3. Task 9 freezes durable-memory history and evidence-preserving retrieval behavior.
4. Task 10 connects the complete contract to #8.
5. Task 11 creates the Phase 3/preflight/Tier gates and doctor evidence.
6. After #1 Go/No-Go, write a separate product implementation plan for the selected runtime using these exact interfaces.
