// 出荷する matrix が fixture から機械的に導けることを確かめる。
//
// CI が `diff <(jq …) <(jq …)` でやっていた検査を置き換えたもの。あの形は 2 つ素通しする:
// `jq` は object の重複キーを後勝ちで潰すので、潰れる側に何を書いても比較は一致し、
// process substitution の中の `jq` が落ちても終了状態は `diff` のものしか返らない。
// ここでは repo の I-JSON parser で読むので、重複キーはその場で棄却される。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, readIJsonFile } from "../schema/jcs.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const CLIS = ["claude", "codex"] as const;

/** generatedAt は実行ごとに変わるので比較から外す。それ以外は 1 byte も動かさない */
const withoutGeneratedAt = (m: unknown): string => {
  const { generatedAt: _dropped, ...rest } = m as Record<string, unknown>;
  return canonicalizeJson(rest);
};

const assertNoDrift = (cli: (typeof CLIS)[number]): void => {
  const out = join(mkdtempSync(join(tmpdir(), "matrix-drift-")), `${cli}.json`);
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(repoRoot, "harness", "assemble.ts"),
      join(repoRoot, "harness", "fixtures", cli),
      out,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(
    withoutGeneratedAt(readIJsonFile(new URL(`../matrix/${cli}.json`, import.meta.url))),
    withoutGeneratedAt(readIJsonFile(out)),
    `${cli}: 出荷している matrix が fixture から導けない（手で編集された）`,
  );
};

// test 名は literal で並べる（変異表との突き合わせが grep で効く形にするため）
test("the shipped claude matrix is what the fixtures assemble to", () => assertNoDrift("claude"));
test("the shipped codex matrix is what the fixtures assemble to", () => assertNoDrift("codex"));
