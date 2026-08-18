// #90 が閉じるまでの機械的な歯止め。
//
// real-cli-e2e への昇格経路は実装され test も通っているが、観測記録は測定対象 CLI と同じ
// UID で書けるので「CLI が自分で作った記録」を最高位証跡として公開できてしまう
// （harness/matrix/README.md「記録の取得側に残っている限界」）。文書は経路を閉じない。
//
// そこで、直せるまでは **成果物の側**を止める。この test は #90 を閉じたときに削除する。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const CLIS = ["claude", "codex"] as const;

test("no rig-written manifest is committed while the recorder is forgeable (#90)", () => {
  for (const cli of CLIS) {
    const dir = new URL(`../fixtures/${cli}/raw/`, import.meta.url);
    const manifests = readdirSync(dir).filter((n) => n.endsWith(".manifest.json"));
    assert.deepEqual(manifests, [], `${cli}: #90 が閉じるまで manifest は commit しない`);
  }
});

test("no shipped matrix cell claims real-cli-e2e while the recorder is forgeable (#90)", () => {
  for (const cli of CLIS) {
    const matrix = readFileSync(new URL(`../matrix/${cli}.json`, import.meta.url), "utf8");
    assert.ok(!matrix.includes('"real-cli-e2e"'), `${cli}: #90 が閉じるまで real-cli-e2e は出荷しない`);
  }
});
