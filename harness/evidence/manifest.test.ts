// manifest と fixture・観測記録の照合表（data-model.md §2.5）を 1 項目ずつ反転する。
// 表の 1 行を落としても他の 10 行が通るので、まとめて 1 件の test にすると穴が見えない。
import assert from "node:assert/strict";
import test from "node:test";
import type { assembleFromFixtures } from "../assemble.ts";
import { assembleWithRoot, fixtureBase, lifecycle, newRoot, putEvidence } from "./synthetic.ts";

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
