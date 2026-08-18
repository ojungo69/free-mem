# Implementation Plan: 証拠 digest による real-cli-e2e 昇格の裏付け

**Branch**: `feat/evidence-hash-normalization` | **Date**: 2026-08-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-evidence-hash-normalization/spec.md`（GitHub issue #20 / p0）

## Summary

`harness/assemble.ts` は 3 箇所で `Boolean(fixture.evidenceHash)` だけを見て `real-cli-e2e` を刻む。
64 桁 hex を書けば最高位の証拠強度を名乗れる。これを「fixture が名指しした観測記録から
正規化抜粋の SHA-256 を再計算し、一致したときにだけ刻む」へ変える。

正規化規則は committed 済みの観測記録 16 件で実測して決めた（research.md R1/R2）。
値は既定で伏せ字にし、キーは必ず残す。verbatim にするのは実測で安定と確認できた 8 キーのみ。
これにより「同一 scenario の再取得で同じ digest」と「未知の欄の中身が成果物へ漏れない」を
同時に満たす。

移行では 8 fixture すべてに証拠配列と digest を埋め、21 cell が `source-test` から
`real-cli-e2e` へ昇格する。降格は 1 件も発生しない。

## Technical Context

**Language/Version**: TypeScript / Node.js 24.16.0（`harness/` 既存構成）

**Primary Dependencies**: 追加なし。`node:crypto` の `createHash("sha256")`、`node:fs`、`node:path` のみ

**Storage**: ファイル。観測記録は `harness/fixtures/<cli>/raw/*.jsonl`、成果物は `harness/matrix/*.json`

**Testing**: `node --test`（既存の `harness/**/*.test.mjs` / `assemble.ts` 内の自己 assert と同じ形）

**Target Platform**: Linux（WSL2）。CI は `ubuntu-24.04`

**Project Type**: 単一 repo 内の検証 harness

**Performance Goals**: 観測記録 16 件の合計が 40KB 未満。組み立て時間への影響は無視できる範囲

**Constraints**:
- 凍結済み語彙 `official-doc` / `source-test` / `real-cli-e2e` を変えない
- `harness/assemble.ts:147` の未知キー拒否があるため schema・型・fixture は同一 commit で動かす
- 成果物・診断出力・CI ログへ観測記録の本文・投入指示・モデル出力・絶対 path を出さない

**Scale/Scope**: 観測記録 16 件、capture fixture 8 件、matrix cell 38 件（Claude 19 / Codex 19）

## Constitution Check

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. ローカルファースト | 通過 | 追加の外部通信なし |
| II. ゼロ増分コスト | 通過 | 依存追加なし。標準ライブラリのみ |
| III. プライバシー境界（NON-NEGOTIABLE） | 通過。**ただし実装者の指定あり** | 正規化は既定で伏せ字にし、verbatim 8 キー以外を digest にも出力にも出さない。本件は完全性 digest・path traversal 拒否・入力検証を含むため「セキュリティ関連コードは外部 CLI へ委譲せず Claude Code が直接実装する（MUST）」に該当する。issue #20 の実装順序は task 2 を Codex CLI へ割り当てているが、**この点は逸脱して Claude Code が実装する** |
| IV. 安全境界（fail-closed） | 通過 | 観測記録の不在・読み取り失敗・digest 不一致・未知の版のすべてで組み立てを失敗させる。降格して続行しない |
| V. 決定論的ゲート | 通過 | 判定は SHA-256 の一致という機械比較のみ。LLM 判定を含まない |
| VI. ローカル完結（push / PR 禁止） | **食い違いあり。本 plan では解消しない** | 本 repo は現在 GitHub 上で PR 運用しており、原則 VI と食い違う。その解消は issue #74 の担当で、本 feature の範囲外 |

Phase 1 設計後の再評価: 変更なし。設計で新たな外部送信・新規依存・非決定的判定は増えていない。

## Project Structure

### Documentation (this feature)

```text
specs/003-evidence-hash-normalization/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── evidence-normalizer.md
├── checklists/
│   └── requirements.md
└── tasks.md              # /speckit-tasks が生成する
```

### Source Code (repository root)

```text
harness/
├── evidence/
│   ├── normalize.ts            # 新規: 正規化 + digest + path 解決。module 兼 CLI
│   └── normalize.test.ts       # 新規: 正規化と path 解決の test
├── assemble.ts                 # 変更: 3 箇所の昇格判定を再計算の一致へ
├── schema/
│   ├── capability.ts           # 変更: evidence[] 追加 / top-level evidenceHash 廃止
│   └── capability.schema.json  # 変更: 同上
├── fixtures/
│   ├── claude/*.json           # 変更: evidence[] を埋める（5 件）
│   ├── codex/*.json            # 変更: evidence[] を埋める（3 件）
│   ├── claude/raw/*.jsonl      # 変更なし（証拠置き場）
│   └── codex/raw/*.jsonl       # 変更なし
├── matrix/
│   ├── claude.json             # 再生成
│   ├── codex.json              # 再生成
│   └── README.md               # 変更: evidenceKind の記述を実態へ
├── contract-hashes.json        # 再生成（CI が差分を見ている）
└── rig/
    └── rig.sh                  # 変更: manifest を書き、置き場へ持ち込み、digest を出す
```

**Structure Decision**: 新規コードは `harness/evidence/` に 1 モジュールだけ置く。
`harness/` 直下は既に平坦で用途が混在しているため、証拠まわりを 1 ディレクトリへ寄せる。

**拡張子は `.ts`。`.mjs` にしない。** `harness/tsconfig.json` は `include: ["**/*.ts"]` で
`allowJs` も `checkJs` も無い。`.mjs` を `assemble.ts` から import すると module の API が
implicit any になり、セキュリティ境界の型検査が消える。`rig.sh` からは
`node --experimental-strip-types harness/evidence/normalize.ts` で起動する
（`harness/matrix/README.md` が assemble に対して既に使っている形と同じ）。
`erasableSyntaxOnly` と `verbatimModuleSyntax` が有効なので、enum や実行時に効く
装飾構文は使わない。

## 実装順序

issue #20 の H0〜H3 を、この repo での作業単位へ落としたもの。

| 段 | 内容 | 対応 | 完了条件 |
|---|---|---|---|
| 1 | 正規化規則の凍結（H0） | spec.md / research.md / data-model.md / contracts | 実測に基づく規則が文書として確定している（**本 plan の時点で完了**） |
| 2 | normalizer の実装（H0/H1） | `harness/evidence/normalize.mjs` + test | data-model.md §6 の M5〜M12 が kill される |
| 3 | schema と型（H1） | `capability.ts` / `capability.schema.json` | M13 が kill される。continuity fixture が壊れない |
| 4 | 昇格判定と欄の退役（H2） | `assemble.ts` ほか。下の「`evidenceHash` の全参照」を全件処理 | M0〜M4 が kill される。`grep -rn evidenceHash harness/` の残りが意図した形だけになる |
| 5 | 移行 backfill（H2） | fixture 8 件 + matrix 再生成 | 21 cell が昇格し、降格 0 件 |
| 6 | rig の manifest と持ち込み（H2/H3） | `rig.sh` + manifest 形式 | manifest が書かれ、capture と一緒に置き場へ byte 同一で入る。M20 が kill される |
| 7 | provenance と退役（H3） | `matrix/README.md` ほか research.md R6 の 5 箇所、`contract-hashes.json` 再生成 | 古い記述が残っていない。M14 / M24 / M25 が kill される |

段 2〜4 は先に失敗する test を書いてから実装する。段 5 は段 4 が通ってからでないと
「昇格した」ことを確認できない。段 5 の backfill には fixture の `limitations` の無害化を含める
（現在 `harness/matrix/{claude,codex}.json` に `RIG_INJECT_5f3a9` がそのまま載っており、
normalizer を直すだけでは消えない）。

各段の完了判定に使う実コマンド（`npm run` script は存在しない）:

```bash
node --experimental-strip-types --test harness/evidence/normalize.test.ts
npx tsc -p harness/tsconfig.json                    # strict 型検査
node harness/contract-hashes.mjs > /tmp/ch.json && diff harness/contract-hashes.json /tmp/ch.json
```

matrix の生成コマンドは `harness/matrix/README.md` の記載に従う。

## 主要な設計判断

### 共有 normalizer は 1 本、CLI としても動く

取得側は shell、検証側は TypeScript。shell から TS の関数を呼ぶ手段が無いため、
同じファイルを `import` と `node <file>` の両方から使う。二重実装は必ず drift する。

### digest が証明しないことを先に書く

SHA-256 の一致は「記録が申告どおりの内容である」ことしか言わない。
「実 CLI を隔離 rig で動かした記録である」は rig が書く manifest で裏付ける
（rig は既に `.version` と `.errors` を出しているので材料はある）。
「モデルが特定の文言を返した」は伏せ字になるので digest では裏付けられない。
この 3 つの区別を data-model.md §0 に信頼境界として明記し、
`real-cli-e2e` の意味を実態へ合わせる。

### 識別子は捨てずに局所 token へ置き換える

すべて `<string>` にすると等値関係が消え、`stableNativeSessionId`（session 識別子が
run を通して同一か）が原理的に裏付けられなくなる。証拠を要求したのに証拠から導けない
cell が生まれるのは設計の誤り。`session_id` などはファイル単位の初出順 token
（`<id:1>`）へ置き換え、値は出さずに等値関係だけ残す。16 件で測り直した結果、
distinct 14 種・衝突 2 組は変わらない。

### 昇格箇所は 3 つあり、3 つとも塞ぐ

`assemble.ts:280`（capture cell）、`:349`（highLevel cell）、`:383`（prompt 対の再刻印）。
`:383` は `pairFixture` の抽出条件が `f.evidenceHash` を見ているので、
そこも `verified` を見る形へ変える。1 箇所でも残すと別識別子で同じ欠陥が生き残る。

### `evidenceHash` の全参照を棚卸ししてから変える

top-level の `fixture.evidenceHash` を廃止する以上、**それを読んでいる箇所すべて**が対象になる。
昇格の 3 箇所だけを直すと、残りは廃止された欄を読み続けて黙って `undefined` になる。
`grep -rn evidenceHash harness/` の 95 件は次の内訳（`matrix/*.json` の 44 件は再生成される出力）。

| 箇所 | 現在の役割 | 扱い |
|---|---|---|
| `assemble.ts:125` | schema キーの正規表現検証ループに `evidenceHash` を含む | `evidence[]` の検証へ置き換える |
| `assemble.ts:252` `improvesEvidence` | 同値の cell を「hash 付きの観測」で上書きしてよいかの判定 | `verified` を見る形へ。**廃止した欄を読むと常に false になり、証跡の優劣が黙って消える**（M0） |
| `assemble.ts:275` / `:344` `hashed` | 昇格判定 | `verified` へ |
| `assemble.ts:285-286` / `:354` / `:389` | `no evidenceHash:` caveat の付与と除去 | 文言を「再計算で裏付けられていない」意味へ改める |
| `assemble.ts:288` / `:357` / `:386` | 出力 cell の `evidenceHash` 欄への書き込み | 再計算した digest を書く |
| `assemble.ts:338` | highLevel の同値 tie-break スコアに `evidenceHash ? 1 : 0` | `verified ? 1 : 0` へ |
| `assemble.ts:367` `pairFixture` | prompt 対を証明した fixture の抽出条件 | `verified` へ |
| `assemble.ts:414` | **capability hash の入力**に `fixture:<id>@<evidenceHash>` を含む | 入力の形が変わる。hash は再生成が要る（`fixture-change-needs-hash-regen`）。入力の列挙が構造から導かれているかも合わせて確認する |
| `assemble.ts:535` / `:588-758` | ファイル内の自己 test。`"a".repeat(64)` 等の作り物 hash で昇格を確認している | **意味を反転させる**。作り物 hash では昇格しないことを確認する形へ書き換える。コンパイルが通るだけの機械的置換にしない |
| `continuity/fixture-validation.test.ts`（7 件） | fixture 検証の test | 同上 |
| `continuity/capability-contract.test.ts`（5 件） | contract の test | 同上 |
| `schema/capability.ts`（3 件） | 型定義とコメント | 型は `evidence[]` へ。コメント「raw transcript の SHA-256」は owner が不採用とした案なので書き換える |
| `schema/capability.schema.json`（1 件） | top-level `evidenceHash` の定義 | 削除し `evidence` を追加 |

test 群は「hash があれば `real-cli-e2e`」という**現在の仕様を encode している**。
コンパイルを通すだけの置換では、古い仕様を守る test が残る。

### 空配列を空虚真にしない

「全 ref が一致」を `every` で実装すると `evidence: []` が真になり、観測記録を 1 件も
読まずに昇格できる。schema の `minItems: 1` と assemble 側の非空検査の両方を置く。
片方だけだと、schema を通さない経路が増えたときに穴が開く。

### 証拠参照は配列

`claude/interrupt-and-hook-timeout` が 5 本の観測記録を根拠にしている。
単数欄だと 4 本が検査対象から外れ、この fixture の主張の中心である中断の証跡が裏取り無しで残る。

### `evidence` を schema の `required` に入れない

入れると `official-doc` 由来の fixture が書けなくなり、語彙 3 種のうち 2 種が到達不能になる。
条件付きの要求（実 CLI 観測を名乗るときだけ必要）は assemble 側の検査で表す。

### rig は置き場へ持ち込んでから digest を出す

rig は `$RIG_BASE/capture/` へ書く（repo の外）。置き場 `harness/fixtures/<cli>/raw/` へ
byte 同一で持ち込み、**持ち込んだ後のファイル**に対して digest を出す。
持ち込み前に出すと、持ち込みで内容が変わっても気づけない。

### 既定は伏せ字、verbatim は 8 キーだけ

denylist（揮発キーを落として残りは verbatim）にすると、CLI が将来追加する未知の欄が
既定で verbatim になり、絶対 path や会話内容が digest 経由で成果物へ出る。
constitution III を既定で破る向きなので採らない。

## test の設計

両方向を書く。片方向だけの test は偽陽性を仕様として守ってしまう。

| 向き | 内容 |
|---|---|
| 攻撃側 | 形式は正しい 64 桁 hex + 実在しない path / 別物の path / 未知の版 → いずれも棄却。`..`・絶対 path・脱出 symlink → 拒否 |
| 通過側 | 許容した環境差だけが違う再取得（`claude-interrupt3` / `claude-interrupt4`）→ 同じ digest で昇格が成功する |
| 過剰正規化側 | substantive に違う 2 記録（`claude-tool-denied` / `claude-tool-ok`）→ digest が異なる。識別子の相関だけが違う 2 記録 → digest が異なる |
| 主張の捏造 | 正しい raw と digest のまま、実在しない hook を `sourceEvents` に挙げた fixture → 棄却 |
| 空虚真 | `evidence: []` → 棄却 |
| 入力の頑健性 | 重複キー・不正 UTF-8・`payload.unparsed`・`__proto__` → 棄却 |
| 秘密 | matrix・stdout・stderr に raw の実値（`RIG_INJECT_5f3a9` 等）が現れない |
| 方向拘束 | fixture だけ先に `evidence` を足した状態 → schema の未知キー拒否で落ちる |

変異と kill 対応表は data-model.md §6（M1〜M14）。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| constitution VI（push / PR 禁止）との食い違い | 本 repo は既に GitHub で PR 運用しており、本 feature だけ運用を変えられない | 原則側の改訂は issue #74 が扱う。本 feature で先に決めると、未決事項を別 issue へ分離した意味が消える |
| issue #20 の実装順序（task 2 を Codex CLI へ）からの逸脱 | 完全性 digest・path traversal 拒否・入力検証はセキュリティ関連にあたり、constitution III が外部 CLI への委譲を禁じている（MUST） | 委譲して事後レビューする案は、原則が「委譲しない」と書いている以上、レビューの有無で置き換えられない |
| cell ごとの claim 述語を実装しない | 正しい観測記録と digest を持っていれば、本文に依存する cell 主張（注入 token の echo、tool 出力の内容）は書き換えられる。これを塞ぐには cell ごとに raw から値を導く述語が要り、本 issue の範囲を大きく超える | 「範囲を超えるから無視する」は採らない。data-model.md §0 と §4.3 に残る穴として明記し、`real-cli-e2e` の定義を「event 構造と識別子相関までを裏付ける」へ合わせ、別 issue へ切り出す |
| rig 運用者への信頼が残る | manifest は rig が書くため、rig を動かす人を信頼する境界が残る | 署名や外部 attestation はローカル完結（constitution I / VI）と釣り合わない。checkout を信頼するのと同じ水準として §0 に明記する |
