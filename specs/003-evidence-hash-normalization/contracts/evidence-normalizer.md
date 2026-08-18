# Contract: evidence normalizer

正規化と digest の唯一の実装。取得側（`harness/rig/rig.sh`）と検証側（`harness/assemble.ts`）が
同じものを使う。二重実装を作らない。

配置: `harness/evidence/normalize.mjs`

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

---

## CLI としての表面

```
node harness/evidence/normalize.mjs <capture-file>
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

**行の中身は出さない。** 行番号までにする。
