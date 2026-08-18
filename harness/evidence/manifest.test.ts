// manifest と fixture・観測記録の照合表（data-model.md §2.5）を 1 項目ずつ反転する。
// 表の 1 行を落としても他の 10 行が通るので、まとめて 1 件の test にすると穴が見えない。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleFromFixtures, validateFixture } from "../assemble.ts";
import type { CaptureFixture } from "../schema/capability.ts";
import { fixtureBase, lifecycle, putEvidence } from "./synthetic.ts";

const AT = "2026-08-12T00:00:00.000Z";
const newRoot = (): string => mkdtempSync(join(tmpdir(), "manifest-"));

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
  return assembleFromFixtures([validateFixture(fixture, "f.json") as CaptureFixture], { evidenceRoot: root });
}

test("an unmodified rig manifest promotes the cell", () => {
  const m = build();
  assert.equal(m.capabilities.capture.session_started?.evidenceKind, "real-cli-e2e");
});

// 表の 11 項目。どれか 1 つでも照合を落とすと、その行の test だけが通ってしまう
const INVERSIONS: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
  ["manifestVersion", { manifestVersion: 2 }],
  ["cli", { cli: "codex" }],
  ["cliVersion", { cliVersion: "0.0.0-other" }],
  ["scenarioId", { scenarioId: "other.scenario" }],
  ["capture", { capture: "somewhere-else.jsonl" }],
  ["captureRawHash", { captureRawHash: "b".repeat(64) }],
  ["captureHash", { captureHash: "c".repeat(64) }],
  ["normalizationVersion", { normalizationVersion: 2 }],
  ["isolated", { isolated: false }],
  ["recorderErrors", { recorderErrors: 1 }],
];

for (const [name, manifestOverrides] of INVERSIONS) {
  test(`manifest ${name} that disagrees is rejected`, () => {
    assert.throws(() => build(manifestOverrides), new RegExp(`manifest ${name}`));
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
