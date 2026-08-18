// DCO ゲートの純粋な判定を、通す側と落とす側の両方で固定する。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findUnsignedCommits } from "./dco-check.mjs";

function commit(overrides = {}) {
  return {
    sha: "1111111111111111111111111111111111111111",
    subject: "変更を追加",
    authorName: "Alice Example",
    authorEmail: "alice@example.com",
    committerEmail: "committer@example.com",
    body: "変更を追加\n\nSigned-off-by: Alice Example <alice@example.com>\n",
    ...overrides,
  };
}

test("すべての commit に一致する sign-off があれば空を返す", () => {
  const commits = [
    commit(),
    commit({
      sha: "2222222222222222222222222222222222222222",
      authorEmail: "ALICE@example.com",
    }),
  ];

  assert.deepEqual(findUnsignedCommits(commits), []);
});

test("未署名の commit だけを返す", () => {
  const unsigned = commit({
    sha: "2222222222222222222222222222222222222222",
    subject: "未署名の変更",
    body: "未署名の変更\n",
  });

  assert.deepEqual(findUnsignedCommits([commit(), unsigned]), [unsigned]);
});

test("sign-off の email が author と committer のどちらにも一致しなければ返す", () => {
  const mismatched = commit({
    body: "変更を追加\n\nSigned-off-by: Mallory Example <mallory@example.com>\n",
  });

  assert.deepEqual(findUnsignedCommits([mismatched]), [mismatched]);
});

test("複数の sign-off のうち 1 つが committer email と一致すれば通す", () => {
  const signed = commit({
    body: [
      "変更を追加",
      "",
      "Signed-off-by: Mallory Example <mallory@example.com>",
      "Signed-off-by: Committer Example <COMMITTER@example.com>",
      "",
    ].join("\n"),
  });

  assert.deepEqual(findUnsignedCommits([signed]), []);
});

test("bot を名乗る author email でも未署名なら落とす", () => {
  // `git commit --author` で誰でも名乗れる綴りなので、bot 名は免除の根拠にならない。
  const botEmails = [
    "dependabot[bot]@users.noreply.github.com",
    "49699333+dependabot[bot]@users.noreply.github.com",
    "github-actions[bot]@users.noreply.github.com",
  ];
  const commits = botEmails.map((authorEmail, index) =>
    commit({ sha: String(index + 1).repeat(40), authorEmail, body: "依存更新\n" }),
  );

  assert.deepEqual(findUnsignedCommits(commits), commits);
});

test("bot を名乗る author email でも署名があれば通す", () => {
  const signed = commit({
    authorEmail: "dependabot[bot]@users.noreply.github.com",
    body: "依存更新\n\nSigned-off-by: Dependabot <dependabot[bot]@users.noreply.github.com>\n",
  });

  assert.deepEqual(findUnsignedCommits([signed]), []);
});

// ゲートの「形」は unit test が届かない層（workflow の trigger と job 名）で決まっているので、
// そこが崩れたら落ちるものをここに 1 つ置く。security control ではなく、後から自分で壊さない
// ための回帰検査。
// GitHub が required status check を照合する名前は job の `name`、無ければ job id。
// どちらの綴りでも `dco` という check 名を作れるので、両方を数える。
function checkNames(workflow) {
  const names = [];
  let inJobs = false;
  let current = null;
  for (const line of workflow.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobId = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobId) {
      current = { name: jobId[1] };
      names.push(current);
      continue;
    }
    const jobName = line.match(/^ {4}name:\s*(.+?)\s*$/);
    if (jobName && current) current.name = jobName[1].replaceAll(/^["']|["']$/g, "");
  }
  return names.map((job) => job.name);
}

test("dco check は 1 経路だけで、base branch 側から走る", () => {
  const workflowDir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
  const declaring = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .filter((name) => checkNames(readFileSync(join(workflowDir, name), "utf8")).includes("dco"));

  // 同名 check の生産者が 2 つあると、skip された側が成功として使われる。
  assert.deepEqual(declaring, ["dco.yml"]);

  const workflow = readFileSync(join(workflowDir, "dco.yml"), "utf8");
  // PR 側の tree から実行すると、PR が自分を検査する workflow と checker を書き換えられる。
  assert.match(workflow, /^ {2}pull_request_target:$/m);
  // checkout に ref を渡すと base ではなく PR head を取り出してしまう。
  assert.doesNotMatch(workflow, /^\s+ref:/m);
  assert.match(workflow, /node harness\/dco-check\.mjs/);
});

test("本文中の引用や行途中にある Signed-off-by は trailer として扱わない", () => {
  const quoted = commit({
    sha: "2222222222222222222222222222222222222222",
    body: "説明\n\n> Signed-off-by: Alice Example <alice@example.com>\n",
  });
  const inline = commit({
    sha: "3333333333333333333333333333333333333333",
    body: "説明\n\n例: Signed-off-by: Alice Example <alice@example.com>\n",
  });

  assert.deepEqual(findUnsignedCommits([quoted, inline]), [quoted, inline]);
});

// 上の 7 件は純関数だけを見る。実測では、その 7 件が全部通ったまま CLI 経路が `Refs #59` +
// sign-off の commit を落としていた（trailer block の判定違い）。実物を子プロセスとして
// 起動し、通す側・落とす側・fail-closed の 3 方向を固定する。
const script = fileURLToPath(new URL("./dco-check.mjs", import.meta.url));

function run(cwd, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "dco-check-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Alice Example"]);
  git(root, ["config", "user.email", "alice@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

function commitFile(root, name, message, { signOff = true } = {}) {
  writeFileSync(join(root, name), `${name}\n`);
  git(root, ["add", name]);
  git(root, ["commit", "-q", ...(signOff ? ["-s"] : []), "-m", message]);
}

// `git commit -s` は trailer らしくない最終段落の後に空行を足してから sign-off を付ける。
// agent や人が message 全体を書くときはその空行が入らず、`Refs #59` の直下に sign-off が並ぶ。
// 落ちるのはこちらの形なので、テストはこちらを作る。
function commitWithRawMessage(root, name, message) {
  writeFileSync(join(root, name), `${name}\n`);
  git(root, ["add", name]);
  git(root, ["commit", "-q", "-m", message]);
}

test("実スクリプト: PR の commit が全部署名済みなら通る", (t) => {
  const root = repository(t);
  commitFile(root, "base.txt", "base commit");
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-q", "-b", "feature"]);
  commitFile(root, "a.txt", "signed commit");
  // この repo の慣習: 末尾段落に `Refs #59` と sign-off が空行なしで並ぶ
  commitWithRawMessage(
    root,
    "b.txt",
    "refs style commit\n\nRefs #59\nSigned-off-by: Alice Example <alice@example.com>\n",
  );

  const result = run(root, [base, "HEAD"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DCO check OK: 2 commit\(s\)/);
});

test("実スクリプト: 未署名 commit が 1 件でもあれば落ちる", (t) => {
  const root = repository(t);
  commitFile(root, "base.txt", "base commit");
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-q", "-b", "feature"]);
  commitFile(root, "a.txt", "signed commit");
  commitFile(root, "b.txt", "unsigned commit", { signOff: false });

  const result = run(root, [base, "HEAD"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DCO check FAILED/);
  assert.match(result.stderr, /unsigned commit/);
});

// 検査できなかったことを成功として返さない。ここが緩むと、ゲートは「何も見ていない」まま緑になる。
test("実スクリプト: 検査対象を確定できない場合は fail-closed", (t) => {
  const root = repository(t);
  commitFile(root, "base.txt", "base commit");

  assert.equal(run(root, []).status, 2, "引数不足");
  assert.equal(run(root, ["HEAD"]).status, 2, "引数不足");
  assert.equal(run(root, ["HEAD", "HEAD", "extra"]).status, 2, "余分な引数");
  assert.equal(run(root, ["does-not-exist", "HEAD"]).status, 2, "解決できない ref");
  assert.equal(run(root, ["HEAD", "HEAD"]).status, 2, "範囲が空");
});

// 起動判定が壊れると、ゲートは何も検査せず exit 0 で終わる。symlink 経由でも main() に届くこと。
test("実スクリプト: symlink 経由で起動しても main() に到達する", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dco-check-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, "linked-dco-check.mjs");
  symlinkSync(script, link);

  const result = spawnSync(process.execPath, [link], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: dco-check\.mjs/);
});
