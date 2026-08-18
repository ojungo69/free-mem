import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assembleFromFixtures, shareRef, validateFixture } from "../assemble.ts";
import { NORMALIZATION_VERSION } from "./normalize.ts";
import {
  assembleWithRoot,
  codexLifecycle,
  fixtureBase,
  lifecycle,
  newRoot,
  putEvidence,
  subagentRun,
  toolRun,
  type CaptureLine,
} from "./synthetic.ts";
import type { CaptureFixture } from "../schema/capability.ts";

const asFixture = (o: Record<string, unknown>): CaptureFixture => o as unknown as CaptureFixture;
const AT = "2026-08-12T00:00:00.000Z";

const assemble = assembleWithRoot;

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
              // enum 内だが lifecycle() の観測記録には出ない hook を選ぶ。enum 外を書くと
              // schema 側が先に落とし、導出の検査に届かない
              { kind: "session_started", at: AT, capability: "synthesized", sourceEvents: ["SubagentStop"] },
            ],
            evidence: [ref],
          }),
        ],
        root,
      ),
    /sourceEvents names SubagentStop/,
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

// 高位 2 cell の述語は native しか出さない。key だけで導出可否を決めると、この 2 値の
// 申告が「導けるのに支持が無い」と読まれ、証拠を足しただけで組み立てが落ちる
const highLevelWithEvidence = (value: "synthesized" | "unsupported"): unknown => {
  const root = newRoot();
  const ref = putEvidence(root, `hl-${value}`, lifecycle("s1", "p1"), { manifest: true });
  return assemble([fixtureBase({ highLevel: { subagentCapture: value }, evidence: [ref] })], root)
    .capabilities.subagentCapture;
};

test("a synthesized high-level claim is not invalidated by attaching evidence", () => {
  const cell = highLevelWithEvidence("synthesized") as { value: string; evidenceKind: string | null };
  assert.equal(cell.value, "synthesized");
  assert.equal(cell.evidenceKind, "source-test");
});

test("an unsupported high-level claim is not invalidated by attaching evidence", () => {
  // 記録は「起きたこと」しか言わないので、起きなかったことの証拠にはならない
  const cell = highLevelWithEvidence("unsupported") as { value: string; evidenceKind: string | null };
  assert.equal(cell.value, "unsupported");
  assert.equal(cell.evidenceKind, "source-test");
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
          // sourceEvents を書かない主張。出どころの照合が効かないので、支持の照合だけが
          // 「manifest 付きだが別の主張を支持する ref」を弾く
          { kind: "session_started", at: AT },
          { kind: "tool_started", at: AT },
        ],
        evidence: [legacyInterrupt, backedTools],
      }),
    ],
    root,
  ).capabilities;
  assert.equal(m.capture.session_interrupted.evidenceKind, "source-test", "legacy が支持した cell は上がらない");
  assert.equal(m.capture.session_started.evidenceKind, "source-test", "支持しない manifest で上がった");
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
  // 組み立ては fixtureId で整列するので、渡す順ではなく **id の順** を変えて両方向を見る。
  // 裏付けの無い側が先に処理される向きが、証跡の優劣が効いているかを決める
  for (const [backedId, declaredId] of [
    ["claude/z-backed", "claude/a-declared"],
    ["claude/a-backed", "claude/z-declared"],
  ]) {
    const cell = assemble(
      [
        fixtureBase({ fixtureId: backedId, observedEvents: [{ kind: "session_started", at: AT }], evidence: [ref] }),
        fixtureBase({ fixtureId: declaredId, observedEvents: [{ kind: "session_started", at: AT }] }),
      ],
      root,
    ).capabilities.capture.session_started;
    assert.equal(cell.evidenceKind, "real-cli-e2e", `${backedId} が先か後かで結果が変わる`);
    assert.equal(cell.sourceFixtureId, backedId);
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
  // 件数だけを見ると、1 つの raw を 2 つの fixture が参照して別の raw が孤立しても
  // 合計は変わらない。置き場にある名前の集合と突き合わせる
  for (const [cli, assembled] of Object.entries(m)) {
    const onDisk = readdirSync(new URL(`../fixtures/${cli}/raw/`, import.meta.url))
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    const referenced = [...new Set(assembled.evidenceSources.map((s) => s.path))].sort();
    assert.deepEqual(referenced, onDisk, `${cli}: 置き場の raw と結び付いた raw が食い違う`);
  }
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
  // 名前を手で並べない。並べると 9 個目の fixture が「昇格 0 件」の検査から黙って抜ける
  const dir = new URL(`../fixtures/${cli}/`, import.meta.url);
  const names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  assert.ok(names.length > 0, `${cli} の fixture が 1 件も見つからない`);
  return names.map((name) => validateFixture(JSON.parse(readFileSync(new URL(name, dir), "utf8")), name));
}

test("shared-ref predicate requires an actual common index", () => {
  // 対の再刻印はこの述語だけが門になる。呼び出し側は導けない主張のせいで現在到達しないので、
  // 述語そのものを固定する（到達しない経路の門は、経路が復活したときに黙って緩む）
  assert.equal(shareRef([0, 1], [1, 2]), true);
  assert.equal(shareRef([0, 1], [2, 3]), false, "共有が無いのに成立させている");
  assert.equal(shareRef([], []), false, "空どうしは対の証明にならない");
  assert.equal(shareRef([0], []), false);
});

test("the assemble entrypoint ignores EVIDENCE_ROOT from the environment", () => {
  // 同一プロセスで assembleFromFixtures を呼ぶ test は entrypoint を通らない。
  // 置き場を環境変数から取る実装に変えられても気づけないので、子プロセスで見る
  const root = newRoot();
  const ref = putEvidence(root, "cap", lifecycle("s1", "p1"), { manifest: true });
  const fixturesDir = mkdtempSync(join(tmpdir(), "evfix-"));
  writeFileSync(
    join(fixturesDir, "f.json"),
    JSON.stringify(fixtureBase({ fixtureId: "claude/env", observedEvents: [{ kind: "session_started", at: AT }], evidence: [ref] })),
  );
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(new URL("../assemble.ts", import.meta.url)), fixturesDir, join(fixturesDir, "out.json")],
    { encoding: "utf8", env: { ...process.env, EVIDENCE_ROOT: root } },
  );
  assert.notEqual(run.status, 0, "環境変数で置き場が動いた");
  assert.match(`${run.stdout}\n${run.stderr}`, /cannot be resolved/);
});

test("stableNativeSessionId needs a session id on every observed line", () => {
  const root = newRoot();
  // 1 行だけ id を持ち、残りに欄が無い記録。欄の無い行を先に除くと「run 全体で安定」に見える
  const lines = lifecycle("s1", "p1").map((l, i) =>
    i === 0 ? l : { ...l, payload: Object.fromEntries(Object.entries(l.payload).filter(([k]) => k !== "session_id")) },
  );
  const ref = putEvidence(root, "sparse", lines, { manifest: true });
  assert.throws(
    () =>
      assemble(
        [fixtureBase({ fixtureId: "claude/sparse", highLevel: { stableNativeSessionId: "native" }, evidence: [ref] })],
        root,
      ),
    /stableNativeSessionId claims "native" but no referenced capture derives it/,
  );
});

test("a numeric identifier is not a correlation token", () => {
  const root = newRoot();
  // 数値の session_id は正規化で <number> になる。型だけ見ると別々の ID が同じ token として
  // 等値になり、run 全体で安定していたことにできる
  const lines = lifecycle("s1", "p1").map((l, i) => ({
    ...l,
    payload: { ...l.payload, session_id: 100 + i },
  }));
  const ref = putEvidence(root, "numeric", lines, { manifest: true });
  assert.throws(
    () =>
      assemble(
        [fixtureBase({ fixtureId: "claude/numeric", highLevel: { stableNativeSessionId: "native" }, evidence: [ref] })],
        root,
      ),
    /stableNativeSessionId claims "native" but no referenced capture derives it/,
  );
});

test("a null completion field does not derive assistant_completed", () => {
  const root = newRoot();
  const lines = lifecycle("s1", "p1").map((l) =>
    l.event === "Stop" ? { ...l, payload: { ...l.payload, last_assistant_message: null } } : l,
  );
  const ref = putEvidence(root, "nullmsg", lines, { manifest: true });
  assert.throws(
    () =>
      assemble(
        [
          fixtureBase({
            fixtureId: "claude/nullmsg",
            observedEvents: [{ kind: "assistant_completed", at: AT, capability: "synthesized", sourceEvents: ["Stop"] }],
            evidence: [ref],
          }),
        ],
        root,
      ),
    /assistant_completed claims "synthesized" but no referenced capture derives it/,
  );
});

test("the same capture cannot be named twice in one fixture", () => {
  const root = newRoot();
  // 昇格は manifest 付きの ref で決まる一方、公開する evidenceSources は後勝ちで legacy 側になる
  const backed = putEvidence(root, "twice", lifecycle("s1", "p1"), { manifest: true });
  const legacy = { path: backed.path, evidenceHash: backed.evidenceHash, captureRawHash: backed.captureRawHash, normalizationVersion: backed.normalizationVersion };
  assert.throws(
    () => assemble([fixtureBase({ fixtureId: "claude/twice", evidence: [backed, legacy] })], root),
    /names twice\.jsonl more than once/,
  );
});

test("fixtureId must be attributed to the cli that produced the capture", () => {
  // 正しい記録と manifest を、別 CLI の fixture ID へ付け替えられないようにする
  assert.throws(() => validateFixture(fixtureBase({ fixtureId: "codex/spoof" }), "f.json"), /must be prefixed with its own cli/);
  // 診断へ cli の生値を出さない（schema を通る前の値なので改行で CI log を偽装できる）
  const raised = (() => {
    try {
      validateFixture(fixtureBase({ fixtureId: "codex/spoof" }), "f.json");
    } catch (e) {
      return String(e);
    }
    return "";
  })();
  assert.ok(!raised.includes("codex/spoof"), "診断に fixture の値が出た");
});

test("a claude capture that carries turn_id does not derive a synthesized turn", () => {
  const root = newRoot();
  // Claude 規則は「prompt_id を共有し、turn_id が無い」。識別子の在不在を伏せ字の綴りで
  // 判定すると、turn_id があっても「無い」と読める
  const lines = lifecycle("s1", "p1").map((l) => ({ ...l, payload: { ...l.payload, turn_id: "t1" } }));
  const ref = putEvidence(root, "withturn", lines, { manifest: true });
  assert.throws(
    () =>
      assemble(
        [
          fixtureBase({
            fixtureId: "claude/withturn",
            observedEvents: [{ kind: "turn_completed", at: AT, capability: "synthesized", sourceEvents: ["Stop"] }],
            evidence: [ref],
          }),
        ],
        root,
      ),
    /turn_completed claims "synthesized" but no referenced capture derives it/,
  );
});

test("empty identifiers do not correlate", () => {
  const root = newRoot();
  // 空文字の session_id / prompt_id に token を振ると、実体の無い ID どうしが
  // 「run を通して同じ」の根拠になる
  const lines = lifecycle("s1", "p1").map((l) => ({
    ...l,
    payload: { ...l.payload, session_id: "", ...("prompt_id" in l.payload ? { prompt_id: "" } : {}) },
  }));
  const ref = putEvidence(root, "emptyid", lines, { manifest: true });
  for (const [key, kind] of [
    ["stableNativeSessionId", "highLevel"],
    ["turn_completed", "capture"],
  ] as const) {
    const fixture =
      kind === "highLevel"
        ? fixtureBase({ fixtureId: "claude/emptyid", highLevel: { [key]: "native" }, evidence: [ref] })
        : fixtureBase({
            fixtureId: "claude/emptyid",
            observedEvents: [{ kind: key, at: AT, capability: "synthesized", sourceEvents: ["Stop"] }],
            evidence: [ref],
          });
    assert.throws(() => assemble([fixture], root), new RegExp(`${key} claims`), key);
  }
});
