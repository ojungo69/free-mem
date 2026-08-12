# Phase 1 — Safety Boundary / Sole Writer 設計判断（正本）

日付: 2026-08-12 / 状態: Accepted（計画レビューゲート収束済み）
対象: tasks.md Phase 1 節（T027–T058）が参照する設計判断の永続記録。
tasks.md の「判断 #N」は本ファイルの表を指す。実装中の新規判断は本ファイルへ追記する。

入力: `agent-memory-final-spec-v6.md`（v6.1）§5/§8/§9/§17/§19/§20/§24/§25/§26/§28–29、
`evidence/unsafe-path-action-plan.md`（A1–A7）、`evidence/codemem/write-handle-classification.md`、
`evidence/adr-001-base.md`、ai-memory `writer.rs`（writer actor 設計参照元）。

## 削除対象の確定

Phase 0A 分類の fatal 10 経路 + 計画時実地検証で判明した未計上 3 経路 = **計 13**:

| 追加 # | 対象 | 位置 |
|---|---|---|
| +1 | Codex CLI sidecar 一式（3 関数 + dispatch + 分岐） | `packages/core/src/observer-client.ts:2256-2590`、dispatch 1894、分岐 1381/1558-1559/1590/1638（2026-08-13 実地照合済み） |
| +2 | codex-hook-inject の local store open | `packages/cli/src/commands/codex-hook-inject.ts:120-190`（`buildLocalPack`、store :125） |
| +3 | flushBoundaryRawEvents の direct store | `packages/cli/src/commands/claude-hook-ingest.ts:218-265`（store :237） |

完了判定は「全 production DB-open/auth 経路の disposition 全消化 + 機械検証」（T029 表 → T053 完全一致検証）。
凍結 evidence（Phase 0A 成果物）は非改変とし、3 経路は日付付き補遺として T029(c) で追記する。

## 主要設計判断

| # | 判断点 | 採用 |
|---|---|---|
| 1 | busy timeout | 5000ms（canonical DB のみ。lock.db は 0） |
| 2 | peer auth | **ADR-002**（下記）: Unix DAC（0700 dir + 0600 socket）正式化。EACCES/ECONNREFUSED → typed error 写像。別 UID 実接続テスト（可用時実走 / 不可時 permission assert）。Linux/WSL 以外 fail-closed |
| 3 | hook deadline | Agent 別 hard deadline を Phase 0B fixture 実測 host budget から**実装前成果物**として確定（Codex wrapper ≈2s 考慮。表 = Agent 別 hard cap / RPC cutoff / spool lock wait / fsync 余裕）。全体 − spool 専用予約（≥400ms）= RPC 上限。RPC は AbortController + socket timeout で cutoff（spool write ≤64KiB bounded の実測根拠込み）。予約超過 = dropped counter へ。実 hook 経由で timeout 直前保全検証。p95 目標（Node fallback 150ms）+ doctor 表示 |
| 4 | spool quota | 通常 128 MiB / 予約 16 MiB・最低 64 event / file 64 KiB / 集計 tmp+ready / quarantine 別枠 32 MiB（満杯 = ready 非削除・新規 quarantine 停止 + critical）。dropped counter = 事前確保固定領域 write-in-place（完全 disk full は stderr のみと限界明記）。claim = spool lock 下原子 |
| 5 | 設定キー | Phase 1 新設。cascade 縮小は observer-config 直接改修 |
| 6 | 破壊的 maintenance | daemon maintenance mode（writer actor 実行・期間中 adapter spool・CLI = RPC trigger）。daemon 停止 + CLI 直接 open は不採用（HI-4 違反のため） |
| 7 | daemon 外 DB handle | **完全ゼロ**: `connectReadOnly()` 残 2 箇所も RPC 移行（daemon 不在時 status = not running 表示）。TOCTOU/旧 inode 根絶、static scan の readonly 例外なし |
| 8 | redaction 配置 | spool/RPC 前の adapter 共通前処理必須（§8.1・HI-7 — spool ファイルにも redaction 前 secret を置かない）+ daemon intake 第 2 層。echo-loop 抑止 Phase 5 |
| 9 | secret scanner | vendor SecretScanner 土台 + gitleaks 互換 pin + syntax subset 契約。**全 rule（built-in/gitleaks/user）を kill 可能 worker で bounded 実行**（corpus は回帰試験専用。daemon 側常駐 worker で償却）+ event 単位総 deadline。mandatory pinned rule 変換失敗 = release gate fail。optional/user 失敗 = skip + doctor 警告 + degraded。ruleset hash = 実ロード集合から生成。長さ 512/件数 100 cap。不正 pattern = 本文非保存 / 処理 fail-open |
| 10 | install ownership manifest | 最小定義 + managed-block 機構（selector/marker + fingerprint + compare-before-remove + atomic write + roundtrip 検証） |
| 11 | exactly-once | mutation class 3 分類（T029 表の列）: **(A) transactional DB → daemon 内共有 dispatcher（RPC・spool import 両経路）+ receipt を副作用と同一 transaction** (B) filesystem 副作用（backup/restore/export）→ operation ID + durable journal (C) 非 spoolable maintenance → maintenance mode 直列のみ。既存 unique constraint で同等の event 系は表で証明し省略可。同一 key 異 payload = conflict → quarantine |
| 12 | viewer auth | read-only 化。**永続 Bearer（256-bit・0600・非 browser クライアント用・URL 不出）と、daemon 再起動ごとに生成する session 署名鍵を分離**。browser = 短寿命（60s）単回 nonce → httpOnly+SameSite=Strict session cookie（TTL 12h・再起動失効・logout・同時 session 上限 8 / 超過 = 最旧 evict・交換直後 history.replaceState + Referrer-Policy）。cookie + Origin 検証 + CSP + loopback 限定 bind + query 非ログ。API は Bearer / cookie 両受理 |
| 13 | 後続 Phase CLI | typed 無効化 stub（distill/embed 等。RPC 移植しない） |
| 14 | single-instance lock | 専用 `control/lock.db` に better-sqlite3 `BEGIN EXCLUSIVE` 存命保持（busy_timeout 0 / journal DELETE / 0600 / preflight 後・資源 open 前取得。SQLITE_BUSY = fail-closed）。**force-kill identity**: control root に 0600 identity record（PID + OS start time + exe/cmdline fingerprint + instance nonce）atomic 保存。通常停止 = 認証 socket 経由。force-kill 前に複数 identity 再検証・不一致 = 拒否 |
| 15 | migration 順序 | connect() から bootstrap/migration 分離。schema 変更（receipt 表含む）は backup + verify 成功後のみ |
| 16 | storage layout + restore | `data_dir/control/`（lock.db・identity・socket・token・spool・backups・restore journal = swap 対象外）/ `data_dir/db/`（`current` symlink pointer 経由。**pointer 形式は §19.6 version 管理下・永続契約にしない。transport/lock/pointer は薄い platform interface module 1 枚に集約、Windows/macOS は Phase 11 引継ぎ**）。restore 厳密順序: journal prepared fsync → staging fsync → pointer rename → 親 dir fsync → switched fsync → reopen+integrity → **committed fsync（integrity 後）**。**journal 更新自体も atomic replace 規律（tmp→fsync→rename→parent fsync、old/new pointer + artifact hash + operation ID 記載）**。journal recovery は lock 直後・DB open 前。旧版は committed まで保持・失敗時 pointer 戻し + fsync。in-place 禁止。legacy cutover の排他契約は T051 |

## ADR-002: daemon peer authentication = Unix DAC

日付: 2026-08-12 / 状態: **Accepted**

### 決定

daemon の RPC socket（Unix domain socket）に対する peer 認証は **filesystem DAC** で行う:
socket を `data_dir/control/`（mode 0700）配下に置き、socket 自体は 0600。
同一 UID のプロセスのみ接続可能。追加の token/credential 層は Phase 1 では導入しない。

### 根拠

- Core 1.0 の脅威モデルは「同一ユーザーの複数 agent プロセス」であり、UID 境界が正確に一致する。
- SO_PEERCRED 等の追加検証は同一 UID 内では識別力を持たず、複雑さだけ増える。
- viewer（TCP loopback）は別系の認証（判断 #12）を持つ。socket 経路と混同しない。

### 制約と検証

- EACCES / ECONNREFUSED は typed error に写像し、hook は fail-open（HI-1）。
- 別 UID からの接続拒否テスト: 別 UID が可用な環境では実接続で検証、不可の環境では
  permission bits の assert に切り替える（T043 / T055 の受入条件）。
- Linux/WSL2 以外のプラットフォームは fail-closed（起動拒否）。Windows/macOS の transport は
  Phase 11 で platform interface module（判断 #16）ごと差し替える。

## 並列計画の比較統合（記録）

codex-plan（独立第二計画）と段階構成一致。取り込み 8 件: disposition 化 / 未計上 3 経路 /
linter restricted-import / audited wrapper trace / owner set 定式化 / platform fail-closed /
backup hash + in-place 禁止 / legacy spool drain。
不採用 2 件: strace 前提 gate（本ホストに strace 不在。audited wrapper + lsof + mtime/hash で代替）/
backup 署名の Phase 1 実装（hash のみ。署名は ADR 記録 + Phase 8 blocking task — T052）。

## 計画レビュー履歴（記録）

- codex-review target=plan 継続 session iter1–5: blocking 31 + advisory 14 全採用 → ok:true
- fresh session 独立レビュー 4 巡: blocking 12 + advisory 10。platform 抽象化 1 件のみ縮小採用
  （plan.md の Linux/WSL2 コミット済みターゲットを根拠に thin interface + Phase 11 引継ぎへ縮小）、他全採用
- 最終 ok:true（advisory 3 — T047 前提 T046 追加 / T051 受入順序固定 / T055(a) 実 surface 列挙 — 反映済み）
- 計 **blocking 43 / advisory 27** を消化して収束。`~/.claude/review-status.json` 記録済み
  （2026-08-12T23:48:05+09:00, reviewer=codex, mode=plan）

主な修正例（レビューで捕捉された設計誤り）: spool 生 payload 保存（HI-7 違反）→ adapter 前処理必須化 /
「daemon 停止 + CLI 直接 open」の maintenance 案（HI-4 違反）→ maintenance mode /
Bearer×httpOnly の矛盾 → nonce→cookie 交換 / data_dir 全体 rename swap → control/db 分離 /
T040 完了条件の循環 → synthetic producer 限定化。
