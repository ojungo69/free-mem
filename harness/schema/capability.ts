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
  // どの capture fixture が根拠か。cell 間で「同一の実測に基づくか」を比較するために持つ
  // （limitations の自由文から fixture 名を読み取るのは照合として弱い）
  sourceFixtureId?: string;
  // その capture の raw transcript の SHA-256。Task 2/3 の実 CLI rig が埋める。
  // 実測がまだ無い cell では null。
  evidenceHash?: string | null;
}

/**
 * 自動配送の経路。`manual_only` は「自動配送しない」であって「resume できない」ではない。
 *
 * - native_prompt_gate: CLI 自身が prompt を model に渡す前に context を差し込める
 * - next_prompt_synthesized: hook 合成で次 prompt 前配送を実現できる（両 cell が同一実測で証明済み）
 * - session_start_full: SessionStart でのみ full 配送できる
 * - manual_only: 自動配送の証明が無い（既定値）
 */
export type ResumeDeliveryStrategy =
  | "native_prompt_gate"
  | "next_prompt_synthesized"
  | "session_start_full"
  | "manual_only";

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
  // prompt が model に渡る前に context が可視だったか。hook が印字しただけでは足りない
  // ため promptAwareInjection とは別 cell にする（両方揃って初めて prompt 経路を名乗れる）
  promptDeliveryBeforeModel: CapabilityEvidence;
  // compact 後の full 配送がちょうど 1 回か（重複 hook の dedupe を含む）
  compactSingleDelivery: CapabilityEvidence;
  // §7.2 の union に "unknown" が無いため、未観測を表現できるよう null を許す
  // （"unsupported" と書くと未計測を否定的事実として断定してしまう）
  compactionRecoveryStrategy: CompactionRecoveryStrategy | null;
  trueSessionEnd: CapabilityEvidence;
  subagentCapture: CapabilityEvidence;
  stableNativeSessionId: CapabilityEvidence;
  // 上の cell 群から導出する。手で書き換えない
  resumeDeliveryStrategy: ResumeDeliveryStrategy;
  // capability hash の入力（exact version + 各 fixture の evidence hash）。
  // hash 値そのものは scenario manifest が揃ってから計算する（addendum §13）
  capabilityHashInputs: string[];
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
  // raw transcript の SHA-256（64 hex）。実 CLI rig が記録する
  evidenceHash?: string;
  // 高位 cell の観測結果（観測できた fixture だけが書く。書かなければ unknown のまま）
  highLevel?: Partial<{
    sessionStartInjection: "native" | "synthesized" | "unsupported";
    promptAwareInjection: "native" | "synthesized" | "unsupported";
    promptDeliveryBeforeModel: "native" | "synthesized" | "unsupported";
    compactSingleDelivery: "native" | "synthesized" | "unsupported";
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
    promptDeliveryBeforeModel: unknownEvidence(nativeVersion),
    compactSingleDelivery: unknownEvidence(nativeVersion),
    compactionRecoveryStrategy: null,
    trueSessionEnd: unknownEvidence(nativeVersion),
    subagentCapture: unknownEvidence(nativeVersion),
    stableNativeSessionId: unknownEvidence(nativeVersion),
    resumeDeliveryStrategy: "manual_only",
    capabilityHashInputs: [],
  };
}

/** 実 CLI で観測され、肯定的な結論が出ている cell だけを「証明済み」とする。 */
function isProven(cell: CapabilityEvidence): boolean {
  return (
    (cell.value === "native" || cell.value === "synthesized") &&
    cell.evidenceKind === "real-cli-e2e" &&
    typeof cell.verifiedAt === "string" &&
    cell.verifiedAt.length > 0
  );
}

/**
 * 2 つの cell が「同一の実測」に基づくか。exact version・fixture・evidence hash の
 * 3 つすべてが揃って一致することを要求する。別々の run をつなぎ合わせて経路を
 * 主張させないためのゲートなので、hash が無い cell は「照合できない」= 不合格とする
 * （transcript hash の無い手書き fixture が自動配送を有効化できてしまうため）。
 */
function sameEvidenceSource(a: CapabilityEvidence, b: CapabilityEvidence): boolean {
  if (a.nativeVersion !== b.nativeVersion) return false;
  if (!a.sourceFixtureId || !b.sourceFixtureId) return false;
  if (a.sourceFixtureId !== b.sourceFixtureId) return false;
  if (!a.evidenceHash || !b.evidenceHash) return false;
  if (a.evidenceHash !== b.evidenceHash) return false;
  return true;
}

/**
 * 配送経路を cell から導出する。証明が欠けたら必ず下位の経路へ落ちる（既定 manual_only）。
 * 片方だけ証明された prompt 経路（half-proven）は採用しない。
 *
 * prompt 経路の 2 cell が native と synthesized で割れた場合は、弱いほう
 * （= `next_prompt_synthesized`）に倒す。両方 native のときだけ `native_prompt_gate`。
 */
export function resolveResumeDeliveryStrategy(caps: AdapterCapabilities): ResumeDeliveryStrategy {
  const prompt = caps.promptAwareInjection;
  const beforeModel = caps.promptDeliveryBeforeModel;
  const promptPathProven = isProven(prompt) && isProven(beforeModel) && sameEvidenceSource(prompt, beforeModel);

  if (promptPathProven) {
    if (prompt.value === "native" && beforeModel.value === "native") return "native_prompt_gate";
    return "next_prompt_synthesized";
  }
  if (isProven(caps.sessionStartInjection)) return "session_start_full";
  return "manual_only";
}
