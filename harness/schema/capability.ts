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
  // 未観測 cell は evidenceKind / verifiedAt を持たない（観測していないものに
  // 証跡種別と検証時刻を書くと provenance の捏造になる）。§7.2 の型は必須だが、
  // 本 harness では value==="unknown" のとき null を明示する。
  coverage?: number; // 既知の欠落があるcapabilityの被覆率
  sourceEvents: string[]; // synthesized時の根拠native event
  nativeVersion: string; // 検証したexact CLI version
  sourceCommit?: string;
  evidenceKind: "official-doc" | "source-test" | "real-cli-e2e" | null;
  verifiedAt: string | null;
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
  // 観測できた phase と、観測を試みていない phase を区別する（前者だけを並べると
  // 「サポートしていない」と読めてしまうため）
  toolFailurePhases: ToolFailurePhase[];
  toolFailurePhasesUntested: ToolFailurePhase[];
  sessionStartInjection: CapabilityEvidence;
  promptAwareInjection: CapabilityEvidence;
  // §7.2 の union に "unknown" が無いため、未観測を表現できるよう null を許す
  // （"unsupported" と書くと未計測を否定的事実として断定してしまう）
  compactionRecoveryStrategy: CompactionRecoveryStrategy | null;
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
  // capability 既定 "native"。Stop→turn_completed 等の合成は "synthesized" + sourceEvents（§7.2）。
  observedEvents: Array<{
    kind: EventKind | "raw";
    raw?: unknown;
    at?: string;
    capability?: "native" | "synthesized";
    sourceEvents?: string[];
    coverage?: number;
    limitations?: string[];
  }>;
  toolFailurePhasesObserved: ToolFailurePhase[];
  limitations: string[];
  rig: { isolated: boolean; internalRunMarker: boolean }; // 隔離 rig 下で取ったか
  // 高位 cell の観測結果（観測できた fixture だけが書く。書かなければ unknown のまま）
  highLevel?: Partial<{
    sessionStartInjection: "native" | "synthesized" | "unsupported";
    promptAwareInjection: "native" | "synthesized" | "unsupported";
    compactionRecoveryStrategy: CompactionRecoveryStrategy;
    trueSessionEnd: "native" | "synthesized" | "unsupported";
    subagentCapture: "native" | "synthesized" | "unsupported";
    stableNativeSessionId: "native" | "synthesized" | "unsupported";
  }>;
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
    evidenceKind: null,
    verifiedAt: null,
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
    toolFailurePhasesUntested: [],
    sessionStartInjection: unknownEvidence(nativeVersion),
    promptAwareInjection: unknownEvidence(nativeVersion),
    compactionRecoveryStrategy: null,
    trueSessionEnd: unknownEvidence(nativeVersion),
    subagentCapture: unknownEvidence(nativeVersion),
    stableNativeSessionId: unknownEvidence(nativeVersion),
  };
}
