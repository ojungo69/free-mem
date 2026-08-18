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

// 実 CLI の代わり。--version は 1 行返し、それ以外では hook 相当の観測記録を書く。
// 付属物は rig と同じ stem（.jsonl を外した形）で見る。記録側の名前で見ると、rig が
// 別名を消していても常に「無い」と読めてしまい、検査が空振りする
const stub = (extra = "") => `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = --version ]; then printf '%s\\n' '${VERSION}'; exit 0; fi
STEM="\${CAPTURE_FILE%.jsonl}"
# 前の run の終了コードが残ったまま今回の run が始まっていないか。run 中にしか観測できない
if [ -e "$STEM.exit" ]; then printf 'stale\\n' > "$STEM.stale-exit"; fi
# 資格情報が置かれるのは run の最中だけ（trap で消える）ので、ここでしか観測できない
if [ -e "\${CLAUDE_CONFIG_DIR:-/nonexistent}/.credentials.json" ]; then printf 'staged\\n' > "$STEM.staged-credential"; fi
${extra}
emit() { printf '{"event":"%s","at":"2026-01-01T00:00:00.000Z","payload":%s}\\n' "$1" "$2" >> "$CAPTURE_FILE"; }
emit SessionStart '{"hook_event_name":"SessionStart","source":"startup","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit UserPromptSubmit '{"hook_event_name":"UserPromptSubmit","prompt_id":"p-stub","prompt":"hello","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit Stop '{"hook_event_name":"Stop","prompt_id":"p-stub","last_assistant_message":"hi","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit SessionEnd '{"hook_event_name":"SessionEnd","prompt_id":"p-stub","reason":"other","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
`;

function rigRun({ stubExtra = "", skipImport = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "rig-manifest-"));
  cpSync(HARNESS, join(tmp, "harness"), { recursive: true });
  const stubPath = join(tmp, "stub-cli");
  writeFileSync(stubPath, stub(stubExtra));
  chmodSync(stubPath, 0o755);

  const rig = join(tmp, "harness", "rig", "rig.sh");
  const base = join(tmp, "rig-base");
  // HOME は差し替える。実 HOME のままだと rig が開発者の Claude 資格情報を
  // 一時 rig へ複製する（trap で消えるが、SIGKILL で落ちれば残る）
  const env = { ...process.env, HOME: join(tmp, "home"), RIG_BASE: base, CLAUDE_BIN: stubPath };
  const sh = (...args) => spawnSync("bash", [rig, ...args], { encoding: "utf8", env });

  const setup = sh("setup");
  assert.equal(setup.status, 0, setup.stderr);
  const run = sh("claude-run", LABEL, "hello");
  assert.equal(run.status, 0, run.stderr);
  const rawDir = join(tmp, "harness", "fixtures", "claude", "raw");
  if (skipImport) return { tmp, base, sh, rawDir };
  const imported = sh("import", "claude", LABEL, "self.stub");
  assert.equal(imported.status, 0, imported.stderr);

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
    !existsSync(join(base, "capture", `claude-${LABEL}.stale-exit`)),
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

test("every run initialisation clears the exit status file the run itself writes", () => {
  // stub で走らせるのは claude 経路だけなので、codex 経路はここで形として見る
  // （片方だけ直すと、同じ欠陥が別の識別子で残る）。綴りを固定するのではなく、
  // **書く path と消す path が同じ**ことを突き合わせる: 綴りだけ見る検査は、両方が
  // 揃って間違っている状態（実際にそうなっていた）を素通しする
  const rig = readFileSync(join(HARNESS, "rig", "rig.sh"), "utf8");
  // run ごとに閉じて見る。ファイル全体で照合すると、2 つの run が同じ変数名を使う限り
  // 片方の消し忘れをもう片方の行が隠す
  const blocks = [...rig.matchAll(/^(claude|codex)_run\(\) \{$([\s\S]*?)^\}$/gm)];
  assert.equal(blocks.length, 2, "run 関数の数が変わった");
  for (const [, name, body] of blocks) {
    const written = [...body.matchAll(/printf '%s\\n' "\$rc" > "([^"]+)"/g)].map((m) => m[1]);
    assert.equal(written.length, 1, `${name}_run が終了コードを書く箇所数が変わった`);
    const removals = body.split("\n").filter((l) => l.includes("rm -f "));
    assert.ok(
      removals.some((l) => l.includes(`"${written[0]}"`)),
      `${name}_run が書く ${written[0]} を消している行が無い`,
    );
    assert.equal(body.split("\n").filter((l) => l.includes(': > "$capture"')).length, 1, `${name}_run の初期化が無い`);
    // lock の fd を測定対象へ渡していないこと。渡すと daemon が残る限り以後の run が止まる
    assert.match(body, /\) 9>&- \|\| rc=\$\?/, `${name}_run が lock の fd を CLI へ渡している`);
  }
});

test("the rig stages no credential when the test runs", () => {
  // run が終われば trap が消すので、外から見ても常に無い。stub に run 中を見させる
  const { base } = rigRun();
  assert.ok(
    !existsSync(join(base, "capture", `claude-${LABEL}.staged-credential`)),
    "test の run が実 HOME の資格情報を一時 rig へ複製した",
  );
});

test("a run does not hand its lock to a process the CLI leaves behind", () => {
  // 測定対象が daemon を残すのは普通のこと。lock の fd を継承させていると、その daemon が
  // 終わるまで kernel の flock が解放されず、以後の run と import が全部止まる
  const { sh } = rigRun({
    stubExtra: 'setsid sleep 20 </dev/null >/dev/null 2>&1 &',
    skipImport: true,
  });
  const again = sh("claude-run", LABEL, "hello");
  assert.equal(again.status, 0, `2 回目の run が lock で止まった: ${again.stderr}`);
});

test("an import that would write an unusable manifest replaces nothing", () => {
  // recorderErrors が 0 でない manifest は検証側が必ず棄却する。持ち込みが成功すると、
  // 保存済みの正しい対を壊したうえで、組み立てが必ず落ちる参照を返すことになる
  const { base, sh, rawDir } = rigRun();
  const stored = join(rawDir, `claude-${LABEL}.jsonl`);
  const storedManifest = join(rawDir, `claude-${LABEL}.manifest.json`);
  const before = { capture: readFileSync(stored), manifest: readFileSync(storedManifest) };
  writeFileSync(join(base, "capture", `claude-${LABEL}.jsonl.errors`), "2026-01-01T00:00:00Z\trecorder-failed rc=1 event=Stop\n");
  const again = sh("import", "claude", LABEL, "self.stub");
  assert.notEqual(again.status, 0, "記録器のエラーが残ったまま持ち込みが成功した");
  assert.deepEqual(readFileSync(stored), before.capture, "落ちたのに保存済みの記録が置き換わった");
  assert.deepEqual(readFileSync(storedManifest), before.manifest, "落ちたのに保存済みの manifest が置き換わった");
});

test("a CLI version the manifest schema rejects does not replace the stored evidence", () => {
  // 取り込み側は「1 行で printable」しか見ていない。manifest schema は 64 文字までなので、
  // 長い版を返す CLI は「持ち込みは成功、組み立ては必ず失敗」を作れてしまう
  const { base, sh, rawDir } = rigRun();
  const stored = join(rawDir, `claude-${LABEL}.jsonl`);
  const before = readFileSync(stored);
  writeFileSync(join(base, "capture", `claude-${LABEL}.version`), `${"9".repeat(70)}\n`);
  const again = sh("import", "claude", LABEL, "self.stub");
  assert.notEqual(again.status, 0, "schema が棄却する版で持ち込みが成功した");
  assert.match(again.stderr, /does not match the schema/);
  assert.deepEqual(readFileSync(stored), before, "落ちたのに保存済みの記録が置き換わった");
});

test("an exit status too large to be one is rejected", () => {
  // `^\d+$` だけだと 30 桁が Number で丸められ、schema の integer は通るのに
  // 元の綴りと違う値が manifest へ載る
  const { base, sh, rawDir } = rigRun();
  const before = readFileSync(join(rawDir, `claude-${LABEL}.manifest.json`));
  writeFileSync(join(base, "capture", `claude-${LABEL}.exit`), `${"9".repeat(30)}\n`);
  const again = sh("import", "claude", LABEL, "self.stub");
  assert.notEqual(again.status, 0, "終了コードでない数で持ち込みが成功した");
  assert.deepEqual(readFileSync(join(rawDir, `claude-${LABEL}.manifest.json`)), before);
});
