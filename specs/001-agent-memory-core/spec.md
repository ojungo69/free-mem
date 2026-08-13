# Feature Specification: Agent Memory Continuity Platform — Core 1.0（Phase 0A〜8）

**Feature Branch**: `001-agent-memory-core`

**Created**: 2026-08-12

**Status**: Ready for planning

**Input**: User description: "正本仕様は agent-memory-final-spec-v6.md (v6.1) 全体。今回のフィーチャー範囲は Phase 0A〜8 (Core 1.0, PR 1-10) の実装。v6.1 §29-30 のフェーズ定義と exit gate をそのまま要件として採用し、新規要件を発明しない。"

> **正本**: この spec.md は薄い索引である。要件・スキーマ・ゲートの正本は
> `agent-memory-final-spec-v6.md`（v6.1、リポジトリルート）であり、矛盾時は常に v6.1 が優先する。
> ユーザー決定 6 件は v6.1 付録A、Codex 壁打ち反映（B-01〜B-13）は付録B に記録済み。
> 本ファイルでは各フェーズの受け入れ基準（= v6.1 の Exit gate）を索引化するに留め、要件を再発明しない。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 作業の中断と再開（継続性） (Priority: P1)

コーディング CLI（Claude Code / Codex）のユーザーが、セッション中断（クラッシュ・compact・
明示終了）の後に新しいセッションを開始すると、直前の作業状態（チェックポイント）が提示され、
受け入れると作業を続きから再開できる。同じチェックポイントが複数セッションに二重配布される
ことはない。

**Why this priority**: プラットフォームの中核価値。これが成立しない限り他の全機能は意味を持たない。

**Independent Test**: observer / embedding / sync をすべて無効にした状態で、Claude Code と
Codex それぞれの same-agent continuation が成功すること（v6.1 Phase 3 Exit）。

**Acceptance Scenarios**:

1. **Given** 作業途中のセッションがクラッシュした状態、**When** 同一エージェントで新セッションを開始、**Then** crash recovery チェックポイントが提示され、受け入れで作業状態が復元される
2. **Given** 未配布チェックポイント 1 件と並行セッション 2 本、**When** 両方が同時に claim、**Then** CAS（revision + fence）により一方だけが受け取る（at-most-one）
3. **Given** チェックポイント配布後にタスク境界（explicit / new_substantive_task）が発生、**When** 次の crash recovery、**Then** 境界前のチェックポイント lineage は継承されない

### User Story 2 - 記憶の蓄積と検索（メモリ） (Priority: P2)

ユーザーの作業から抽出・手動登録された記憶（DurableMemory）がローカルに永続化され、
新しいセッション開始時・明示検索時に、日本語・英語・混在クエリで正しく検索・注入される。

**Why this priority**: 継続性（P1）の次に価値が高い。検索正しさは Phase 5 で独立に検証可能。

**Independent Test**: ベクトル無効（FTS のみ）のまま 100k 件スケールで JP/EN/mixed の
retrieval gate（v6.1 §27.6）と echo-loop テストが通ること（Phase 5 Exit）。

**Acceptance Scenarios**:

1. **Given** 日本語 2 文字クエリ、**When** 検索、**Then** exact/n-gram ルーティングにより trigram の 3 文字未満不一致問題を回避して結果が返る
2. **Given** 注入済みコンテキストを含む会話、**When** イベント取り込み、**Then** self-ingestion prevention により注入内容が再抽出されない（echo-loop 防止）

### User Story 3 - エージェント間の作業引き継ぎ（クロスエージェント） (Priority: P3)

Claude Code で中断した作業を Codex で再開できる（逆方向も）。4 つの directed route
（Claude ⇄ Codex、self 含む）すべてで memory + checkpoint が引き継がれる。

**Why this priority**: 差別化価値だが、P1（same-agent）成立が前提。Phase 4 で検証。

**Independent Test**: 4/4 directed route シナリオが pass（Phase 4 Exit）。

**Acceptance Scenarios**:

1. **Given** Claude Code で作成されたチェックポイント、**When** Codex セッションが受け入れ、**Then** capability 差分は 4 値（native/synthesized/unsupported/unknown）+ evidence 付きで扱われ、fail-closed で劣化する

### User Story 4 - ゼロコスト運用（無料枠生成） (Priority: P4)

記憶抽出・要約などの生成処理は、認定済み無料プロファイル（hard cap 80 req/day、
リトライ込み）でコスト 0 円で動作する。キャップ超過時は抽出をスキップ・キュー退避し、
コア機能（継続性・検索）は劣化しない。

**Why this priority**: ユーザー決定④の中核だが、生成なしでもチェックポイント・検索は機能する。

**Independent Test**: probe manifest + dense/sparse 両 trace で少なくとも 1 つの
free-certified profile が認定され、provider swap でデータロスがない（Phase 6 Exit）。

**Acceptance Scenarios**:

1. **Given** 日次 80 req 消費済み、**When** 追加の抽出要求、**Then** 外部リクエストは発生せずキュー退避、翌日 catch-up
2. **Given** Claude サブスクリプション資格情報が端末に存在、**When** どの生成経路でも、**Then** それを利用しない（付録B.3 恒久除外。Codex sidecar は certification 合格 + 明示 opt-in のみ）

### Edge Cases

- v6.1 §8（重複 x10 / 並行 / 遅延イベント）、§6（identity 衝突: fork/rename/shallow/worktree/no-remote/monorepo/WSL）、§11（claim 競合・lease 失効・heartbeat 停止）、§22.11（tombstone/復活）に列挙済み。本 spec では再掲しない。

## Requirements *(mandatory)*

### Functional Requirements

各 FR は v6.1 の該当章をそのまま要件本文とする（番号は Phase に対応）。

- **FR-0A**: Evidence Freeze / Base Bake-off — v6.1 §29 Phase 0A + §4.3 base gate。候補 3 リポ（codemem 26438e75 / ai-memory a9e9a24d / remem cde8bc05）の pin・upstream テスト・license/SBOM・write-handle inventory・delta 比較 → base ADR。機能変更なし。
- **FR-0B**: Adapter / Sidecar Contract Harness — v6.1 §29 Phase 0B + §7.2 + §13.6。Claude/Codex hook golden matrix（version-pinned）、capability schema、sidecar hostile harness。product DB 変更なし。
- **FR-1**: Safety Boundary / Sole Writer — v6.1 §29 Phase 1 + §5。daemon 単一 writer、thin RPC client 化、atomic spool、local peer auth、install ownership manifest、backup baseline。
- **FR-2**: Canonical Identity / Event State Machine — v6.1 §29 Phase 2 + §6 + §8 + §10.1。opaque UUID、adapterDeliveryId 冪等、turn state、late correction invalidation、session liveness。
- **FR-3**: Continuity State Machine — v6.1 §29 Phase 3 + §11。checkpoint claim fence/lease/CAS、task lineage/boundary、crash recovery、smart resume、`memory_resume`。
- **FR-4**: Claude/Codex Vertical Routes — v6.1 §29 Phase 4。両 adapter 完成、4 directed routes、capability profile 公開（Tier は evidence hash に付与）。
- **FR-5**: Retrieval / Injection / MCP — v6.1 §29 Phase 5 + §16 + §18。contentful dual FTS、fixed RRF、CJK routing、envelope/provenance stripping、local stdio MCP 5 tools + user-authority CAS。
- **FR-6**: Generation Roles / Free Candidate — v6.1 §29 Phase 6 + §13〜14。単一 job runner、run ledger/cache、probe manifest + hard budget 認定、claude-mem one-way importer。sidecar は別 optional PR。
- **FR-7**: Optional Embeddings — v6.1 §29 Phase 7 + §15。item-addressable contract、per-item ledger、sqlite-vec SHA pin、atomic switch、FTS-only fallback。
- **FR-8**: Core 1.0 Gates / Release — v6.1 §29 Phase 8 + §27。Track 1 deterministic gates、backup/restore、install matrix、72h soak、signed artifacts。

### Key Entities

正本は v6.1 のスキーマ定義（§ 参照）: NormalizedEvent（§8）/ Session（§10）/
SessionWorkState・SessionLineage・ContinuationCheckpoint（§11）/ DurableMemory（§12）/
CapabilityEvidence（§7.2）/ EmbeddingRequest・ledger（§15）/ SyncOperation（§22、Core 1.0 では未実装）。

## Success Criteria *(mandatory)*

### Measurable Outcomes

各フェーズの Exit gate（v6.1 §29）をそのまま受け入れ基準とする。ブロッキング判定は
決定論的検証のみ（constitution Principle V / v6.1 §27 Track 1）。

- **SC-0A**: base ADR 確定（write-handle inventory 完了 + fatal/non-fatal 分類 + delta 比較記録）、clean install、unsafe path action plan
- **SC-0B**: Claude/Codex capability golden matrix（version-pinned）、sidecar certification 可否判定
- **SC-1**: runtime DB-open trace + static scan で write-capable handle = daemon のみ（Hard Invariant 4 の blocking 検証）、fault injection tests、no Agent blockage、backup restore smoke
- **SC-2**: identity collision matrix pass、duplicate x10 / parallel・late event property tests pass
- **SC-3**: observer/embedding/sync 全 off で Claude・Codex 各 same-agent continuation 成功、claim/fence property tests（§27.10）pass
- **SC-4**: 4/4 directed route シナリオ pass、capability profile 公開
- **SC-5**: retrieval gate（§27.6）+ echo-loop test pass、100k scale p95 目標内（FTS-only）
- **SC-6**: provider swap without data loss、free-certified profile ≥ 1
- **SC-7**: generation switch test / vector off fallback pass、embedding gate（§27.8）pass
- **SC-8**: Core 1.0 release（Claude + Codex）、release 後 schema freeze

## Assumptions

- 実装順序・PR 分割は v6.1 §30（PR 1–10、Phase 0A〜8 に 1:1 対応）に従う。
- Phase 9–11（Agent expansion / Personal Cloud / Platform 1.0）は本フィーチャーの範囲外（後続フィーチャー）。
- 2026-08-14 のユーザー決定により、公開準備ゲート通過後の GitHub source 公開と PR は許可する。これは Core 1.0 release ではなく、runtime data のローカル境界、Phase 順序、Exit gate、tag/package/release 禁止（Phase 8 まで）を変更しない。
- ベースが bake-off で不合格の場合の分岐（MIT 資産選択移植）は v6.1 Phase 0A Exit の規定に従い、その時点で plan を改訂する。
