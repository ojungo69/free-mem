export type EventKind =
  | "session_started"
  | "user_prompted"
  | "assistant_completed"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "turn_completed"
  | "pre_compact"
  | "post_compact"
  | "session_idle"
  | "session_interrupted"
  | "session_ended";

export type Capability = "native" | "synthesized" | "unsupported" | "unknown";

export interface CapabilityEvidence {
  value: Capability;
  coverage?: number; // 既知の欠落があるcapabilityの被覆率
  sourceEvents: string[]; // synthesized時の根拠native event
  nativeVersion: string; // 検証したexact CLI version
  sourceCommit?: string;
  evidenceKind: "official-doc" | "source-test" | "real-cli-e2e";
  verifiedAt: string;
  limitations: string[];
}

export type ToolFailurePhase =
  | "executed"
  | "permission_denied"
  | "schema_invalid"
  | "unknown_tool"
  | "interrupt"
  | "unknown";

export type CompactionRecoveryStrategy =
  | "native_pre_and_post"
  | "native_pre_next_prompt"
  | "session_compaction_event"
  | "turn_checkpoint_detect_reset"
  | "unsupported";

export interface AdapterCapabilities {
  capture: Record<EventKind, CapabilityEvidence>;
  toolFailurePhases: ToolFailurePhase[];
  sessionStartInjection: CapabilityEvidence;
  promptAwareInjection: CapabilityEvidence;
  compactionRecoveryStrategy: CompactionRecoveryStrategy;
  trueSessionEnd: CapabilityEvidence;
  subagentCapture: CapabilityEvidence;
  stableNativeSessionId: CapabilityEvidence;
}

export interface CaptureFixture {
  fixtureId: string; // 例 "claude/lifecycle-basic"
  cli: "claude" | "codex";
  nativeVersion: string; // capture 時点の exact `--version` 出力
  capturedAt: string; // ISO 8601
  scenario: string; // 何を観測したか 1 行
  observedEvents: Array<{ kind: EventKind | "raw"; raw?: unknown; at?: string }>;
  toolFailurePhasesObserved: ToolFailurePhase[];
  limitations: string[];
  rig: { isolated: boolean; internalRunMarker: boolean }; // 隔離 rig 下で取ったか
}

export const EVENT_KINDS: readonly EventKind[] = [
  "session_started",
  "user_prompted",
  "assistant_completed",
  "tool_started",
  "tool_completed",
  "tool_failed",
  "turn_completed",
  "pre_compact",
  "post_compact",
  "session_idle",
  "session_interrupted",
  "session_ended",
] as const;

export const TOOL_FAILURE_PHASES: readonly ToolFailurePhase[] = [
  "executed",
  "permission_denied",
  "schema_invalid",
  "unknown_tool",
  "interrupt",
  "unknown",
] as const;

export function unknownEvidence(nativeVersion: string): CapabilityEvidence {
  return {
    value: "unknown",
    sourceEvents: [],
    nativeVersion,
    evidenceKind: "real-cli-e2e",
    verifiedAt: new Date().toISOString(),
    limitations: ["not observed in Phase 0B"],
  };
}

export function emptyMatrix(nativeVersion: string): AdapterCapabilities {
  const capture = {} as Record<EventKind, CapabilityEvidence>;
  for (const kind of EVENT_KINDS) {
    capture[kind] = unknownEvidence(nativeVersion);
  }
  return {
    capture,
    toolFailurePhases: [],
    sessionStartInjection: unknownEvidence(nativeVersion),
    promptAwareInjection: unknownEvidence(nativeVersion),
    compactionRecoveryStrategy: "unsupported",
    trueSessionEnd: unknownEvidence(nativeVersion),
    subagentCapture: unknownEvidence(nativeVersion),
    stableNativeSessionId: unknownEvidence(nativeVersion),
  };
}
