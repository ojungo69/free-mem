import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFixture, assembleFromFixtures } from "../assemble.ts";
import type { CaptureFixture } from "../schema/capability.ts";

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

test("evidenceHash が無ければ実測があっても manual_only に落ちる", () => {
  const f = validateFixture(
    base({ highLevel: { promptAwareInjection: "native", promptDeliveryBeforeModel: "native" } }),
    "f.json",
  ) as CaptureFixture;
  assert.equal(assembleFromFixtures([f]).capabilities.resumeDeliveryStrategy, "manual_only");
});
