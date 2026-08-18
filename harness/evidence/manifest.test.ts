// manifest と fixture・観測記録の照合表（data-model.md §2.5）を 1 項目ずつ反転する。
// 表の 1 行を落としても他の 10 行が通るので、まとめて 1 件の test にすると穴が見えない。
import assert from "node:assert/strict";
import test from "node:test";
import type { assembleFromFixtures } from "../assemble.ts";
import { assembleWithRoot, atTime, fixtureBase, lifecycle, newRoot, putEvidence, subagentRun } from "./synthetic.ts";

const AT = "2026-08-12T00:00:00.000Z";

/**
 * manifest 付きの証拠 1 件で組み立てる。`manifestOverrides` は manifest 側だけを、
 * `fixtureOverrides` は fixture 側だけを動かす。
 */
function build(
  manifestOverrides: Record<string, unknown> = {},
  fixtureOverrides: Record<string, unknown> = {},
): ReturnType<typeof assembleFromFixtures> {
  const root = newRoot();
  const ref = putEvidence(root, "backed", lifecycle("s1", "p1"), { manifest: true, manifestOverrides });
  const fixture = fixtureBase({
    fixtureId: "claude/backed",
    observedEvents: [{ kind: "session_started", at: AT, capability: "native", sourceEvents: ["SessionStart"] }],
    evidence: [ref],
    ...fixtureOverrides,
  });
  return assembleWithRoot([fixture], root);
}

test("an unmodified rig manifest promotes the cell", () => {
  const m = build();
  assert.equal(m.capabilities.capture.session_started.evidenceKind, "real-cli-e2e");
});

// 表の 11 項目。どれか 1 つでも照合を落とすと、その行の test だけが通ってしまう。
// test 名は literal で並べる（変異表との突き合わせが grep で効く形にするため）
const INVERSIONS: Array<[string, string, Record<string, unknown>]> = [
  ["manifest manifestVersion that disagrees is rejected", "manifestVersion", { manifestVersion: 2 }],
  ["manifest cli that disagrees is rejected", "cli", { cli: "codex" }],
  ["manifest cliVersion that disagrees is rejected", "cliVersion", { cliVersion: "0.0.0-other" }],
  ["manifest scenarioId that disagrees is rejected", "scenarioId", { scenarioId: "other.scenario" }],
  ["manifest capturedAt that disagrees is rejected", "capturedAt", { capturedAt: "2026-01-01T00:00:00.000Z" }],
  ["manifest capture that disagrees is rejected", "capture", { capture: "somewhere-else.jsonl" }],
  ["manifest captureRawHash that disagrees is rejected", "captureRawHash", { captureRawHash: "b".repeat(64) }],
  ["manifest captureHash that disagrees is rejected", "captureHash", { captureHash: "c".repeat(64) }],
  ["manifest normalizationVersion that disagrees is rejected", "normalizationVersion", { normalizationVersion: 2 }],
  ["manifest isolated that disagrees is rejected", "isolated", { isolated: false }],
  ["manifest recorderErrors that disagrees is rejected", "recorderErrors", { recorderErrors: 1 }],
];

for (const [testName, field, manifestOverrides] of INVERSIONS) {
  test(testName, () => {
    // 動的な RegExp を作らずに部分一致で見る（静的解析が RegExp の非リテラル引数を拾う）
    assert.throws(
      () => build(manifestOverrides),
      (e: unknown) => String(e).includes(`manifest ${field}`),
      `manifest ${field} の照合が効いていない`,
    );
  });
}

test("manifest internalRunMarker must be true, not merely equal to the fixture", () => {
  // 「fixture と一致」で見ていると、双方 false の組み合わせが通ってしまう。
  // 隔離 rig の外で取った記録を real-cli-e2e として載せる経路がそこに開く
  assert.throws(
    () => build({ internalRunMarker: false }, { rig: { isolated: true, internalRunMarker: false } }),
    /manifest internalRunMarker/,
  );
  assert.throws(() => build({ internalRunMarker: false }), /manifest internalRunMarker/);
});

// 1 つの fixture は複数の run を束ねる（claude/interrupt-and-hook-timeout は 5 本参照する）。
// capturedAt を fixture 単位で縛ると、2 本目以降の manifest が構造的に通らなくなる
test("a fixture that references two runs carries a manifest for each", () => {
  const root = newRoot();
  const first = putEvidence(root, "run-1", lifecycle("s1", "p1"), { manifest: true });
  const second = putEvidence(root, "run-2", atTime(lifecycle("s2", "p2"), "2026-08-13T09:30:00.000Z"), {
    manifest: true,
  });
  const m = assembleWithRoot(
    [
      fixtureBase({
        fixtureId: "claude/two-runs",
        observedEvents: [{ kind: "session_started", at: AT, capability: "native", sourceEvents: ["SessionStart"] }],
        evidence: [first, second],
      }),
    ],
    root,
  );
  assert.equal(m.capabilities.capture.session_started.evidenceKind, "real-cli-e2e");
  // 公開する時刻は fixture の申告ではなく、根拠になった記録の側から来る
  assert.equal(m.capabilities.capture.session_started.verifiedAt, "2026-08-13T09:30:00.000Z");
});

// 遅いほうを選ぶ判定は「文字列の大小」ではない。小数秒の桁数が違うと
// `…:00.1Z` < `…:00Z` になり、文字列比較は早いほうを選んでしまう
test("verifiedAt picks the later instant, not the larger string", () => {
  const root = newRoot();
  const late = putEvidence(root, "run-late", atTime(lifecycle("s1", "p1"), "2026-08-13T09:30:00.1Z"), {
    manifest: true,
  });
  const early = putEvidence(root, "run-early", atTime(lifecycle("s2", "p2"), "2026-08-13T09:30:00Z"), {
    manifest: true,
  });
  const m = assembleWithRoot(
    [
      fixtureBase({
        fixtureId: "claude/fractional",
        observedEvents: [{ kind: "session_started", at: AT, capability: "native", sourceEvents: ["SessionStart"] }],
        evidence: [late, early],
      }),
    ],
    root,
  );
  assert.equal(m.capabilities.capture.session_started.verifiedAt, "2026-08-13T09:30:00.1Z");
});

test("manifest capturedAt must come from the capture, not from the fixture", () => {
  const root = newRoot();
  const ref = putEvidence(root, "late", atTime(lifecycle("s1", "p1"), "2026-08-13T09:30:00.000Z"), {
    manifest: true,
    manifestOverrides: { capturedAt: AT },
  });
  assert.throws(
    () =>
      assembleWithRoot(
        [
          fixtureBase({
            fixtureId: "claude/late",
            observedEvents: [{ kind: "session_started", at: AT, capability: "native", sourceEvents: ["SessionStart"] }],
            evidence: [ref],
          }),
        ],
        root,
      ),
    (e: unknown) => String(e).includes("manifest capturedAt"),
  );
});

// 申告した hook 名が「どれかの記録に在る」だけでは足りない。裏付けのある 1 本が
// 値も導き、申告した hook 名も全部持っていること
test("a claimed source event that lives only in an unbacked capture does not promote", () => {
  const root = newRoot();
  const backed = putEvidence(root, "backed", lifecycle("s1", "p1"), { manifest: true });
  const legacy = putEvidence(root, "legacy", subagentRun("s2"));
  const m = assembleWithRoot(
    [
      fixtureBase({
        fixtureId: "claude/split",
        observedEvents: [
          {
            kind: "session_started",
            at: AT,
            capability: "native",
            sourceEvents: ["SessionStart", "SubagentStop"],
          },
        ],
        evidence: [backed, legacy],
      }),
    ],
    root,
  );
  assert.equal(m.capabilities.capture.session_started.evidenceKind, "source-test");
});

// 証拠を持たない fixture は「申告した hook 名が記録に実在するか」の検査を素通りする
// （refs が空なので飛ばされる）。cell の統合でその名前を足すと、real-cli-e2e の cell が
// どの記録にも無い hook 名を主張する
test("an unbacked fixture cannot add a source event to a promoted cell", () => {
  const root = newRoot();
  const ref = putEvidence(root, "backed", lifecycle("s1", "p1"), { manifest: true });
  const event = (sourceEvents: string[]) => ({
    kind: "session_started",
    at: AT,
    capability: "native",
    sourceEvents,
  });
  const m = assembleWithRoot(
    [
      fixtureBase({
        fixtureId: "claude/a-backed",
        observedEvents: [event(["SessionStart"])],
        evidence: [ref],
      }),
      fixtureBase({ fixtureId: "claude/b-claim", observedEvents: [event(["SessionStart", "SubagentStop"])] }),
    ],
    root,
  );
  const cell = m.capabilities.capture.session_started;
  assert.equal(cell.evidenceKind, "real-cli-e2e");
  assert.deepEqual(cell.sourceEvents, ["SessionStart"]);
});
