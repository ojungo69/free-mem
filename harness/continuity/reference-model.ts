/**
 * addendum v6.2 §3.1 / §4.2 / §4.3 の参照実装。
 *
 * 目的は「TS と Rust が同じ fixture から同じ結果を出す」ことの基準になる決定的な関数群を
 * 置くこと。時計・乱数・I/O を使わず、入力 event と直前の状態だけから次の状態を決める。
 *
 * 正本に書かれていない導出（revision の作り方など）は evidence/phase3-reference-model.md に
 * 根拠と限界を記録している。addendum に無い規則をここで発明しない。
 */
import { createHash } from "node:crypto";
import { canonicalizeJson } from "../schema/jcs.ts";
import {
  NON_OPERATION_EVENT_KINDS,
  OPERATION_EVENT_PHASES,
  SENSITIVITIES,
  type CanonicalWorkStateV1,
  type ContinuityCaptureMethod,
  type ContinuityIngestAttestationV1,
  type NormalizedContinuityEvent,
  type OperationCorrelationV1,
  type PendingOperation,
  type Sensitivity,
} from "../schema/continuity.ts";

const INGEST_SEQ_PATTERN = /^(0|[1-9][0-9]*)$/;

/** revision 導出の schema 版。導出式を変えるときはここを上げる。 */
const REVISION_SCHEMA_ID = "free-mem/work-state-revision/v1";

/** operationId 導出の schema 版。 */
const OPERATION_ID_SCHEMA_ID = "free-mem/operation-id/v1";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * §22.6「server seq、device seq、epoch は JavaScript safe integer を超えても壊れない
 * decimal string として wire へ出す」。よって数値化して比較しない。先頭ゼロが無い decimal
 * なので「桁数 → 辞書順」の 2 段比較が全順序になる。
 */
export function compareIngestSeq(a: string, b: string): number {
  assertIngestSeq(a);
  assertIngestSeq(b);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function assertIngestSeq(value: string): void {
  if (!INGEST_SEQ_PATTERN.test(value)) {
    throw new Error(`ingestSeq が decimal string でない: ${JSON.stringify(value)}`);
  }
}

function maxIngestSeq(a: string, b: string): string {
  return compareIngestSeq(a, b) >= 0 ? a : b;
}

// --- §3.1 intake ------------------------------------------------------------

/** §3.1「scenarioId ... proven for that `captureMethod`/channel pair」の照合表の 1 行。 */
export interface ProvenScenarioV1 {
  scenarioId: string;
  captureMethod: ContinuityCaptureMethod;
  channel: ContinuityIngestAttestationV1["channel"];
}

/**
 * daemon intake 層が持つ文脈。caller ではなく intake 側の値であることが §3.1 の要点なので、
 * event とは別の引数として渡す。
 */
export interface IntakeContextV1 {
  exactAgentVersion: string;
  activeCapabilityHash: string;
  provenScenarios: readonly ProvenScenarioV1[];
}

/**
 * §3.1「`evidenceKind` と `ingestAttestation` は daemon intake 層が割り当て、caller の値を
 * 信頼しない」。native の条件を 1 つでも満たさない event は、caller が何を送っていても
 * `synthesized` になる。
 */
export function stampIntakeEvidence(
  event: NormalizedContinuityEvent,
  context: IntakeContextV1,
): NormalizedContinuityEvent {
  const { provenance } = event;
  const attestation = provenance.ingestAttestation;
  const proven =
    attestation !== undefined &&
    provenance.sourceAgentVersion === context.exactAgentVersion &&
    provenance.capabilityHash === context.activeCapabilityHash &&
    provenance.scenarioId !== undefined &&
    context.provenScenarios.some(
      (scenario) =>
        scenario.scenarioId === provenance.scenarioId &&
        scenario.captureMethod === provenance.captureMethod &&
        scenario.channel === attestation.channel,
    );
  return {
    ...event,
    provenance: { ...provenance, evidenceKind: proven ? "native" : "synthesized" },
  };
}

// --- §3.1 operation envelope（#29） -----------------------------------------

const NON_OPERATION_KIND_SET: ReadonlySet<string> = new Set(NON_OPERATION_EVENT_KINDS);

/**
 * §3.1「operation event without a valid `operation` envelope is a schema violation」。
 * schema では kind が開いた文字列のため表現できず（#29）、この層で落とす。
 */
export function assertOperationEnvelope(event: NormalizedContinuityEvent): void {
  const expectedPhase = (OPERATION_EVENT_PHASES as Record<string, string | undefined>)[event.kind];
  if (expectedPhase === undefined) {
    if (event.operation !== undefined && NON_OPERATION_KIND_SET.has(event.kind)) {
      throw new Error(`§3.1 違反: operation 系でない kind ${event.kind} が operation envelope を持つ`);
    }
    return;
  }
  const operation = event.operation;
  if (operation === undefined) {
    throw new Error(`§3.1 違反: operation event ${event.kind} に operation envelope が無い`);
  }
  if (operation.phase !== expectedPhase) {
    throw new Error(
      `§3.1 違反: kind ${event.kind} の phase は ${expectedPhase} だが envelope は ${operation.phase}`,
    );
  }
  if (operation.operationMatchKey === "" || operation.operationKind === "") {
    throw new Error(`§3.1 違反: operation envelope の operationMatchKey / operationKind が空`);
  }
}

/**
 * §3.1「`turnId` は `turnIdSource` が native / synthesized_monotonic のとき必須、
 * unavailable のとき不在」。turn 有無で振る舞いが変わる規則（§4.3 の rule 2）が
 * turnId の有無を根拠にできるよう、ここで不変条件を確定させる。
 */
export function assertTurnIdentity(event: NormalizedContinuityEvent): void {
  const hasTurnId = event.turnId !== undefined;
  if (event.turnIdSource === "unavailable") {
    if (hasTurnId) {
      throw new Error("§3.1 違反: turnIdSource が unavailable なのに turnId がある");
    }
    return;
  }
  if (!hasTurnId) {
    throw new Error(`§3.1 違反: turnIdSource が ${event.turnIdSource} なのに turnId が無い`);
  }
}

// --- §8.2 idempotency key ---------------------------------------------------

/**
 * v6 §8.2「idempotencyKey = adapterDeliveryId ?? sha256(canonical source fingerprint)」。
 * fingerprint は adapter が算出して `canonicalFingerprint` として届けるので、ここでは
 * 導出式ではなく優先順位（第一 authority は adapterDeliveryId）だけを実装する。
 */
export function idempotencyKeyOf(event: NormalizedContinuityEvent): string {
  const key = event.adapterDeliveryId ?? event.canonicalFingerprint;
  if (key === "") {
    throw new Error("idempotency key が空（adapterDeliveryId も canonicalFingerprint も無い）");
  }
  return key;
}

// --- §4.2 状態と revision ---------------------------------------------------

/** hash 対象は「stateRevision を除いた状態」。除外は列挙ではなく型と構築で担保する。 */
export type WorkStateContentV1 = Omit<CanonicalWorkStateV1, "stateRevision">;

export interface WorkStateRevisionEntryV1 {
  revision: string;
  contentHash: string;
  eventId: string;
  ingestSeq: string;
}

/** 適用済み idempotency key → 最初に適用した eventId。 */
export type IdempotencyLedger = ReadonlyMap<string, string>;

export interface TaskWorkStateSnapshotV1 {
  state: CanonicalWorkStateV1;
  history: readonly WorkStateRevisionEntryV1[];
  /**
   * operationId → start event の ingestSeq。§4.3「terminal は start より後でなければならない」を
   * 権威順序（ingestSeq）で判定するために持つ。`PendingOperation` は startedAt（時刻）しか
   * 持たないため、frozen schema の外に置く（#35）。
   */
  operationStartSeq: ReadonlyMap<string, string>;
}

export type ContinuityDiagnosticCode =
  | "terminal_unmatched"
  | "terminal_ambiguous"
  | "terminal_conflict"
  | "terminal_out_of_order"
  | "terminal_already_applied"
  | "duplicate_operation_start";

export interface ContinuityDiagnosticV1 {
  code: ContinuityDiagnosticCode;
  eventId: string;
  detail: string;
}

export interface TaskStateReductionResult {
  applied: boolean;
  snapshot: TaskWorkStateSnapshotV1;
  contentHash: string;
  ledger: IdempotencyLedger;
  diagnostics: readonly ContinuityDiagnosticV1[];
}

export function contentHashOf(content: WorkStateContentV1): string {
  return sha256Hex(canonicalizeJson(content));
}

function deriveRevision(previousRevision: string, eventId: string, contentHash: string): string {
  return sha256Hex(
    canonicalizeJson({ schema: REVISION_SCHEMA_ID, previousRevision, eventId, contentHash }),
  );
}

function deriveOperationId(startEventId: string, operationMatchKey: string): string {
  return sha256Hex(canonicalizeJson({ schema: OPERATION_ID_SCHEMA_ID, startEventId, operationMatchKey }));
}

const SENSITIVITY_RANK: ReadonlyMap<string, number> = new Map(
  SENSITIVITIES.map((value, index) => [value, index]),
);

/**
 * v6「構成要素の最大機密度（集約値）」。構成要素を手で並べると、状態に欄が増えたとき
 * 集約から漏れるので、内容を走査して見つけた `sensitivity` すべての最大を取る。
 */
function aggregateSensitivity(content: Omit<WorkStateContentV1, "sensitivity">): Sensitivity {
  let rank = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "sensitivity" && typeof child === "string") {
        rank = Math.max(rank, SENSITIVITY_RANK.get(child) ?? 0);
        continue;
      }
      visit(child);
    }
  };
  visit(content);
  return SENSITIVITIES[rank] as Sensitivity;
}

function nextContent(
  previous: CanonicalWorkStateV1,
  event: NormalizedContinuityEvent,
  pendingOperations: readonly PendingOperation[],
): WorkStateContentV1 {
  const { stateRevision: _ignored, sensitivity: _aggregate, ...rest } = previous;
  const withoutSensitivity = {
    ...rest,
    pendingOperations: [...pendingOperations],
    lastIngestSeq: maxIngestSeq(previous.lastIngestSeq, event.ingestSeq),
    updatedAt: event.occurredAt,
  };
  return { ...withoutSensitivity, sensitivity: aggregateSensitivity(withoutSensitivity) };
}

function commit(
  previous: TaskWorkStateSnapshotV1,
  event: NormalizedContinuityEvent,
  content: WorkStateContentV1,
  operationStartSeq: ReadonlyMap<string, string>,
  ledger: IdempotencyLedger,
  diagnostics: readonly ContinuityDiagnosticV1[],
): TaskStateReductionResult {
  const contentHash = contentHashOf(content);
  const revision = deriveRevision(previous.state.stateRevision, event.eventId, contentHash);
  const nextLedger = new Map(ledger);
  nextLedger.set(idempotencyKeyOf(event), event.eventId);
  return {
    applied: true,
    snapshot: {
      state: { ...content, stateRevision: revision },
      history: [
        ...previous.history,
        { revision, contentHash, eventId: event.eventId, ingestSeq: event.ingestSeq },
      ],
      operationStartSeq,
    },
    contentHash,
    ledger: nextLedger,
    diagnostics,
  };
}

/**
 * §4.2 の状態遷移。
 *
 * - dedupe authority は `adapterDeliveryId` または canonical fingerprint（§8.2 の優先順位）。
 * - dedupe は revision を採番する**前**に判定する。
 * - 重複した論理 event は no-op。同じ state bytes・content hash・revision・history を返す。
 * - 遅れて届いた event も新しい revision を作り、既存の証跡は書き換えない。
 */
export function reduceTaskWorkState(
  previous: TaskWorkStateSnapshotV1,
  event: NormalizedContinuityEvent,
  idempotencyLedger: IdempotencyLedger,
): TaskStateReductionResult {
  assertOperationEnvelope(event);
  assertTurnIdentity(event);
  assertIngestSeq(event.ingestSeq);
  // 状態は lineage ごとに 1 つ（§4）。別 lineage の event を黙って取り込むと、境界の確定
  // （§4.4）を経ずに前の task の状態が書き換わる
  if (event.taskLineageId !== undefined && event.taskLineageId !== previous.state.taskLineageId) {
    throw new Error(
      `別 lineage の event は適用しない: 状態 ${previous.state.taskLineageId} / event ${event.taskLineageId}`,
    );
  }
  const key = idempotencyKeyOf(event);

  if (idempotencyLedger.has(key)) {
    const { stateRevision: _ignored, ...content } = previous.state;
    return {
      applied: false,
      snapshot: previous,
      contentHash: contentHashOf(content),
      ledger: idempotencyLedger,
      diagnostics: [],
    };
  }

  const operation = event.operation;
  if (operation === undefined || operation.phase === "progress") {
    return commit(
      previous,
      event,
      nextContent(previous.state, event, previous.state.pendingOperations),
      previous.operationStartSeq,
      idempotencyLedger,
      [],
    );
  }

  if (operation.phase === "start") {
    const operationId = deriveOperationId(event.eventId, operation.operationMatchKey);
    if (previous.state.pendingOperations.some((pending) => pending.operationId === operationId)) {
      return commit(
        previous,
        event,
        nextContent(previous.state, event, previous.state.pendingOperations),
        previous.operationStartSeq,
        idempotencyLedger,
        [
          {
            code: "duplicate_operation_start",
            eventId: event.eventId,
            detail: `operationId ${operationId} は既に pending`,
          },
        ],
      );
    }
    const started = startPendingOperation(event, operation, operationId, previous.state.taskLineageId);
    const startSeq = new Map(previous.operationStartSeq);
    startSeq.set(operationId, event.ingestSeq);
    return commit(
      previous,
      event,
      nextContent(previous.state, event, [...previous.state.pendingOperations, started]),
      startSeq,
      idempotencyLedger,
      [],
    );
  }

  const correlation = correlateTerminalEvent(previous, event);
  if (correlation.matched === null) {
    return commit(
      previous,
      event,
      nextContent(previous.state, event, previous.state.pendingOperations),
      previous.operationStartSeq,
      idempotencyLedger,
      [{ code: correlation.diagnostic, eventId: event.eventId, detail: correlation.detail }],
    );
  }

  const matchedId = correlation.matched.operationId;
  // §4.3「terminal の証跡が欠けている / 曖昧なときは unknown を確定する」。successful が
  // 無い terminal は成否を主張できないので unknown に倒す。
  const status =
    event.successful === true ? ("succeeded" as const)
    : event.successful === false ? ("failed" as const)
    : ("unknown" as const);
  const closed = previous.state.pendingOperations.map((pending) =>
    pending.operationId === matchedId
      ? {
          ...pending,
          status,
          sourceEventIds: [...pending.sourceEventIds, event.eventId],
          terminalAt: event.occurredAt,
        }
      : pending,
  );
  return commit(
    previous,
    event,
    nextContent(previous.state, event, closed),
    previous.operationStartSeq,
    idempotencyLedger,
    [],
  );
}

function startPendingOperation(
  event: NormalizedContinuityEvent,
  operation: NonNullable<NormalizedContinuityEvent["operation"]>,
  operationId: string,
  stateTaskLineageId: string,
): PendingOperation {
  const correlation: OperationCorrelationV1 = {
    operationId,
    startEventId: event.eventId,
    operationMatchKey: operation.operationMatchKey,
    sessionId: event.sessionId,
    // event が lineage を持たない場合、還元先の状態が属する lineage を使う（event は
    // その lineage の状態へ適用されている）。
    taskLineageId: event.taskLineageId ?? stateTaskLineageId,
    toolName: operation.operationKind,
    ...(operation.nativeOperationId !== undefined
      ? { nativeOperationId: operation.nativeOperationId }
      : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(operation.canonicalInputHash !== undefined
      ? { canonicalInputHash: operation.canonicalInputHash }
      : {}),
  };
  return {
    operationId,
    correlation,
    // operationKind は adapter 固有の自由文字列で、PendingOperation の分類語彙への写像は
    // addendum に無い（#36）。tool 由来であることだけが確実なので tool とする。
    kind: "tool",
    description: operation.operationKind,
    status: "started",
    // §4.3 の既定（shell は verify_first、破壊的/外部/資格情報は never_auto）を選ぶには
    // operationKind の分類表が要る。表が無い間は最も制限の強い側に倒す（#36）。
    replayPolicy: "never_auto",
    sourceEventIds: [event.eventId],
    startedAt: event.occurredAt,
    // §12.3 の分類器が無い間、内容を見ずに normal と申告しない（#36）。
    sensitivity: "private",
    ...(operation.nativeOperationId !== undefined
      ? { idempotencyKey: operation.nativeOperationId }
      : {}),
  };
}

// --- §4.3 terminal correlation ---------------------------------------------

export type TerminalCorrelationResult =
  | { matched: PendingOperation; rule: "native_operation_id" | "match_key" }
  | { matched: null; rule: "no_match"; diagnostic: ContinuityDiagnosticCode; detail: string };

function isOpen(pending: PendingOperation): boolean {
  return pending.status === "started" || pending.status === "unknown";
}

/**
 * §4.3 の terminal 照合。authority は順序付き:
 *   1. `nativeOperationId` 完全一致 + 同一 session / task lineage
 *   2. `operationMatchKey` 完全一致 + 同一 session / task lineage + turn / kind が両立 +
 *      open な候補がちょうど 1 件
 *   3. それ以外は不一致
 * command 文字列・tool 名・時刻の近さ・cwd だけでは決して足りない。
 */
export function correlateTerminalEvent(
  previous: TaskWorkStateSnapshotV1,
  terminalEvent: NormalizedContinuityEvent,
): TerminalCorrelationResult {
  assertTurnIdentity(terminalEvent);
  const operation = terminalEvent.operation;
  if (operation === undefined || operation.phase !== "terminal") {
    return { matched: null, rule: "no_match", diagnostic: "terminal_unmatched", detail: "terminal envelope が無い" };
  }
  const lineage = terminalEvent.taskLineageId ?? previous.state.taskLineageId;
  const sameScope = previous.state.pendingOperations.filter(
    (pending) =>
      pending.correlation.sessionId === terminalEvent.sessionId &&
      pending.correlation.taskLineageId === lineage,
  );

  const byNativeId =
    operation.nativeOperationId === undefined
      ? []
      : sameScope.filter((pending) => pending.correlation.nativeOperationId === operation.nativeOperationId);

  const candidates =
    byNativeId.length > 0
      ? byNativeId
      : sameScope.filter(
          (pending) =>
            pending.correlation.operationMatchKey === operation.operationMatchKey &&
            pending.correlation.toolName === operation.operationKind &&
            // §4.3「rule 2 は双方が turn 同一性を持つことを要求する」。§3.1 の不変条件
            // （unavailable のとき turnId は不在）を assertTurnIdentity で確定させてあるので、
            // turnId の有無がそのまま turn 同一性の有無になる。
            pending.correlation.turnId !== undefined &&
            pending.correlation.turnId === terminalEvent.turnId,
        );
  const rule = byNativeId.length > 0 ? "native_operation_id" : "match_key";

  if (candidates.length === 0) {
    return {
      matched: null,
      rule: "no_match",
      diagnostic: "terminal_unmatched",
      detail: "一致する open な operation が無い",
    };
  }
  const open = candidates.filter(isOpen);
  if (open.length === 0) {
    return {
      matched: null,
      rule: "no_match",
      diagnostic: "terminal_already_applied",
      detail: "候補はすべて terminal 済み",
    };
  }
  if (open.length > 1) {
    return {
      matched: null,
      rule: "no_match",
      diagnostic: "terminal_ambiguous",
      detail: `open な候補が ${open.length} 件`,
    };
  }
  const matched = open[0] as PendingOperation;

  const startSeq = previous.operationStartSeq.get(matched.operationId);
  if (startSeq === undefined || compareIngestSeq(terminalEvent.ingestSeq, startSeq) <= 0) {
    return {
      matched: null,
      rule: "no_match",
      diagnostic: "terminal_out_of_order",
      detail: "terminal が start より後であることを権威順序で確認できない",
    };
  }
  const startHash = matched.correlation.canonicalInputHash;
  if (
    startHash !== undefined &&
    operation.canonicalInputHash !== undefined &&
    startHash !== operation.canonicalInputHash
  ) {
    return {
      matched: null,
      rule: "no_match",
      diagnostic: "terminal_conflict",
      detail: "canonicalInputHash が start と衝突",
    };
  }
  return { matched, rule };
}

// --- §4.3 abandonment -------------------------------------------------------

/**
 * §4.3「terminal の証跡が無い、または曖昧なまま放棄・復帰したときは unknown を確定する」。
 * 状態は不変なので、新しい revision を持つ別の状態を返す。
 */
export function finalizeAbandonedState(
  state: CanonicalWorkStateV1,
  event: NormalizedContinuityEvent,
): CanonicalWorkStateV1 {
  assertIngestSeq(event.ingestSeq);
  const pendingOperations = state.pendingOperations.map((pending) =>
    pending.status === "started"
      ? { ...pending, status: "unknown" as const, sourceEventIds: [...pending.sourceEventIds, event.eventId] }
      : pending,
  );
  const content = nextContent(state, event, pendingOperations);
  return {
    ...content,
    stateRevision: deriveRevision(state.stateRevision, event.eventId, contentHashOf(content)),
  };
}
