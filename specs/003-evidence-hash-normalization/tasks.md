---
description: "Task list for 003-evidence-hash-normalization"
---

# Tasks: 証拠 digest による real-cli-e2e 昇格の裏付け

**Input**: `specs/003-evidence-hash-normalization/`（spec.md / plan.md / research.md / data-model.md / contracts/evidence-normalizer.md）

**Prerequisites**: plan.md（実装順序 7 段）、data-model.md §6（変異 M0〜M49 + M8b）

**Branch**: `feat/evidence-hash-normalization` / **Worktree**: `/home/jura/projects/free-mem-wt/evidence-hash`

## 実装者

**Claude Code が実装する。外部 CLI（Codex / Grok）へ委譲しない。** 本 feature は完全性 digest・
path traversal の拒否・入力検証を含むためセキュリティ関連にあたり、constitution III と
CLAUDE.md の「セキュリティ関連コードは委譲せず Claude Code が実装」に該当する。
issue #20 の実装順序は task 2 を Codex CLI へ割り当てているが、この点は意図的に逸脱する
（plan.md の Complexity Tracking に記録済み）。

レビュー・調査・検証のステージは実装ではないので、この制約の対象外。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行可（別ファイル・未完了タスクへの依存なし）
- **[Story]**: US1 = 証拠のない昇格を止める（P1） / US2 = 再取得しても同じ digest（P2） / US3 = 出所を追え秘密は漏れない（P3）

## Path Conventions

すべて repository root からの相対 path。実装は `harness/` 配下のみ。

## 段と phase の対応

| plan.md の段 | phase | 主な成果物 |
|---|---|---|
| 1. 正規化規則の凍結（H0） | — | **完了済み**（spec / research / data-model / contracts） |
| 2. normalizer の実装 | Phase 2 | `harness/evidence/normalize.ts` + test |
| 3. schema と型 | Phase 2 | `capability.ts` / `capability.schema.json` / `evidence-manifest.schema.json` |
| 4. 昇格判定と欄の退役 | Phase 3（US1） | `assemble.ts` の 3 経路 |
| 5. 移行 backfill | Phase 5（US3）+ Phase 3 | fixture 8 件 + matrix 再生成 |
| 6. rig の manifest と持ち込み | Phase 6（US1） | `rig.sh` + manifest |
| 7. provenance と退役 | Phase 7 | `matrix/README.md` ほか + contract hash |

---

## Phase 1: Setup（主張を実行して確かめる）

**Purpose**: 計画中に 2 度間違えた「実行すれば数秒で分かる事実」を、コードを書く前に実行で確定させる。
この phase の 3 件は**書く前に走らせる**。結果が計画と食い違ったら計画側を直してから進む。

- [X] T001 起草した schema 片が `harness/schema/validate.ts` の `SUPPORTED_KEYWORDS` だけで書けているかを実行で確かめる。`capability.schema.json` の `evidence` 定義（`allOf` + 2 つの `if`/`then`）と新規 `harness/schema/evidence-manifest.schema.json` の草案を一時ファイルへ書き、`validateAgainstSchema` へ通して `unsupported schema keyword` が出ないことを確認する。`dependentRequired` / `maxProperties` / `not` は使えない（`harness/schema/validate.ts:327` が throw する）
- [X] T002 [P] `observedEvents[].sourceEvents[]` の enum 値を手で並べず、`jq` で `harness/fixtures/{claude,codex}/*.json` と `harness/fixtures/{claude,codex}/raw/*.jsonl` から機械的に導く。導いた集合を T009 の schema へそのまま入れる（手で並べたとき、raw に 1 件も無い `PreCompact` を書いていた）
- [X] T003 [P] `limitationCodes` の enum を、現行の散文 `limitations`（fixture 8 件の top-level と `observedEvents[]`）から機械的に列挙して 1 対 1 の対応表を作る。対応表は `specs/003-evidence-hash-normalization/limitation-codes.md` へ置き、T009 で `capability.schema.json` へ凍結する
- [X] T004 [P] 変更前の baseline を計測して `specs/003-evidence-hash-normalization/baseline.md` へ記録する。(a) `harness/matrix/{claude,codex}.json` の `evidenceKind` 内訳、(b) 成果物に現れる raw 由来の実値（`RIG_INJECT_5f3a9` 等）のヒット件数、(c) raw 16 件の digest 分布。SC-005 / SC-008 は変更後にこれと突き合わせて判定する

**完了条件**: T001 が「使う keyword はすべて対応済み」を実行で示している。T002 / T003 の集合が実データ由来である

**Phase 1 の実測結果**:

- T001: 起草した `evidence` 定義（`allOf` + 2 つの `if`/`then`）と manifest schema を
  `validateAgainstSchema` へ通し、10 ケースすべてが期待どおり（`unsupported schema keyword` の
  throw なし。`manifest` 片方だけ・空配列・未知の欄・絶対 path・負の `recorderErrors`・
  `cliVersion` の改行がすべて棄却された）
- T002: raw に現れる event は 7 種（`PostToolUse` / `PreToolUse` / `SessionEnd` / `SessionStart` /
  `Stop` / `SubagentStop` / `UserPromptSubmit`）。fixture の `sourceEvents` はこのうち 6 種。
  **`PreCompact` は 1 件も無い**（手で並べたときは書いていた）
- T003: 散文 27 件（top-level 11 / event ごと 16）へ 22 種のコードを割り当て、
  `limitation-codes.md` へ出力した
- T004: `baseline.md` へ記録。`real-cli-e2e` の cell は **0 件**（claude 12 / codex 9 がすべて
  `source-test`）。秘密の出現は matrix に 3 件。raw 16 件の生 byte SHA-256 も取ってある
  （backfill の `captureRawHash` はこれを使う）

---

## Phase 2: Foundational（段 2・段 3 — すべての story の前提）

**Purpose**: 正規化と digest の唯一の実装と、それを載せる schema・型。ここが無いと US1 も US2 も始まらない

**⚠️ この phase が終わるまで user story の実装に入らない**

### 段 2: normalizer（`harness/evidence/normalize.ts`）

- [X] T005 先に落ちる test を書く。`harness/evidence/normalize.test.ts` を新規作成し、data-model.md §1 の canonical 形に対する assertion を並べる（この時点では module が無いので全件落ちる）
- [X] T006 `harness/evidence/normalize.ts` を新規作成し、`NORMALIZATION_VERSION` / `normalizeCapture(bytes)` / `digestCapture(bytes)` / `digestRaw(bytes)` を実装する。読み取りは `harness/schema/jcs.ts` の `decodeUtf8` + `parseIJson` を再利用する（`readFileSync(..., "utf8")` + `JSON.parse` を書かない）。中間 object は `Object.create(null)` で作る
- [X] T007 `harness/evidence/normalize.ts` に `resolveEvidencePath(cli, relPath, root?)` を実装する。data-model.md §3 の 8 段（`cli` の既知値確認 → 絶対 path 拒否 → `..` 拒否 → root の realpath → candidate の realpath → root + 区切りの前方一致 → 通常ファイル判定 → 読み取り）をこの順で置く。`root` は test 専用の差し替え口で、production 経路は必ず省略する。例外は安全な理由コードへ変換し、絶対 path を伝播させない
- [X] T008 `harness/evidence/normalize.ts` に CLI 表面を足す（`node --experimental-strip-types harness/evidence/normalize.ts <capture-file>` が `{"evidenceHash","captureRawHash","normalizationVersion"}` を 1 行、`--raw <file>` が `{"rawHash"}` を 1 行）。失敗は終了コード 2 で、行番号までは出すが行の中身と絶対 path は出さない

### 段 3: schema と型

- [X] T009 `harness/schema/capability.schema.json` を更新する。`evidence`（`minItems: 1`・`additionalProperties: false`・T001 で確かめた `allOf` + `if`/`then` の manifest 対）、`scenarioId`（`pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$"`・`required`）、`limitationCodes`（T003 の closed enum）を追加し、top-level `evidenceHash` を削除する。既存の無制約 string にも制約を掛ける（`fixtureId` の pattern、`sourceEvents[]` を T002 の enum、`nativeVersion` に `^[\x20-\x7e]+$`）
- [X] T010 `harness/schema/evidence-manifest.schema.json` を新規作成する。data-model.md §2.5 の 12 欄を `additionalProperties: false` の closed schema にし、`exitStatus` / `recorderErrors` を非負整数に閉じる
- [X] T011 `harness/schema/capability.ts` を更新する。`EvidenceRef` / `RunManifest` の型を足し、`CaptureFixture.evidenceHash` を廃止し、`CapabilityEvidence` へ `evidenceRefs?: number[]`、matrix 直下へ `evidenceSources` を足す。`capability.ts:44` の「その capture の raw transcript の SHA-256」というコメントは owner が不採用とした案なので書き換える
- [X] T012 `harness/evidence/schema.test.ts` を新規作成し、schema 側の検査を固定する（対応済み keyword だけで書けている / `evidence: []` の棄却 / `manifest` と `manifestHash` の対 / enum 外の `limitationCodes` の棄却 / fixture だけ先に `evidence` を足した状態が `unknown top-level key` で落ちる）
- [X] T013 `harness/fixtures/continuity/*.json` が `capability.schema.json` の変更に影響されないことを回帰で確認する（別種の fixture で検証対象外）。`harness/continuity/validate.test.ts` と `harness/continuity/schema-freeze.test.ts` が通ることを見る

**完了条件**（この phase の終わりに全部通す）:

```bash
node --experimental-strip-types --test harness/evidence/*.test.ts
node --experimental-strip-types --test harness/continuity/*.test.ts
vendor/codemem/node_modules/.bin/tsc -p harness/tsconfig.json
```

---

## Phase 3: US1 — 証拠のない tier 昇格を止める（Priority: P1）🎯 MVP

**Goal**: fixture が名指しした観測記録から digest を計算し直し、一致し、run の素性が伴い、cell の
主張が記録から導けたときにだけ `real-cli-e2e` を刻む

**Independent Test**: 実在しない観測記録を指す fixture と、記録はあるが digest が食い違う fixture を
用意し、どちらも `real-cli-e2e` にならず組み立てが失敗する

- [X] T014 [US1] `harness/evidence/promotion.test.ts` を新規作成し、先に落ちる test を並べる。攻撃側（実在しない path / 別物の path / 未知の版 / 空配列 / 実在しない hook の申告 / 導出値と申告値の食い違い）と、synthetic な観測記録・manifest・fixture を `mkdtemp` へ作って組み立てる positive control を両方書く
- [X] T015 [US1] `harness/assemble.ts` に検証器を実装する。data-model.md §4.1 の順で ref ごとに検査する（版 → path 解決 → 読み取り → `captureRawHash` → 正規化 → `evidenceHash` → manifest があれば `manifestHash` を **parse の前に** 照合 → closed schema → §2.5 の 11 項目）。いずれの失敗も組み立て全体の失敗にし、cell を黙って `source-test` へ落として続行しない
- [X] T016 [US1] `harness/assemble.ts` に `VerifiedClaims` の導出を実装する（data-model.md §4.3）。導ける主張（`session_started` / `user_prompted` / `session_ended` / `tool_started` / `tool_completed` / `assistant_completed` / `turn_completed`（Claude と Codex で規則が違う）/ `session_interrupted` / `subagentCapture` / `stableNativeSessionId`）は記録から値を導いて申告値と照合する。複数 ref は和集合で、いずれか 1 件以上が同じ値を導出すれば成立させる
- [X] T017 [US1] `harness/assemble.ts` の昇格判定を data-model.md §4.2 の順序で実装する。**種別の判定を先に置く**（導けない主張 → `source-test`、導ける主張 → supporting を求め、空なら失敗、manifest 付きが無ければ `source-test`、あれば `real-cli-e2e`）。順序を逆にすると既存 fixture で組み立てが落ちる
- [X] T018 [US1] 昇格を刻む 3 経路すべてを `verified` を見る形へ変える（`harness/assemble.ts:280` capture cell / `:349` highLevel cell / `:383` prompt 対の再刻印）。`:367` の `pairFixture` 抽出条件も `f.evidenceHash` から `verified` へ変える。prompt 対は**両 cell を支持する ref 集合に同じ 1 件が含まれるときだけ**成立させる
- [X] T019 [US1] `evidenceHash` を読んでいる残りの箇所を全件処理する（plan.md の棚卸し表）。`harness/assemble.ts:125`（schema キーの検証ループ）・`:252` `improvesEvidence`・`:285-286` / `:354` / `:389`（caveat 文言）・`:288` / `:357` / `:386`（出力欄）・`:338`（tie-break スコア）・`:414`（capability hash 入力）。`grep -rn evidenceHash harness/` の残りが意図した形だけになることを確認する
- [X] T020 [US1] `harness/assemble.ts` の in-file self-test（`:535` と `:588-758`）の**意味を反転させる**。現在は `"a".repeat(64)` のような作り物 hash で昇格することを確認しているので、作り物 hash では昇格しないことを確認する形へ書き換える。コンパイルが通るだけの機械的置換にしない
- [X] T021 [US1] `harness/continuity/fixture-validation.test.ts`（`evidenceHash` 参照 7 件）と `harness/continuity/capability-contract.test.ts`（同 5 件）を、新しい契約を守る形へ書き換える。これらは「hash があれば `real-cli-e2e`」という**現在の仕様を encode している**ので、古い仕様を守る test が残らないようにする
- [X] T022 [US1] `harness/assemble.ts` の `assembleFromFixtures` へ `EvidenceContext { evidenceRoot?: string }` を配線する。production の入口 `runAssemble` は `ctx` を取らず、内部で固定 root を作る。CLI 引数・fixture の値・環境変数のどれからも root が動かないことを test で固定する

**完了条件**:

```bash
node --experimental-strip-types --test harness/evidence/*.test.ts
node --experimental-strip-types harness/assemble.ts --self-test | tee /dev/stderr | grep -qx PASS
vendor/codemem/node_modules/.bin/tsc -p harness/tsconfig.json
```

---

## Phase 4: US2 — 別環境で取り直しても同じ digest になる（Priority: P2）

**Goal**: 環境差だけを取り除いた抜粋から digest を作り、同じ scenario の再取得が同じ digest になる

**Independent Test**: committed 済みの観測記録 16 件だけで、同一 scenario の 2 回の取得が同じ digest に
なり、別 scenario が別 digest になることを確認できる

- [X] T023 [P] [US2] `harness/evidence/normalize.test.ts` へ通過側の test を足す。`raw/claude-interrupt3.jsonl` と `raw/claude-interrupt4.jsonl` の digest が一致する（許容した環境差だけが違う再取得）
- [X] T024 [P] [US2] `harness/evidence/normalize.test.ts` へ過剰正規化側の test を足す。`raw/claude-tool-denied.jsonl` と `raw/claude-tool-ok.jsonl` の digest が異なる（`prompt` を verbatim から外すと衝突する）。識別子の相関だけが違う 2 記録の digest が異なる
- [X] T025 [P] [US2] `harness/evidence/normalize.test.ts` へ既知の正しい衝突を固定する。`raw/claude-hook-timeout.jsonl` と `raw/claude-lifecycle-basic.jsonl` は digest が一致する（hook の timeout は hook event 列に現れないので観測が本当に同一）。この一致が「取り違えても通る」を意味しないことは、fixture が自分の記録を名指しし `captureRawHash` で結び付けることで担保する
- [X] T026 [US2] committed raw 16 件の digest 分布（distinct 14 種・衝突 2 組）を回帰として固定する。`harness/evidence/normalize.test.ts` から 16 件すべての digest を計算し、期待集合と突き合わせる

**完了条件**: `node --experimental-strip-types --test harness/evidence/normalize.test.ts` が通り、16 件の digest 分布が計画の実測（distinct 14 / 衝突 2 組）と一致する

---

## Phase 5: US3 — 出所を追え、秘密は漏れない（Priority: P3）+ 段 5 移行 backfill

**Goal**: 成果物だけで「どの記録を・どの正規化版で・どの digest で・どの CLI 版で判定したか」を辿れ、
かつ観測記録の本文・投入指示・モデル出力・絶対 path が成果物へ出ない

**Independent Test**: canary を仕込んだ fixture と raw で組み立て、matrix・stdout・stderr のいずれにも
canary が現れない

- [X] T027 [US3] `harness/assemble.ts` に `evidenceSources`（matrix 直下・`fixtureId` → `path` の昇順で一意化）と cell 側の `evidenceRefs?: number[]` を実装する（data-model.md §5.1）。自由文の `scenario` は matrix へ出さず `scenarioId` を出す。成果物へ出す path は `^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$` に制約する
- [X] T028 [US3] `harness/assemble.ts:414` の `capabilityHashInputs` を構造化し、`harness/schema/jcs.ts` の `canonicalizeJson` で canonical 化する（data-model.md §5.2）。入力の列挙は欄を数え上げず畳んだ結果から導く。exact な byte 列と並び順を contract test で固定する
- [X] T029 [US3] `harness/assemble.ts` に自由文の runtime 検査を足す。成果物へ出る全文字列を対象に、参照 raw の秘密欄（`prompt` / `last_assistant_message` / `cwd` / `transcript_path` / 入れ子の `tool_input`・`tool_response`）から取った 16 文字以上の部分文字列を含んだら組み立てを失敗させる。**これは信頼境界ではなく警報**であることをコメントに書く
- [X] T030 [US3] `harness/evidence/secrets.test.ts` を新規作成する。canary を (a) fixture の散文 `limitations`、(b) raw の秘密欄、の各経路へ 1 つずつ仕込み、組み立てを**子プロセスとして起動**して matrix・stdout・stderr のいずれにも canary が出ないことを見る。失敗メッセージに観測記録の中身と絶対 path が出ないことも同じ file で見る
- [X] T031 [P] [US3] `harness/fixtures/claude/*.json` 5 件へ `evidence[]`（`path` / `evidenceHash` / `captureRawHash` / `normalizationVersion`。manifest は付けない = legacy 証拠）・`scenarioId`・`limitationCodes` を埋める。digest は T008 の CLI から得る（手で計算しない）。`interrupt-and-hook-timeout` は raw 5 本を配列で持つ
- [X] T032 [P] [US3] `harness/fixtures/codex/*.json` 3 件へ同じ形で `evidence[]`・`scenarioId`・`limitationCodes` を埋める
- [X] T033 [US3] matrix を再生成し、証拠強度が変化した cell が 0 件（昇格 0・降格 0）であることを T004 の baseline と突き合わせる。生成コマンドは `node --experimental-strip-types harness/assemble.ts harness/fixtures/<cli> harness/matrix/<cli>.json`
- [X] T034 [US3] 観測記録を 1 byte 変えると組み立てが失敗することを実測で確認する（`raw/*.jsonl` の 1 件へ空行を足して組み立て、失敗を見てから戻す）。この確認自体を `harness/evidence/promotion.test.ts` の test としても置く

**完了条件**:

```bash
node --experimental-strip-types --test harness/evidence/*.test.ts
for cli in claude codex; do
  node --experimental-strip-types harness/assemble.ts "harness/fixtures/$cli" "/tmp/$cli.json"
  diff <(jq 'del(.generatedAt)' "harness/matrix/$cli.json") <(jq 'del(.generatedAt)' "/tmp/$cli.json")
done
grep -rn 'RIG_INJECT_5f3a9\|aa16b2026df287771' harness/matrix/ ; test $? -eq 1
```

---

## Phase 6: 段 6 — rig の manifest と持ち込み（US1 の FR-003b / FR-006d）

**Goal**: これ以降の取得では、rig が run の素性を manifest として書き、観測記録と一緒に証拠置き場へ
byte 同一で持ち込む。既存 16 件は legacy のままで、この phase では昇格しない

- [X] T035 [US1] `harness/rig/rig.sh` を変更し、run ごとに manifest を 1 件書く（data-model.md §2.5 の 12 欄）。`cliVersion` は `.version` を UTF-8 の単一行として読み、末尾の CRLF か LF を 1 つだけ取り除く。複数行が返る CLI では失敗させる（黙って 1 行目を採らない）
- [X] T036 [US1] `harness/rig/rig.sh` に、観測記録と manifest を証拠置き場 `harness/fixtures/<cli>/raw/` へ **byte 同一で持ち込んでから** digest を出す工程を足す。持ち込み前に digest を出すと、持ち込みで内容が変わっても気づけない。digest は `harness/evidence/normalize.ts` の CLI から得る（`sha256sum` を別に呼ぶ二重実装にしない）
- [X] T037 [US1] `harness/evidence/manifest.test.ts` を新規作成し、§2.5 の照合表 11 項目を 1 つずつ反転する table-driven test を置く。`internalRunMarker` は「fixture と一致」ではなく「`true` であること」を見る（双方 `false` の組み合わせを棄却する）
- [X] T038 [US1] rig の manifest 生成部を stub CLI で起動できる形にし、`harness/evidence/rig-manifest.test.mjs` で「manifest が書かれる」「観測記録と manifest が置き場へ byte 同一で入る」を実 CLI 無しで検証する。CLI 実体を環境変数で受け取れない形なら、受け取れるようにしてから test を書く

**完了条件**: `node --experimental-strip-types --test harness/evidence/*.test.ts` と `node --test harness/evidence/rig-manifest.test.mjs` が通る。実 CLI を要求する test を CI へ入れない

---

## Phase 7: Polish（段 7 — provenance と退役、ゲート）

- [X] T039 [P] research.md R6 が挙げた 5 箇所の古い記述を退役させる。`harness/matrix/README.md` の `evidenceKind` の説明を実態（digest が裏付ける範囲・legacy 証拠・導けない主張）へ合わせる。**節ごとに掃除する**（変更前の設計は別の語で書かれた節に残る）
- [X] T040 [P] `harness/contract-hashes.json` を再生成する（`node harness/contract-hashes.mjs > harness/contract-hashes.json`）。`capability.schema.json` と fixture がその入力なので、Phase 2 と Phase 5 の変更で必ず動く
- [X] T041 `harness/evidence/mutate.sh` を新規作成する。`harness/continuity/mutate.sh` と同じ形（anchor 付きの実変異 → test 実行 → fail 件数 ≥ 1 を要求 → 実行件数と baseline test 件数の突き合わせ）で、下の変異表 54 件を並べる。**実行件数の突き合わせを省かない**（anchor が外れた変異は出力に何も出ないまま黙って飛ばされる）
- [X] T042 変異の網羅を機械的に確認する。`M0`〜`M52` と `M8b` の 54 件すべてが (a) 下の変異表に 1 行ずつある、(b) `harness/evidence/mutate.sh` に実変異として存在する、の両方を満たすことを検査するスクリプトを `harness/evidence/mutate.sh` の中に置き、欠けたら非ゼロで終了させる
- [X] T043 `.github/workflows/ci.yml` の `harness` job へ 2 step 足す（`node --experimental-strip-types --test harness/evidence/*.test.ts` と `bash harness/evidence/mutate.sh`）。既存 step は緩めない
- [X] T044 `specs/003-evidence-hash-normalization/quickstart.md` を実際に上から実行し、書いてあるコマンドがそのまま通ることを確認する。通らない箇所は quickstart 側を直す
- [X] T045 セキュリティ関連の必須ゲートを通す。`semgrep scan`（CLI）→ `/codex-review mode=security` → `/codex:adversarial-review`。指摘は `review-routing` の批判的評価にかけ、採否の理由を残す
- [ ] T046 `/code-review`（正しさ）で `ok: true` を得た直後に `ponytail-review`（過剰実装）を通す。2 本立てを省略しない
- [ ] T047 PR を作成し、`pr-merge-gate` スキルの 7 項目を通す。PR 本文に「昇格 0 件・降格 0 件」「digest が証明しないこと」「実装者の逸脱」を書く

**完了条件**（CI と同じコマンドをローカルで全部通す）:

```bash
vendor/codemem/node_modules/.bin/tsc -p harness/tsconfig.json
node harness/contract-hashes.mjs > /tmp/ch.json && diff harness/contract-hashes.json /tmp/ch.json
node --experimental-strip-types harness/assemble.ts --self-test | tee /dev/stderr | grep -qx PASS
node --experimental-strip-types --test harness/continuity/*.test.ts
node --experimental-strip-types --test harness/evidence/*.test.ts
bash harness/continuity/mutate.sh
bash harness/evidence/mutate.sh
for cli in claude codex; do
  node --experimental-strip-types harness/assemble.ts "harness/fixtures/$cli" "/tmp/$cli.json"
  diff <(jq 'del(.generatedAt)' "harness/matrix/$cli.json") <(jq 'del(.generatedAt)' "/tmp/$cli.json")
done
```

---

## 変異の割り当て（data-model.md §6 の全 51 件）

各行の「殺す test」は、その変異を入れたときに**必ず落ちる** test。`harness/evidence/mutate.sh`
（T041）はこの表を実行可能な形にしたもので、T042 が両者の一致を機械的に確認する。

| # | 変異先 | 殺す test | タスク |
|---|---|---|---|
| M0 | `harness/assemble.ts` `improvesEvidence` | `promotion.test.ts::verified fixture outranks unverified for the same cell` | T019 |
| M1 | `harness/assemble.ts` 昇格条件 | `promotion.test.ts::nonexistent evidence path is rejected` | T015 |
| M2 | `harness/assemble.ts` 不一致の扱い | `promotion.test.ts::digest mismatch fails the build` | T015 |
| M3 | `harness/assemble.ts` 版の照合 | `promotion.test.ts::unknown normalization version fails the build` | T015 |
| M4 | `harness/evidence/verify.ts` `DERIVABLE_HIGH_LEVEL_KEYS` | `promotion.test.ts::prompt pair requires a shared supporting ref` | T018 |
| M5 | `harness/evidence/normalize.ts` path 解決 | `normalize.test.ts::相対 path の .. は棄却される` | T007 |
| M6 | `harness/evidence/normalize.ts` path 解決 | `normalize.test.ts::置き場の外へ出る symlink は棄却される` | T007 |
| M7 | `harness/evidence/normalize.ts` verbatim 集合 | `normalize.test.ts::投入した指示が違う 2 記録は別の digest になる` | T024 |
| M8 | `harness/evidence/normalize.ts` 伏せ字 | `normalize.test.ts::同一 scenario の再取得は同じ digest になる` | T023 |
| M8b | `harness/evidence/normalize.ts` verbatim の深さ | `normalize.test.ts::入れ子の tool_input.prompt が違っても digest は変わらない` | T006 |
| M9 | `harness/evidence/normalize.ts` キー保持 | `normalize.test.ts::欄の有無は digest を変える` | T005 |
| M10 | `harness/evidence/normalize.ts` 直列化 | `normalize.test.ts::直列化は LF 区切りで最終行の後にも LF が付く` | T006 |
| M11 | `harness/evidence/normalize.ts` array | `normalize.test.ts::配列の長さは保たれる` | T005 |
| M12 | `harness/evidence/normalize.ts` 行数検査 | `normalize.test.ts::空の観測記録は棄却される` | T006 |
| M13 | `harness/schema/capability.schema.json` | `schema.test.ts::fixture with evidence is rejected when the schema lacks it` | T012 |
| M14 | `harness/assemble.ts` 失敗メッセージ | `secrets.test.ts::failure messages carry neither capture contents nor absolute paths` | T030 |
| M15 | schema の `minItems` と assemble の非空検査 | `schema.test.ts::empty evidence array is rejected` + `promotion.test.ts::empty evidence array fails the build` | T012 / T015 |
| M16 | `harness/evidence/normalize.ts` 相関 token | `normalize.test.ts::session 識別子が継続するかどうかは digest に現れる` | T006 |
| M17 | `harness/evidence/normalize.ts` token の scope | `normalize.test.ts::token の番号はファイル単位で、id と path で別の空間を持つ` | T006 |
| M18 | `harness/evidence/verify.ts` `sourceEvents` 検査 | `promotion.test.ts::claimed hook absent from the capture is rejected` | T016 |
| M19 | `harness/assemble.ts` `shareRef` | `promotion.test.ts::shared-ref predicate requires an actual common index` | T018 |
| M20 | `harness/evidence/verify.ts` manifest 照合表 | `manifest.test.ts::manifest captureHash that disagrees is rejected` | T037 |
| M21 | `harness/evidence/normalize.ts` 読み取り | `normalize.test.ts::重複したキーを持つ行は棄却される` + `normalize.test.ts::不正な UTF-8 は棄却される` | T006 |
| M22 | `harness/evidence/normalize.ts` `unparsed` | `normalize.test.ts::payload.unparsed を持つ行は棄却される` | T006 |
| M23 | `harness/evidence/normalize.ts` 中間 object | `normalize.test.ts::__proto__ 欄の有無は保たれる` | T006 |
| M24 | `harness/evidence/verify.ts` `SECRET_KEYS` | `secrets.test.ts::collectSecrets covers every secret-bearing field` | T029 |
| M25 | `harness/contract-hashes.json` | custom: `node harness/contract-hashes.mjs` との diff | T040 |
| M26 | `harness/evidence/verify.ts` claim 導出 | `promotion.test.ts::claimed cell value the capture does not derive is rejected` | T016 |
| M27 | `harness/assemble.ts` 種別の判定 | `promotion.test.ts::underivable claims stay source-test` | T017 |
| M28 | `harness/assemble.ts` manifest 要求 | `promotion.test.ts::legacy-only evidence stays source-test` | T017 |
| M29 | `harness/evidence/verify.ts` `captureRawHash` | `promotion.test.ts::normalization-collision swap is rejected by captureRawHash` | T015 |
| M30 | `harness/evidence/normalize.ts` token 走査順 | `normalize.test.ts::キーの書き順は相関 token の番号も変えない` | T006 |
| M31 | `harness/evidence/normalize.ts` 公開 API | `normalize.test.ts::normalizeCapture は byte 列を受け取り、string を拒否する` | T006 |
| M32 | `harness/assemble.ts` `capabilityHashInputs` | `hash-inputs.test.ts::capabilityHashInputs stay three canonical blobs that react to every input` | T028 |
| M33 | `harness/assemble.ts` 出力（自由文 `scenario`） | `secrets.test.ts::planted canaries never reach the matrix, stdout, or stderr` | T027 |
| M34 | `harness/evidence/verify.ts` legacy ref | `promotion.test.ts::legacy ref still verifies captureRawHash` | T015 |
| M35 | `harness/assemble.ts` `manifestBacked` の粒度 | `promotion.test.ts::mixed fixture does not promote legacy-backed cells` | T017 |
| M36 | `harness/evidence/verify.ts` 複数 ref の集約 | `promotion.test.ts::a claim is supported by any one ref (5-ref fixture)` | T016 |
| M37 | `harness/evidence/verify.ts` `turn_completed` 導出 | `promotion.test.ts::codex turn_completed derives as native` | T016 |
| M38 | `harness/evidence/verify.ts` `internalRunMarker` | `manifest.test.ts::manifest internalRunMarker must be true, not merely equal to the fixture` | T037 |
| M39 | `harness/rig/import-evidence.mjs` `cliVersion` | `rig-manifest.test.mjs::a CLI that prints more than one version line is rejected` | T035 |
| M40 | `harness/schema/capability.schema.json` manifest 対 | `schema.test.ts::manifest and manifestHash must appear together` | T012 |
| M41 | `harness/assemble.ts` 16-gram 警報 | `secrets.test.ts::a 16+ char secret substring in a generated string fails the build` | T029 |
| M42 | `harness/assemble.ts` `limitations` の転記 | `secrets.test.ts::planted canaries never reach the matrix, stdout, or stderr` | T030 |
| M43 | `harness/schema/capability.schema.json` `limitationCodes` | `schema.test.ts::unknown limitation code is rejected` | T012 |
| M44 | `harness/schema/capability.schema.json` keyword | `schema.test.ts::capability schema uses only supported keywords` | T012 |
| M45 | `harness/evidence/verify.ts` `captureRawHash` 再計算 | `promotion.test.ts::raw byte change fails even when the normalized digest is unchanged` | T034 |
| M46 | `harness/evidence/verify.ts` `manifestHash` の照合位置 | `promotion.test.ts::corrupt manifest is rejected before parsing` | T015 |
| M47 | `harness/assemble.ts` 判定の順序 | `promotion.test.ts::underivable claim does not fail the build` | T017 |
| M48 | `harness/evidence/normalize.ts` root 差し替え口 | `promotion.test.ts::synthetic manifest-backed fixture promotes end-to-end` | T014 / T022 |
| M49 | `harness/assemble.ts` `runAssemble` | `promotion.test.ts::the assemble entrypoint ignores EVIDENCE_ROOT from the environment` | T022 |
| M50 | `harness/assemble.ts` fixture 全体の schema 検査 | `schema.test.ts::provenance fields that reach the matrix are pattern-constrained` | T045 |
| M51 | `harness/evidence/verify.ts` `stableNativeSessionId` 導出 | `promotion.test.ts::stableNativeSessionId needs a session id on every observed line` | T045 |
| M52 | `harness/assemble.ts` 暦の検査 | `schema.test.ts::timestamps that pass the pattern but do not exist on the calendar are rejected` | T045 |

**変異表を実行可能にする過程で分かったこと**（表は実測に合わせて直した。詳細は PR 本文）:

- **prompt 対の再刻印は現在到達しない。** 対の 2 cell は導けない主張なので `promoteCell` が
  `evidenceRefs: []` を返し、`pairFixture` が常に `undefined` になる。したがって「対の再刻印の中で
  裏付けを求める」変異は原理的に殺せない。門そのもの（共有 ref の述語）を `shareRef` として
  切り出し、直接 test で固定した。経路が復活したとき門が黙って緩まないようにするため
- **「キーの書き順は digest を変えない」は 1 つの変異では壊せない。** 整列した順で挿入し、さらに
  canonical に直列化しているので、どちらか一方を外しても出力 byte は変わらない（過剰決定）。
  M10 は実際に壊せる性質（末尾 LF の framing）へ振り直した
- **契約 hash は node:test では殺せない。** `run_custom` で再生成との diff を門にする

**割当の確認**（T042 が自動化する。手で確かめるときはこれ）:

```bash
# 表に 53 件そろっているか
grep -oE '^\| M[0-9]+b? ' specs/003-evidence-hash-normalization/tasks.md | tr -d '| ' | sort -u | wc -l   # => 54
```

---

## Dependencies

```
Phase 1（実行して確かめる）
   ↓
Phase 2（段 2 normalizer + 段 3 schema）  ← ここが終わるまで story に入らない
   ↓
Phase 3（US1 昇格判定）  ──┐
   ↓                        │
Phase 4（US2 正規化の受け入れ。Phase 2 だけに依存し Phase 3 と並行可）
   ↓                        │
Phase 5（US3 provenance + 段 5 backfill。Phase 3 の判定が要る）
   ↓
Phase 6（段 6 rig manifest。Phase 3 の manifest 照合が要る）
   ↓
Phase 7（段 7 退役 + ゲート）
```

- **US1**（Phase 3）は Phase 2 だけに依存する。単独で「証拠のない昇格が止まる」ことを示せる = MVP
- **US2**（Phase 4）は Phase 2 だけに依存する。Phase 3 と並行してよい
- **US3**（Phase 5）は Phase 3 の判定結果に依存する（昇格 0 件・降格 0 件を測るため）

## Parallel Example

```
Phase 1: T002 / T003 / T004 を同時に（別ファイル）
Phase 4: T023 / T024 / T025 を同時に（同じ test file だが独立した test 追加。競合するなら順に）
Phase 5: T031 / T032 を同時に（claude 5 件と codex 3 件で別ファイル）
Phase 7: T039 / T040 を同時に
```

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3**。ここまでで「証拠のない `real-cli-e2e` 昇格が塞がる」が
成立する。Phase 4 は正規化の受け入れ条件を committed データで固定するもので、Phase 3 と並行できる。

Phase 5 以降は移行と provenance と将来の rig。**Phase 5 を終えるまで matrix は再生成しない**
（判定が固まる前に生成すると、baseline との比較が意味を失う）。

段 2〜4 は**先に落ちる test を書いてから実装する**。段 5 は段 4 が通ってからでないと
「昇格したかどうか」を確認できない。
