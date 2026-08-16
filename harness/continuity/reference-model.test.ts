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
    // 認証済みの adapter が他 Agent 名義の event を出しても native authority は得られない
    ["sourceAgent が受領証の Agent と違う", startEvent({ sourceAgent: "codex" })],
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
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_unmatched"],
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
    correlation: { ...template.correlation, operationId: `op-${index}` },
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
    ["Agent 名が受領証と違う", startEvent({ sourceAgent: "codex" }), INTAKE],
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
});

test("閉じた operation は 2 度目の terminal で書き換わらない", () => {
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
  assert.deepEqual(
    again.diagnostics.map((d) => d.code),
    ["terminal_already_applied"],
  );
  assert.equal(again.snapshot.state.pendingOperations[0]?.status, "succeeded");
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
    rejectedBy: "schema" | "runtime" | "intake";
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
    const stamped = stampIntakeEvidence(testCase.event, {
      ...fixture.intakeContext,
      ...testCase.intakeOverride,
    }).event;
    assert.equal(stamped.provenance.evidenceKind, "synthesized", testCase.name);
  }
  assert.deepEqual([...layers].sort(), ["intake", "runtime", "schema"]);

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
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_unmatched"],
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "started");
});

test("start が状態に無い terminal は隔離し、start を入れ直せば閉じられる", () => {
  // checkpoint から復元すると operationStarts が空になる（#35）。順序を確認できないだけの
  // 健全な terminal を「順序違反」として台帳に入れると、二度と閉じられなくなる
  const started = startedSnapshot();
  const restored: TaskWorkStateSnapshotV1 = { ...started, operationStarts: new Map() };
  const result = reduceTaskWorkState(restored, terminalEvent(), new Map());
  assert.equal(result.outcome, "quarantined");
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_order_unverifiable"],
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "started");
  assert.equal(result.ledger.size, 0);
  // start を取り込み直せば同じ terminal で閉じられる
  const closed = reduceTaskWorkState(started, terminalEvent(), result.ledger);
  assert.equal(closed.outcome, "applied");
  assert.equal(closed.snapshot.state.pendingOperations[0]?.status, "succeeded");
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


