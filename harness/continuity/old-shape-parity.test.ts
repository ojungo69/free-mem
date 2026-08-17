import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { CanonicalWorkStateV1, NormalizedContinuityEvent } from "../schema/continuity.ts";
import {
  finalizeAbandonedState,
  reduceTaskWorkState,
  stampIntakeEvidence,
  type IdempotencyLedger,
  type WorkStateRevisionEntryV1,
} from "./reference-model.ts";
import { diffPaths, projectOldShape, valueAtPath, type OldShapeOutcomeV1 } from "./old-shape-projection.ts";

/**
 * SC-003（旧形の入力に対する振る舞いは #35 / #39 / #43 / #44 の是正以外変わらない）の門。
 *
 * 「変わらない」を行数や issue 番号で語ると検証できない主張になるので、**変更前の実装の出力**を
 * committed baseline として持ち、この実装の出力と突き合わせる。差分は 1 つ残らず下の
 * `ALLOWED_DELTAS` に、case 名・event・JSON path・**値**・issue 番号まで書いてあるものだけを許す。
 * baseline の作り方と基準 sha は `old-shape-baseline.mjs` を参照。
 *
 * 意図した振る舞いの変更で許可表を書き直すときは、手で写さずに実測を出す:
 *   OLD_SHAPE_PARITY_DUMP=1 node --experimental-strip-types --test harness/continuity/old-shape-parity.test.ts
 *
 * 門が見ていない経路（黙って間引かない）: `pendingOperations` が上限 256 件に達したときの退避
 * （#43 の `droppedEvidence` reason `evicted`）。corpus に 256 件の pending を committed で
 * 持つ必要があるため入れていない。この経路の証拠は `reference-model.test.ts` の退避 test 群と
 * `mutate.sh` の該当変異が持つ。
 */

interface ParityCase {
  readonly name: string;
  readonly description: string;
  readonly initialState: CanonicalWorkStateV1;
  readonly events: readonly NormalizedContinuityEvent[];
  readonly abandonEvent?: NormalizedContinuityEvent;
  readonly baseline: readonly (OldShapeOutcomeV1 & { readonly eventId: string })[];
}

interface ParityFixture {
  readonly sourceCommit: string;
  readonly intakeContext: Parameters<typeof stampIntakeEvidence>[1];
  readonly cases: readonly ParityCase[];
}

/** corpus が黙って縮まないための実数。case を消したら件数で落ちる */
const EXPECTED_CASES = 8;
const EXPECTED_STEPS = 13;

interface AllowedDelta {
  /** case 名 */
  readonly caseName: string;
  /** その step の eventId（放棄は `<eventId>#abandon`） */
  readonly eventId: string;
  /**
   * 変更前と食い違ってよい JSON path と、**そのときの値**。path だけを許すと
   * 「ここは何が起きてもよい」になり、記録が 2 件に増える退行を素通しする（#39 がまさにその形）。
   * ここに無い path が 1 つでもあれば落ちるし、ここにあるのに差分が出なくても落ちる。
   */
  readonly values: Readonly<Record<string, unknown>>;
  readonly issue: string;
  readonly why: string;
}

const ALLOWED_DELTAS: readonly AllowedDelta[] = [
  {
    caseName: "tool-lifecycle",
    eventId: "event-start",
    issue: "#35",
    why: "start の権威順序と turn 種別を状態に載せた。状態だけを渡された実装でも §4.3 の順序検査ができる",
    values: {
      "state.pendingOperations[0].startIngestSeq": "9007199254740994",
      "state.pendingOperations[0].startTurnIdSource": "native",
    },
  },
  {
    caseName: "tool-lifecycle",
    eventId: "event-start-redelivered",
    issue: "#35",
    why: "再配送は状態を変えないが、直前の start が書いた欄がそのまま見える",
    values: {
      "state.pendingOperations[0].startIngestSeq": "9007199254740994",
      "state.pendingOperations[0].startTurnIdSource": "native",
    },
  },
  {
    caseName: "tool-lifecycle",
    eventId: "event-terminal",
    issue: "#35 / #44",
    why: "閉じた terminal の指紋を残す。あとから届く別指紋の terminal を衝突として弾くため",
    values: {
      "state.pendingOperations[0].startIngestSeq": "9007199254740994",
      "state.pendingOperations[0].startTurnIdSource": "native",
      "state.pendingOperations[0].terminalFingerprint": "fingerprint-terminal",
    },
  },
  {
    caseName: "tool-lifecycle",
    eventId: "event-terminal-orphan",
    issue: "#35 / #43 / #44",
    why: "相手の居ない terminal を状態に記録する。隔離は配送鍵を消費しないので、状態の記録が唯一の証跡",
    values: {
      "diagnostics[1]": "dropped_evidence_recorded",
      "historyLength": 3,
      "state.droppedEvidence": [{"reason": "orphaned_terminal", "eventId": "event-terminal-orphan", "terminalFingerprint": "fingerprint-terminal-orphan", "adapterDeliveryId": "delivery-terminal-orphan", "recordedAt": "2026-08-16T00:00:04Z", "sensitivity": "private"}],
      "state.pendingOperations[0].startIngestSeq": "9007199254740994",
      "state.pendingOperations[0].startTurnIdSource": "native",
      "state.pendingOperations[0].terminalFingerprint": "fingerprint-terminal",
      "state.updatedAt": "2026-08-16T00:00:04Z",
    },
  },
  {
    caseName: "restored-orphan-terminal-redelivered",
    eventId: "event-terminal-orphan",
    issue: "#43",
    why: "同じ記録を、復元直後（pending が 1 件も無い状態）でも残す",
    values: {
      "diagnostics[1]": "dropped_evidence_recorded",
      "historyLength": 1,
      "state.droppedEvidence": [{"reason": "orphaned_terminal", "eventId": "event-terminal-orphan", "terminalFingerprint": "fingerprint-terminal-orphan", "adapterDeliveryId": "delivery-terminal-orphan", "recordedAt": "2026-08-16T00:00:04Z", "sensitivity": "private"}],
      "state.sensitivity": "private",
      "state.updatedAt": "2026-08-16T00:00:04Z",
    },
  },
  {
    caseName: "restored-orphan-terminal-redelivered",
    eventId: "event-terminal-orphan-again",
    issue: "#39",
    why: "再起動で台帳が空に戻っても記録は 1 件のまま。2 件に増えないことをこの値で固定する",
    values: {
      "historyLength": 1,
      "state.droppedEvidence": [{"reason": "orphaned_terminal", "eventId": "event-terminal-orphan", "terminalFingerprint": "fingerprint-terminal-orphan", "adapterDeliveryId": "delivery-terminal-orphan", "recordedAt": "2026-08-16T00:00:04Z", "sensitivity": "private"}],
      "state.sensitivity": "private",
      "state.updatedAt": "2026-08-16T00:00:04Z",
    },
  },
];

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/continuity/old-shape-parity.json", import.meta.url), "utf8"),
) as ParityFixture;

test("旧形の入力に対する振る舞いは、許可した差分以外は変更前と一致する（SC-003）", () => {
  assert.equal(fixture.cases.length, EXPECTED_CASES, "corpus の case 数が変わっている");
  const steps = fixture.cases.reduce((sum, testCase) => sum + testCase.baseline.length, 0);
  assert.equal(steps, EXPECTED_STEPS, "corpus の step 数が変わっている");

  const usedDeltas = new Set<AllowedDelta>();
  const unexplained: string[] = [];
  // 意図した振る舞いの変更のあとに allowlist を手で書き写すと転記を間違える。実測を出す
  const dump: unknown[] = [];

  for (const testCase of fixture.cases) {
    let snapshot = { state: testCase.initialState, history: [] as readonly WorkStateRevisionEntryV1[] };
    let ledger: IdempotencyLedger = new Map();
    const actual: (OldShapeOutcomeV1 & { eventId: string })[] = [];

    for (const raw of testCase.events) {
      const event = stampIntakeEvidence(raw, fixture.intakeContext).event;
      const result = reduceTaskWorkState(snapshot, event, ledger);
      snapshot = result.snapshot;
      ledger = result.ledger;
      actual.push({
        eventId: event.eventId,
        ...projectOldShape({
          outcome: result.outcome,
          diagnostics: result.diagnostics,
          state: result.snapshot.state as unknown as Record<string, unknown>,
          historyLength: result.snapshot.history.length,
          ledgerSize: ledger.size,
        }),
      });
    }

    if (testCase.abandonEvent !== undefined) {
      const event = stampIntakeEvidence(testCase.abandonEvent, fixture.intakeContext).event;
      const result = finalizeAbandonedState(snapshot.state, event, ledger);
      actual.push({
        eventId: `${event.eventId}#abandon`,
        ...projectOldShape({
          outcome: result.outcome,
          diagnostics: result.diagnostics,
          state: result.state as unknown as Record<string, unknown>,
          historyLength: snapshot.history.length,
          ledgerSize: result.ledger.size,
        }),
      });
    }

    assert.equal(
      actual.length,
      testCase.baseline.length,
      `${testCase.name}: step 数が baseline と違う（event が黙って落ちている）`,
    );

    for (const [index, expected] of testCase.baseline.entries()) {
      const produced = actual[index] as OldShapeOutcomeV1 & { eventId: string };
      assert.equal(produced.eventId, expected.eventId, `${testCase.name}: step ${index} の event が違う`);
      const { eventId: _e1, ...before } = expected;
      const { eventId: _e2, ...after } = produced;
      const differing = diffPaths(before, after);
      const describe = (paths: readonly string[]): string =>
        paths.map((path) => `${path}=${JSON.stringify(valueAtPath(after, path))}`).join(", ");
      if (differing.length === 0) continue;
      if (process.env.OLD_SHAPE_PARITY_DUMP === "1") {
        dump.push({
          caseName: testCase.name,
          eventId: expected.eventId,
          values: Object.fromEntries(differing.map((path) => [path, valueAtPath(after, path)])),
        });
      }
      const allowed = ALLOWED_DELTAS.find(
        (entry) => entry.caseName === testCase.name && entry.eventId === expected.eventId,
      );
      if (allowed === undefined) {
        unexplained.push(`${testCase.name} / ${expected.eventId}: ${describe(differing)}`);
        continue;
      }
      usedDeltas.add(allowed);
      const extra = differing.filter((path) => !(path in allowed.values));
      if (extra.length > 0) unexplained.push(`${testCase.name} / ${expected.eventId}: ${describe(extra)}`);
      for (const [path, value] of Object.entries(allowed.values)) {
        if (!differing.includes(path)) {
          unexplained.push(`${testCase.name} / ${expected.eventId}: 許可したのに差分が無い path ${path}`);
          continue;
        }
        try {
          assert.deepEqual(valueAtPath(after, path), value);
        } catch {
          unexplained.push(`${testCase.name} / ${expected.eventId}: ${describe([path])} は許可した値と違う`);
        }
      }
    }
  }

  if (dump.length > 0) console.log(JSON.stringify(dump, null, 2));
  assert.deepEqual(unexplained, [], "許可していない振る舞いの差分がある");
  // 締めすぎた門は自分の test からは漏れる。使われなかった許可は「もう起きない差分」なので、
  // 残すと allowlist が実際より広く見える
  const unused = ALLOWED_DELTAS.filter((entry) => !usedDeltas.has(entry));
  assert.deepEqual(unused.map((entry) => `${entry.caseName} / ${entry.eventId}`), []);
});

test("baseline は変更前の実装から生成されている（基準 sha を動かすと落ちる）", () => {
  assert.equal(fixture.sourceCommit, "d517a8b49988b1109d56c1868edd8e0f5a1c85b5");
});
