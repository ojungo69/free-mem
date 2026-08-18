import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleFromFixtures, validateFixture } from "../assemble.ts";
import { NORMALIZATION_VERSION, digestRaw } from "./normalize.ts";
import {
  codexLifecycle,
  fixtureBase,
  lifecycle,
  putEvidence,
  subagentRun,
  toolRun,
  type CaptureLine,
} from "./synthetic.ts";
import type { CaptureFixture } from "../schema/capability.ts";

const newRoot = (): string => mkdtempSync(join(tmpdir(), "evroot-"));
const asFixture = (o: Record<string, unknown>): CaptureFixture => o as unknown as CaptureFixture;
const AT = "2026-08-12T00:00:00.000Z";

/** schema と手書き検証も通してから組み立てる（fixture だけ先に変える経路を作らない） */
const assemble = (fixtures: Record<string, unknown>[], root: string) =>
  assembleFromFixtures(
    fixtures.map((f, i) => validateFixture(JSON.parse(JSON.stringify(f)), `f${i}.json`)),
    { evidenceRoot: root },
  );

// --- positive control ---

test("synthetic manifest-backed fixture promotes end-to-end", () => {
  const root = newRoot();
  const ref = putEvidence(root, "backed", lifecycle("s1", "p1"), { manifest: true });
  const m = assemble(
    [
      fixtureBase({
        fixtureId: "claude/backed",
        observedEvents: [{ kind: "session_started", at: AT }],
        evidence: [ref],
      }),
    ],
    root,
  );
  assert.equal(m.capabilities.capture.session_started.evidenceKind, "real-cli-e2e");
  assert.deepEqual(m.capabilities.capture.session_started.evidenceRefs, [0]);
  assert.equal(m.evidenceSources[0].manifestHash, ref.manifestHash);
});

test("legacy-only evidence stays source-test", () => {
  const root = newRoot();
  const ref = putEvidence(root, "legacy", lifecycle("s1", "p1"));
  const m = assemble(
    [
      fixtureBase({
        fixtureId: "claude/legacy",
        observedEvents: [{ kind: "session_started", at: AT }],
        evidence: [ref],
      }),
    ],
    root,
  );
  // digest の照合は掛かるが、run の素性を示す記録が無いので昇格しない
  assert.equal(m.capabilities.capture.session_started.evidenceKind, "source-test");
  assert.equal(m.evidenceSources[0].manifestHash, null);
});

test("all three promotion sites require verification", () => {
  const root = newRoot();
  const ref = putEvidence(root, "legacy", subagentRun("s1"));
  const m = assemble(
    [
      fixtureBase({
        fixtureId: "claude/three-sites",
        observedEvents: [{ kind: "session_started", at: AT }],
        highLevel: {
          subagentCapture: "native",
          promptAwareInjection: "synthesized",
          promptDeliveryBeforeModel: "synthesized",
        },
        evidence: [ref],
      }),
    ],
    root,
  ).capabilities;
  assert.equal(m.capture.session_started.evidenceKind, "source-test", "capture cell");
  assert.equal(m.subagentCapture.evidenceKind, "source-test", "highLevel cell");
  assert.equal(m.promptAwareInjection.evidenceKind, "source-test", "prompt 対の再刻印");
  assert.equal(m.resumeDeliveryStrategy, "manual_only");
});

// --- 攻撃側 ---

test("nonexistent evidence path is rejected", () => {
  const root = newRoot();
  assert.throws(
    () =>
      assemble(
        [
          fixtureBase({
            evidence: [
              {
                path: "no-such.jsonl",
                evidenceHash: "a".repeat(64),
                captureRawHash: "b".repeat(64),
                normalizationVersion: NORMALIZATION_VERSION,
              },
            ],
          }),
        ],
        root,
      ),
    /cannot be resolved/,
  );
});

test("digest mismatch fails the build", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"));
  assert.throws(
    () => assemble([fixtureBase({ evidence: [{ ...ref, evidenceHash: "c".repeat(64) }] })], root),
    /evidenceHash mismatch/,
  );
});

test("unknown normalization version fails the build", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"));
  assert.throws(
    () => assemble([fixtureBase({ evidence: [{ ...ref, normalizationVersion: 99 }] })], root),
    /unknown normalizationVersion/,
  );
});

test("empty evidence array fails the build", () => {
  const root = newRoot();
  // schema 側でも落ちる。assemble 側の非空検査は schema を通さない経路のための二重化
  assert.throws(() => assemble([fixtureBase({ evidence: [] })], root), /minItems/);
  assert.throws(
    () => assembleFromFixtures([asFixture(fixtureBase({ evidence: [] }))], { evidenceRoot: root }),
    /must not be empty/,
  );
});

test("raw byte change fails even when the normalized digest is unchanged", () => {
  const root = newRoot();
  const lines = lifecycle("s1", "p1");
  const ref = putEvidence(root, "cap", lines);
  // 時刻だけを変える: 正規化は at を落とすので evidenceHash は変わらない
  const moved: CaptureLine[] = lines.map((l) => ({ ...l, at: "2099-01-01T00:00:00.000Z" }));
  writeFileSync(join(root, "cap.jsonl"), `${moved.map((l) => JSON.stringify(l)).join("\n")}\n`);
  assert.throws(() => assemble([fixtureBase({ evidence: [ref] })], root), /captureRawHash mismatch/);
});

test("legacy ref still verifies captureRawHash", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"));
  assert.throws(
    () => assemble([fixtureBase({ evidence: [{ ...ref, captureRawHash: "d".repeat(64) }] })], root),
    /captureRawHash mismatch/,
  );
});

test("normalization-collision swap is rejected by captureRawHash", () => {
  const root = newRoot();
  const lines = lifecycle("s1", "p1");
  const a = putEvidence(root, "a", lines, { manifest: true });
  // 同じ観測を別の時刻で取り直した記録。正規化 digest は一致するが生 byte は違う
  const b = putEvidence(
    root,
    "b",
    lines.map((l) => ({ ...l, at: "2026-08-13T00:00:00.000Z" })),
  );
  assert.equal(a.evidenceHash, b.evidenceHash, "前提: 正規化 digest は衝突する");
  assert.notEqual(a.captureRawHash, b.captureRawHash);
  // b を指しながら a の manifest と raw hash を持ち込む
  assert.throws(
    () =>
      assemble(
        [fixtureBase({ evidence: [{ ...a, path: "b.jsonl" }] })],
        root,
      ),
    /captureRawHash mismatch/,
  );
});

test("corrupt manifest is rejected before parsing", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"), {
    manifest: true,
    manifestBytes: Buffer.from("{not json", "utf8"),
  });
  // hash を先に見るので、parse できないことより先に不一致で落ちる
  assert.throws(
    () => assemble([fixtureBase({ evidence: [{ ...ref, manifestHash: "e".repeat(64) }] })], root),
    /manifestHash mismatch/,
  );
});

test("claimed hook absent from the capture is rejected", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"));
  assert.throws(
    () =>
      assemble(
        [
          fixtureBase({
            observedEvents: [
              { kind: "session_started", at: AT, capability: "synthesized", sourceEvents: ["PreCompact"] },
            ],
            evidence: [ref],
          }),
        ],
        root,
      ),
    /sourceEvents names PreCompact/,
  );
});

test("claimed cell value the capture does not derive is rejected", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"));
  // この記録に PreToolUse は無い
  assert.throws(
    () => assemble([fixtureBase({ observedEvents: [{ kind: "tool_started", at: AT }], evidence: [ref] })], root),
    /no referenced capture derives it/,
  );
});

// --- 導けない主張 ---

test("underivable claims stay source-test", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"), { manifest: true });
  const m = assemble(
    [fixtureBase({ highLevel: { sessionStartInjection: "native" }, evidence: [ref] })],
    root,
  ).capabilities;
  assert.equal(m.sessionStartInjection.value, "native");
  assert.equal(m.sessionStartInjection.evidenceKind, "source-test");
});

test("underivable claim does not fail the build", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"), { manifest: true });
  // 判定の順序が逆だと（supporting を先に求めると）導出値が無いので必ず空になり、
  // tool_failed を持つ既存 fixture が組み立て全体を落とす
  assert.doesNotThrow(() =>
    assemble(
      [
        fixtureBase({
          observedEvents: [{ kind: "tool_failed", at: AT }],
          toolFailurePhasesObserved: ["executed"],
          evidence: [ref],
        }),
      ],
      root,
    ),
  );
});

// --- 集約と粒度 ---

test("a claim is supported by any one ref (5-ref fixture)", () => {
  const root = newRoot();
  // 5 本のうち中断形は 3 本。fixture は和集合を表すので、どれか 1 本が導けば成立する
  const refs = [
    putEvidence(root, "r1", lifecycle("s1", "p1"), { manifest: true }),
    putEvidence(root, "r2", lifecycle("s2", "p2").filter((l) => l.event !== "Stop"), { manifest: true }),
    putEvidence(root, "r3", lifecycle("s3", "p3").filter((l) => l.event !== "Stop"), { manifest: true }),
  ];
  const m = assemble(
    [
      fixtureBase({
        observedEvents: [
          { kind: "session_interrupted", at: AT, capability: "synthesized", sourceEvents: ["SessionEnd"] },
          { kind: "assistant_completed", at: AT, capability: "synthesized", sourceEvents: ["Stop"] },
        ],
        evidence: refs,
      }),
    ],
    root,
  ).capabilities;
  assert.equal(m.capture.session_interrupted.evidenceKind, "real-cli-e2e");
  assert.equal(m.capture.assistant_completed.evidenceKind, "real-cli-e2e");
  // 支持した記録だけを載せる（全 ref を並べない）
  assert.deepEqual(m.capture.assistant_completed.evidenceRefs, [0]);
  assert.deepEqual(m.capture.session_interrupted.evidenceRefs, [1, 2]);
});

test("mixed fixture does not promote legacy-backed cells", () => {
  const root = newRoot();
  // legacy な ref が session_interrupted を支持し、manifest 付きの ref は別の主張を支持する
  const legacyInterrupt = putEvidence(root, "legacy", lifecycle("s1", "p1").filter((l) => l.event !== "Stop"));
  const backedTools = putEvidence(root, "backed", toolRun("s2"), { manifest: true });
  const m = assemble(
    [
      fixtureBase({
        observedEvents: [
          { kind: "session_interrupted", at: AT, capability: "synthesized", sourceEvents: ["SessionEnd"] },
          { kind: "tool_started", at: AT },
        ],
        evidence: [legacyInterrupt, backedTools],
      }),
    ],
    root,
  ).capabilities;
  assert.equal(m.capture.session_interrupted.evidenceKind, "source-test", "legacy が支持した cell は上がらない");
  assert.equal(m.capture.tool_started.evidenceKind, "real-cli-e2e", "manifest 付きが支持した cell は上がる");
});

test("codex turn_completed derives as native", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", codexLifecycle("s1", "t1"), {
    manifest: true,
    cli: "codex",
    scenarioId: "codex.lifecycle",
  });
  const m = assemble(
    [
      fixtureBase({
        fixtureId: "codex/lifecycle",
        cli: "codex",
        scenarioId: "codex.lifecycle",
        observedEvents: [{ kind: "turn_completed", at: AT, capability: "native" }],
        evidence: [ref],
      }),
    ],
    root,
  ).capabilities;
  // Claude 規則（prompt_id 共有 + turn_id 無し）へ統一すると codex fixture が落ちる
  assert.equal(m.capture.turn_completed.evidenceKind, "real-cli-e2e");
});

test("verified fixture outranks unverified for the same cell", () => {
  const root = newRoot();
  const ref = putEvidence(root, "backed", lifecycle("s1", "p1"), { manifest: true });
  const backed = fixtureBase({
    fixtureId: "claude/backed",
    observedEvents: [{ kind: "session_started", at: AT }],
    evidence: [ref],
  });
  const declared = fixtureBase({
    fixtureId: "claude/declared",
    observedEvents: [{ kind: "session_started", at: AT }],
  });
  for (const order of [
    [backed, declared],
    [declared, backed],
  ]) {
    const cell = assemble(order, root).capabilities.capture.session_started;
    assert.equal(cell.evidenceKind, "real-cli-e2e");
    assert.equal(cell.sourceFixtureId, "claude/backed");
  }
});

test("prompt pair requires a shared supporting ref", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"), { manifest: true });
  // 対の両 cell は導けない主張なので、証拠があっても対は成立しない
  const m = assemble(
    [
      fixtureBase({
        highLevel: { promptAwareInjection: "synthesized", promptDeliveryBeforeModel: "synthesized" },
        evidence: [ref],
      }),
    ],
    root,
  ).capabilities;
  assert.equal(m.resumeDeliveryStrategy, "manual_only");
  assert.ok(
    !m.promptAwareInjection.limitations.some((l) => l.startsWith("prompt pair proven together")),
    "対の再刻印は起きない",
  );
});

// --- evidence root の差し替え口 ---

test("evidence root cannot be set from CLI args, fixture values, or env", () => {
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"), { manifest: true });
  const fixture = asFixture(fixtureBase({ evidence: [ref] }));
  // ctx を渡さなければ置き場は harness/fixtures/<cli>/raw/ に固定される
  assert.throws(() => assembleFromFixtures([fixture]), /cannot be resolved/);
  process.env.EVIDENCE_ROOT = root;
  try {
    assert.throws(() => assembleFromFixtures([fixture]), /cannot be resolved/);
  } finally {
    delete process.env.EVIDENCE_ROOT;
  }
  // fixture に置き場を書き足す経路も無い（schema の未知キー拒否）
  assert.throws(
    () => validateFixture({ ...fixtureBase({ evidence: [ref] }), evidenceRoot: root }, "f.json"),
    /unknown top-level key/,
  );
});

// --- 移行した実データ ---

test("committed fixtures bind every raw by digest and promote nothing", () => {
  const m = {
    claude: assembleFromFixtures(loadCommitted("claude")),
    codex: assembleFromFixtures(loadCommitted("codex")),
  };
  assert.equal(m.claude.evidenceSources.length + m.codex.evidenceSources.length, 16, "raw 16 件が結び付く");
  for (const assembled of Object.values(m)) {
    for (const source of assembled.evidenceSources) {
      assert.equal(source.manifestHash, null, "legacy 証拠なので manifest は無い");
    }
    const kinds = JSON.stringify(assembled.capabilities)
      .match(/"evidenceKind":"[a-z-]+"/g)
      ?.map((s) => s.split(":")[1]) ?? [];
    assert.ok(!kinds.includes('"real-cli-e2e"'), "この変更で昇格する cell は 0 件");
  }
});

function loadCommitted(cli: "claude" | "codex"): CaptureFixture[] {
  const dir = new URL(`../fixtures/${cli}/`, import.meta.url);
  const names = ["injection-and-subagent", "interrupt-and-hook-timeout", "lifecycle-basic", "tool-failed-executed", "tool-lifecycle", "injection", "tool-lifecycle-and-failure"];
  const out: CaptureFixture[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(new URL(`${name}.json`, dir), "utf8");
    } catch {
      continue;
    }
    out.push(validateFixture(JSON.parse(raw), `${name}.json`));
  }
  return out;
}
