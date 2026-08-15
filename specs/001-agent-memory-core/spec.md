# Feature Specification: Agent Memory Continuity Platform — Core 1.0（Phase 0A〜8）

**Feature Branch**: `001-agent-memory-core`

**Created**: 2026-08-12

**Status**: Ready for planning with Phase 3 preflight

**Input**: User description: "正本仕様は agent-memory-final-spec-v6.md (v6.1) 全体。今回のフィーチャー範囲は Phase 0A〜8 (Core 1.0, PR 1-10) の実装。v6.1 §29-30 のフェーズ定義と exit gate を要件として採用し、Phase 3 continuityは2026-08-16のresume preflight addendumで安全性・品質契約を補強する。"

> **正本と優先関係**: 要件・スキーマ・ゲートの基礎正本は
> `agent-memory-final-spec-v6.md`（v6.1、リポジトリルート）である。
> `resume-continuity-addendum-v6.2.md` は §7 / §10 / §11 / §17 / §27 のcontinuity詳細だけを
> 限定的に上書きし、その範囲ではaddendumが優先する。その他はv6.1が優先する。
> ユーザー決定6件はv6.1付録A、Codex壁打ち反映（B-01〜B-13）は付録B、
> Phase 3のOSS比較・採否は `evidence/phase3-resume-oss-comparison.md` に記録する。
> 本ファイルは各フェーズの受け入れ基準を索引化し、正本の型や状態遷移を重複定義しない。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 作業の中断と再開（継続性） (Priority: P1)

コーディング CLI（Claude Code / Codex）のユーザーが、セッション中断（クラッシュ・compact・
明示終了）の後に新しいセッションを開始すると、直前の作業状態（チェックポイント）が提示され、
現在のprompt・workspaceと互換性がある場合だけ続きとして復元される。同じチェックポイントが
複数セッションに二重配布されず、誤ったresumeは最初の正常turnだけでacceptedにならない。

**Why this priority**: プラットフォームの中核価値。これが成立しない限り他の全機能は意味を持たない。

**Independent Test**: observer / embedding / sync をすべて無効にした状態で、Claude Code と
Codex それぞれの same-agent continuation が成功し、typed task state・pending operation・
workspace reconciliation・delivery attemptの全deterministic gateを通ること（Phase 3 Exit）。

**Acceptance Scenarios**:

1. **Given** 作業途中のセッションがクラッシュした状態、**When** 同一エージェントで新セッションを開始、**Then** crash recoveryチェックポイントが提示され、現在workspaceとの照合後に続きの作業状態が復元される
2. **Given** 未配布チェックポイント1件と並行セッション2本、**When** 両方が同時にclaim、**Then** CAS（revision + fence）により一方だけがactive delivery attemptを取得する
3. **Given** チェックポイント配送後に別タスクを開始、**When** 最初のturnが正常終了、**Then** 関連engagement evidenceがないため旧checkpointはacceptedにならない
4. **Given** command開始後にterminal eventなしでクラッシュ、**When** resume capsuleを生成、**Then** operationは`unknown / verify_first`として表示され、自動再実行されない
5. **Given** checkpoint時点からHEAD・dirty tree・対象fileが非互換に変化、**When** smart resumeを評価、**Then** full checkpointは自動注入されず、照合理由と確認候補だけが提示される
6. **Given** heuristicが新規task boundaryを提案、**When** user/runtimeによる確認がない、**Then** 旧task lineageは削除・supersedeされない

### User Story 2 - 記憶の蓄積と検索（メモリ） (Priority: P2)

ユーザーの作業から抽出・手動登録された記憶（DurableMemory）がローカルに永続化され、
新しいセッション開始時・明示検索時に、日本語・英語・混在クエリで正しく検索・注入される。
Derived observationはsource evidenceを保持し、古い事実は無言上書きせず履歴・失効状態を持つ。

**Why this priority**: 継続性（P1）の次に価値が高い。検索正しさは Phase 5 で独立に検証可能。

**Independent Test**: ベクトル無効（FTS のみ）のまま 100k 件スケールで JP/EN/mixed の
retrieval gate（v6.1 §27.6）と echo-loop テストが通り、presentation-level dedupeでもsource evidenceが失われないこと（Phase 5 Exit）。

**Acceptance Scenarios**:

1. **Given** 日本語2文字クエリ、**When** 検索、**Then** exact/n-gramルーティングによりtrigramの3文字未満不一致問題を回避して結果が返る
2. **Given** 注入済みコンテキストを含む会話、**When** イベント取り込み、**Then** self-ingestion preventionにより注入内容が再抽出されない（echo-loop防止）
3. **Given** consolidated observationとsupporting factが同時に候補、**When** context packを作成、**Then** packは重複を抑制できるが保存済みsource evidenceは削除しない

### User Story 3 - エージェント間の作業引き継ぎ（クロスエージェント） (Priority: P3)

Claude Code で中断した作業を Codex で再開できる（逆方向も）。4つのdirected route
（Claude ⇄ Codex、self含む）すべてでmemory + typed checkpointが引き継がれる。

**Why this priority**: 差別化価値だが、P1（same-agent）成立が前提。Phase 4で検証。

**Independent Test**: 4/4 directed routeシナリオがpassし、source Agentとdestination Agentの
capability差がdelivery strategyへ正しく反映されること（Phase 4 Exit）。

**Acceptance Scenarios**:

1. **Given** Claude Codeで作成されたチェックポイント、**When** Codexセッションが受け入れ、**Then** capability差分は4値（native/synthesized/unsupported/unknown）+ evidence付きで扱われ、未確認経路は自動的にdowngradeする
2. **Given** destination Agentがprompt-aware injectionを実機証明できない、**When** smart resumeを要求、**Then** source inspectionだけでTier A扱いせず`session_start_full` / `next_prompt_synthesized` / `manual_only`の証明済み経路へ落とす

### User Story 4 - ゼロコスト運用（無料枠生成） (Priority: P4)

記憶抽出・要約などの生成処理は、認定済み無料プロファイル（hard cap 80 req/day、
リトライ込み）でコスト0円で動作する。キャップ超過時は抽出をスキップ・キュー退避し、
コア機能（継続性・検索）は劣化しない。

**Why this priority**: ユーザー決定④の中核だが、生成なしでもtyped checkpoint・検索は機能する。

**Independent Test**: probe manifest + dense/sparse両traceで少なくとも1つの
free-certified profileが認定され、provider swapでデータロスがない（Phase 6 Exit）。

**Acceptance Scenarios**:

1. **Given** 日次80 req消費済み、**When** 追加の抽出要求、**Then** 外部リクエストは発生せずキュー退避、翌日catch-up
2. **Given** Claudeサブスクリプション資格情報が端末に存在、**When** どの生成経路でも、**Then** それを利用しない（付録B.3恒久除外。Codex sidecarはcertification合格 + 明示opt-inのみ）
3. **Given** generation provider停止、**When** compact/crash recovery、**Then** canonical observed stateだけでresumeが成立する

### Edge Cases

- v6.1 §8（重複x10 / 並行 / 遅延イベント）、§6（identity衝突: fork/rename/shallow/worktree/no-remote/monorepo/WSL）、§22.11（tombstone/復活）に加え、v6.2 addendumのtask boundary proposal、pending operation、workspace drift、delivery attempt、safe capsule、resume mode matrixをblocking fixtureに含める。

## Requirements *(mandatory)*

### Functional Requirements

各FRはv6.1の該当章を基礎とし、continuity範囲はv6.2 addendumを合わせて要件本文とする。

- **FR-0A**: Evidence Freeze / Base Bake-off — v6.1 §29 Phase 0A + §4.3 base gate。候補3リポ（codemem 26438e75 / ai-memory a9e9a24d / remem cde8bc05）のpin・upstreamテスト・license/SBOM・write-handle inventory・delta比較 → base ADR。機能変更なし。
- **FR-0B**: Adapter / Sidecar Contract Harness — v6.1 §29 Phase 0B + §7.2 + §13.6。Claude/Codex hook golden matrix（version-pinned）、capability schema、sidecar hostile harness。未観測cellは`unknown`。
- **FR-1**: Safety Boundary / Sole Writer — v6.1 §29 Phase 1 + §5。daemon単一writer、thin RPC client化、atomic spool、local peer auth、install ownership manifest、backup baseline。
- **FR-2**: Canonical Identity / Event State Machine — v6.1 §29 Phase 2 + §6 + §8 + §10.1。opaque UUID、adapterDeliveryId冪等、turn state、late correction invalidation、session liveness。
- **FR-3P**: Phase 3 Preflight — v6.2 addendum §2〜§14。exact Claude/Codex prompt/compact E2E、task-scoped typed state、PendingOperation、workspace reconciliation、immutable checkpoint history、delivery attempt、safe capsule、#8 metricsをfreezeする。FR-3 product実装の開始条件。
- **FR-3**: Continuity State Machine — v6.1 §29 Phase 3 + v6.2 addendum。task lineage/binding、`CanonicalWorkStateV1`、checkpoint disposition history、delivery claim/fence/lease/engagement、crash recovery、capability-driven smart resume、`memory_resume`。
- **FR-4**: Claude/Codex Vertical Routes — v6.1 §29 Phase 4 + v6.2 capability gate。両adapter完成、4 directed routes、capability profile公開（Tierはevidence hash + exact native versionに付与）。
- **FR-5**: Retrieval / Injection / MCP — v6.1 §29 Phase 5 + §16 + §18 + v6.2 §10/§12。contentful dual FTS、fixed RRF、CJK routing、schema-validated safe capsule、envelope/provenance stripping、local stdio MCP 5 tools + user-authority CAS、source-evidence-preserving dedupe。
- **FR-6**: Generation Roles / Free Candidate — v6.1 §29 Phase 6 + §13〜14。単一job runner、run ledger/cache、probe manifest + hard budget認定、claude-mem one-way importer。sidecarは別optional PR。
- **FR-7**: Optional Embeddings — v6.1 §29 Phase 7 + §15。item-addressable contract、per-item ledger、sqlite-vec SHA pin、atomic switch、FTS-only fallback。
- **FR-8**: Core 1.0 Gates / Release — v6.1 §29 Phase 8 + §27 + v6.2 §14 + #8。Track 1 deterministic gates、resume non-inferiority、backup/restore、install matrix、72h soak、signed artifacts。

### Key Entities

正本はv6.1の基礎スキーマとv6.2 addendum: NormalizedEvent（v6.1 §8）/ Session（v6.1 §10）/
SessionTaskBinding・CanonicalWorkStateV1・PendingOperation・ContinuationCheckpointV2・
CheckpointDispositionEvent・CheckpointDeliveryAttempt・WorkspaceReconciliationReport（v6.2）/
DurableMemory（v6.1 §12 + v6.2 source/temporal history）/ CapabilityEvidence（v6.1 §7.2 + v6.2 delivery strategy）/
EmbeddingRequest・ledger（v6.1 §15）/ SyncOperation（v6.1 §22、Core 1.0では未実装）。

## Success Criteria *(mandatory)*

### Measurable Outcomes

各フェーズのExit gateを受け入れ基準とする。決定論的critical invariantは平均点でなく100% passとする。

- **SC-0A**: base ADR確定（write-handle inventory完了 + fatal/non-fatal分類 + delta比較記録）、clean install、unsafe path action plan
- **SC-0B**: Claude/Codex capability golden matrix（version-pinned）、sidecar certification可否判定。source/READMEだけでTierを上げない
- **SC-1**: runtime DB-open trace + static scanでwrite-capable handle = daemonのみ、fault injection tests、no Agent blockage、backup restore smoke
- **SC-2**: identity collision matrix pass、duplicate x10 / parallel・late event property tests pass
- **SC-3P**: exact Claude/Codex prompt-aware・compact E2E、typed continuity schema hash、pending-operation fixture、workspace reconciliation matrix、delivery-attempt property tests、safe renderer negative tests、deterministic report再現性がpass。未証明capabilityは適切にdowngrade
- **SC-3**: observer/embedding/sync全offでClaude・Codex各same-agent continuation成功。duplicate full injection、wrong scope auto-resume、incompatible auto-resume、unsafe unknown replay、early acceptance、stale fence、capsule boundary破壊がすべて0
- **SC-4**: 4/4 directed routeシナリオpass、capability profile公開、destination Agentの証明済みstrategyだけを使用
- **SC-5**: retrieval gate（v6.1 §27.6）+ echo-loop + source-evidence preservation pass、100k scale p95目標内（FTS-only）
- **SC-6**: provider swap without data loss、free-certified profile ≥ 1、generation停止時もcanonical continuation pass
- **SC-7**: generation switch test / vector off fallback pass、embedding gate（v6.1 §27.8）pass
- **SC-8**: Core 1.0 release（Claude + Codex）、release後schema freeze。#8の主要resume scenarioでclaude-mem baselineに対するfrozen non-inferiority gateをpassし、未達はreviewed exception ADRなしにrelease不可

### Behavioral Measures

Phase 3 / Phase 4 / Phase 8 reportは最低限以下を記録する。

- wrong-resume rate
- unnecessary-hint rate
- candidate-selection accuracy
- critical state recall
- fabricated/unsupported state rate
- stale-field rate
- user re-explanation turns / tokens
- first useful action latency
- resume後のtask completion success
- hint/full capsule token count
- claude-mem baseline delta

## Assumptions

- Phase順序はv6.1 §30を基礎とするが、**FR-3P / SC-3PはPhase 3 product実装より前のblocking barrier**として挿入する。
- #1 Stage 0/1がTS継続かRust移行かを決定するまで、大規模なPhase 2以降のTS product codeを増やさない。FR-3Pのschema・fixture・harnessはruntime-language-neutralなので並行可能。
- Phase 9〜11（Agent expansion / Personal Cloud / Platform 1.0）は本フィーチャーの範囲外（後続フィーチャー）。
- 2026-08-14のユーザー決定により、公開準備ゲート通過後のGitHub source公開とPRは許可する。これはCore 1.0 releaseではなく、runtime dataのローカル境界、tag/package/release禁止（Phase 8まで）を変更しない。
- ベースがbake-offで不合格の場合の分岐（MIT資産選択移植）はv6.1 Phase 0A Exitの規定に従う。
- `resume_mode=off`はcompactを含む全automatic hint/injectionを無効にする。manual `memory_resume`は利用可能。
- Cline型shadow GitはCore 1.0必須にしない。workspace auto-restoreは別ADR・security gate・evidence後に追加可能。
