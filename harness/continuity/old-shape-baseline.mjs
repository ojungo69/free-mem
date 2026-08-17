#!/usr/bin/env node
/**
 * 旧形 corpus と、その corpus を**この branch の前の実装**に通した結果（baseline）を生成する。
 *
 * 生成物 `harness/fixtures/continuity/old-shape-parity.json` は入力と旧結果を両方含む committed
 * artifact で、`old-shape-parity.test.ts` がこの branch の実装と突き合わせる。実行時に git を
 * 引かないのは、この PR が main に入った時点で `origin/main` が変更後の実装になり、
 * 「main と比べる」門が自分で自分を無効化するため。基準は sha で固定する。
 *
 * 使い方:
 *   node harness/continuity/old-shape-baseline.mjs            # 固定 sha で再生成
 *   node harness/continuity/old-shape-baseline.mjs --source <sha>   # 基準を変える（差分に出る）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** この branch と origin/main の merge-base。「変更前の実装」の定義であり、勝手に動かさない */
const PINNED_SOURCE_COMMIT = "d517a8b49988b1109d56c1868edd8e0f5a1c85b5";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "harness", "fixtures", "continuity", "tool-lifecycle-reduction.json");
const OUTPUT_PATH = join(REPO_ROOT, "harness", "fixtures", "continuity", "old-shape-parity.json");

const sourceIndex = process.argv.indexOf("--source");
const sourceCommit = sourceIndex === -1 ? PINNED_SOURCE_COMMIT : process.argv[sourceIndex + 1];
if (sourceCommit !== PINNED_SOURCE_COMMIT) {
  console.warn(`⚠ 基準 sha を ${PINNED_SOURCE_COMMIT} から ${sourceCommit} に変えて生成する`);
}

// --- 旧形 corpus -----------------------------------------------------------
// 「旧形」= 新しい任意欄（startIngestSeq / startTurnIdSource / terminalFingerprint /
// droppedEvidence / adapterDeliveryId の記録側）を 1 つも持たない状態。復元された状態は
// 必ずこの形をしているので、event の種類ごとに 1 件ずつ通す。

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const { intakeContext } = fixture;
const [startTemplate, , terminalTemplate] = fixture.events;

/** 旧形の PendingOperation。凍結 schema の必須欄だけを持ち、新しい任意欄は 1 つも無い */
function oldShapePending(overrides = {}) {
  const { correlation: correlationOverrides, ...rest } = overrides;
  return {
    operationId: "op-restored",
    correlation: {
      operationId: "op-restored",
      startEventId: "event-start-before-restore",
      nativeOperationId: "toolu_1",
      operationMatchKey: "match-key-1",
      sessionId: "session-1",
      taskLineageId: "lineage-1",
      turnId: "turn-1",
      toolName: "Bash",
      canonicalInputHash: "input-hash-1",
      ...correlationOverrides,
    },
    kind: "tool",
    description: "restored pending operation",
    status: "started",
    replayPolicy: "never_auto",
    sourceEventIds: ["event-start-before-restore"],
    startedAt: "2026-08-16T00:00:01Z",
    sensitivity: "normal",
    ...rest,
  };
}

function restoredState(pendings) {
  return { ...fixture.initialState, pendingOperations: pendings };
}

function event(template, overrides = {}) {
  const { operation: operationOverrides, provenance: provenanceOverrides, ...rest } = overrides;
  const merged = { ...template, ...rest };
  if (operationOverrides === undefined) {
    // 明示的に undefined を渡した場合は operation を落とす（非 operation 系の kind）
    if ("operation" in overrides) delete merged.operation;
  } else {
    merged.operation = { ...template.operation, ...operationOverrides };
  }
  if (provenanceOverrides !== undefined) {
    merged.provenance = { ...template.provenance, ...provenanceOverrides };
  }
  return merged;
}

const CASES = [
  {
    name: "tool-lifecycle",
    description: "変更前から committed だった parity fixture の入力そのもの（start / 再配送 / terminal / 孤児 terminal）",
    initialState: fixture.initialState,
    events: fixture.events,
  },
  {
    name: "restored-native-id-terminal",
    description: "復元した旧形 pending（順序材料なし）に rule 1 の terminal が届く",
    initialState: restoredState([oldShapePending()]),
    events: [terminalTemplate],
  },
  {
    name: "restored-match-key-terminal",
    description: "同じ形を rule 2（matchKey 照合）で閉じる。nativeOperationId を名乗らない adapter",
    initialState: restoredState([oldShapePending({ correlation: { nativeOperationId: undefined } })]),
    events: [event(terminalTemplate, { operation: { nativeOperationId: undefined } })],
  },
  {
    name: "restored-terminal-redelivered",
    description: "旧形 pending を閉じた terminal が同じ配送 ID で再送される",
    initialState: restoredState([oldShapePending()]),
    events: [
      terminalTemplate,
      event(terminalTemplate, { eventId: "event-terminal-again", ingestSeq: "9007199254740998" }),
    ],
  },
  {
    name: "restored-unknown-terminal",
    description: "旧形 pending に successful を持たない terminal が届き unknown に倒れる",
    initialState: restoredState([oldShapePending()]),
    events: [event(terminalTemplate, { successful: undefined })],
  },
  {
    name: "restored-non-operation-event",
    description: "旧形 pending を抱えたまま operation 系でない event が届く",
    initialState: restoredState([oldShapePending()]),
    events: [
      event(startTemplate, {
        eventId: "event-assistant",
        adapterDeliveryId: "delivery-assistant",
        canonicalFingerprint: "fingerprint-assistant",
        kind: "assistant_completed",
        ingestSeq: "9007199254740999",
        operation: undefined,
      }),
    ],
  },
  {
    name: "restored-orphan-terminal-redelivered",
    description:
      "相手の居ない terminal が同じ配送 ID で 2 度届く。**隔離は配送鍵を消費しない**ので" +
      "台帳は 2 通目を止めない。止められるのは記録側の鍵だけ（#39）",
    initialState: fixture.initialState,
    events: [
      fixture.events[3],
      event(fixture.events[3], { eventId: "event-terminal-orphan-again" }),
    ],
  },
  {
    name: "restored-abandonment",
    description: "旧形 pending を抱えた状態で session が終わる（放棄経路）",
    initialState: restoredState([oldShapePending()]),
    events: [],
    abandonEvent: event(startTemplate, {
      eventId: "event-abandon",
      adapterDeliveryId: "delivery-abandon",
      canonicalFingerprint: "fingerprint-abandon",
      kind: "session_ended",
      ingestSeq: "9007199254741000",
      operation: undefined,
    }),
  },
];

// --- 変更前の実装を読み込む -------------------------------------------------
// 相対 import (`../schema/*.ts`) が解決するよう、同じディレクトリに置いて読む。
// schema 側の runtime 値はこの PR では追加しかしていないので、旧実装はそのまま動く。
const scratch = mkdtempSync(join(tmpdir(), "old-shape-baseline-"));
const oldModulePath = join(HERE, ".old-shape-baseline-reducer.ts");
try {
  const source = execFileSync("git", ["show", `${sourceCommit}:harness/continuity/reference-model.ts`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(oldModulePath, source);
  const old = await import(pathToFileURL(oldModulePath).href);
  const { projectOldShape } = await import(pathToFileURL(join(HERE, "old-shape-projection.ts")).href);

  // `{ nativeOperationId: undefined }` のような「欄を消す」上書きは、値が undefined の key として
  // 残る。committed fixture は JSON なので、走らせる前に JSON の形へ落として欄ごと消す
  const cases = CASES.map((raw) => JSON.parse(JSON.stringify(raw))).map((testCase) => {
    let state = testCase.initialState;
    let history = [];
    let ledger = new Map();
    // 変更前の snapshot は状態の外に `operationStarts` を持っていた。**状態だけを渡された**
    // 実装ではこれが空になる（それが #35 の欠陥そのもの）ので、復元を再現するなら空で始めるのが
    // 正しい。同じ session 内で start を受けた case では、旧実装がここを埋めながら進む
    let operationStarts = new Map();
    const baseline = [];
    for (const raw of testCase.events) {
      const stamped = old.stampIntakeEvidence(raw, intakeContext).event;
      const result = old.reduceTaskWorkState({ state, history, operationStarts }, stamped, ledger);
      state = result.snapshot.state;
      history = result.snapshot.history;
      operationStarts = result.snapshot.operationStarts;
      ledger = result.ledger;
      baseline.push({
        eventId: stamped.eventId,
        ...projectOldShape({
          outcome: result.outcome,
          diagnostics: result.diagnostics,
          state,
          historyLength: history.length,
          ledgerSize: ledger.size,
        }),
      });
    }
    if (testCase.abandonEvent !== undefined) {
      const stamped = old.stampIntakeEvidence(testCase.abandonEvent, intakeContext).event;
      const result = old.finalizeAbandonedState(state, stamped, ledger);
      baseline.push({
        eventId: `${stamped.eventId}#abandon`,
        ...projectOldShape({
          outcome: result.outcome,
          diagnostics: result.diagnostics,
          state: result.state,
          historyLength: history.length,
          ledgerSize: result.ledger.size,
        }),
      });
    }
    return { ...testCase, baseline };
  });

  const output = {
    fixtureId: "old-shape-parity",
    description:
      "旧形（新しい任意欄を持たない）状態と event を、この branch の変更前の実装に通した結果。" +
      "SC-003 の「旧形入力に対する振る舞いは 4 件の是正以外変わらない」を機械的に検証するための基準。",
    sourceCommit,
    generatedBy: "harness/continuity/old-shape-baseline.mjs",
    intakeContext,
    cases,
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  const events = cases.reduce((sum, testCase) => sum + testCase.baseline.length, 0);
  console.log(`${OUTPUT_PATH} を生成した: ${cases.length} case / ${events} step（基準 ${sourceCommit}）`);
} finally {
  rmSync(oldModulePath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
