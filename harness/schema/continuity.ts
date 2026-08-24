import type { EventKind } from "./capability.ts";

/** 継続契約のスキーマ版。 */
export const CONTINUITY_SCHEMA_VERSION: 1 = 1;

/** §10 の共有上限。 */
export const CONTINUITY_LIMITS = {
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

/** spec 005 / #132 S0 successor contract bundle version. */
export const SOURCE_AWARE_CONTINUITY_CONTRACT_VERSION: 1 = 1;
export const SOURCE_AWARE_SHA256_PATTERN = "^[0-9a-f]{64}$";

export type Sha256Hex = string;
export type OpaqueIdV1 = string;
export type GitObjectIdV1 = string;

export type CanonicalClientIdV1 = "claude-code" | "codex-cli";
export const CANONICAL_CLIENT_IDS_V1 = [
  "claude-code",
  "codex-cli",
] as const satisfies readonly CanonicalClientIdV1[];

export type SharingScopeV1 =
  | "agent_private"
  | "task_shared"
  | "project_shared"
  | "personal_shared";
export const SHARING_SCOPES_V1 = [
  "agent_private",
  "task_shared",
  "project_shared",
  "personal_shared",
] as const satisfies readonly SharingScopeV1[];

export type EgressPolicyV1 = "eligible" | "local_only" | "prohibited_egress";
export const EGRESS_POLICIES_V1 = [
  "eligible",
  "local_only",
  "prohibited_egress",
] as const satisfies readonly EgressPolicyV1[];

export type ResumeProfileV1 = "same_agent" | "cross_agent";
export const RESUME_PROFILES_V1 = [
  "same_agent",
  "cross_agent",
] as const satisfies readonly ResumeProfileV1[];

export type LegacyMigrationDispositionV1 = "migrate" | "legacy_read_only" | "quarantine";
export const LEGACY_MIGRATION_DISPOSITIONS_V1 = [
  "migrate",
  "legacy_read_only",
  "quarantine",
] as const satisfies readonly LegacyMigrationDispositionV1[];

export type TaskBindingRole = "primary" | "side" | "subagent";

export const TASK_BINDING_ROLES = ["primary", "side", "subagent"] as const satisfies readonly TaskBindingRole[];

export type BoundaryEvidenceKind =
  | "explicit_user"
  | "native_fork"
  | "accepted_resume"
  | "agent_proposal"
  | "deterministic_shift";

export const BOUNDARY_EVIDENCE_KINDS = [
  "explicit_user",
  "native_fork",
  "accepted_resume",
  "agent_proposal",
  "deterministic_shift",
] as const satisfies readonly BoundaryEvidenceKind[];

export type TaskBoundaryProposalState = "proposed" | "confirmed" | "rejected";

export const TASK_BOUNDARY_PROPOSAL_STATES = [
  "proposed",
  "confirmed",
  "rejected",
] as const satisfies readonly TaskBoundaryProposalState[];

export interface BoundaryEvidence {
  kind: BoundaryEvidenceKind;
  sourceEventIds: string[];
  proposedAt: string;
  confidence?: number;
}

export interface SessionTaskBinding {
  sessionId: string;
  taskLineageId: string;
  role: TaskBindingRole;
  boundAt: string;
  unboundAt?: string;
  boundaryEvidence: BoundaryEvidence;
  revision: string;
}

export interface TaskBoundaryProposalV1 {
  proposalId: string;
  sessionId: string;
  currentTaskLineageId: string;
  proposedTaskLineageId: string;
  proposedRole: TaskBindingRole;
  evidence: BoundaryEvidence;
  state: TaskBoundaryProposalState;
  revision: string;
}

export type TaskBoundaryDecisionSource = "user" | "native_runtime";

export const TASK_BOUNDARY_DECISION_SOURCES = [
  "user",
  "native_runtime",
] as const satisfies readonly TaskBoundaryDecisionSource[];

export type TaskBoundaryDecisionV1 =
  | {
      kind: "confirm";
      proposalId: string;
      expectedProposalRevision: string;
      expectedBindingRevision: string;
      source: TaskBoundaryDecisionSource;
      sourceEventIds: string[];
    }
  | {
      kind: "reject";
      proposalId: string;
      expectedProposalRevision: string;
      expectedBindingRevision: string;
      source: TaskBoundaryDecisionSource;
      sourceEventIds: string[];
    };

export interface TaskBoundaryAuthorityContextV1 {
  // §2.2 caller の source 値ではなく、解決済み event から権限を検証する
  sourceEvents: NormalizedContinuityEvent[];
  agent: string;
  exactAgentVersion: string;
  capabilityHash: string;
  provenScenarioIds: string[];
  userSurfaceAuthority?: {
    surface: "cli" | "viewer" | "mcp_user_authority";
    grantedAt: string;
  };
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type EvidenceKind = "native" | "synthesized" | "derived";

export const EVIDENCE_KINDS = ["native", "synthesized", "derived"] as const satisfies readonly EvidenceKind[];

export type Freshness = "current" | "stale" | "unknown";

export const FRESHNESS_VALUES = ["current", "stale", "unknown"] as const satisfies readonly Freshness[];

export type Sensitivity = "normal" | "private" | "secret";

export const SENSITIVITIES = ["normal", "private", "secret"] as const satisfies readonly Sensitivity[];

export interface Observed<T extends JsonValue> {
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

export type ContinuityCaptureMethod =
  | "native_event"
  | "hook"
  | "plugin"
  | "transcript_scan"
  | "user_surface";

export const CONTINUITY_CAPTURE_METHODS = [
  "native_event",
  "hook",
  "plugin",
  "transcript_scan",
  "user_surface",
] as const satisfies readonly ContinuityCaptureMethod[];

export interface ContinuityIngestAttestationV1 {
  ingestReceiptId: string;
  peerIdentityId: string;
  channel: "rpc" | "spool";
  attestedAt: string;
}

export interface ContinuityEventProvenanceV1 {
  sourceAgentVersion: string;
  // §3.1 daemon intake 層が割り当て、caller の値は信頼しない
  evidenceKind: EvidenceKind;
  captureMethod: ContinuityCaptureMethod;
  capabilityHash?: string;
  scenarioId?: string;
  // §3.1 daemon intake 層が割り当て、caller の値は信頼しない
  ingestAttestation?: ContinuityIngestAttestationV1;
}

export type TurnIdSource = "native" | "synthesized_monotonic" | "unavailable";

export const TURN_ID_SOURCES = [
  "native",
  "synthesized_monotonic",
  "unavailable",
] as const satisfies readonly TurnIdSource[];

export type ContinuityOperationPhase = "start" | "progress" | "terminal";

export const CONTINUITY_OPERATION_PHASES = [
  "start",
  "progress",
  "terminal",
] as const satisfies readonly ContinuityOperationPhase[];

/**
 * §3.1「`operation` は kind が operation の start / progress / terminal である event に必須」を
 * 判定するための正本（#29）。addendum は operation 系 kind を列挙していないため、harness の
 * 正規化 event 語彙（`EventKind`）に対する分類をここで固定する。`NormalizedContinuityEvent.kind`
 * は adapter 固有の値も取り得る開いた文字列であり、この表にも `NON_OPERATION_EVENT_KINDS` にも
 * 無い kind は未分類として envelope を要求しない。
 */
export const OPERATION_EVENT_PHASES = {
  tool_started: "start",
  tool_completed: "terminal",
  tool_failed: "terminal",
} as const satisfies Partial<Record<EventKind, ContinuityOperationPhase>>;

/** operation 系でないと確定している kind。`OPERATION_EVENT_PHASES` との和が `EVENT_KINDS` に一致する。 */
export const NON_OPERATION_EVENT_KINDS = [
  "session_started",
  "user_prompted",
  "assistant_completed",
  "turn_completed",
  "pre_compact",
  "post_compact",
  "session_idle",
  "session_interrupted",
  "session_ended",
] as const satisfies readonly EventKind[];

export interface ContinuityOperationRefV1 {
  phase: ContinuityOperationPhase;
  // §4.3 terminal correlation の正本となる schema-versioned hash
  operationMatchKey: string;
  operationKind: string;
  nativeOperationId?: string;
  canonicalInputHash?: string;
}

export interface NormalizedContinuityEvent {
  eventId: string;
  adapterDeliveryId?: string;
  canonicalFingerprint: string;
  kind: string;
  ingestSeq: string;
  occurredAt: string;
  sessionId: string;
  taskLineageId?: string;
  turnId?: string;
  turnIdSource: TurnIdSource;
  sourceAgent: string;
  provenance: ContinuityEventProvenanceV1;
  // §3.1 operation event の correlation 値は payload ではなくこの envelope を使う
  operation?: ContinuityOperationRefV1;
  payload: JsonValue;
  successful?: boolean;
}

export interface ObservedFile {
  path: string;
  role: "active" | "modified" | "read" | "test" | "config" | "unknown";
  contentHash?: string;
  existsAtObservation: boolean;
  sourceEventIds: string[];
  observedAt: string;
  freshness: Freshness;
  sensitivity: Sensitivity;
}

export interface ObservedCommand {
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

export interface ObservedTest {
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

export interface OperationCorrelationV1 {
  operationId: string;
  startEventId: string;
  nativeOperationId?: string;
  operationMatchKey: string;
  sessionId: string;
  taskLineageId: string;
  turnId?: string;
  toolName?: string;
  canonicalInputHash?: string;
}

export type ReplayPolicy = "never_auto" | "verify_first" | "safe_idempotent";

export const REPLAY_POLICIES = [
  "never_auto",
  "verify_first",
  "safe_idempotent",
] as const satisfies readonly ReplayPolicy[];

export interface PendingOperation {
  operationId: string;
  correlation: OperationCorrelationV1;
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
  // §4.3 unknown side effect の自動再実行可否
  replayPolicy: ReplayPolicy;
  sourceEventIds: string[];
  startedAt: string;
  terminalAt?: string;
  idempotencyKey?: string;
  verificationHint?: string;
  sensitivity: Sensitivity;
  // §4.3 の権威順序・turn 両立を状態だけで判定するための start 側の材料（#35）
  startIngestSeq?: string;
  startTurnIdSource?: TurnIdSource;
  // §4.3 の衝突検査に使う、この operation を閉じた terminal の指紋（#44）
  terminalFingerprint?: string;
}

export interface DroppedEvidenceEntryV1 {
  reason: "evicted" | "orphaned_terminal";
  recordedAt: string;
  sensitivity: Sensitivity;
  eventId?: string;
  operationId?: string;
  status?: "started" | "succeeded" | "failed" | "unknown";
  // 再送で記録が増えないようにするための鍵（#39）。監査用の識別子は eventId のほう。
  // 第一 authority は adapterDeliveryId で、指紋はそれを名乗らない記録の fallback（§8.2 と同じ順）
  terminalFingerprint?: string;
  adapterDeliveryId?: string;
}

export interface RepositoryStateSnapshot {
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

export interface SemanticResumeNoteV1 {
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

export interface OpaqueIdProfileV1 {
  readonly schemaVersion: 1;
  readonly algorithm: "hmac-sha-256";
  readonly keyId: string;
  readonly outputEncoding: "lowercase_hex_256";
}

export type OpaqueIdKindV1 =
  | "personal_vault_id"
  | "project_id"
  | "workspace_id"
  | "branch_key"
  | "task_lineage_id"
  | "session_id"
  | "turn_id"
  | "decision_event_id"
  | "source_event_id"
  | "ingest_receipt_id"
  | "peer_identity_id"
  | "daemon_id"
  | "operation_id"
  | "native_operation_id"
  | "operation_match_key"
  | "idempotency_key"
  | "terminal_fingerprint"
  | "adapter_delivery_id"
  | "repository_id"
  | "worktree_id"
  | "dirty_tree_fingerprint"
  | "device_id"
  | "checkpoint_id"
  | "injection_id"
  | "memory_id"
  | "evidence_snapshot_id";
export const OPAQUE_ID_KINDS_V1 = [
  "personal_vault_id",
  "project_id",
  "workspace_id",
  "branch_key",
  "task_lineage_id",
  "session_id",
  "turn_id",
  "decision_event_id",
  "source_event_id",
  "ingest_receipt_id",
  "peer_identity_id",
  "daemon_id",
  "operation_id",
  "native_operation_id",
  "operation_match_key",
  "idempotency_key",
  "terminal_fingerprint",
  "adapter_delivery_id",
  "repository_id",
  "worktree_id",
  "dirty_tree_fingerprint",
  "device_id",
  "checkpoint_id",
  "injection_id",
  "memory_id",
  "evidence_snapshot_id",
] as const satisfies readonly OpaqueIdKindV1[];

export interface OpaqueIdConformanceTestVectorV1 {
  readonly keyHex: string;
  readonly input: {
    readonly domain: "free-mem/OpaqueIdV1/v1";
    readonly kind: OpaqueIdKindV1;
    readonly value: JsonValue;
  };
  readonly opaqueId: OpaqueIdV1;
}

export interface OpaqueIdConformanceProfileV1 {
  readonly schemaVersion: 1;
  readonly algorithm: "hmac-sha-256";
  readonly keyResolution: "keyId_from_personal_vault_keyring";
  readonly keyEncoding: "lowercase_hex";
  readonly minimumKeyBytes: 32;
  readonly inputCanonicalization: "rfc8785-jcs";
  readonly derivationDomain: "free-mem/OpaqueIdV1/v1";
  readonly messageFields: readonly ["domain", "kind", "value"];
  readonly idKinds: readonly OpaqueIdKindV1[];
  readonly outputEncoding: "lowercase_hex_256";
  readonly testVector: OpaqueIdConformanceTestVectorV1;
}

export interface PersonalVaultSubjectScopeV1 {
  readonly kind: "personal_vault";
  readonly personalVaultId: OpaqueIdV1;
}

export interface ProjectSubjectScopeV1 {
  readonly kind: "project";
  readonly personalVaultId: OpaqueIdV1;
  readonly projectId: OpaqueIdV1;
}

export interface WorkspaceSubjectScopeV1 {
  readonly kind: "workspace";
  readonly personalVaultId: OpaqueIdV1;
  readonly projectId: OpaqueIdV1;
  readonly workspaceId: OpaqueIdV1;
}

export interface BranchSubjectScopeV1 {
  readonly kind: "branch";
  readonly personalVaultId: OpaqueIdV1;
  readonly projectId: OpaqueIdV1;
  readonly workspaceId: OpaqueIdV1;
  readonly branchKey: OpaqueIdV1;
}

export interface TaskLineageSubjectScopeV1 {
  readonly kind: "task_lineage";
  readonly personalVaultId: OpaqueIdV1;
  readonly projectId: OpaqueIdV1;
  readonly workspaceId: OpaqueIdV1;
  readonly branchKey?: OpaqueIdV1;
  readonly taskLineageId: OpaqueIdV1;
}

export interface SessionSubjectScopeV1 {
  readonly kind: "session";
  readonly personalVaultId: OpaqueIdV1;
  readonly projectId: OpaqueIdV1;
  readonly workspaceId: OpaqueIdV1;
  readonly branchKey?: OpaqueIdV1;
  readonly taskLineageId: OpaqueIdV1;
  readonly sessionId: OpaqueIdV1;
}

export interface TurnSubjectScopeV1 {
  readonly kind: "turn";
  readonly personalVaultId: OpaqueIdV1;
  readonly projectId: OpaqueIdV1;
  readonly workspaceId: OpaqueIdV1;
  readonly branchKey?: OpaqueIdV1;
  readonly taskLineageId: OpaqueIdV1;
  readonly sessionId: OpaqueIdV1;
  readonly turnId: OpaqueIdV1;
}

export type SubjectScopeV1 =
  | PersonalVaultSubjectScopeV1
  | ProjectSubjectScopeV1
  | WorkspaceSubjectScopeV1
  | BranchSubjectScopeV1
  | TaskLineageSubjectScopeV1
  | SessionSubjectScopeV1
  | TurnSubjectScopeV1;

export type SharingGrantScopeV1 = "task_shared" | "project_shared" | "personal_shared";
export const SHARING_GRANT_SCOPES_V1 = [
  "task_shared",
  "project_shared",
  "personal_shared",
] as const satisfies readonly SharingGrantScopeV1[];

export interface SharedTaskProjectionTargetV1 {
  readonly kind: "shared_task_projection";
  readonly taskLineageId: OpaqueIdV1;
}

export interface CanonicalMemoryEntityTargetV1 {
  readonly kind: "canonical_memory_entity";
  readonly canonicalFactId: Sha256Hex;
}

export type SharingDecisionTargetV1 = SharedTaskProjectionTargetV1 | CanonicalMemoryEntityTargetV1;

export interface SharingDecisionV1 {
  readonly schemaVersion: 1;
  readonly decisionEventId: OpaqueIdV1;
  readonly authoritySourceEventId: OpaqueIdV1;
  readonly authorityKind: "user";
  readonly decision: "grant";
  readonly subjectScope: SubjectScopeV1;
  readonly sharingScope: SharingGrantScopeV1;
  readonly target: SharingDecisionTargetV1;
  readonly decidedAt: string;
}

export interface SharingDecisionPolicyV1 {
  readonly schemaVersion: 1;
  readonly authority: "explicit_user";
  readonly scopeMatch: "exact";
  readonly targetMatch: "exact";
  readonly invalidDisposition: "reject";
  readonly referenceOrder: "sorted_unique";
}

export interface TaskStateRevisionEnvelopeV1 {
  readonly stateRevision: Sha256Hex;
  readonly contentHash: Sha256Hex;
  readonly parentStateRevisions: readonly Sha256Hex[];
  readonly lineageRevisionOrdinal: string;
  readonly committedByDaemonId: OpaqueIdV1;
  readonly writerEpoch: string;
  readonly sourceSessionId: OpaqueIdV1;
  readonly committedAt: string;
}

export type WorkspaceCompatibilityV1 = "compatible" | "incompatible" | "unknown";
export const WORKSPACE_COMPATIBILITIES_V1 = [
  "compatible",
  "incompatible",
  "unknown",
] as const satisfies readonly WorkspaceCompatibilityV1[];

export type CheckpointResumeDispositionV1 = "open" | "accepted" | "superseded" | "retracted" | "unknown";
export const CHECKPOINT_RESUME_DISPOSITIONS_V1 = [
  "open",
  "accepted",
  "superseded",
  "retracted",
  "unknown",
] as const satisfies readonly CheckpointResumeDispositionV1[];

export type LineageHeadStateV1 = "single" | "forked" | "conflicted";
export const LINEAGE_HEAD_STATES_V1 = [
  "single",
  "forked",
  "conflicted",
] as const satisfies readonly LineageHeadStateV1[];

export type RevisionEligibilityReasonCodeV1 =
  | "workspace_incompatible"
  | "workspace_unknown"
  | "checkpoint_accepted"
  | "checkpoint_superseded"
  | "checkpoint_retracted"
  | "checkpoint_unknown"
  | "lineage_forked"
  | "lineage_conflicted"
  | "ordered_head_corrupt";
export const REVISION_ELIGIBILITY_REASON_CODES_V1 = [
  "workspace_incompatible",
  "workspace_unknown",
  "checkpoint_accepted",
  "checkpoint_superseded",
  "checkpoint_retracted",
  "checkpoint_unknown",
  "lineage_forked",
  "lineage_conflicted",
  "ordered_head_corrupt",
] as const satisfies readonly RevisionEligibilityReasonCodeV1[];

export interface RevisionCandidateEvaluationV1 {
  readonly stateRevision: Sha256Hex;
  readonly lineageRevisionOrdinal: string;
  readonly isOrderedHead: boolean;
  readonly workspaceCompatibility: WorkspaceCompatibilityV1;
  readonly checkpointDisposition: CheckpointResumeDispositionV1;
  readonly lineageState: LineageHeadStateV1;
  readonly resumeEligible: boolean;
  readonly reasonCodes: readonly RevisionEligibilityReasonCodeV1[];
}

export type RevisionSelectionCorruptionReasonV1 =
  | "duplicate_state_revision"
  | "duplicate_lineage_ordinal"
  | "ordered_head_cardinality"
  | "ordered_head_reference_mismatch"
  | "ordered_head_not_greatest";
export const REVISION_SELECTION_CORRUPTION_REASONS_V1 = [
  "duplicate_state_revision",
  "duplicate_lineage_ordinal",
  "ordered_head_cardinality",
  "ordered_head_reference_mismatch",
  "ordered_head_not_greatest",
] as const satisfies readonly RevisionSelectionCorruptionReasonV1[];

interface RevisionHeadSelectionBaseV1 {
  readonly orderingKey: "lineage_revision_ordinal";
  readonly orderedHeadStateRevision: Sha256Hex;
  readonly candidateEvaluations: readonly RevisionCandidateEvaluationV1[];
}

export type RevisionHeadSelectionContractV1 =
  | (RevisionHeadSelectionBaseV1 & {
      readonly automaticResumeHeadStateRevision: Sha256Hex;
      readonly fallbackDisposition: "none";
    })
  | (RevisionHeadSelectionBaseV1 & {
      readonly fallbackDisposition: "manual";
    })
  | (RevisionHeadSelectionBaseV1 & {
      readonly fallbackDisposition: "quarantine";
      readonly corruptionReasonCodes: readonly RevisionSelectionCorruptionReasonV1[];
    });

export interface ObservedV2<T extends JsonValue> {
  readonly value: T;
  readonly sourceEventIds: readonly OpaqueIdV1[];
  readonly observedAt: string;
  readonly evidenceKind: EvidenceKind;
  readonly confidence: number;
  readonly freshness: Freshness;
  readonly truncated: boolean;
  readonly sensitivity: Sensitivity;
}

export interface ObservedFileV2 {
  readonly path: string;
  readonly role: ObservedFile["role"];
  readonly contentHash?: Sha256Hex;
  readonly existsAtObservation: boolean;
  readonly sourceEventIds: readonly OpaqueIdV1[];
  readonly observedAt: string;
  readonly freshness: Freshness;
  readonly sensitivity: Sensitivity;
}

export interface ObservedCommandV2 {
  readonly operationId: OpaqueIdV1;
  readonly commandDisplay: string;
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly status: ObservedCommand["status"];
  readonly sourceEventIds: readonly OpaqueIdV1[];
  readonly observedAt: string;
  readonly evidenceKind: EvidenceKind;
  readonly sensitivity: Sensitivity;
}

export interface ObservedTestV2 {
  readonly operationId: OpaqueIdV1;
  readonly commandDisplay?: string;
  readonly target?: string;
  readonly status: ObservedTest["status"];
  readonly summary?: string;
  readonly sourceEventIds: readonly OpaqueIdV1[];
  readonly observedAt: string;
  readonly evidenceKind: EvidenceKind;
  readonly sensitivity: Sensitivity;
}

export interface OperationCorrelationV2 {
  readonly operationId: OpaqueIdV1;
  readonly startEventId: OpaqueIdV1;
  readonly nativeOperationId?: OpaqueIdV1;
  readonly operationMatchKey: OpaqueIdV1;
  readonly sessionId: OpaqueIdV1;
  readonly taskLineageId: OpaqueIdV1;
  readonly turnId?: OpaqueIdV1;
  readonly toolName?: string;
  readonly canonicalInputHash?: Sha256Hex;
}

export interface PendingOperationV2 {
  readonly operationId: OpaqueIdV1;
  readonly correlation: OperationCorrelationV2;
  readonly kind: PendingOperation["kind"];
  readonly description: string;
  readonly status: PendingOperation["status"];
  readonly replayPolicy: ReplayPolicy;
  readonly sourceEventIds: readonly OpaqueIdV1[];
  readonly startedAt: string;
  readonly terminalAt?: string;
  readonly idempotencyKey?: OpaqueIdV1;
  readonly verificationHint?: string;
  readonly sensitivity: Sensitivity;
  readonly startLineageRevisionOrdinal?: string;
  readonly startTurnIdSource?: TurnIdSource;
  readonly terminalFingerprint?: OpaqueIdV1;
}

export type DroppedEvidenceReasonV1 = "evicted" | "orphaned_terminal";
export const DROPPED_EVIDENCE_REASONS_V1 = [
  "evicted",
  "orphaned_terminal",
] as const satisfies readonly DroppedEvidenceReasonV1[];

export interface DroppedEvidenceEntryV2 {
  readonly reason: DroppedEvidenceReasonV1;
  readonly sourceEventIds: readonly OpaqueIdV1[];
  readonly recordedAtLineageRevisionOrdinal: string;
  readonly sensitivity: Sensitivity;
  readonly operationId?: OpaqueIdV1;
  readonly status?: PendingOperation["status"];
  readonly terminalFingerprint?: OpaqueIdV1;
  readonly adapterDeliveryId?: OpaqueIdV1;
}

export interface DroppedEvidenceReasonWindowV1 {
  readonly reason: DroppedEvidenceReasonV1;
  readonly totalRecorded: string;
  readonly totalOverflowed: string;
  readonly oldestRetainedLineageRevisionOrdinal?: string;
  readonly latestRecordedLineageRevisionOrdinal?: string;
  readonly entries: readonly DroppedEvidenceEntryV2[];
}

export interface DroppedEvidenceSummaryV1 {
  readonly totalRecorded: string;
  readonly totalOverflowed: string;
  readonly reasonWindows: readonly DroppedEvidenceReasonWindowV1[];
}

export interface RepositoryStateSnapshotV2 {
  readonly repositoryId: OpaqueIdV1;
  readonly workspaceId: OpaqueIdV1;
  readonly branchKey?: OpaqueIdV1;
  readonly worktreeId?: OpaqueIdV1;
  readonly headSha?: GitObjectIdV1;
  readonly upstreamSha?: GitObjectIdV1;
  readonly dirtyTreeFingerprint?: OpaqueIdV1;
  readonly gitStatusSummary?: string;
  readonly capturedAt: string;
}

export interface SemanticResumeNoteV2 {
  readonly schemaVersion: 2;
  readonly goal?: string;
  readonly completed: readonly string[];
  readonly currentState?: string;
  readonly nextActions: readonly string[];
  readonly blockers: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly providerId: string;
  readonly modelId: string;
  readonly promptHash: Sha256Hex;
  readonly confidence: number;
  readonly sourceEventIds: readonly OpaqueIdV1[];
  readonly sensitivity: Sensitivity;
}

export interface SourceIdentityV1 {
  readonly clientId: CanonicalClientIdV1;
  readonly clientVersion: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sessionId: OpaqueIdV1;
  readonly deviceId?: OpaqueIdV1;
  readonly capabilityHash?: Sha256Hex;
  readonly captureMethod: ContinuityCaptureMethod;
  readonly ingestAttestation: ContinuityIngestAttestationV1 & {
    readonly ingestReceiptId: OpaqueIdV1;
    readonly peerIdentityId: OpaqueIdV1;
  };
}

export interface LineageSourceSummaryV1 {
  readonly lineageOriginSourceEventId: OpaqueIdV1;
  readonly lastContributingSourceEventId: OpaqueIdV1;
  readonly participantSourceEventIds: readonly OpaqueIdV1[];
}

export interface SharedTaskStateV1 {
  readonly sharingScope: "task_shared";
  readonly sharingDecisionEventIds: readonly OpaqueIdV1[];
  readonly goal?: ObservedV2<string>;
  readonly constraints: readonly ObservedV2<string>[];
  readonly activeFiles: readonly ObservedFileV2[];
  readonly modifiedFiles: readonly ObservedFileV2[];
  readonly recentCommands: readonly ObservedCommandV2[];
  readonly recentTests: readonly ObservedTestV2[];
  readonly pendingOperations: readonly PendingOperationV2[];
  readonly droppedEvidence: DroppedEvidenceSummaryV1;
  readonly repositoryState: RepositoryStateSnapshotV2;
  readonly semanticResumeNote?: SemanticResumeNoteV2;
  readonly sensitivity: Sensitivity;
  readonly egressPolicy: EgressPolicyV1;
}

export interface AgentLocalStateV1 {
  readonly sharingScope: "agent_private";
  readonly sourceIdentityEventId: OpaqueIdV1;
  readonly clientId: CanonicalClientIdV1;
  readonly sessionId: OpaqueIdV1;
  readonly latestSubstantivePrompt?: ObservedV2<string>;
  readonly lastAssistantConclusion?: ObservedV2<string>;
  readonly nativeTodoState?: ObservedV2<JsonValue>;
  readonly nativePlanState?: ObservedV2<JsonValue>;
  readonly hostMetadata?: ObservedV2<JsonValue>;
  readonly sensitivity: Sensitivity;
  readonly egressPolicy: EgressPolicyV1;
}

export interface AgentLocalLanePolicyV1 {
  readonly schemaVersion: 1;
  readonly laneKeyFields: readonly ["clientId", "sessionId"];
  readonly canonicalStateCardinality: "at_most_one_per_key";
  readonly capsuleCardinality: "zero_or_one";
  readonly destinationBinding: "client_and_session";
  readonly sourceIdentityBinding: "client_and_session";
  readonly duplicateDisposition: "quarantine";
  readonly nonMatchingCapsuleDisposition: "reject";
}

export interface SensitivityAggregationPolicyV1 {
  readonly schemaVersion: 1;
  readonly order: readonly ["normal", "private", "secret"];
  readonly sharedTaskState: "max_of_contained_values";
  readonly agentLocalState: "max_of_contained_values";
  readonly canonicalWorkState: "max_of_shared_and_agent_local";
  readonly checkpoint: "match_embedded_canonical_state";
  readonly resumeCapsule: "max_of_included_projections";
  readonly mismatchDisposition: "quarantine_before_delivery";
}

export interface CanonicalWorkStateV2 {
  readonly schemaVersion: 2;
  readonly subjectScope: TaskLineageSubjectScopeV1;
  readonly opaqueIdProfile: OpaqueIdProfileV1;
  readonly revision: TaskStateRevisionEnvelopeV1;
  readonly lineageSourceSummary: LineageSourceSummaryV1;
  readonly sharedTaskState: SharedTaskStateV1;
  readonly agentLocalStates: readonly AgentLocalStateV1[];
  readonly sensitivity: Sensitivity;
}

export interface ContinuationCheckpointV3 {
  readonly id: OpaqueIdV1;
  readonly schemaVersion: 3;
  readonly checkpointRevision: Sha256Hex;
  readonly kind: ContinuationCheckpointV2["kind"];
  readonly parentCheckpointId?: OpaqueIdV1;
  readonly parentCheckpointRevision?: Sha256Hex;
  readonly sourceSessionId: OpaqueIdV1;
  readonly checkpointCreatedBySourceEventId: OpaqueIdV1;
  readonly canonicalState: CanonicalWorkStateV2;
  readonly memoryWatermark: string;
  readonly contentHash: Sha256Hex;
  readonly sensitivity: Sensitivity;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface ResumeDestinationV1 {
  readonly sourceIdentityEventId: OpaqueIdV1;
  readonly clientId: CanonicalClientIdV1;
  readonly clientVersion: string;
  readonly sessionId: OpaqueIdV1;
  readonly capabilityHash?: Sha256Hex;
  readonly privateEligible: boolean;
}

export interface ResumeCapsuleV2 {
  readonly schemaVersion: 2;
  readonly contentHash: Sha256Hex;
  readonly injectionId: OpaqueIdV1;
  readonly checkpointId: OpaqueIdV1;
  readonly checkpointRevision: Sha256Hex;
  readonly workStateRevision: Sha256Hex;
  readonly subjectScope: TaskLineageSubjectScopeV1;
  readonly lineageSourceSummary: LineageSourceSummaryV1;
  readonly checkpointCreatedBySourceEventId: OpaqueIdV1;
  readonly destination: ResumeDestinationV1;
  readonly resumeProfile: ResumeProfileV1;
  readonly ageSeconds: number;
  readonly reconciliation: ReconciliationStatus;
  readonly sharedTaskState: SharedTaskStateV1;
  readonly destinationAgentLocalState?: AgentLocalStateV1;
  readonly selectedMemoryIds: readonly OpaqueIdV1[];
  readonly warnings: readonly string[];
}

export type MemoryKindV1 =
  | "decision"
  | "bugfix"
  | "feature"
  | "discovery"
  | "security"
  | "constraint"
  | "procedure"
  | "preference"
  | "failed_approach"
  | "handoff"
  | "other";
export const MEMORY_KINDS_V1 = [
  "decision",
  "bugfix",
  "feature",
  "discovery",
  "security",
  "constraint",
  "procedure",
  "preference",
  "failed_approach",
  "handoff",
  "other",
] as const satisfies readonly MemoryKindV1[];

export type MemoryLifecycleV1 = "active" | "superseded" | "retracted" | "expired";
export const MEMORY_LIFECYCLES_V1 = [
  "active",
  "superseded",
  "retracted",
  "expired",
] as const satisfies readonly MemoryLifecycleV1[];

export type MemoryTruthStateV1 =
  | "unverified"
  | "user_confirmed"
  | "runtime_confirmed"
  | "contradicted"
  | "confirmed_wrong";
export const MEMORY_TRUTH_STATES_V1 = [
  "unverified",
  "user_confirmed",
  "runtime_confirmed",
  "contradicted",
  "confirmed_wrong",
] as const satisfies readonly MemoryTruthStateV1[];

export type MemoryDurabilityV1 = "transient" | "session" | "durable" | "pinned";
export const MEMORY_DURABILITIES_V1 = [
  "transient",
  "session",
  "durable",
  "pinned",
] as const satisfies readonly MemoryDurabilityV1[];

export interface CanonicalMemoryEntityV1 {
  readonly schemaVersion: 1;
  readonly memoryId: OpaqueIdV1;
  readonly memoryRevision: Sha256Hex;
  readonly parentMemoryRevision?: Sha256Hex;
  readonly subjectScope: SubjectScopeV1;
  readonly opaqueIdProfile: OpaqueIdProfileV1;
  readonly kind: MemoryKindV1;
  readonly normalizationProfileId: string;
  readonly canonicalContent: JsonValue;
  readonly canonicalFactId: Sha256Hex;
  readonly sharingScope: SharingScopeV1;
  readonly sharingDecisionEventIds: readonly OpaqueIdV1[];
  readonly sensitivity: Sensitivity;
  readonly egressPolicy: EgressPolicyV1;
  readonly lifecycle: MemoryLifecycleV1;
  readonly truthState: MemoryTruthStateV1;
  readonly durability: MemoryDurabilityV1;
  readonly sourceEventIds: readonly OpaqueIdV1[];
  readonly evidenceSnapshotIds: readonly OpaqueIdV1[];
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly expiresAt?: string;
  readonly contentHash: Sha256Hex;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RawIdentifierReaderV1 = "daemon_validator" | "daemon_migrator";
export const RAW_IDENTIFIER_READERS_V1 = [
  "daemon_validator",
  "daemon_migrator",
] as const satisfies readonly RawIdentifierReaderV1[];

export interface RawIdentifierEvidencePolicyV1 {
  readonly schemaVersion: 1;
  readonly newIntakePersistence: "none";
  readonly migrationScratch: "memory_only";
  readonly scratchRetention: "transaction";
  readonly quarantinedArtifactRetention: "until_user_repair_or_discard";
  readonly allowedRawReaders: readonly RawIdentifierReaderV1[];
  readonly rawDiagnostics: "never";
  readonly rawExport: "never";
  readonly externalEgress: "prohibited";
  readonly postTransaction: "zeroize";
}

export type ContinuityP0IssueNumberV1 = 46 | 49 | 53 | 61 | 62 | 56 | 57 | 32 | 58;
export const CONTINUITY_P0_ISSUE_NUMBERS_V1 = [
  46,
  49,
  53,
  61,
  62,
  56,
  57,
  32,
  58,
] as const satisfies readonly ContinuityP0IssueNumberV1[];

export type ContinuityP0DeltaKindV1 =
  | "no_op_state_stable"
  | "published_bytes_immutable"
  | "daemon_ordered_head"
  | "overflow_summary_visible"
  | "raw_identifier_absent"
  | "invalid_scope_quarantined"
  | "invalid_timestamp_quarantined"
  | "limit_policy_enforced"
  | "terminal_sibling_diagnostic";
export const CONTINUITY_P0_DELTA_KINDS_V1 = [
  "no_op_state_stable",
  "published_bytes_immutable",
  "daemon_ordered_head",
  "overflow_summary_visible",
  "raw_identifier_absent",
  "invalid_scope_quarantined",
  "invalid_timestamp_quarantined",
  "limit_policy_enforced",
  "terminal_sibling_diagnostic",
] as const satisfies readonly ContinuityP0DeltaKindV1[];

export type ContinuityP0ObservationKindV1 =
  | "state_transition"
  | "canonical_bytes"
  | "head_selection"
  | "overflow_summary"
  | "identifier_privacy"
  | "restore_validation"
  | "limit_policy"
  | "diagnostic";
export const CONTINUITY_P0_OBSERVATION_KINDS_V1 = [
  "state_transition",
  "canonical_bytes",
  "head_selection",
  "overflow_summary",
  "identifier_privacy",
  "restore_validation",
  "limit_policy",
  "diagnostic",
] as const satisfies readonly ContinuityP0ObservationKindV1[];

export type SourceAwareDownstreamStageV1 = "S1" | "S2" | "S3";
export const SOURCE_AWARE_DOWNSTREAM_STAGES_V1 = [
  "S1",
  "S2",
  "S3",
] as const satisfies readonly SourceAwareDownstreamStageV1[];

export interface BehaviorDeltaEntryV1 {
  readonly jsonPathOrField: string;
  readonly currentV1: JsonValue;
  readonly successor: JsonValue;
  readonly deltaKind: ContinuityP0DeltaKindV1;
}

export interface ContinuityP0ObservationEntryV1 {
  readonly caseId: string;
  readonly issueNumber: ContinuityP0IssueNumberV1;
  readonly input: JsonValue;
  readonly observationKind: ContinuityP0ObservationKindV1;
  readonly downstreamStage: SourceAwareDownstreamStageV1;
  readonly behaviorDeltas: readonly BehaviorDeltaEntryV1[];
}

export interface ContinuityP0ObservationContractV1 {
  readonly schemaVersion: 1;
  readonly entries: readonly ContinuityP0ObservationEntryV1[];
}

export type StateTransitionClassificationV1 =
  | "state_changed"
  | "ledger_only"
  | "duplicate_noop"
  | "rejected_or_quarantined";
export const STATE_TRANSITION_CLASSIFICATIONS_V1 = [
  "state_changed",
  "ledger_only",
  "duplicate_noop",
  "rejected_or_quarantined",
] as const satisfies readonly StateTransitionClassificationV1[];

export interface StateNeutralTransitionPolicyV1 {
  readonly schemaVersion: 1;
  readonly classifications: readonly StateTransitionClassificationV1[];
  readonly stateNeutralClassification: "ledger_only";
  readonly canonicalStateEffect: "reuse_revision";
  readonly receiptLedgerEffect: "insert_once";
  readonly receiptKeyProfile: "adapter_delivery_id_else_canonical_fingerprint_v1";
  readonly deliveryKeyPrefix: "d:";
  readonly fingerprintKeyPrefix: "f:";
  readonly receiptUniquenessScope: "task_lineage_event_store";
  readonly receiptEvidenceComparison: "canonical_fingerprint";
  readonly receiptCollisionDisposition: "quarantine";
  readonly duplicateReceiptDisposition: "return_existing";
  readonly diagnosticAuditEffect: "record_bounded";
  readonly coverageWatermarkEffect: "advance";
  readonly transactionBoundary: "same_daemon_transaction";
}

export type SourceInventorySurfaceClassV1 = "persisted" | "wire" | "user-facing" | "derived" | "diagnostic";
export const SOURCE_INVENTORY_SURFACE_CLASSES_V1 = [
  "persisted",
  "wire",
  "user-facing",
  "derived",
  "diagnostic",
] as const satisfies readonly SourceInventorySurfaceClassV1[];

export type SourceInventoryDispositionV1 =
  | "retain"
  | "rename"
  | "split"
  | "migrate"
  | "legacy_read_only"
  | "quarantine";
export const SOURCE_INVENTORY_DISPOSITIONS_V1 = [
  "retain",
  "rename",
  "split",
  "migrate",
  "legacy_read_only",
  "quarantine",
] as const satisfies readonly SourceInventoryDispositionV1[];

export type SourceInventoryAuthorityV1 = "authenticated" | "caller_claimed" | "derived" | "none";
export const SOURCE_INVENTORY_AUTHORITIES_V1 = [
  "authenticated",
  "caller_claimed",
  "derived",
  "none",
] as const satisfies readonly SourceInventoryAuthorityV1[];

export type SourceInventoryCoverageModeV1 = "partition" | "snapshot";
export const SOURCE_INVENTORY_COVERAGE_MODES_V1 = [
  "partition",
  "snapshot",
] as const satisfies readonly SourceInventoryCoverageModeV1[];

export interface SourceInventorySearchV1 {
  readonly id: string;
  readonly coverageMode: SourceInventoryCoverageModeV1;
  readonly pattern: string;
  readonly includePaths: readonly string[];
  readonly excludePaths: readonly string[];
  readonly lineCount: number;
  readonly sha256: Sha256Hex;
}

export type SourceInventorySupportingReasonV1 = "documentation" | "test" | "fixture" | "tooling";
export const SOURCE_INVENTORY_SUPPORTING_REASONS_V1 = [
  "documentation",
  "test",
  "fixture",
  "tooling",
] as const satisfies readonly SourceInventorySupportingReasonV1[];

export type SourceInventoryCandidateRuleV1 =
  | {
      readonly id: string;
      readonly searchIds: readonly string[];
      readonly recordPattern: string;
      readonly inventoryEntryId: string;
    }
  | {
      readonly id: string;
      readonly searchIds: readonly string[];
      readonly recordPattern: string;
      readonly supportingReason: SourceInventorySupportingReasonV1;
    };

export interface SourceInventoryEntryV1 {
  readonly id: string;
  readonly locus: string;
  readonly semanticTerm: string;
  readonly currentMeaning: string;
  readonly authority: SourceInventoryAuthorityV1;
  readonly surfaceClass: SourceInventorySurfaceClassV1;
  readonly disposition: SourceInventoryDispositionV1;
  readonly successorTarget: string;
  readonly migrationCondition: string;
  readonly restoreValidationRequired: boolean;
  readonly schemaDefinition?: string;
  readonly sqlTable?: string;
  readonly notes: string;
}

export interface SourceIdentityInventoryV1 {
  readonly inventoryVersion: 1;
  readonly baselineCommit: GitObjectIdV1;
  readonly searches: readonly SourceInventorySearchV1[];
  readonly candidateRules: readonly SourceInventoryCandidateRuleV1[];
  readonly entries: readonly SourceInventoryEntryV1[];
}

export type SourceAwareFixtureCaseIdV1 = "F0" | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7";
export const SOURCE_AWARE_FIXTURE_CASE_IDS_V1 = [
  "F0",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
] as const satisfies readonly SourceAwareFixtureCaseIdV1[];

export type SourceAwareCurrentDispositionV1 = "unsupported" | "unsafe";
export const SOURCE_AWARE_CURRENT_DISPOSITIONS_V1 = [
  "unsupported",
  "unsafe",
] as const satisfies readonly SourceAwareCurrentDispositionV1[];

export type SourceAwareCurrentReasonCodeV1 =
  | "agent_local_not_isolated"
  | "shared_projection_not_expressible"
  | "field_provenance_not_immutable"
  | "multi_agent_lineage_not_expressible"
  | "canonical_memory_evidence_union_not_expressible"
  | "source_retrieval_profile_not_expressible"
  | "caller_claimed_source_not_authority_bound"
  | "destination_policy_and_capability_not_expressible";
export const SOURCE_AWARE_CURRENT_REASON_CODES_V1 = [
  "agent_local_not_isolated",
  "shared_projection_not_expressible",
  "field_provenance_not_immutable",
  "multi_agent_lineage_not_expressible",
  "canonical_memory_evidence_union_not_expressible",
  "source_retrieval_profile_not_expressible",
  "caller_claimed_source_not_authority_bound",
  "destination_policy_and_capability_not_expressible",
] as const satisfies readonly SourceAwareCurrentReasonCodeV1[];

export type SourceSharingDispositionCodeV1 =
  | "agent_private"
  | "private_not_eligible"
  | "secret"
  | "local_only"
  | "prohibited_egress"
  | "scope_mismatch"
  | "destination_capability_unsupported"
  | "source_unverified"
  | "legacy_read_only";
export const SOURCE_SHARING_DISPOSITION_CODES_V1 = [
  "agent_private",
  "private_not_eligible",
  "secret",
  "local_only",
  "prohibited_egress",
  "scope_mismatch",
  "destination_capability_unsupported",
  "source_unverified",
  "legacy_read_only",
] as const satisfies readonly SourceSharingDispositionCodeV1[];

export type SourceAwareRetrievalProfileV1 =
  | "all_source_project"
  | "current_source"
  | "named_source"
  | "active_task_shared";
export const SOURCE_AWARE_RETRIEVAL_PROFILES_V1 = [
  "all_source_project",
  "current_source",
  "named_source",
  "active_task_shared",
] as const satisfies readonly SourceAwareRetrievalProfileV1[];

export interface SourceAwareFixtureSourceV1 {
  readonly id: string;
  readonly canonicalClientId: CanonicalClientIdV1;
  readonly claimedClientId: string;
  readonly authenticated: boolean;
}

export interface SourceAwareFixtureDestinationV1 {
  readonly sourceId: string;
  readonly privateEligible: boolean;
  readonly capabilityIds: readonly string[];
}

export interface SourceAwareFixtureScopeV1 {
  readonly personalVaultId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly taskLineageId: string;
}

export interface SourceAwareFixtureRecordV1 {
  readonly id: string;
  readonly kind: string;
  readonly sourceId: string;
  readonly sharingScope: SharingScopeV1;
  readonly sensitivity: Sensitivity;
  readonly egressPolicy: EgressPolicyV1;
  readonly sourceEvidenceIds: readonly string[];
  readonly sharingDecisionEventIds?: readonly string[];
  readonly subjectScope?: SourceAwareFixtureScopeV1;
  readonly canonicalFactId?: string;
}

export interface SourceAwareFixtureSharedTaskTargetV1 {
  readonly kind: "shared_task_projection";
  readonly taskLineageId: string;
}

export interface SourceAwareFixtureMemoryTargetV1 {
  readonly kind: "canonical_memory_entity";
  readonly canonicalFactId: string;
}

export type SourceAwareFixtureSharingTargetV1 =
  | SourceAwareFixtureSharedTaskTargetV1
  | SourceAwareFixtureMemoryTargetV1;

export interface SourceAwareFixtureSharingDecisionV1 {
  readonly id: string;
  readonly authorityEventId: string;
  readonly authorityKind: "user";
  readonly decision: "grant";
  readonly authenticated: boolean;
  readonly subjectScope: SourceAwareFixtureScopeV1;
  readonly sharingScope: SharingGrantScopeV1;
  readonly target: SourceAwareFixtureSharingTargetV1;
}

export interface SourceAwareFixtureTransitionV1 {
  readonly id: string;
  readonly actorSourceId: string;
  readonly kind: "create" | "update" | "checkpoint";
}

export interface SourceAwareFixtureInputV1 {
  readonly sources: readonly SourceAwareFixtureSourceV1[];
  readonly destination: SourceAwareFixtureDestinationV1;
  readonly scope: SourceAwareFixtureScopeV1;
  readonly records: readonly SourceAwareFixtureRecordV1[];
  readonly sharingDecisions: readonly SourceAwareFixtureSharingDecisionV1[];
  readonly transitions: readonly SourceAwareFixtureTransitionV1[];
}

export interface SourceAwareCurrentExpectationV1 {
  readonly disposition: SourceAwareCurrentDispositionV1;
  readonly reasonCode: SourceAwareCurrentReasonCodeV1;
}

export interface SourceAwareRecordEvidenceExpectationV1 {
  readonly recordId: string;
  readonly sourceIds: readonly string[];
}

export interface SourceAwareLineageExpectationV1 {
  readonly originSourceId: string;
  readonly lastContributorSourceId: string;
  readonly participantSourceIds: readonly string[];
  readonly checkpointCreatorSourceId: string;
}

export interface SourceAwareMemoryExpectationV1 {
  readonly memoryId: string;
  readonly canonicalFactId: string;
  readonly sourceIds: readonly string[];
  readonly sharingScope: SharingScopeV1;
  readonly sensitivity: Sensitivity;
  readonly egressPolicy: EgressPolicyV1;
}

export interface SourceAwareMemoryReviewCandidateV1 {
  readonly recordId: string;
  readonly canonicalFactId: string;
  readonly sharingScope: SharingScopeV1;
  readonly sensitivity: Sensitivity;
  readonly egressPolicy: EgressPolicyV1;
  readonly disposition: "policy_review_required";
  readonly reasonCode: "policy_tuple_mismatch";
}

export interface SourceAwareRetrievalExpectationV1 {
  readonly profile: SourceAwareRetrievalProfileV1;
  readonly recordIds: readonly string[];
}

export interface SourceAwareAuthorityExpectationV1 {
  readonly authenticatedSourceId: string;
  readonly automaticResumeAuthorized: boolean;
}

export interface SourceAwareSuccessorExpectationV1 {
  readonly automaticFullRecordIds: readonly string[];
  readonly hintOrManualRecordIds: readonly string[];
  readonly agentLocalRecordIds: readonly string[];
  readonly sourceEvidence: readonly SourceAwareRecordEvidenceExpectationV1[];
  readonly lineage: SourceAwareLineageExpectationV1;
  readonly memoryEntities: readonly SourceAwareMemoryExpectationV1[];
  readonly memoryReviewCandidates: readonly SourceAwareMemoryReviewCandidateV1[];
  readonly retrievalProfiles: readonly SourceAwareRetrievalExpectationV1[];
  readonly authority: SourceAwareAuthorityExpectationV1;
  readonly downgradeReasonCodes: readonly SourceSharingDispositionCodeV1[];
}

export interface SourceAwareContractCaseV1 {
  readonly id: SourceAwareFixtureCaseIdV1;
  readonly title: string;
  readonly input: SourceAwareFixtureInputV1;
  readonly currentV1: SourceAwareCurrentExpectationV1;
  readonly successor: SourceAwareSuccessorExpectationV1;
}

export interface SourceAwareContractCorpusV1 {
  readonly corpusVersion: 1;
  readonly contractBundle: "SourceAwareContinuityContractV1";
  readonly cases: readonly SourceAwareContractCaseV1[];
}

export type LegacyArtifactV1 =
  | "CanonicalWorkStateV1"
  | "ContinuationCheckpointV2"
  | "ResumeCapsuleV1"
  | "DurableMemory";
export const LEGACY_ARTIFACTS_V1 = [
  "CanonicalWorkStateV1",
  "ContinuationCheckpointV2",
  "ResumeCapsuleV1",
  "DurableMemory",
] as const satisfies readonly LegacyArtifactV1[];

export interface LegacyMigrationRuleV1 {
  readonly artifact: LegacyArtifactV1;
  readonly verifiedDisposition: LegacyMigrationDispositionV1;
  readonly unresolvedDisposition: LegacyMigrationDispositionV1;
  readonly evidencePreconditions: readonly string[];
}

export interface RestoreArtifactValidationRuleV1 {
  readonly inventoryEntryId: string;
  readonly scopeIdentityPaths: readonly string[];
  readonly isoTimestampPaths: readonly string[];
  readonly crossFieldRules: readonly string[];
  readonly invalidDisposition: "quarantine";
  readonly repairAuthorities: readonly ["user"];
  readonly auditRequired: true;
}

export interface RestoreSemanticValidationContractV1 {
  readonly schemaVersion: 1;
  readonly scopeIdentityPolicy: "non_blank_and_parent_consistent";
  readonly timestampProfile: "iso-z-nanos-v1-calendar-valid";
  readonly rules: readonly RestoreArtifactValidationRuleV1[];
}

export type ContinuityLimitNameV1 = keyof typeof CONTINUITY_LIMITS;
export const CONTINUITY_LIMIT_NAMES_V1 = [
  "hintTokens",
  "fullCapsuleTokens",
  "promptMemoryTokens",
  "combinedTokens",
  "absoluteTokens",
  "capsulePayloadBytes",
  "wrapperBytes",
  "jsonDepth",
  "stringUtf8Bytes",
  "arrayItems",
  "objectKeys",
  "rankedCandidates",
] as const satisfies readonly ContinuityLimitNameV1[];
export type ContinuityLimitDispositionV1 = "reject" | "select_with_diagnostic";
export const CONTINUITY_LIMIT_DISPOSITIONS_V1 = [
  "reject",
  "select_with_diagnostic",
] as const satisfies readonly ContinuityLimitDispositionV1[];

export interface ContinuityLimitPolicyV1 {
  readonly name: ContinuityLimitNameV1;
  readonly limit: number;
  readonly disposition: ContinuityLimitDispositionV1;
}

export type ContinuityDiagnosticCodeV2 =
  | "terminal_unmatched"
  | "terminal_orphaned"
  | "terminal_ambiguous"
  | "terminal_conflict"
  | "terminal_out_of_order"
  | "terminal_order_unverifiable"
  | "terminal_turn_unverifiable"
  | "terminal_identity_unverifiable"
  | "terminal_already_applied"
  | "terminal_evidence_contradicts"
  | "duplicate_operation_start"
  | "start_sibling_conflict"
  | "start_conflict"
  | "delivery_conflict"
  | "pending_operations_evicted"
  | "dropped_evidence_recorded"
  | "dropped_evidence_overflowed"
  | "source_events_truncated"
  | "turn_identity_downgraded"
  | "turn_identity_unauthenticated"
  | "terminal_sibling_conflict";
export const CONTINUITY_DIAGNOSTIC_CODES_V2 = [
  "terminal_unmatched",
  "terminal_orphaned",
  "terminal_ambiguous",
  "terminal_conflict",
  "terminal_out_of_order",
  "terminal_order_unverifiable",
  "terminal_turn_unverifiable",
  "terminal_identity_unverifiable",
  "terminal_already_applied",
  "terminal_evidence_contradicts",
  "duplicate_operation_start",
  "start_sibling_conflict",
  "start_conflict",
  "delivery_conflict",
  "pending_operations_evicted",
  "dropped_evidence_recorded",
  "dropped_evidence_overflowed",
  "source_events_truncated",
  "turn_identity_downgraded",
  "turn_identity_unauthenticated",
  "terminal_sibling_conflict",
] as const satisfies readonly ContinuityDiagnosticCodeV2[];

export interface SourceAwareArtifactSchemaRefV1 {
  readonly name: "CanonicalWorkStateV2" | "ContinuationCheckpointV3" | "ResumeCapsuleV2" | "CanonicalMemoryEntityV1";
  readonly schemaVersion: 1 | 2 | 3;
}

export interface RevisionHeadSelectionPolicyV1 {
  readonly orderingKey: "lineage_revision_ordinal";
  readonly headCardinality: "exactly_one";
  readonly ordinalUniqueness: "required";
  readonly automaticTarget: "ordered_head_only";
  readonly eligibilityDerivation: "workspace_checkpoint_lineage";
  readonly automaticFallback: "never";
  readonly ineligibleDisposition: "manual";
  readonly corruptDisposition: "quarantine";
}

export interface CanonicalStateHashTestVectorV1 {
  readonly contentProjection: JsonValue;
  readonly contentHash: Sha256Hex;
  readonly revisionMetadata: JsonValue;
  readonly stateRevision: Sha256Hex;
}

export interface CanonicalStateHashProfileV1 {
  readonly schemaVersion: 1;
  readonly canonicalization: "rfc8785-jcs";
  readonly digest: "sha-256";
  readonly contentProjectionFields: readonly [
    "schemaVersion",
    "subjectScope",
    "opaqueIdProfile",
    "lineageSourceSummary",
    "sharedTaskState",
    "agentLocalStates",
    "sensitivity",
  ];
  readonly stateRevisionDomain: "free-mem/CanonicalWorkStateV2/state-revision/v1";
  readonly revisionMetadataFields: readonly [
    "parentStateRevisions",
    "lineageRevisionOrdinal",
    "committedByDaemonId",
    "writerEpoch",
    "sourceSessionId",
    "committedAt",
  ];
  readonly testVector: CanonicalStateHashTestVectorV1;
}

export interface CheckpointHashTestVectorV1 {
  readonly canonicalStateVectorRef: "canonicalStateHashProfile.testVector";
  readonly envelope: JsonValue;
  readonly contentHash: Sha256Hex;
  readonly checkpointId: OpaqueIdV1;
  readonly initialCheckpointRevision: Sha256Hex;
  readonly parentCheckpointId: OpaqueIdV1;
  readonly parentCheckpointRevision: Sha256Hex;
  readonly childCheckpointRevision: Sha256Hex;
}

export interface CheckpointHashProfileV1 {
  readonly schemaVersion: 1;
  readonly canonicalization: "rfc8785-jcs";
  readonly digest: "sha-256";
  readonly contentProjectionFields: readonly [
    "schemaVersion",
    "kind",
    "sourceSessionId",
    "checkpointCreatedBySourceEventId",
    "canonicalState",
    "memoryWatermark",
    "sensitivity",
    "createdAt",
    "expiresAt",
  ];
  readonly checkpointRevisionDomain: "free-mem/ContinuationCheckpointV3/checkpoint-revision/v1";
  readonly transitionKinds: readonly ["initial", "parent"];
  readonly testVector: CheckpointHashTestVectorV1;
}

export interface CanonicalMemoryHashTestVectorV1 {
  readonly contentProjection: JsonValue;
  readonly contentHash: Sha256Hex;
  readonly revisionMetadata: JsonValue;
  readonly memoryId: OpaqueIdV1;
  readonly initialMemoryRevision: Sha256Hex;
  readonly parentMemoryRevision: Sha256Hex;
  readonly childMemoryRevision: Sha256Hex;
}

export interface CanonicalMemoryHashProfileV1 {
  readonly schemaVersion: 1;
  readonly canonicalization: "rfc8785-jcs";
  readonly digest: "sha-256";
  readonly contentProjectionFields: readonly [
    "schemaVersion",
    "subjectScope",
    "opaqueIdProfile",
    "kind",
    "normalizationProfileId",
    "canonicalContent",
    "canonicalFactId",
    "sharingScope",
    "sensitivity",
    "egressPolicy",
    "lifecycle",
    "truthState",
    "durability",
    "validFrom",
    "validTo",
    "expiresAt",
  ];
  readonly revisionMetadataFields: readonly [
    "sharingDecisionEventIds",
    "sourceEventIds",
    "evidenceSnapshotIds",
    "createdAt",
    "updatedAt",
  ];
  readonly memoryRevisionDomain: "free-mem/CanonicalMemoryEntityV1/memory-revision/v1";
  readonly transitionKinds: readonly ["initial", "parent"];
  readonly testVector: CanonicalMemoryHashTestVectorV1;
}

export interface ResumeCapsuleHashTestVectorV1 {
  readonly sharedTaskStateVectorRef: "canonicalStateHashProfile.testVector.contentProjection.sharedTaskState";
  readonly envelope: JsonValue;
  readonly contentHash: Sha256Hex;
}

export interface ResumeCapsuleHashProfileV1 {
  readonly schemaVersion: 1;
  readonly canonicalization: "rfc8785-jcs";
  readonly digest: "sha-256";
  readonly contentDomain: "free-mem/ResumeCapsuleV2/content/v1";
  readonly contentProjectionFields: readonly [
    "schemaVersion",
    "injectionId",
    "checkpointId",
    "checkpointRevision",
    "workStateRevision",
    "subjectScope",
    "lineageSourceSummary",
    "checkpointCreatedBySourceEventId",
    "destination",
    "resumeProfile",
    "ageSeconds",
    "reconciliation",
    "sharedTaskState",
    "destinationAgentLocalState",
    "selectedMemoryIds",
    "warnings",
  ];
  readonly testVector: ResumeCapsuleHashTestVectorV1;
}

export interface SourceAwareContinuityContractV1 {
  readonly contractVersion: 1;
  readonly contractHash: Sha256Hex;
  readonly schemaFile: "schema/continuity.schema.json";
  readonly schemaHash: Sha256Hex;
  readonly artifactSchemas: readonly SourceAwareArtifactSchemaRefV1[];
  readonly sourceVocabularyVersion: "1";
  readonly inventoryFile: "schema/source-aware-source-inventory.v1.json";
  readonly inventoryHash: Sha256Hex;
  readonly fixtureCorpusFile: "fixtures/continuity/source-aware-f0-f7.v1.json";
  readonly fixtureCorpusVersion: 1;
  readonly fixtureCorpusHash: Sha256Hex;
  readonly fixtureCaseIds: readonly SourceAwareFixtureCaseIdV1[];
  readonly opaqueIdProfile: OpaqueIdProfileV1;
  readonly opaqueIdConformanceProfile: OpaqueIdConformanceProfileV1;
  readonly canonicalStateHashProfile: CanonicalStateHashProfileV1;
  readonly checkpointHashProfile: CheckpointHashProfileV1;
  readonly canonicalMemoryHashProfile: CanonicalMemoryHashProfileV1;
  readonly resumeCapsuleHashProfile: ResumeCapsuleHashProfileV1;
  readonly revisionHeadSelectionPolicy: RevisionHeadSelectionPolicyV1;
  readonly rawIdentifierEvidencePolicy: RawIdentifierEvidencePolicyV1;
  readonly stateNeutralTransitionPolicy: StateNeutralTransitionPolicyV1;
  readonly sharingDecisionPolicy: SharingDecisionPolicyV1;
  readonly agentLocalLanePolicy: AgentLocalLanePolicyV1;
  readonly sensitivityAggregationPolicy: SensitivityAggregationPolicyV1;
  readonly continuityP0Observations: ContinuityP0ObservationContractV1;
  readonly legacyMigrationRules: readonly LegacyMigrationRuleV1[];
  readonly restoreSemanticValidation: RestoreSemanticValidationContractV1;
  readonly limitPolicies: readonly ContinuityLimitPolicyV1[];
  readonly continuityDiagnosticCodes: readonly ContinuityDiagnosticCodeV2[];
  readonly sourceSharingDispositionCodes: readonly SourceSharingDispositionCodeV1[];
}

export interface CanonicalWorkStateV1 {
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
  // 退避した operation と相手の見つからなかった terminal の記録（#43 / #39）
  droppedEvidence?: DroppedEvidenceEntryV1[];
  repositoryState: RepositoryStateSnapshot;
  semanticResumeNote?: SemanticResumeNoteV1;
  sensitivity: Sensitivity;
  lastIngestSeq: string;
  stateRevision: string;
  updatedAt: string;
}

export interface ContinuationCheckpointV2 {
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

export type CheckpointDispositionKind =
  | "created"
  | "accepted"
  | "superseded"
  | "expired"
  | "reopened"
  | "retracted";

export const CHECKPOINT_DISPOSITION_KINDS = [
  "created",
  "accepted",
  "superseded",
  "expired",
  "reopened",
  "retracted",
] as const satisfies readonly CheckpointDispositionKind[];

export interface CheckpointDispositionEvent {
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

export interface CheckpointDispositionProjection {
  checkpointId: string;
  state: "open" | "accepted" | "superseded" | "expired" | "retracted";
  projectionRevision: string;
  latestEventId: string;
  // §6.1 post-claim command が projection CAS で比較する attempt
  activeDeliveryAttemptId?: string;
  // §6.1 post-claim command が projection CAS で比較する fence
  activeClaimFence?: string;
  // §6.1 attempt と同一 transaction で更新する lease
  activeLeaseUntil?: string;
}

export interface CheckpointMetadataV1 {
  checkpointId: string;
  checkpointRevision: string;
  taskLineageId: string;
  kind: ContinuationCheckpointV2["kind"];
  sourceSessionId: string;
}

export interface DispositionAuthorityContextV1 {
  source: "daemon" | "runtime" | "user";
  userAuthorizedCrossLineage: boolean;
  sourceEventIds: string[];
}

export type DeliveryAttemptState =
  | "claimed"
  | "delivered"
  | "engaged"
  | "accepted"
  | "dismissed"
  | "abandoned";

export const DELIVERY_ATTEMPT_STATES = [
  "claimed",
  "delivered",
  "engaged",
  "accepted",
  "dismissed",
  "abandoned",
] as const satisfies readonly DeliveryAttemptState[];

export type EngagementEvidenceKind =
  | "explicit_accept"
  | "explicit_continue_prompt"
  | "related_file_action"
  | "related_command"
  | "related_test"
  | "related_todo_progress"
  | "manual_resume_tool";

export const ENGAGEMENT_EVIDENCE_KINDS = [
  "explicit_accept",
  "explicit_continue_prompt",
  "related_file_action",
  "related_command",
  "related_test",
  "related_todo_progress",
  "manual_resume_tool",
] as const satisfies readonly EngagementEvidenceKind[];

export interface CheckpointAnchorV1 {
  anchorId: string;
  checkpointId: string;
  checkpointRevision: string;
  taskLineageId: string;
  kind: "file" | "symbol" | "command" | "test" | "todo" | "task_lineage";
  valueHash: string;
  sourceEventIds: string[];
}

export interface EngagementEvidence {
  kind: EngagementEvidenceKind;
  sourceEventIds: string[];
  score: number;
  checkpointAnchorIds: string[];
  successful: boolean;
  observedAt: string;
}

export interface ContradictionEvidenceV1 {
  contradictionId: string;
  kind: "explicit_rejection" | "new_task_confirmed" | "workspace_incompatible" | "runtime_invalidated";
  sourceEventIds: string[];
  observedAt: string;
}

export interface ContradictionScanRangeV1 {
  fromIngestSeq: string;
  toIngestSeq: string;
  scannedAt: string;
}

export interface EngagementEvaluationContextV1 {
  sourceEvents: NormalizedContinuityEvent[];
  checkpointAnchors: CheckpointAnchorV1[];
  // §6.4 caller 値は診断用で、acceptance は daemon event store を再検索する
  contradictions: ContradictionEvidenceV1[];
  // §6.4 caller の範囲は authoritative scan を制限しない
  contradictionScan: ContradictionScanRangeV1;
  destinationTurnId: string;
  destinationTurnIdSource: TurnIdSource;
  destinationAgentVersion: string;
  destinationCapabilityHash: string;
  turnIdentityDisposition: CapabilityTestDisposition;
  evaluationStartedAt: string;
  evaluationEndedAt: string;
}

export interface CheckpointDeliveryAttempt {
  attemptId: string;
  checkpointId: string;
  checkpointRevision: string;
  destinationSessionId: string;
  destinationAgent: string;
  state: DeliveryAttemptState;
  // §6.1 claim CAS で比較する fence
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

export type DeliveryCommandV1 =
  | { kind: "mark_delivered"; attemptId: string; revision: string; fence: string; sessionId: string; contentHash: string }
  | { kind: "record_engagement"; attemptId: string; revision: string; fence: string; sessionId: string; evidence: EngagementEvidence }
  | { kind: "accept"; attemptId: string; revision: string; fence: string; sessionId: string; projectionRevision: string }
  | { kind: "dismiss"; attemptId: string; revision: string; fence: string; sessionId: string }
  | { kind: "abandon"; attemptId: string; revision: string; fence: string; sessionId: string; reason: string }
  | { kind: "renew_lease"; attemptId: string; revision: string; fence: string; sessionId: string; requestedLeaseUntil: string };

export interface ResumeSuppressionEntryV1 {
  checkpointId: string;
  sessionId: string;
  reason: "dismissed";
  attemptId: string;
  createdAt: string;
}

export type ReconciliationStatus =
  | "exact"
  | "fast_forward_compatible"
  | "stale_but_usable"
  | "requires_verification"
  | "incompatible";

export const RECONCILIATION_STATUSES = [
  "exact",
  "fast_forward_compatible",
  "stale_but_usable",
  "requires_verification",
  "incompatible",
] as const satisfies readonly ReconciliationStatus[];

export type ResumeDeliveryStrategy =
  | "native_prompt_gate"
  | "session_start_full"
  | "next_prompt_synthesized"
  | "manual_only";

export const RESUME_DELIVERY_STRATEGIES = [
  "native_prompt_gate",
  "session_start_full",
  "next_prompt_synthesized",
  "manual_only",
] as const satisfies readonly ResumeDeliveryStrategy[];

export type ResumeMode = "smart" | "always" | "hint_only" | "compact_only" | "off";

export const RESUME_MODES = ["smart", "always", "hint_only", "compact_only", "off"] as const satisfies readonly ResumeMode[];

export type ResumeDeliveryBoundary = "session_start" | "first_user_prompt" | "post_compact" | "manual";

export const RESUME_DELIVERY_BOUNDARIES = [
  "session_start",
  "first_user_prompt",
  "post_compact",
  "manual",
] as const satisfies readonly ResumeDeliveryBoundary[];

export interface ResumeCapsuleV1 {
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

export interface ResumeThresholdProfileV1 {
  profileId: string;
  datasetVersion: string;
  fullResumeMinScore: number;
  hintMinScore: number;
  ambiguityMargin: number;
  maxCandidates: number;
}

export type ResumeDecisionAction =
  | "none"
  | "hint"
  | "candidate_list"
  | "verification_capsule"
  | "full_capsule"
  | "manual_only";

export const RESUME_DECISION_ACTIONS = [
  "none",
  "hint",
  "candidate_list",
  "verification_capsule",
  "full_capsule",
  "manual_only",
] as const satisfies readonly ResumeDecisionAction[];

export interface RankedResumeCandidateV1 {
  rank: number;
  checkpointId: string;
  checkpointRevision: string;
  taskLineageId: string;
  score: number;
  reconciliationStatus: ReconciliationStatus;
  reasonCodes: string[];
  ageSeconds: number;
}

export interface ResumeSelectionDecisionV1 {
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

export type DerivedArtifactKind =
  | "summary"
  | "semantic_resume_note"
  | "checkpoint_semantic_note"
  | "consolidated_memory"
  | "embedding_item"
  | "context_pack_cache"
  | "cloud_projection";

export const DERIVED_ARTIFACT_KINDS = [
  "summary",
  "semantic_resume_note",
  "checkpoint_semantic_note",
  "consolidated_memory",
  "embedding_item",
  "context_pack_cache",
  "cloud_projection",
] as const satisfies readonly DerivedArtifactKind[];

export type DerivedArtifactStatus = "active" | "stale" | "invalidated" | "rebuilding";

export const DERIVED_ARTIFACT_STATUSES = [
  "active",
  "stale",
  "invalidated",
  "rebuilding",
] as const satisfies readonly DerivedArtifactStatus[];

export type DerivedArtifactSourceRefV1 =
  | {
      kind: "memory";
      memoryId: string;
      memoryRevision: string;
      contentHash: string;
    }
  | {
      kind: "artifact";
      artifactId: string;
      artifactKind: DerivedArtifactKind;
      artifactRevision: string;
      contentHash: string;
    };

export interface DerivedArtifactDependencyV1 {
  artifactId: string;
  artifactKind: DerivedArtifactKind;
  artifactRevision: string;
  sources: DerivedArtifactSourceRefV1[];
  // §12.3 write 時に materialize し、read 時の traversal では導出しない
  baseMemoryClosure: Array<{ memoryId: string; memoryRevision: string; contentHash: string }>;
  sourceEventIds: string[];
  generationId?: string;
}

export interface DerivedArtifactInvalidationEventV1 {
  eventId: string;
  artifactId: string;
  artifactKind: DerivedArtifactKind;
  expectedArtifactRevision: string;
  sourceMemoryId: string;
  invalidatingMemoryRevision: string;
  viaArtifactId?: string;
  hopDepth: number;
  reason:
    | "memory_updated"
    | "memory_superseded"
    | "memory_retracted"
    | "memory_invalidated"
    | "source_artifact_invalidated";
  resultingStatus: "stale" | "invalidated";
  idempotencyKey: string;
  createdAt: string;
}

export type CapabilityTestDisposition = "not_run" | "proven" | "unsupported" | "unknown_after_test";

export const CAPABILITY_TEST_DISPOSITIONS = [
  "not_run",
  "proven",
  "unsupported",
  "unknown_after_test",
] as const satisfies readonly CapabilityTestDisposition[];

export type ContractPreflightState = "incomplete" | "complete";

export const CONTRACT_PREFLIGHT_STATES = ["incomplete", "complete"] as const satisfies readonly ContractPreflightState[];

export interface RequiredCapabilityScenarioV1 {
  scenarioId: string;
  title: string;
  appliesToAgents: string[];
  requiredFor: Array<"generic_phase3" | "automatic_strategy" | "tier_a">;
}

export interface CapabilityScenarioManifestV1 {
  manifestVersion: string;
  // §13 exact-set 照合に用いる manifest hash
  manifestHash: string;
  scenarios: RequiredCapabilityScenarioV1[];
}
