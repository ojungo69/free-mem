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
  CONTINUITY_LIMITS,
  NON_OPERATION_EVENT_KINDS,
  OPERATION_EVENT_PHASES,
  SENSITIVITIES,
  type CanonicalWorkStateV1,
  type ContinuityCaptureMethod,
  type ContinuityIngestAttestationV1,
  type ContinuityOperationPhase,
  type NormalizedContinuityEvent,
  type OperationCorrelationV1,
  type PendingOperation,
  type Sensitivity,
  type TurnIdSource,
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
  /**
   * 認証済み peer identity が名乗ることを許された Agent。§3.1 は evidenceKind を
   * 「認証済み peer identity・channel・captureMethod・capability matrix」から導けと言うので、
   * caller が申告する `event.sourceAgent` は受領証が指す Agent と一致しなければならない。
   * 一致を見ないと、認証済みの adapter が他 Agent 名義の event に native authority を得られる。
   */
  expectedSourceAgent: string;
  exactAgentVersion: string;
  /**
   * §3.1「`turnIdSource="native"` は、その exact version について proven な native turn
   * identifier を要求する」。capability matrix にまだ turn identity の cell が無いので（#40）、
   * intake 側の既知事実としてここで受け取る。false のとき caller の native 主張は降格する。
   */
  nativeTurnIdentityProven: boolean;
  activeCapabilityHash: string;
  provenScenarios: readonly ProvenScenarioV1[];
  /**
   * 認証済みの取り込みに対して daemon が発行する受領証。認証されていない経路
   * （peer identity を確かめられない spool 等）では持たない。caller が送ってきた
   * `provenance.ingestAttestation` は常にこの値で置き換える。
   */
  attestation?: ContinuityIngestAttestationV1;
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
  // caller の attestation は読まずに捨てる。読んだ時点で「認証済みだと名乗れる」ことになり、
  // §3.1 が禁じている自己申告の native authority が通ってしまう
  const { ingestAttestation: _claimed, ...provenance } = event.provenance;
  const attestation = context.attestation;
  // §3.1 は evidenceKind も turn identity も「認証済み peer identity」から導けと言う。
  // 受領証があり、かつ caller の名乗る Agent と version が受領証の指すそれと一致することが
  // その認証にあたる。evidence の証明も turn の証明もこの束縛の上に乗る
  const authenticatedVersion =
    attestation !== undefined &&
    event.sourceAgent === context.expectedSourceAgent &&
    provenance.sourceAgentVersion === context.exactAgentVersion;
  const proven =
    authenticatedVersion &&
    provenance.capabilityHash === context.activeCapabilityHash &&
    provenance.scenarioId !== undefined &&
    context.provenScenarios.some(
      (scenario) =>
        scenario.scenarioId === provenance.scenarioId &&
        scenario.captureMethod === provenance.captureMethod &&
        scenario.channel === attestation.channel,
    );
  // §3.1「turn identity は payload の慣習ではなく canonical」。proven でない version の native
  // 主張をそのまま通すと、rule 2 の turn 両立を caller が自作した turnId で満たせてしまう。
  // 証明が無いなら turn 同一性は確立できない = unavailable（turnId は §3.1 の不変条件で不在）。
  // 証明は「その exact version について」なので、その version であること自体が認証されて
  // いなければ証明を適用できない。capabilityHash は capability matrix にまだ turn identity の
  // cell が無い（#40）ため、ここでは要求しない
  const turnDowngraded =
    event.turnIdSource === "native" && !(authenticatedVersion && context.nativeTurnIdentityProven);
  const { turnId: _claimedTurnId, ...withoutTurnId } = event;
  return {
    ...(turnDowngraded ? withoutTurnId : event),
    ...(turnDowngraded ? { turnIdSource: "unavailable" as const } : {}),
    provenance: {
      ...provenance,
      evidenceKind: proven ? "native" : "synthesized",
      ...(attestation !== undefined ? { ingestAttestation: attestation } : {}),
    },
  };
}

// --- §3.1 operation envelope（#29） -----------------------------------------

const NON_OPERATION_KIND_SET: ReadonlySet<string> = new Set(NON_OPERATION_EVENT_KINDS);

// `kind` は開いた文字列なので、素の object を添字で引くと `__proto__` や `constructor` が
// 値として返る。自分のキーだけを持つ Map で引く
const OPERATION_PHASE_BY_KIND: ReadonlyMap<string, ContinuityOperationPhase> = new Map(
  Object.entries(OPERATION_EVENT_PHASES),
);

/**
 * §3.1「operation event without a valid `operation` envelope is a schema violation」。
 * schema では kind が開いた文字列のため表現できず（#29）、この層で落とす。
 */
export function assertOperationEnvelope(event: NormalizedContinuityEvent): void {
  const expectedPhase = OPERATION_PHASE_BY_KIND.get(event.kind);
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

/**
 * 状態は lineage ごとに 1 つ（§4）。別 lineage の event を黙って取り込むと、境界の確定
 * （§4.4）を経ずに前の task の状態が書き換わる。lineage を持たない event は、還元先の
 * 状態が属する lineage のものとして扱う。
 */
function assertSameLineage(state: CanonicalWorkStateV1, event: NormalizedContinuityEvent): void {
  if (event.taskLineageId !== undefined && event.taskLineageId !== state.taskLineageId) {
    throw new Error(
      `別 lineage の event は適用しない: 状態 ${state.taskLineageId} / event ${event.taskLineageId}`,
    );
  }
}

/** hash 対象は「stateRevision を除いた状態」。除外は列挙ではなく型と構築で担保する。 */
export type WorkStateContentV1 = Omit<CanonicalWorkStateV1, "stateRevision">;

export interface WorkStateRevisionEntryV1 {
  revision: string;
  contentHash: string;
  eventId: string;
}

/** 適用済み idempotency key → 最初に適用した eventId。 */
export type IdempotencyLedger = ReadonlyMap<string, string>;

/** start event のうち frozen schema に入らない値（#35）。 */
export interface OperationStartFactsV1 {
  ingestSeq: string;
  turnIdSource: TurnIdSource;
}

export interface TaskWorkStateSnapshotV1 {
  state: CanonicalWorkStateV1;
  history: readonly WorkStateRevisionEntryV1[];
  /**
   * operationId → start event の権威順序と turn 同一性の種別。§4.3 の「terminal は start より
   * 後」「rule 2 は同じ `turnIdSource` 種別を要求する」を判定するために持つ。
   * `PendingOperation` / `OperationCorrelationV1` はどちらも持てないので frozen schema の外に置く。
   */
  operationStarts: ReadonlyMap<string, OperationStartFactsV1>;
}

export type ContinuityDiagnosticCode =
  | "terminal_unmatched"
  | "terminal_ambiguous"
  | "terminal_conflict"
  | "terminal_out_of_order"
  | "terminal_already_applied"
  | "duplicate_operation_start"
  | "pending_operations_overflow"
  | "pending_operations_evicted";

export interface ContinuityDiagnosticV1 {
  code: ContinuityDiagnosticCode;
  eventId: string;
  detail: string;
}

export interface TaskStateReductionResult {
  /** applied = 状態に入った / duplicate = 重複で no-op / quarantined = 衝突として隔離 */
  outcome: "applied" | "duplicate" | "quarantined";
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
        rank = Math.max(rank, SENSITIVITIES.indexOf(child as Sensitivity));
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
  pendingOperations: PendingOperation[],
): WorkStateContentV1 {
  const { stateRevision: _ignored, sensitivity: _aggregate, ...rest } = previous;
  const withoutSensitivity = {
    ...rest,
    pendingOperations,
    lastIngestSeq: maxIngestSeq(previous.lastIngestSeq, event.ingestSeq),
    updatedAt: event.occurredAt,
  };
  return { ...withoutSensitivity, sensitivity: aggregateSensitivity(withoutSensitivity) };
}

function commit(
  previous: TaskWorkStateSnapshotV1,
  event: NormalizedContinuityEvent,
  ledger: IdempotencyLedger,
  applied: {
    pendingOperations: PendingOperation[];
    diagnostics: readonly ContinuityDiagnosticV1[];
    operationStarts?: ReadonlyMap<string, OperationStartFactsV1>;
  },
): TaskStateReductionResult {
  const content = nextContent(previous.state, event, applied.pendingOperations);
  const contentHash = contentHashOf(content);
  const revision = deriveRevision(previous.state.stateRevision, event.eventId, contentHash);
  const nextLedger = new Map(ledger);
  nextLedger.set(idempotencyKeyOf(event), event.eventId);
  return {
    outcome: "applied",
    snapshot: {
      state: { ...content, stateRevision: revision },
      history: [...previous.history, { revision, contentHash, eventId: event.eventId }],
      operationStarts: applied.operationStarts ?? previous.operationStarts,
    },
    contentHash,
    ledger: nextLedger,
    diagnostics: applied.diagnostics,
  };
}

/** 状態にも台帳にも入れずに隔離する。訂正した event を後から入れ直せるようにするため。 */
function quarantine(
  previous: TaskWorkStateSnapshotV1,
  ledger: IdempotencyLedger,
  diagnostics: readonly ContinuityDiagnosticV1[],
): TaskStateReductionResult {
  const { stateRevision: _ignored, ...content } = previous.state;
  return {
    outcome: "quarantined",
    snapshot: previous,
    contentHash: contentHashOf(content),
    ledger,
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
  assertSameLineage(previous.state, event);
  const key = idempotencyKeyOf(event);

  if (idempotencyLedger.has(key)) {
    const { stateRevision: _ignored, ...content } = previous.state;
    return {
      outcome: "duplicate",
      snapshot: previous,
      contentHash: contentHashOf(content),
      ledger: idempotencyLedger,
      diagnostics: [],
    };
  }

  const operation = event.operation;
  const unchanged = { pendingOperations: previous.state.pendingOperations, diagnostics: [] };

  if (operation === undefined || operation.phase === "progress") {
    return commit(previous, event, idempotencyLedger, unchanged);
  }

  if (operation.phase === "start") {
    const operationId = deriveOperationId(event.eventId, operation.operationMatchKey);
    // 台帳と状態がずれた状態で同じ start を再適用しても、同じ operation を二重に積まない
    if (previous.state.pendingOperations.some((pending) => pending.operationId === operationId)) {
      return commit(previous, event, idempotencyLedger, {
        ...unchanged,
        diagnostics: [
          { code: "duplicate_operation_start", eventId: event.eventId, detail: `operationId ${operationId} は既に pending` },
        ],
      });
    }
    const started = startPendingOperation(event, operation, operationId, previous.state.taskLineageId);
    const retained = retainPendingOperations(previous.state.pendingOperations);
    if (retained === null) {
      return quarantine(previous, idempotencyLedger, [
        {
          code: "pending_operations_overflow",
          eventId: event.eventId,
          detail: `pendingOperations が上限 ${CONTINUITY_LIMITS.arrayItems} 件で、落とせる terminal 済みの entry が無い`,
        },
      ]);
    }
    // 黙って間引かない。退避した operation の event 自体は event store に残るが、状態からは
    // 消えるので、どれを落としたかを診断に出す
    const kept = new Set(retained.map((pending) => pending.operationId));
    const evicted = previous.state.pendingOperations
      .filter((pending) => !kept.has(pending.operationId))
      .map((pending) => pending.operationId);
    return commit(previous, event, idempotencyLedger, {
      pendingOperations: [...retained, started],
      diagnostics:
        evicted.length === 0
          ? []
          : [
              {
                code: "pending_operations_evicted",
                eventId: event.eventId,
                detail: `上限 ${CONTINUITY_LIMITS.arrayItems} 件のため terminal 済みを退避: ${evicted.join(", ")}`,
              },
            ],
      operationStarts: new Map(previous.operationStarts).set(operationId, {
        ingestSeq: event.ingestSeq,
        turnIdSource: event.turnIdSource,
      }),
    });
  }

  const correlation = correlateTerminalEvent(previous, event);
  if (correlation.matched === null) {
    const diagnostics = [
      { code: correlation.diagnostic, eventId: event.eventId, detail: correlation.detail },
    ];
    // v6「same op ID + different hash: quarantine corruption」。衝突した event は状態にも
    // 台帳にも入れない（入れると、訂正された再配送が重複 no-op として黙って捨てられる）
    if (correlation.diagnostic === "terminal_conflict") {
      return quarantine(previous, idempotencyLedger, diagnostics);
    }
    // §4.3「zero or multiple にマッチした terminal は候補を unknown のままにする」。status は
    // unknown にするが pending には残すので、後から権威ある証跡（rule 1）が来れば閉じられる
    const unresolved = new Set(correlation.unresolvedOperationIds);
    return commit(previous, event, idempotencyLedger, {
      pendingOperations: previous.state.pendingOperations.map((pending) =>
        unresolved.has(pending.operationId) && pending.status === "started"
          ? { ...pending, status: "unknown" as const }
          : pending,
      ),
      diagnostics,
    });
  }

  const matchedId = correlation.matched.operationId;
  // §4.3「terminal の証跡が欠けている / 曖昧なときは unknown を確定する」。successful が
  // 無い terminal は成否を主張できないので unknown に倒す。
  const status =
    event.successful === true ? ("succeeded" as const)
    : event.successful === false ? ("failed" as const)
    : ("unknown" as const);
  return commit(previous, event, idempotencyLedger, {
    pendingOperations: previous.state.pendingOperations.map((pending) =>
      pending.operationId === matchedId
        ? {
            ...pending,
            status,
            sourceEventIds: [...pending.sourceEventIds, event.eventId],
            terminalAt: event.occurredAt,
          }
        : pending,
    ),
    diagnostics: [],
  });
}

/**
 * frozen schema は `pendingOperations` を 256 件（§10 の `arrayItems`）に制限しているのに、
 * addendum には保持方針が無い（#39）。上限に達したら、もう状態が変わらない succeeded / failed を
 * 古い順に落として新しい start の場所を空ける。`started` と `unknown` は後から rule 1 で
 * 閉じられる可能性があるので落とさない。落とせるものが無ければ `null` を返し、呼び出し側は
 * schema 違反の状態を作らずに隔離する。
 */
function retainPendingOperations(pending: PendingOperation[]): PendingOperation[] | null {
  if (pending.length < CONTINUITY_LIMITS.arrayItems) return pending;
  const dropCount = pending.length - CONTINUITY_LIMITS.arrayItems + 1;
  const dropped = new Set<string>();
  for (const candidate of pending) {
    if (dropped.size === dropCount) break;
    if (candidate.status === "succeeded" || candidate.status === "failed") {
      dropped.add(candidate.operationId);
    }
  }
  if (dropped.size < dropCount) return null;
  return pending.filter((candidate) => !dropped.has(candidate.operationId));
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
  | {
      matched: null;
      diagnostic: ContinuityDiagnosticCode;
      detail: string;
      /**
       * §4.3「zero or multiple にマッチした terminal は候補を `unknown` のままにする」。
       * 閉じられなかった同一 match key の open な候補を返す。
       */
      unresolvedOperationIds: readonly string[];
    };

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
    return {
      matched: null,
      diagnostic: "terminal_unmatched",
      detail: "terminal envelope が無い",
      unresolvedOperationIds: [],
    };
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
            pending.correlation.toolName === operation.operationKind,
        );
  const rule = byNativeId.length > 0 ? "native_operation_id" : "match_key";

  const open = candidates.filter((pending) => pending.status === "started" || pending.status === "unknown");
  // §4.3「候補を unknown のままにする」の候補集合。閉じられない分岐すべてで同じ集合を使う
  const unresolvedOperationIds = open.map((pending) => pending.operationId);

  if (candidates.length === 0) {
    return {
      matched: null,
      diagnostic: "terminal_unmatched",
      detail: "一致する open な operation が無い",
      unresolvedOperationIds,
    };
  }
  if (open.length === 0) {
    return {
      matched: null,
      diagnostic: "terminal_already_applied",
      detail: "候補はすべて terminal 済み",
      unresolvedOperationIds,
    };
  }
  // §4.3「rule 2 は双方が同じ `turnIdSource` 種別の turn 同一性を持つことを要求する。どちらかが
  // unavailable のとき rule 2 は適用されず、operation は unknown のままになる。閉じられるのは
  // rule 1 だけ」。§3.1 の不変条件（unavailable のとき turnId は不在）は assertTurnIdentity で
  // 確定させてあるので、turnId の有無がそのまま turn 同一性の有無になる。
  const eligible =
    byNativeId.length > 0
      ? open
      : open.filter(
          (pending) =>
            pending.correlation.turnId !== undefined &&
            pending.correlation.turnId === terminalEvent.turnId &&
            previous.operationStarts.get(pending.operationId)?.turnIdSource === terminalEvent.turnIdSource,
        );
  if (eligible.length === 0) {
    return {
      matched: null,
      diagnostic: "terminal_unmatched",
      detail: "turn 同一性が無いので rule 2 では閉じられない",
      unresolvedOperationIds,
    };
  }
  if (eligible.length > 1) {
    return {
      matched: null,
      diagnostic: "terminal_ambiguous",
      detail: `open な候補が ${eligible.length} 件`,
      unresolvedOperationIds,
    };
  }
  const matched = eligible[0] as PendingOperation;

  const start = previous.operationStarts.get(matched.operationId);
  if (start === undefined || compareIngestSeq(terminalEvent.ingestSeq, start.ingestSeq) <= 0) {
    return {
      matched: null,
      diagnostic: "terminal_out_of_order",
      detail: "terminal が start より後であることを権威順序で確認できない",
      unresolvedOperationIds,
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
      diagnostic: "terminal_conflict",
      detail: "canonicalInputHash が start と衝突",
      // 隔離は状態を一切変えないので、候補も unknown にしない
      unresolvedOperationIds: [],
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
  assertSameLineage(state, event);
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
