# Research: #92 レビュー残件（issue #109）の回収

**作成**: 2026-08-20
**基準 commit**: `bc42c40`（origin/main。PR #92 のマージ commit）
**worktree**: `/home/jura/projects/free-mem-wt/residue-109`（branch `fix/review-residue-109`）

この文書は、実装に入る前に **実際に走らせて確かめた** 環境側の事実だけを記録する。
issue #109 の各指摘そのものの裏取りは `spec.md` の FR と `tasks.md` に落とす。

## 1. ベースラインは green（実測 2026-08-20）

worktree を `origin/main` から作り、CI の harness job と同じ順で回した結果:

| 検査 | コマンド | 結果 |
|---|---|---|
| contract hashes | `node harness/contract-hashes.mjs \| diff harness/contract-hashes.json -` | 一致 |
| capability matrix self-test | `node --experimental-strip-types harness/assemble.ts --self-test` | `PASS` |
| continuity contract tests | `node --experimental-strip-types --test harness/continuity/*.test.ts` | 333 pass / 0 fail |
| evidence verification tests | `node --experimental-strip-types --test harness/evidence/*.test.ts harness/evidence/rig-manifest.test.mjs` | 167 pass / 0 fail |
| DCO gate self-test | `node --test harness/dco-check.test.mjs` | 0 fail |
| matrix drift | `node --experimental-strip-types --test harness/evidence/matrix-drift.test.ts` | 2 pass / 0 fail |
| evidence 変異ゲート | `bash harness/evidence/mutate.sh` | 実行中（144 件。別途記録） |

Node は `v24.16.0`（CI の `node-version: 24.16.0` と一致）。

## 2. 変異ゲートの自己検査が課す制約（`harness/evidence/mutate.sh`）

実装を触る前に読んで確かめた、**この feature の変更が必ずぶつかる** 仕掛け:

- `MUTABLE=("$ASSEMBLE" "$VERIFY" "$NORMALIZE" "$SCHEMA" "$MSCHEMA" "$SCHEMAV" "$CAP" "$IMPORT" "$RIG" "$HASHES" "$FIXTURE" "$MATRIX" "$CI")`
  — 変異中はこれらが書き換わる。**ゲートの実行中に作業ツリーのこれらを編集してはならない**
  （EXIT trap の `restore_all` が編集を巻き戻す）。
- 変異表との突き合わせは `python3` で行い、`|| exit 1` が付いているので **この python の
  終了状態は伝播する**。issue #109 が言う「python の非ゼロが伝播しない」のは
  **アンカー適用側の別の python** のこと。両者を混同しないこと。
- 件数は **直書き**: `if len(table) != 144:`。変異を増減したら
  `specs/003-evidence-hash-normalization/tasks.md` の表と **この数値の両方** を更新する。
  （直書きの理由も同ファイルにコメントで書かれている: 表の行と実変異を同時に消す縮小を
  通さないため。数え上げに変えてはならない。）
- `bak_key() { printf '%s' "${1//\//_}"; }` — `/` を `_` に潰す。すぐ上のコメントは
  「basename だと別 directory の同名 file で退避が上書きされる」と書いており、`_` 化は
  その対策。ただし `_` 化でも別 path が同じ鍵に落ちうる（#109 の指摘）。

## 3. contract hash と「公開済み版の不変」ゲートの守備範囲（一次確認済み）

`capability.schema.json` を触ってよいかを決める 2 つの CI step を読んだ:

- **`Contract hashes are regenerated`**: `harness/contract-hashes.mjs` は `ROOTS` 配下を
  walk して **各ファイルの生バイトの SHA-256** を `harness/contract-hashes.json` に書く。
  → `harness/schema/capability.schema.json` は対象。**1 byte でも変えたら
  `harness/contract-hashes.json` の再生成が必須**。整形の違いも検出される。
- **`Published manifest versions are immutable`**: 対象は
  `grep -E 'capability-scenarios\.v[0-9]+\.json$'` で絞られた **`capability-scenarios.v*.json` のみ**。
  → `capability.schema.json` は **この不変ゲートの対象外**。したがって enum の重複統合は
  「禁止」ではなく「hash 再生成を伴う変更」として扱える。

## 4. 出荷 matrix の不変条件（#90 kill switch）

`harness/matrix/*.json` の 21 cell はすべて `source-test`、`real-cli-e2e` は 0 件。
`killswitch.test.ts` が manifest の同梱と `real-cli-e2e` の出荷を止めている。
**この feature のどの変更もこれを動かしてはならない。** 動かす提案は却下する。

## 5. 並行レーンとの非重複（衝突回避）

同時に走っている他レーンとファイルが重ならないことを確認済み:

- `fix/continuity-abandon-conflict-73`（issue #73）→ `harness/continuity/*` と
  `evidence/phase3-reference-model.md` に閉じる
- `fix/flaky-spool-89`（issue #89）→ `vendor/codemem/packages/core/src/spool*` に閉じる

この feature は `harness/evidence/*`・`harness/assemble.ts`・`harness/schema/*`・
`harness/rig/*`・`.github/workflows/ci.yml`・`harness/matrix/README.md`・
`specs/003-evidence-hash-normalization/*`・`harness/contract-hashes.json` を触る。

## 6. `synthetic-tmp-cleanup` は nit ではなく実害（2026-08-20 実測）

issue #109 は `harness/evidence/synthetic.ts` の一時 directory 漏れを「test 衛生」として挙げていたが、
この作業中に **実際に別の作業を止めた**。

変異ゲート（`bash harness/evidence/mutate.sh`）は test 一式を約 99 回回す。`newRoot()` は毎回
`mkdtempSync(join(tmpdir(), "evroot-"))` を作り、どこでも消さない。measurement:

```
$ find /tmp -maxdepth 1 -name 'evroot-*' | wc -l
273737
$ find /tmp -maxdepth 1 -mindepth 1 | wc -l
309590
```

内訳（/tmp 直下）: `evroot-` 273,737 / `evidence-secrets-` 9,084 / `matrix-drift-` 7,120 /
`evsib-` 5,224 / `evlink-` 5,224 / `evfix-` 5,159。

この状態で `grok-delegate.sh` による実装委譲を起動すると、sandbox の構築段階で落ちた:

```
grok exit=1: error: sandbox deny glob could not be enforced on Linux:
expanding the deny globs ["/tmp/tmp.*/releases"] visited over 2000000 entries
across their roots (stopped in /tmp at /tmp/evroot-.../backed
```

つまり漏れた一時 directory が **カーネル強制の deny glob 展開を破綻させ、sandbox を組めなくした**。
`/tmp` を掃除してから再実行して復旧させた。

**この項目の優先度はこの実測に基づいて上げてよい。** 直し方は反証役の訂正どおり、
`synthetic.ts` の `newRoot()` 側に `node:test` の `after` を置き、
`promotion.test.ts:512` の `evfix-` も同じ経路へ寄せる。
