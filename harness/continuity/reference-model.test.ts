import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeJson, readIJsonFile } from "../schema/jcs.ts";
import { validateContractValue, type JsonSchemaDocument } from "../schema/validate.ts";
import {
  EVENT_KINDS,
  type EventKind,
} from "../schema/capability.ts";
import {
  CONTINUITY_LIMITS,
  NON_OPERATION_EVENT_KINDS,
  OPERATION_EVENT_PHASES,
  type CanonicalWorkStateV1,
  type NormalizedContinuityEvent,
  type PendingOperation,
} from "../schema/continuity.ts";
import {
  assertOperationEnvelope,
  assertTurnIdentity,
  compareIngestSeq,
  contentHashOf,
  correlateTerminalEvent,
  finalizeAbandonedState,
  idempotencyKeyOf,
  reduceTaskWorkState,
  stampIntakeEvidence,
  type IdempotencyLedger,
  type IntakeContextV1,
  type IntakeStampedEventV1,
  type TaskWorkStateSnapshotV1,
} from "./reference-model.ts";

const SCHEMA_ROOT = readIJsonFile<JsonSchemaDocument>(
  new URL("../schema/continuity.schema.json", import.meta.url),
);

const CAPABILITY_HASH = "b1946ac92492d2347c6235b4d2611184e2f4a1d94d4b3f7d3b5c3f9d0c6e8a11";
const VERSION = "2.1.228 (Claude Code)";

const START_OPERATION = {
  phase: "start",
  operationMatchKey: "match-key-1",
  operationKind: "Bash",
  nativeOperationId: "toolu_1",
  canonicalInputHash: "input-hash-1",
} as const satisfies NonNullable<NormalizedContinuityEvent["operation"]>;

const TERMINAL_OPERATION = { ...START_OPERATION, phase: "terminal" } as const;

/** nativeOperationId を出さない adapter（rule 2 でしか閉じられない） */
const MATCH_KEY_ONLY = { ...START_OPERATION, nativeOperationId: undefined } as const;

const ATTESTATION = {
  ingestReceiptId: "receipt-1",
  peerIdentityId: "peer-1",
  channel: "rpc",
  attestedAt: "2026-08-16T00:00:01Z",
} as const;

const INTAKE: IntakeContextV1 = {
  expectedSourceAgent: "claude",
  exactAgentVersion: VERSION,
  nativeTurnIdentityProven: true,
  activeCapabilityHash: CAPABILITY_HASH,
  provenScenarios: [
    { scenarioId: "tool-call-lifecycle", captureMethod: "native_event", channel: "rpc" },
  ],
  attestation: ATTESTATION,
};

function emptyState(overrides: Partial<CanonicalWorkStateV1> = {}): CanonicalWorkStateV1 {
  return {
    schemaVersion: 1,
    taskLineageId: "lineage-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    sourceAgent: "claude",
    activeFiles: [],
    modifiedFiles: [],
    recentCommands: [],
    recentTests: [],
    pendingOperations: [],
    repositoryState: {
      repositoryId: "repo-1",
      workspaceId: "workspace-1",
      capturedAt: "2026-08-16T00:00:00Z",
    },
    sensitivity: "normal",
    lastIngestSeq: "10",
    stateRevision: "genesis",
    updatedAt: "2026-08-16T00:00:00Z",
    ...overrides,
  };
}

function emptySnapshot(overrides: Partial<CanonicalWorkStateV1> = {}): TaskWorkStateSnapshotV1 {
  return { state: emptyState(overrides), history: [], operationStarts: new Map() };
}

/**
 * intake 済みとして扱う目印を付ける。目印は型だけのものなので値は変わらない。test は
 * intake の各分岐を stampIntakeEvidence 側で直接確かめるので、還元器の test では
 * 組み立てた event をそのまま渡す。
 */
function asStamped(event: NormalizedContinuityEvent): IntakeStampedEventV1 {
  return event as IntakeStampedEventV1;
}

function startEvent(overrides: Partial<NormalizedContinuityEvent> = {}): IntakeStampedEventV1 {
  return asStamped({
    eventId: "event-start",
    adapterDeliveryId: "delivery-start",
    canonicalFingerprint: "fingerprint-start",
    kind: "tool_started",
    ingestSeq: "11",
    occurredAt: "2026-08-16T00:00:01Z",
    sessionId: "session-1",
    taskLineageId: "lineage-1",
    turnId: "turn-1",
    turnIdSource: "native",
    sourceAgent: "claude",
    provenance: {
      sourceAgentVersion: VERSION,
      evidenceKind: "native",
      captureMethod: "native_event",
      capabilityHash: CAPABILITY_HASH,
      scenarioId: "tool-call-lifecycle",
      ingestAttestation: ATTESTATION,
    },
    operation: START_OPERATION,
    payload: { tool_name: "Bash" },
    ...overrides,
  });
}

function terminalEvent(overrides: Partial<NormalizedContinuityEvent> = {}): IntakeStampedEventV1 {
  return asStamped({
    ...startEvent(),
    eventId: "event-terminal",
    adapterDeliveryId: "delivery-terminal",
    canonicalFingerprint: "fingerprint-terminal",
    kind: "tool_completed",
    ingestSeq: "12",
    occurredAt: "2026-08-16T00:00:02Z",
    operation: TERMINAL_OPERATION,
    payload: { tool_response: "ok" },
    successful: true,
    ...overrides,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function apply(
  snapshot: TaskWorkStateSnapshotV1,
  events: readonly IntakeStampedEventV1[],
  ledger: IdempotencyLedger = new Map(),
): { snapshot: TaskWorkStateSnapshotV1; ledger: IdempotencyLedger } {
  let current = snapshot;
  let currentLedger = ledger;
  for (const event of events) {
    const result = reduceTaskWorkState(current, event, currentLedger);
    current = result.snapshot;
    currentLedger = result.ledger;
  }
  return { snapshot: current, ledger: currentLedger };
}

// --- event kind の分類（#29） -----------------------------------------------

test("operation 系 kind と非 operation kind は EVENT_KINDS を過不足なく分ける", () => {
  // 語彙に kind を足したとき、どちらに属するか決めないまま素通りさせない。
  // 期待値を手で並べると足した kind が両方から漏れるので、EVENT_KINDS から導く。
  const classified = [...Object.keys(OPERATION_EVENT_PHASES), ...NON_OPERATION_EVENT_KINDS].sort();
  assert.deepEqual(classified, [...EVENT_KINDS].sort());
  assert.equal(new Set(classified).size, classified.length);
});

// --- §22.6 decimal string の比較 --------------------------------------------

test("ingestSeq は safe integer を超えても桁順・辞書順で比較できる", () => {
  // Number 化すると 9007199254740993 と 9007199254740992 が同値になり、順序が壊れる
  assert.equal(Number("9007199254740993") === Number("9007199254740992"), true);
  assert.equal(compareIngestSeq("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareIngestSeq("9007199254740992", "9007199254740993"), -1);
  assert.equal(compareIngestSeq("9007199254740993", "9007199254740993"), 0);
  // 桁数が違えば辞書順ではなく桁数で決まる
  assert.equal(compareIngestSeq("9", "10"), -1);
  assert.equal(compareIngestSeq("0", "0"), 0);
});

test("decimal string でない ingestSeq は比較しない", () => {
  assert.throws(() => compareIngestSeq("01", "1"), /decimal string でない/);
  assert.throws(() => compareIngestSeq("1e3", "1"), /decimal string でない/);
  assert.throws(() => compareIngestSeq("-1", "1"), /decimal string でない/);
});

test("lastIngestSeq は遅れて届いた event で戻らない", () => {
  const late = startEvent({ ingestSeq: "3", eventId: "event-late" });
  const { snapshot } = apply(emptySnapshot({ lastIngestSeq: "9007199254740993" }), [late]);
  assert.equal(snapshot.state.lastIngestSeq, "9007199254740993");
  // 遅れて届いても revision は新しく作る（§4.2「Late ... events create later revisions」）
  assert.equal(snapshot.history.length, 1);
  assert.notEqual(snapshot.state.stateRevision, "genesis");
});

// --- §4.2 重複 no-op --------------------------------------------------------

test("同じ adapterDeliveryId を 10 回適用しても最初の 1 回しか効かない", () => {
  const first = reduceTaskWorkState(emptySnapshot(), startEvent(), new Map());
  assert.equal(first.outcome, "applied");
  const bytes = canonicalizeJson(first.snapshot.state);

  let snapshot = first.snapshot;
  let ledger = first.ledger;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // 再送は eventId・ingestSeq・occurredAt が違っても同じ配送 ID を持つ
    const redelivered = startEvent({
      eventId: `event-start-retry-${attempt}`,
      ingestSeq: String(20 + attempt),
      occurredAt: "2026-08-16T00:00:09Z",
    });
    const result = reduceTaskWorkState(snapshot, redelivered, ledger);
    assert.equal(result.outcome, "duplicate");
    assert.equal(canonicalizeJson(result.snapshot.state), bytes);
    assert.equal(result.contentHash, first.contentHash);
    assert.equal(result.snapshot.state.stateRevision, first.snapshot.state.stateRevision);
    assert.equal(result.snapshot.history.length, first.snapshot.history.length);
    assert.equal(result.ledger, ledger);
    snapshot = result.snapshot;
    ledger = result.ledger;
  }
  assert.equal(ledger.size, 1);
});

test("adapterDeliveryId が無い event は canonical fingerprint で重複判定する", () => {
  const event = startEvent({ adapterDeliveryId: undefined });
  assert.equal(idempotencyKeyOf(event), "fingerprint-start");
  const first = reduceTaskWorkState(emptySnapshot(), event, new Map());
  const again = reduceTaskWorkState(first.snapshot, { ...event, eventId: "other" }, first.ledger);
  assert.equal(again.outcome, "duplicate");
});

test("adapterDeliveryId に他 event の fingerprint を書いても先取りできない", () => {
  // v6 §8.2 の導出式は adapterDeliveryId と canonicalFingerprint を同じ keyspace に置く。
  // adapterDeliveryId は adapter が自由に採番する値なので、被害者の fingerprint を名乗る event を
  // 先に送ると、本物が診断ゼロの重複として消える
  const poison = reduceTaskWorkState(
    emptySnapshot(),
    startEvent({ eventId: "event-poison", adapterDeliveryId: "fingerprint-victim" }),
    new Map(),
  );
  assert.equal(poison.outcome, "applied");
  const victim = reduceTaskWorkState(
    poison.snapshot,
    startEvent({
      eventId: "event-victim",
      adapterDeliveryId: undefined,
      canonicalFingerprint: "fingerprint-victim",
      ingestSeq: "13",
      operation: { ...START_OPERATION, nativeOperationId: "toolu_victim" },
    }),
    poison.ledger,
  );
  assert.equal(victim.outcome, "applied");
  assert.equal(victim.snapshot.state.pendingOperations.length, 2);
});

test("同じ配送 ID で source hash が違う再配送は隔離する", () => {
  // §4.3「terminal は … payload/source hash が衝突しないこと」。重複として捨てると衝突検査が
  // 到達不能になり、訂正版の再配送も同じ鍵で消える
  const first = reduceTaskWorkState(emptySnapshot(), startEvent(), new Map());
  assert.equal(first.outcome, "applied");
  const conflicting = reduceTaskWorkState(
    first.snapshot,
    startEvent({ eventId: "event-start-corrupt", ingestSeq: "13", canonicalFingerprint: "fingerprint-other" }),
    first.ledger,
  );
  assert.equal(conflicting.outcome, "quarantined");
  assert.deepEqual(
    conflicting.diagnostics.map((d) => d.code),
    ["delivery_conflict"],
  );
  assert.equal(conflicting.ledger, first.ledger);
  // 同じ内容の再送はこれまでどおり重複 no-op
  const retry = reduceTaskWorkState(
    first.snapshot,
    startEvent({ eventId: "event-start-retry" }),
    first.ledger,
  );
  assert.equal(retry.outcome, "duplicate");
});

test("配送 ID が違えば別の論理 event として適用される", () => {
  // §8.2 の第一 authority は adapterDeliveryId。同じ fingerprint でも配送 ID が違えば
  // 「同一論理 event の再送」ではない
  const first = reduceTaskWorkState(emptySnapshot(), startEvent(), new Map());
  const other = startEvent({
    eventId: "event-start-2",
    adapterDeliveryId: "delivery-start-2",
    ingestSeq: "13",
    operation: { ...START_OPERATION, operationMatchKey: "match-key-2", nativeOperationId: "toolu_2" },
  });
  const second = reduceTaskWorkState(first.snapshot, other, first.ledger);
  assert.equal(second.outcome, "applied");
  assert.equal(second.snapshot.state.pendingOperations.length, 2);
});

test("適用は直前の状態を書き換えない", () => {
  const snapshot = emptySnapshot();
  deepFreeze(snapshot.state);
  const result = reduceTaskWorkState(snapshot, startEvent(), new Map());
  assert.equal(snapshot.state.pendingOperations.length, 0);
  assert.equal(result.snapshot.state.pendingOperations.length, 1);
  assert.notEqual(result.snapshot.state, snapshot.state);
});

test("別 lineage の event は適用しない", () => {
  assert.throws(
    () => reduceTaskWorkState(emptySnapshot(), startEvent({ taskLineageId: "lineage-2" }), new Map()),
    /別 lineage の event は適用しない/,
  );
  // lineage を持たない event は、還元先の状態の lineage に属するものとして扱う
  const result = reduceTaskWorkState(emptySnapshot(), startEvent({ taskLineageId: undefined }), new Map());
  assert.equal(result.snapshot.state.pendingOperations[0]?.correlation.taskLineageId, "lineage-1");
});

test("ledger を取り違えても同じ start が二重に pending へ入らない", () => {
  // 台帳と状態がずれた（復元・移送）ときの最後の砦。operationId が同じなら追加しない
  const first = reduceTaskWorkState(emptySnapshot(), startEvent(), new Map());
  const again = reduceTaskWorkState(first.snapshot, startEvent(), new Map());
  assert.equal(again.snapshot.state.pendingOperations.length, 1);
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["duplicate_operation_start"],
  );
});

// --- §3.1 operation envelope ------------------------------------------------

test("operation event に envelope が無ければ schema violation", () => {
  assert.throws(
    () => assertOperationEnvelope(startEvent({ operation: undefined })),
    /operation envelope が無い/,
  );
  assert.throws(
    () => reduceTaskWorkState(emptySnapshot(), startEvent({ operation: undefined }), new Map()),
    /operation envelope が無い/,
  );
});

test("kind と envelope の phase がずれていれば schema violation", () => {
  assert.throws(
    () => assertOperationEnvelope(startEvent({ operation: TERMINAL_OPERATION })),
    /phase は start だが envelope は terminal/,
  );
});

test("operation 系でない既知の kind が envelope を持てば schema violation", () => {
  assert.throws(
    () => assertOperationEnvelope(startEvent({ kind: "session_started" })),
    /operation 系でない kind/,
  );
});

test("envelope を要求しない kind は素通りする", () => {
  // 締めすぎの確認: 非 operation kind（envelope 無し）と、語彙外の adapter 固有 kind は通る
  assertOperationEnvelope(startEvent({ kind: "session_started", operation: undefined }));
  assertOperationEnvelope(startEvent({ kind: "adapter_specific_kind" }));
  assertOperationEnvelope(startEvent({ kind: "adapter_specific_kind", operation: undefined }));
});

test("envelope の必須値が空なら schema violation", () => {
  assert.throws(
    () => assertOperationEnvelope(startEvent({ operation: { ...START_OPERATION, operationKind: "" } })),
    /operationMatchKey \/ operationKind が空/,
  );
});

// --- §3.1 turn identity -----------------------------------------------------

test("envelope の任意欄が空文字なら schema violation", () => {
  // schema は maxLength しか持たないので空文字が届く。空文字を「値がある」と読むと、rule 1 が
  // native ID を持たない operation 同士を全部同じものとして照合する
  assert.throws(
    () => assertOperationEnvelope(startEvent({ operation: { ...START_OPERATION, nativeOperationId: "" } })),
    /nativeOperationId \/ canonicalInputHash が空文字/,
  );
  assert.throws(
    () => assertOperationEnvelope(startEvent({ operation: { ...START_OPERATION, canonicalInputHash: "" } })),
    /nativeOperationId \/ canonicalInputHash が空文字/,
  );
  // 欄そのものが無いのは正しい形
  assertOperationEnvelope(
    startEvent({ operation: { ...START_OPERATION, nativeOperationId: undefined, canonicalInputHash: undefined } }),
  );
});

test("turnIdSource と turnId の有無が食い違えば schema violation", () => {
  assert.throws(
    () => assertTurnIdentity(startEvent({ turnId: undefined })),
    /turnIdSource が native なのに turnId が無い/,
  );
  assert.throws(
    () => assertTurnIdentity(startEvent({ turnIdSource: "unavailable" })),
    /unavailable なのに turnId がある/,
  );
  assert.throws(
    () => reduceTaskWorkState(emptySnapshot(), startEvent({ turnId: undefined }), new Map()),
    /turnId が無い/,
  );
});

test("turn 同一性の 3 通りの正しい組み合わせは通る", () => {
  assertTurnIdentity(startEvent());
  assertTurnIdentity(startEvent({ turnIdSource: "synthesized_monotonic", turnId: "turn-7" }));
  assertTurnIdentity(startEvent({ turnIdSource: "unavailable", turnId: undefined }));
});

// --- §3.1 intake ------------------------------------------------------------

test("native の条件を満たす event は native のまま", () => {
  assert.equal(stampIntakeEvidence(startEvent(), INTAKE).event.provenance.evidenceKind, "native");
});

test("native の条件を 1 つでも欠けば synthesized へ落ちる", () => {
  const cases: Array<[string, NormalizedContinuityEvent]> = [

    [
      "capabilityHash が active と違う",
      startEvent({ provenance: { ...startEvent().provenance, capabilityHash: "0".repeat(64) } }),
    ],
    [
      "scenarioId が proven でない",
      startEvent({ provenance: { ...startEvent().provenance, scenarioId: "not-proven" } }),
    ],
    [
      "captureMethod が proven の組と違う",
      startEvent({ provenance: { ...startEvent().provenance, captureMethod: "hook" } }),
    ],
    [
      "sourceAgentVersion が exact でない",
      startEvent({ provenance: { ...startEvent().provenance, sourceAgentVersion: "2.1.228" } }),
    ],
    // `sourceAgent` の食い違いはここには無い。降格ではなく intake が受け取らないため
    // （scope selector なので降格では縛れない。→「認証済み peer と違う Agent 名を…」）
  ];
  for (const [label, event] of cases) {
    assert.equal(stampIntakeEvidence(event, INTAKE).event.provenance.evidenceKind, "synthesized", label);
  }
  // 認証されていない経路（受領証を出せない）でも native にならない
  const unauthenticated: IntakeContextV1 = { ...INTAKE, attestation: undefined };
  assert.equal(stampIntakeEvidence(startEvent(), unauthenticated).event.provenance.evidenceKind, "synthesized");
  // channel は intake の受領証側の値で判定する。proven の組に無い channel なら native にならない
  const spool: IntakeContextV1 = { ...INTAKE, attestation: { ...ATTESTATION, channel: "spool" } };
  assert.equal(stampIntakeEvidence(startEvent(), spool).event.provenance.evidenceKind, "synthesized");
});

test("caller の ingestAttestation は読まずに intake の受領証で置き換える", () => {
  const forged = startEvent({
    provenance: {
      ...startEvent().provenance,
      ingestAttestation: {
        ingestReceiptId: "forged-receipt",
        peerIdentityId: "attacker",
        channel: "rpc",
        attestedAt: "2026-08-16T00:00:01Z",
      },
    },
  });
  // 認証済み経路: 受領証は intake のものに差し替わる
  const stamped = stampIntakeEvidence(forged, INTAKE).event;
  assert.deepEqual(stamped.provenance.ingestAttestation, ATTESTATION);
  // 認証されていない経路: 名乗った受領証ごと落ちる
  const unauthenticated = stampIntakeEvidence(forged, { ...INTAKE, attestation: undefined }).event;
  assert.equal(unauthenticated.provenance.ingestAttestation, undefined);
  assert.equal(unauthenticated.provenance.evidenceKind, "synthesized");
});

test("capability matrix が無い daemon では native を与えない", () => {
  // 空文字同士は「一致」ではない。matrix が未整備（activeCapabilityHash が空）の daemon で
  // caller も空を名乗ると、§3.1 の「active exact-version capability matrix hash と等しいこと」を
  // 満たしていないのに native が成立してしまう
  const result = stampIntakeEvidence(
    startEvent({
      provenance: { ...startEvent().provenance, capabilityHash: "" },
    }),
    { ...INTAKE, activeCapabilityHash: "" },
  );
  assert.equal(result.event.provenance.evidenceKind, "synthesized");
});

test("§3.1 の必須 negative: capability hash を写した native 主張は hook/spool 経路で synthesized になる", () => {
  const forged = startEvent({
    provenance: {
      ...startEvent().provenance,
      // caller は native を主張し、正しい capability hash と proven な scenarioId を写している
      evidenceKind: "native",
      captureMethod: "hook",
      ingestAttestation: { ...startEvent().provenance.ingestAttestation!, channel: "spool" },
    },
  });
  assert.equal(stampIntakeEvidence(forged, INTAKE).event.provenance.evidenceKind, "synthesized");
});

// --- §4.3 terminal correlation ---------------------------------------------

function startedSnapshot(event = startEvent()): TaskWorkStateSnapshotV1 {
  return reduceTaskWorkState(emptySnapshot(), event, new Map()).snapshot;
}

test("nativeOperationId 一致で terminal が閉じる", () => {
  const snapshot = startedSnapshot();
  const correlation = correlateTerminalEvent(snapshot, terminalEvent());
  if (correlation.matched === null) assert.fail(`照合されなかった: ${correlation.detail}`);
  assert.equal(correlation.rule, "native_operation_id");

  const closed = reduceTaskWorkState(snapshot, terminalEvent(), new Map());
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "succeeded");
  assert.equal(closed.snapshot.state.pendingOperations[0]?.terminalAt, "2026-08-16T00:00:02Z");
  assert.deepEqual(closed.diagnostics, []);
});

test("nativeOperationId が無ければ operationMatchKey + turn で閉じる", () => {
  const start = startEvent({ operation: { phase: "start", operationMatchKey: "match-key-1", operationKind: "Bash" } });
  const snapshot = startedSnapshot(start);
  const terminal = terminalEvent({
    operation: { phase: "terminal", operationMatchKey: "match-key-1", operationKind: "Bash" },
  });
  const correlation = correlateTerminalEvent(snapshot, terminal);
  if (correlation.matched === null) assert.fail(`照合されなかった: ${correlation.detail}`);
  assert.equal(correlation.rule, "match_key");
});

test("turn が確立していない terminal は rule 2 で閉じない", () => {
  const start = startEvent({
    turnId: undefined,
    turnIdSource: "unavailable",
    operation: { phase: "start", operationMatchKey: "match-key-1", operationKind: "Bash" },
  });
  const snapshot = startedSnapshot(start);
  const terminal = terminalEvent({
    turnId: undefined,
    turnIdSource: "unavailable",
    operation: { phase: "terminal", operationMatchKey: "match-key-1", operationKind: "Bash" },
  });
  const correlation = correlateTerminalEvent(snapshot, terminal);
  assert.equal(correlation.matched, null);
});

test("open な候補が複数ある matchKey 一致は閉じない", () => {
  const first = startEvent({
    operation: { phase: "start", operationMatchKey: "match-key-1", operationKind: "Bash" },
  });
  const second = startEvent({
    eventId: "event-start-2",
    adapterDeliveryId: "delivery-start-2",
    ingestSeq: "13",
    operation: { phase: "start", operationMatchKey: "match-key-1", operationKind: "Bash" },
  });
  const { snapshot } = apply(emptySnapshot(), [first, second]);
  assert.equal(snapshot.state.pendingOperations.length, 2);
  const terminal = terminalEvent({
    ingestSeq: "14",
    operation: { phase: "terminal", operationMatchKey: "match-key-1", operationKind: "Bash" },
  });
  const result = reduceTaskWorkState(snapshot, terminal, new Map());
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_ambiguous"],
  );
  assert.deepEqual(
    result.snapshot.state.pendingOperations.map((p) => p.status),
    ["unknown", "unknown"],
  );
});

test("session が違う terminal は閉じない", () => {
  const snapshot = startedSnapshot();
  const result = reduceTaskWorkState(snapshot, terminalEvent({ sessionId: "session-2" }), new Map());
  assert.equal(result.outcome, "quarantined");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_orphaned"],
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "started");
});

test("権威順序で start より前の terminal は閉じず、候補を unknown にする", () => {
  const snapshot = startedSnapshot();
  const result = reduceTaskWorkState(snapshot, terminalEvent({ ingestSeq: "11" }), new Map());
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_out_of_order"],
  );
  // terminal 証跡が来ている以上「まだ走っている」とは言えない。§4.3 の「閉じられない terminal は
  // 候補を unknown にする」に倒す（started のままにすると実行中だと主張することになる）
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "unknown");
});

test("turn 同一性が無い terminal は閉じず、候補を unknown にする", () => {
  // §4.3「どちらかが unavailable のとき rule 2 は適用されず、operation は unknown のままになる」
  const snapshot = startedSnapshot();
  const terminal = terminalEvent({
    turnIdSource: "unavailable",
    turnId: undefined,
    operation: { ...TERMINAL_OPERATION, nativeOperationId: undefined },
  });
  const result = reduceTaskWorkState(snapshot, terminal, new Map());
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_unmatched"],
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "unknown");
});

test("turn 同一性が無くても rule 1 なら閉じられる", () => {
  // 上と同じ event で nativeOperationId だけ残す。unknown 化が turn 不一致に効いていることを、
  // 「閉じられる側」でも確かめる（両方 unknown になるなら gate の意味が無い）
  const snapshot = startedSnapshot();
  const result = reduceTaskWorkState(
    snapshot,
    terminalEvent({ turnIdSource: "unavailable", turnId: undefined }),
    new Map(),
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "succeeded");
});

/** pendingOperations を schema 上限まで埋めた状態。`resolveFirst` で先頭だけ terminal 済みにする。 */
function filledSnapshot(resolveFirst: boolean): TaskWorkStateSnapshotV1 {
  const template = startedSnapshot().state.pendingOperations[0] as PendingOperation;
  const pendingOperations = Array.from({ length: CONTINUITY_LIMITS.arrayItems }, (_, index) => ({
    ...template,
    operationId: `op-${index}`,
    // nativeOperationId は本物の呼び出しごとに一意（同じ値を並べると再配送に見える）
    correlation: { ...template.correlation, operationId: `op-${index}`, nativeOperationId: `toolu_filled_${index}` },
    status: resolveFirst && index === 0 ? ("succeeded" as const) : ("started" as const),
  }));
  return emptySnapshot({ pendingOperations });
}

test("pendingOperations が上限のとき terminal 済みを落として新しい start を入れる", () => {
  const snapshot = filledSnapshot(true);
  const result = reduceTaskWorkState(snapshot, startEvent(), new Map());
  assert.equal(result.outcome, "applied");
  assert.equal(result.snapshot.state.pendingOperations.length, CONTINUITY_LIMITS.arrayItems);
  // 落ちたのは terminal 済みの op-0 だけ
  assert.equal(
    result.snapshot.state.pendingOperations.some((p) => p.operationId === "op-0"),
    false,
  );
  // 黙って落とさない
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["pending_operations_evicted"],
  );
  assert.match(result.diagnostics[0]?.detail ?? "", /op-0/);
});

test("退避した operation の順序材料も落とす", () => {
  // pendingOperations が 256 件で頭打ちの一方、operationStarts だけ単調増加すると
  // 権威順序の判定表がメモリを食い続ける
  const snapshot = filledSnapshot(true);
  const seeded: TaskWorkStateSnapshotV1 = {
    ...snapshot,
    operationStarts: new Map(
      snapshot.state.pendingOperations.map((pending) => [
        pending.operationId,
        { ingestSeq: "1", turnIdSource: "native" as const },
      ]),
    ),
  };
  const result = reduceTaskWorkState(seeded, startEvent(), new Map());
  assert.equal(result.snapshot.operationStarts.size, CONTINUITY_LIMITS.arrayItems);
  assert.equal(result.snapshot.operationStarts.has("op-0"), false);
});

test("rule 1 の nativeOperationId に複数当たるなら、どれも閉じない", () => {
  // 凍結 schema は `nativeOperationId` にも一意性を課さないので、復元した checkpoint には
  // 同じ native id の確定済みと live が並びうる。§4.3 の rule 1 は「exact nativeOperationId +
  // 同じ session/lineage」で operation を一意に指す規則なので、2 件当たったら指せていない。
  // 件数を見ずに open だけで選ぶと、確定済み operation 宛ての再配送が live な兄弟を閉じる
  const pending = (operationId: string, status: "started" | "succeeded"): PendingOperation =>
    ({
      operationId,
      correlation: {
        operationId, startEventId: `s-${operationId}`, nativeOperationId: START_OPERATION.nativeOperationId,
        operationMatchKey: START_OPERATION.operationMatchKey, sessionId: "session-1",
        taskLineageId: "lineage-1", turnId: "turn-1", toolName: "Bash",
        canonicalInputHash: START_OPERATION.canonicalInputHash,
      },
      kind: "tool", description: "Bash", status, replayPolicy: "never_auto",
      sourceEventIds: [`s-${operationId}`], startedAt: "2026-08-16T00:00:01Z", sensitivity: "normal",
    }) as unknown as PendingOperation;
  const snapshotOf = (...operations: PendingOperation[]): TaskWorkStateSnapshotV1 => ({
    state: emptyState({ pendingOperations: operations }),
    history: [],
    // live 側の start 材料も入れて、順序が確認できる = 閉じられる状態にしておく
    operationStarts: new Map(operations.map((p) => [p.operationId, { ingestSeq: "1", turnIdSource: "native" as const }])),
  });
  const mixed = reduceTaskWorkState(
    snapshotOf(pending("op-settled", "succeeded"), pending("op-live", "started")),
    terminalEvent(),
    new Map(),
  );
  assert.deepEqual(mixed.diagnostics.map((d) => d.code), ["terminal_ambiguous"]);
  // live 側が「閉じられた」ことにならない。§4.3 どおり candidates は unknown まで
  assert.deepEqual(
    mixed.snapshot.state.pendingOperations.map((p) => `${p.operationId}:${p.status}`),
    ["op-settled:succeeded", "op-live:unknown"],
  );
  // 通す側も測る: 全件確定済みなら従来どおり「適用済み」で、曖昧扱いに変わらない
  const settled = reduceTaskWorkState(
    snapshotOf(pending("op-a", "succeeded"), pending("op-b", "succeeded")),
    terminalEvent(),
    new Map(),
  );
  assert.deepEqual(settled.diagnostics.map((d) => d.code), ["terminal_already_applied"]);
});

test("再配送 start が turn の種別をすり替えたら隔離する", () => {
  // `turnIdSource` は turn 同一性の一部なのに凍結 `OperationCorrelationV1` の外にしか無いので、
  // `turnId` の比較では見えない。重複として台帳に入れると記録は元の種別のまま残り、再配送側の
  // 種別で来た terminal は rule 2 の候補選びで落ちて unknown に倒れる（証跡が失われ鍵も消費済み）
  const started = startedSnapshot(startEvent({ operation: MATCH_KEY_ONLY, turnIdSource: "native" }));
  const switched = reduceTaskWorkState(
    started,
    startEvent({ operation: MATCH_KEY_ONLY, turnIdSource: "synthesized_monotonic", ingestSeq: "13" }),
    new Map(),
  );
  assert.equal(switched.outcome, "quarantined");
  assert.deepEqual(switched.diagnostics.map((d) => d.code), ["start_conflict"]);
  assert.equal(switched.snapshot.operationStarts.get(
    started.state.pendingOperations[0]?.operationId as string,
  )?.turnIdSource, "native");
});

/** 上限まで埋めた状態のうち index 1 を index 0 と同名にする（frozen schema は一意性を課さない）。 */
function collidedFilledSnapshot(): TaskWorkStateSnapshotV1 {
  const snapshot = filledSnapshot(true);
  const pendingOperations = snapshot.state.pendingOperations.map((pending, index) =>
    index === 1
      ? { ...pending, operationId: "op-0", correlation: { ...pending.correlation, operationId: "op-0" } }
      : pending,
  );
  return { ...snapshot, state: { ...snapshot.state, pendingOperations } };
}

test("状態側で operationId が衝突していても退避は必要な件数しか落とさない", () => {
  // 落とす相手を `operationId` の集合で持つと、1 件分の枠を空けるつもりで同名の兄弟まで
  // まとめて消える。上限に収めるのが目的なのに、上限を下回ってなお生きている operation が消える
  const result = reduceTaskWorkState(collidedFilledSnapshot(), startEvent(), new Map());
  assert.equal(result.outcome, "applied");
  assert.equal(result.snapshot.state.pendingOperations.length, CONTINUITY_LIMITS.arrayItems);
  // 落ちたのは terminal 済みの 1 件だけで、同名の started な兄弟は残る
  const survivors = result.snapshot.state.pendingOperations.filter((p) => p.operationId === "op-0");
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0]?.status, "started");
});

test("同名の兄弟が残っているなら退避で順序材料を消さない", () => {
  // `operationStarts` の鍵は `operationId` なので、退避した側の id で消すと生きている
  // 兄弟の順序材料まで落ち、次の terminal が terminal_order_unverifiable で unknown に倒れる
  const snapshot = collidedFilledSnapshot();
  const seeded: TaskWorkStateSnapshotV1 = {
    ...snapshot,
    operationStarts: new Map(
      snapshot.state.pendingOperations.map((pending) => [
        pending.operationId,
        { ingestSeq: "1", turnIdSource: "native" as const },
      ]),
    ),
  };
  const result = reduceTaskWorkState(seeded, startEvent(), new Map());
  assert.equal(result.snapshot.operationStarts.has("op-0"), true);
});

test("上限に余裕があるときは退避の診断を出さない", () => {
  const result = reduceTaskWorkState(emptySnapshot(), startEvent(), new Map());
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.state.pendingOperations.length, 1);
});

test("proven でない version の native turn 主張は unavailable へ降格する", () => {
  // §3.1「turnIdSource=native は exact version について proven な native turn identifier を要求する」
  const unproven: IntakeContextV1 = { ...INTAKE, nativeTurnIdentityProven: false };
  const downgrade = stampIntakeEvidence(startEvent(), unproven);
  const stamped = downgrade.event;
  assert.equal(stamped.turnIdSource, "unavailable");
  assert.equal(stamped.turnId, undefined);
  assertTurnIdentity(stamped);
  // §3.1「downgrade の理由は doctor が報告する」。黙って降格しない
  assert.deepEqual(
    downgrade.diagnostics.map((d) => d.code),
    ["turn_identity_downgraded"],
  );

  // 降格した start は rule 2 で閉じられない（自作の turnId で turn 両立を満たせない）
  const snapshot = startedSnapshot(stamped);
  const terminal = stampIntakeEvidence(
    terminalEvent({ operation: { ...TERMINAL_OPERATION, nativeOperationId: undefined } }),
    unproven,
  ).event;
  const result = reduceTaskWorkState(snapshot, terminal, new Map());
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_unmatched"],
  );
});

test("証明は version に紐づく: 認証されない名乗りは native turn を保てない", () => {
  // nativeTurnIdentityProven は「その exact version について」の事実なので、
  // その version であること自体が認証されていない event には適用できない
  const cases: ReadonlyArray<readonly [string, NormalizedContinuityEvent, IntakeContextV1]> = [
    [
      "version が exact でない",
      startEvent({ provenance: { ...startEvent().provenance, sourceAgentVersion: "2.1.228" } }),
      INTAKE,
    ],
    // Agent 名の食い違いはここには無い（intake が受け取らないので降格の対象にならない）。
    // 認証できない経路として残るのは「受領証側が Agent を名乗っていない」形
    ["受領証が Agent を名乗らない", startEvent(), { ...INTAKE, expectedSourceAgent: "" }],
    ["受領証を出せない経路", startEvent(), { ...INTAKE, attestation: undefined }],
  ];
  for (const [label, event, context] of cases) {
    const stamped = stampIntakeEvidence(event, context).event;
    assert.equal(stamped.turnIdSource, "unavailable", label);
    assert.equal(stamped.turnId, undefined, label);
    assertTurnIdentity(stamped);
  }
});

test("proven な version の native turn 主張と adapter 側の monotonic turn は触らない", () => {
  // 降格が「native を名乗る全部」を潰していないことを、通るべき側で確かめる
  assert.equal(stampIntakeEvidence(startEvent(), INTAKE).event.turnIdSource, "native");
  assert.equal(stampIntakeEvidence(startEvent(), INTAKE).event.turnId, "turn-1");
  const monotonic = startEvent({ turnIdSource: "synthesized_monotonic", turnId: "turn-7" });
  const unproven: IntakeContextV1 = { ...INTAKE, nativeTurnIdentityProven: false };
  assert.equal(stampIntakeEvidence(monotonic, unproven).event.turnIdSource, "synthesized_monotonic");
  assert.equal(stampIntakeEvidence(monotonic, unproven).event.turnId, "turn-7");
  // capabilityHash の不一致は evidence を降格させるが turn は降格させない。capability matrix に
  // turn identity の cell が無い（#40）ので、hash は turn について何も語らないため
  const staleHash = startEvent({
    provenance: { ...startEvent().provenance, capabilityHash: `sha256:${"5".repeat(64)}` },
  });
  assert.equal(stampIntakeEvidence(staleHash, INTAKE).event.provenance.evidenceKind, "synthesized");
  assert.equal(stampIntakeEvidence(staleHash, INTAKE).event.turnIdSource, "native");
});

test("terminal 済みが無くても start は取り込む（枠が埋まっても詰まらせない）", () => {
  // 落とせるものが無いとき隔離すると、unknown を消す経路が他に無いので枠が永久に埋まり、
  // 以後どの tool 呼び出しも記録できなくなる（訂正版の無い隔離を adapter が再送し続ける）
  const snapshot = filledSnapshot(false);
  const result = reduceTaskWorkState(snapshot, startEvent(), new Map());
  assert.equal(result.outcome, "applied");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["pending_operations_evicted"],
  );
  assert.equal(result.snapshot.state.pendingOperations.length, CONTINUITY_LIMITS.arrayItems);
  // 落とすのは最古の 1 件だけで、新しい start は必ず入る
  assert.equal(result.snapshot.state.pendingOperations.at(-1)?.correlation.startEventId, "event-start");
  assert.equal(
    result.snapshot.state.pendingOperations.some(
      (pending) => pending.operationId === snapshot.state.pendingOperations[0]?.operationId,
    ),
    false,
  );
});

test("canonicalInputHash が食い違う terminal は隔離する", () => {
  const snapshot = startedSnapshot();
  const conflicting = terminalEvent({
    operation: { ...TERMINAL_OPERATION, canonicalInputHash: "input-hash-other" },
  });
  const ledger: IdempotencyLedger = new Map();
  const result = reduceTaskWorkState(snapshot, conflicting, ledger);
  assert.equal(result.outcome, "quarantined");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_conflict"],
  );
  // 状態も台帳も動かない。動かすと訂正版の再配送が重複 no-op として捨てられる
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.ledger, ledger);
  assert.equal(result.ledger.size, 0);
  assert.equal(result.snapshot.history.length, snapshot.history.length);
});

test("turnIdSource の種別が違えば rule 2 では閉じない", () => {
  const start = startEvent({
    operation: { phase: "start", operationMatchKey: "match-key-1", operationKind: "Bash" },
  });
  const snapshot = startedSnapshot(start);
  const terminal = terminalEvent({
    turnIdSource: "synthesized_monotonic",
    operation: { phase: "terminal", operationMatchKey: "match-key-1", operationKind: "Bash" },
  });
  const result = reduceTaskWorkState(snapshot, terminal, new Map());
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_unmatched"],
  );
  // 理由は「turn 同一性が無い」ではなく「種別が違う」。§3.1 は降格の理由を doctor が
  // 報告することを求めているので取り違えない
  assert.match(result.diagnostics[0]?.detail ?? "", /turnIdSource/);
  // unknown に倒すのは種別が違う候補だけ。同じ matchKey で turn が違う open は巻き込まない
  const other = reduceTaskWorkState(
    snapshot,
    startEvent({
      eventId: "start-other", adapterDeliveryId: "d-other", canonicalFingerprint: "f-other", ingestSeq: "13",
      turnId: "turn-9",
      operation: { phase: "start", operationMatchKey: "match-key-1", operationKind: "Bash" },
    }),
    new Map(),
  );
  const scoped = reduceTaskWorkState(other.snapshot, terminal, other.ledger);
  assert.deepEqual(
    scoped.snapshot.state.pendingOperations.map((p) => p.status),
    ["unknown", "started"],
  );
});

test("確定済みの成否と矛盾する 2 度目の terminal は隔離する", () => {
  // 配送 ID が違う 2 通目は dedupe で内容を比べられず、identity 衝突検査も kind と input hash
  // しか見ないので、成否だけが逆の terminal が「適用済み」として黙って通っていた。受理済み
  // terminal の source hash は状態に持っていない（#43）が、確定した status は持っている
  const snapshot = startedSnapshot();
  const closed = reduceTaskWorkState(snapshot, terminalEvent(), new Map());
  const again = reduceTaskWorkState(
    closed.snapshot,
    terminalEvent({
      eventId: "event-terminal-2",
      adapterDeliveryId: "delivery-terminal-2",
      ingestSeq: "13",
      successful: false,
    }),
    closed.ledger,
  );
  assert.equal(again.outcome, "quarantined");
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["terminal_conflict"],
  );
  assert.equal(again.snapshot.state.pendingOperations[0]?.status, "succeeded");
  assert.equal(again.ledger, closed.ledger);
});

test("空文字の turnId は schema violation", () => {
  // schema は maxLength しか課さないので空文字が届く。「turn がある」と読むと §4.3 rule 2 の
  // turn 同一性が空文字同士で成立し、無関係な turn の operation を閉じる。unavailable な turn を
  // 全部空文字で表す adapter では、全 operation が 1 つの turn に潰れる
  assert.throws(() => reduceTaskWorkState(emptySnapshot(), startEvent({ turnId: "" }), new Map()), /turnId が空文字/);
  assert.throws(
    () =>
      reduceTaskWorkState(
        emptySnapshot(),
        startEvent({ turnIdSource: "synthesized_monotonic", turnId: "" }),
        new Map(),
      ),
    /turnId が空文字/,
  );
  // unavailable は従来どおり turnId 不在を要求する（空文字での代用も落ちる）
  assert.throws(
    () => reduceTaskWorkState(emptySnapshot(), startEvent({ turnIdSource: "unavailable", turnId: "" }), new Map()),
    /turnId がある/,
  );
});

test("空文字の eventId は schema violation", () => {
  // deriveOperationId(eventId, matchKey) の材料なので、空文字だと同じ turn の rule 2 の start が
  // 2 件とも同じ operationId になり、2 件目が duplicate_operation_start として消える
  assert.throws(
    () => reduceTaskWorkState(emptySnapshot(), startEvent({ eventId: "" }), new Map()),
    /eventId が空文字/,
  );
  assert.throws(
    () =>
      finalizeAbandonedState(
        startedSnapshot().state,
        startEvent({ eventId: "", kind: "session_ended", ingestSeq: "4", operation: undefined }),
        new Map(),
      ),
    /eventId が空文字/,
  );
});

test("空文字の sessionId は schema violation", () => {
  // 候補選びも放棄も session で絞るので、空文字だと session を特定できない adapter の event が
  // 全部同じ scope に入り、別 session の terminal が診断ゼロで operation を閉じる。
  // 実 ID なら terminal_orphaned で隔離される（control）
  assert.throws(
    () => reduceTaskWorkState(emptySnapshot(), startEvent({ sessionId: "" }), new Map()),
    /sessionId が空文字/,
  );
  const started = startedSnapshot(startEvent({ sessionId: "session-A" }));
  const crossSession = reduceTaskWorkState(
    started,
    terminalEvent({ sessionId: "session-B" }),
    new Map(),
  );
  assert.equal(crossSession.outcome, "quarantined");
  assert.deepEqual(
    crossSession.diagnostics.map((d) => d.code),
    ["terminal_orphaned"],
  );
});

test("構成要素が消えても sensitivity は下がらない", () => {
  // §10「sensitivity は構成要素 event の最大機密度を常に反映する」。集約値を実体に持たせる理由が
  // 「raw event の TTL 後には遡って判定できない」ことなので、構成要素が状態から消えても下げない
  // （retainPendingOperations の退避は保管上の都合で、機密でなくなった証跡ではない）
  const snapshot = emptySnapshot({ sensitivity: "secret" });
  assert.deepEqual(
    snapshot.state.activeFiles.filter((file) => file.sensitivity === "secret"),
    [],
  );
  const applied = reduceTaskWorkState(snapshot, startEvent(), new Map());
  assert.equal(applied.snapshot.state.sensitivity, "secret");
});

test("放棄の kind を reduceTaskWorkState に渡すと落ちる", () => {
  // operation envelope を持たないので汎用 commit に落ちて状態を変えないまま台帳の鍵だけを
  // 消費する。その台帳で finalizeAbandonedState を呼ぶと重複として捨てられ、放棄が永久に
  // 適用されない（operation が started のまま残って状態が嘘をつく）
  const abandon = startEvent({
    eventId: "event-abandon",
    adapterDeliveryId: "delivery-abandon",
    kind: "session_ended",
    ingestSeq: "12",
    operation: undefined,
  });
  assert.throws(
    () => reduceTaskWorkState(startedSnapshot(), abandon, new Map()),
    /finalizeAbandonedState に渡す/,
  );
  // 正しい入口に渡せば放棄は効く
  const finalized = finalizeAbandonedState(startedSnapshot().state, abandon, new Map());
  assert.equal(finalized.outcome, "applied");
  assert.equal(finalized.state.pendingOperations[0]?.status, "unknown");
});

test("閉じた operation に届いた自己矛盾 terminal も証跡の矛盾を出す", () => {
  // 矛盾は照合の成否と無関係な event 自身の性質。照合できた場合しか出さないと、同じ壊れた
  // adapter でも operation が既に閉じているときだけ terminal_already_applied に埋もれる
  const snapshot = startedSnapshot();
  const closed = reduceTaskWorkState(snapshot, terminalEvent(), new Map());
  const again = reduceTaskWorkState(
    closed.snapshot,
    terminalEvent({
      eventId: "event-terminal-2",
      adapterDeliveryId: "delivery-terminal-2",
      ingestSeq: "13",
      kind: "tool_failed",
      successful: true,
    }),
    closed.ledger,
  );
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["terminal_already_applied", "terminal_evidence_contradicts"],
  );
  assert.equal(again.snapshot.state.pendingOperations[0]?.status, "succeeded");
});

test("identity が一致する兄弟がいれば terminal を隔離しない", () => {
  // §4.3 どおりに matchKey を導出しない adapter では、同じ matchKey で input hash が違う
  // pending が並ぶ。兄弟の identity を根拠に隔離すると live な operation が永久に閉じない
  const first = startEvent({ eventId: "event-start-a", operation: MATCH_KEY_ONLY });
  const firstTerminal = terminalEvent({
    eventId: "event-terminal-a",
    adapterDeliveryId: "delivery-terminal-a",
    ingestSeq: "12",
    operation: { ...MATCH_KEY_ONLY, phase: "terminal" },
  });
  const second = startEvent({
    eventId: "event-start-b",
    adapterDeliveryId: "delivery-start-b",
    ingestSeq: "13",
    operation: { ...MATCH_KEY_ONLY, canonicalInputHash: "input-hash-2" },
  });
  // 1 件目を閉じてから 2 件目を積む。この順なら候補は「確定済み 1 + 未確定 1」になり、
  // 2 件目の terminal は rule 2 で一意に閉じられる（両方 open だと ambiguous で unknown に倒れる）
  const both = apply(emptySnapshot(), [first, firstTerminal, second]);
  assert.deepEqual(
    both.snapshot.state.pendingOperations.map((pending) => pending.status),
    ["succeeded", "started"],
  );

  const closed = reduceTaskWorkState(
    both.snapshot,
    terminalEvent({
      eventId: "event-terminal-b",
      adapterDeliveryId: "delivery-terminal-b",
      ingestSeq: "14",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal", canonicalInputHash: "input-hash-2" },
    }),
    both.ledger,
  );
  assert.deepEqual(
    closed.snapshot.state.pendingOperations.map((pending) => pending.status),
    ["succeeded", "succeeded"],
  );
  assert.deepEqual(closed.diagnostics, []);

  // どの候補とも identity が合わない terminal は従来どおり隔離する
  const alien = reduceTaskWorkState(
    both.snapshot,
    terminalEvent({
      eventId: "event-terminal-x",
      adapterDeliveryId: "delivery-terminal-x",
      ingestSeq: "15",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal", canonicalInputHash: "input-hash-9" },
    }),
    both.ledger,
  );
  assert.equal(alien.outcome, "quarantined");
  assert.deepEqual(
    alien.diagnostics.map((d) => d.code),
    ["terminal_conflict"],
  );
});

test("同じ成否を名乗る 2 度目の terminal は適用済みとして扱う", () => {
  const snapshot = startedSnapshot();
  const closed = reduceTaskWorkState(snapshot, terminalEvent(), new Map());
  const again = reduceTaskWorkState(
    closed.snapshot,
    terminalEvent({ eventId: "event-terminal-2", adapterDeliveryId: "delivery-terminal-2", ingestSeq: "13" }),
    closed.ledger,
  );
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["terminal_already_applied"],
  );
  assert.equal(again.snapshot.state.pendingOperations[0]?.status, "succeeded");
});

test("成否が違う兄弟が確定済みでも、成否が一致する再配送は隔離しない", () => {
  // rule 2 の候補は同じ matchKey の兄弟をまとめて拾う。同じ turn で同じ tool を同じ入力で
  // 2 回動かして成否が分かれると、片方の terminal の再配送がもう片方の成否を根拠に隔離される。
  // 隔離は台帳に入らないので adapter は無限再送になる
  const first = startEvent({ eventId: "event-start-a", operation: MATCH_KEY_ONLY });
  const firstTerminal = terminalEvent({
    eventId: "event-terminal-a",
    adapterDeliveryId: "delivery-terminal-a",
    ingestSeq: "12",
    operation: { ...MATCH_KEY_ONLY, phase: "terminal" },
  });
  const second = startEvent({ eventId: "event-start-b", adapterDeliveryId: "delivery-start-b", ingestSeq: "13", operation: MATCH_KEY_ONLY });
  const secondTerminal = terminalEvent({
    eventId: "event-terminal-b",
    adapterDeliveryId: "delivery-terminal-b",
    ingestSeq: "14",
    successful: false,
    kind: "tool_failed",
    operation: { ...MATCH_KEY_ONLY, phase: "terminal" },
  });
  const settled = apply(emptySnapshot(), [first, firstTerminal, second, secondTerminal]);
  assert.deepEqual(
    settled.snapshot.state.pendingOperations.map((pending) => pending.status),
    ["succeeded", "failed"],
  );

  const again = reduceTaskWorkState(
    settled.snapshot,
    terminalEvent({
      eventId: "event-terminal-a-2",
      adapterDeliveryId: "delivery-terminal-a-2",
      ingestSeq: "15",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal" },
    }),
    settled.ledger,
  );
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["terminal_already_applied"],
  );
  assert.deepEqual(
    again.snapshot.state.pendingOperations.map((pending) => pending.status),
    ["succeeded", "failed"],
  );
});

test("成否を主張しない 2 度目の terminal は矛盾ではない", () => {
  // unknown は「成否を主張していない」なので、確定済みの succeeded と矛盾しない。
  // 矛盾扱いにすると、成否を出さない adapter の再送が全部隔離されて無限再送になる
  const snapshot = startedSnapshot();
  const closed = reduceTaskWorkState(snapshot, terminalEvent(), new Map());
  const again = reduceTaskWorkState(
    closed.snapshot,
    terminalEvent({
      eventId: "event-terminal-3",
      adapterDeliveryId: "delivery-terminal-3",
      ingestSeq: "13",
      successful: undefined,
    }),
    closed.ledger,
  );
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["terminal_already_applied"],
  );
  assert.equal(again.snapshot.state.pendingOperations[0]?.status, "succeeded");
});

test("空の canonicalFingerprint は schema violation", () => {
  // dedupe authority は adapterDeliveryId、無ければ canonical fingerprint。空文字を「値がある」と
  // 読むと、配送 ID を持たない event が全部 1 つの鍵に潰れ、配送 ID を持つ event は台帳に
  // source hash 無しで載って訂正版が衝突検査を素通りする
  assert.throws(
    () => reduceTaskWorkState(emptySnapshot(), startEvent({ canonicalFingerprint: "" }), new Map()),
    /canonicalFingerprint が空文字/,
  );
  assert.throws(
    () =>
      finalizeAbandonedState(
        startedSnapshot().state,
        startEvent({ eventId: "event-abandon", kind: "session_ended", ingestSeq: "4", operation: undefined, canonicalFingerprint: "" }),
        new Map(),
      ),
    /canonicalFingerprint が空文字/,
  );
});

test("成否を主張しない terminal は unknown を確定する", () => {
  const snapshot = startedSnapshot();
  const result = reduceTaskWorkState(snapshot, terminalEvent({ successful: undefined }), new Map());
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "unknown");
});

test("失敗の terminal は failed を確定する", () => {
  const snapshot = startedSnapshot();
  const result = reduceTaskWorkState(
    snapshot,
    terminalEvent({ kind: "tool_failed", successful: false }),
    new Map(),
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "failed");
});

// --- §4.3 abandonment -------------------------------------------------------

test("放棄時に開いていた operation は unknown になり、元の状態は変わらない", () => {
  const snapshot = startedSnapshot();
  deepFreeze(snapshot.state);
  const abandonEvent = terminalEvent({
    eventId: "event-session-ended",
    kind: "session_ended",
    ingestSeq: "20",
    operation: undefined,
    successful: undefined,
  });
  const first = finalizeAbandonedState(snapshot.state, abandonEvent, new Map());
  const finalized = first.state;
  assert.equal(first.outcome, "applied");
  assert.equal(finalized.pendingOperations[0]?.status, "unknown");
  // 放棄も証跡を残す。何が unknown を確定させたかを状態から辿れるようにする
  assert.deepEqual(finalized.pendingOperations[0]?.sourceEventIds, [
    "event-start",
    "event-session-ended",
  ]);
  // 再実行の可否は放棄では緩めない
  assert.equal(finalized.pendingOperations[0]?.replayPolicy, "never_auto");
  assert.equal(snapshot.state.pendingOperations[0]?.status, "started");
  assert.notEqual(finalized.stateRevision, snapshot.state.stateRevision);
  assert.equal(finalized.lastIngestSeq, "20");

  // §4.2「重複した論理 event は no-op」。放棄経路も台帳を見る
  const again = finalizeAbandonedState(finalized, abandonEvent, first.ledger);
  assert.equal(again.outcome, "duplicate");
  assert.equal(again.state.stateRevision, finalized.stateRevision);
});

test("別 lineage の event では放棄を確定しない", () => {
  const snapshot = startedSnapshot();
  assert.throws(
    () =>
      finalizeAbandonedState(
        snapshot.state,
        terminalEvent({
          eventId: "event-session-ended",
          kind: "session_ended",
          taskLineageId: "lineage-2",
          ingestSeq: "20",
          operation: undefined,
          successful: undefined,
        }),
        new Map(),
      ),
    /別 lineage の event は適用しない/,
  );
});

test("放棄後に届いた terminal は元の operation を閉じる", () => {
  const snapshot = startedSnapshot();
  const abandoned = finalizeAbandonedState(
    snapshot.state,
    terminalEvent({
      eventId: "event-session-ended",
      kind: "session_ended",
      ingestSeq: "20",
      operation: undefined,
      successful: undefined,
    }),
    new Map(),
  ).state;
  const late = terminalEvent({ eventId: "event-terminal-late", ingestSeq: "30" });
  const result = reduceTaskWorkState(
    { ...snapshot, state: abandoned },
    late,
    new Map(),
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "succeeded");
  assert.equal(result.snapshot.state.pendingOperations[0]?.operationId, snapshot.state.pendingOperations[0]?.operationId);
});

// --- 集約値 -----------------------------------------------------------------

test("sensitivity は構成要素の最大を取る", () => {
  const snapshot = startedSnapshot();
  // pendingOperation が private なので集約も private
  assert.equal(snapshot.state.sensitivity, "private");

  const withSecret = emptySnapshot({
    recentCommands: [
      {
        operationId: "op-secret",
        commandDisplay: "redacted",
        status: "unknown",
        sourceEventIds: ["event-x"],
        observedAt: "2026-08-16T00:00:00Z",
        evidenceKind: "native",
        sensitivity: "secret",
      },
    ],
  });
  const result = reduceTaskWorkState(withSecret, startEvent(), new Map());
  assert.equal(result.snapshot.state.sensitivity, "secret");
});

test("語彙外の sensitivity は最上位に倒す", () => {
  // indexOf の -1 をそのまま順位に使うと最下位（normal）に落ちる = fail open。
  // 語彙外は「機密度不明」なので、自動 resume を止める側へ倒す
  const foreign = emptySnapshot({
    recentCommands: [
      {
        operationId: "op-foreign",
        commandDisplay: "redacted",
        status: "unknown",
        sourceEventIds: ["event-x"],
        observedAt: "2026-08-16T00:00:00Z",
        evidenceKind: "native",
        sensitivity: "top-secret" as never,
      },
    ],
  });
  const result = reduceTaskWorkState(foreign, startEvent(), new Map());
  assert.equal(result.snapshot.state.sensitivity, "secret");
});

test("optional が全部無い状態も hash できる", () => {
  // canonicalizeJson は undefined を拒否する。欠けている optional を undefined のまま
  // 載せていないことの確認
  const { stateRevision: _revision, ...content } = emptyState();
  assert.match(contentHashOf(content), /^[0-9a-f]{64}$/);
});

// --- fixture parity ---------------------------------------------------------

interface ReductionFixture {
  intakeContext: IntakeContextV1;
  initialState: CanonicalWorkStateV1;
  events: NormalizedContinuityEvent[];
  expected: Array<{
    eventId: string;
    evidenceKind: string;
    outcome: string;
    contentHash: string;
    stateRevision: string;
    historyLength: number;
    pendingStatuses: string[];
    diagnostics: string[];
  }>;
}

interface RejectionFixture {
  intakeContext: IntakeContextV1;
  cases: Array<{
    name: string;
    rejectedBy: "schema" | "runtime" | "intake" | "intake-reject";
    reason: string;
    intakeOverride?: Partial<IntakeContextV1>;
    event: NormalizedContinuityEvent;
  }>;
}

test("negative fixture は宣言した層で落ちる", () => {
  const fixture = readIJsonFile<RejectionFixture>(
    new URL("../fixtures/continuity/invalid/rejected-events.json", import.meta.url),
  );
  assert.equal(fixture.cases.length > 0, true);
  const layers = new Set<string>();
  for (const testCase of fixture.cases) {
    layers.add(testCase.rejectedBy);
    const issues = validateContractValue(
      "NormalizedContinuityEvent",
      testCase.event,
      SCHEMA_ROOT,
      CONTINUITY_LIMITS,
    );
    if (testCase.rejectedBy === "schema") {
      assert.notEqual(issues.length, 0, testCase.name);
      continue;
    }
    // #29 の前提: 残りは schema では落ちない。落ちるようになったら runtime 側の検査が
    // 要らなくなるので、その事実ごと壊れるべき
    assert.deepEqual(issues, [], testCase.name);
    if (testCase.rejectedBy === "runtime") {
      assert.throws(
        () => reduceTaskWorkState(emptySnapshot(), asStamped(testCase.event), new Map()),
        /§3.1 違反/,
        testCase.name,
      );
      continue;
    }
    const context = { ...fixture.intakeContext, ...testCase.intakeOverride };
    // intake は 2 通りの落とし方をする。降格（証跡の質が足りない）と、受け取らない
    // （名乗っている identity が認証済み peer と矛盾する）。fixture でこの 2 つを区別しないと、
    // 降格しか実装しない移植でも fixture が緑になる
    if (testCase.rejectedBy === "intake-reject") {
      assert.throws(() => stampIntakeEvidence(testCase.event, context), /§3.1 違反/, testCase.name);
      continue;
    }
    assert.equal(
      stampIntakeEvidence(testCase.event, context).event.provenance.evidenceKind,
      "synthesized",
      testCase.name,
    );
  }
  assert.deepEqual([...layers].sort(), ["intake", "intake-reject", "runtime", "schema"]);

  // fixture の intakeContext に欠落があると、何をしても synthesized になって intake の case が
  // 素通りする。正当な経路なら native になることを対で確かめる
  const intakeCase = fixture.cases.find((testCase) => testCase.rejectedBy === "intake");
  if (intakeCase === undefined) assert.fail("intake の case が無い");
  const repaired: NormalizedContinuityEvent = {
    ...intakeCase.event,
    provenance: { ...intakeCase.event.provenance, captureMethod: "native_event" },
  };
  assert.equal(stampIntakeEvidence(repaired, fixture.intakeContext).event.provenance.evidenceKind, "native");
});

test("fixture の期待値は参照実装の出力と一致する（TS/Rust parity の基準）", () => {
  const fixture = readIJsonFile<ReductionFixture>(
    new URL("../fixtures/continuity/tool-lifecycle-reduction.json", import.meta.url),
  );
  let snapshot: TaskWorkStateSnapshotV1 = {
    state: fixture.initialState,
    history: [],
    operationStarts: new Map(),
  };
  let ledger: IdempotencyLedger = new Map();
  const actual = fixture.events.map((raw) => {
    const event = stampIntakeEvidence(raw, fixture.intakeContext).event;
    const result = reduceTaskWorkState(snapshot, event, ledger);
    snapshot = result.snapshot;
    ledger = result.ledger;
    return {
      eventId: event.eventId,
      evidenceKind: event.provenance.evidenceKind,
      outcome: result.outcome,
      contentHash: result.contentHash,
      stateRevision: result.snapshot.state.stateRevision,
      historyLength: result.snapshot.history.length,
      pendingStatuses: result.snapshot.state.pendingOperations.map((p) => p.status),
      diagnostics: result.diagnostics.map((d) => d.code),
    };
  });
  assert.deepEqual(actual, fixture.expected);
  assert.equal(fixture.expected.length > 0, true);
});

// --- code-review 指摘の回帰（51a339c で実測された経路） ----------------------

test("還元後の状態は凍結 schema に適合する（terminal が何度届いても）", () => {
  // successful を持たない terminal は unknown を確定するが、unknown は open のままなので
  // 同じ operation に何度でも再照合される。上限を見ずに append すると、還元器自身が
  // sourceEventIds 256 件超の状態を出して parity の基準にならなくなる
  let snapshot = startedSnapshot();
  let ledger: IdempotencyLedger = new Map();
  let truncations = 0;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = reduceTaskWorkState(
      snapshot,
      terminalEvent({
        eventId: `event-terminal-${attempt}`,
        adapterDeliveryId: `delivery-terminal-${attempt}`,
        ingestSeq: `${100 + attempt}`,
        successful: undefined,
      }),
      ledger,
    );
    snapshot = result.snapshot;
    ledger = result.ledger;
    truncations += result.diagnostics.filter((d) => d.code === "source_events_truncated").length;
  }
  const pending = snapshot.state.pendingOperations[0] as PendingOperation;
  assert.equal(pending.status, "unknown");
  assert.equal(pending.sourceEventIds.length, CONTINUITY_LIMITS.arrayItems);
  // 黙って捨てない
  assert.ok(truncations > 0);
  assert.deepEqual(
    validateContractValue("CanonicalWorkStateV1", snapshot.state, SCHEMA_ROOT, CONTINUITY_LIMITS),
    [],
  );
});

test("別 Agent の event は状態に適用しない", () => {
  // OperationCorrelationV1 は Agent を持たず、scope は sessionId + taskLineageId だけ。
  // ここで束縛しないと、同じ session に居る別 Agent の terminal が他人の operation を閉じる
  const snapshot = startedSnapshot();
  assert.throws(
    () => reduceTaskWorkState(snapshot, terminalEvent({ sourceAgent: "codex" }), new Map()),
    /別 Agent の event は適用しない/,
  );
  // 同じ Agent なら通る
  assert.equal(reduceTaskWorkState(snapshot, terminalEvent(), new Map()).outcome, "applied");
});

test("空の adapterDeliveryId は fingerprint へ落とす", () => {
  // schema は minLength を持たないので空文字が届きうる。throw すると adapter の 1 種類のバグで
  // event stream 全体が止まる
  assert.equal(idempotencyKeyOf(startEvent({ adapterDeliveryId: "" })), "fingerprint-start");
  assert.equal(idempotencyKeyOf(startEvent({ adapterDeliveryId: undefined })), "fingerprint-start");
  assert.throws(
    () => idempotencyKeyOf(startEvent({ adapterDeliveryId: "", canonicalFingerprint: "" })),
    /idempotency key が無い/,
  );
});

test("一致しない nativeOperationId を名乗る terminal は matchKey へ落ちない", () => {
  // rule 1 を名乗った以上 rule 1 で判定する。落とすと、別 operation を診断なしで閉じられる
  const snapshot = startedSnapshot();
  const stray = terminalEvent({
    operation: { ...TERMINAL_OPERATION, nativeOperationId: "toolu_other" },
    successful: false,
  });
  const result = reduceTaskWorkState(snapshot, stray, new Map());
  assert.equal(result.outcome, "quarantined");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_orphaned"],
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "started");
});

test("start より先に届いた terminal は台帳に入れない（後から start が来れば閉じられる）", () => {
  // hook と transcript scan の取り込み順、再起動後の catch-up で順序前後は正常に起きる。
  // 候補が 1 件も無い terminal を台帳に入れると、後から start が届いても二度と閉じられない
  const empty = emptySnapshot();
  const early = reduceTaskWorkState(empty, terminalEvent(), new Map());
  assert.equal(early.outcome, "quarantined");
  assert.deepEqual(
    early.diagnostics.map((d) => d.code),
    ["terminal_orphaned"],
  );
  assert.equal(early.ledger.size, 0);
  // start が届いてから同じ terminal を再配送すれば閉じられる
  const started = reduceTaskWorkState(early.snapshot, startEvent(), early.ledger);
  const closed = reduceTaskWorkState(started.snapshot, terminalEvent(), started.ledger);
  assert.equal(closed.outcome, "applied");
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "succeeded");
});

test("start が状態に無い terminal は閉じないが、詰まらせず unknown に倒す", () => {
  // checkpoint から復元すると operationStarts が空になる（#35）。ここで隔離すると復元後は
  // 全 terminal が隔離され、operation が started のまま二度と閉じられない（resume capsule が
  // 「まだ実行中」と偽る）。閉じずに unknown へ倒し、台帳には入れる
  const started = startedSnapshot();
  const restored: TaskWorkStateSnapshotV1 = { ...started, operationStarts: new Map() };
  const result = reduceTaskWorkState(restored, terminalEvent(), new Map());
  assert.equal(result.outcome, "applied");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_order_unverifiable"],
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "unknown");
  assert.equal(result.snapshot.state.pendingOperations[0]?.sourceEventIds.at(-1), "event-terminal");
  assert.equal(result.ledger.size, 1);
});

test("復元後の start 再配送は権威順序の材料を作らない", () => {
  // §6.4 の ingestSeq は event store が採番する watermark なので、再配送 event が運ぶのは
  // 再配送時の取り込み位置であって元の start の権威順序ではない。材料が無いまま閉じるより
  // unknown に倒す（§3.1 の fail closed）。復旧は #35 が本筋
  const started = startedSnapshot();
  const restored: TaskWorkStateSnapshotV1 = { ...started, operationStarts: new Map() };
  const again = reduceTaskWorkState(restored, startEvent({ ingestSeq: "3" }), new Map());
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["duplicate_operation_start"],
  );
  assert.equal(again.snapshot.operationStarts.size, 0);
  const closed = reduceTaskWorkState(again.snapshot, terminalEvent(), again.ledger);
  assert.deepEqual(
    closed.diagnostics.map((d) => d.code),
    ["terminal_order_unverifiable"],
  );
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "unknown");
});

test("eventId が変わった再配送 start でも operation を二重に積まない", () => {
  // 再送契約（上の「同じ配送 ID の再送は…」）では eventId が変わる。台帳だけを失った復元では
  // 導出 operationId が一致しないので、nativeOperationId で拾わないと同じ operation が 2 件になり、
  // rule 1 の terminal が候補 2 件で何も閉じられなくなる
  const started = startedSnapshot();
  const restored: TaskWorkStateSnapshotV1 = { ...started, operationStarts: new Map() };
  const redelivered = reduceTaskWorkState(
    restored,
    startEvent({ eventId: "event-start-retry-0", ingestSeq: "3" }),
    new Map(),
  );
  assert.deepEqual(
    redelivered.diagnostics.map((d) => d.code),
    ["duplicate_operation_start"],
  );
  assert.equal(redelivered.snapshot.state.pendingOperations.length, 1);
  // 候補が 1 件に保たれていることが要点。閉じる側は順序材料が無いので unknown（fail closed）
  const closed = reduceTaskWorkState(redelivered.snapshot, terminalEvent(), redelivered.ledger);
  assert.equal(closed.snapshot.state.pendingOperations.length, 1);
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "unknown");
});

test("operationKind だけが違う再配送 start も隔離する", () => {
  // rule 2 の候補選びが kind の一致を見るのと対称。重複として台帳に入れると訂正版が戻せない
  const started = startedSnapshot();
  const forged = reduceTaskWorkState(
    started,
    startEvent({
      eventId: "event-start-rekind",
      ingestSeq: "3",
      operation: { ...START_OPERATION, operationKind: "Write" },
    }),
    new Map(),
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(
    forged.diagnostics.map((d) => d.code),
    ["start_conflict"],
  );
});

test("canonicalInputHash だけが違う再配送 start も隔離する", () => {
  // matchKey の導出が §4.3 どおりでない adapter だと、入力が違っても matchKey は一致しうる。
  // 再配送として台帳に入れると、訂正版が同じ配送 ID で来ても重複 no-op になって戻せない
  const started = startedSnapshot();
  const ledger: IdempotencyLedger = new Map();
  const forged = reduceTaskWorkState(
    started,
    startEvent({
      eventId: "event-start-rehash",
      ingestSeq: "3",
      operation: { ...START_OPERATION, canonicalInputHash: "input-hash-other" },
    }),
    ledger,
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(
    forged.diagnostics.map((d) => d.code),
    ["start_conflict"],
  );
  assert.equal(forged.ledger, ledger);
});

test("同じ nativeOperationId で matchKey が違う start は隔離する", () => {
  // 再配送として台帳に入れると、訂正版が同じ配送 ID で来ても重複 no-op になって戻せない
  const started = startedSnapshot();
  const forged = reduceTaskWorkState(
    started,
    startEvent({
      eventId: "event-start-forged",
      ingestSeq: "3",
      operation: { ...START_OPERATION, operationMatchKey: "match-key-other" },
    }),
    new Map(),
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(
    forged.diagnostics.map((d) => d.code),
    ["start_conflict"],
  );
  assert.equal(forged.ledger.size, 0);
  assert.equal(forged.snapshot.state.pendingOperations.length, 1);
});

test("放棄を確定しない kind を finalizeAbandonedState に渡せない", () => {
  // routing の取り違えで届いた user_prompted が同 session の実行中 operation を全部 unknown に
  // したうえで冪等キーを消費する事故を、入口で落とす
  const started = startedSnapshot();
  assert.throws(
    () =>
      finalizeAbandonedState(
        started.state,
        startEvent({ eventId: "event-prompt", kind: "user_prompted", ingestSeq: "4", operation: undefined }),
        new Map(),
      ),
    /放棄を確定しない kind/,
  );
});

test("旧 session の session_ended は resume 先の operation を放棄しない", () => {
  // lineage は session をまたいで続く（§5 の checkpoint は sourceSessionId と taskLineageId を
  // 別に持つ）。session を見ないと、遅れて届いた旧 session の放棄が live な operation を潰す
  const started = startedSnapshot();
  const resumed = reduceTaskWorkState(
    started,
    startEvent({
      eventId: "event-start-new-session",
      ingestSeq: "3",
      sessionId: "session-2",
      operation: { ...START_OPERATION, nativeOperationId: "toolu_resumed" },
    }),
    new Map(),
  );
  const result = finalizeAbandonedState(
    resumed.snapshot.state,
    startEvent({ eventId: "event-abandon", kind: "session_ended", ingestSeq: "4", operation: undefined }),
    new Map(),
  );
  const bySession = new Map(
    result.state.pendingOperations.map((p) => [p.correlation.sessionId, p.status]),
  );
  assert.equal(bySession.get("session-1"), "unknown");
  assert.equal(bySession.get("session-2"), "started");
});

test("nativeOperationId が違う 2 回目の呼び出しは別 operation として積む", () => {
  // 再配送の判定に matchKey を使うと、同じ tool を同じ入力で 2 回呼んだだけで 1 件に潰れる
  const started = startedSnapshot();
  const second = reduceTaskWorkState(
    started,
    startEvent({
      eventId: "event-start-2",
      ingestSeq: "3",
      operation: { ...START_OPERATION, nativeOperationId: "toolu_second" },
    }),
    new Map(),
  );
  assert.deepEqual(second.diagnostics, []);
  assert.equal(second.snapshot.state.pendingOperations.length, 2);
});

test("低い ingestSeq を名乗る偽 start で unknown を succeeded に変えられない", () => {
  // 復元直後（operationStarts が空）に、被害者の identity を写した start を小さい ingestSeq で
  // 送ると、wire の値で順序材料を埋める実装では正規の terminal が順序検査を通って succeeded に
  // 化ける。§14 の zero-tolerance カウンタ `unsafe unknown replay` に直結する
  const started = startedSnapshot();
  const restored: TaskWorkStateSnapshotV1 = { ...started, operationStarts: new Map() };
  const forged = reduceTaskWorkState(
    restored,
    startEvent({ eventId: "event-start-forged-seq", ingestSeq: "1", sessionId: "session-1" }),
    new Map(),
  );
  const closed = reduceTaskWorkState(forged.snapshot, terminalEvent(), forged.ledger);
  assert.deepEqual(
    closed.diagnostics.map((d) => d.code),
    ["terminal_order_unverifiable"],
  );
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "unknown");
});

test("再配送された start は既存の順序材料を上書きしない", () => {
  // 後から来た再配送の ingestSeq で上書きすると、飛行中の terminal が順序違反に見える
  const started = startedSnapshot();
  const again = reduceTaskWorkState(started, startEvent({ ingestSeq: "99" }), new Map());
  const closed = reduceTaskWorkState(again.snapshot, terminalEvent(), again.ledger);
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "succeeded");
});

test("turn をまたいだ terminal は matchKey が違っても rule 1 で閉じる", () => {
  // §4.3 は matchKey の入力に「turn when present」を含めるので、turn をまたいだ terminal が
  // start と違う matchKey を持つのは仕様どおり。rule 1 は turn を要求しない（turn 両立は
  // rule 2 の要件）ので、ここで matchKey 一致を求めると背景実行の完了が永久に閉じない
  const snapshot = startedSnapshot();
  const acrossTurn = terminalEvent({
    turnId: "turn-2",
    operation: { ...TERMINAL_OPERATION, operationMatchKey: "match-key-2" },
  });
  const result = reduceTaskWorkState(snapshot, acrossTurn, new Map());
  assert.equal(result.outcome, "applied");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "succeeded");
});

test("tool_failed が successful: true を名乗っても succeeded にしない", () => {
  // schema はどちらも valid なので通る。succeeded にすると壊れた adapter が失敗を握り潰せる
  const snapshot = startedSnapshot();
  const result = reduceTaskWorkState(
    snapshot,
    terminalEvent({ kind: "tool_failed", successful: true }),
    new Map(),
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "unknown");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_evidence_contradicts"],
  );
});

test("terminal 済みの候補に対する identity 衝突も隔離する", () => {
  // 衝突検査が「terminal 済み」の早期 return より後にあると、corrupt な event が台帳へ入り
  // 訂正版の再配送が重複 no-op になる
  const snapshot = startedSnapshot();
  const closed = reduceTaskWorkState(snapshot, terminalEvent(), new Map());
  const forged = reduceTaskWorkState(
    closed.snapshot,
    terminalEvent({
      eventId: "event-terminal-forged",
      ingestSeq: "9",
      adapterDeliveryId: "delivery-forged",
      operation: { ...TERMINAL_OPERATION, canonicalInputHash: "input-hash-other" },
    }),
    closed.ledger,
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(
    forged.diagnostics.map((d) => d.code),
    ["terminal_conflict"],
  );
  assert.equal(forged.ledger.size, closed.ledger.size);
});

test("terminal 済みへの同一 identity の再配送は already_applied として台帳に入る", () => {
  // 衝突検査を前に出したせいで正当な再配送まで隔離しては困る
  const snapshot = startedSnapshot();
  const closed = reduceTaskWorkState(snapshot, terminalEvent(), new Map());
  const again = reduceTaskWorkState(
    closed.snapshot,
    terminalEvent({ eventId: "event-terminal-again", ingestSeq: "9", adapterDeliveryId: "delivery-again" }),
    closed.ledger,
  );
  assert.equal(again.outcome, "applied");
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["terminal_already_applied"],
  );
});

test("tool_failed が successful: false なら矛盾しない", () => {
  const snapshot = startedSnapshot();
  const result = reduceTaskWorkState(
    snapshot,
    terminalEvent({ kind: "tool_failed", successful: false }),
    new Map(),
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "failed");
  assert.deepEqual(result.diagnostics, []);
});

test("順序が確認できて hash が衝突する terminal は隔離が先に立つ", () => {
  // 権威順序の gate を先に置くと、順序 NG かつ hash 衝突の terminal が台帳へ入り、
  // 訂正版の再配送が重複 no-op として黙って捨てられる
  const snapshot = startedSnapshot();
  const conflicting = terminalEvent({
    ingestSeq: "5",
    operation: { ...TERMINAL_OPERATION, canonicalInputHash: "input-hash-other" },
  });
  const result = reduceTaskWorkState(snapshot, conflicting, new Map());
  assert.equal(result.outcome, "quarantined");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_conflict"],
  );
  assert.equal(result.ledger.size, 0);
});

test("権威順序に反する terminal が unknown にするのは一致した 1 件だけ", () => {
  // 同じ matchKey の start 2 件を別 turn に置く。rule 2 で適格なのは同じ turn の 1 件だけなので、
  // 巻き込みの有無がそのまま見える
  const first = startedSnapshot(startEvent({ operation: MATCH_KEY_ONLY }));
  const both = reduceTaskWorkState(
    first,
    startEvent({
      eventId: "event-start-2",
      adapterDeliveryId: "delivery-start-2",
      ingestSeq: "15",
      turnId: "turn-2",
      operation: MATCH_KEY_ONLY,
    }),
    new Map(),
  ).snapshot;
  const stale = terminalEvent({ ingestSeq: "5", operation: { ...MATCH_KEY_ONLY, phase: "terminal" } });
  const result = reduceTaskWorkState(both, stale, new Map());
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_out_of_order"],
  );
  const statuses = result.snapshot.state.pendingOperations.map((pending) => pending.status);
  assert.deepEqual(statuses, ["unknown", "started"]);
  // 閉じられなかった terminal も証跡として残す（§4.3「preserve it as unmatched evidence」）
  assert.deepEqual(result.snapshot.state.pendingOperations[0]?.sourceEventIds, [
    "event-start",
    "event-terminal",
  ]);
  // 巻き込まれなかった側は証跡も付かない
  assert.deepEqual(result.snapshot.state.pendingOperations[1]?.sourceEventIds, ["event-start-2"]);
});

test("Agent 名を名乗らない event 同士で native authority は成立しない", () => {
  const anonymous = startEvent({ sourceAgent: "" });
  const context: IntakeContextV1 = { ...INTAKE, expectedSourceAgent: "" };
  const stamped = stampIntakeEvidence(anonymous, context).event;
  assert.equal(stamped.provenance.evidenceKind, "synthesized");
  assert.equal(stamped.turnIdSource, "unavailable");
});

test("認証済み peer と違う Agent 名を名乗る event は intake が受け取らない", () => {
  // `sourceAgent` は証跡の質ではなく scope selector（`assertSameScope` がこの値の等値で
  // 「どの状態を書き換えてよいか」を決める）。降格しても値は残るので、降格だけでは
  // peer=codex の event が claude の operation を診断ゼロで閉じるのを止められない
  for (const claimed of ["codex", "", " ", "\u{200B}"]) {
    assert.throws(
      () => stampIntakeEvidence(startEvent({ sourceAgent: claimed }), INTAKE),
      /§3.1 違反: 認証済み peer は claude なのに/,
      JSON.stringify(claimed),
    );
  }
});

test("認証できない経路では Agent 名の食い違いを降格で扱う", () => {
  // 締めすぎない側も測る。`expectedSourceAgent` が空 = 受領証が peer を名乗っていない経路では
  // 「違う」と言える相手が居ないので、従来どおり native を落とすだけにする
  const stamped = stampIntakeEvidence(startEvent({ sourceAgent: "codex" }), {
    ...INTAKE,
    expectedSourceAgent: "",
  });
  assert.equal(stamped.event.provenance.evidenceKind, "synthesized");
  assert.equal(stamped.event.sourceAgent, "codex");
});

test("revision ごとに pendingOperations の配列を分ける", () => {
  // 配列を共有すると、新しい revision への変更が過去の snapshot にも見える（§4.2 違反）
  const started = startedSnapshot();
  const next = reduceTaskWorkState(
    started,
    startEvent({
      eventId: "event-prompt",
      adapterDeliveryId: "delivery-prompt",
      kind: "user_prompted",
      ingestSeq: "13",
      operation: undefined,
    }),
    new Map(),
  );
  assert.equal(
    Object.is(started.state.pendingOperations, next.snapshot.state.pendingOperations),
    false,
  );
});



test("adapter 固有の kind でも envelope の欄は検査する", () => {
  // 既知の phase が無い kind は phase を照合できないが、envelope を持つなら reducer の
  // operation 経路にそのまま入る。空文字の native ID が rule 1 の照合権威になると、
  // 無関係な custom operation 同士が同じものとして畳まれる
  assert.throws(
    () =>
      assertOperationEnvelope(
        startEvent({
          kind: "adapter_custom_started",
          operation: { ...START_OPERATION, nativeOperationId: "" },
        }),
      ),
    /nativeOperationId \/ canonicalInputHash が空文字/,
  );
  // 未知の kind そのものは拒否しない（欄が揃っていれば通る）
  assertOperationEnvelope(startEvent({ kind: "adapter_custom_started" }));
});

test("operationId 一致で見つけた再配送 start でも native ID の違いは隔離する", () => {
  // 同じ eventId・matchKey で当たると native ID を一度も比べないまま重複として台帳に入り、
  // 訂正版が同じ配送 ID で来ても no-op になって戻せない
  const started = startedSnapshot();
  const forged = reduceTaskWorkState(
    started,
    startEvent({
      adapterDeliveryId: "delivery-start-2",
      canonicalFingerprint: "fingerprint-start-2",
      ingestSeq: "13",
      operation: { ...START_OPERATION, nativeOperationId: "toolu_other" },
    }),
    new Map(),
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(
    forged.diagnostics.map((d) => d.code),
    ["start_conflict"],
  );
  assert.equal(forged.snapshot.state.pendingOperations.length, 1);
});

test("operationKind が違う terminal は native ID が一致しても閉じない", () => {
  // rule 1 は nativeOperationId だけで候補を選ぶので、kind を見ないと Bash の operation を
  // 別種の terminal で閉じられる。kind は §4.3 の matchKey の入力に含まれる identity の一部
  const snapshot = startedSnapshot();
  const forged = reduceTaskWorkState(
    snapshot,
    terminalEvent({ operation: { ...TERMINAL_OPERATION, operationKind: "Read" } }),
    new Map(),
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(
    forged.diagnostics.map((d) => d.code),
    ["terminal_conflict"],
  );
  assert.equal(forged.snapshot.state.pendingOperations[0]?.status, "started");
});

test("放棄でも同じ配送 ID で source hash が違えば隔離する", () => {
  // 重複として黙って捨てると放棄が落ちて operation が started のまま残る。reducer 側の
  // delivery_conflict と判定を揃える
  const started = startedSnapshot();
  const abandon = startEvent({
    eventId: "event-abandon",
    kind: "session_ended",
    ingestSeq: "4",
    operation: undefined,
    adapterDeliveryId: "delivery-abandon",
    canonicalFingerprint: "fingerprint-abandon",
  });
  const first = finalizeAbandonedState(started.state, abandon, new Map());
  assert.equal(first.outcome, "applied");
  const conflicting = finalizeAbandonedState(
    first.state,
    startEvent({
      eventId: "event-abandon-corrupt",
      kind: "session_ended",
      ingestSeq: "5",
      operation: undefined,
      adapterDeliveryId: "delivery-abandon",
      canonicalFingerprint: "fingerprint-other",
    }),
    first.ledger,
  );
  assert.equal(conflicting.outcome, "quarantined");
  assert.equal(conflicting.state, first.state);
  assert.equal(conflicting.ledger, first.ledger);
  // 診断も還元器側と同じものを出す。doctor が受け取るのは outcome ではなく診断の側なので、
  // 空で返すと「なぜ放棄が落ちたか」が経路ごとに違う形でしか分からない
  assert.deepEqual(conflicting.diagnostics.map((d) => d.code), ["delivery_conflict"]);
  assert.equal(conflicting.diagnostics[0]?.eventId, "event-abandon-corrupt");
});

test("toolName を持たない schema 妥当な pending でも rule 1 の terminal は閉じる", () => {
  // toolName は凍結 schema の required に無い（required は operationId / startEventId /
  // operationMatchKey / sessionId / taskLineageId の 5 つ）。checkpoint から復元した状態や
  // 別実装が書いた状態では欠けうるので、kind を素で比べると健全な terminal が永久に隔離され、
  // 台帳にも入らないので adapter が無限再送になる
  const started = startedSnapshot();
  const pending = started.state.pendingOperations[0];
  if (pending === undefined) assert.fail("pending が無い");
  const { toolName: _dropped, ...correlation } = pending.correlation;
  const state = { ...started.state, pendingOperations: [{ ...pending, correlation }] };
  assert.deepEqual(
    validateContractValue("CanonicalWorkStateV1", state, SCHEMA_ROOT, CONTINUITY_LIMITS),
    [],
  );
  const closed = reduceTaskWorkState({ ...started, state }, terminalEvent(), new Map());
  assert.equal(closed.outcome, "applied");
  assert.deepEqual(closed.diagnostics, []);
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "succeeded");
  // start 側も同じ非対称を持っていたので、再配送 start が隔離されないことも見る
  const again = reduceTaskWorkState(
    { ...started, state },
    startEvent({ adapterDeliveryId: "delivery-start-3", canonicalFingerprint: "fingerprint-start-3", ingestSeq: "14" }),
    new Map(),
  );
  assert.equal(again.outcome, "applied");
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["duplicate_operation_start"],
  );
});

// --- round 9: identity 材料の省略・空白・session（#37） ------------------------

test("identity が一致する確定済み兄弟がいても、衝突する open な候補は閉じない", () => {
  // rule 2 で matchKey を共有する「確定済み A（hash A）」と「open な B（hash B）」が並ぶとき、
  // A の terminal を再配送すると「互換な候補が 1 件でもあれば全体を免除する」実装では
  // B に terminal が付いてしまう。確定済みの互換候補が囮になる形
  const A = { ...MATCH_KEY_ONLY, canonicalInputHash: "input-hash-A" } as const;
  const B = { ...MATCH_KEY_ONLY, canonicalInputHash: "input-hash-B" } as const;
  const prepared = apply(emptySnapshot(), [
    startEvent({ eventId: "start-a", adapterDeliveryId: "d-start-a", canonicalFingerprint: "f-start-a", operation: A, ingestSeq: "11" }),
    terminalEvent({ eventId: "term-a", adapterDeliveryId: "d-term-a", canonicalFingerprint: "f-term-a", operation: { ...A, phase: "terminal" }, ingestSeq: "12" }),
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-start-b", canonicalFingerprint: "f-start-b", operation: B, ingestSeq: "13" }),
  ]);
  assert.deepEqual(
    prepared.snapshot.state.pendingOperations.map((p) => p.status),
    ["succeeded", "started"],
  );
  const redelivered = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({ eventId: "term-a2", adapterDeliveryId: "d-term-a2", canonicalFingerprint: "f-term-a2", operation: { ...A, phase: "terminal" }, ingestSeq: "14" }),
    prepared.ledger,
  );
  assert.equal(redelivered.outcome, "applied");
  assert.deepEqual(
    redelivered.diagnostics.map((d) => d.code),
    ["terminal_already_applied"],
  );
  // B は起動したまま。囮に引きずられて succeeded にならない
  assert.deepEqual(
    redelivered.snapshot.state.pendingOperations.map((p) => p.status),
    ["succeeded", "started"],
  );
});

test("候補が複数あるとき canonicalInputHash を省いた terminal は照合できないものとして扱う", () => {
  // 両方 present のときだけ比べる衝突検査は復元耐性のためにあるが、そのままだと欄を省くだけで
  // 検査を無効化できる。省略は wire 側の自由なので、これは攻撃者が選べる経路。
  // 弁別子が hash しか残っていない形＝同じ matchKey に hash 違いの兄弟が並ぶ形でだけ発火する
  const A = { ...MATCH_KEY_ONLY, canonicalInputHash: "input-hash-A" } as const;
  const B = { ...MATCH_KEY_ONLY, canonicalInputHash: "input-hash-B" } as const;
  const prepared = apply(emptySnapshot(), [
    startEvent({ eventId: "start-a", adapterDeliveryId: "d-start-a", canonicalFingerprint: "f-start-a", operation: A, ingestSeq: "11" }),
    terminalEvent({ eventId: "term-a", adapterDeliveryId: "d-term-a", canonicalFingerprint: "f-term-a", operation: { ...A, phase: "terminal" }, ingestSeq: "12" }),
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-start-b", canonicalFingerprint: "f-start-b", operation: B, ingestSeq: "13" }),
  ]);
  const omitted = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-x", adapterDeliveryId: "d-term-x", canonicalFingerprint: "f-term-x", ingestSeq: "14",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal", canonicalInputHash: undefined },
    }),
    prepared.ledger,
  );
  assert.equal(omitted.outcome, "applied");
  assert.deepEqual(
    omitted.diagnostics.map((d) => d.code),
    ["terminal_identity_unverifiable"],
  );
  // succeeded を名乗られても B は unknown に倒れる。確定済みの A は動かない
  assert.deepEqual(
    omitted.snapshot.state.pendingOperations.map((p) => p.status),
    ["succeeded", "unknown"],
  );
  // 隔離ではなく台帳に入るので、後から届いた本物の terminal がそのまま閉じられる
  const real = reduceTaskWorkState(
    omitted.snapshot,
    terminalEvent({
      eventId: "event-fail", adapterDeliveryId: "delivery-fail", canonicalFingerprint: "fingerprint-fail",
      kind: "tool_failed", successful: false, operation: { ...B, phase: "terminal" }, ingestSeq: "15",
    }),
    omitted.ledger,
  );
  assert.deepEqual(real.diagnostics, []);
  assert.deepEqual(
    real.snapshot.state.pendingOperations.map((p) => p.status),
    ["succeeded", "failed"],
  );
});

test("照合不能で unknown に倒すのも turn が両立する候補だけ", () => {
  // 照合不能は「この terminal がどの候補を指すか決められない」であって、閉じえない候補まで
  // 巻き込んでよい話ではない。§4.3 の rule 2 で閉じられない turn 非両立の候補は、そもそも
  // この terminal の candidates ではないので `started` のまま残す
  const prepared = apply(emptySnapshot(), [
    startEvent({ eventId: "start-a", adapterDeliveryId: "d-start-a", canonicalFingerprint: "f-start-a", operation: MATCH_KEY_ONLY, ingestSeq: "11", turnIdSource: "native" }),
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-start-b", canonicalFingerprint: "f-start-b", operation: MATCH_KEY_ONLY, ingestSeq: "12", turnIdSource: "synthesized_monotonic" }),
  ]);
  assert.deepEqual(prepared.snapshot.state.pendingOperations.map((p) => p.status), ["started", "started"]);
  const omitted = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-x", adapterDeliveryId: "d-term-x", canonicalFingerprint: "f-term-x", ingestSeq: "13",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal", canonicalInputHash: undefined }, turnIdSource: "native",
    }),
    prepared.ledger,
  );
  assert.deepEqual(omitted.diagnostics.map((d) => d.code), ["terminal_identity_unverifiable"]);
  assert.deepEqual(omitted.snapshot.state.pendingOperations.map((p) => p.status), ["unknown", "started"]);
});

test("候補が 1 件なら canonicalInputHash の省略は照合を妨げない", () => {
  // §4.3 の matchKey は canonical input hash を入力に含むので、仕様どおりに導出する adapter では
  // hash 違いの兄弟は候補に並ばない。付け替えられる相手が居ない以上、省略で盗めるものが無い。
  // 「terminal は入力ではなく結果なので hash を載せない」adapter を締め出さないための対照
  for (const [label, op] of [
    ["rule 2（matchKey）", MATCH_KEY_ONLY],
    ["rule 1（nativeOperationId）", START_OPERATION],
  ] as const) {
    const started = startedSnapshot(startEvent({ operation: op }));
    const omitted = reduceTaskWorkState(
      started,
      terminalEvent({ operation: { ...op, phase: "terminal", canonicalInputHash: undefined } }),
      new Map(),
    );
    assert.deepEqual(omitted.diagnostics, [], label);
    assert.equal(omitted.snapshot.state.pendingOperations[0]?.status, "succeeded", label);
  }
});

test("確定済みの候補に矛盾する terminal は hash を省いても隔離される", () => {
  // 照合不能の検査を成否矛盾検査より前に置くと、hash を省くだけで隔離（台帳を消費しない）を
  // 回避して照合不能（台帳を消費する）に化け、訂正版の再配送が重複 no-op として捨てられる
  const A = { ...MATCH_KEY_ONLY, canonicalInputHash: "input-hash-A" } as const;
  const B = { ...MATCH_KEY_ONLY, canonicalInputHash: "input-hash-B" } as const;
  const failed = { kind: "tool_failed", successful: false } as const;
  const prepared = apply(emptySnapshot(), [
    startEvent({ eventId: "start-a", adapterDeliveryId: "d-start-a", canonicalFingerprint: "f-start-a", operation: A, ingestSeq: "11" }),
    terminalEvent({ eventId: "term-a", adapterDeliveryId: "d-term-a", canonicalFingerprint: "f-term-a", operation: { ...A, phase: "terminal" }, ingestSeq: "12", ...failed }),
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-start-b", canonicalFingerprint: "f-start-b", operation: B, ingestSeq: "13" }),
    terminalEvent({ eventId: "term-b", adapterDeliveryId: "d-term-b", canonicalFingerprint: "f-term-b", operation: { ...B, phase: "terminal" }, ingestSeq: "14", ...failed }),
  ]);
  const forged = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-x", adapterDeliveryId: "d-term-x", canonicalFingerprint: "f-term-x", ingestSeq: "15",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal", canonicalInputHash: undefined },
    }),
    prepared.ledger,
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(
    forged.diagnostics.map((d) => d.code),
    ["terminal_conflict"],
  );
  // 隔離は配送鍵を消費しないので、訂正版が後から効く
  assert.equal(forged.ledger.size, prepared.ledger.size);
});

test("turn 種別が両立しない兄弟は矛盾する terminal の言い訳にならない", () => {
  // 確定済みの候補で再配送を説明するときにも「この terminal が閉じえた候補」だけを使う。
  // 素の候補集合で説明を許すと、種別が両立しない兄弟が囮になって隔離（台帳を消費しない）を
  // 回避し、`terminal_already_applied` として台帳を消費するので訂正版が重複 no-op になる
  const failed = { kind: "tool_failed", successful: false } as const;
  const prepared = apply(emptySnapshot(), [
    startEvent({ eventId: "start-a", adapterDeliveryId: "d-start-a", canonicalFingerprint: "f-start-a", operation: MATCH_KEY_ONLY, ingestSeq: "11", turnIdSource: "native" }),
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-start-b", canonicalFingerprint: "f-start-b", operation: MATCH_KEY_ONLY, ingestSeq: "12", turnIdSource: "synthesized_monotonic" }),
    terminalEvent({ eventId: "term-a", adapterDeliveryId: "d-term-a", canonicalFingerprint: "f-term-a", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, ingestSeq: "13", turnIdSource: "native", ...failed }),
    terminalEvent({ eventId: "term-b", adapterDeliveryId: "d-term-b", canonicalFingerprint: "f-term-b", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, ingestSeq: "14", turnIdSource: "synthesized_monotonic" }),
  ]);
  assert.deepEqual(
    prepared.snapshot.state.pendingOperations.map((pending) => pending.status),
    ["failed", "succeeded"],
  );
  // native の候補は failed で確定しているので、succeeded を名乗る native の 2 通目は矛盾する。
  // succeeded の兄弟は synthesized_monotonic なのでこの terminal では閉じえない
  const forged = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-x", adapterDeliveryId: "d-term-x", canonicalFingerprint: "f-term-x", ingestSeq: "15",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "native",
    }),
    prepared.ledger,
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(forged.diagnostics.map((d) => d.code), ["terminal_conflict"]);
  assert.equal(forged.ledger.size, prepared.ledger.size);
  // 対照: 種別が両立する候補と成否が一致する再配送は従来どおり適用済みとして通る
  const honest = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-y", adapterDeliveryId: "d-term-y", canonicalFingerprint: "f-term-y", ingestSeq: "16",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "native", ...failed,
    }),
    prepared.ledger,
  );
  assert.equal(honest.outcome, "applied");
  assert.deepEqual(honest.diagnostics.map((d) => d.code), ["terminal_already_applied"]);
});

test("turn が両立する確定済み候補が 1 件も無いなら適用済みを名乗らない", () => {
  // 「候補は全件確定済みで、この terminal が閉じえたものは 1 件も無い」は再配送では説明できない。
  // `terminal_already_applied` を名乗ると、閉じえなかった terminal が適用済みとして台帳に入る
  const prepared = apply(emptySnapshot(), [
    startEvent({ operation: MATCH_KEY_ONLY, ingestSeq: "11", turnIdSource: "synthesized_monotonic" }),
    terminalEvent({ eventId: "term-b", adapterDeliveryId: "d-term-b", canonicalFingerprint: "f-term-b", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, ingestSeq: "12", turnIdSource: "synthesized_monotonic" }),
  ]);
  assert.equal(prepared.snapshot.state.pendingOperations[0]?.status, "succeeded");
  const agreeing = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-agree", adapterDeliveryId: "d-agree", canonicalFingerprint: "f-agree",
      ingestSeq: "13", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "native",
    }),
    prepared.ledger,
  );
  assert.deepEqual(agreeing.diagnostics.map((d) => d.code), ["terminal_unmatched"]);
  // 候補は確定済みなので `unknown` に倒す相手は居ない
  assert.equal(agreeing.snapshot.state.pendingOperations[0]?.status, "succeeded");
  // 対照: turn が両立する候補があれば従来どおり適用済みとして通る
  const same = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-same", adapterDeliveryId: "d-same", canonicalFingerprint: "f-same", ingestSeq: "14",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "synthesized_monotonic",
    }),
    prepared.ledger,
  );
  assert.deepEqual(same.diagnostics.map((d) => d.code), ["terminal_already_applied"]);
});

test("状態側で operationId が衝突していても terminal は 1 件しか閉じない", () => {
  // `operationId` は `eventId` + matchKey からの導出なので還元器は重複を作らないが、凍結 schema は
  // `maxLength` しか課さず一意性も要求しない。復元した checkpoint や別実装が書いた状態では
  // schema 妥当なまま重複しうるので、`operationId` の等値で当てると 1 通で N 件が閉じる
  const pending = (operationId: string, nativeOperationId: string): PendingOperation =>
    ({
      operationId,
      correlation: {
        operationId, startEventId: `start-${nativeOperationId}`, nativeOperationId,
        operationMatchKey: `match-${nativeOperationId}`, sessionId: "session-1", taskLineageId: "lineage-1",
        turnId: "turn-1", toolName: "Bash", canonicalInputHash: "input-hash-1",
      },
      kind: "tool", description: "Bash", status: "started", replayPolicy: "never_auto",
      sourceEventIds: [`start-${nativeOperationId}`], startedAt: "2026-08-16T00:00:01Z", sensitivity: "normal",
    }) as unknown as PendingOperation;
  for (const duplicated of ["", "op-dup"]) {
    const victim: TaskWorkStateSnapshotV1 = {
      state: emptyState({ pendingOperations: [pending(duplicated, "toolu_1"), pending(duplicated, "toolu_2")] }),
      history: [],
      operationStarts: new Map([[duplicated, { ingestSeq: "11", turnIdSource: "native" as const }]]),
    };
    const result = reduceTaskWorkState(victim, terminalEvent(), new Map());
    assert.deepEqual(
      result.snapshot.state.pendingOperations.map((p) => p.status),
      ["succeeded", "started"],
      JSON.stringify(duplicated),
    );
  }
});

test("operationId が衝突していても放棄は自 session の operation だけを unknown にする", () => {
  // `abandoned` を `operationId` の集合で持つと、直前の session 絞り込みが id の重複で無意味に
  // なり、旧 session の session_ended が resume 先の live な operation まで unknown にする
  const pending = (operationId: string, sessionId: string, n: string): PendingOperation =>
    ({
      operationId,
      correlation: {
        operationId, startEventId: `s-${n}`, nativeOperationId: n, operationMatchKey: `m-${n}`,
        sessionId, taskLineageId: "lineage-1", turnId: "turn-1", toolName: "Bash", canonicalInputHash: "h",
      },
      kind: "tool", description: "Bash", status: "started", replayPolicy: "never_auto",
      sourceEventIds: [`s-${n}`], startedAt: "2026-08-16T00:00:01Z", sensitivity: "normal",
    }) as unknown as PendingOperation;
  const ended = {
    eventId: "end-1", adapterDeliveryId: "d-end", canonicalFingerprint: "f-end", kind: "session_ended",
    ingestSeq: "20", occurredAt: "2026-08-16T00:00:09Z", sessionId: "session-old", taskLineageId: "lineage-1",
    turnIdSource: "unavailable", sourceAgent: "claude",
    provenance: { sourceAgentVersion: VERSION, evidenceKind: "synthesized", captureMethod: "native_event" },
    payload: {},
  } as unknown as Parameters<typeof finalizeAbandonedState>[1];
  const result = finalizeAbandonedState(
    emptyState({ pendingOperations: [pending("dup", "session-old", "n1"), pending("dup", "session-live", "n2")] }),
    ended,
    new Map(),
  );
  assert.deepEqual(
    result.state?.pendingOperations.map((p) => `${p.correlation.sessionId}:${p.status}`),
    ["session-old:unknown", "session-live:started"],
  );
});

test("turn が両立しない open な兄弟は確定済みへの再配送を妨げない", () => {
  // open / 確定済みの切り分けを turn の絞り込みより先にすると、閉じえない open な兄弟が
  // 「open が居る」と数えられて確定済み経路が飛ばされ、健全な再配送が `terminal_unmatched` に
  // 化けて兄弟を `unknown` に倒し、台帳まで消費する
  const prepared = apply(emptySnapshot(), [
    startEvent({ operation: MATCH_KEY_ONLY, ingestSeq: "11", turnIdSource: "native" }),
    terminalEvent({ eventId: "term-a", adapterDeliveryId: "d-term-a", canonicalFingerprint: "f-term-a", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, ingestSeq: "12", turnIdSource: "native" }),
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-start-b", canonicalFingerprint: "f-start-b", operation: MATCH_KEY_ONLY, ingestSeq: "13", turnIdSource: "synthesized_monotonic" }),
  ]);
  assert.deepEqual(prepared.snapshot.state.pendingOperations.map((p) => p.status), ["succeeded", "started"]);
  const redelivered = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-x", adapterDeliveryId: "d-term-x", canonicalFingerprint: "f-term-x", ingestSeq: "14",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "native",
    }),
    prepared.ledger,
  );
  assert.deepEqual(redelivered.diagnostics.map((d) => d.code), ["terminal_already_applied"]);
  // 閉じえない兄弟は巻き込まない
  assert.deepEqual(redelivered.snapshot.state.pendingOperations.map((p) => p.status), ["succeeded", "started"]);
});

test("unknown に倒す相手は候補だけで、別 session の同名 operation を巻き込まない", () => {
  // 閉じられなかった候補を id で当てると、状態側で id が重複しているとき候補ですらない
  // operation——別 session のもの——まで `unknown` になる。§4.3 が集合単位で指示しているのは
  // 「candidates を unknown のままにする」であって、候補の外へ広げてよいとは言っていない
  const pending = (sessionId: string, n: string, turnId: string): PendingOperation =>
    ({
      operationId: "dup",
      correlation: {
        operationId: "dup", startEventId: `s-${n}`, operationMatchKey: START_OPERATION.operationMatchKey,
        sessionId, taskLineageId: "lineage-1", turnId, toolName: "Bash",
        canonicalInputHash: START_OPERATION.canonicalInputHash,
      },
      kind: "tool", description: "Bash", status: "started", replayPolicy: "never_auto",
      sourceEventIds: [`s-${n}`], startedAt: "2026-08-16T00:00:01Z", sensitivity: "normal",
    }) as unknown as PendingOperation;
  const victim: TaskWorkStateSnapshotV1 = {
    // 候補側は turn 同一性が無いので rule 2 では閉じられず `unknown` に倒れる
    state: emptyState({ pendingOperations: [pending("session-1", "n1", "turn-9"), pending("session-other", "n2", "turn-1")] }),
    history: [],
    operationStarts: new Map(),
  };
  const result = reduceTaskWorkState(
    victim,
    terminalEvent({ operation: { ...MATCH_KEY_ONLY, phase: "terminal" } }),
    new Map(),
  );
  assert.deepEqual(result.diagnostics.map((d) => d.code), ["terminal_unmatched"]);
  assert.deepEqual(
    result.snapshot.state.pendingOperations.map((p) => `${p.correlation.sessionId}:${p.status}`),
    ["session-1:unknown", "session-other:started"],
  );
});

test("turn が両立しなくても成否が矛盾する terminal は隔離する", () => {
  // 矛盾の検出は「閉じる権限があるか」ではなく「壊れた証跡か」の判定なので turn 両立は要らない。
  // ここまで絞ると候補が全部落ちたときに `find` が undefined を返し、隔離（台帳を消費しない）が
  // `terminal_already_applied`（台帳を消費する）に化けて、訂正版が重複 no-op になる
  const failed = { kind: "tool_failed", successful: false } as const;
  const prepared = apply(emptySnapshot(), [
    startEvent({ operation: MATCH_KEY_ONLY, ingestSeq: "11", turnIdSource: "synthesized_monotonic" }),
    terminalEvent({ eventId: "term-a", adapterDeliveryId: "d-term-a", canonicalFingerprint: "f-term-a", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, ingestSeq: "12", turnIdSource: "synthesized_monotonic", ...failed }),
  ]);
  assert.equal(prepared.snapshot.state.pendingOperations[0]?.status, "failed");
  // turn 種別が違う / turn そのものが違う のどちらでも、成否が逆なら隔離する
  for (const [label, extra] of [
    ["種別違い", { turnIdSource: "native" }],
    ["別 turn", { turnIdSource: "synthesized_monotonic", turnId: "turn-2" }],
  ] as const) {
    const forged = reduceTaskWorkState(
      prepared.snapshot,
      terminalEvent({
        eventId: `term-${label}`, adapterDeliveryId: `d-${label}`, canonicalFingerprint: `f-${label}`,
        ingestSeq: "13", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, ...extra,
      }),
      prepared.ledger,
    );
    assert.equal(forged.outcome, "quarantined", label);
    assert.deepEqual(forged.diagnostics.map((d) => d.code), ["terminal_conflict"], label);
    // 隔離は配送鍵を消費しないので、訂正版が後から効く
    assert.equal(forged.ledger.size, prepared.ledger.size, label);
  }
});

/**
 * turn 種別が違う live な B（synthesized_monotonic）と、確定済みの A（native）が同じ matchKey で
 * 並ぶ状態。**open を先頭に置く**: 矛盾の相手を配列順で拾う実装なので、確定済みを先頭にすると
 * 母数を広げる変異が同じ候補を掴んでしまい、母数の違いが観測できない
 */
function openThenSettledSibling(): ReturnType<typeof apply> {
  const prepared = apply(emptySnapshot(), [
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-start-b", canonicalFingerprint: "f-start-b", operation: MATCH_KEY_ONLY, ingestSeq: "11", turnIdSource: "synthesized_monotonic" }),
    startEvent({ operation: MATCH_KEY_ONLY, ingestSeq: "12", turnIdSource: "native" }),
    terminalEvent({ eventId: "term-a", adapterDeliveryId: "d-term-a", canonicalFingerprint: "f-term-a", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, ingestSeq: "13", turnIdSource: "native" }),
  ]);
  assert.deepEqual(prepared.snapshot.state.pendingOperations.map((p) => p.status), ["started", "succeeded"]);
  return prepared;
}

test("記録できる open な候補が居るなら、確定済みとの矛盾より unmatched を優先する", () => {
  // §4.3:368 は「zero か複数の open にマッチした terminal は何も閉じず、unmatched な証跡として
  // 保存し candidates を unknown にする」と終状態を名指ししている。ここで隔離を優先すると
  // open な候補は `started` のまま残って状態が嘘をつき、しかも `turnIdSource` の食い違いは
  // adapter の捕捉経路という定常的な性質なので「訂正版」が存在せず、還元器は純関数なので
  // 再送は毎回同じ隔離になる = adapter は無限再送する
  const failed = { kind: "tool_failed", successful: false } as const;
  const prepared = openThenSettledSibling();
  const orphaned = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-x", adapterDeliveryId: "d-term-x", canonicalFingerprint: "f-term-x", ingestSeq: "14",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "native", turnId: "turn-9", ...failed,
    }),
    prepared.ledger,
  );
  assert.equal(orphaned.outcome, "applied");
  assert.deepEqual(orphaned.diagnostics.map((d) => d.code), ["terminal_unmatched"]);
  assert.deepEqual(orphaned.snapshot.state.pendingOperations.map((p) => p.status), ["unknown", "succeeded"]);
  assert.equal(orphaned.snapshot.history.length, prepared.snapshot.history.length + 1);
  // 抑止するのは隔離という行動だけで、矛盾していた事実は doctor に届ける（§3.1 は棄却・降格の
  // 理由を報告できることを求めている）
  assert.match(orphaned.diagnostics[0]?.detail ?? "", /succeeded で確定済みなのに failed を名乗っている/);
});

test("矛盾の診断は確定済みの候補を名指しする", () => {
  // 矛盾判定の母数を `compatible` 全体に広げると、open な兄弟のほうが先に見つかって
  // 「started で確定済み」という自己矛盾した診断になる。open は成否を主張していない
  const failed = { kind: "tool_failed", successful: false } as const;
  const prepared = openThenSettledSibling();
  const forged = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({
      eventId: "term-y", adapterDeliveryId: "d-term-y", canonicalFingerprint: "f-term-y", ingestSeq: "14",
      operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "native", ...failed,
    }),
    prepared.ledger,
  );
  assert.equal(forged.outcome, "quarantined");
  assert.deepEqual(forged.diagnostics.map((d) => d.code), ["terminal_conflict"]);
  assert.match(forged.diagnostics[0]?.detail ?? "", /succeeded で確定済み/);
});

test("記録側も canonicalInputHash を持たないなら省略は照合を妨げない", () => {
  const noHash = { ...MATCH_KEY_ONLY, canonicalInputHash: undefined } as const;
  const closed = apply(emptySnapshot(), [
    startEvent({ operation: noHash }),
    terminalEvent({ operation: { ...noHash, phase: "terminal" } }),
  ]);
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "succeeded");
});

test("空白文字だけの identity 材料は空文字と同じく schema violation", () => {
  // schema は maxLength しか課さないので、空文字と同じ実害が空白 1 文字でもそのまま起きる。
  // U+FEFF は JS の `\s` に入るが U+200B は入らないので、書式制御文字も落とす
  for (const blank of [" ", "\t", "\n", "\u{FEFF}", "\u{200B}"]) {
    for (const field of ["canonicalFingerprint", "eventId", "sessionId", "turnId"] as const) {
      assert.throws(
        () => reduceTaskWorkState(emptySnapshot(), startEvent({ [field]: blank }), new Map()),
        /§3.1 違反/,
        `${field} = ${JSON.stringify(blank)}`,
      );
    }
    // `sourceAgent` は状態側も event 側も maxLength しか課されないので、Agent 同一性を「不明」として
    // 空白で表す adapter が 2 つあると `assertSameScope` の等値で互いの状態を書き換えられる
    assert.throws(
      () =>
        reduceTaskWorkState(
          { state: emptyState({ sourceAgent: blank }), history: [], operationStarts: new Map() },
          startEvent({ sourceAgent: blank }),
          new Map(),
        ),
      /sourceAgent が空文字/,
      `sourceAgent = ${JSON.stringify(blank)}`,
    );
    assert.throws(
      () => reduceTaskWorkState(emptySnapshot(), startEvent({ operation: { ...START_OPERATION, operationMatchKey: blank } }), new Map()),
      /§3.1 違反/,
    );
  }
  // 空白を含むだけの値と "0" は identity として妥当なので落とさない
  assert.equal(reduceTaskWorkState(emptySnapshot(), startEvent({ sessionId: "session 1" }), new Map()).outcome, "applied");
  assert.equal(reduceTaskWorkState(emptySnapshot(), startEvent({ sessionId: "0" }), new Map()).outcome, "applied");
  // adapterDeliveryId は「無い」を表せるので落とさず fingerprint に落ちる
  assert.equal(idempotencyKeyOf(startEvent({ adapterDeliveryId: " " })), "fingerprint-start");
});

test("再配送 start が session を変えたら隔離する", () => {
  // operationId は eventId + matchKey から導出するので session を含まない。assertSameScope は
  // lineage と Agent しか束縛せず、状態は session を持たない。ここで比べないと誰も比べない
  const started = startedSnapshot(startEvent({ operation: MATCH_KEY_ONLY }));
  const moved = reduceTaskWorkState(
    started,
    startEvent({ operation: MATCH_KEY_ONLY, sessionId: "session-2", ingestSeq: "13" }),
    new Map(),
  );
  assert.equal(moved.outcome, "quarantined");
  assert.deepEqual(
    moved.diagnostics.map((d) => d.code),
    ["start_conflict"],
  );
  assert.equal(moved.snapshot.state.pendingOperations[0]?.correlation.sessionId, "session-1");
  // 対照: session が同じ再配送は従来どおり重複
  const same = reduceTaskWorkState(
    started,
    startEvent({ operation: MATCH_KEY_ONLY, ingestSeq: "13" }),
    new Map(),
  );
  assert.deepEqual(
    same.diagnostics.map((d) => d.code),
    ["duplicate_operation_start"],
  );
});

test("放棄で証跡を記録できなかった operation は還元器と同じく報告する", () => {
  const started = startedSnapshot(startEvent({ operation: MATCH_KEY_ONLY }));
  const pending = started.state.pendingOperations[0];
  if (pending === undefined) assert.fail("pending が無い");
  const ended = startEvent({
    eventId: "event-end", adapterDeliveryId: "delivery-end", canonicalFingerprint: "fingerprint-end",
    kind: "session_ended", operation: undefined, ingestSeq: "20",
  });
  const full = Array.from({ length: CONTINUITY_LIMITS.arrayItems }, (_, i) => `filler-${i}`);
  const truncated = finalizeAbandonedState(
    { ...started.state, pendingOperations: [{ ...pending, sourceEventIds: full }] },
    ended,
    new Map(),
  );
  assert.equal(truncated.outcome, "applied");
  assert.equal(truncated.state.pendingOperations[0]?.status, "unknown");
  assert.deepEqual(
    truncated.diagnostics.map((d) => d.code),
    ["source_events_truncated"],
  );
  // 対照: 余裕があれば診断は出ず、証跡が入る
  const recorded = finalizeAbandonedState(started.state, ended, new Map());
  assert.deepEqual(recorded.diagnostics, []);
  assert.equal(recorded.state.pendingOperations[0]?.sourceEventIds.includes("event-end"), true);
});

test("直接呼びの correlateTerminalEvent も envelope の欠落を schema violation にする", () => {
  // 公開 API なので還元器を経由しない呼び出しがありうる。ここを飛ばすと §3.1 違反が
  // 「照合できなかっただけ」の terminal_unmatched に化けて、壊れた証跡がそのまま残る
  assert.throws(
    () => correlateTerminalEvent(emptySnapshot(), terminalEvent({ operation: undefined })),
    /operation envelope が無い/,
  );
});

test("再配送 start が turn を変えたら隔離する", () => {
  // §4.3 は matchKey の入力に「turn when present」を含むので、正しく導出された matchKey なら
  // turn が違えば matchKey も違う。導出は wire 越しに検証できないので、記録された turn を
  // 素通りさせると rule 2 の候補選びが古い turn で絞り、本来の turn の terminal が閉じられない
  const started = startedSnapshot(startEvent({ operation: MATCH_KEY_ONLY }));
  const moved = reduceTaskWorkState(
    started,
    startEvent({ operation: MATCH_KEY_ONLY, turnId: "turn-2", ingestSeq: "13" }),
    new Map(),
  );
  assert.equal(moved.outcome, "quarantined");
  assert.deepEqual(
    moved.diagnostics.map((d) => d.code),
    ["start_conflict"],
  );
  assert.equal(moved.snapshot.state.pendingOperations[0]?.correlation.turnId, "turn-1");
  // `turnId` は OperationCorrelationV1 の required に無く unavailable では正当に不在なので、
  // 片側だけ持たない再配送は隔離しない（復元で欠けた状態に届いた健全な再配送を殺さない）
  const unavailable = reduceTaskWorkState(
    started,
    startEvent({ operation: MATCH_KEY_ONLY, turnId: undefined, turnIdSource: "unavailable", ingestSeq: "13" }),
    new Map(),
  );
  assert.deepEqual(
    unavailable.diagnostics.map((d) => d.code),
    ["duplicate_operation_start"],
  );
});

// --- round 12: intake authority の空白・公開 API の scope・turn 種別（#37） -------

test("空白だけの intake authority 値は native を成立させない", () => {
  // 「未設定」を空文字で表すとは限らない。空白 1 文字・タブ・書式制御文字で表す daemon でも、
  // caller が同じ値を名乗れば一致してしまうので、identity 材料と同じ `isBlank` で落とす
  for (const blank of ["", " ", "\t", "\u{200B}", "\u{FEFF}"]) {
    const label = JSON.stringify(blank);
    const hashBlank = stampIntakeEvidence(
      { ...startEvent(), provenance: { ...startEvent().provenance, capabilityHash: blank } },
      { ...INTAKE, activeCapabilityHash: blank },
    );
    assert.equal(hashBlank.event.provenance.evidenceKind, "synthesized", `capabilityHash ${label}`);
    const agentBlank = stampIntakeEvidence(
      { ...startEvent(), sourceAgent: blank },
      { ...INTAKE, expectedSourceAgent: blank },
    );
    assert.equal(agentBlank.event.provenance.evidenceKind, "synthesized", `sourceAgent ${label}`);
    const versionBlank = stampIntakeEvidence(
      { ...startEvent(), provenance: { ...startEvent().provenance, sourceAgentVersion: blank } },
      { ...INTAKE, exactAgentVersion: blank },
    );
    assert.equal(versionBlank.event.provenance.evidenceKind, "synthesized", `version ${label}`);
  }
  // 対照: 空白を含むが空白だけではない値は従来どおり native
  const spaced = "2.1.228 (Claude Code)";
  assert.equal(stampIntakeEvidence(startEvent(), { ...INTAKE, exactAgentVersion: spaced }).event.provenance.evidenceKind, "native");
});

// --- round 13: 受領証の identity 欄と scenarioId の空白（#37） ---

test("欄が空白だけの受領証は native authority の根拠にならない", () => {
  // §3.1 は受領証を「その認証済み取り込みの receipt」と定義し、evidenceKind を「認証済み
  // peer identity」から導けと言う。認証できない経路を undefined ではなく空の受領証で表す
  // daemon では、存在だけを見ると誰も名乗っていない受領証で native が成立する
  for (const blank of ["", " ", "\t", "\u{200B}", "\u{FEFF}"]) {
    const label = JSON.stringify(blank);
    const receiptBlank = stampIntakeEvidence(startEvent(), {
      ...INTAKE,
      attestation: { ...ATTESTATION, ingestReceiptId: blank },
    });
    assert.equal(receiptBlank.event.provenance.evidenceKind, "synthesized", `receiptId ${label}`);
    // 認証が成立しない以上、その version についての turn identity の証明も適用できない
    assert.equal(receiptBlank.event.turnIdSource, "unavailable", `receiptId ${label} turn`);
    const peerBlank = stampIntakeEvidence(startEvent(), {
      ...INTAKE,
      attestation: { ...ATTESTATION, peerIdentityId: blank },
    });
    assert.equal(peerBlank.event.provenance.evidenceKind, "synthesized", `peerId ${label}`);
    assert.equal(peerBlank.event.turnIdSource, "unavailable", `peerId ${label} turn`);
  }
  // 対照: 欄が埋まっている受領証は従来どおり native
  assert.equal(stampIntakeEvidence(startEvent(), INTAKE).event.provenance.evidenceKind, "native");
});

test("空白だけの scenarioId は proven な scenario を名指したことにならない", () => {
  // §3.1 の proven は `scenarioId` が scenario を naming していることを要求する。matrix 側にも
  // 空白の entry がある daemon で、caller が同じ空白を名乗ると等値で proven が成立してしまう
  for (const blank of ["", " ", "\t", "\u{200B}", "\u{FEFF}"]) {
    const stamped = stampIntakeEvidence(
      { ...startEvent(), provenance: { ...startEvent().provenance, scenarioId: blank } },
      { ...INTAKE, provenScenarios: [{ scenarioId: blank, captureMethod: "native_event", channel: "rpc" }] },
    );
    assert.equal(stamped.event.provenance.evidenceKind, "synthesized", JSON.stringify(blank));
  }
  // 対照: 名前が実体を持つなら従来どおり native（空白を含むだけの id は落とさない）
  const spaced = "tool call lifecycle";
  assert.equal(
    stampIntakeEvidence(
      { ...startEvent(), provenance: { ...startEvent().provenance, scenarioId: spaced } },
      { ...INTAKE, provenScenarios: [{ scenarioId: spaced, captureMethod: "native_event", channel: "rpc" }] },
    ).event.provenance.evidenceKind,
    "native",
  );
});

test("直接呼びの correlateTerminalEvent も空白の identity 材料を拒否する", () => {
  // `assertSameScope` は lineage と Agent しか束縛せず、候補の絞り込みは `sessionId` の等値
  // だけを見る。空白の `sessionId` を持つ terminal は、同じく空白の `sessionId` を持つ
  // pending（復元した checkpoint や別実装が書いた状態。凍結 schema に minLength は無い）と
  // 一致して閉じてしまう。空白同士は「同じ session」ではなく「どちらも名乗っていない」
  // 還元器は空白の sessionId を受け付けないので、被害側の状態は「復元した checkpoint」を模して
  // 正常に作った pending の sessionId だけを空にする
  const started = startedSnapshot(startEvent({ operation: MATCH_KEY_ONLY }));
  const victim: TaskWorkStateSnapshotV1 = {
    ...started,
    state: {
      ...started.state,
      pendingOperations: started.state.pendingOperations.map((pending) => ({
        ...pending,
        correlation: { ...pending.correlation, sessionId: "" },
      })),
    },
  };
  for (const blank of ["", " ", "\t", "\u{200B}"]) {
    assert.throws(
      () =>
        correlateTerminalEvent(
          victim,
          terminalEvent({ sessionId: blank, operation: { ...MATCH_KEY_ONLY, phase: "terminal" } }),
        ),
      /sessionId が空文字/,
      JSON.stringify(blank),
    );
  }
  // 対照: 名乗りのある session は従来どおり照合まで進む（ここでは候補ゼロ）
  const ok = correlateTerminalEvent(victim, terminalEvent({ sessionId: "session-2" }));
  if (ok.matched !== null) assert.fail("別 session の pending を閉じた");
  assert.equal(ok.diagnostic, "terminal_orphaned");
});

test("直接呼びの correlateTerminalEvent も decimal string でない ingestSeq を拒否する", () => {
  // §22.6 の制約は `compareIngestSeq` が start を選んだ後にしか走らないので、候補ゼロで
  // 早期 return する経路では検査されない。還元器は入口で落とすのに直接呼びだけが
  // `terminal_orphaned` を返すと、§22.6 違反が正常な結果に化けて壊れた順序証跡が残る
  for (const bad of ["", " ", "007", "1e3", "-1", "1.0", "abc"]) {
    assert.throws(
      () => correlateTerminalEvent(emptySnapshot(), terminalEvent({ ingestSeq: bad })),
      /ingestSeq が decimal string でない/,
      JSON.stringify(bad),
    );
  }
  // 対照: 妥当な decimal string は従来どおり照合の結果（ここでは候補ゼロ）を返す
  const ok = correlateTerminalEvent(emptySnapshot(), terminalEvent({ ingestSeq: "12" }));
  if (ok.matched !== null) assert.fail("候補が無いのに閉じた");
  assert.equal(ok.diagnostic, "terminal_orphaned");
});

test("直接呼びの correlateTerminalEvent も別 Agent の terminal を拒否する", () => {
  // 候補の絞り込みは session と lineage しか見ない。還元器と同じ検査を入口でしないと、
  // 別 Agent の terminal が「権威ある一致」として返り、consumer がそれを適用する
  const started = startedSnapshot(startEvent());
  assert.throws(
    () => correlateTerminalEvent(started, terminalEvent({ sourceAgent: "codex" })),
    /別 Agent の event は適用しない/,
  );
  // 対照: 同じ Agent は従来どおり閉じられる
  assert.equal(correlateTerminalEvent(started, terminalEvent()).matched?.status, "started");
});

test("turn 種別が違う候補は rule 2 の候補から外す", () => {
  // §4.3「rule 2 は双方が同じ turnIdSource 種別の turn 同一性を持つことを要求する」。
  // 同じ matchKey・同じ turnId で種別だけ違う 2 件が並ぶとき、種別で絞れば 1 件になるので
  // rule 2 の「exactly one open candidate」が成立する
  const prepared = apply(emptySnapshot(), [
    startEvent({ eventId: "start-a", adapterDeliveryId: "d-sa", canonicalFingerprint: "f-sa", operation: MATCH_KEY_ONLY, ingestSeq: "11", turnIdSource: "native" }),
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-sb", canonicalFingerprint: "f-sb", operation: MATCH_KEY_ONLY, ingestSeq: "12", turnIdSource: "synthesized_monotonic" }),
  ]);
  assert.equal(prepared.snapshot.state.pendingOperations.length, 2);
  const closed = reduceTaskWorkState(
    prepared.snapshot,
    terminalEvent({ eventId: "term-x", adapterDeliveryId: "d-tx", canonicalFingerprint: "f-tx", ingestSeq: "13", operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "native" }),
    prepared.ledger,
  );
  assert.deepEqual(closed.diagnostics, []);
  assert.deepEqual(
    closed.snapshot.state.pendingOperations.map((p) => p.status),
    ["succeeded", "started"],
  );
});

test("turn 種別の材料が無い候補は種別違いとして落とさない", () => {
  // 種別は start 側の材料（operationStarts、#35）にしかなく、復元直後は空。材料が無いことを
  // 「種別が違う」と読むと、復元直後の全 terminal が理由を取り違えた診断になる
  const prepared = apply(emptySnapshot(), [
    startEvent({ eventId: "start-a", adapterDeliveryId: "d-sa", canonicalFingerprint: "f-sa", operation: MATCH_KEY_ONLY, ingestSeq: "11", turnIdSource: "native" }),
    startEvent({ eventId: "start-b", adapterDeliveryId: "d-sb", canonicalFingerprint: "f-sb", operation: MATCH_KEY_ONLY, ingestSeq: "12", turnIdSource: "synthesized_monotonic" }),
  ]);
  const restored = { state: prepared.snapshot.state, history: [], operationStarts: new Map() };
  const result = correlateTerminalEvent(
    restored,
    terminalEvent({ operation: { ...MATCH_KEY_ONLY, phase: "terminal" }, turnIdSource: "native" }),
  );
  // 材料が無いので 2 件とも残り、種別違いではなく曖昧として報告する
  if (result.matched !== null) assert.fail("材料が無いのに閉じた");
  assert.equal(result.diagnostic, "terminal_ambiguous");
  assert.equal(result.unresolved.length, 2);
});
