import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFixture, assembleFromFixtures } from "../assemble.ts";
import type { CaptureFixture } from "../schema/capability.ts";
import { validateAgainstSchema, type JsonSchemaDocument } from "../schema/validate.ts";
import { readFileSync, readdirSync } from "node:fs";
import { parseIJson } from "../schema/jcs.ts";

const VERSION = "1.2.3-test";
const AT = "2026-08-16T00:00:00.000Z";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fixtureId: "claude/high-level",
    cli: "claude",
    nativeVersion: VERSION,
    capturedAt: AT,
    scenario: "prompt delivery",
    observedEvents: [{ kind: "session_started", at: AT }],
    toolFailurePhasesObserved: [],
    limitations: [],
    rig: { isolated: true, internalRunMarker: true },
    ...overrides,
  };
}

test("highLevel の値は schema の enum で検査する", () => {
  // 型でない値: 素通りすると CapabilityEvidence.value に数値が載る
  assert.throws(
    () => validateFixture(base({ highLevel: { compactSingleDelivery: 1 } }), "f.json"),
    /expected type string, got integer/,
  );
  // enum 外の綴り違い
  assert.throws(
    () => validateFixture(base({ highLevel: { promptAwareInjection: "natvie" } }), "f.json"),
    /value not in enum/,
  );
  // highLevel 自体の未知キー
  assert.throws(
    () => validateFixture(base({ highLevel: { promptAwareInjecton: "native" } }), "f.json"),
    /unknown property: promptAwareInjecton/,
  );
});

test("正しい highLevel は通り、cell に載る", () => {
  const f = validateFixture(
    base({
      evidenceHash: "a".repeat(64),
      highLevel: { promptAwareInjection: "native", promptDeliveryBeforeModel: "native" },
    }),
    "f.json",
  ) as CaptureFixture;
  const m = assembleFromFixtures([f]);
  assert.equal(m.capabilities.promptAwareInjection.value, "native");
  assert.equal(m.capabilities.promptAwareInjection.evidenceHash, "a".repeat(64));
  assert.equal(m.capabilities.resumeDeliveryStrategy, "native_prompt_gate");
});

test("synthesized 対は evidenceHash が無ければ manual_only に落ちる", () => {
  // §8 の synthesized tier だけが「同一 fixture / evidence hash」を要求する。
  // native tier（上のテスト）は pre-model 1 cell の実測で成立する
  const f = validateFixture(
    base({ highLevel: { promptAwareInjection: "synthesized", promptDeliveryBeforeModel: "synthesized" } }),
    "f.json",
  ) as CaptureFixture;
  assert.equal(assembleFromFixtures([f]).capabilities.resumeDeliveryStrategy, "manual_only");

  const withHash = validateFixture(
    base({
      evidenceHash: "b".repeat(64),
      highLevel: { promptAwareInjection: "synthesized", promptDeliveryBeforeModel: "synthesized" },
    }),
    "f.json",
  ) as CaptureFixture;
  assert.equal(
    assembleFromFixtures([withHash]).capabilities.resumeDeliveryStrategy,
    "next_prompt_synthesized",
  );
});

test("既存 fixture は capability.schema.json 全体に対して妥当（schema と手書き検証の drift 検出）", () => {
  const schema = parseIJson<JsonSchemaDocument>(
    readFileSync(new URL("../schema/capability.schema.json", import.meta.url), "utf8"),
  ) as JsonSchemaDocument;
  let checked = 0;
  for (const cli of ["claude", "codex"]) {
    const dir = new URL(`../fixtures/${cli}/`, import.meta.url);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const data = parseIJson(readFileSync(new URL(name, dir), "utf8"));
      assert.deepEqual(validateAgainstSchema(data, schema, schema), [], `${cli}/${name}`);
      checked++;
    }
  }
  assert.ok(checked >= 8, `fixture が見つかっていない (checked=${checked})`);
});

test("evidenceHash の無い highLevel は real-cli-e2e として刻まない", () => {
  const noHash = validateFixture(
    base({ highLevel: { sessionStartInjection: "native" } }),
    "f.json",
  ) as CaptureFixture;
  const cell = assembleFromFixtures([noHash]).capabilities.sessionStartInjection;
  assert.equal(cell.value, "native");
  assert.equal(cell.evidenceKind, "source-test");
  assert.ok(cell.limitations.some((l) => /no evidenceHash/.test(l)));
  // 自動配送は有効にならない
  assert.equal(assembleFromFixtures([noHash]).capabilities.resumeDeliveryStrategy, "manual_only");

  const hashed = validateFixture(
    base({ evidenceHash: "c".repeat(64), highLevel: { sessionStartInjection: "native" } }),
    "f.json",
  ) as CaptureFixture;
  const m = assembleFromFixtures([hashed]).capabilities;
  assert.equal(m.sessionStartInjection.evidenceKind, "real-cli-e2e");
  assert.equal(m.resumeDeliveryStrategy, "session_start_full");
});
