# Phase 1 Data Model: 証拠 digest による real-cli-e2e 昇格の裏付け

---

## 1. 正規化の canonical 形（`normalizationVersion: 1`）

### 1.1 入力の境界

- 入力は 1 件の観測記録ファイル。1 行 1 JSON の NDJSON
- 抽出範囲は **ファイル全体**。scenario 1 件に対して rig が 1 ファイルを書くため、
  ファイル境界がそのまま scenario 境界になる
- 空行は読み飛ばす。空行以外で JSON として解釈できない行が 1 つでもあれば **失敗**
  （壊れた行を読み飛ばして残りで digest を作らない）
- 解釈できた行が 0 件なら **失敗**（「対象 0 件だから成功」にしない）
- 各行は `event`（文字列）と `payload`（オブジェクト）を持たなければならない。
  欠けていれば失敗。`at` は存在してもしなくてもよい（落とすため）

### 1.2 各行の変換

```
{ "event": <verbatim>, "payload": <normalizeValue(payload)> }
```

top-level の `at` は落とす。それ以外の top-level キーが現れた場合は、`payload` と同じ
`normalizeValue` を通したうえで残す（未知の欄の出現自体を digest に反映するため）。

### 1.3 値の変換 `normalizeValue(v, key)`

| 入力 | 出力 |
|---|---|
| `null` | `null` |
| boolean | そのまま |
| number | `"<number>"` |
| string、かつ `key` が verbatim キー | marker 置換を適用した文字列 |
| string、かつ空文字列 | `"<string:empty>"` |
| string、その他 | `"<string>"` |
| array | 要素ごとに `normalizeValue(要素, undefined)`。**長さを保持する** |
| object | キーを全保持し、キーごとに `normalizeValue(値, キー名)` |

**verbatim キー（8 種）**

`event` / `hook_event_name` / `tool_name` / `source` / `reason` / `permission_mode` /
`agent_type` / `prompt`

選定根拠は research.md R1/R2 の実測。この 8 種はどれも、
(a) 同一 scenario の再取得で変わらず、(b) 値が違えば観測として別物になる。
`prompt` を外すと許可拒否と成功実行が同一 digest になることを実測済み。

**marker 置換**: verbatim キーの値に対してのみ、`RIG_INJECT_[A-Za-z0-9_]+` を
`RIG_INJECT_<marker>` へ置換する。rig の呼び出し側が `INJECT_MARKER` で渡す値であり、
run ごとに変わり得るため。

**array の要素にキー名は渡さない。** 配列の中の文字列は常に伏せ字になる。
配列要素にキー名相当の文脈は無く、渡す規則を作ると「N 番目の要素だけ verbatim」という
位置依存の規則になって不安定。

### 1.4 直列化

- 各行を JSON へ直列化する。**オブジェクトのキーは UTF-16 コードユニット昇順**
  （`Array.prototype.sort` の既定順。`JSON.stringify` へ整列済みの置換オブジェクトを渡す）
- 区切りは詰める（`,` と `:` の後に空白を入れない）
- 非 ASCII はエスケープせず UTF-8 のまま出す
- 行区切りは LF（`\n`）。**最終行の後にも LF を 1 つ置く**
- 全体を UTF-8 でバイト列にし、その SHA-256 の小文字 hex が `evidenceHash`

### 1.5 版番号

- `normalizationVersion` は整数。現在の値は `1`
- 上記 1.1〜1.4 のいずれかを変えたら値を上げる
- harness は自分が実装している版と一致しない申告を **失敗**として扱う。
  「たぶん同じ」で続行しない

---

## 2. schema と型の変更

### 2.1 `CaptureFixture` に足す欄

```ts
/**
 * この capture の根拠となる観測記録。`harness/fixtures/<cli>/raw/` からの相対 path。
 * 複数の run を 1 つの fixture でまとめている場合があるため配列。
 * 例: claude/interrupt-and-hook-timeout は 5 本を参照する。
 */
evidence?: EvidenceRef[];

interface EvidenceRef {
  /** 証拠置き場 harness/fixtures/<cli>/raw/ からの相対 path。絶対 path と `..` は拒否 */
  path: string;
  /** 正規化抜粋の SHA-256（小文字 hex 64 桁） */
  evidenceHash: string;
  /** 生成に用いた正規化規則の版 */
  normalizationVersion: number;
}
```

**単数欄にしない理由**: `claude/interrupt-and-hook-timeout` が 5 本の観測記録を根拠にしている。
単数欄だと 4 本が検査対象から外れ、中断の証跡（この fixture の主張の中心）が裏取り無しで残る。

### 2.2 既存 `evidenceHash` 欄の扱い

`CaptureFixture` 直下の `evidenceHash?: string` は **廃止**する。この欄は
「fixture が自分で書いた 64 桁 hex」であり、本 issue が塞ぐ対象そのもの。
申告している fixture は 0 件なので、廃止による既存 fixture の書き換えは発生しない。

`CapabilityEvidence.evidenceHash`（matrix 側の出力欄）は**残す**。ただし値の出どころが
「fixture の自己申告」から「再計算して一致した digest」へ変わる。

### 2.3 `capability.schema.json`

- `properties.evidence` を追加（`type: array`、要素は `path` / `evidenceHash` /
  `normalizationVersion` を required とする object、`additionalProperties: false`）
- `properties.evidenceHash`（top-level）を削除
- `required` には **加えない**。`official-doc` / `source-test` を根拠とする fixture は
  観測記録を持たない。要求するのは「実 CLI 観測を名乗るとき」であって「常に」ではない
- 判定は assemble 側で行う: `evidence` を持たない fixture の cell は `source-test` 止まり、
  持つ fixture は全件の再計算が一致したときにだけ `real-cli-e2e`

**`required` に入れない判断の理由**: 入れると `official-doc` 由来の fixture が書けなくなり、
`evidenceKind` の語彙 3 種のうち 2 種が到達不能になる。schema の required は「常に必要な欄」を
表すもので、条件付きの要求は assemble 側の検査で表す。

### 2.4 `harness/fixtures/continuity/*.json`

別種の fixture（`cases` / `intakeContext` を持つ）で `capability.schema.json` の検証対象外。
schema 変更の影響を受けないことを回帰で確認する。

---

## 3. path 解決の許可範囲

```
resolveEvidence(cli, ref.path):
  1. ref.path が絶対 path なら失敗
  2. ref.path が path 区切りで分解したとき ".." を含むなら失敗
  3. root = realpath(harness/fixtures/<cli>/raw)
  4. candidate = realpath(join(root, ref.path))
     - 存在しなければ失敗
  5. candidate が root + path 区切り で始まらなければ失敗（symlink 脱出の遮断）
  6. candidate を読む
```

- 3 と 4 の両方で realpath を取る。root 側を解決しないと、root 自体が symlink のときに
  5 の前方一致が常に失敗する
- 5 は「root で始まる」ではなく「root + 区切り で始まる」で判定する。
  `raw` と `raw-evil` のような兄弟ディレクトリを通さないため

---

## 4. 判定の流れ（assemble 側）

```
fixture ごと:
  evidence が無い  → この fixture の cell は real-cli-e2e にしない（source-test 止まり）
  evidence がある  → 各 ref について:
      normalizationVersion が harness の実装版と違う  → 失敗（fail closed）
      path 解決が拒否された                            → 失敗
      ファイルが読めない / 解釈できない                → 失敗
      再計算した digest が ref.evidenceHash と違う     → 失敗
    全 ref が一致したときだけ verified = true
```

- 「失敗」は組み立て全体の失敗。当該 cell だけ黙って `source-test` へ落として続行しない。
  落として続行すると、証拠の差し替えを忘れた状態が緑のまま残る（FR-005）
- 3 つの昇格箇所（`assemble.ts:280` / `:349` / `:383`）はすべて `verified` を見る。
  `Boolean(f.evidenceHash)` を見る経路を 1 つも残さない

---

## 5. 出力に載せる provenance（FR-014）と載せないもの（FR-015）

**載せる**

| 項目 | 出どころ |
|---|---|
| 証拠の所在 | `evidence[].path`（置き場からの相対 path。絶対 path ではない） |
| 正規化規則の版 | `evidence[].normalizationVersion` |
| digest | 再計算した値 |
| scenario の識別子 | 既存の `scenario` 欄と `fixtureId` |
| CLI の正確な版 | 既存の `nativeVersion` 欄 |

**載せない**

観測記録の本文、`prompt` の内容、モデルの出力、`cwd` / `transcript_path` などの絶対 path。
失敗時の説明も同じ制約に従い、「どの ref が」「どの理由で」までを出して中身は出さない。

digest 自体は正規化抜粋のハッシュであり、原文を復元できない。相対 path は
`claude-interrupt3.jsonl` のようなラベルで、実行環境の情報を含まない。

---

## 6. 先に決めた変異（実装が満たすべき kill 条件）

| # | 変異 | 落ちるべき test |
|---|---|---|
| M1 | 昇格条件を `Boolean(fixture.evidence)` へ戻す（再計算しない） | 実在しない path を指す 64 桁 hex fixture が棄却されること |
| M2 | digest 不一致を「失敗」から「`source-test` へ降格して続行」へ変える | 不一致 fixture で組み立てが失敗すること |
| M3 | `normalizationVersion` の照合を消す | 未知の版を申告した fixture で失敗すること |
| M4 | 3 箇所のうち 1 箇所だけ検査を外す（`:383` を素通しにする） | 3 経路それぞれの棄却 test |
| M5 | path 解決の `..` 検査を消す | `../../../etc/passwd` 形の ref が拒否されること |
| M6 | path 解決の realpath 前方一致を消す | 置き場内から外へ出る symlink が拒否されること |
| M7 | 正規化の verbatim キーから `prompt` を落とす | `claude-tool-denied` と `claude-tool-ok` の digest が異なること |
| M8 | 正規化で伏せ字にせず値を verbatim にする | 同一 scenario の再取得 `claude-interrupt3` / `claude-interrupt4` の digest が一致すること |
| M9 | 正規化でキーを落とす（値が伏せ字なら欄ごと省く） | 欄の有無だけが違う 2 記録の digest が異なること |
| M10 | 直列化のキー整列を消す | 同じ内容でキー順が違う 2 記録の digest が一致すること |
| M11 | array の長さを保持しない（空配列と 1 要素配列を同一視） | 長さだけが違う 2 記録の digest が異なること |
| M12 | 空ファイル・全行壊れの入力を成功にする | 空の観測記録で失敗すること |
| M13 | schema から `evidence` を消す（fixture だけ先に足した状態） | `unknown top-level key` で弾かれること |
| M14 | 失敗メッセージへ観測記録の中身や絶対 path を入れる | 失敗出力に禁止文字列が現れないこと |
