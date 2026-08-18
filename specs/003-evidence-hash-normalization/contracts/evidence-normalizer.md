# Contract: evidence normalizer

正規化と digest の唯一の実装。取得側（`harness/rig/rig.sh`）と検証側（`harness/assemble.ts`）が
同じものを使う。二重実装を作らない。

配置: `harness/evidence/normalize.ts`（`.mjs` にしない。harness/tsconfig.json は `include: ["**/*.ts"]` で `allowJs` が無く、`.mjs` を import すると implicit any になる）

---

## モジュールとしての表面

```ts
/** 現在の正規化規則の版。data-model.md §1 の定義に対応する */
export const NORMALIZATION_VERSION: number;

/**
 * 観測記録の本文から正規化抜粋を作る。
 * @param text 観測記録ファイルの中身（UTF-8 文字列）
 * @returns LF 区切りの NDJSON。最終行の後にも LF が付く
 * @throws 空行以外に解釈できない行がある / 解釈できた行が 0 件 /
 *         行が event か payload を欠く
 */
export function normalizeCapture(text: string): string;

/** normalizeCapture の出力の SHA-256（小文字 hex 64 桁） */
export function digestCapture(text: string): string;

/**
 * 証拠置き場の中だけを解決する。
 * @param cli "claude" | "codex"
 * @param relPath 置き場からの相対 path
 * @returns 解決済みの絶対 path
 * @throws 絶対 path / ".." を含む / 存在しない / 実体解決後に置き場の外
 */
export function resolveEvidencePath(cli: string, relPath: string): string;
```

`resolveEvidencePath` の置き場は `harness/fixtures/<cli>/raw/`。基点はモジュール自身の位置から
解決する（呼び出し側の cwd に依存しない）。

`cli` は既知の値（`"claude"` / `"codex"`）であることを関数内で確認してから path へ結合する。
schema が上流で検証しているが、path の一部になる値の検査を呼び出し側任せにしない。

---

## CLI としての表面

```
node --experimental-strip-types harness/evidence/normalize.ts <capture-file>
```

- 標準出力へ `{"evidenceHash":"<64 hex>","normalizationVersion":<n>}` を 1 行
- 成功で終了コード 0
- 失敗（引数不足・引数過多・読めない・解釈できない）で終了コード 2 と、
  標準エラーへ理由。**観測記録の中身と絶対 path は出さない**
- 引数で渡した path はそのまま読む（`resolveEvidencePath` は通さない）。
  rig は置き場の外（`$RIG_BASE/capture/`）から呼ぶ場面があるため。
  置き場の制約は fixture の申告値に対して assemble 側で掛かる

---

## 失敗の分類

| 状況 | 終了コード / 例外 | 出す情報 |
|---|---|---|
| 引数の個数が違う | 2 | usage |
| ファイルが読めない | 2 | 「読めない」ことと、渡された path の basename |
| 空行以外が解釈できない | 2 | 行番号 |
| 解釈できた行が 0 件 | 2 | 件数 0 |
| `event` / `payload` を欠く行 | 2 | 行番号と欠けたキー名 |
| 重複 property を含む行（`parseIJson` が拒否） | 2 | 行番号 |
| 不正な UTF-8（`decodeUtf8` が拒否） | 2 | byte 位置 |
| `payload.unparsed` を持つ行 | 2 | 行番号 |

**行の中身は出さない。** 行番号までにする。
**path も出さない。** 例外は安全な理由コードへ変換し、渡された path は basename までにする。

---

## 読み取りは既存実装を使う

`harness/schema/jcs.ts` の `decodeUtf8` と `parseIJson` を再利用する。自前で
`readFileSync(..., "utf8")` + `JSON.parse` を書かない。

- Node の既定 UTF-8 読み取りは不正 byte を U+FFFD へ黙って置換する。壊れた記録が
  正常な記録として digest を得る
- `JSON.parse` は重複 property を後勝ちで潰す。`{"a":1,"a":2}` と `{"a":2}` が同じ digest になる

正規化の中間オブジェクトは `Object.create(null)` で作る。通常の `{}` へ `__proto__` を
代入すると欄が消える。
