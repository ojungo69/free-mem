# Resume Continuity Addendum v6.2

Date: 2026-08-16  
Status: **Normative pre-implementation contract**  
Related: #1, #8, #13  
Research basis: [`evidence/phase3-resume-oss-comparison.md`](../../evidence/phase3-resume-oss-comparison.md)

## 0. Authority and scope

This addendum supplements `agent-memory-final-spec-v6.md` v6.1.

When this addendum conflicts with v6.1, it takes precedence only for:

- §7 adapter capability claims used by continuation;
- §10 SessionWorkState / task-state ownership;
- §11 ContinuationCheckpoint, task boundaries, claim, delivery, acceptance, and resume-mode semantics;
- §17 resume hint, selection, full-resume injection, sensitivity, and serialization;
- §27 Phase 3 / Phase 4 / Core 1.0 continuity quality gates.

All Phase 1 sole-writer, fail-open, spool, redaction, peer-auth, backup, and user-authority invariants remain unchanged.

The contract is runtime-language neutral. The TypeScript reference and Rust candidate MUST implement the same schemas, transition semantics, fixtures, hashes, and reports.

Core 1.0 may claim smooth automatic continuation only for an exact Agent/native-CLI/capability-hash tuple that passes §8, the completed preflight in §14, and the release gates in §15.

## 1. Separation of concerns

`free-mem` MUST keep these independent:

1. **Task execution state** — current work and unresolved side effects.
2. **Continuation checkpoint** — immutable point-in-time task state.
3. **Durable memory** — long-lived knowledge searched across tasks/sessions.

A DurableMemory or summary MUST NOT substitute for a checkpoint. Generation, embedding, rerank, and sync failures MUST NOT prevent deterministic continuation.

## 2. Task lineage and boundary decisions

### 2.1 Canonical unit

Canonical mutable work state belongs to a `taskLineageId`, not directly to a session. A session may touch multiple lineages, but Core 1.0 permits at most one active primary binding.

```ts
type TaskBindingRole = "primary" | "side" | "subagent";
type BoundaryEvidenceKind =
  | "explicit_user"
  | "native_fork"
  | "accepted_resume"
  | "agent_proposal"
  | "deterministic_shift";

type TaskBoundaryProposalState = "proposed" | "confirmed" | "rejected";

interface BoundaryEvidence {
  kind: BoundaryEvidenceKind;
  sourceEventIds: string[];
  proposedAt: string;
  confidence?: number;
}

interface SessionTaskBinding {
  sessionId: string;
  taskLineageId: string;
  role: TaskBindingRole;
  boundAt: string;
  unboundAt?: string;
  boundaryEvidence: BoundaryEvidence;
  revision: string;
}

interface TaskBoundaryProposalV1 {
  proposalId: string;
  sessionId: string;
  currentTaskLineageId: string;
  proposedTaskLineageId: string;
  proposedRole: TaskBindingRole;
  evidence: BoundaryEvidence;
  state: TaskBoundaryProposalState;
  revision: string;
}

type TaskBoundaryDecisionV1 =
  | {
      kind: "confirm";
      proposalId: string;
      expectedProposalRevision: string;
      expectedBindingRevision: string;
      source: "user" | "runtime";
      sourceEventIds: string[];
    }
  | {
      kind: "reject";
      proposalId: string;
      expectedProposalRevision: string;
      expectedBindingRevision: string;
      source: "user" | "runtime";
      sourceEventIds: string[];
    };
```

### 2.2 Boundary rules

- `explicit_user`, `native_fork`, and `accepted_resume` may establish a new primary binding.
- Heuristics may only create a proposal; they cannot supersede, retract, unbind, or delete the old lineage.
- Short acknowledgements such as `yes`, `continue`, or `ok` do not create a new task.
- **Confirm** validates proposal/session/binding revisions, marks the proposal confirmed, unbinds the old primary, and creates the new primary binding in one daemon transaction.
- **Reject** validates the same revisions, marks the proposal rejected, and leaves the old binding unchanged.
- Stale, competing, cross-session, or invalid confirm/reject commands are rejected with no binding change.

## 3. Shared evidence types

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type EvidenceKind = "native" | "synthesized" | "derived";
type Freshness = "current" | "stale" | "unknown";
type Sensitivity = "normal" | "private" | "secret";

interface Observed<T extends JsonValue> {
  value: T;
  sourceEventIds: string[];
  ingestSeq: string;
  observedAt: string;
  evidenceKind: EvidenceKind;
  confidence: number; // 0..1
  freshness: Freshness;
  truncated: boolean;
  sensitivity: Sensitivity;
}

interface NormalizedContinuityEvent {
  eventId: string;
  adapterDeliveryId?: string;
  canonicalFingerprint: string;
  kind: string;
  ingestSeq: string;
  occurredAt: string;
  sessionId: string;
  taskLineageId?: string;
  sourceAgent: string;
  payload: JsonValue;
  successful?: boolean;
}
```

Evidence certainty never grants instruction authority. Model output is always `derived` and retains provider/model/prompt/schema/source provenance.

## 4. Canonical task work state

### 4.1 Versioned schema

`canonicalStateJson: unknown` is not a Core 1.0 contract.

```ts
interface ObservedFile {
  path: string;
  role: "active" | "modified" | "read" | "test" | "config" | "unknown";
  contentHash?: string;
  existsAtObservation: boolean;
  sourceEventIds: string[];
  observedAt: string;
  freshness: Freshness;
  sensitivity: Sensitivity;
}

interface ObservedCommand {
  operationId: string;
  commandDisplay: string;
  cwd?: string;
  exitCode?: number;
  status: "succeeded" | "failed" | "unknown";
  sourceEventIds: string[];
  observedAt: string;
  evidenceKind: EvidenceKind;
  sensitivity: Sensitivity;
}

interface ObservedTest {
  operationId: string;
  commandDisplay?: string;
  target?: string;
  status: "passed" | "failed" | "partial" | "unknown";
  summary?: string;
  sourceEventIds: string[];
  observedAt: string;
  evidenceKind: EvidenceKind;
  sensitivity: Sensitivity;
}

type ReplayPolicy = "never_auto" | "verify_first" | "safe_idempotent";

interface PendingOperation {
  operationId: string;
  kind:
    | "command"
    | "file_mutation"
    | "test"
    | "tool"
    | "migration"
    | "external_side_effect"
    | "other";
  description: string;
  status: "started" | "succeeded" | "failed" | "unknown";
  replayPolicy: ReplayPolicy;
  sourceEventIds: string[];
  startedAt: string;
  terminalAt?: string;
  idempotencyKey?: string;
  verificationHint?: string;
  sensitivity: Sensitivity;
}

interface RepositoryStateSnapshot {
  repositoryId: string;
  workspaceId: string;
  branchKey?: string;
  worktreeId?: string;
  headSha?: string;
  upstreamSha?: string;
  dirtyTreeFingerprint?: string;
  gitStatusSummary?: string;
  capturedAt: string;
}

interface SemanticResumeNoteV1 {
  schemaVersion: 1;
  goal?: string;
  completed: string[];
  currentState?: string;
  nextActions: string[];
  blockers: string[];
  unresolvedQuestions: string[];
  providerId: string;
  modelId: string;
  promptHash: string;
  generatedFromIngestSeq: string;
  confidence: number;
  sourceEventIds: string[];
  sensitivity: Sensitivity;
}

interface CanonicalWorkStateV1 {
  schemaVersion: 1;
  taskLineageId: string;
  projectId: string;
  workspaceId: string;
  branchKey?: string;
  sourceAgent: string;
  latestSubstantivePrompt?: Observed<string>;
  lastAssistantConclusion?: Observed<string>;
  nativeTodoState?: Observed<JsonValue>;
  activeFiles: ObservedFile[];
  modifiedFiles: ObservedFile[];
  recentCommands: ObservedCommand[];
  recentTests: ObservedTest[];
  pendingOperations: PendingOperation[];
  repositoryState: RepositoryStateSnapshot;
  semanticResumeNote?: SemanticResumeNoteV1;
  sensitivity: Sensitivity;
  lastIngestSeq: string;
  stateRevision: string;
  updatedAt: string;
}
```

### 4.2 Immutable revisions and duplicate no-op

- Work-state revisions are immutable; one pointer selects the current revision per lineage.
- Dedupe authority is `adapterDeliveryId` or the v6.1 canonical event fingerprint.
- Dedupe is checked **before** allocating a revision.
- A duplicate logical event is a no-op: return the same state bytes, content hash, revision pointer, and history.
- Late terminal/correction events create later revisions without rewriting source evidence.
- Semantic refinement cannot alter canonical observed fields.

### 4.3 Pending operations

- Stable start evidence creates `started`.
- Trustworthy terminal evidence creates `succeeded` or `failed`.
- Missing or ambiguous terminal evidence becomes `unknown`.
- Unknown renders as `result unknown; verify current state before retry`.
- Shell commands default to `verify_first`; migrations/deploys/publishing/destructive/external/credential operations default to `never_auto`.
- `safe_idempotent` requires an explicit idempotency contract and matching capability evidence.

## 5. Immutable checkpoints and disposition history

```ts
interface ContinuationCheckpointV2 {
  id: string;
  schemaVersion: 2;
  checkpointRevision: string;
  projectId: string;
  workspaceId: string;
  branchKey?: string;
  taskLineageId: string;
  sourceSessionId: string;
  sourceAgent: string;
  kind: "pre_compact" | "session_end" | "idle" | "manual" | "crash_recovery";
  parentCheckpointId?: string;
  workStateRevision: string;
  canonicalState: CanonicalWorkStateV1;
  memoryWatermark: string;
  contentHash: string;
  sensitivity: Sensitivity;
  createdAt: string;
  expiresAt?: string;
}

type CheckpointDispositionKind =
  | "created"
  | "accepted"
  | "superseded"
  | "expired"
  | "reopened"
  | "retracted";

interface CheckpointDispositionEvent {
  eventId: string;
  checkpointId: string;
  kind: CheckpointDispositionKind;
  expectedProjectionRevision: string;
  resultingProjectionRevision: string;
  relatedCheckpointId?: string;
  relatedDeliveryAttemptId?: string;
  reasonCode: string;
  source: "daemon" | "runtime" | "user";
  createdAt: string;
}

interface CheckpointDispositionProjection {
  checkpointId: string;
  state: "open" | "accepted" | "superseded" | "expired" | "retracted";
  projectionRevision: string;
  latestEventId: string;
  activeDeliveryAttemptId?: string;
  activeLeaseUntil?: string;
}

interface CheckpointMetadataV1 {
  checkpointId: string;
  checkpointRevision: string;
  taskLineageId: string;
  kind: ContinuationCheckpointV2["kind"];
  sourceSessionId: string;
}

interface DispositionAuthorityContextV1 {
  source: "daemon" | "runtime" | "user";
  userAuthorizedCrossLineage: boolean;
  sourceEventIds: string[];
}
```

Disposition projection/validation MUST receive the event list, a checkpoint metadata lookup, and authority context.

- Accepted/superseded/expired/retracted are excluded from automatic candidates.
- Reopen creates a new open projection revision.
- Daemon/runtime supersede is valid only when source and related checkpoints share `taskLineageId`.
- Cross-lineage supersede requires explicit user-authoritative context.
- Missing related-checkpoint metadata fails closed; it never assumes same lineage.

## 6. Claim, delivery, engagement, and acceptance

### 6.1 Delivery attempt and commands

```ts
type DeliveryAttemptState =
  | "claimed"
  | "delivered"
  | "engaged"
  | "accepted"
  | "dismissed"
  | "abandoned";

type EngagementEvidenceKind =
  | "explicit_accept"
  | "explicit_continue_prompt"
  | "related_file_action"
  | "related_command"
  | "related_test"
  | "related_todo_progress"
  | "manual_resume_tool";

interface CheckpointAnchorV1 {
  anchorId: string;
  kind: "file" | "symbol" | "command" | "test" | "todo" | "task_lineage";
  valueHash: string;
  sourceEventIds: string[];
}

interface EngagementEvidence {
  kind: EngagementEvidenceKind;
  sourceEventIds: string[];
  score: number;
  checkpointAnchorIds: string[];
  successful: boolean;
  observedAt: string;
}

interface ContradictionEvidenceV1 {
  contradictionId: string;
  kind: "explicit_rejection" | "new_task_confirmed" | "workspace_incompatible" | "runtime_invalidated";
  sourceEventIds: string[];
  observedAt: string;
}

interface EngagementEvaluationContextV1 {
  sourceEvents: NormalizedContinuityEvent[];
  checkpointAnchors: CheckpointAnchorV1[];
  contradictions: ContradictionEvidenceV1[];
  destinationTurnId: string;
  evaluationStartedAt: string;
  evaluationEndedAt: string;
}

interface CheckpointDeliveryAttempt {
  attemptId: string;
  checkpointId: string;
  checkpointRevision: string;
  destinationSessionId: string;
  destinationAgent: string;
  state: DeliveryAttemptState;
  claimFence: string;
  leaseUntil: string;
  heartbeatUntil: string;
  injectedContentHash?: string;
  injectionId?: string;
  engagementEvidence: EngagementEvidence[];
  createdAt: string;
  deliveredAt?: string;
  engagedAt?: string;
  acceptedAt?: string;
  dismissedAt?: string;
  abandonedAt?: string;
  revision: string;
}

type DeliveryCommandV1 =
  | { kind: "mark_delivered"; attemptId: string; revision: string; fence: string; sessionId: string; contentHash: string }
  | { kind: "record_engagement"; attemptId: string; revision: string; fence: string; sessionId: string; evidence: EngagementEvidence }
  | { kind: "accept"; attemptId: string; revision: string; fence: string; sessionId: string; projectionRevision: string }
  | { kind: "dismiss"; attemptId: string; revision: string; fence: string; sessionId: string }
  | { kind: "abandon"; attemptId: string; revision: string; fence: string; sessionId: string; reason: string };
```

Every post-claim command validates the caller-supplied `attemptId`, attempt revision, fence, and destination session. A mismatched attempt ID is a typed stale/invalid request and causes no state change.

### 6.2 Initial claim CAS

The candidate-to-claimed operation is a daemon transaction that:

1. loads checkpoint projection by checkpoint ID + expected projection revision;
2. requires `open` and no unexpired active attempt;
3. validates destination session/task binding, delivery boundary, selected mode, capability, selection decision, and reconciliation;
4. creates attempt ID and fenced claim token;
5. inserts the claimed attempt;
6. sets active attempt/lease on the projection;
7. commits together.

Concurrent claims yield exactly one winner. Expiry/replacement uses CAS on projection revision and active attempt identity.

### 6.3 Deterministic engagement

Contract v1 weights:

| Evidence | Score | Requirement |
|---|---:|---|
| explicit_accept | 1.00 | explicit user or user-authoritative UI/CLI |
| manual_resume_tool | 1.00 | user-authoritative invocation |
| explicit_continue_prompt | 0.35 | prompt positively references task/checkpoint |
| related_file_action | 0.35 | successful event linked to file/symbol anchor |
| related_command | 0.40 | successful event linked to command/task anchor |
| related_test | 0.50 | successful/meaningful test linked to checkpoint work |
| related_todo_progress | 0.40 | deterministic todo transition linked to lineage |

- Duplicate `(kind, sourceEventId)` counts once.
- Failed/unknown/unrelated events score zero.
- Evidence labels are not trusted by themselves. The evaluator MUST verify each source event exists in `EngagementEvaluationContextV1`, has the expected kind/success state, occurs after delivery and before evaluation end, and links to a declared anchor.
- `engaged`: one valid linked item score `>=0.35`.
- Automatic `accepted`: cumulative score `>=0.80`, at least two evidence kinds, at least one successful runtime kind, no contradiction.
- Explicit user/manual acceptance may atomically perform delivered/engaged/accepted at score `1.00`.
- Window is bounded by active lease and 30 minutes.
- Explicit rejection, confirmed other task, incompatible reconciliation, or invalidating runtime evidence blocks automatic acceptance.
- Agent prose alone never constitutes explicit acceptance.

### 6.4 Atomic acceptance

Acceptance receives attempt, current disposition events/projection, checkpoint metadata, authority context, and verified engagement context. In one transaction it:

1. validates command attempt ID/revision/fence/session;
2. revalidates engagement from normalized source events and anchors;
3. verifies no later contradiction;
4. verifies open checkpoint projection and active attempt identity;
5. appends accepted disposition linked to the attempt;
6. advances projection to accepted and clears active claim;
7. advances attempt to accepted;
8. commits all or none.

An accepted attempt with an open checkpoint projection is invalid.

## 7. Fail-closed workspace reconciliation

```ts
type ReconciliationStatus =
  | "exact"
  | "fast_forward_compatible"
  | "stale_but_usable"
  | "requires_verification"
  | "incompatible";
```

Required checks: repository/workspace identity, branch/worktree, HEAD ancestry, dirty fingerprint, relevant file existence/hash, test/config drift, and pending operations.

- `exact` requires every applicable check to be positively completed and matched.
- Missing hash, unreadable path, unknown ancestry, unknown branch/worktree relationship, contradiction, or unclassified drift is at least `requires_verification`.
- Repository/workspace mismatch is `incompatible`.
- Fast-forward with unchanged affected files is `fast_forward_compatible`.
- Classified low-risk drift is `stale_but_usable`.
- `requires_verification` permits only a verification capsule; `incompatible` prohibits automatic full resume.
- No unhandled input may fall through to exact.

Core 1.0 does not automatically restore workspace files. A future snapshot provider requires separate ADR/security/storage/UX evidence.

## 8. Exact-version capability strategy

```ts
type ResumeDeliveryStrategy =
  | "native_prompt_gate"
  | "session_start_full"
  | "next_prompt_synthesized"
  | "manual_only";
```

- `native_prompt_gate`: pre-model first-prompt delivery is native and real-CLI proven.
- `next_prompt_synthesized`: both pre-model delivery and prompt-aware injection are synthesized by the same exact-version real-CLI fixture/evidence hash.
- `session_start_full`: SessionStart injection is native/synthesized and proven, but prompt-gated proof is absent.
- `manual_only`: no reliable automatic path.

A half-proven synthesized pair is invalid. Source declarations/README claims are insufficient.

Tier A requires exact-version proof of hint delivery, claimed prompt-gate delivery, compact persistence/fallback, exactly-one compact restore, retry dedupe, crash/restart semantics, and size/malformed behavior.

At publication, Claude and Codex SessionStart injection are proven; prompt-aware/compact paths remain unproven and must downgrade.

## 9. Resume modes and delivery boundaries

```ts
type ResumeMode = "smart" | "always" | "hint_only" | "compact_only" | "off";
type ResumeDeliveryBoundary = "session_start" | "first_user_prompt" | "post_compact" | "manual";
```

Mode and exact capability are intersected at a specific boundary:

| Mode | session_start | first_user_prompt | post_compact | manual |
|---|---|---|---|---|
| smart | proven hint only | full only with proven prompt gate + selection/reconciliation | full only with proven compact single-delivery | allowed |
| always | full only with proven SessionStart path | no duplicate automatic full if already delivered; otherwise proven prompt fallback only | full only with proven compact single-delivery | allowed |
| hint_only | proven hint only | no automatic full | no automatic full | allowed |
| compact_only | none | none | full only with proven compact single-delivery | allowed |
| off | none | none | none | allowed |

Boundary is explicit in selection input/output and fixtures. Checkpoint kind or prompt presence is not used to guess the delivery boundary.

## 10. Bounded, sensitivity-aware capsule lifecycle

Shared limits:

```text
hint tokens 120; full capsule tokens 700; prompt-memory tokens 700;
combined automatic tokens 1500; absolute tokens 1800;
payload bytes 32768; wrapper bytes 36864; JSON depth 12;
string UTF-8 bytes 8192; array items 256; object keys 128; candidates 5.
```

```ts
interface ResumeCapsuleV1 {
  schemaVersion: 1;
  injectionId: string;
  checkpointId: string;
  checkpointRevision: string;
  taskLineageId: string;
  sourceAgent: string;
  ageSeconds: number;
  reconciliation: ReconciliationStatus;
  workState: CanonicalWorkStateV1;
  selectedMemoryIds: string[];
  warnings: string[];
}
```

Sensitivity is filtered before canonical serialization:

- `normal`: eligible by scope/relevance/budget.
- `private`: excluded unless explicit project opt-in and destination `privateEligible=true`; otherwise metadata-only omission/warning.
- `secret`: never automatic; value removed, non-sensitive omission provenance retained.
- Derived notes inherit maximum source sensitivity.
- Hash/bytes are calculated after selection, omission, and redaction.

Rendering stable-sorts JSON, enforces limits, escapes `<`, `>`, `&`, includes schema/bytes/hash/injection ID, and never concatenates raw historical text outside the encoder.

Capture parses and verifies wrapper boundary, schema, bytes, hash, injection ID, and owned ledger:

- valid owned capsule: strip fully; retain metadata only;
- unknown ID, bad hash/size/schema, malformed/nested wrapper: do not trust or auto-promote; retain as protected evidence and emit diagnostic;
- parser failure never blocks the coding Agent;
- round-trip self-ingestion prevention is blocking.

Invalid/oversized fallback obeys mode and boundary: `off` => empty; `compact_only` post-compact => empty+diagnostic; `hint_only` => valid hint only; `smart/always` => valid proven hint only, otherwise empty. Invalid full capsules are never claimed/delivered.

## 11. Dataset-versioned resume selection

```ts
interface ResumeThresholdProfileV1 {
  profileId: string;
  datasetVersion: string;
  fullResumeMinScore: number;
  hintMinScore: number;
  ambiguityMargin: number;
  maxCandidates: number;
}

type ResumeDecisionAction =
  | "none"
  | "hint"
  | "candidate_list"
  | "verification_capsule"
  | "full_capsule"
  | "manual_only";

interface RankedResumeCandidateV1 {
  rank: number;
  checkpointId: string;
  checkpointRevision: string;
  taskLineageId: string;
  score: number;
  reconciliationStatus: ReconciliationStatus;
  reasonCodes: string[];
  ageSeconds: number;
}

interface ResumeSelectionDecisionV1 {
  schemaVersion: 1;
  boundary: ResumeDeliveryBoundary;
  datasetVersion: string;
  thresholdProfileId: string;
  capabilityHash: string;
  strategy: ResumeDeliveryStrategy;
  mode: ResumeMode;
  action: ResumeDecisionAction;
  selectedCheckpointId?: string;
  rankedCandidates: RankedResumeCandidateV1[];
  topScore?: number;
  topMargin?: number;
  confidenceBand: "high" | "medium" | "low" | "none";
  decisionReasonCodes: string[];
  fallbackReasonCode?: string;
  reconciliationReportHash?: string;
}
```

Initial preflight profile: full `0.75`, hint `0.35`, ambiguity margin `0.08`, max candidates `5`.

- Top below hint => none.
- Between hint/full => hint or candidate list.
- Top above full but second within margin => candidate list, never guess.
- Low/unknown confidence, contradictory reasons, unproven capability, mode mismatch, or incompatible workspace => no full.
- `requires_verification` => verification capsule at most.
- Full requires exactly one high-confidence candidate, outside ambiguity margin, at an allowed boundary/mode/capability/reconciliation state.
- Decision/reasons are persisted. Threshold changes require dataset bump and reviewed before/after report.

## 12. Durable-memory history and evidence preservation

- Semantic notes and consolidated memories retain source event/fact IDs.
- Raw evidence is not deleted during derivation.
- Memory changes are append-only ADD/UPDATE/SUPERSEDE/RETRACT events.
- Temporal validity/invalidation is retained when supported by evidence.
- Stale/contradicted facts remain inspectable but are excluded/down-ranked from current retrieval.
- Output may prefer consolidated observations while preserving source records.
- Presentation dedupe never deletes source evidence.

## 13. Preflight and automatic-support states

```ts
type CapabilityTestDisposition = "not_run" | "proven" | "unsupported" | "unknown_after_test";
type ContractPreflightState = "incomplete" | "complete";
```

Contract preflight is complete only when all required scenarios are not `not_run`, evidence artifacts exist, matrices are regenerated honestly, all runtime-neutral contract fixtures pass, and #1 Stage 0 fixes runtime direction.

Unsupported/unknown-after-test does not block generic/manual continuity implementation; it forces strategy/Tier downgrade. A particular automatic strategy is enabled only when its required exact-version capability is `proven`. Tier A/Core 1.0 also require release E2E and #8 quality.

## 14. Normative quality and doctor reports

`benchmarks/behavioral/contract.schema.json` is the sole machine-readable authority for `ResumeQualityReportV1`.

Zero-tolerance numeric counters include duplicate injection, wrong scope, incompatible auto-resume, unsafe unknown replay, early acceptance, accepted-attempt/open-checkpoint, stale fence, capsule boundary escape, malformed capsule trusted, and source evidence deletion. All must be zero; deterministic critical scenarios must be 100% pass.

Behavioral metrics include wrong resume, unnecessary hint, candidate accuracy, critical-state recall, fabricated/stale state, re-explanation turns/tokens, first useful action, task completion, hint/full tokens, and claude-mem baseline delta. `unsupported` is allowed only where declared inapplicable; a required metric marked unsupported fails the gate.

`doctor continuity --json` is versioned and reports exact version/capability hash, scenario dispositions, strategy, mode, threshold/dataset, last boundary/selection reasons, reconciliation, active attempt/lease summary, unknown pending count, preflight/unmet gate IDs, and schema/fixture/report hashes. It never emits raw prompts, commands, private/secret values, or capsule content.

Major public resume scenarios MUST meet #8's frozen claude-mem non-inferiority gate or receive an explicit reviewed exception ADR before Core 1.0.

## 15. Non-goals

- Reproducing private claude-mem/CMEM prompts/services.
- Treating model output as canonical truth.
- Automatically restoring workspace files in Core 1.0.
- Requiring shadow Git.
- Letting heuristic boundaries delete/supersede work.
- Claiming Tier A from source inspection.
- Automatically replaying unknown external side effects.
- Weakening Phase 1 safety/security/backup gates.

## 16. Exit criteria

Implemented when machine-readable schemas/fixtures exist; TS/Rust consume identical fixtures; exact Claude/Codex dispositions are recorded; task state/idempotency, boundary confirm/reject, pending operations, lineage-aware dispositions, initial claim, source-verified engagement, atomic acceptance, fail-closed reconciliation, explicit delivery boundaries, selection, sensitivity, capsule render/capture, memory history, quality report, and doctor all pass; and Phase 3/Core 1.0 gates enforce this addendum.
