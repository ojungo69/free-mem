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
# matrix 生成（実コマンドは harness/matrix/README.md に従う）
node --experimental-strip-types harness/assemble.ts ...
# contract hash の再生成（CI が差分を見ている）
node harness/contract-hashes.mjs > /tmp/ch.json && diff harness/contract-hashes.json /tmp/ch.json
git diff harness/matrix/
# => evidenceKind が source-test から real-cli-e2e へ変わる cell が 21 件
# => 逆向き（real-cli-e2e から下がる）変化は 0 件
```

## 5. 攻撃側を確認する（SC-001 / SC-007）

```bash
node --experimental-strip-types --test harness/evidence/normalize.test.ts
node --experimental-strip-types --test harness/assemble.ts
npx tsc -p harness/tsconfig.json
```

test が確認すること:

- 実在しない観測記録を指す 64 桁 hex fixture → 組み立てが失敗する
- 実在するが digest が違う fixture → 組み立てが失敗する
- 未知の `normalizationVersion` → 組み立てが失敗する
- `evidence: []` → 組み立てが失敗する
- `..` を含む path、絶対 path、置き場の外へ出る symlink → いずれも拒否される
- 正しい raw と digest のまま、実在しない hook を `sourceEvents` に挙げた fixture → 棄却される
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

観測記録から実値を機械抽出して突き合わせる形も置く（自由文へ新しい実値が混ざったときに
上の 2 つの grep では捕まらないため）。
