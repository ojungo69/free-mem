# Quickstart: 証拠 digest の検証

作業ディレクトリ `/home/jura/projects/free-mem-wt/evidence-hash`。

## 前提

```bash
node --version   # 24.16.0 系
```

## 1. 既存の観測記録から digest を出す

```bash
node --experimental-strip-types harness/evidence/normalize.ts harness/fixtures/claude/raw/claude-lifecycle-basic.jsonl
# => {"evidenceHash":"1a6bab46...","normalizationVersion":1}
```

## 2. 再取得が同じ digest になることを確認する（SC-003）

`claude-interrupt3` と `claude-interrupt4` は同一 prompt・同一 event 列で、
session id・時刻・transcript path だけが違う 2 回の取得。

```bash
for f in 3 4; do node --experimental-strip-types harness/evidence/normalize.ts harness/fixtures/claude/raw/claude-interrupt$f.jsonl; done
# => 2 行が完全に一致する
```

## 3. 別の観測が別の digest になることを確認する（SC-004）

```bash
for f in tool-denied tool-ok; do node --experimental-strip-types harness/evidence/normalize.ts harness/fixtures/claude/raw/claude-$f.jsonl; done
# => 2 行が異なる（許可拒否と成功実行を取り違えない）
```

## 4. matrix を組み立て直す

`harness/package.json` に scripts は無い。`harness/matrix/README.md` 記載の実コマンドを使う。

```bash
# matrix 生成（usage は node --experimental-strip-types harness/assemble.ts で出る）
node --experimental-strip-types harness/assemble.ts --self-test
# contract hash の再生成（CI が差分を見ている）
node harness/contract-hashes.mjs > /tmp/ch.json && diff harness/contract-hashes.json /tmp/ch.json
git diff harness/matrix/
# => evidenceKind の変化は 0 件（既存 16 件は manifest が無いので昇格しない）
# => evidenceSources 表が増え、各 cell が添字で参照する
```

## 5. 攻撃側を確認する（SC-001 / SC-007）

```bash
node --experimental-strip-types --test harness/evidence/normalize.test.ts
node --experimental-strip-types harness/assemble.ts --self-test
node --experimental-strip-types --test harness/continuity/*.test.ts
vendor/codemem/node_modules/.bin/tsc -p harness/tsconfig.json
```

test が確認すること:

- 実在しない観測記録を指す 64 桁 hex fixture → 組み立てが失敗する
- 実在するが digest が違う fixture → 組み立てが失敗する
- 未知の `normalizationVersion` → 組み立てが失敗する
- `evidence: []` → 組み立てが失敗する
- `..` を含む path、絶対 path、置き場の外へ出る symlink → いずれも拒否される
- 正しい raw と digest のまま cell の値を書き換えた fixture → 棄却される
- manifest 無しの ref だけを持つ cell → `source-test` に留まる（昇格しない）
- 本文に依存する主張（`sessionStartInjection` 等）→ `source-test` に留まる
- manifest の `isolated !== true` / `recorderErrors > 0` / `cliVersion` 不一致 → 棄却される
- 重複キー・不正 UTF-8・`payload.unparsed` を含む記録 → 棄却される
- 3 つの昇格箇所すべてで棄却される

## 6. 秘密が漏れていないことを確認する（SC-005）

**この検査は現在すでに失敗する。** `harness/matrix/{claude,codex}.json` に
`RIG_INJECT_5f3a9` がそのまま載っている（fixture の `limitations` 自由文が逐語転記されるため）。
backfill で fixture 側を無害化してから通す。

```bash
grep -r "/tmp/free-mem-rig" harness/matrix/ && echo "NG" || echo "OK"
grep -r "RIG_INJECT_" harness/matrix/ && echo "NG" || echo "OK"
```

固定文字列の grep では、新しく混ざった実値も、`OK` のような短い一般文字列の偽陽性も扱えない。
本番の検査は canary で行う（data-model.md §5.3）。fixture の自由文と raw の各経路へ
一意な canary を仕込み、子プロセスで組み立てて matrix・stdout・stderr に出ないことを見る。
