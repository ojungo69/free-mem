---

description: "Task list for 継続状態に証跡の置き場を作る（Cluster C）"
---

# Tasks: 継続状態に証跡の置き場を作る（Cluster C）

**Input**: Design documents from `/specs/002-continuity-state-evidence/`

**Prerequisites**: plan.md / spec.md / research.md / data-model.md / quickstart.md（すべて作成済み）

**Tests**: **必要**。spec の SC-003（既存テストが 1 件も書き換わらない）と SC-004（規則ごとの変異が
生存 0）はテストと変異ゲートでしか示せない。テスト作成は任意ではなく要件。

**Organization**: user story ごとに phase を分ける。ただし **phase の順序は入れ替えられない**
（plan.md「実装順序」）。凍結 schema を先に固定しないと、どの story も「何を書いてよいか」を
決められないため。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列可（別ファイル・未完了タスクへの依存なし）
- **[Story]**: US1 / US2 / US3（spec.md の user story に対応）
- パスは repo ルート相対。作業ディレクトリは `/home/jura/projects/free-mem-wt/cluster-c`

## Path Conventions

単一プロジェクト。契約は `harness/schema/`、参照実装とテストは `harness/continuity/`、
正本は `specs/001-agent-memory-core/` と `evidence/`。新しいディレクトリは作らない。

## 共通の実行コマンド（各タスクの検証で使う）

```bash
WT=/home/jura/projects/free-mem-wt/cluster-c
"$WT/vendor/codemem/node_modules/.bin/tsc" -p "$WT/harness/tsconfig.json" --noEmit
node --experimental-strip-types --test "$WT"/harness/continuity/*.test.ts
bash "$WT/harness/continuity/mutate.sh"

# 契約 hash（CI と同じ手順。手で書かず、生成物で上書きする）
cd "$WT" && node harness/contract-hashes.mjs > /tmp/contract-hashes.json
diff harness/contract-hashes.json /tmp/contract-hashes.json   # CI が見るのはこの diff
cp /tmp/contract-hashes.json harness/contract-hashes.json     # 更新するときだけ
```

---

## Phase 1: Setup（前提の確認）

**Purpose**: 着手可能な状態かを機械的に確かめる。ここで赤なら実装に入らない。

- [X] T001 `main` に PR #51・#52・#55 が入っていることを確認する（`git -C /home/jura/projects/free-mem-wt/cluster-c fetch origin && git log origin/main --oneline | head -20`）。3 本とも `harness/continuity/` と `harness/contract-hashes.json` を触るので、未マージなら着手しない
- [X] T002 作業ブランチを `origin/main` に載せ直す（`git -C /home/jura/projects/free-mem-wt/cluster-c rebase origin/main`）。plan までの成果物は `specs/` しか触っていないので衝突しないはず。衝突したら内容を確認してから解決する
- [X] T003 vendor の依存を入れてから着手前のベースラインを取る（`tsc` / テスト / `mutate.sh` / `contract-hashes.json` 差分空）。**4 つとも緑でない状態から実装を始めない**。この時点のテスト件数と変異の 実行/期待 件数を記録し、T036 の比較に使う。**実測（2026-08-17、main = d517a8b）: tsc clean / 286 tests / 変異 実行 164・期待 164・生存 0 / contract-hashes 差分なし**。**先に `cd vendor/codemem && corepack pnpm install --frozen-lockfile`**（CI と同じ。`npm ci` は lockfile が無いので失敗する）: `tsc` は `vendor/codemem/node_modules/.bin/tsc` にしか無く、worktree を作った直後は存在しない。入れずに走らせると ENOENT で落ち、**実装の赤と区別が付かない**

---

## Phase 2: Foundational（凍結 schema の差分・全 story を塞ぐ）

**Purpose**: 契約を先に固定する。ここが決まらないと実装が「何を書いてよいか」を決められない。

**⚠️ CRITICAL**: T004〜T009 が終わるまで、どの user story も着手できない

- [X] T004 `harness/schema/continuity.schema.json` の `PendingOperation` に任意欄 3 つを足す — `startIngestSeq`（`pattern: ^(0|[1-9][0-9]*)$` / `maxLength: 8192`、`lastIngestSeq` と同一制約）、`startTurnIdSource`（`$ref: "#/$defs/TurnIdSource"`）、`terminalFingerprint`（`type: string` / `maxLength: 8192`）。3 欄とも `required` に入れない。`additionalProperties: false` を維持する（data-model.md §1）
- [X] T005 `harness/schema/continuity.schema.json` に `$defs.DroppedEvidenceEntryV1` を足す — `reason`（`enum: ["evicted", "orphaned_terminal"]`・必須）/ `recordedAt`（`$ref: IsoTimestamp`・必須）/ `sensitivity`（`$ref: Sensitivity`・必須）/ `eventId`・`operationId`（`type: string` / `maxLength: 8192`・任意）/ `status`（`enum: ["started","succeeded","failed","unknown"]`・任意）。`additionalProperties: false`。**`oneOf` で分岐させない**（data-model.md §3 の理由）
- [X] T006 `harness/schema/continuity.schema.json` の `CanonicalWorkStateV1` に `droppedEvidence`（`type: array` / `items: {$ref: DroppedEvidenceEntryV1}` / `maxItems: 256`・任意）を足す（data-model.md §2）
- [X] T007 `harness/schema/continuity.ts` に T004〜T006 と同じ形を TypeScript で足す — `PendingOperation` の 3 欄は `?:`、`CanonicalWorkStateV1.droppedEvidence?: readonly DroppedEvidenceEntryV1[]`、`DroppedEvidenceEntryV1` 型を新設。**JSON 側と欄名・任意性・語彙が 1 文字でも違わないこと**。**逸脱**: `readonly` を付けず `droppedEvidence?: DroppedEvidenceEntryV1[]` にした。この file の配列欄は `pendingOperations: PendingOperation[]` を含め 1 つも `readonly` を使っておらず、ここだけ付けると新しい欄が別の規約で書かれたように読める
- [X] T008 `harness/continuity/schema-freeze.test.ts` に新しい欄と `$def` の凍結を足す — 存在すること、`required` に**入っていない**こと、`additionalProperties: false` であること、`maxItems` が 256 であること、`startTurnIdSource` が `TurnIdSource` を `$ref` していること（語彙の複製が入ったら落ちる）。既存ゲートが担う分は足していない: `additionalProperties: false` は「object はすべて closed」が、`$ref` の複製は「property の中に直接書かれた enum も凍結する」が拾う（inline enum に置き換えると凍結表と食い違って落ちる）
- [X] T009 契約 hash を再生成して差分を確認する（`node harness/contract-hashes.mjs > /tmp/contract-hashes.json` → `diff harness/contract-hashes.json /tmp/contract-hashes.json` → 一致させる）。**schema の hash だけが動き、fixture の hash は動かないこと**。fixture の hash まで動いたら T004〜T007 で意図しない場所を触っている

**Checkpoint**: 契約が固定された。`tsc` とテストが緑。この時点で実装はまだ 0 行

**実測（Phase 2 完了時）**: tsc clean / 288 tests（+2、いずれも schema-freeze）/ 変異 実行 164・期待 164・生存 0（還元器は未変更なので baseline と同数）/ `contract-hashes.json` は `schema/continuity.schema.json` の 1 行だけが動いた。schema への差分は挿入のみ（65 insertions / 0 deletions）— 凍結 schema は**生バイトが TS/Rust parity の signal** なので、JSON の round-trip で整形し直すと無関係な行まで hash が動く

---

## Phase 3: User Story 1 - 状態だけで権威順序を判定できる (Priority: P1) 🎯 MVP

**Goal**: `startIngestSeq` / `startTurnIdSource` を `PendingOperation` に載せ、凍結 schema の外の
索引（`operationStarts` / `OperationStartFactsV1` / `startFactsFor`）を消す。**実装が減る**段。

**Independent Test**: 状態と event だけを渡す経路（`reduceTaskWorkState` の第 3 引数に空 Map）に、
start より小さい連番の terminal を与えて隔離されること。外部索引を渡さずに済むこと。

### Tests for User Story 1

> 実装より先に書き、**落ちること**を確認してから T014 へ進む

- [X] T010 [P] [US1] `harness/continuity/reference-model.test.ts` に FR-001/FR-002 の回帰を足す — start 受理時に `startIngestSeq` と `startTurnIdSource` が `PendingOperation` に書かれること（spec Acceptance 1・2 に対応）
- [X] T011 [P] [US1] `harness/continuity/reference-model.test.ts` に FR-003 の回帰を足す — 同じ operation への**再配送 start** で 2 欄が**変わらない**こと（spec Acceptance 4）。遅れて届いた再配送の後、正当な terminal が順序違反で落ちないことまで見る
- [X] T012 [P] [US1] `harness/continuity/reference-model.test.ts` に FR-004 の回帰を足す — 2 欄を**持たない** `PendingOperation`（復元直後・旧い状態）に terminal を与えると `terminal_order_unverifiable` → `unknown` に落ちること。**材料が無いことを合格に読み替えない**
- [X] T013 [P] [US1] `harness/continuity/reference-model.test.ts` に SC-001 の回帰を足す — 索引を渡した場合と渡さない場合で、同じ状態・同じ event 列から**同じ判断・同じ状態**が出ること（spec Acceptance 3）。**書き換え**: T018 で索引そのものが消えるので「渡した場合」は書けない。SC-001 の主張を「同じ id の兄弟が並ぶ状態でも、各 pending が自分の材料で判定される」として固定した（側索引の頃はここが**原理的に判別できず**、両方 `terminal_order_unverifiable` に倒すしか無かった箇所）

### Implementation for User Story 1

- [X] T014 [US1] `harness/continuity/reference-model.ts` の start 受理経路で `startIngestSeq` / `startTurnIdSource` を書く。**新規 pending を作るときだけ**書き、既存 pending への再配送では触らない（FR-003）
- [X] T015 [US1] `harness/continuity/reference-model.ts` の §4.3 rule 1（権威順序）を `PendingOperation.startIngestSeq` から読むように付け替える。欄が無ければ従来どおり `terminal_order_unverifiable`
- [X] T016 [US1] `harness/continuity/reference-model.ts` の §4.3 rule 2（turn 種別の両立）を `PendingOperation.startTurnIdSource` から読むように付け替える。欄が無ければ従来どおり検査を免除
- [X] T017 [US1] `harness/continuity/reference-model.ts` から `startFactsFor()` を削除する。同名 pending を数えて曖昧なら材料なしに倒す分岐は、材料が要素に載った時点で発生しえない（research R-001）。**`terminal_order_unverifiable` へ倒す経路そのものは残す**（欄が無い状態のため）
- [X] T018 [US1] `harness/continuity/reference-model.ts` から `OperationStartFactsV1` 型と `TaskWorkStateSnapshotV1.operationStarts` を削除し、`reduceTaskWorkState` / `correlateTerminalEvent` / `finalizeAbandonedState` の引数から索引を落とす。退避時の索引同期（`operationStarts.delete(...)`）も一緒に消える
- [X] T019 [US1] 索引を渡していた既存の呼び出し側（テストの `new Map()` 引数を含む）を新しい signature に合わせる。**既存テストの期待値は 1 件も書き換えない**（SC-003）。書き換えが要るなら T014〜T018 のどこかで挙動を変えている

**T019 の逸脱（SC-003 を満たしていない 5 件）**: 「期待値を 1 件も書き換えない」は達成できなかった。書き換えたのはすべて**側索引の欠陥そのものを仕様として固定していた test** で、その欠陥を消すのが US1 の目的なので、挙動を意図せず変えた結果ではない。内訳:

| test | 旧 | 新 | なぜ変わるのが正しいか |
|---|---|---|---|
| 自 lineage で id が衝突しているとき | `terminal_order_unverifiable` | 診断ゼロで `succeeded` | 鍵が `operationId` だったので帰属を判別できず材料なしに倒していた。要素に載れば判別が要らない |
| 同名の兄弟が退避されたとき | 生存側も `unknown` | 生存側は `succeeded` | 退避のたび同名の材料をまとめて消していたので、**生き残った側の証跡まで失われていた** |
| 状態側で operationId が衝突 | `["unknown","started"]` | `["succeeded","started"]` | 同上。「1 件しか閉じない」という本来の主張は保っている |
| 同名兄弟の start facts で順序検査 | 両方 `terminal_order_unverifiable` | A の材料で A を判定（前なら `terminal_out_of_order`、後なら `succeeded`） | test 名どおり「他人の材料で検査しない」が、材料が要素に載れば**自分の材料で検査できる** |
| 名乗っている兄弟の 2 件（互換・非互換） | 末尾で `terminal_order_unverifiable` | 診断ゼロ | 旧 test のコメント自身が「これは #35 の欠落で、この test の主題とは無関係」と書いていた残渣 |

**実測（Phase 3 完了時）**: tsc clean / 294 tests（+6）/ 変異 実行 165・期待 165・生存 0 / `contract-hashes.json` は parity fixture の 1 行だけが動いた（還元器の出力が変わったので当然。**判断・診断・status は 1 件も変わらず hash だけが動いた**ことを diff で確認済み）/ `reference-model.ts` は 62 insertions・91 deletions で **29 行純減**

**変異ゲートの付け替え（data-model.md §7 の先決めどおり）**: 消えた機構の変異 3 件（退避の索引同期 2 件・側索引の曖昧判定 2 件のうち生き残る形に付け替えた分）を削り、#35 の規則を守る変異 4 件（start の連番を記録しない / turn 種別を記録しない / 再配送でも順序材料を書く = FR-003 / 空白を値として読む × 2）を足した。「空白の turn 種別を値として読む」は最初 fail 0 で生存したので、rule 2 の候補が空白で落ちないことを見る test を追加して kill した

**Checkpoint**: US1 が単独で成立。`tsc` / 全テスト / `mutate.sh` が緑で、**実装の行数が着手前より減っている**

---

## Phase 4: User Story 2 - 状態から消えた証跡が状態に残る (Priority: P2)

**Goal**: `droppedEvidence` に退避 operation と孤児 terminal を有界に記録し、追加と脱落を診断に出す。

**Independent Test**: 上限まで埋めた状態に新しい start を入れて退避を起こし、退避された
`operationId` が `droppedEvidence` に現れること。孤児 terminal も同様。

### Tests for User Story 2

- [ ] T020 [P] [US2] `harness/continuity/reference-model.test.ts` に FR-005 の回帰を足す — 退避で `{reason: "evicted", operationId, status, recordedAt, sensitivity}` が 1 件足され、`sensitivity` が**退避元から引き継がれる**こと（spec Acceptance 1）
- [ ] T021 [P] [US2] `harness/continuity/reference-model.test.ts` に FR-006 の回帰を足す — 候補 0 件の terminal で `{reason: "orphaned_terminal", eventId, recordedAt, sensitivity: "private"}` が足されること。孤児は相手が居ないので fail-closed の `private`（spec Acceptance 2）
- [ ] T022 [P] [US2] `harness/continuity/reference-model.test.ts` に FR-007 の回帰を足す — 記録に payload・引数・出力・`description` が**入らない**こと。`DroppedEvidenceEntryV1` の欄集合そのものを固定する
- [ ] T023 [P] [US2] `harness/continuity/reference-model.test.ts` に FR-008 の回帰を足す — 記録が 256 件のとき、**配列の先頭**が落ちて末尾に足されること。`recordedAt` で並べ替えると落ちるように、`recordedAt` を降順に仕込んだ fixture を使う
- [ ] T024 [P] [US2] `harness/continuity/reference-model.test.ts` に FR-009 の回帰を足す — 追加で `dropped_evidence_recorded`、脱落で `dropped_evidence_overflowed` が診断に出ること
- [ ] T025 [P] [US2] `harness/continuity/reference-model.test.ts` に FR-013/FR-014 の回帰を足す — `droppedEvidence` を**持たない**状態を読めて、退避が起きたら欄が新設されること（spec Acceptance 4）

### Implementation for User Story 2

- [ ] T026 [US2] `harness/continuity/reference-model.ts` に `DiagnosticCode` の 2 値 `dropped_evidence_recorded` / `dropped_evidence_overflowed` を足す
- [ ] T027 [US2] `harness/continuity/reference-model.ts` に記録の追加関数を 1 つ足す — 末尾に足し、`maxItems` に達していたら**先頭から 1 件落としてから**足す。落としたら `dropped_evidence_overflowed`、足したら `dropped_evidence_recorded`。`pendingOperations` の退避と**同じ規則**を使い、時刻で並べ替えない
- [ ] T028 [US2] `harness/continuity/reference-model.ts` の退避経路（`retainPendingOperations`）から T027 を呼び、退避された各 operation を `reason: "evicted"` で記録する。`sensitivity` は退避元から引き継ぐ
- [ ] T029 [US2] `harness/continuity/reference-model.ts` の孤児 terminal 経路（`terminal_orphaned`）から T027 を呼び、`reason: "orphaned_terminal"` で記録する。**隔離の判断自体は変えない**（記録は隔離の代わりではない）

**Checkpoint**: US1 と US2 が両方とも単独で成立。状態のサイズが上限で頭打ちになる（SC-005）

---

## Phase 5: User Story 3 - 配送 ID をまたいだ payload 衝突を見つけられる (Priority: P3)

**Goal**: 受理した terminal の `canonicalFingerprint` を `PendingOperation.terminalFingerprint` に
保持し、同じ成否・違う指紋・違う配送 ID の terminal を衝突として扱う。

**Independent Test**: 同じ operation を、同じ成否・違う payload・違う配送 ID で 2 回 terminal し、
2 通目が衝突として隔離されること。

### Tests for User Story 3

- [ ] T030 [P] [US3] `harness/continuity/reference-model.test.ts` に FR-010/FR-011 の回帰を足す — 確定時に `terminalFingerprint` が書かれ、同じ成否・違う指紋・違う配送 ID の 2 通目が衝突として隔離され、**状態が変わらない**こと（spec Acceptance 1）
- [ ] T031 [P] [US3] `harness/continuity/reference-model.test.ts` に「同じ指紋なら隔離しない」回帰を足す — 別の配送 ID でも指紋が同じなら適用済みの再配送として扱われること（spec Acceptance 2）
- [ ] T032 [P] [US3] `harness/continuity/reference-model.test.ts` に FR-012 の回帰を足す — `terminalFingerprint` を持たない旧い状態では新しい検査が**発動せず**、従来どおり `terminal_already_applied` になること（spec Acceptance 3）

### Implementation for User Story 3

- [ ] T033 [US3] `harness/continuity/reference-model.ts` の terminal 受理経路で、`status` を `succeeded` / `failed` に変えるときに `terminalFingerprint` へ event の `canonicalFingerprint` を**そのまま**入れる。**計算し直さない**。`unknown` へ倒す経路では書かない（受理していない）
- [ ] T034 [US3] `harness/continuity/reference-model.ts` の再配送判定に指紋比較を足す — 確定済み operation に `terminalFingerprint` があり、届いた terminal の `canonicalFingerprint` が違えば衝突。欄が無ければ従来どおり `terminal_already_applied`

**Checkpoint**: 3 つの story がすべて単独で成立

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: fixture・hash・変異ゲート・正本を、実装が着地した形に合わせる。

**⚠️ 順序**: T035（fixture）→ T036（hash 再生成）→ T037〜T038（変異）の順。quickstart.md の
「hash 差分をテストより先」を守る。fixture を変えて hash を再生成し忘れると、ローカルは緑のまま
CI だけが落ちる。

- [ ] T035 `harness/fixtures/continuity/` に新しい欄を持つ状態の fixture を足す。**旧い形（新しい欄を持たない）の fixture は 1 件も消さない** — FR-013/FR-014 の証拠がそこにある
- [ ] T036 契約 hash を再生成し（`node harness/contract-hashes.mjs`）、差分が schema 2 件 + 新しい fixture 分だけであることを確認する。**手で書かない**（FR-016）
- [ ] T037 `harness/continuity/mutate.sh` から、消えた規則を守っていた変異を削除する — `startFactsFor` の同名 pending 数え上げ、`operationStarts` の退避同期。アンカー切れで黙って飛ぶのではなく**明示的に消す**
- [ ] T038 `harness/continuity/mutate.sh` に data-model.md §7 で先に決めた 6 つの変異を足す — FR-003（再配送でも `startIngestSeq` を書く）/ FR-004（欄が無いとき検査を素通り）/ FR-008（`recordedAt` 昇順で落とす）/ FR-009（脱落の診断を出さない）/ FR-012（指紋が無くても衝突扱い）/ FR-015（記録の上限検査を外す）。**各変異が「落ちるべきテスト」だけを赤にすることを 1 本ずつ確かめる**
- [ ] T039 `mutate.sh` の 実行件数 / 期待件数 / 生存数 を突き合わせる。ずれたら `comm -23 <(期待の一覧) <(実行された一覧)` でアンカー切れを特定して直す（生存 0 かどうかより先に**実行件数**を見る）
- [ ] T040 [P] `specs/001-agent-memory-core/resume-continuity-addendum-v6.2.md` §4.3 の文面を実装に一致させる（FR-017）— 「候補 0 件の terminal は unmatched evidence として保存する」を、実装がとる「隔離しつつ `droppedEvidence` に有界に記録する」に直す。3 つの検査が状態だけで実施できるようになったことも書く
- [ ] T041 [P] `specs/001-agent-memory-core/resume-continuity-addendum-v6.2.md` §0.1 の Revision log に改定行を足す。節番号とファイル名は動かさない
- [ ] T042 [P] `evidence/phase3-reference-model.md` に、索引方式（`operationStarts`）をやめた理由（R-001: `operationId` に一意性が無いので鍵にできない）と、新しい規則の根拠を記録する。§5 の件数（テスト数・変異の 実行/期待）を実測値に更新する
- [ ] T043 5 つのゲートを通しで実行する — `tsc` / 全テスト / `mutate.sh`（生存 0・実行=期待）/ `contract-hashes.json` 差分が再生成と一致 / `git status` に未追跡の生成物が無い
- [ ] T044 SC-003 を機械的に示す — `git diff origin/main -- harness/continuity/reference-model.test.ts` に**既存テストの期待値の書き換えが 1 件も無い**こと（追加のみ）を確認する。書き換えがあるなら、新しい欄が無い経路の挙動を変えている
- [ ] T045 `/code-review`（正しさ）→ `ponytail-review`（過剰実装）の 2 本立てを通す。この feature は Constitution III と `rules/security.md` の対象範囲（入力検証・fail-closed の境界）なので、**外部 CLI へ委譲せず Claude Code が実装しレビューする**
- [ ] T046 `speckit-verify-tasks` を 1 回通し、`[X]` に実装が伴っているかを確認してから PR を作る

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし。ただし T001 が赤なら全体が着手不可
- **Foundational (Phase 2)**: Setup 完了後。**全 user story を塞ぐ**
- **US1 (Phase 3)**: Foundational 完了後
- **US2 (Phase 4)**: Foundational 完了後。US1 とは論理的に独立だが、**同じ関数群（退避経路）を触る**ので直列にする（plan.md）
- **US3 (Phase 5)**: Foundational 完了後。同上
- **Polish (Phase 6)**: 3 story 完了後。T037〜T039 は US1 で関数が消えた後でないと付け替えられない

### User Story Dependencies

- **US1 (P1)**: 他 story に依存しない。単独で成立する。**MVP**
- **US2 (P2)**: US1 に論理依存しない。US1 が `retainPendingOperations` を触るのでファイル上は直列
- **US3 (P3)**: US1 / US2 に論理依存しない。同上

### Within Each User Story

- テストを先に書き、**落ちること**を確認してから実装へ進む
- 契約（Phase 2）→ 書き込み → 読み取り → 索引削除 の順

### Parallel Opportunities

- Phase 3 / 4 / 5 の**テストタスク**（T010〜T013・T020〜T025・T030〜T032）は同じファイルに書くが
  互いに独立なので、内容としては並行して設計できる。**同時編集はしない**（同一ファイル）
- Phase 6 の T040 / T041 / T042 は別ファイルなので真に並列可
- 実装タスクは全て `reference-model.ts` の同じ関数群を触るため**並列にしない**

---

## Parallel Example: Phase 6 の正本追従

```bash
# 別ファイルなので同時に進められる
Task: "addendum §4.3 の文面を実装に一致させる（T040）"
Task: "addendum §0.1 に改定行を足す（T041）"
Task: "evidence に索引方式をやめた理由を記録する（T042）"
```

---

## Implementation Strategy

### MVP First (User Story 1 のみ)

1. Phase 1: Setup（前提の確認）
2. Phase 2: Foundational（契約の固定 — **全 story を塞ぐ**）
3. Phase 3: US1（順序材料の移設 + 索引削除）
4. **STOP して検証**: 状態だけを渡す経路で権威順序が判定できること。実装が減っていること
5. ここで一度 5 ゲートを通す

US1 だけで SC-002 の「実施不能な 1 件」が解消し、SC-001 のパリティが名乗れるようになる。
US2 / US3 は正本との食い違いの解消と診断の追加であり、誤った判断が確定する経路は無い。

### Incremental Delivery

1. Setup + Foundational → 契約が固定
2. US1 → 単独検証 → **MVP**（実装が減る）
3. US2 → 単独検証（記録の置き場ができる）
4. US3 → 単独検証（指紋の比較が効く）
5. Polish → fixture / hash / 変異 / 正本を着地形に合わせる

各 story は前の story の挙動を壊さない（新しい欄はすべて任意で、無ければ従来経路）。

### 単独作業前提

この repo は 1 人 + 委譲で動いている。実装タスクは全て同じファイルの同じ関数群を触るので、
**実装の並列化はしない**。並列にできるのは Phase 6 の正本追従だけ。

---

## Notes

- [P] = 別ファイル・依存なし
- 実装は Claude Code が自ら行う（`rules/coding.md` の委譲ルーティング: 入力検証・fail-closed の
  境界はセキュリティ関連。外部 CLI へ委譲しない）
- **`harness/contract-hashes.json` を手で書かない**。必ず再生成する（FR-016）
- 変異ゲートは**生存数より先に実行件数**を見る。アンカー切れは黙ってスキップされる
- タスクごと、または論理的なまとまりごとに commit する
- 各 Checkpoint で止まって story 単独の成立を確認してよい
