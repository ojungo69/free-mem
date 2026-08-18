// rig が書く manifest を、実 CLI 無しで end-to-end に確かめる。
// stub CLI を CLAUDE_BIN として渡し、rig.sh の setup → claude-run → import を実際に走らせる。
// harness ごと複製して走らせるので、既定の証拠置き場（module からの相対）も複製側を指す。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("../", import.meta.url));
const LABEL = "rig-stub";
const VERSION = "9.9.9-stub (Stub Code)";

// 実 CLI の代わり。--version は 1 行返し、それ以外では hook 相当の観測記録を書く
const STUB = `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = --version ]; then printf '%s\\n' '${VERSION}'; exit 0; fi
# 前の run の終了コードが残ったまま今回の run が始まっていないか。run 中にしか観測できない
if [ -e "$CAPTURE_FILE.exit" ]; then printf 'stale\\n' > "$CAPTURE_FILE.stale-exit"; fi
# 資格情報が置かれるのは run の最中だけ（trap で消える）ので、ここでしか観測できない
if [ -e "\${CLAUDE_CONFIG_DIR:-/nonexistent}/.credentials.json" ]; then printf 'staged\\n' > "$CAPTURE_FILE.staged-credential"; fi
emit() { printf '{"event":"%s","at":"2026-01-01T00:00:00.000Z","payload":%s}\\n' "$1" "$2" >> "$CAPTURE_FILE"; }
emit SessionStart '{"hook_event_name":"SessionStart","source":"startup","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit UserPromptSubmit '{"hook_event_name":"UserPromptSubmit","prompt_id":"p-stub","prompt":"hello","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit Stop '{"hook_event_name":"Stop","prompt_id":"p-stub","last_assistant_message":"hi","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit SessionEnd '{"hook_event_name":"SessionEnd","prompt_id":"p-stub","reason":"other","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
`;

function rigRun() {
  const tmp = mkdtempSync(join(tmpdir(), "rig-manifest-"));
  cpSync(HARNESS, join(tmp, "harness"), { recursive: true });
  const stub = join(tmp, "stub-cli");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);

  const rig = join(tmp, "harness", "rig", "rig.sh");
  const base = join(tmp, "rig-base");
  // HOME は差し替える。実 HOME のままだと rig が開発者の Claude 資格情報を
  // 一時 rig へ複製する（trap で消えるが、SIGKILL で落ちれば残る）
  const env = { ...process.env, HOME: join(tmp, "home"), RIG_BASE: base, CLAUDE_BIN: stub };
  const sh = (...args) => spawnSync("bash", [rig, ...args], { encoding: "utf8", env });

  const setup = sh("setup");
  assert.equal(setup.status, 0, setup.stderr);
  const run = sh("claude-run", LABEL, "hello");
  assert.equal(run.status, 0, run.stderr);
  const imported = sh("import", "claude", LABEL, "self.stub");
  assert.equal(imported.status, 0, imported.stderr);

  const rawDir = join(tmp, "harness", "fixtures", "claude", "raw");
  return {
    tmp,
    base,
    sh,
    rawDir,
    ref: JSON.parse(imported.stdout),
    capture: join(base, "capture", `claude-${LABEL}.jsonl`),
    manifest: JSON.parse(readFileSync(join(rawDir, `claude-${LABEL}.manifest.json`), "utf8")),
  };
}

test("the rig writes a manifest and imports the capture byte-identically", () => {
  const { rawDir, ref, capture, manifest } = rigRun();

  assert.deepEqual(readFileSync(join(rawDir, `claude-${LABEL}.jsonl`)), readFileSync(capture));
  assert.equal(manifest.cliVersion, VERSION);
  assert.equal(manifest.cli, "claude");
  assert.equal(manifest.scenarioId, "self.stub");
  assert.equal(manifest.isolated, true);
  assert.equal(manifest.internalRunMarker, true);
  assert.equal(manifest.exitStatus, 0);
  assert.equal(manifest.recorderErrors, 0);
  assert.equal(manifest.capture, `claude-${LABEL}.jsonl`);
  // 出力した ref と manifest が同じ digest を指す（貼り間違いではなく機械で一致する）
  assert.equal(ref.evidenceHash, manifest.captureHash);
  assert.equal(ref.captureRawHash, manifest.captureRawHash);
  assert.match(ref.manifestHash, /^[a-f0-9]{64}$/);
});

test("a rig-produced manifest promotes the cell to real-cli-e2e", () => {
  const { tmp, ref, manifest } = rigRun();
  const dir = join(tmp, "harness", "fixtures", "rigtest");
  const at = "2026-01-01T00:00:00.000Z";
  const event = (kind, sourceEvents, capability = "native") => ({ kind, at, capability, sourceEvents });
  cpSync(join(tmp, "harness", "fixtures", "claude"), dir, { recursive: true, filter: (s) => !s.endsWith(".json") });
  writeFileSync(
    join(dir, "rig-stub.json"),
    JSON.stringify(
      {
        fixtureId: "claude/rig-stub",
        cli: "claude",
        nativeVersion: manifest.cliVersion,
        capturedAt: at,
        scenario: "stub lifecycle",
        scenarioId: manifest.scenarioId,
        observedEvents: [
          event("session_started", ["SessionStart"]),
          event("user_prompted", ["UserPromptSubmit"]),
          // Stop から復元する主張なので native ではなく synthesized
          event("assistant_completed", ["Stop"], "synthesized"),
          event("session_ended", ["SessionEnd"]),
        ],
        toolFailurePhasesObserved: [],
        limitations: [],
        limitationCodes: [],
        evidence: [ref],
        rig: { isolated: true, internalRunMarker: true },
      },
      null,
      2,
    ),
  );

  const out = join(tmp, "rigtest.json");
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(tmp, "harness", "assemble.ts"), dir, out],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const matrix = JSON.parse(readFileSync(out, "utf8"));
  for (const kind of ["session_started", "user_prompted", "assistant_completed", "session_ended"]) {
    assert.equal(matrix.capabilities.capture[kind].evidenceKind, "real-cli-e2e", `${kind} が昇格していない`);
  }
  // 昇格した cell に「manifest が無い」の caveat が残らない
  assert.ok(!JSON.stringify(matrix.capabilities.capture).includes("no manifest-backed evidence"));
});

test("a CLI that prints more than one version line is rejected", () => {
  const { base, sh } = rigRun();
  // 複数行を返す CLI で黙って 1 行目を採ると、manifest の cliVersion が本当の版と食い違う
  writeFileSync(join(base, "capture", `claude-${LABEL}.version`), "9.9.9-stub (Stub Code)\nwarning: update available\n");
  const again = sh("import", "claude", LABEL, "self.stub");
  assert.notEqual(again.status, 0, "複数行の版で持ち込みが成功した");
  assert.match(again.stderr, /more than one line/);
});

test("a rerun does not start with the previous run's exit status in place", () => {
  // SIGKILL などで新しい .exit が書かれないまま終わると、前回の成功が途中で切れた記録に付く。
  // stub は run 中に .exit を見つけたら痕跡を残すので、消し忘れはここで鳴る
  const { base, sh } = rigRun();
  assert.ok(existsSync(join(base, "capture", `claude-${LABEL}.exit`)), "1 回目で .exit が書かれていない");
  const again = sh("claude-run", LABEL, "hello");
  assert.equal(again.status, 0, again.stderr);
  assert.ok(
    !existsSync(join(base, "capture", `claude-${LABEL}.jsonl.stale-exit`)),
    "前の run の .exit を持ったまま次の run が始まった",
  );
});

test("a capture is not replaced when a later input fails validation", () => {
  const { base, sh, rawDir } = rigRun();
  const stored = join(rawDir, `claude-${LABEL}.jsonl`);
  const before = readFileSync(stored);
  // 取り込み側の入力を 1 つ壊し、記録のほうは別物にする。検証を複製の後に置いていると、
  // 落ちた時点で保存済みの証拠は上書き済みで、古い manifest が別の byte を指したまま残る
  const capture = join(base, "capture", `claude-${LABEL}.jsonl`);
  writeFileSync(capture, `${readFileSync(capture, "utf8")}{"event":"Stop","at":"2026-01-02T00:00:00.000Z","payload":{"hook_event_name":"Stop"}}\n`);
  writeFileSync(join(base, "capture", `claude-${LABEL}.version`), "9.9.9-stub (Stub Code)\nwarning\n");
  const again = sh("import", "claude", LABEL, "self.stub");
  assert.notEqual(again.status, 0, "壊れた入力で持ち込みが成功した");
  assert.deepEqual(readFileSync(stored), before, "検証で落ちたのに保存済みの記録が置き換わった");
});

test("every run initialisation clears the previous exit status", () => {
  // stub で走らせるのは claude 経路だけなので、codex 経路はここで形として見る
  // （片方だけ直すと、同じ欠陥が別の識別子で残る）
  const lines = readFileSync(join(HARNESS, "rig", "rig.sh"), "utf8")
    .split("\n")
    .filter((l) => l.includes(': > "$capture"'));
  assert.equal(lines.length, 2, "run 初期化の箇所数が変わった");
  for (const line of lines) assert.match(line, /rm -f [^\n]*\$capture\.exit/, line);
});

test("the rig stages no credential when the test runs", () => {
  // run が終われば trap が消すので、外から見ても常に無い。stub に run 中を見させる
  const { base } = rigRun();
  assert.ok(
    !existsSync(join(base, "capture", `claude-${LABEL}.jsonl.staged-credential`)),
    "test の run が実 HOME の資格情報を一時 rig へ複製した",
  );
});
