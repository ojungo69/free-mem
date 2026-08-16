import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyMatrix,
  resolveResumeDeliveryStrategy,
  type AdapterCapabilities,
  type CapabilityEvidence,
} from "../schema/capability.ts";

const VERSION = "1.2.3-test";
const AT = "2026-08-16T00:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function proven(
  value: "native" | "synthesized",
  overrides: Partial<CapabilityEvidence> = {},
): CapabilityEvidence {
  return {
    value,
    sourceEvents: [],
    nativeVersion: VERSION,
    evidenceKind: "real-cli-e2e",
    verifiedAt: AT,
    limitations: [],
    sourceFixtureId: "claude/prompt-aware",
    evidenceHash: HASH_A,
    ...overrides,
  };
}

function matrixWith(patch: Partial<AdapterCapabilities>): AdapterCapabilities {
  return { ...emptyMatrix(VERSION), ...patch };
}

test("空の matrix は manual_only、evidence cell は unknown のまま", () => {
  const caps = emptyMatrix(VERSION);
  assert.equal(caps.resumeDeliveryStrategy, "manual_only");
  assert.equal(caps.sessionStartInjection.value, "unknown");
  assert.equal(caps.promptAwareInjection.value, "unknown");
  assert.equal(caps.promptDeliveryBeforeModel.value, "unknown");
  assert.equal(caps.compactSingleDelivery.value, "unknown");
  assert.equal(resolveResumeDeliveryStrategy(caps), "manual_only");
  assert.deepEqual(caps.capabilityHashInputs, []);
});

test("prompt 経路が片方しか証明されていなければ採用しない（half-proven の棄却）", () => {
  const halfProven = matrixWith({ promptAwareInjection: proven("synthesized") });
  assert.equal(resolveResumeDeliveryStrategy(halfProven), "manual_only");

  const otherHalf = matrixWith({ promptDeliveryBeforeModel: proven("synthesized") });
  assert.equal(resolveResumeDeliveryStrategy(otherHalf), "manual_only");
});

test("prompt 経路は同一 fixture の実測でなければ採用しない", () => {
  const differentFixture = matrixWith({
    promptAwareInjection: proven("synthesized"),
    promptDeliveryBeforeModel: proven("synthesized", { sourceFixtureId: "claude/other-run" }),
  });
  assert.equal(resolveResumeDeliveryStrategy(differentFixture), "manual_only");

  const differentHash = matrixWith({
    promptAwareInjection: proven("synthesized"),
    promptDeliveryBeforeModel: proven("synthesized", { evidenceHash: HASH_B }),
  });
  assert.equal(resolveResumeDeliveryStrategy(differentHash), "manual_only");

  const differentVersion = matrixWith({
    promptAwareInjection: proven("synthesized"),
    promptDeliveryBeforeModel: proven("synthesized", { nativeVersion: "9.9.9" }),
  });
  assert.equal(resolveResumeDeliveryStrategy(differentVersion), "manual_only");
});

test("実 CLI 実測でない証跡では prompt 経路を採用しない", () => {
  for (const kind of ["official-doc", "source-test", null] as const) {
    const caps = matrixWith({
      promptAwareInjection: proven("synthesized", { evidenceKind: kind }),
      promptDeliveryBeforeModel: proven("synthesized", { evidenceKind: kind }),
    });
    assert.equal(resolveResumeDeliveryStrategy(caps), "manual_only", `evidenceKind=${String(kind)}`);
  }

  const noTimestamp = matrixWith({
    promptAwareInjection: proven("synthesized", { verifiedAt: null }),
    promptDeliveryBeforeModel: proven("synthesized", { verifiedAt: null }),
  });
  assert.equal(resolveResumeDeliveryStrategy(noTimestamp), "manual_only");
});

test("unsupported は証明として数えない", () => {
  const caps = matrixWith({
    promptAwareInjection: proven("synthesized"),
    promptDeliveryBeforeModel: {
      ...proven("synthesized"),
      value: "unsupported",
    },
  });
  assert.equal(resolveResumeDeliveryStrategy(caps), "manual_only");
});

test("両 cell が同一実測で synthesized なら next_prompt_synthesized", () => {
  const caps = matrixWith({
    promptAwareInjection: proven("synthesized"),
    promptDeliveryBeforeModel: proven("synthesized"),
  });
  assert.equal(resolveResumeDeliveryStrategy(caps), "next_prompt_synthesized");
});

test("両 cell が native なら native_prompt_gate、片方でも synthesized なら降格", () => {
  const nativeGate = matrixWith({
    promptAwareInjection: proven("native"),
    promptDeliveryBeforeModel: proven("native"),
  });
  assert.equal(resolveResumeDeliveryStrategy(nativeGate), "native_prompt_gate");

  const mixed = matrixWith({
    promptAwareInjection: proven("native"),
    promptDeliveryBeforeModel: proven("synthesized"),
  });
  assert.equal(resolveResumeDeliveryStrategy(mixed), "next_prompt_synthesized");
});

test("evidenceHash が未記録でも fixture と version が一致すれば prompt 経路を認める", () => {
  const caps = matrixWith({
    promptAwareInjection: proven("synthesized", { evidenceHash: null }),
    promptDeliveryBeforeModel: proven("synthesized", { evidenceHash: null }),
  });
  assert.equal(resolveResumeDeliveryStrategy(caps), "next_prompt_synthesized");
});

test("sourceFixtureId が無い cell は prompt 経路の根拠にならない", () => {
  const caps = matrixWith({
    promptAwareInjection: proven("synthesized", { sourceFixtureId: undefined }),
    promptDeliveryBeforeModel: proven("synthesized", { sourceFixtureId: undefined }),
  });
  assert.equal(resolveResumeDeliveryStrategy(caps), "manual_only");
});

test("SessionStart の実測だけがあれば session_start_full", () => {
  for (const value of ["native", "synthesized"] as const) {
    const caps = matrixWith({ sessionStartInjection: proven(value) });
    assert.equal(resolveResumeDeliveryStrategy(caps), "session_start_full", value);
  }
});

test("prompt 経路が証明されていれば SessionStart より優先する", () => {
  const caps = matrixWith({
    sessionStartInjection: proven("native"),
    promptAwareInjection: proven("synthesized"),
    promptDeliveryBeforeModel: proven("synthesized"),
  });
  assert.equal(resolveResumeDeliveryStrategy(caps), "next_prompt_synthesized");
});

test("compactSingleDelivery は配送経路の判定には影響しない（別 gate の入力）", () => {
  const withCompact = matrixWith({ compactSingleDelivery: proven("native") });
  assert.equal(resolveResumeDeliveryStrategy(withCompact), "manual_only");
});
