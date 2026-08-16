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
  type TaskWorkStateSnapshotV1,
} from "./reference-model.ts";

const SCHEMA_ROOT = readIJsonFile<JsonSchemaDocument>(
  new URL("../schema/continuity.schema.json", import.meta.url),
);

const CAPABILITY_HASH = "b1946ac92492d2347c6235b4d2611184e2f4a1d94d4b3f7d3b5c3f9d0c6e8a11";
const VERSION = "2.1.228 (Claude Code)";

const INTAKE: IntakeContextV1 = {
  exactAgentVersion: VERSION,
  activeCapabilityHash: CAPABILITY_HASH,
  provenScenarios: [
    { scenarioId: "tool-call-lifecycle", captureMethod: "native_event", channel: "rpc" },
  ],
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
  return { state: emptyState(overrides), history: [], operationStartSeq: new Map() };
}

function startEvent(overrides: Partial<NormalizedContinuityEvent> = {}): NormalizedContinuityEvent {
  return {
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
      ingestAttestation: {
        ingestReceiptId: "receipt-1",
        peerIdentityId: "peer-1",
        channel: "rpc",
        attestedAt: "2026-08-16T00:00:01Z",
      },
    },
    operation: {
      phase: "start",
      operationMatchKey: "match-key-1",
      operationKind: "Bash",
      nativeOperationId: "toolu_1",
      canonicalInputHash: "input-hash-1",
    },
    payload: { tool_name: "Bash" },
    ...overrides,
  };
}

function terminalEvent(overrides: Partial<NormalizedContinuityEvent> = {}): NormalizedContinuityEvent {
  const base = startEvent();
  return {
    ...base,
    eventId: "event-terminal",
    adapterDeliveryId: "delivery-terminal",
    canonicalFingerprint: "fingerprint-terminal",
    kind: "tool_completed",
    ingestSeq: "12",
    occurredAt: "2026-08-16T00:00:02Z",
    operation: { ...base.operation!, phase: "terminal" },
    payload: { tool_response: "ok" },
    successful: true,
    ...overrides,
  };
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
  events: readonly NormalizedContinuityEvent[],
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
  assert.equal(first.applied, true);
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
    assert.equal(result.applied, false);
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
  assert.equal(again.applied, false);
});

test("配送 ID が違えば別の論理 event として適用される", () => {
  // §8.2 の第一 authority は adapterDeliveryId。同じ fingerprint でも配送 ID が違えば
  // 「同一論理 event の再送」ではない
  const first = reduceTaskWorkState(emptySnapshot(), startEvent(), new Map());
  const other = startEvent({
    eventId: "event-start-2",
    adapterDeliveryId: "delivery-start-2",
    ingestSeq: "13",
    operation: { ...startEvent().operation!, operationMatchKey: "match-key-2", nativeOperationId: "toolu_2" },
  });
  const second = reduceTaskWorkState(first.snapshot, other, first.ledger);
  assert.equal(second.applied, true);
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
    () => assertOperationEnvelope(startEvent({ operation: { ...startEvent().operation!, phase: "terminal" } })),
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
    () => assertOperationEnvelope(startEvent({ operation: { ...startEvent().operation!, operationKind: "" } })),
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
  assert.equal(stampIntakeEvidence(startEvent(), INTAKE).provenance.evidenceKind, "native");
});

test("native の条件を 1 つでも欠けば synthesized へ落ちる", () => {
  const cases: Array<[string, NormalizedContinuityEvent]> = [
    [
      "ingestAttestation が無い",
      startEvent({ provenance: { ...startEvent().provenance, ingestAttestation: undefined } }),
    ],
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
      "channel が proven の組と違う",
      startEvent({
        provenance: {
          ...startEvent().provenance,
          ingestAttestation: { ...startEvent().provenance.ingestAttestation!, channel: "spool" },
        },
      }),
    ],
    [
      "sourceAgentVersion が exact でない",
      startEvent({ provenance: { ...startEvent().provenance, sourceAgentVersion: "2.1.228" } }),
    ],
  ];
  for (const [label, event] of cases) {
    assert.equal(stampIntakeEvidence(event, INTAKE).provenance.evidenceKind, "synthesized", label);
  }
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
  assert.equal(stampIntakeEvidence(forged, INTAKE).provenance.evidenceKind, "synthesized");
});

// --- §4.3 terminal correlation ---------------------------------------------

function startedSnapshot(event = startEvent()): TaskWorkStateSnapshotV1 {
  return reduceTaskWorkState(emptySnapshot(), event, new Map()).snapshot;
}

test("nativeOperationId 一致で terminal が閉じる", () => {
  const snapshot = startedSnapshot();
  const correlation = correlateTerminalEvent(snapshot, terminalEvent());
  assert.equal(correlation.rule, "native_operation_id");
  assert.notEqual(correlation.matched, null);

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
  assert.equal(correlation.rule, "match_key");
  assert.notEqual(correlation.matched, null);
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
  assert.equal(correlation.rule, "no_match");
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
    ["started", "started"],
  );
});

test("session や lineage が違う terminal は閉じない", () => {
  const snapshot = startedSnapshot();
  for (const differing of [
    terminalEvent({ sessionId: "session-2" }),
    terminalEvent({ taskLineageId: "lineage-2" }),
  ]) {
    const result = reduceTaskWorkState(snapshot, differing, new Map());
    assert.deepEqual(
      result.diagnostics.map((d) => d.code),
      ["terminal_unmatched"],
    );
  }
});

test("権威順序で start より前の terminal は閉じない", () => {
  const snapshot = startedSnapshot();
  const result = reduceTaskWorkState(snapshot, terminalEvent({ ingestSeq: "11" }), new Map());
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_out_of_order"],
  );
  assert.equal(result.snapshot.state.pendingOperations[0]?.status, "started");
});

test("canonicalInputHash が食い違う terminal は閉じない", () => {
  const snapshot = startedSnapshot();
  const conflicting = terminalEvent({
    operation: { ...terminalEvent().operation!, canonicalInputHash: "input-hash-other" },
  });
  const result = reduceTaskWorkState(snapshot, conflicting, new Map());
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["terminal_conflict"],
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
  const finalized = finalizeAbandonedState(snapshot.state, abandonEvent);
  assert.equal(finalized.pendingOperations[0]?.status, "unknown");
  // 再実行の可否は放棄では緩めない
  assert.equal(finalized.pendingOperations[0]?.replayPolicy, "never_auto");
  assert.equal(snapshot.state.pendingOperations[0]?.status, "started");
  assert.notEqual(finalized.stateRevision, snapshot.state.stateRevision);
  assert.equal(finalized.lastIngestSeq, "20");
});

test("放棄後に届いた terminal は元の operation を閉じる", () => {
  const snapshot = startedSnapshot();
  const abandoned = finalizeAbandonedState(snapshot.state, terminalEvent({
    eventId: "event-session-ended",
    kind: "session_ended",
    ingestSeq: "20",
    operation: undefined,
    successful: undefined,
  }));
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
    applied: boolean;
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
        () => reduceTaskWorkState(emptySnapshot(), testCase.event, new Map()),
        /§3.1 違反/,
        testCase.name,
      );
      continue;
    }
    const stamped = stampIntakeEvidence(testCase.event, fixture.intakeContext);
    assert.equal(stamped.provenance.evidenceKind, "synthesized", testCase.name);
  }
  assert.deepEqual([...layers].sort(), ["intake", "runtime", "schema"]);
});

test("fixture の期待値は参照実装の出力と一致する（TS/Rust parity の基準）", () => {
  const fixture = readIJsonFile<ReductionFixture>(
    new URL("../fixtures/continuity/tool-lifecycle-reduction.json", import.meta.url),
  );
  let snapshot: TaskWorkStateSnapshotV1 = {
    state: fixture.initialState,
    history: [],
    operationStartSeq: new Map(),
  };
  let ledger: IdempotencyLedger = new Map();
  const actual = fixture.events.map((raw) => {
    const event = stampIntakeEvidence(raw, fixture.intakeContext);
    const result = reduceTaskWorkState(snapshot, event, ledger);
    snapshot = result.snapshot;
    ledger = result.ledger;
    return {
      eventId: event.eventId,
      evidenceKind: event.provenance.evidenceKind,
      applied: result.applied,
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
