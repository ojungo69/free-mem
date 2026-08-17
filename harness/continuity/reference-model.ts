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
  TURN_ID_SOURCES,
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
  // 認証済み peer と違う Agent を名乗る event は、降格ではなく**受け取らない**。§3.1 は検査に
  // 落ちた event を `synthesized` へ降格せよと言うが、それは証跡の質の話で、`sourceAgent` は
  // 質ではなく **scope selector** として使われる（`assertSameScope` が「どの状態を書き換えて
  // よいか」をこの値の等値で決める）。降格しても値そのものは残るので、peer=codex として
  // 認証された event が `sourceAgent: "claude"` を名乗ると、`synthesized` の札を貼られたまま
  // claude の operation を診断ゼロで閉じられる（実測）。correlation は `evidenceKind` を一度も
  // 読まないので、札は何も束縛しない。空白の `sourceAgent` を還元器が落とすのと同じ形で、
  // 他人の名前はそれより悪い（空白は「誰も名乗っていない」、他人の名前は「scope が矛盾する」）。
  // 認証できない経路（`expectedSourceAgent` が空）は従来どおり降格で扱う。intake は台帳より
  // 前なので、throw しても配送鍵は消費されず、訂正版の再送はそのまま効く
  if (!isBlank(context.expectedSourceAgent) && event.sourceAgent !== context.expectedSourceAgent) {
    throw new Error(
      `§3.1 違反: 認証済み peer は ${context.expectedSourceAgent} なのに event が ${JSON.stringify(event.sourceAgent)} を名乗っている`,
    );
  }
  // caller の attestation は読まずに捨てる。読んだ時点で「認証済みだと名乗れる」ことになり、
  // §3.1 が禁じている自己申告の native authority が通ってしまう
  const { ingestAttestation: _claimed, ...provenance } = event.provenance;
  const attestation = context.attestation;
  // §3.1 は evidenceKind も turn identity も「認証済み peer identity」から導けと言う。
  // 受領証があり、かつ caller の名乗る Agent と version が受領証の指すそれと一致することが
  // その認証にあたる。evidence の証明も turn の証明もこの束縛の上に乗る
  const authenticatedVersion =
    attestation !== undefined &&
    // §3.1 は受領証を「その認証済み取り込みの receipt」と定義し、evidenceKind を「認証済み
    // peer identity」から導けと言う。受領証が在ることと、それが peer を指していることは別で、
    // 認証できない経路を `undefined` ではなく欄が空の受領証で表す daemon では、存在だけを
    // 見ると「誰も名乗っていない受領証」が native authority の根拠になってしまう
    !isBlank(attestation.ingestReceiptId) &&
    !isBlank(attestation.peerIdentityId) &&
    // 空文字同士は「一致」ではなく「どちらも名乗っていない」。素通りさせない
    // 「未設定」の表し方は空文字とは限らない。identity 材料と同じ理由（`isBlank`）で、
    // 空白 1 文字・タブ・U+200B で「無い」を表す daemon でも同じ実害が起きる
    !isBlank(context.expectedSourceAgent) &&
    !isBlank(context.exactAgentVersion) &&
    // `event.sourceAgent === context.expectedSourceAgent` はここには書かない。上の throw が
    // 「`expectedSourceAgent` が非空なら等値」を保証済みで、この行は到達時点で必ず true になる。
    // 証明済みに死んだ条件を authority 述語に残すと、検査が行われているように読めてしまう
    provenance.sourceAgentVersion === context.exactAgentVersion;
  const proven =
    authenticatedVersion &&
    // 空同士は「一致」ではない。capability matrix が未整備の daemon（activeCapabilityHash が
    // 空）で、caller も同じ空を名乗ると native が成立してしまう。§3.1 は proven を「active
    // exact-version capability matrix hash と等しいこと」と定義しているので、matrix が無いなら
    // proven も無い
    !isBlank(context.activeCapabilityHash) &&
    provenance.capabilityHash === context.activeCapabilityHash &&
    provenance.scenarioId !== undefined &&
    // §3.1 は `scenarioId` が scenario を「naming」していることを要求する。空白は何も
    // 名指していないので、matrix 側の空白 entry と等しくなっても proven の根拠にならない。
    // caller 側を非空白に固定すれば、matrix 側が空白の entry は等値にならないので片側で足りる
    !isBlank(provenance.scenarioId) &&
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
  const operation = event.operation;
  if (expectedPhase === undefined) {
    if (operation !== undefined && NON_OPERATION_KIND_SET.has(event.kind)) {
      throw new Error(`§3.1 違反: operation 系でない kind ${event.kind} が operation envelope を持つ`);
    }
    // adapter 固有の kind は既知の phase を持たないので phase の照合はできないが、envelope を
    // 持つなら reducer の operation 経路（start / terminal）にそのまま入る。欄の検査を飛ばすと
    // 空文字の nativeOperationId が rule 1 の照合権威として扱われ、無関係な custom operation
    // 同士が同一視される
    if (operation !== undefined) {
      assertOperationFields(operation);
    }
    return;
  }
  if (operation === undefined) {
    throw new Error(`§3.1 違反: operation event ${event.kind} に operation envelope が無い`);
  }
  if (operation.phase !== expectedPhase) {
    throw new Error(
      `§3.1 違反: kind ${event.kind} の phase は ${expectedPhase} だが envelope は ${operation.phase}`,
    );
  }
  assertOperationFields(operation);
}

/**
 * identity の材料として「値が無い」と同じもの。schema は `maxLength` しか課さないので、空文字と
 * 同じ実害が空白 1 文字・タブ・U+FEFF・U+200B でもそのまま起きる（identity が潰れる／「値がある」と
 * 読まれる）。`unavailable` を空文字で表す adapter は、同じ理由で空白でも表す。
 * `\s` は U+FEFF まで含むが U+200B 等の書式制御文字は含まないので `\p{Cf}` を足す。
 */
function isBlank(value: string): boolean {
  return /^[\s\p{Cf}]*$/u.test(value);
}

/**
 * `IsoTimestamp` の pattern は成分の範囲（月 01-12・日 01-31・秒 00-59・`Z` 固定）までしか
 * 書けず、**暦としての実在**は表せない。`2026-02-30T00:00:00Z` も `2027-02-29T00:00:00Z` も
 * 通り、`new Date()` は例外を投げずに翌月へ繰り上げる（#27）。
 *
 * 繰り上がった値は状態の `updatedAt` / `startedAt` / `terminalAt` にそのまま載るので、
 * 下流が `new Date()` で読んだ瞬間に**申告と別の時刻**になる。lease や expiry の判断に
 * そのまま入る欄なので、綴りとして受理した以上は指す瞬間も一意でなければならない。
 *
 * `toISOString()` と秒までを突き合わせるのは、繰り上がりが必ず綴りを変えるため。小数秒は
 * 桁数が固定されていない（`(\.\d+)?`）ので比較対象から外す。
 */
function isRealInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value.slice(0, 19));
}

function assertOperationFields(operation: NonNullable<NormalizedContinuityEvent["operation"]>): void {
  if (isBlank(operation.operationMatchKey) || isBlank(operation.operationKind)) {
    throw new Error(`§3.1 違反: operation envelope の operationMatchKey / operationKind が空`);
  }
  // schema は任意欄に maxLength しか持たないので空文字が届きうる。空文字を「値がある」と読むと
  // rule 1 が「native ID を持たない operation」同士を全部同じものとして照合してしまう。正規化を
  // 照合側に散らさず、ここで落とす（`undefined` を送れば「無い」と正しく扱われる）
  if (
    (operation.nativeOperationId !== undefined && isBlank(operation.nativeOperationId)) ||
    (operation.canonicalInputHash !== undefined && isBlank(operation.canonicalInputHash))
  ) {
    throw new Error(`§3.1 違反: operation envelope の nativeOperationId / canonicalInputHash が空文字`);
  }
}

/**
 * identity の材料になる欄は schema の `required` に入っていても `maxLength` しか制約が無いので
 * 空文字が届きうる。空文字を「値がある」と読むと、別々の event が同じ identity に潰れる。
 *
 * `canonicalFingerprint`: v6 §8.2 の dedupe authority は「`adapterDeliveryId`、無ければ canonical
 * fingerprint」なので、空文字だと 2 通りに壊れる。
 *
 * - 配送 ID を持たない event が全部 `f:` という 1 つの鍵に潰れ、最初の 1 件以外が診断ゼロで消える
 * - 配送 ID を持つ event は台帳に source hash 無しで載り、同じ配送 ID の訂正版が衝突検査を
 *   素通りして重複として捨てられる（訂正が永久に届かない）
 *
 * `eventId`: `deriveOperationId(eventId, matchKey)` の材料なので、空文字だと同じ turn の
 * rule 2 の start が 2 件とも同じ operationId になり、2 件目が `duplicate_operation_start` として
 * 消える（以後その operation の terminal は照合できない）。
 *
 * `sessionId`: §4.3 の候補選びと §4.3 の放棄はどちらも session で絞る。空文字だと、session を
 * 特定できない adapter の event が全部同じ scope に入り、別 session の terminal が診断ゼロで
 * operation を閉じ、別 session の `session_ended` がそれを放棄する（実 ID なら
 * `terminal_orphaned` で隔離される）。`turnId` と違って「不在」を表す語彙が無いので落とすしかない。
 *
 * 空文字の `adapterDeliveryId` を「無い」として fingerprint へ落とすのと違い、どちらも落とし先が
 * 無いので schema violation にする。
 *
 * `occurredAt` の暦検査（#27）もここに置く。3 つの入口（還元器・terminal 相関・放棄の確定）が
 * 揃って呼ぶのはこの関数だけなので、別の入口で呼び忘れる形にならない。
 */
function assertIdentityMaterial(event: NormalizedContinuityEvent): void {
  if (isBlank(event.canonicalFingerprint)) {
    throw new Error("§3.1 違反: canonicalFingerprint が空文字（dedupe authority が定まらない）");
  }
  if (isBlank(event.eventId)) {
    throw new Error("§3.1 違反: eventId が空文字（operation identity が導出できない）");
  }
  if (isBlank(event.sessionId)) {
    throw new Error("§3.1 違反: sessionId が空文字（session scope が定まらない）");
  }
  // `assertSameScope` は `event.sourceAgent === state.sourceAgent` の等値しか見ない。凍結 schema は
  // event 側にも状態側にも `maxLength` しか課さないので、Agent 同一性を「不明」として空白で表す
  // adapter が 2 つあると、互いの状態を同じ scope として書き換えられる（空白同士は「同じ Agent」
  // ではなく「どちらも名乗っていない」）。intake の降格は evidenceKind を落とすだけで scope は
  // 縛らないので、ここで落とさないと誰も落とさない
  if (isBlank(event.sourceAgent)) {
    throw new Error("§3.1 違反: sourceAgent が空文字（Agent scope が定まらない）");
  }
  if (!isRealInstant(event.occurredAt)) {
    throw new Error(`§22.6 違反: occurredAt が暦として実在しない: ${event.occurredAt}`);
  }
}

/**
 * §3.1「`turnId` は `turnIdSource` が native / synthesized_monotonic のとき必須、
 * unavailable のとき不在」。turn 有無で振る舞いが変わる規則（§4.3 の rule 2）が
 * turnId の有無を根拠にできるよう、ここで不変条件を確定させる。
 */
export function assertTurnIdentity(event: NormalizedContinuityEvent): void {
  // **語彙そのものを先に確かめる**。`TurnIdSource` の語彙は凍結 schema にしかなく、参照模型は
  // event が schema 検証を通ってから届くとは限らない（intake も還元器も生の値を読む）。語彙外の
  // 綴りは `unavailable` の分岐にも intake の `native` 証明要求にも当たらないので、**降格を
  // 丸ごと迂回して自称 `turnId` を保持できた**（実測: `"Native"` / `"NATIVE"` / 末尾空白の
  // `"native "` / キリル а の同形異字 / `"bogus"` がいずれも診断ゼロで通り、`turnId` は
  // `"turn-FORGED"` のまま残った）。そのまま §4.3 rule 2 に入ると、`sameTurnOf` は `turnId` の
  // 等値、`eligibleOf` は記録と event の**自己一致**で通るので、捏造した turn 同一性で turn scope が
  // まるごと成立する。空白の identity 材料と同じ扱いで、語彙外はここで落とす
  if (!(TURN_ID_SOURCES as readonly string[]).includes(event.turnIdSource)) {
    throw new Error(
      `§3.1 違反: turnIdSource が語彙外: ${JSON.stringify(event.turnIdSource)}`,
    );
  }
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
  // schema は `turnId` に maxLength しか課さないので空文字が届きうる。空文字を「turn がある」と
  // 読むと、§4.3 rule 2 の turn 同一性が空文字同士で成立して無関係な turn の operation を閉じる。
  // すべての unavailable な turn を空文字で表す adapter では、全 operation が 1 つの turn に潰れる
  if (event.turnId !== undefined && isBlank(event.turnId)) {
    throw new Error(
      `§3.1 違反: turnIdSource が ${event.turnIdSource} なのに turnId が空文字（unavailable として送る）`,
    );
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
  const delivery =
    event.adapterDeliveryId !== undefined && isBlank(event.adapterDeliveryId)
      ? undefined
      : event.adapterDeliveryId;
  const fingerprint = isBlank(event.canonicalFingerprint) ? undefined : event.canonicalFingerprint;
  const key = delivery ?? fingerprint;
  if (key === undefined) {
    throw new Error("idempotency key が無い（adapterDeliveryId も canonicalFingerprint も空）");
  }
  return key;
}

/**
 * 台帳の鍵。v6 §8.2 の導出式は adapterDeliveryId と fingerprint を同じ keyspace に置くので、
 * `adapterDeliveryId` に他 event の `canonicalFingerprint` を書いた event を先に送ると、本物の
 * event が診断ゼロの重複として消える（`adapterDeliveryId` は adapter が自由に採番する値）。
 * wire に出る導出式は正本のままにして、台帳の中だけ authority を分ける。
 *
 * **`idempotencyKeyOf` ではなくこちらが台帳の鍵**なので export する。`IdempotencyLedger` は
 * caller が渡して caller に返る = 構築・永続化・復元は caller の責務なのに、公開していたのは
 * 接頭辞の無い `idempotencyKeyOf` だけだった。公開関数で台帳を組み立て直した daemon は全 entry で
 * 還元器と食い違い、重複判定が一度も発火しないまま再配送が新規 event として適用される（実測:
 * 還元器が引くのは `"d:delivery-start"`、公開関数が返すのは `"delivery-start"`）。`d:`/`f:` の
 * 分割は wire にも hash にも出ない内部詳細なので、caller が自力で再現しようと思う類の知識ではない。
 */
export function ledgerKeyOf(event: NormalizedContinuityEvent): string {
  const key = idempotencyKeyOf(event);
  return event.adapterDeliveryId === undefined || isBlank(event.adapterDeliveryId)
    ? `f:${key}`
    : `d:${key}`;
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
  // `sourceAgent` と同じ理由で空白を落とす（`assertIdentityMaterial` 参照）。凍結 schema は
  // `taskLineageId` にも `maxLength` しか課さないので、lineage が空白の状態と lineage を省いた
  // event が組み合わさると下の等値検査を素通りする（`undefined !== ""` の比較に到達しない）。
  // 素通りすると無関係な task の operation が同じ scope に潰れ、terminal が他人の operation を
  // 閉じ、`session_ended` がそれを放棄できる。`turnId` と違って lineage には「不在」を表す
  // 語彙が無いので、空白は「名乗っていない」であって「同じ lineage」ではない。
  if (isBlank(state.taskLineageId)) {
    throw new Error("§3.1 違反: 状態の taskLineageId が空文字（lineage scope が定まらない）");
  }
  if (event.taskLineageId !== undefined && isBlank(event.taskLineageId)) {
    throw new Error("§3.1 違反: event の taskLineageId が空文字（lineage scope が定まらない）");
  }
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

/**
 * 適用済み idempotency key → 最初に適用した eventId と、その event の source hash。
 * §4.3「terminal は … payload/source hash が衝突しないこと」を dedupe の時点で見るために
 * source hash を持つ。持たないと、同じ配送 ID で内容が違う event が correlation へ届く前に
 * `duplicate` として黙って捨てられ、衝突検査そのものが到達不能になる。
 */
export type IdempotencyLedger = ReadonlyMap<string, LedgerEntryV1>;

export interface LedgerEntryV1 {
  eventId: string;
  /** `canonicalFingerprint`（v6 §8.2 の source hash）。空文字は「無い」として扱う。 */
  sourceHash?: string;
}

function sourceHashOf(event: NormalizedContinuityEvent): string | undefined {
  return isBlank(event.canonicalFingerprint) ? undefined : event.canonicalFingerprint;
}

function ledgerEntryOf(event: NormalizedContinuityEvent): LedgerEntryV1 {
  const sourceHash = sourceHashOf(event);
  return { eventId: event.eventId, ...(sourceHash !== undefined ? { sourceHash } : {}) };
}

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
  | "terminal_identity_unverifiable"
  | "terminal_already_applied"
  | "terminal_evidence_contradicts"
  | "duplicate_operation_start"
  | "start_conflict"
  | "delivery_conflict"
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
function rankOfSensitivity(value: string): number {
  // 未知の語彙を indexOf の -1 のまま流すと最下位（normal）に落ちる = fail open。
  // §10 の語彙外は「機密度不明」なので最上位に倒す
  const known = SENSITIVITIES.indexOf(value as Sensitivity);
  return known < 0 ? SENSITIVITIES.length - 1 : known;
}

/**
 * §10「`sensitivity` は構成要素 event の最大機密度を常に反映する」。`floor` には直前の revision の
 * 集約値を渡す。集約値を実体に持たせる理由が「raw event の TTL 後には遡って判定できない」こと
 * なので、構成要素が状態から消えても機密度は下げない（`retainPendingOperations` の退避は
 * 保管上の都合であって「機密ではなくなった」という証跡ではない）。この模型に格下げの event は
 * 無いので、単調非減少にして §9.2 の remote 送信ゲートを fail closed に保つ。
 */
function aggregateSensitivity(
  content: Omit<WorkStateContentV1, "sensitivity">,
  floor: Sensitivity,
): Sensitivity {
  let rank = rankOfSensitivity(floor);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "sensitivity" && typeof child === "string") {
        rank = Math.max(rank, rankOfSensitivity(child));
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
  return {
    ...withoutSensitivity,
    sensitivity: aggregateSensitivity(withoutSensitivity, previous.sensitivity),
  };
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
  nextLedger.set(ledgerKeyOf(event), ledgerEntryOf(event));
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
  assertIdentityMaterial(event);
  assertIngestSeq(event.ingestSeq);
  assertSameScope(previous.state, event);
  // 放棄の kind をこの入口に渡すと、operation envelope を持たないので下の汎用 commit に落ちて
  // 状態を何も変えないまま台帳の鍵だけを消費する。その台帳を渡された finalizeAbandonedState は
  // 重複として捨てるので、放棄が永久に適用されず operation が `started` のまま残る。
  // finalizeAbandonedState が逆向きに張っているガードと対称にして、経路の取り違えを落とす
  if (ABANDONMENT_EVENT_KINDS.has(event.kind)) {
    throw new Error(`放棄を確定する kind は finalizeAbandonedState に渡す: ${event.kind}`);
  }
  const key = ledgerKeyOf(event);

  const applied = idempotencyLedger.get(key);
  if (applied !== undefined) {
    // §4.3「terminal は … payload/source hash が衝突しないこと」。同じ配送 ID で内容が違う
    // event は再送ではなく corruption なので、重複として黙って捨てずに隔離する（捨てると
    // 衝突検査が到達不能になり、訂正版の再配送も同じ鍵で消える）。source hash がどちらかに
    // 無いときは比較材料が無いので再送として扱う
    const incoming = sourceHashOf(event);
    if (applied.sourceHash !== undefined && incoming !== undefined && applied.sourceHash !== incoming) {
      return quarantine(previous, idempotencyLedger, [
        {
          code: "delivery_conflict",
          eventId: event.eventId,
          detail: `event ${applied.eventId} と同じ配送 ID で source hash が違う`,
        },
      ]);
    }
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
    // **再配送の相手を探す集合は lineage で絞る**。状態は lineage を 1 つしか持たず、`assertSameScope`
    // が束縛するのも lineage と Agent なので、`correlation.taskLineageId` が違う pending はこの状態の
    // scope に無い。凍結 schema は `correlation.taskLineageId` と `state.taskLineageId` の一致を課さない
    // ので、復元した checkpoint や別実装が書いた状態では別 lineage の pending が schema 妥当なまま並ぶ。
    // `nativeMatches` は最初から lineage で絞っていたのに derived id の検索だけ素通しで、そこに同じ
    // derived id（= 同じ eventId・同じ matchKey）の別 lineage の pending が居ると、**現 lineage 宛ての
    // start が重複として台帳に入り、現 lineage には operation が 1 件も残らない**（実測: 状態 lineage-1 /
    // pending lineage-OTHER で `applied` + `duplicate_operation_start`、鍵は消費済み、pending は
    // 別 lineage の 1 件のみ）。scope 外を「再配送の相手」として使わない
    const inLineage = previous.state.pendingOperations.filter(
      (pending) => pending.correlation.taskLineageId === previous.state.taskLineageId,
    );
    const nativeMatches =
      operation.nativeOperationId === undefined
        ? []
        : inLineage.filter(
            (pending) =>
              pending.correlation.nativeOperationId === operation.nativeOperationId &&
              pending.correlation.sessionId === event.sessionId,
          );
    // 同じ nativeOperationId を名乗りながら identity が違う start は再配送ではなく corruption。
    // 再配送として台帳に入れると、訂正版が同じ配送 ID で来ても重複 no-op になって戻せない。
    // terminal 側と同じく input hash も直接見る（matchKey の導出が §4.3 どおりでない adapter 対策）
    const startConflictsWith = (existing: PendingOperation): boolean => {
      const recordedSource = startFactsFor(previous, existing.operationId)?.turnIdSource;
      return (
        existing.correlation.operationMatchKey !== operation.operationMatchKey ||
          // 上の検索が operationId 一致（eventId + matchKey から導出）で当たった場合、session は
          // 一度も比べていない。`assertSameScope` は lineage と Agent しか束縛せず、状態は session を
          // 持たない（lineage は session をまたぐ）ので、ここで比べないと誰も比べない。
          // §4.3 の候補選びと放棄はどちらも `correlation.sessionId` で絞るので、別 session を
          // 名乗る再配送を重複として台帳に入れると、その operation は記録された旧 session でしか
          // 閉じられないまま訂正版も no-op になる。`sessionId` は `OperationCorrelationV1` の
          // required なので、任意欄と違って両方 present ガードは要らない
          existing.correlation.sessionId !== event.sessionId ||
          // turn も同じ理由で誰も比べていない。§4.3 は matchKey の入力に「turn when present」を
          // 含むので、正しく導出された matchKey なら turn が違えば上の比較で落ちるが、導出は
          // wire 越しに検証できない。記録された turn は rule 2 の候補選び（`eligible`）が使うので、
          // 古い turn のまま重複として台帳に入れると、その operation は本来の turn の terminal で
          // 閉じられず `terminal_unmatched` で `unknown` に倒れる。`turnId` は
          // `OperationCorrelationV1` の required に無く、`turnIdSource: unavailable` では正当に
          // 不在なので、兄弟の任意欄と同じく両方 present のときだけ比べる
          (existing.correlation.turnId !== undefined &&
            event.turnId !== undefined &&
            existing.correlation.turnId !== event.turnId) ||
          // `turnIdSource` は `turnId` と対になる turn 同一性の一部なのに、凍結
          // `OperationCorrelationV1` の外（`operationStarts`・#35）にしか無いので、上の `turnId` の
          // 比較では見えない。種別だけ違う再配送を重複として台帳に入れると、記録は元の種別のまま
          // 残る（再配送された start で `operationStarts` は埋めない）ので、再配送側の種別で来た
          // terminal は rule 2 の候補選び（`eligibleOf`）で落ちて `terminal_unmatched` になり、
          // **健全な証跡が `unknown` に倒れたうえに配送鍵まで消費済み**になる。復元直後は記録が
          // 無いので、`eligibleOf` と同じく材料があるときだけ比べる。**矛盾と言えるのは双方が
          // 具体的な turn 同一性を主張している場合だけ**にする: `unavailable` は「turn 同一性を
          // 主張していない」という表明で、§4.3 もどちらかが `unavailable` なら rule 2 を適用しないと
          // 言うだけで矛盾とは言わない。片側でも `unavailable` を衝突にすると、intake が降格した
          // start（proven でない version の native 主張はここへ落ちる）と、証明が回復した後の
          // 同じ start の再配送とが噛み合わず、**還元器は純関数なので毎回同じ隔離になる
          // = 決定論的な永久隔離と無限再送**になる（`started` を矛盾集合から外した理由と同型）。
          // 免除しても記録は汚れない: 再配送は `operationStarts` を書かないので、記録された種別は
          // どちらの経路でも元のまま残る。塞ぐのは種別の**すり替え**（native ⇄
          // synthesized_monotonic）だけで、そこは 2 つの具体的な主張が食い違っている
          (recordedSource !== undefined &&
            recordedSource !== "unavailable" &&
            event.turnIdSource !== "unavailable" &&
            recordedSource !== event.turnIdSource) ||
          // rule 2 の候補選びが kind の一致を見るのと対称。kind だけ違う再配送を重複として
          // 台帳に入れると、訂正版が同じ配送 ID で来ても no-op になって戻せない。
          // `toolName` は凍結 schema の required に無いので、checkpoint から復元した状態や
          // 別実装が書いた状態では schema 妥当なまま欠けうる。素で比べると健全な再配送が
          // 永久に隔離されるので、兄弟の 2 つと同じく両方 present のときだけ比べる
          (existing.correlation.toolName !== undefined &&
            existing.correlation.toolName !== operation.operationKind) ||
          // 上の検索が operationId 一致で当たった場合、nativeOperationId は一度も比べていない。
          // 同じ eventId・matchKey で native ID だけ違う start を重複として台帳に入れると、
          // 同じく訂正版を戻せなくなる（native ID 一致で当たった場合はここは常に等しい）
          (existing.correlation.nativeOperationId !== undefined &&
            operation.nativeOperationId !== undefined &&
            existing.correlation.nativeOperationId !== operation.nativeOperationId) ||
          (existing.correlation.canonicalInputHash !== undefined &&
            operation.canonicalInputHash !== undefined &&
            existing.correlation.canonicalInputHash !== operation.canonicalInputHash)
      );
    };
    // 同じ native id の兄弟が並ぶとき、先頭 1 件だけを見ると、**その先頭が衝突しているせいで
    // identity が完全に一致する兄弟への健全な再配送が永久に隔離される**（実測: matchKey も
    // input hash も一致する op-2 宛ての再配送が、op-1 と比べられて start_conflict になった）。
    // 互換な兄弟が居るならそれを再配送の相手にし、居ないときだけ先頭を衝突の証拠に使う
    // **同じ選び方を derived id の兄弟にも適用する**。片方の枝（native id）だけ互換な兄弟を
    // 優先していたので、`operationId` が衝突する状態では**配列順で結果が変わっていた**
    // （実測: 衝突する兄弟が先頭なら `start_conflict`、互換な兄弟が先頭なら
    // `duplicate_operation_start`）。隔離は鍵を消費せず還元器は純関数なので、前者は同じ再配送が
    // 永久に収束しない。選ぶ側を 1 箇所直したらもう 1 箇所の選ぶ側が残っていた形
    const idMatches = inLineage.filter((pending) => pending.operationId === operationId);
    const preferCompatible = (candidates: readonly PendingOperation[]): PendingOperation | undefined =>
      candidates.find((pending) => !startConflictsWith(pending)) ?? candidates[0];
    // **2 つの集合をまたいで選ぶ**。集合ごとに `preferCompatible` を掛けて `??` で繋ぐと、
    // `preferCompatible` は非空配列に必ず値を返す（互換が無ければ先頭）ので、`idMatches` が
    // 非空でありさえすれば中身が全件衝突していても `nativeMatches` が評価されない。derived id
    // 側に衝突する兄弟、native id 側に identity 完全一致の兄弟が並ぶ状態では、健全な再配送が
    // `start_conflict` で隔離される。隔離は鍵を消費せず還元器は純関数なので永久に収束しない。
    // 連結順は `idMatches` を先にして、両集合とも全件衝突のときの衝突の証拠を従来と揃える
    const existing = preferCompatible([...idMatches, ...nativeMatches]);
    const startConflict = existing !== undefined && startConflictsWith(existing);
    if (startConflict) {
      return quarantine(previous, idempotencyLedger, [
        {
          code: "start_conflict",
          eventId: event.eventId,
          detail: `operationId ${existing.operationId} と同じ nativeOperationId で identity が違う`,
        },
      ]);
    }
    if (existing !== undefined) {
      // **再配送が持っていて記録に欠けている識別材料は、鍵を消費する前に埋める**。凍結 schema の
      // `OperationCorrelationV1` は `nativeOperationId` / `canonicalInputHash` / `toolName` を
      // required にしていないので、復元した checkpoint や別実装が書いた状態では欠けうる。欠けたまま
      // 重複として鍵だけ消費すると、**その material を使う照合が永久に成立しない**（実測: native id を
      // 持たない pending に native id 付きの start を再配送すると重複になり、その native id を名乗る
      // terminal は rule 1 で候補ゼロ = `terminal_orphaned` の隔離を繰り返し、operation は `started` の
      // まま止まる）。埋めるのが安全なのは、ここに来た時点で `startConflictsWith` が false = 両方が
      // 持つ欄はすべて一致していると確認済みだから。欠けている欄を埋めるだけなら矛盾は作れない。
      // **`turnId` と `turnIdSource` は埋めない**: どちらも turn scoped で、再配送は元の start と
      // 違う turn で届きうる。記録が turn 同一性を持たないときに再配送側の turn を書くと、rule 2 の
      // 照合権限を「元の start に無かった turn」で与えることになる（欠落と違って、これは記録の
      // 意味を変える）。降格された turn の回復は #35 の本筋で扱う
      // 値が無い欄は**キーごと**落とす。JCS は `undefined` を canonicalize できないので、
      // `{ nativeOperationId: undefined }` を残すと状態 hash の計算で例外になる
      const recovered = withoutUndefined<OperationCorrelationV1>({
        ...existing.correlation,
        nativeOperationId: existing.correlation.nativeOperationId ?? operation.nativeOperationId,
        canonicalInputHash: existing.correlation.canonicalInputHash ?? operation.canonicalInputHash,
        toolName: existing.correlation.toolName ?? operation.operationKind,
      });
      // **原因 event を operation に残す**。この経路は配送鍵を消費して revision も進めるのに、
      // 状態を変える他の経路（照合できた terminal / `unknown` に倒した候補 / 放棄）が全部
      // 呼んでいる `withSourceEvent` だけ呼んでいなかった。しかも上で correlation を埋めるように
      // したので、**状態が変わった理由が状態からも辿れない**（`history` は
      // `CanonicalWorkStateV1` の欄ではないので永続的な provenance にならない）。
      // `withSourceEvent` が早期 return する条件は 2 つあり、意味が違う。**同じ eventId の
      // 再配送**（台帳だけ失った復元）は既に記録済みなので何も失っていない。**上限 256 件に
      // 達している**場合は本当に記録できないので、他の 3 経路（照合できた terminal /
      // `unknown` に倒した候補 / 放棄）と同じく診断に出す。この経路だけ対を付けておらず、
      // revision と配送鍵は消費されるのに「provenance は残らなかった」が呼び出し側に届かなかった
      const truncated = sourceEventsFull(previous.state.pendingOperations, new Set([existing]), event.eventId);
      const duplicateDiagnostic: ContinuityDiagnosticV1 = {
        code: "duplicate_operation_start",
        eventId: event.eventId,
        detail: `operationId ${existing.operationId} は既に pending`,
      };
      return commit(previous, event, idempotencyLedger, {
        pendingOperations: previous.state.pendingOperations.map((pending) =>
          pending === existing
            ? withSourceEvent({ ...pending, correlation: recovered }, event.eventId)
            : pending,
        ),
        diagnostics:
          truncated.length === 0
            ? [duplicateDiagnostic]
            : [duplicateDiagnostic, truncationDiagnostic(event, truncated)],
        // 再配送された start で operationStarts を埋めない。§6.4 の `ingestSeq` は event store が
        // 採番する watermark なので、再配送 event が運ぶのは再配送時の取り込み位置であって
        // 元の start の権威順序ではない。埋めると低い値を名乗る偽 start で unknown を succeeded に
        // 変えられる。復元直後（operationStarts が空）は terminal_order_unverifiable で unknown に
        // 倒れるのが §3.1 の fail closed どおりで、材料の復旧は #35（状態に持たせる）が本筋
      });
    }
    const started = startPendingOperation(event, operation, operationId, previous.state.taskLineageId);
    const retained = retainPendingOperations(previous.state.pendingOperations, previous.state.taskLineageId);
    // 黙って間引かない。退避した operation の event 自体は event store に残るが、状態からは
    // 消えるので、どれを落としたかを診断に出す
    const kept = new Set(retained);
    const evicted = previous.state.pendingOperations
      .filter((pending) => !kept.has(pending))
      .map((pending) => pending.operationId);
    // 退避した operation の start facts も落とす。残すと pendingOperations が 256 件で頭打ちの
    // 一方でこの表だけが単調増加する。
    // **同名の兄弟が残っていても消す**。ここに「生きている operation の順序材料を消さないため」の
    // 例外を一度入れたが、それは fail open だった: `operationStarts` の鍵は `operationId` なので、
    // id が衝突していると**どちらの兄弟の材料かを原理的に判別できない**。退避した側の材料を残すと、
    // 生き残った側の順序検査がその他人の材料で通り、**順序違反の terminal が診断ゼロで適用され
    // 台帳まで消費される**（実測: 退避側 start=10・生存側の実 start=100 の状態に ingestSeq 50 の
    // terminal を当てると succeeded になった）。材料を落として `terminal_order_unverifiable` で
    // `unknown` に倒れるのが §3.1 の fail closed どおりで、材料の復旧は #35（状態に持たせる）が本筋
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

  // 自己矛盾の証跡は照合の成否とは無関係な event 自身の性質なので、照合前に作って全経路で出す。
  // 照合できた場合しか出さないと、同じ壊れた adapter でも operation が既に閉じているときだけ
  // `terminal_already_applied` に埋もれて見えなくなる
  const contradictionDiagnostics: ContinuityDiagnosticV1[] = terminalEvidenceContradicts(event)
    ? [
        {
          code: "terminal_evidence_contradicts",
          eventId: event.eventId,
          detail: `kind ${event.kind} が successful: true を名乗っている`,
        },
      ]
    : [];

  const correlation = correlateTerminalEvent(previous, event);
  if (correlation.matched === null) {
    const diagnostics = [
      { code: correlation.diagnostic, eventId: event.eventId, detail: correlation.detail },
      ...contradictionDiagnostics,
    ];
    // 隔離するのは「状態に記録できる相手が居ない」場合だけにする。
    // - `terminal_conflict`: v6「same op ID + different hash: quarantine corruption」。台帳に
    //   入れると訂正された再配送が重複 no-op として黙って捨てられる
    // - `terminal_orphaned`: 候補が 1 件も無い。start より先に terminal が届く順序前後は正常運用
    //   （hook と transcript scan の取り込み順、再起動後の catch-up）なので、台帳に入れると
    //   後から start が届いても二度と閉じられない。隔離しておけば再配送で拾い直せる
    // 候補が居る分岐（unmatched / ambiguous / order_unverifiable）は下の commit で unknown に
    // 倒して台帳へ入れる。隔離すると operation が `started` のまま残り、状態が嘘をつく
    // 判定は**診断コードの列挙ではなく結果**から導く。「記録できる相手が居ない」は
    // `unresolved` が空であることそのもので、コード名で並べると同じ状態に別のコードで到達する
    // 経路が漏れる（実測: 確定済みで同じ matchKey の兄弟が 1 件居るだけで、start より先に届いた
    // terminal が `terminal_orphaned`（隔離・鍵を残す）ではなく `terminal_unmatched`（commit・
    // 鍵を消費）に落ちた。候補を 1 件も `unknown` にしないので状態には何も残らず、それでいて
    // 配送鍵は焼けるので、後から start が届いてからの再配送が重複 no-op になり operation は
    // 永久に `started`。上のコメントが `terminal_orphaned` について書いている失敗そのもの）。
    // #43 のとおり unmatched evidence の置き場が凍結 schema に無いので、記録先が無い commit は
    // 状態に何も残さない = 隔離との差は「鍵を焼くかどうか」しかない。
    // 例外は `terminal_already_applied`——これは「既に閉じた operation の再配送」なので本当に
    // 重複であり、隔離すると adapter が無限に再送する
    if (
      correlation.unresolved.length === 0 &&
      correlation.diagnostic !== "terminal_already_applied"
    ) {
      return quarantine(previous, idempotencyLedger, diagnostics);
    }
    // §4.3「zero or multiple にマッチした terminal は unmatched evidence として保ち、候補を
    // unknown のままにし、診断を出す」。status は unknown にするが pending には残すので、
    // 後から権威ある証跡（rule 1）が来れば閉じられる。証跡を足さないと、状態が変わった理由が
    // 状態からも history からも辿れない（放棄経路は足しているので扱いも揃わない）
    // 対象は `operationId` ではなく候補そのものの参照で受け取る。id で当てると、状態側で id が
    // 重複しているとき（凍結 schema は一意性を要求しない）**候補ですらない operation**——
    // 別 session のものまで——が `unknown` になる。§4.3 が集合単位で指示しているのは
    // 「candidates を unknown のままにする」であって、候補の外へ広げてよいとは言っていない
    const unresolved = new Set(correlation.unresolved);
    const truncated = sourceEventsFull(previous.state.pendingOperations, unresolved, event.eventId);
    return commit(previous, event, idempotencyLedger, {
      pendingOperations: previous.state.pendingOperations.map((pending) =>
        unresolved.has(pending)
          ? withSourceEvent(
              pending.status === "started" ? { ...pending, status: "unknown" as const } : pending,
              event.eventId,
            )
          : pending,
      ),
      diagnostics: truncated.length === 0 ? diagnostics : [...diagnostics, truncationDiagnostic(event, truncated)],
    });
  }

  const status = terminalStatusOf(event);
  const truncated = sourceEventsFull(
    previous.state.pendingOperations,
    new Set([correlation.matched]),
    event.eventId,
  );
  return commit(previous, event, idempotencyLedger, {
    // 照合された 1 件だけを更新する。`operationId` の等値で当てると、**状態側で
    // `operationId` が衝突している**とき terminal 1 通が複数の operation を診断ゼロで閉じる。
    // `operationId` は `eventId` + matchKey からの導出なので還元器は重複を作らないが、
    // 凍結 schema は `maxLength` しか課さず一意性も要求しないため、checkpoint から復元した
    // 状態や別実装が書いた状態では schema 妥当なまま重複しうる（状態側 identity の検査は
    // Task 6 `reconcileWorkspace` 待ち）。候補の絞り込みは `.filter` だけなので、照合結果は
    // この配列の要素そのもの = 参照で当てれば重複があっても 1 件に限定できる
    pendingOperations: previous.state.pendingOperations.map((pending) =>
      pending === correlation.matched
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

/**
 * 退避の優先順位。**lineage 外が status 順より先に来る**。当初は「上限は容量の判断なので lineage を
 * 見ない」としていたが、それだと**別 lineage の要素で自 lineage の証跡を押し出せた**（実測:
 * 自 lineage の `succeeded` 1 件 + 別 lineage の `started` 255 件で満杯の状態に自 lineage の start を
 * 入れると、自 lineage の `succeeded` が退避されて別 lineage 255 件は全て残った）。lineage 外の要素は
 * `assertSameScope` の外にあり、照合・放棄のどの経路からも候補にならないので、状態に残しておく
 * 価値が自 lineage の確定済み証跡より低い。容量の判断だからこそ、価値の低いものから落とす。
 */
function retainPendingOperations(
  pending: PendingOperation[],
  taskLineageId: string,
): PendingOperation[] {
  if (pending.length < CONTINUITY_LIMITS.arrayItems) return pending;
  const dropCount = pending.length - CONTINUITY_LIMITS.arrayItems + 1;
  // 落とす相手は `operationId` ではなく要素の参照で持つ。frozen schema は `operationId` に
  // 一意性を課さないので、復元した状態には同名の pending が並びうる。id の集合で持つと
  // (a) 1 件分の枠を空けるつもりで同名の兄弟までまとめて消え、(b) `dropped.size` が件数でなく
  // 異なり数になるので、上限を割ってもなお足りないと判定できない
  const dropped = new Set<PendingOperation>();
  const passes: readonly ((candidate: PendingOperation) => boolean)[] = [
    (candidate) => candidate.correlation.taskLineageId !== taskLineageId,
    ...EVICTION_ORDER.map((status) => (candidate: PendingOperation) => candidate.status === status),
  ];
  for (const matches of passes) {
    for (const candidate of pending) {
      if (dropped.size === dropCount) break;
      if (matches(candidate)) dropped.add(candidate);
    }
  }
  return pending.filter((candidate) => !dropped.has(candidate));
}

/**
 * frozen schema は `sourceEventIds` も 256 件（§10 の `arrayItems`）に制限する。projection は
 * 上限で頭打ちにし、超えた分は状態に載せない（記録できなかった事実は診断に出す）。上限を見ずに append すると、
 * 同じ operation に届き続ける terminal で還元器自身が schema 違反の状態を出す。
 */
/**
 * 値が `undefined` の欄をキーごと落とす。JCS（§22.6 の canonical form）は `undefined` を
 * canonicalize できないので、任意欄を `?? ` で埋める形で組み立てた object をそのまま状態へ
 * 入れると、両方が無いときに hash 計算が例外になる。
 */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function withSourceEvent(pending: PendingOperation, eventId: string): PendingOperation {
  if (pending.sourceEventIds.includes(eventId)) return pending;
  if (pending.sourceEventIds.length >= CONTINUITY_LIMITS.arrayItems) return pending;
  return { ...pending, sourceEventIds: [...pending.sourceEventIds, eventId] };
}

// 対象は `operationId` ではなく **object 参照**で受け取る。状態側で `operationId` が重複して
// いるとき（凍結 schema は一意性を要求しない）、id で当てると無関係な operation まで数える
function sourceEventsFull(
  pending: readonly PendingOperation[],
  targets: ReadonlySet<PendingOperation>,
  eventId: string,
): string[] {
  return pending
    .filter((candidate) => targets.has(candidate))
    // `withSourceEvent` の判定と揃える。あちらは「既に記録済みなら何もしない」を先に見るので、
    // 上限に達していても**その event は失われていない**。長さだけで判定すると、何も失って
    // いないのに `source_events_truncated` が出る（診断文は「この event を記録できない」と
    // event について断言する形なので、本当に記録できなかった場合と区別がつかなくなる）
    .filter((candidate) => !candidate.sourceEventIds.includes(eventId))
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
      unresolved: readonly PendingOperation[];
    };

/**
 * kind が失敗を宣言しているのに `successful: true` を名乗る自己矛盾。schema はどちらの欄も
 * valid なので通ってしまうが、これを `succeeded` として扱うと壊れた adapter が失敗を握り潰せる。
 * 成否の判定と診断の生成の両方がこの述語を要るので、書き分けて drift しないよう 1 箇所にする。
 */
function terminalEvidenceContradicts(event: NormalizedContinuityEvent): boolean {
  return event.kind === "tool_failed" && event.successful === true;
}

/**
 * terminal event が主張する成否。自己矛盾している terminal と `successful` が無い terminal は
 * どちらも成否を主張できないので `unknown` に倒す。
 * §4.3「terminal の証跡が欠けている / 曖昧なときは unknown を確定する」。
 */
function terminalStatusOf(event: NormalizedContinuityEvent): "succeeded" | "failed" | "unknown" {
  if (terminalEvidenceContradicts(event)) return "unknown";
  if (event.successful === true) return "succeeded";
  if (event.successful === false) return "failed";
  return "unknown";
}

/**
 * `operationStarts` は `operationId` 鍵の側索引（#35。凍結 schema の外）なので、同じ id の
 * pending が並ぶ状態では**どちらの兄弟の材料かを判別できない**。判別できないまま引くと、片方の
 * start facts でもう片方の順序と turn 種別が検査される（実測: 兄弟 B の `ingestSeq` 100 を使って
 * A 宛ての terminal が通り、A が診断ゼロで `succeeded` になった。逆向きの値では健全な terminal が
 * `terminal_out_of_order` で弾かれた）。曖昧な id は「材料が無い」として扱い、復元直後と同じ
 * fail closed な経路（`terminal_order_unverifiable`）へ倒す。
 */
function startFactsFor(
  snapshot: TaskWorkStateSnapshotV1,
  operationId: string,
): OperationStartFactsV1 | undefined {
  let seen = 0;
  for (const pending of snapshot.state.pendingOperations) {
    // **数えるのは自 lineage の pending だけ**。`operationStarts` は凍結 schema の外にあるので
    // checkpoint から復元されることが無く、entry を書けるのは `assertSameScope` を通った
    // 自 lineage の start だけ（この関数が読む側、書く側とも 1 箇所）。よって別 lineage の同名
    // pending は entry の帰属を曖昧にしない。数に入れると**曖昧でないものを曖昧と読む**ことになり、
    // 材料なし扱いが 2 方向に効いてしまう: 健全な operation が `terminal_order_unverifiable` で
    // `unknown` に倒れるだけでなく、`startConflictsWith` の `recordedSource !== undefined` 節が
    // 常に false になって **`turnIdSource` のすり替え検査が無効化される**（実測: 別 lineage の
    // 双子を 1 件置くと、native → synthesized_monotonic にすり替えた再配送が `start_conflict` から
    // `duplicate_operation_start` に変わり配送鍵まで消費した = fail open）。
    // 自 lineage で id が衝突している場合だけは帰属を判別できないので、従来どおり材料なしに倒す
    if (
      pending.operationId === operationId &&
      pending.correlation.taskLineageId === snapshot.state.taskLineageId
    ) {
      seen += 1;
    }
    if (seen > 1) return undefined;
  }
  return snapshot.operationStarts.get(operationId);
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
  // **intake 済みの event しか受けない**。当初は「correlate は `provenance` を一度も読まないので
  // authority label を消費しない」として素の `NormalizedContinuityEvent` を受けていたが、これは
  // 誤りだった: この関数は rule 2 の候補選びで `turnIdSource` を、`assertSameScope` で `sourceAgent` を
  // 見ており、**どちらも intake が認証結果に応じて書き換える欄**。intake を飛ばすと、証明の無い
  // native turn 主張がそのまま照合権限になる（実測: 未証明 native の rule 2 terminal は直接呼びだと
  // matched になり、`stampIntakeEvidence` を通すと `unavailable` へ降格して `terminal_unmatched`）。
  // 型で intake の通過を要求すれば、還元器（`IntakeStampedEventV1`）と入口の前提が揃う
  terminalEvent: IntakeStampedEventV1,
): TerminalCorrelationResult {
  // 公開 API なので還元器を経由しない呼び出しがありうる。envelope の検査を飛ばすと、既知の
  // terminal kind が envelope 無しで届いたとき §3.1 違反が `terminal_unmatched` という
  // 「照合できなかっただけ」の結果に化けて、壊れた adapter の証跡がそのまま保存される
  assertOperationEnvelope(terminalEvent);
  // envelope の検査は「kind が示す phase と envelope の phase が一致するか」しか見ないので、
  // start / progress の event を渡しても通ってしまい、**経路の取り違えが
  // `terminal_unmatched`（= 照合できなかっただけの正常な結果）に化ける**。公開型は phase で
  // 判別されない `NormalizedContinuityEvent` なので、caller は start を「未照合の terminal 証跡」
  // として保存してしまえる。`finalizeAbandonedState` が逆向きに張っている kind ガードと対称に、
  // ここでも terminal 相であることを要求する
  if (terminalEvent.operation?.phase !== "terminal") {
    throw new Error(
      `terminal 以外の operation event は correlateTerminalEvent に渡さない: phase=${String(terminalEvent.operation?.phase)}`,
    );
  }
  assertTurnIdentity(terminalEvent);
  // 候補の絞り込みは session と lineage しか見ない（状態は Agent を 1 つしか持たないので、
  // 状態と event の Agent はここで突き合わせるしかない）。還元器は同じ検査を入口でしているが、
  // 直接呼びで飛ばすと別 Agent の terminal が「権威ある一致」として返り、consumer がそれを
  // 適用してしまう
  assertSameScope(previous.state, terminalEvent);
  // identity 材料も入口で見る。`assertSameScope` は lineage と Agent しか束縛せず、候補の
  // 絞り込みは `sessionId` の等値だけを見るので、空白の `sessionId` を持つ terminal は
  // 同じく空白の `sessionId` を持つ pending（復元した checkpoint や別実装が書いた状態。
  // 凍結 schema に minLength は無い）と一致してしまう。空白同士は「同じ session」ではなく
  // 「どちらも session を名乗っていない」なので、event 側をここで落とす
  assertIdentityMaterial(terminalEvent);
  // §22.6 の decimal string 制約も入口で見る。`compareIngestSeq` は start を選んだ後の順序比較
  // でしか走らないので、候補ゼロ・適用済み・曖昧・照合不能で早期 return する経路では検査され
  // ない。還元器は入口で落とすのに直接呼びだけが `terminal_orphaned` という「照合できなかった
  // だけ」の診断を返すと、§22.6 違反が正常な結果に化けて、caller が壊れた順序証跡を保持する
  assertIngestSeq(terminalEvent.ingestSeq);
  const operation = terminalEvent.operation;
  if (operation === undefined || operation.phase !== "terminal") {
    return {
      matched: null,
      diagnostic: "terminal_unmatched",
      detail: "terminal envelope が無い",
      unresolved: [],
    };
  }
  // lineage は状態から取る。`assertSameScope` を入口で通しているので `terminalEvent.taskLineageId`
  // は「不在」か「状態と同じ」のどちらかで、event 側を優先しても値は変わらない。それでも state を
  // 書くのは、wire が運ぶ値を候補選びの権威に見せないため（読み手が「event の lineage で選べる」と
  // 誤読すると、入口の検査を外した瞬間に別 lineage の operation を閉じられるようになる）
  const sameScope = previous.state.pendingOperations.filter(
    (pending) =>
      pending.correlation.sessionId === terminalEvent.sessionId &&
      pending.correlation.taskLineageId === previous.state.taskLineageId,
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
            // `toolName` は凍結 schema の required に無いので、復元した checkpoint や別実装が
            // 書いた状態では欠けうる。**兄弟の 2 箇所（`startConflictsWith` / `identityConflicts`）は
            // 両方 present ガードを持つのに、ここだけ素で比べていた**。素で比べると
            // `undefined === "tool_use"` が false になって候補ゼロ = `terminal_orphaned` の隔離に
            // なり、隔離は台帳を消費せず還元器は純関数なので**同じ再配送が毎回同じ隔離で
            // 収束しない**（実測: `toolName` を消すだけで `succeeded` が `terminal_orphaned` に
            // 変わった）。§4.3 の matchKey は tool 名を入力に含むので、仕様どおりに導出する
            // adapter では matchKey 一致が既に kind を束縛している
            (pending.correlation.toolName === undefined ||
              pending.correlation.toolName === operation.operationKind),
        );
  const rule = byNativeId.length > 0 ? "native_operation_id" : "match_key";

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
      unresolved: [],
    };
  }
  // 衝突検査はすべての早期 return より前に置く。後ろに置くと「terminal 済み」「順序不明」で
  // 先に return してしまい、corrupt な event が隔離されずに台帳へ入って、訂正版の再配送が
  // 重複 no-op として黙って捨てられる。
  // §4.3「operationMatchKey は Agent・session・lineage・turn・kind・native operation ID・
  // canonical input hash に対する schema-versioned SHA-256」。rule 2 の候補は matchKey 一致で
  // 選んでいるので、これが効くのは rule 1（nativeOperationId だけで選ぶ）の候補
  // matchKey 同士は比べない。§4.3 は matchKey の入力に「turn when present」を含めるので、
  // turn をまたいだ terminal は start と違う matchKey を持つのが仕様どおりで、それは衝突ではない。
  // rule 1 は turn を要求しない（turn 両立は rule 2 の要件）ので、ここで matchKey 一致を
  // 要求すると背景実行の完了や prompt 境界をまたいだ tool が永久に閉じなくなる
  // kind は §4.3 の matchKey の入力に含まれる identity の一部で、turn と違って start から
  // terminal の間に変わらない。rule 2 の候補は matchKey 一致で選ぶので kind も揃っているが、
  // rule 1 は nativeOperationId だけで選ぶので、kind を見ないと別種の operation を閉じられる。
  // start 側の identity 衝突検査と対称にする。`toolName` は凍結 schema の required に
  // 無いので、checkpoint から復元した状態や別実装が書いた状態では schema 妥当なまま
  // 欠けうる。素で比べると健全な terminal が永久に隔離され、台帳にも入らないので
  // adapter は無限再送になる。兄弟の `canonicalInputHash` と同じく両方 present のときだけ比べる
  const identityConflicts = (pending: PendingOperation): boolean =>
    (pending.correlation.toolName !== undefined &&
      pending.correlation.toolName !== operation.operationKind) ||
    (pending.correlation.canonicalInputHash !== undefined &&
      operation.canonicalInputHash !== undefined &&
      pending.correlation.canonicalInputHash !== operation.canonicalInputHash);
  // 記録側が持つ identity 材料を terminal が省いているのは「衝突しない」ではなく「照合できない」。
  // 上の両方 present ガードは復元耐性のためにあるが、そのままだと `canonicalInputHash` を
  // 省くだけで検査を無効化でき、同じ matchKey の別 operation を閉じられる（省略は wire 側の
  // 自由なので、これは攻撃者が選べる経路）。§4.3 の fail closed どおり、適用せず候補を
  // `unknown` に倒す。`toolName` 側に対称のものが要らないのは、`operationKind` が envelope の
  // 必須欄で空も許さない（`assertOperationFields`）ので terminal から省けないため
  const identityUnverifiable = (pending: PendingOperation): boolean =>
    pending.correlation.canonicalInputHash !== undefined && operation.canonicalInputHash === undefined;
  // ただしこれが実害になるのは、この terminal が付きうる候補が 2 件以上あるときだけ。
  // 1 件しか残っていないなら省略で付け替えられる相手が居ないので、§4.3 の照合権限
  // （rule 1 = nativeOperationId、rule 2 = matchKey + 互換な turn/kind）が既に相手を
  // 一意に決めている。`canonicalInputHash` は凍結 envelope の optional（§3.1）なので省略は
  // schema 妥当で、§4.3 が terminal に課すのは「non-conflicting な payload/source hash」＝
  // 衝突しないことであって、不在は衝突ではない。§4.3 の matchKey は canonical input hash を
  // 入力に含むので、仕様どおりに導出する adapter では hash 違いの兄弟はそもそも候補に並ばない。
  // 候補が 2 件以上並ぶのは matchKey を仕様どおりに導出しない adapter だけで、そこでは
  // hash が唯一の弁別子なので、省略された時点で倒す。素で発火させると「terminal は入力では
  // なく結果なので hash を載せない」adapter の terminal が 1 通残らず閉じなくなる
  // 候補が複数あるとき（§4.3 どおりに matchKey を導出しない adapter では、同じ matchKey で
  // input hash が違う pending が並びうる）、identity が衝突する候補は「この terminal のもので
  // ある可能性」から外すだけで、他の候補の照合を妨げない。全件衝突なら隔離、そうでなければ
  // 以降は互換な候補だけを見る。兄弟の identity を根拠に live な候補まで隔離すると、その
  // operation が永久に閉じないまま adapter が無限再送する。一方で「互換な兄弟が 1 件でも
  // あれば全体を免除する」（旧 `every` の後の素通し）だと、確定済みの互換候補が囮になって
  // 衝突する open な候補に terminal が付く。候補はここでは必ず 1 件以上ある
  const compatible = candidates.filter((pending) => !identityConflicts(pending));
  if (compatible.length === 0) {
    return {
      matched: null,
      diagnostic: "terminal_conflict",
      detail: `operation ${(candidates[0] as PendingOperation).operationId} と identity が衝突`,
      // 隔離は状態を一切変えないので、候補も unknown にしない
      unresolved: [],
    };
  }
  // §4.3「rule 2 は双方が同じ `turnIdSource` 種別の turn 同一性を持つことを要求する」。
  // 「この terminal が閉じえた候補」の定義なので、open な候補を選ぶときだけでなく、
  // 確定済みの候補で再配送を説明するときにも同じ絞り込みが要る。rule 1 を名乗った terminal は
  // turn 両立を要求しない（候補は既に `byNativeId` に限定されている）ので絞らない
  const sameTurnOf = (list: readonly PendingOperation[]): readonly PendingOperation[] =>
    byNativeId.length > 0
      ? list
      : list.filter(
          (pending) =>
            pending.correlation.turnId !== undefined &&
            pending.correlation.turnId === terminalEvent.turnId,
        );
  // 種別の材料（`operationStarts`、#35）は復元直後と退避後に空になる。材料が無いことを
  // 「種別が違う」と読むと理由を取り違えるので、材料がある候補だけ種別で絞る
  const eligibleOf = (list: readonly PendingOperation[]): readonly PendingOperation[] =>
    byNativeId.length > 0
      ? list
      : list.filter((pending) => {
          const recorded = startFactsFor(previous, pending.operationId)?.turnIdSource;
          return recorded === undefined || recorded === terminalEvent.turnIdSource;
        });
  const isOpen = (pending: PendingOperation): boolean =>
    pending.status === "started" || pending.status === "unknown";
  // **open / 確定済みの切り分けも、この terminal が閉じえた候補の中で行う**。先に切り分けてから
  // 絞ると、turn が両立しない open な兄弟が「open が居る」と数えられて確定済み経路が飛ばされ、
  // 確定済み候補への健全な再配送が `terminal_unmatched` に化けて、その兄弟を `unknown` に倒し
  // 台帳まで消費する（兄弟はこの terminal では閉じえないので巻き込む理由が無い）
  // §4.3 の順序要件（terminal の `ingestSeq` は start より後）も**絞り込みで見る**。これまでは
  // 候補を 1 件に決めたあとの検査だったので、start が 10 と 20 の候補が並ぶとき `ingestSeq` 15 の
  // terminal は「10 の側しか閉じえない」のに両方が候補として数えられ、`terminal_ambiguous` で
  // **両方 `unknown` に倒れて台帳まで消費される**（実測）。`turnIdSource` と同じ扱いで、材料が
  // ある候補だけを対象にし、rule 1 を名乗った terminal は絞らない。
  // **全件が順序不適合なら絞らない**: そこで空にすると、候補 1 件が順序違反というだけの場合に
  // `terminal_out_of_order`（何が起きたかを名指しする診断）が `terminal_unmatched` に化ける
  const orderableOf = (list: readonly PendingOperation[]): readonly PendingOperation[] => {
    if (byNativeId.length > 0) return list;
    const orderable = list.filter((pending) => {
      const start = startFactsFor(previous, pending.operationId);
      return start === undefined || compareIngestSeq(terminalEvent.ingestSeq, start.ingestSeq) > 0;
    });
    return orderable.length === 0 ? list : orderable;
  };
  const sameTurn = sameTurnOf(compatible);
  const plausible = orderableOf(eligibleOf(sameTurn));
  const open = plausible.filter(isOpen);
  if (open.length === 0) {
    // §4.3 は terminal に「未適用であること」と「payload/source hash が衝突しないこと」の両方を
    // 課す。配送 ID が違う 2 通目は dedupe で比べられず、上の identity 衝突検査も kind と
    // input hash しか見ないので、成否だけが逆の terminal が「適用済み」として黙って通る。
    // 受理済み terminal の source hash は状態に持っていない（凍結 schema に置き場が無い。#43）が、
    // 確定済みの status は持っているので、成否の矛盾だけはここで検出できる。
    // どちらかが unknown のときは「成否を主張していない」ので矛盾ではない。
    // rule 2 の候補は同じ matchKey の兄弟をまとめて拾う（同じ turn で同じ tool を同じ入力で
    // 2 回など）ので、成否が一致する候補が 1 件でもあれば、この terminal はその候補の
    // 再配送として説明がつく。兄弟の成否だけを見て隔離すると健全な再配送が台帳に入らず、
    // adapter は無限再送になる。この分岐では候補は全件確定済み（open が空）なので、
    // 一致が無ければどの候補も矛盾している
    // ここは性質の違う 2 つの問いを続けて解くので、**母数を分ける**。
    // (i) この terminal は候補の再配送として説明がつくか → **turn 両立が要る**。
    //     閉じえた候補だけが説明役になれる。素の `compatible` で説明を許すと、turn 種別が
    //     両立しない兄弟が囮になる: native の failed と synthesized_monotonic の succeeded が
    //     同じ matchKey・同じ turnId で並ぶとき、succeeded を名乗る native の 2 通目が兄弟に
    //     説明されて隔離を回避する
    // (ii) 確定済みの候補と成否が矛盾していないか → **turn 両立は要らない**。
    //     これは「閉じる権限があるか」ではなく「壊れた証跡か」の判定で、matchKey・kind・
    //     input hash まで同じ terminal が確定済みの status と逆を主張しているなら、turn の
    //     導出が §4.3 どおりでない adapter だとしても矛盾は矛盾。ここを絞ると、候補が全部
    //     落ちた場合に `find` が undefined を返して隔離（台帳を消費しない）が
    //     `terminal_already_applied`（台帳を消費する）に化け、訂正版が重複 no-op になる。
    //     ただし**確定済みの候補だけ**を見る: この分岐に来るのは「turn が両立する open な候補が
    //     無い」場合で、turn が両立しない open な候補は残りうる。`started` は成否を主張して
    //     いないので、それを矛盾として隔離すると健全な terminal が台帳に入らず無限再送になる
    // (iii) 隔離と unmatched のどちらがこの領域を持つか → **記録できる候補が居るなら unmatched**。
    //     §4.3:368 は「zero か複数の open にマッチした terminal は何も閉じず、unmatched な証跡と
    //     して保存し、candidates を `unknown` にして診断を出す」と終状態まで名指ししている。
    //     矛盾ゲートの優先順位は「確定済みの候補しか居ない」形について `terminal_already_applied`
    //     に対して決めたもので、round 17 で `open` の切り分けを turn 絞り込みの後ろに移したとき
    //     `open.length === 0` の到達範囲が広がったのに、`terminal_unmatched` に対して決め直して
    //     いなかった。そのため「確定済みの兄弟が居て、turn が両立しない open な候補も居る」形が
    //     隔離に落ち、open な候補は `started` のまま残って状態が嘘をつく。**`turnIdSource` の
    //     食い違いは adapter の捕捉経路という定常的な性質なので「訂正版」が存在せず、還元器は
    //     純関数なので再送は毎回同じ隔離になる**——`started` を矛盾集合から外した理由（無限再送）と
    //     同型の失敗が、確定済みの兄弟経由で残っていた。記録できる候補が 1 件でも居るなら、
    //     台帳を消費してでも candidates を `unknown` にするほうが §4.3 の終状態に合う
    //     ただし**抑止するのは行動だけで、報告は残す**。§3.1 は棄却・降格の理由を doctor が
    //     報告できることを求めていて、(ii) は「壊れた証跡か」の判定なので、隔離しない場合でも
    //     矛盾していた事実自体は消えない。そのため矛盾の検出は行動ガードと独立に走らせ、
    //     `recordable` は「隔離するか」だけを決める
    const incoming = terminalStatusOf(terminalEvent);
    const contradicting =
      incoming === "unknown" || plausible.some((pending) => pending.status === incoming)
        ? undefined
        : compatible.filter((pending) => !isOpen(pending)).find((pending) => pending.status !== incoming);
    const recordable = plausible.length === 0 && compatible.some(isOpen);
    const contradicted = recordable ? undefined : contradicting;
    // 隔離は台帳を消費しないので、消費する分岐より必ず先に判定する
    if (contradicted !== undefined) {
      return {
        matched: null,
        diagnostic: "terminal_conflict",
        detail: `operation ${contradicted.operationId} は ${contradicted.status} で確定済みなのに ${incoming} を名乗る terminal が来た`,
        unresolved: [],
      };
    }
    // 矛盾はしていないが turn が両立する候補が 1 件も無い。再配送では説明できないので
    // `terminal_already_applied` を名乗らせず、§4.3 の「zero にマッチした terminal は
    // unmatched evidence として保存する」どおり `terminal_unmatched` にする。
    // `unknown` に倒す相手は「この terminal のせいで閉じられなかった open な候補」なので、
    // turn 同一性はあるが種別が違うならその候補だけ、turn 同一性が無いなら互換な open 全部
    if (plausible.length === 0) {
      const sameTurnOpen = sameTurn.filter(isOpen);
      const compatibleOpen = compatible.filter(isOpen);
      const sourceMismatch = sameTurnOpen.length > 0;
      return {
        matched: null,
        diagnostic: "terminal_unmatched",
        detail:
          (compatibleOpen.length === 0
            ? "候補はすべて terminal 済みで、turn が両立するものが無い"
            : sourceMismatch
              ? `turnIdSource が terminal の ${terminalEvent.turnIdSource} と違うので rule 2 では閉じられない`
              : "turn 同一性が無いので rule 2 では閉じられない") +
          // 隔離しなかった場合でも、矛盾していた事実は doctor に届ける
          (contradicting === undefined
            ? ""
            : `（なお operation ${contradicting.operationId} は ${contradicting.status} で確定済みなのに ${incoming} を名乗っている。閉じえた候補ではないので隔離はしない）`),
        unresolved: sourceMismatch ? sameTurnOpen : compatibleOpen,
      };
    }
    return {
      matched: null,
      diagnostic: "terminal_already_applied",
      detail: "候補はすべて terminal 済み",
      unresolved: [],
    };
  }
  // 照合不能の検査は上の成否矛盾検査より後に置く。前に置くと、確定済みの候補に矛盾する
  // terminal が hash を省くだけで隔離（台帳を消費しないので訂正版が後から効く）を回避して
  // 照合不能（台帳を消費する）に化け、訂正版の再配送が重複 no-op として黙って捨てられる
  // **数えるのは `compatible` ではなく `open`**。このゲートの理由は「terminal が hash を省くことで
  // **別の候補へ付け替えられる**」ことなので、付け替え先になりうる集合＝この terminal が実際に
  // 掴みうる候補（turn も順序も両立していて、まだ open なもの）で数えなければならない。
  // `compatible` で数えると、**閉じえない兄弟が健全な照合を潰す**（実測: open な op-A（hash あり）と
  // 確定済み・**別 turn** の op-B が同じ matchKey で並ぶ状態に、hash を省いた rule 2 terminal が
  // 届くと、兄弟が居ないときは診断ゼロで `succeeded` になるのに、居るだけで
  // `terminal_identity_unverifiable` になり op-A が `unknown` に倒れて台帳まで消費された）。
  // 別 turn の op-B は `sameTurnOf` で落ちるので、この terminal の**再配送先ですらない**。
  // 母数は `open` でもない: 確定済みでも**同じ turn**の兄弟は「この terminal はそちらの再配送
  // だった」がありうるので、hash の省略で付け替えが起きる。`plausible`（turn と順序が両立する
  // 候補。open / 確定済みの切り分け前）がちょうどその集合。rule 1 の候補数を `byNativeId` から
  // `compatible` へ直したのと同じ「母数の取り違え」
  const unverifiable = plausible.length > 1 ? plausible.find(identityUnverifiable) : undefined;
  if (unverifiable !== undefined) {
    return {
      matched: null,
      diagnostic: "terminal_identity_unverifiable",
      detail: `operation ${unverifiable.operationId} は canonicalInputHash を持つのに terminal が省いている`,
      unresolved: open,
    };
  }
  // rule 1 は「exact `nativeOperationId` + 同じ session/lineage」で operation を**一意に**指す規則
  // なので、その条件を満たす候補が 2 件以上あるなら terminal がどちらを指すかは決められない。
  // 凍結 schema は `nativeOperationId` にも一意性を課さないので、復元した checkpoint や別実装が
  // 書いた状態では確定済みと live が同じ native id で並びうる。件数を見ずに open だけで選ぶと、
  // **確定済み operation 宛ての再配送が live な兄弟を閉じる**（実測: 同じ native id の
  // succeeded と started が並ぶ状態で、確定済み側の terminal 再配送が live 側を掴んだ）。
  // 全件が確定済みの場合は上の `open.length === 0` で `terminal_already_applied` に落ちるので
  // ここには来ない = 再配送の扱いは変わらない
  // 数えるのは `byNativeId` ではなく `compatible`。`byNativeId` は `identityConflicts` で絞る
  // **前**の集合なので、native id は同じでも input hash や kind が違う——つまり既に候補から
  // 外れている——兄弟まで数に入り、**健全な terminal が `terminal_ambiguous` で `unknown` に
  // 倒れて台帳まで消費される**（隔離と違って訂正版が重複 no-op になるので隔離より悪い）。
  // この関数の他の判断はすべて `compatible` を見ており、「兄弟の identity を根拠に live な候補を
  // 巻き込まない」はこのファイル自身が絞り込みを導入したときの理由でもある
  if (rule === "native_operation_id" && compatible.length > 1) {
    return {
      matched: null,
      diagnostic: "terminal_ambiguous",
      detail: `rule 1 の nativeOperationId ${operation.nativeOperationId} に一致する候補が ${compatible.length} 件`,
      unresolved: open,
    };
  }
  // §4.3「rule 2 は双方が同じ `turnIdSource` 種別の turn 同一性を持つことを要求する。どちらかが
  // unavailable のとき rule 2 は適用されず、operation は unknown のままになる。閉じられるのは
  // rule 1 だけ」。この絞り込みは `open` を作る前（`plausible`）で済ませてあるので、ここに
  // 残っている open な候補はすべて §4.3 の turn 両立を満たす。あとは件数だけを見る
  if (open.length > 1) {
    return {
      matched: null,
      diagnostic: "terminal_ambiguous",
      detail: `open な候補が ${open.length} 件`,
      unresolved: open,
    };
  }
  const matched = open[0] as PendingOperation;

  const start = startFactsFor(previous, matched.operationId);
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
      unresolved: [matched],
    };
  }
  if (compareIngestSeq(terminalEvent.ingestSeq, start.ingestSeq) <= 0) {
    return {
      matched: null,
      diagnostic: "terminal_out_of_order",
      detail: "terminal が start より後でない",
      // 一致した 1 件だけが unknown。同じ matchKey の無関係な open を巻き込まない
      unresolved: [matched],
    };
  }
  return { matched, rule };
}

// --- §4.3 abandonment -------------------------------------------------------

export interface AbandonmentResultV1 {
  outcome: "applied" | "duplicate" | "quarantined";
  state: CanonicalWorkStateV1;
  ledger: IdempotencyLedger;
  /** 還元器と同じく黙って間引かない。放棄の証跡を記録できなかった operation を出す */
  diagnostics: readonly ContinuityDiagnosticV1[];
}

/**
 * §4.3「terminal の証跡が無い、または曖昧なまま放棄・復帰したときは unknown を確定する」。
 * 状態は不変なので、新しい revision を持つ別の状態を返す。
 *
 * §4.2 の「重複した論理 event は no-op」はこの経路にも掛かる。台帳を見ずに revision を採番すると、
 * 同じ放棄 event の再配送のたびに stateRevision が変わり、それを CAS token として使う下流
 * （checkpointRevision / expectedProjectionRevision / claimFence）が空振りする。
 */
/**
 * §4.3「放棄・復帰時に証跡が無い operation は unknown」。どの kind が放棄を確定するかは正本に
 * 無いので、harness の語彙（`NON_OPERATION_EVENT_KINDS`）から「その session がもう進まない」と
 * 言える 2 つを選ぶ。限らないと、routing の取り違えで届いた `user_prompted` 等が同 session の
 * 実行中 operation を全部 unknown にしたうえで冪等キーを消費してしまう。
 */
const ABANDONMENT_EVENT_KINDS: ReadonlySet<string> = new Set(["session_ended", "session_interrupted"]);

export function finalizeAbandonedState(
  state: CanonicalWorkStateV1,
  event: IntakeStampedEventV1,
  idempotencyLedger: IdempotencyLedger,
): AbandonmentResultV1 {
  assertOperationEnvelope(event);
  assertTurnIdentity(event);
  assertIdentityMaterial(event);
  assertIngestSeq(event.ingestSeq);
  assertSameScope(state, event);
  if (!ABANDONMENT_EVENT_KINDS.has(event.kind)) {
    throw new Error(`放棄を確定しない kind を finalizeAbandonedState に渡している: ${event.kind}`);
  }
  const key = ledgerKeyOf(event);
  const applied = idempotencyLedger.get(key);
  if (applied !== undefined) {
    // reducer 側と同じ判定にする。source hash が違うなら「同じ論理 event の再配送」ではないので、
    // 重複として黙って捨てると放棄が落ちて operation が started のまま残る。状態を変えない点は
    // duplicate と同じだが、outcome を分けて呼び出し側に見えるようにする
    const incoming = sourceHashOf(event);
    if (applied.sourceHash !== undefined && incoming !== undefined && applied.sourceHash !== incoming) {
      // 診断も還元器側と同じものを出す。outcome だけで区別できると考えて空で返していたが、
      // §3.1 が求めるのは doctor が理由を報告できることで、doctor が受け取るのは診断の側。
      // 空で返すと「なぜ放棄が落ちたか」が経路ごとに違う形でしか分からない
      return {
        outcome: "quarantined",
        state,
        ledger: idempotencyLedger,
        diagnostics: [
          {
            code: "delivery_conflict",
            eventId: event.eventId,
            detail: `event ${applied.eventId} と同じ配送 ID で source hash が違う`,
          },
        ],
      };
    }
    return { outcome: "duplicate", state, ledger: idempotencyLedger, diagnostics: [] };
  }
  // 放棄するのはその event の session の operation だけ。lineage は session をまたいで続く
  // （§5 の checkpoint は `sourceSessionId` と `taskLineageId` を別に持つ）ので、session を見ないと
  // 遅れて届いた旧 session の session_ended が、resume 先の live な operation まで unknown にする
  // 対象は `operationId` ではなく object 参照で持つ。状態側で `operationId` が重複していると
  // （凍結 schema は一意性を要求しない）、id で当てた瞬間に上の session 絞り込みが無意味になり、
  // 旧 session の session_ended が別 session の live な operation まで `unknown` にする
  // **lineage も同じ理由で絞る**。凍結 schema は `correlation.taskLineageId` が
  // `state.taskLineageId` と一致することを要求しないので、復元した checkpoint や別実装が書いた
  // 状態には別 lineage の pending が schema 妥当なまま並ぶ。session だけで絞ると、その別 lineage の
  // operation まで `unknown` になり（実測）、`sourceEventIds` は append-only なので巻き込んだ
  // `session_ended` の eventId が別 lineage の記録に永久に残る。`assertSameScope` が束縛するのは
  // lineage と Agent なので、この状態が権威を持つのは自 lineage の operation だけ
  const abandoned = new Set(
    state.pendingOperations.filter(
      (pending) =>
        pending.status === "started" &&
        pending.correlation.sessionId === event.sessionId &&
        pending.correlation.taskLineageId === state.taskLineageId,
    ),
  );
  const pendingOperations = state.pendingOperations.map((pending) =>
    abandoned.has(pending)
      ? withSourceEvent({ ...pending, status: "unknown" as const }, event.eventId)
      : pending,
  );
  // 還元器の terminal 経路と同じ扱い。`sourceEventIds` が上限の operation は status だけ
  // `unknown` に変わって、そう変えた理由の event が状態から落ちる。黙って落とさず報告する
  const truncated = sourceEventsFull(state.pendingOperations, abandoned, event.eventId);
  const content = nextContent(state, event, pendingOperations);
  const next = {
    ...content,
    stateRevision: deriveRevision(state.stateRevision, event.eventId, contentHashOf(content)),
  };
  return {
    outcome: "applied",
    state: next,
    ledger: new Map(idempotencyLedger).set(key, ledgerEntryOf(event)),
    diagnostics: truncated.length === 0 ? [] : [truncationDiagnostic(event, truncated)],
  };
}
