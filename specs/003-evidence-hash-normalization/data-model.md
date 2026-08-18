# Phase 1 Data Model: 証拠 digest による real-cli-e2e 昇格の裏付け

---

## 0. この digest が証明すること・しないこと（信頼境界）

先に境界を書く。ここを曖昧にしたまま「証拠に裏付けられた」と言うと、
`real-cli-e2e` の意味が実態より強く読まれる。

**証明する**

- 名指しされた観測記録が、fixture が申告した digest のとおりの内容であること
- その記録の event 列・欄の構成・識別子の等値関係（どの event が同じ session / turn /
  tool 呼び出しに属するか）が、申告時点から変わっていないこと
- 記録が隔離 rig の 1 回の run から出たものであること（§2.5 の manifest による）

**証明しない**

- 記録の**本文**（モデルの出力、tool の標準出力）が特定の内容だったこと。
  これらは伏せ字になるため digest には現れない
- したがって「textual outcome に依存する主張」（例: 注入した token が応答へ echo された、
  tool が特定の文言で失敗した）は digest だけでは裏付けられない。
  そうした cell は §4.3 の claim 導出で個別に裏付けるか、`real-cli-e2e` を名乗らない

---

## 1. 正規化の canonical 形（`normalizationVersion: 1`）

### 1.1 入力の読み取りと境界

- 入力は 1 件の観測記録ファイル。1 行 1 JSON の NDJSON
- 抽出範囲は **ファイル全体**。rig が scenario 1 件につき 1 ファイルを書くため、
  ファイル境界がそのまま scenario 境界になる
- **読み取りは既存の `harness/schema/jcs.ts` を再利用する**
  - byte 列 → 文字列は `decodeUtf8`。Node の既定 UTF-8 読み取りは不正 byte を U+FFFD へ
    黙って置換するため、そのままでは壊れた記録が「正常な記録」として digest を得る
  - 行の解釈は `parseIJson`。`JSON.parse` は重複 property を後勝ちで潰すため、
    `{"a":1,"a":2}` と `{"a":2}` が同じ digest になる。`parseIJson` は重複を拒否する
- 空行は読み飛ばす。空行以外で解釈できない行が 1 つでもあれば **失敗**
- 解釈できた行が 0 件なら **失敗**
- 各行は `event`（文字列）と `payload`（オブジェクト）を持たなければならない。欠ければ失敗
- **`payload.unparsed` を持つ行があれば失敗**。`harness/rig/capture-hook.sh:15` は hook の
  stdin を解釈できなかったとき `payload = {unparsed: raw}` に包む。これは「取れなかった観測」
  なので、正常な payload として digest に混ぜない
- 正規化の中間オブジェクトは `Object.create(null)` で作る。通常の `{}` へ `__proto__` を
  代入すると欄が消え、`__proto__` の有無が digest に現れなくなる

### 1.2 各行の変換

```
{ "event": <verbatim>, "payload": <正規化した payload> }
```

top-level の `at` は落とす（時刻）。`event` / `at` / `payload` 以外の top-level キーが
現れた場合は伏せ字側で処理して残す（未知の欄の出現自体を digest に反映するため）。

### 1.3 値の変換

値の扱いは **キー名と深さの組**で決まる。3 系統ある。

#### (a) verbatim — 位置を限定する

| 位置 | キー |
|---|---|
| top-level | `event` |
| `payload` の**直下** | `hook_event_name` / `tool_name` / `source` / `reason` / `permission_mode` / `agent_type` / `prompt` |

**それより深い階層に同じ名前が現れても verbatim にしない。** 実測で
`payload.tool_input.prompt`（2 件）と `payload.tool_response.prompt`（1 件）が存在し、
これは Agent tool へモデルが組み立てた引数とその echo にあたる。キー名だけで一致させると
`claude-subagent` の digest が再取得で不安定になる。

verbatim 値には `RIG_INJECT_[A-Za-z0-9_]+` → `RIG_INJECT_<marker>` の置換を適用する。

#### (b) 相関 token — 値は捨てるが等値関係は残す

`payload` 直下の次のキーは、値そのものは出さず**初出順の局所 token** へ置き換える。

| キー | token |
|---|---|
| `session_id` / `prompt_id` / `turn_id` / `tool_use_id` / `agent_id` | `<id:1>`, `<id:2>`, … |
| `transcript_path` / `agent_transcript_path` / `cwd` | `<path:1>`, `<path:2>`, … |

token 表は**ファイル単位**で、`id` と `path` で別の番号空間を持つ。同じ値が再び現れたら
同じ token を返す。

**この扱いが必要な理由**: すべて同じ `<string>` にすると等値関係が消える。
`stableNativeSessionId` は「session 識別子が run を通して同一か」という主張であり、
等値関係が消えると原理的に裏付けられなくなる（証拠を要求したのに、証拠から導けない cell が
生まれる）。token は値の中身を持たないので、絶対 path も識別子も漏れない。

#### (c) 伏せ字 — それ以外すべて

| 入力 | 出力 |
|---|---|
| `null` | `null` |
| boolean | そのまま（低エントロピーで安定。`interrupted` / `isImage` などの意味が残る） |
| number | `"<number>"` |
| string、空 | `"<string:empty>"` |
| string、その他 | `"<string>"` |
| array | 要素ごとに再帰。**長さを保持する** |
| object | キーを全保持し、キーごとに再帰 |

**配列の中と、`payload` 直下より深い階層は、(a) も (b) も適用しない。**
位置で verbatim を決める規則を深い階層へ広げると不安定になる。

### 1.4 直列化

- 各行を JSON へ直列化する。オブジェクトのキーは UTF-16 コードユニット昇順
- 区切りは詰める（`,` と `:` の後に空白を入れない）
- 非 ASCII はエスケープせず UTF-8 のまま出す
- 行区切りは LF。**最終行の後にも LF を 1 つ置く**
- 全体を UTF-8 の byte 列にし、その SHA-256 の小文字 hex が `evidenceHash`

### 1.5 版番号

- `normalizationVersion` は整数。現在の値は `1`
- §1.1〜§1.4 のいずれかを変えたら値を上げる
- harness は自分が実装している版と一致しない申告を **失敗**として扱う

---

## 2. schema と型の変更

### 2.1 `CaptureFixture` に足す欄

```ts
/**
 * この capture の根拠。`harness/fixtures/<cli>/raw/` からの相対 path で名指しする。
 * 複数 run を 1 つの fixture でまとめている場合があるため配列（最低 1 件）。
 */
evidence?: EvidenceRef[];

interface EvidenceRef {
  /** 証拠置き場からの相対 path。絶対 path と `..` は拒否 */
  path: string;
  /** 正規化抜粋の SHA-256（小文字 hex 64 桁） */
  evidenceHash: string;
  /** 生成に用いた正規化規則の版 */
  normalizationVersion: number;
  /** 同じ run の manifest（§2.5）。置き場からの相対 path */
  manifest: string;
  /** manifest の SHA-256 */
  manifestHash: string;
}
```

**単数欄にしない理由**: `claude/interrupt-and-hook-timeout` が 5 本の観測記録を根拠にしている。
単数欄だと 4 本が検査対象から外れ、この fixture の主張の中心である中断の証跡が裏取り無しで残る。

### 2.2 既存 `evidenceHash` 欄の扱い

`CaptureFixture` 直下の `evidenceHash?: string` は **廃止**する。本 issue が塞ぐ対象そのもの。
申告している fixture は 0 件なので、廃止で既存 fixture の書き換えは発生しない。

`CapabilityEvidence`（matrix 出力側）は §5 の形へ変える。

### 2.3 `capability.schema.json`

- `properties.evidence` を追加。`type: "array"`、**`minItems: 1`**、
  要素は `path` / `evidenceHash` / `normalizationVersion` / `manifest` / `manifestHash` を
  required とする object、`additionalProperties: false`
- `properties.evidenceHash`（top-level）を削除
- `required` には加えない。`official-doc` / `source-test` 由来の fixture は観測記録を持たない

**`minItems: 1` が要る理由**: 「全 ref が一致」を `every` で実装すると空配列は空虚真になり、
`evidence: []` を書くだけで観測記録を 1 件も読まずに昇格できる。schema と assemble の両方で
非空を検査する（片方だけだと、schema を通さない経路が残ったときに穴が開く）。

**`required` に入れない判断の理由**: 入れると `official-doc` 由来の fixture が書けなくなり、
`evidenceKind` の語彙 3 種のうち 2 種が到達不能になる。条件付きの要求（実 CLI 観測を
名乗るときだけ必要）は assemble 側の検査で表す。

### 2.4 `harness/fixtures/continuity/*.json`

別種の fixture（`cases` / `intakeContext` を持つ）で `capability.schema.json` の検証対象外。
schema 変更の影響を受けないことを回帰で確認する。

### 2.5 run manifest

digest はファイルの整合性しか証明しない。「これは実 CLI を隔離 rig で動かした記録だ」は
別に裏付けが要る。rig は既に材料を出している。

| 材料 | 現状 |
|---|---|
| CLI の exact version | `$RIG_BASE/capture/<cli>-<label>.version`（`rig.sh:76,88`） |
| recorder の失敗 | `<capture>.errors`（`capture-hook.sh:23`。**無い**ことが正常） |
| run の終了状態 | `<cli>-<label>.stderr` に `exit=N (recorded)` として記録 |
| 隔離設定 | `rig.sh` の `run_env`（`HOME` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` の差し替え） |

rig は run のたびに manifest を 1 件書き、証拠置き場へ observation と一緒に持ち込む。

```jsonc
{
  "manifestVersion": 1,
  "cli": "claude",
  "cliVersion": "2.1.228 (Claude Code)",   // .version の中身
  "scenario": "claude/lifecycle-basic",     // scenario 識別子
  "isolated": true,                          // rig が自分で書く。fixture の自己申告ではない
  "internalRunMarker": true,
  "exitStatus": 0,
  "recorderErrors": 0,                       // .errors が無い / 空なら 0
  "capture": "claude-lifecycle-basic.jsonl",
  "captureHash": "<正規化抜粋の SHA-256>",
  "normalizationVersion": 1
}
```

assemble は manifest の digest を照合し、`isolated !== true`、`recorderErrors > 0`、
`captureHash` が observation の再計算値と食い違う、のいずれでも **失敗**させる。
`nativeVersion` は fixture の自己申告と manifest の `cliVersion` の一致も要求する。

**scope の限界**: manifest は rig が書くので、rig を動かす人を信頼する境界は残る。
これは repository の checkout を信頼するのと同じ水準で、`real-cli-e2e` の定義に
「隔離 rig の運用者を信頼する」ことを明記して閉じる。

---

## 3. path 解決の許可範囲

```
resolveEvidencePath(cli, relPath):
  1. cli が既知の値（"claude" / "codex"）でなければ失敗
  2. relPath が絶対 path なら失敗
  3. relPath を path 区切りで分解して ".." を含むなら失敗
  4. root = realpath(harness/fixtures/<cli>/raw)
  5. candidate = realpath(join(root, relPath))  — 存在しなければ失敗
  6. candidate が root + 区切り で始まらなければ失敗（symlink 脱出の遮断）
  7. candidate が通常ファイルでなければ失敗（lstat で判定）
  8. candidate を読む
```

- 4 と 5 の両方で realpath を取る。root 側を解決しないと、root 自体が symlink のときに
  6 の前方一致が常に失敗する
- 6 は「root で始まる」ではなく「root + 区切り で始まる」で判定する。
  `raw` と `raw-evil` のような兄弟ディレクトリを通さないため
- **失敗はすべて安全な理由コードへ変換する。** `realpath` / `open` / `stat` の例外を
  そのまま伝播させると repository の絶対 path が診断へ出る

**残る境界**: hard link は置き場内の通常ファイルとして通る。検査から読み取りまでの間に
ディレクトリを差し替える TOCTOU も残る。どちらも「checkout を書き換えられる相手」を
前提とするので、checkout を信頼済みとする境界の内側に置く。境界は §0 に明記する。

---

## 4. 判定の流れ（assemble 側）

### 4.1 fixture ごと

```
evidence が無い          → この fixture の cell は real-cli-e2e にしない（source-test 止まり）
evidence が空配列        → 失敗（空虚真の遮断）
evidence がある          → 各 ref について:
    normalizationVersion が harness の実装版と違う  → 失敗
    path 解決が拒否された                            → 失敗
    ファイルが読めない / 解釈できない                → 失敗
    再計算した digest が ref.evidenceHash と違う     → 失敗
    manifest の digest が ref.manifestHash と違う    → 失敗
    manifest.isolated !== true                       → 失敗
    manifest.recorderErrors > 0                      → 失敗
    manifest.captureHash が再計算値と違う            → 失敗
    manifest.cliVersion が fixture.nativeVersion と違う → 失敗
  全 ref が通ったとき verified = true
```

「失敗」は組み立て全体の失敗。当該 cell だけ黙って `source-test` へ落として続行しない。
落として続行すると、証拠の差し替えを忘れた状態が緑のまま残る。

### 4.2 昇格箇所

`assemble.ts:280`（capture cell）、`:349`（highLevel cell）、`:383`（prompt 対の再刻印）の
3 箇所すべてが `verified` を見る。`Boolean(f.evidenceHash)` を見る経路を 1 つも残さない。

**prompt 対の同一 run 拘束**: `:383` は「1 つの実測が対を同時に証明した」ことを要求する。
1 つの fixture が複数 run を束ねられるようになった以上、fixture が同じことは同一 run の
証明にならない。**両 cell が同じ `EvidenceRef`（同じ path・同じ digest）から導かれたときだけ**
対を成立させる。

### 4.3 claim と観測記録の結び付け

digest 一致は「記録が改竄されていない」ことしか言わない。正しい記録と digest を流用して、
fixture へ根拠のない cell 主張を書き足す経路が残る。

**この版で入れる検査（機械的に導ける範囲）**

- `observedEvents[].sourceEvents` に挙げた hook 名が、参照している観測記録のいずれかに
  `event` として実在すること。実在しない主張は失敗
- `toolFailurePhasesObserved` に `executed` 等を挙げるなら、対応する `PostToolUse` が
  観測記録に実在すること
- `highLevel` の各 cell についても、その cell が根拠とする hook 名が実在すること

**この版で入れない検査（残る穴として明記する）**

観測記録の**本文**に依存する主張（注入 token の echo、tool 出力の内容、
`assistant_completed` の復元可否）は、§0 のとおり digest に現れないので導けない。
これらは正しい記録を持っていれば主張の値を書き換えられる。
**cell ごとの claim 述語**を定義して raw から値そのものを導く設計が本来の解で、
本 issue の範囲を超える。別 issue へ切り出し、`real-cli-e2e` の定義に
「event 構造と識別子相関までを裏付ける」と書いて意味を実態へ合わせる。

---

## 5. 出力の provenance

### 5.1 `CapabilityEvidence` の形

複数 ref を持つ fixture が cell の根拠になるため、単数の `evidenceHash` では表せない。

```ts
interface CapabilityEvidence {
  // ... 既存の欄 ...
  /** matrix 直下の evidenceSources への添字。cell がどの記録に裏付けられたか */
  evidenceRefs?: number[];
}
```

matrix 直下に表を 1 つ置き、cell からは添字で参照する。

```ts
/** fixtureId + path の昇順で一意化した配列。cell からは添字で参照する */
evidenceSources: Array<{
  fixtureId: string;
  path: string;              // 置き場からの相対 path。絶対 path は入らない
  evidenceHash: string;
  normalizationVersion: number;
  manifestHash: string;
  cliVersion: string;
  scenario: string;
}>;
```

これで SC-006（どの記録を・どの版で・どの digest で・どの CLI 版で判定したかを成果物だけで追える）
が複数 ref でも成り立つ。並びは `fixtureId` → `path` の昇順で一意に決める。

### 5.2 `capabilityHashInputs`

現在は `fixture:<id>@<evidenceHash>` を並べている（`assemble.ts:414`）。
欄が配列になるので入力の形も変える。

```
`fixture:<fixtureId>@<evidenceSources のうちこの fixture 由来のものの digest を昇順で連結>`
```

`assemble.ts` のコメントが「§13 の manifest hash はまだ無い（Task 5 で入る）。入る場所は
この配列」と書いているとおり、manifest hash もここへ入れる。
入力の列挙は欄を数え上げるのではなく畳んだ結果から導く（既存の `folded` の扱いを踏襲）。

**`harness/contract-hashes.json` の再生成が必要になる。** `capability.schema.json` と
fixture がその入力で、CI が `node harness/contract-hashes.mjs` の出力との差分を見ている
（`.github/workflows/ci.yml:151-152`）。再生成を実装順序へ入れる。

### 5.3 秘密を出さない（FR-015）

**現状は既に破れている。** `harness/matrix/{claude,codex}.json` に `RIG_INJECT_5f3a9` が
そのまま載っている。fixture の `limitations` 自由文が matrix へ逐語転記されるため、
normalizer を伏せ字にしても直らない。

対処:

- backfill の際に 8 fixture の `limitations` から、実値・token・識別子・絶対 path を取り除く
- 観測記録 16 件から `prompt` / `last_assistant_message` / `cwd` / `transcript_path` /
  入れ子の `tool_input` `tool_response` の値を抽出し、matrix・stdout・stderr・CI log に
  完全一致が無いことを機械検査する
- 成果物へ出す path は置き場からの相対 path のみ（`claude-interrupt3.jsonl` のようなラベル）

---

## 6. 先に決めた変異（実装が満たすべき kill 条件）

| # | 変異 | 落ちるべき test |
|---|---|---|
| M0 | `improvesEvidence`（`assemble.ts:252`）を廃止した欄のまま残す | 証跡の優劣で cell が入れ替わる経路。廃止欄を読むと常に false になり優劣が黙って消える |
| M1 | 昇格条件を `Boolean(fixture.evidence)` へ戻す（再計算しない） | 実在しない path を指す fixture が棄却されること |
| M2 | digest 不一致を「失敗」から「降格して続行」へ変える | 不一致 fixture で組み立てが失敗すること |
| M3 | `normalizationVersion` の照合を消す | 未知の版を申告した fixture で失敗すること |
| M4 | 3 箇所のうち 1 箇所だけ検査を外す（`:383` を素通し） | 3 経路それぞれの棄却 test |
| M5 | path 解決の `..` 検査を消す | `../../../etc/passwd` 形の ref が拒否されること |
| M6 | path 解決の realpath 前方一致を消す | 置き場内から外へ出る symlink が拒否されること |
| M7 | verbatim キーから `prompt` を落とす | `claude-tool-denied` と `claude-tool-ok` の digest が異なること |
| M8 | 伏せ字をやめて値を verbatim にする | 再取得 `claude-interrupt3` / `claude-interrupt4` の digest が一致すること |
| M8b | verbatim 判定を深さ無視のキー名一致へ変える | `payload.tool_input.prompt` だけが違う 2 記録の digest が一致すること |
| M9 | 正規化でキーを落とす（値が伏せ字なら欄ごと省く） | 欄の有無だけが違う 2 記録の digest が異なること |
| M10 | 直列化のキー整列を消す | 内容が同じでキー順が違う 2 記録の digest が一致すること |
| M11 | array の長さを保持しない | 長さだけが違う 2 記録の digest が異なること |
| M12 | 空ファイル・全行壊れを成功にする | 空の観測記録で失敗すること |
| M13 | schema から `evidence` を消す（fixture だけ先に足した状態） | `unknown top-level key` で弾かれること |
| M14 | 失敗メッセージへ観測記録の中身や絶対 path を入れる | 失敗出力に禁止文字列が現れないこと |
| **M15** | schema の `minItems: 1` と assemble の非空検査を外す | `evidence: []` の fixture が棄却されること |
| **M16** | 相関 token をやめて `<string>` へ戻す | 同じ `session_id` が継続する記録と途中で変わる記録の digest が異なること |
| **M17** | 相関 token をファイル単位でなく全体で共有する | 別ファイル間で token 番号が影響し合わないこと |
| **M18** | `sourceEvents` の実在検査を消す | 正しい raw と digest のまま、実在しない hook を根拠に挙げた fixture が棄却されること |
| **M19** | prompt 対の同一 run 拘束を「同一 fixture」へ緩める | 2 つの別 run を束ねた fixture で対が成立しないこと |
| **M20** | manifest の照合（`isolated` / `recorderErrors` / `captureHash` / `cliVersion`）を外す | 隔離外・recorder 失敗・version 不一致の manifest が棄却されること |
| **M21** | `parseIJson` を `JSON.parse` へ、`decodeUtf8` を既定読み取りへ戻す | 重複キー・不正 UTF-8 の記録が棄却されること |
| **M22** | `payload.unparsed` を持つ行を正常扱いにする | 取れなかった観測を含む記録が棄却されること |
| **M23** | 正規化の中間オブジェクトを `{}` にする | `__proto__` 欄の有無が digest に現れること |
| **M24** | fixture の `limitations` を無害化せずに backfill する | matrix・stdout・stderr に raw の実値が現れないこと |
| **M25** | `contract-hashes.json` を再生成しない | CI の contract hash 差分検査が落ちること |
