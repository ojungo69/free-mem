# Tasks: Agent Memory Continuity Platform — Core 1.0

**Input**: [plan.md](plan.md) / [spec.md](spec.md) / 正本 = `agent-memory-final-spec-v6.md`（v6.1）§29–30

**方針**: Phase 0A（= PR 1）のみ完全詳細化。Phase 0B〜8 は見出し + Exit gate 参照のみとし、
各 Phase 着手時に本ファイルへ詳細タスクを追記する（plan.md「多段フェーズはターンをまたぐ」）。
テストタスクは生成しない（Exit gate 自体が検証タスクとして列挙されるため）。

**実行体制**: ブランチ `phase-0a-evidence` + worktree 隔離。調査・量産系は Codex へ委譲、
auth path の fatal/non-fatal 判定・action plan・base ADR 決定は Claude Code（セキュリティ関連 + 最終判断）。

---

## Phase 0A — Evidence Freeze / Base Bake-off（v6.1 §29 Phase 0A / §30 PR 1）

**Goal**: 候補 3 リポの証拠を凍結し、§4.3 base gate で base ADR を確定する。機能変更ゼロ。

**Independent Test**: spec.md SC-0A — base ADR 確定（inventory 完了 + fatal/non-fatal 分類 +
delta 比較記録）、clean install、unsafe path action plan。

### Setup

- [X] T001 ブランチ `phase-0a-evidence` を作成し worktree を `~/projects/free-mem-wt/phase-0a-evidence` に隔離（`git worktree add`）
- [X] T002 [P] 候補 3 リポを sibling dir へローカル clone し pin commit を checkout（`~/projects/free-mem-vendor/codemem` @ `26438e75` / `~/projects/free-mem-vendor/ai-memory` @ `a9e9a24d` / `~/projects/free-mem-vendor/remem` @ `cde8bc05`。公開 fork 禁止・clone のみ）
- [X] T003 worktree に `evidence/` ディレクトリと `evidence/README.md`（成果物一覧の索引）を作成

### Evidence Freeze（各候補独立 → 並列可・Codex 委譲）

- [X] T004 [P] codemem: exact toolchain（node/npm/OS）記録 + upstream check/test 実行、ログを `evidence/codemem/upstream-test.log` へ保存。license / SBOM / native asset 一覧を `evidence/codemem/sbom.md` へ
- [X] T005 [P] ai-memory: 同上を `evidence/ai-memory/` へ
- [X] T006 [P] remem: 同上を `evidence/remem/` へ
- [X] T007 codemem: 静的 inventory — 全 DB open 箇所 / write-capable handle / provider auth・backend / sync・sharing import を file:line 付きで `evidence/codemem/write-handle-inventory.md` へ（v6.1 §4.3 の必須成果物）
- [X] T008 [P] ai-memory・remem: 同観点の簡易 inventory（delta 比較に必要な粒度）を各 `evidence/<repo>/inventory-summary.md` へ
- [X] T009 codemem: observer runtime audit と現行 benchmark runner の有無・実行可否を確認し `evidence/codemem/runtime-audit.md` へ

### 判定（セキュリティ関連 = Claude Code 自ら）

- [X] T010 T007 の inventory を fatal / non-fatal に分類（v6.1 §4.3 基準: unsafe auth path・undocumented provider loader・direct DB fallback 等）。結果を `evidence/codemem/write-handle-classification.md` へ
- [X] T011 fork/vendor/greenfield delta を「残る write handle 数・壊す test 数・移植資産数・unsafe auth path 数」で比較し `evidence/delta-comparison.md` へ
- [X] T012 unsafe path action plan（実 remove は Phase 1）を `evidence/unsafe-path-action-plan.md` へ
- [X] T013 base ADR を `evidence/adr-001-base.md` に確定（§4.3 gate 判定。不合格時: MIT 資産選択移植の比較検討を同 ADR 内に記録し plan.md を改訂）

### 取り込み（ADR = codemem 継続の場合のみ）

- [X] T014 pinned snapshot を `vendor/codemem/` へ取り込み（ローカル clone から。`.git` を含めない snapshot コピー + 出所記録 `vendor/codemem/VENDOR.md`）
- [X] T015 clean install 検証（vendor snapshot からの素の install 手順が通ること）。手順と結果を `evidence/clean-install.md` へ
- [X] T016 Exit gate 照合（SC-0A 全項目）→ speckit-verify-tasks → 2 本立てレビュー（/code-review → ponytail-review）→ main へマージ

**Checkpoint**: SC-0A 達成 = Phase 0B へ。ここまで product コード差分ゼロ。

---

## Phase 0B — Adapter / Sidecar Contract Harness（v6.1 §29 Phase 0B / §30 PR 2。2026-08-12 着手時詳細化）

**Goal**: Claude Code / Codex の exact stable binary で hook lifecycle を fixture 化し、§7.2 capability schema による version-pinned golden matrix と sidecar certification 可否判定を得る。product DB 変更なし。Tier A 宣言なし（未観測 cell は `unknown` — HI-23。全 cell 充足は Exit 要件ではない）。

**実行体制**: ブランチ `phase-0b-harness` + worktree。schema/組立コード = Grok 委譲（範囲宣言可: `harness/`）。capture 実行・隔離 rig・sidecar hostile harness・certification 判定 = Claude Code 自ら（セキュリティ関連: credential/config 隔離・process 隔離）。ToS 確認 = researcher。

- [X] T017 ブランチ `phase-0b-harness` + worktree 作成
- [X] T018 [P] harness scaffold: §7.2 の capability schema（TS 型 + JSON Schema）、fixture 記録形式、matrix assembler CLI を `harness/` に実装（委譲可。product コード・vendor/ に触れない独立 package）
- [X] T019 隔離 capture rig: scratch `CLAUDE_CONFIG_DIR`/HOME + 使い捨て repo + capture 専用 hooks のみ + `AGENT_MEMORY_INTERNAL_RUN=1` marker。ユーザー実環境の plugin/hook/メモリ DB を汚染しない構成を `harness/rig/` に作る（Claude Code 自ら）
- [X] T020 Claude Code capture: exact version 記録（capture 時点で毎 fixture に pin）+ hook lifecycle / timeout / first injection / compact / tool failure phase / interrupt / subagent を fixture 化 → `harness/fixtures/claude/`（実 CLI 実行 = Claude Code 自ら。子セッションは最小 prompt・拡張思考なし）
- [X] T021 Codex capture: 同上 → `harness/fixtures/codex/`
- [X] T022 golden matrix 組立: fixtures → §7.2 AdapterCapabilities（unknown 既定・coverage/limitations 明記・evidenceKind=real-cli-e2e）を version-pin 付きで `harness/matrix/` へ（組立コード委譲可、データ確定は Claude Code）
- [ ] T023 [P] Codex sidecar の provider ToS / documented-permission 一次ソース確認（§13.6 manifest 必須欄。OpenAI ToS + Codex CLI docs。researcher 委譲）。結果不明瞭 = 未認定でよい
- [X] T024 sidecar hostile harness: 不活性 hostile fixture（marker file を書くだけの偽 hook/plugin/AGENTS）+ process-group kill / pipe close / FD・descendant 残存検査を stub subprocess に対して実証 → `harness/sidecar/`（Claude Code 自ら）。Claude sidecar は `ANTHROPIC_API_KEY` 不在のため hostile E2E 不能 = **未認定（default disabled）が正当な判定**
- [ ] T025 certification 可否判定を §13.6 manifest 形式で `harness/sidecar/certification-decision.md` に記録（Claude / Codex 各 verdict。否も正当な Exit）
- [ ] T026 Exit gate 照合（SC-0B）→ speckit-verify-tasks → 2 本立てレビュー → main へマージ

## Phase 1 — Safety Boundary / Sole Writer（着手時に詳細化・全体セキュリティ関連 = Claude Code 自ら）

Exit: SC-1（write-capable handle = daemon のみの blocking 検証ほか）。v6.1 §29 Phase 1 + §5。

## Phase 2 — Canonical Identity / Event State Machine（着手時に詳細化）

Exit: SC-2。v6.1 §29 Phase 2 + §6 + §8 + §10.1。

## Phase 3 — Continuity State Machine [US1]（着手時に詳細化）

Exit: SC-3（= US1 Independent Test）。v6.1 §29 Phase 3 + §11。

## Phase 4 — Claude/Codex Vertical Routes [US3]（着手時に詳細化）

Exit: SC-4（= US3 Independent Test）。v6.1 §29 Phase 4。

## Phase 5 — Retrieval / Injection / MCP [US2]（着手時に詳細化）

Exit: SC-5（= US2 Independent Test）。v6.1 §29 Phase 5 + §16 + §18。

## Phase 6 — Generation Roles / Free Candidate [US4]（着手時に詳細化）

Exit: SC-6（= US4 Independent Test）。v6.1 §29 Phase 6 + §13–14。

## Phase 7 — Optional Embeddings（着手時に詳細化）

Exit: SC-7。v6.1 §29 Phase 7 + §15。

## Phase 8 — Core 1.0 Gates / Release（着手時に詳細化）

Exit: SC-8。v6.1 §29 Phase 8 + §27。

---

## Dependencies

- Phase 順序は直列: 0A → 0B → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8（v6.1 §29/§30 固定。並べ替え不可）
- User story の完成順: US1（Phase 3）→ US3（Phase 4）→ US2（Phase 5）→ US4（Phase 6）。
  各 story は該当 Phase の Exit で独立検証されるが、基盤 Phase（0A〜2）を共有する
- Phase 0A 内: T002 → T004–T009（[P] 並列可、Codex 複数ジョブ）→ T010–T013（直列・判定）→ T014–T016

## Parallel Example

- T004 / T005 / T006 / T008 は別リポ対象で衝突なし → Codex background job 並走（`delegate-batch` 相当、各ジョブの成果物パスが分離済み）

## Implementation Strategy

- MVP = US1（same-agent continuation）だが、v6.1 の順序制約により最短経路は 0A→0B→1→2→3。
  Phase 3 完了時点が最初のユーザー価値実証点（observer/embedding/sync 全 off の継続性）。
- 各 Phase のマージは Exit gate + 2 本立てレビュー + （委譲回）speckit-verify-tasks を通過条件とする。
