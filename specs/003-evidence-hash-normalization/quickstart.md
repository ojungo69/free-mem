# Quickstart: 証拠 digest の検証

作業ディレクトリ `/home/jura/projects/free-mem-wt/evidence-hash`。

## 前提

```bash
node --version   # 24.16.0 系
```

## 1. 既存の観測記録から digest を出す

```bash
node harness/evidence/normalize.mjs harness/fixtures/claude/raw/claude-lifecycle-basic.jsonl
# => {"evidenceHash":"24a74e6c...","normalizationVersion":1}
```

## 2. 再取得が同じ digest になることを確認する（SC-003）

`claude-interrupt3` と `claude-interrupt4` は同一 prompt・同一 event 列で、
session id・時刻・transcript path だけが違う 2 回の取得。

```bash
for f in 3 4; do node harness/evidence/normalize.mjs harness/fixtures/claude/raw/claude-interrupt$f.jsonl; done
# => 2 行が完全に一致する
```

## 3. 別の観測が別の digest になることを確認する（SC-004）

```bash
for f in tool-denied tool-ok; do node harness/evidence/normalize.mjs harness/fixtures/claude/raw/claude-$f.jsonl; done
# => 2 行が異なる（許可拒否と成功実行を取り違えない）
```

## 4. matrix を組み立て直す

```bash
npm run harness:assemble   # 既存のスクリプト名は実装時に確認する
git diff harness/matrix/
# => evidenceKind が source-test から real-cli-e2e へ変わる cell が 21 件
# => 逆向き（real-cli-e2e から下がる）変化は 0 件
```

## 5. 攻撃側を確認する（SC-001 / SC-007）

```bash
node --test harness/evidence/normalize.test.mjs harness/assemble.ts
```

test が確認すること:

- 実在しない観測記録を指す 64 桁 hex fixture → 組み立てが失敗する
- 実在するが digest が違う fixture → 組み立てが失敗する
- 未知の `normalizationVersion` → 組み立てが失敗する
- `..` を含む path、絶対 path、置き場の外へ出る symlink → いずれも拒否される
- 3 つの昇格箇所すべてで棄却される

## 6. 秘密が漏れていないことを確認する（SC-005）

```bash
# 観測記録に現れる絶対 path・投入指示・モデル出力が成果物に無いこと
grep -r "/tmp/free-mem-rig" harness/matrix/ && echo "NG" || echo "OK"
grep -r "RIG_INJECT_" harness/matrix/ && echo "NG" || echo "OK"
```
