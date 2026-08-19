// rig が書く manifest を、実 CLI 無しで end-to-end に確かめる。
// stub CLI を CLAUDE_BIN として渡し、rig.sh の setup → claude-run → import を実際に走らせる。
// harness ごと複製して走らせるので、既定の証拠置き場（module からの相対）も複製側を指す。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const stub = (extra = "", versionExtra = "") => `#!/usr/bin/env bash
set -eu
# --version も run_env 経由なので CAPTURE_FILE がある。隔離が効いているかをここで書き出す
# （run_env の外から呼ぶ変異では CAPTURE_FILE が無くなる）。STEM は記録本体を書く段で作る
if [ "\${1:-}" = --version ]; then
{ echo "HOME=\$HOME"; echo "CLAUDE_CONFIG_DIR=\${CLAUDE_CONFIG_DIR:-<unset>}"; echo "INTERNAL=\${AGENT_MEMORY_INTERNAL_RUN:-<unset>}"; echo "PWD=\$PWD"; echo "CAPTURE=\${CAPTURE_FILE:-<unset>}"; } > "\${CAPTURE_FILE:-/dev/null}.version-env"
${versionExtra}
printf '%s\\n' '${VERSION}'; exit 0; fi
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

function rigRun({ stubExtra = "", stubVersionExtra = "", skipImport = false, expectRunFailure = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "rig-manifest-"));
  cpSync(HARNESS, join(tmp, "harness"), { recursive: true });
  const stubPath = join(tmp, "stub-cli");
  writeFileSync(stubPath, stub(stubExtra, stubVersionExtra));
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
  if (!expectRunFailure) assert.equal(run.status, 0, run.stderr);
  const rawDir = join(tmp, "harness", "fixtures", "claude", "raw");
  if (skipImport) return { tmp, base, sh, rawDir, run };
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
  // 綴りを固定するのではなく、
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
  }
});

test("every measured launch is supervised and keeps the lock descriptor", () => {
  // stub で走らせるのは claude 経路だけなので、codex 経路はここで形として見る。
  // 測定対象の起動は 2 つ（--version と本実行）あり、どちらも group ごと畳む。
  // 片方だけ漏れると、その経路の残骸が lock を握って以後の run が止まる
  const rig = readFileSync(join(HARNESS, "rig", "rig.sh"), "utf8");
  const blocks = [...rig.matchAll(/^(claude|codex)_run\(\) \{$([\s\S]*?)^\}$/gm)];
  assert.equal(blocks.length, 2, "run 関数の数が変わった");
  for (const [, name, body] of blocks) {
    assert.equal(
      [...body.matchAll(/reap_group "\$(ver|run)_pid"/g)].length,
      2,
      `${name}_run の起動のうち監督されていないものがある`,
    );
    // fd を渡さないほうが lock は解放されるが、残骸の隣に次の provider の資格情報が置かれる
    assert.ok(!body.includes("9>&-"), `${name}_run が lock の fd を子から外している`);
    // `timeout` は既定で対象を自分の group へ移すので、これが無いと畳む先が空になる
    assert.match(body, /timeout --foreground/, `${name}_run の timeout が group を分けている`);
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

test("a run reaps the processes the CLI leaves behind", () => {
  // 測定対象が子を残すのは普通のこと。残骸は lock の fd を持っているので、畳まないと
  // 以後の run と import が全部「別の run が掴んでいる」で止まる
  const { sh } = rigRun({ stubExtra: "sleep 20 </dev/null >/dev/null 2>&1 &", skipImport: true });
  const again = sh("claude-run", LABEL, "hello");
  assert.equal(again.status, 0, `2 回目の run が lock で止まった: ${again.stderr}`);
});

test("the version probe is supervised like the run itself", () => {
  // --version も測定対象の起動なので、そこで残った子も畳む。監督から漏れると、
  // その子が lock の fd を持ったまま残り、以後の run が全部止まる
  const { sh } = rigRun({ stubVersionExtra: "sleep 20 </dev/null >/dev/null 2>&1 &", skipImport: true });
  const again = sh("claude-run", LABEL, "hello");
  assert.equal(again.status, 0, `2 回目の run が lock で止まった: ${again.stderr}`);
});

test("a process that escapes the group is not released from the lock by the rig", () => {
  // `setsid` で group を抜けた process は畳めない。rig 側から fd を外さないので lock は
  // 握られたままになり、次の run は止まる。
  // **保証はここまで**: 残った process が自分で fd 9 を閉じれば次の run は始まり、
  // その run が置く別 provider の資格情報を同じ UID で読める（#95）。同一 UID で走らせる
  // 限りこれは閉じない
  // detach し切る前に run が終わると group kill が間に合ってしまうので、抜けたことを
  // 待ってから stub を終える（race のまま置くと test が気まぐれに緑になる）
  const escape =
    'setsid sh -c \'printf x > "$STEM.detached"; sleep 20\' </dev/null >/dev/null 2>&1 &\n' +
    'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -e "$STEM.detached" ] && break; sleep 0.2; done';
  const { sh } = rigRun({ stubExtra: escape, skipImport: true });
  const again = sh("claude-run", LABEL, "hello");
  assert.notEqual(again.status, 0, "group を抜けた残骸がいるのに次の run が始まった");
  assert.match(again.stderr, /another rig run holds/);
});

test("a child that ignores SIGTERM does not wedge the rig", () => {
  // group に残った子が SIGTERM を無視すると lock を握ったままになり、以後の run が全部
  // 止まる。畳めるはずの残骸で可用性を失う形なので、猶予のあとに SIGKILL まで上げる
  const stubborn = 'sh -c \'trap "" TERM; sleep 20\' </dev/null >/dev/null 2>&1 &';
  const { sh } = rigRun({ stubExtra: stubborn, skipImport: true });
  const again = sh("claude-run", LABEL, "hello");
  assert.equal(again.status, 0, `SIGTERM を無視する残骸で次の run が止まった: ${again.stderr}`);
});

test("teardown does not pull the lock out from under a live run", () => {
  // teardown が lock を無視して消すと、setup が新しい .lock inode を作り、生きた測定対象の
  // 隣へ次の run が資格情報を置ける。直列化と資格情報の分離が同時に外れる
  const escape =
    'setsid sh -c \'printf x > "$STEM.detached"; sleep 20\' </dev/null >/dev/null 2>&1 &\n' +
    'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -e "$STEM.detached" ] && break; sleep 0.2; done';
  const { sh, base } = rigRun({ stubExtra: escape, skipImport: true });
  const removed = sh("teardown");
  assert.notEqual(removed.status, 0, "lock を握られたまま rig を消した");
  assert.match(removed.stderr, /another rig run holds/);
  assert.ok(existsSync(join(base, ".lock")), "lock を握られたまま .lock を消した");
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

test("a failure while staging leaves both stored files untouched", () => {
  // 検証を全部通ったあとでも書き込みは落ちうる（disk full・権限・race）。置き場を直接
  // 触っていると、そこで落ちた時点で前の対は失われている。manifest の一時 file の場所を
  // directory で塞いで、書き込み側だけを確実に失敗させる
  const { base, sh, rawDir } = rigRun();
  const stored = join(rawDir, `claude-${LABEL}.jsonl`);
  const storedManifest = join(rawDir, `claude-${LABEL}.manifest.json`);
  const before = { capture: readFileSync(stored), manifest: readFileSync(storedManifest) };
  mkdirSync(`${storedManifest}.tmp`);
  // 記録のほうは別物にしておく（置き換わったかどうかが byte で分かる形にする）
  const capture = join(base, "capture", `claude-${LABEL}.jsonl`);
  writeFileSync(
    capture,
    `${readFileSync(capture, "utf8")}{"event":"Stop","at":"2026-01-02T00:00:00.000Z","payload":{"hook_event_name":"Stop"}}\n`,
  );
  const again = sh("import", "claude", LABEL, "self.stub");
  assert.notEqual(again.status, 0, "書き込みに失敗したのに持ち込みが成功した");
  assert.deepEqual(readFileSync(stored), before.capture, "書き込みに失敗したのに記録が置き換わった");
  assert.deepEqual(readFileSync(storedManifest), before.manifest, "書き込みに失敗したのに manifest が置き換わった");
  // 落ちた経路でも一時 file を証拠置き場へ残さない（次の持ち込みが古い複製の隣で始まる）
  assert.ok(!existsSync(`${stored}.tmp`), "書き込みに失敗した run が一時 file を証拠置き場へ残した");
});

test("the version probe runs in the isolated environment, not the caller's", () => {
  // 隔離の約束は「実 HOME・実設定・実 plugin・実 repository を継承しない」。--version を
  // 素で起動していると、その 1 回だけ約束の外で測定対象が動く（実際に外れていた）。
  // 作業場所も見る: CLI は cwd から上へ設定を探すので、呼び出し元に居るだけで実設定に届く
  const { base } = rigRun({ skipImport: true });
  const seen = readFileSync(join(base, "capture", `claude-${LABEL}.version-probe.jsonl.version-env`), "utf8");
  assert.match(seen, new RegExp(`HOME=${base}/home\n`), `版の問い合わせが隔離 HOME で走っていない: ${seen}`);
  assert.match(seen, new RegExp(`CLAUDE_CONFIG_DIR=${base}/claude-config\n`), seen);
  assert.match(seen, /INTERNAL=1\n/, seen);
  assert.match(seen, new RegExp(`PWD=${base}/workspace\n`), `版の問い合わせが呼び出し元の作業場所で走っている: ${seen}`);
});

test("what the version probe records never reaches the scenario's capture", () => {
  // 問い合わせも測定対象の起動なので、hook が動きうる。同じ記録先を使っていると、その event が
  // scenario の記録として持ち込まれ、同じ manifest と digest に入る
  const { capture, rawDir } = rigRun({
    stubVersionExtra: `printf '%s\\n' '{"event":"SessionStart","at":"2026-01-01T00:00:00.000Z","payload":{"hook_event_name":"SessionStart","forged":"version-probe"}}' >> "$CAPTURE_FILE"`,
  });
  assert.ok(
    !readFileSync(capture, "utf8").includes("version-probe"),
    "版の問い合わせが書いた行が scenario の記録に混ざった",
  );
  const imported = readFileSync(join(rawDir, `claude-${LABEL}.jsonl`), "utf8");
  assert.ok(!imported.includes("version-probe"), "版の問い合わせが書いた行を証拠として持ち込んだ");
});

test("a version probe that fails is not accepted as the version behind the evidence", () => {
  // 非ゼロで終えた問い合わせでも、1 行だけ吐けば版として schema を通る。run を続けると
  // そのエラー行が cliVersion に載り、証拠が「この版で測った」と読める
  const { run, base } = rigRun({
    stubVersionExtra: `printf '%s\\n' '${VERSION}'; exit 7`,
    skipImport: true,
    expectRunFailure: true,
  });
  assert.notEqual(run.status, 0, `版の問い合わせが失敗したのに run が成功した: ${run.stdout}`);
  assert.match(run.stderr, /claude --version failed \(exit=7\)/, run.stderr);
  assert.ok(
    !existsSync(join(base, "capture", `claude-${LABEL}.exit`)),
    "版の問い合わせが失敗したのに測定を続けた",
  );
});
