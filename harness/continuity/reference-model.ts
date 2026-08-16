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

declare const INTAKE_STAMP: unique symbol;

/**
 * intake を通った event。実体は `NormalizedContinuityEvent` そのもので、この目印は型だけに
 * 存在する（wire にも hash 対象にも現れない）。§3.1 の「evidenceKind は intake 層が割り当てる」は、
 * 還元器が生の event を受け取れてしまうと 1 経路の呼び忘れで丸ごと迂回されるので、
 * `reduceTaskWorkState` の入口をこの型に限定して呼び順を型で固定する。
 */
export type IntakeStampedEventV1 = NormalizedContinuityEvent & { readonly [INTAKE_STAMP]: true };

export interface IntakeStampResultV1 {
  event: IntakeStampedEventV1;
  /** §3.1「downgrade の理由は doctor が報告する」。降格を黙って行わないための報告経路 */
  diagnostics: readonly ContinuityDiagnosticV1[];
}

/**
 * §3.1「`evidenceKind` と `ingestAttestation` は daemon intake 層が割り当て、caller の値を
 * 信頼しない」。native の条件を 1 つでも満たさない event は、caller が何を送っていても
 * `synthesized` になる。
 */
export function stampIntakeEvidence(
  event: NormalizedContinuityEvent,
  context: IntakeContextV1,
): IntakeStampResultV1 {
  // caller の attestation は読まずに捨てる。読んだ時点で「認証済みだと名乗れる」ことになり、
  // §3.1 が禁じている自己申告の native authority が通ってしまう
  const { ingestAttestation: _claimed, ...provenance } = event.provenance;
  const attestation = context.attestation;
  // §3.1 は evidenceKind も turn identity も「認証済み peer identity」から導けと言う。
  // 受領証があり、かつ caller の名乗る Agent と version が受領証の指すそれと一致することが
  // その認証にあたる。evidence の証明も turn の証明もこの束縛の上に乗る
  const authenticatedVersion =
    attestation !== undefined &&
    // 空文字同士は「一致」ではなく「どちらも名乗っていない」。素通りさせない
    context.expectedSourceAgent !== "" &&
    context.exactAgentVersion !== "" &&
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
  const stamped = {
    ...(turnDowngraded ? withoutTurnId : event),
    ...(turnDowngraded ? { turnIdSource: "unavailable" as const } : {}),
    provenance: {
      ...provenance,
      evidenceKind: proven ? "native" : "synthesized",
      ...(attestation !== undefined ? { ingestAttestation: attestation } : {}),
    },
  } as IntakeStampedEventV1;
  return {
    event: stamped,
    // §3.1「turn scoping を要求する規則は unavailable に対して fail closed になり、影響を受けた
    // 自動経路は downgrade され、その理由は doctor が報告する」。降格した事実を残さないと、
    // 「何も correlate しない」だけが観測されて理由が辿れない
    diagnostics: turnDowngraded
      ? [
          {
            code: "turn_identity_downgraded" as const,
            eventId: event.eventId,
            detail: `native turn identity が ${provenance.sourceAgentVersion} について証明されていないので unavailable へ降格した`,
          },
        ]
      : [],
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
  // schema は adapterDeliveryId に minLength を持たないので空文字が届きうる。空文字は
  // 「delivery id が無い」であって「key が空」ではないので、fingerprint へ落とす
  const delivery = event.adapterDeliveryId === "" ? undefined : event.adapterDeliveryId;
  const fingerprint = event.canonicalFingerprint === "" ? undefined : event.canonicalFingerprint;
  const key = delivery ?? fingerprint;
  if (key === undefined) {
    throw new Error("idempotency key が無い（adapterDeliveryId も canonicalFingerprint も空）");
  }
  return key;
}

// --- §4.2 状態と revision ---------------------------------------------------

/**
 * 状態は lineage ごとに 1 つ（§4）。別 lineage の event を黙って取り込むと、境界の確定
 * （§2.2）を経ずに前の task の状態が書き換わる。lineage を持たない event は、還元先の
 * 状態が属する lineage のものとして扱う。
 *
 * Agent も同じ理由で束縛する。`CanonicalWorkStateV1.sourceAgent` は状態の持ち主で、
 * `OperationCorrelationV1` は Agent を持たない（scope は sessionId + taskLineageId だけ）。
 * intake の受領証束縛は event と受領証を結ぶだけなので、ここで結ばないと、別 Agent の
 * terminal が同じ session/lineage に居る他 Agent の operation を閉じられる。
 */
function assertSameScope(state: CanonicalWorkStateV1, event: NormalizedContinuityEvent): void {
  if (event.taskLineageId !== undefined && event.taskLineageId !== state.taskLineageId) {
    throw new Error(
      `別 lineage の event は適用しない: 状態 ${state.taskLineageId} / event ${event.taskLineageId}`,
    );
  }
  if (event.sourceAgent !== state.sourceAgent) {
    throw new Error(
      `別 Agent の event は適用しない: 状態 ${state.sourceAgent} / event ${event.sourceAgent}`,
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
  | "terminal_orphaned"
  | "terminal_ambiguous"
  | "terminal_conflict"
  | "terminal_out_of_order"
  | "terminal_order_unverifiable"
  | "terminal_already_applied"
  | "terminal_evidence_contradicts"
  | "duplicate_operation_start"
  | "start_conflict"
  | "pending_operations_evicted"
  | "source_events_truncated"
  | "turn_identity_downgraded";

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
    // revision ごとに配列を分ける。`CanonicalWorkStateV1.pendingOperations` は readonly でないので、
    // 共有すると新 revision への変更が過去の snapshot にも見える（§4.2 の immutable revision 違反）
    pendingOperations: [...pendingOperations],
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
  event: IntakeStampedEventV1,
  idempotencyLedger: IdempotencyLedger,
): TaskStateReductionResult {
  assertOperationEnvelope(event);
  assertTurnIdentity(event);
  assertIngestSeq(event.ingestSeq);
  assertSameScope(previous.state, event);
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
    // 台帳と状態がずれた状態で同じ start を再適用しても、同じ operation を二重に積まない。
    // 再配送は eventId が変わる（再送契約: 同じ adapterDeliveryId・違う eventId・違う ingestSeq）
    // ので導出した operationId は一致しない。台帳だけを失った復元では素通りして同じ operation が
    // 二重に積まれ、以後 rule 1 の terminal が候補 2 件で何も閉じられなくなる。
    // `nativeOperationId` は本物の呼び出しごとに一意なので、それが一致する pending があれば
    // 再配送として扱う（持たない start では 2 回目の本物の呼び出しと区別できないので触らない）
    const existing =
      previous.state.pendingOperations.find((pending) => pending.operationId === operationId) ??
      (operation.nativeOperationId === undefined
        ? undefined
        : previous.state.pendingOperations.find(
            (pending) =>
              pending.correlation.nativeOperationId === operation.nativeOperationId &&
              pending.correlation.sessionId === event.sessionId &&
              pending.correlation.taskLineageId === previous.state.taskLineageId,
          ));
    // 同じ nativeOperationId を名乗りながら identity が違う start は再配送ではなく corruption。
    // 再配送として台帳に入れると、訂正版が同じ配送 ID で来ても重複 no-op になって戻せない
    if (existing !== undefined && existing.correlation.operationMatchKey !== operation.operationMatchKey) {
      return quarantine(previous, idempotencyLedger, [
        {
          code: "start_conflict",
          eventId: event.eventId,
          detail: `operationId ${existing.operationId} と同じ nativeOperationId で operationMatchKey が違う`,
        },
      ]);
    }
    if (existing !== undefined) {
      return commit(previous, event, idempotencyLedger, {
        ...unchanged,
        diagnostics: [
          { code: "duplicate_operation_start", eventId: event.eventId, detail: `operationId ${existing.operationId} は既に pending` },
        ],
        // checkpoint から復元すると pendingOperations だけが戻り operationStarts は空になる（#35）。
        // 再配送された start で権威順序の材料を戻す。既にある分は上書きしない（後から来た
        // 再配送の ingestSeq で上書きすると、飛行中の terminal が順序違反に見える）
        operationStarts: previous.operationStarts.has(existing.operationId)
          ? previous.operationStarts
          : new Map(previous.operationStarts).set(existing.operationId, {
              ingestSeq: event.ingestSeq,
              turnIdSource: event.turnIdSource,
            }),
      });
    }
    const started = startPendingOperation(event, operation, operationId, previous.state.taskLineageId);
    const retained = retainPendingOperations(previous.state.pendingOperations);
    // 黙って間引かない。退避した operation の event 自体は event store に残るが、状態からは
    // 消えるので、どれを落としたかを診断に出す
    const kept = new Set(retained.map((pending) => pending.operationId));
    const evicted = previous.state.pendingOperations
      .filter((pending) => !kept.has(pending.operationId))
      .map((pending) => pending.operationId);
    // 退避した operation の start facts も落とす。残すと pendingOperations が 256 件で頭打ちの
    // 一方でこの表だけが単調増加する
    const operationStarts = new Map(previous.operationStarts);
    for (const evictedId of evicted) operationStarts.delete(evictedId);
    operationStarts.set(operationId, { ingestSeq: event.ingestSeq, turnIdSource: event.turnIdSource });
    return commit(previous, event, idempotencyLedger, {
      pendingOperations: [...retained, started],
      diagnostics:
        evicted.length === 0
          ? []
          : [
              {
                code: "pending_operations_evicted",
                eventId: event.eventId,
                detail: `上限 ${CONTINUITY_LIMITS.arrayItems} 件のため退避: ${evicted.join(", ")}`,
              },
            ],
      operationStarts,
    });
  }

  const correlation = correlateTerminalEvent(previous, event);
  if (correlation.matched === null) {
    const diagnostics = [
      { code: correlation.diagnostic, eventId: event.eventId, detail: correlation.detail },
    ];
    // 隔離するのは「状態に記録できる相手が居ない」場合だけにする。
    // - `terminal_conflict`: v6「same op ID + different hash: quarantine corruption」。台帳に
    //   入れると訂正された再配送が重複 no-op として黙って捨てられる
    // - `terminal_orphaned`: 候補が 1 件も無い。start より先に terminal が届く順序前後は正常運用
    //   （hook と transcript scan の取り込み順、再起動後の catch-up）なので、台帳に入れると
    //   後から start が届いても二度と閉じられない。隔離しておけば再配送で拾い直せる
    // 候補が居る分岐（unmatched / ambiguous / order_unverifiable）は下の commit で unknown に
    // 倒して台帳へ入れる。隔離すると operation が `started` のまま残り、状態が嘘をつく
    if (
      correlation.diagnostic === "terminal_conflict" ||
      correlation.diagnostic === "terminal_orphaned"
    ) {
      return quarantine(previous, idempotencyLedger, diagnostics);
    }
    // §4.3「zero or multiple にマッチした terminal は unmatched evidence として保ち、候補を
    // unknown のままにし、診断を出す」。status は unknown にするが pending には残すので、
    // 後から権威ある証跡（rule 1）が来れば閉じられる。証跡を足さないと、状態が変わった理由が
    // 状態からも history からも辿れない（放棄経路は足しているので扱いも揃わない）
    const unresolved = new Set(correlation.unresolvedOperationIds);
    const truncated = sourceEventsFull(previous.state.pendingOperations, unresolved);
    return commit(previous, event, idempotencyLedger, {
      pendingOperations: previous.state.pendingOperations.map((pending) =>
        unresolved.has(pending.operationId)
          ? withSourceEvent(
              pending.status === "started" ? { ...pending, status: "unknown" as const } : pending,
              event.eventId,
            )
          : pending,
      ),
      diagnostics: truncated.length === 0 ? diagnostics : [...diagnostics, truncationDiagnostic(event, truncated)],
    });
  }

  const matchedId = correlation.matched.operationId;
  // kind が失敗を宣言しているのに `successful: true` を名乗る terminal は自己矛盾している。
  // schema はどちらも valid なので通ってしまうが、これを `succeeded` にすると壊れた adapter が
  // 失敗を握り潰せる。§4.3「terminal の証跡が欠けている / 曖昧なときは unknown を確定する」に倒す
  const contradicts = event.kind === "tool_failed" && event.successful === true;
  // successful が無い terminal も成否を主張できないので unknown。
  const status =
    contradicts ? ("unknown" as const)
    : event.successful === true ? ("succeeded" as const)
    : event.successful === false ? ("failed" as const)
    : ("unknown" as const);
  const truncated = sourceEventsFull(previous.state.pendingOperations, new Set([matchedId]));
  const contradictionDiagnostics: ContinuityDiagnosticV1[] = contradicts
    ? [
        {
          code: "terminal_evidence_contradicts",
          eventId: event.eventId,
          detail: `kind ${event.kind} が successful: true を名乗っている`,
        },
      ]
    : [];
  return commit(previous, event, idempotencyLedger, {
    pendingOperations: previous.state.pendingOperations.map((pending) =>
      pending.operationId === matchedId
        ? withSourceEvent({ ...pending, status, terminalAt: event.occurredAt }, event.eventId)
        : pending,
    ),
    diagnostics:
      truncated.length === 0
        ? contradictionDiagnostics
        : [...contradictionDiagnostics, truncationDiagnostic(event, truncated)],
  });
}

function truncationDiagnostic(
  event: NormalizedContinuityEvent,
  operationIds: readonly string[],
): ContinuityDiagnosticV1 {
  return {
    code: "source_events_truncated",
    eventId: event.eventId,
    detail: `sourceEventIds が上限 ${CONTINUITY_LIMITS.arrayItems} 件で、この event を記録できない operation: ${operationIds.join(", ")}`,
  };
}

/**
 * frozen schema は `pendingOperations` を 256 件（§10 の `arrayItems`）に制限しているのに、
 * addendum には保持方針が無い（#39）。上限に達したら、失って影響の小さい順に古いものから
 * 落として新しい start の場所を空ける。
 *
 * 「落とせるものが無ければ取り込まない」にはできない。`unknown` を消す経路が他に無いので、
 * 枠が `started` / `unknown` で埋まると以後すべての start が入らなくなり、訂正版の存在しない
 * 隔離を adapter が永久に再送し続ける（回復経路が無い）。落とした事実は診断に出す。
 * 状態は projection で、daemon 側には event store がある（§6.4 が acceptance transaction の
 * 中でそれを再照会する）が、event の保持期間そのものは addendum に無い（#39）。
 */
const EVICTION_ORDER: readonly PendingOperation["status"][] = [
  "succeeded",
  "failed",
  "unknown",
  "started",
];

function retainPendingOperations(pending: PendingOperation[]): PendingOperation[] {
  if (pending.length < CONTINUITY_LIMITS.arrayItems) return pending;
  const dropCount = pending.length - CONTINUITY_LIMITS.arrayItems + 1;
  const dropped = new Set<string>();
  for (const status of EVICTION_ORDER) {
    for (const candidate of pending) {
      if (dropped.size === dropCount) break;
      if (candidate.status === status) dropped.add(candidate.operationId);
    }
  }
  return pending.filter((candidate) => !dropped.has(candidate.operationId));
}

/**
 * frozen schema は `sourceEventIds` も 256 件（§10 の `arrayItems`）に制限する。projection は
 * 上限で頭打ちにし、超えた分は状態に載せない（記録できなかった事実は診断に出す）。上限を見ずに append すると、
 * 同じ operation に届き続ける terminal で還元器自身が schema 違反の状態を出す。
 */
function withSourceEvent(pending: PendingOperation, eventId: string): PendingOperation {
  if (pending.sourceEventIds.includes(eventId)) return pending;
  if (pending.sourceEventIds.length >= CONTINUITY_LIMITS.arrayItems) return pending;
  return { ...pending, sourceEventIds: [...pending.sourceEventIds, eventId] };
}

function sourceEventsFull(pending: readonly PendingOperation[], ids: ReadonlySet<string>): string[] {
  return pending
    .filter((candidate) => ids.has(candidate.operationId))
    .filter((candidate) => candidate.sourceEventIds.length >= CONTINUITY_LIMITS.arrayItems)
    .map((candidate) => candidate.operationId);
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
    // 分類器が正本に無い間、内容を見ずに normal と申告しない（#36）。
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

  // rule 1 を名乗った terminal は rule 1 だけで判定する。§4.3 の matchKey は nativeOperationId を
  // 含むので、正しく導出された matchKey なら rule 2 でも一致しない。導出は wire 越しには
  // 検証できないので、「native id はあるが一致しない」を「native id が無い」と同じに扱わない
  const candidates =
    operation.nativeOperationId !== undefined
      ? byNativeId
      : sameScope.filter(
          (pending) =>
            pending.correlation.operationMatchKey === operation.operationMatchKey &&
            pending.correlation.toolName === operation.operationKind,
        );
  const rule = byNativeId.length > 0 ? "native_operation_id" : "match_key";

  const open = candidates.filter((pending) => pending.status === "started" || pending.status === "unknown");
  // §4.3「候補を unknown のままにする」。候補が無い分岐では unknown にする相手も無い
  const openIds = open.map((pending) => pending.operationId);

  // 候補が 1 件も無い terminal は「候補はあるが閉じられない」とは別物なので別の code にする。
  // 前者は状態に書ける相手が居ないので隔離、後者は候補を unknown にして台帳へ入れる
  if (candidates.length === 0) {
    return {
      matched: null,
      diagnostic: "terminal_orphaned",
      detail:
        operation.nativeOperationId === undefined
          ? "一致する operation が無い"
          : `nativeOperationId ${operation.nativeOperationId} に一致する operation が無い`,
      unresolvedOperationIds: [],
    };
  }
  // 衝突検査はすべての早期 return より前に置く。後ろに置くと「terminal 済み」「順序不明」で
  // 先に return してしまい、corrupt な event が隔離されずに台帳へ入って、訂正版の再配送が
  // 重複 no-op として黙って捨てられる。
  // §4.3「operationMatchKey は Agent・session・lineage・turn・kind・native operation ID・
  // canonical input hash に対する schema-versioned SHA-256」。rule 2 の候補は matchKey 一致で
  // 選んでいるので、これが効くのは rule 1（nativeOperationId だけで選ぶ）の候補
  const conflicting = candidates.find(
    (pending) =>
      pending.correlation.operationMatchKey !== operation.operationMatchKey ||
      // matchKey の導出が §4.3 どおりでない adapter に備えて input hash も直接見る
      (pending.correlation.canonicalInputHash !== undefined &&
        operation.canonicalInputHash !== undefined &&
        pending.correlation.canonicalInputHash !== operation.canonicalInputHash),
  );
  if (conflicting !== undefined) {
    return {
      matched: null,
      diagnostic: "terminal_conflict",
      detail: `operation ${conflicting.operationId} と identity が衝突`,
      // 隔離は状態を一切変えないので、候補も unknown にしない
      unresolvedOperationIds: [],
    };
  }
  if (open.length === 0) {
    return {
      matched: null,
      diagnostic: "terminal_already_applied",
      detail: "候補はすべて terminal 済み",
      unresolvedOperationIds: [],
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
      unresolvedOperationIds: openIds,
    };
  }
  if (eligible.length > 1) {
    return {
      matched: null,
      diagnostic: "terminal_ambiguous",
      detail: `open な候補が ${eligible.length} 件`,
      unresolvedOperationIds: eligible.map((pending) => pending.operationId),
    };
  }
  const matched = eligible[0] as PendingOperation;

  const start = previous.operationStarts.get(matched.operationId);
  if (start === undefined) {
    // start の ingestSeq が状態に無い（checkpoint から復元した等: #35）。順序を確認できない
    // ので閉じることはできないが、隔離してはいけない: 復元直後は全 terminal がこの分岐に
    // 落ちるため、隔離すると operation が `started` のまま二度と閉じられず、resume capsule が
    // 「まだ実行中」と偽る。§3.1 の fail closed（自動経路を降格し理由を doctor に出す）どおり
    // 候補を unknown に倒して台帳へ入れる
    return {
      matched: null,
      diagnostic: "terminal_order_unverifiable",
      detail: `operation ${matched.operationId} の start が状態に無く、権威順序を確認できない`,
      unresolvedOperationIds: [matched.operationId],
    };
  }
  if (compareIngestSeq(terminalEvent.ingestSeq, start.ingestSeq) <= 0) {
    return {
      matched: null,
      diagnostic: "terminal_out_of_order",
      detail: "terminal が start より後でない",
      // 一致した 1 件だけが unknown。同じ matchKey の無関係な open を巻き込まない
      unresolvedOperationIds: [matched.operationId],
    };
  }
  return { matched, rule };
}

// --- §4.3 abandonment -------------------------------------------------------

export interface AbandonmentResultV1 {
  outcome: "applied" | "duplicate";
  state: CanonicalWorkStateV1;
  ledger: IdempotencyLedger;
}

/**
 * §4.3「terminal の証跡が無い、または曖昧なまま放棄・復帰したときは unknown を確定する」。
 * 状態は不変なので、新しい revision を持つ別の状態を返す。
 *
 * §4.2 の「重複した論理 event は no-op」はこの経路にも掛かる。台帳を見ずに revision を採番すると、
 * 同じ放棄 event の再配送のたびに stateRevision が変わり、それを CAS token として使う下流
 * （checkpointRevision / expectedProjectionRevision / claimFence）が空振りする。
 */
export function finalizeAbandonedState(
  state: CanonicalWorkStateV1,
  event: IntakeStampedEventV1,
  idempotencyLedger: IdempotencyLedger,
): AbandonmentResultV1 {
  assertOperationEnvelope(event);
  assertTurnIdentity(event);
  assertIngestSeq(event.ingestSeq);
  assertSameScope(state, event);
  const key = idempotencyKeyOf(event);
  if (idempotencyLedger.has(key)) {
    return { outcome: "duplicate", state, ledger: idempotencyLedger };
  }
  // 放棄するのはその event の session の operation だけ。lineage は session をまたいで続く
  // （§5 の checkpoint は `sourceSessionId` と `taskLineageId` を別に持つ）ので、session を見ないと
  // 遅れて届いた旧 session の session_ended が、resume 先の live な operation まで unknown にする
  const pendingOperations = state.pendingOperations.map((pending) =>
    pending.status === "started" && pending.correlation.sessionId === event.sessionId
      ? withSourceEvent({ ...pending, status: "unknown" as const }, event.eventId)
      : pending,
  );
  const content = nextContent(state, event, pendingOperations);
  const next = {
    ...content,
    stateRevision: deriveRevision(state.stateRevision, event.eventId, contentHashOf(content)),
  };
  return {
    outcome: "applied",
    state: next,
    ledger: new Map(idempotencyLedger).set(key, event.eventId),
  };
}
