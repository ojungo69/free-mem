// 秘密が成果物へ出ない経路を、組み立てを子プロセスとして起動して確かめる。
// 同一プロセスで assembleFromFixtures を呼ぶ test では、実際に出力される file の中身と
// stdout / stderr を見られない（entrypoint の起動判定も含めて経路が違う）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertNoSecretSubstrings } from "../assemble.ts";
import { collectSecretsOf } from "./verify.ts";

const HARNESS = fileURLToPath(new URL("../", import.meta.url));
const RAW = "claude-lifecycle-basic.jsonl";

// canary はどれも 16 文字以上。漏れた場合は成果物の検査（16-gram 警報）にも掛かる
const PROSE = "CANARY-PROSE-8f2b1c4d9e7a";
const CWD = "CANARY-CWD-3a7e5b1f2d8c0114";
const MSG = "CANARY-MSG-6d4c2a9f1b3e0227";
const EVENT = "CANARY-EVENT-1e9b7d3f5a2c";
const SCENARIO = "CANARY-SCENARIO-4b8e0c6a2f91";

const node = (args: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", ...args], { encoding: "utf8" });

/** harness ごと複製する。証拠置き場は module からの相対なので、複製と一緒に動く */
function plantedTree(): { tmp: string; rawPath: string } {
  const tmp = mkdtempSync(join(tmpdir(), "evidence-secrets-"));
  cpSync(HARNESS, join(tmp, "harness"), { recursive: true });
  const fixturesDir = join(tmp, "harness", "fixtures", "claude");
  const rawPath = join(fixturesDir, "raw", RAW);

  // (b) 観測記録の秘密欄へ仕込む
  const lines = readFileSync(rawPath, "utf8").split("\n");
  const planted = lines.map((line) => {
    if (line.trim() === "") return line;
    const rec = JSON.parse(line);
    rec.payload.cwd = `/home/someone/${CWD}`;
    if ("last_assistant_message" in rec.payload) rec.payload.last_assistant_message = MSG;
    return JSON.stringify(rec);
  });
  writeFileSync(rawPath, planted.join("\n"));

  // 記録を変えたので digest を取り直す。手で計算せず CLI から得る
  const out = node([join(tmp, "harness", "evidence", "normalize.ts"), rawPath]);
  assert.equal(out.status, 0, out.stderr);
  const { evidenceHash, captureRawHash } = JSON.parse(out.stdout);

  let prosePlanted = false;
  let eventPlanted = false;
  for (const name of readdirSync(fixturesDir).filter((n) => n.endsWith(".json"))) {
    const file = join(fixturesDir, name);
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    for (const ref of fixture.evidence ?? []) {
      if (ref.path !== RAW) continue;
      ref.evidenceHash = evidenceHash;
      ref.captureRawHash = captureRawHash;
    }
    fixture.scenario = `${fixture.scenario} ${SCENARIO}`;
    // (a) fixture の散文へ仕込む。散文は成果物へ出ず、対応する code だけが出る
    if (!prosePlanted && fixture.limitations?.length) {
      fixture.limitations[0] = `${fixture.limitations[0]} ${PROSE}`;
      prosePlanted = true;
    }
    // 事象側の散文も別経路。こちらは cell の limitations へ出る欄なので別に仕込む
    for (const ev of fixture.observedEvents ?? []) {
      if (eventPlanted || !ev.limitations?.length) continue;
      ev.limitations[0] = `${ev.limitations[0]} ${EVENT}`;
      eventPlanted = true;
    }
    writeFileSync(file, JSON.stringify(fixture, null, 2));
  }
  assert.ok(prosePlanted, "散文 limitations を持つ fixture が無い");
  assert.ok(eventPlanted, "散文 limitations を持つ事象が無い");
  return { tmp, rawPath };
}

test("planted canaries never reach the matrix, stdout, or stderr", () => {
  const { tmp } = plantedTree();
  const outFile = join(tmp, "out.json");
  const run = node([join(tmp, "harness", "assemble.ts"), join(tmp, "harness", "fixtures", "claude"), outFile]);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const matrix = readFileSync(outFile, "utf8");
  // 仕込みが効いていることを先に見る（記録側に無ければ、この test は何も守らない）
  assert.match(readFileSync(join(tmp, "harness", "fixtures", "claude", "raw", RAW), "utf8"), new RegExp(CWD));
  for (const [label, canary] of [["prose", PROSE], ["event", EVENT], ["scenario", SCENARIO], ["cwd", CWD], ["message", MSG]] as const) {
    assert.ok(!matrix.includes(canary), `${label} canary が matrix に出た`);
    assert.ok(!run.stdout.includes(canary), `${label} canary が stdout に出た`);
    assert.ok(!run.stderr.includes(canary), `${label} canary が stderr に出た`);
  }
  // 成果物が空でないこと（何も出さなければ canary も出ない）
  assert.match(matrix, /"evidenceKind"/);
});

test("failure messages carry neither capture contents nor absolute paths", () => {
  const { tmp, rawPath } = plantedTree();
  appendFileSync(rawPath, "\n");

  const run = node([join(tmp, "harness", "assemble.ts"), join(tmp, "harness", "fixtures", "claude"), join(tmp, "o.json")]);
  assert.notEqual(run.status, 0, "改竄した記録で組み立てが成功した");
  const said = `${run.stdout}\n${run.stderr}`;
  assert.match(said, /captureRawHash mismatch/);
  assert.match(said, new RegExp(RAW), "どの記録かは basename で言う");
  assert.ok(!said.includes(tmp), "失敗の説明に絶対 path が出た");
  for (const canary of [PROSE, EVENT, SCENARIO, CWD, MSG]) assert.ok(!said.includes(canary), "失敗の説明に記録の中身が出た");
});

// --- 警報そのものを直接見る ---
// 正しい実装では秘密が成果物へ届く経路が無いので、上の canary test は警報を殺しても落ちない。
// 警報は「他の防御が破れたとき最後に鳴るもの」なので、単体で鳴ることを別に確かめる。

test("a 16+ char secret substring in a generated string fails the build", () => {
  const secret = "0123456789abcdefghij";
  assert.throws(() => assertNoSecretSubstrings({ cell: { note: `xx${secret.slice(0, 16)}yy` } }, [secret]), /16\+ character/);
  // 15 文字までは通す。窓を縮めると偽陽性で正常な組み立てが落ちる
  assert.doesNotThrow(() => assertNoSecretSubstrings({ cell: { note: `xx${secret.slice(0, 15)}yy` } }, [secret]));
  assert.doesNotThrow(() => assertNoSecretSubstrings({ cell: { note: secret } }, []));
});

test("collectSecrets covers every secret-bearing field", () => {
  const long = (tag: string) => `${tag}-0123456789abcdef`;
  const line = {
    event: "PreToolUse",
    at: "2026-01-01T00:00:00.000Z",
    payload: {
      prompt: long("prompt"),
      last_assistant_message: long("msg"),
      cwd: long("cwd"),
      transcript_path: long("transcript"),
      agent_transcript_path: long("agent-transcript"),
      tool_input: { command: long("command"), nested: [{ deep: long("deep-input") }] },
      tool_response: { stdout: long("stdout") },
      hook_event_name: long("not-a-secret"),
    },
  };
  const found = collectSecretsOf(Buffer.from(`${JSON.stringify(line)}\n`, "utf8"));
  for (const tag of ["prompt", "msg", "cwd", "transcript", "agent-transcript", "command", "deep-input", "stdout"]) {
    assert.ok(found.has(long(tag)), `${tag} が警報の材料に入っていない`);
  }
  // 秘密でない欄まで材料にすると、正常な組み立てが偽陽性で落ちる
  assert.ok(!found.has(long("not-a-secret")));
});
