# T010 — codemem write-handle / auth path fatal・non-fatal 分類

対象 snapshot: `26438e75ce1d0fec6be34981f15045a15c89658b`
入力: `write-handle-inventory.md`（T007、file:line 付き全数）+ 決定的箇所のソース直接照合（本文書内に記載）
判定者: Claude Code（セキュリティ関連のため委譲なし）。判定基準: v6.1 §4.3 base gate / §3 Hard Invariant 4（sole writer）/ 付録B.3（B-06 法的制約）/ §13.6（sidecar certification）

**分類の意味**: fatal = Phase 1 で物理削除または非到達化が必須（存在したままでは v6.1 の Hard Invariant / 法的制約に抵触）。non-fatal = Phase 1 で thin RPC client 化・daemon 内移設・無効化で対応可能。fatal が「局在していて削除可能」であれば base 採用自体は妨げない（§4.3）。

## FATAL（8 経路）

### F1. Anthropic OAuth consumer（SSE 直接ストリーミング）
`packages/core/src/observer-client.ts:2010-2067` 付近 — OAuth token（Claude サブスク資格情報）で `api.anthropic.com` へ直接リクエスト。**B-06 で確認済みの規約明示禁止経路そのもの**（Anthropic は Free/Pro/Max 資格情報経由の第三者ルーティングを不許可）。物理削除。

### F2. Codex consumer（cached OAuth 直接利用）
`packages/core/src/observer-client.ts:1989-2027`（ソース照合済み: `buildCodexHeaders(this._codexAccess, this._codexAccountId)` で cached OAuth access token を codex endpoint へ直接送信）+ ヘッダ構築 `packages/core/src/observer-auth.ts:163-183`。ChatGPT サブスク資格情報の第三者直接ルーティング = F1 と同じ法的 lens（§13.6 に ToS 確認を要件化済み。文書化された許可が確認されるまで到達不能化）。物理削除（sidecar 経路とは別物である点に注意 — これは API 直叩き）。

### F3. Claude CLI sidecar（plain `-p` + bypassPermissions）
`packages/core/src/observer-client.ts:2074-2245`（ソース照合済み: `-p --output-format json --permission-mode bypassPermissions`、`--bare` なし）。plain `-p` はサブスク auth を継承しうる（B-06 検証済み）うえ、`bypassPermissions` で hostile config リスクも負う。v6.1 の設計は「`--bare` + `ANTHROPIC_API_KEY`（BYOK）+ certification 合格時のみ optional」なので、この実装は削除し、v6.1 §13.6 準拠の実装に置換（Phase 6 の別 optional PR）。

### F4. 第三者 OAuth キャッシュ読出し（OpenCode auth cache）
`packages/core/src/observer-auth.ts:49-158` — OpenCode の OAuth/API-key キャッシュファイルを読み、provider entry / access token / account を抽出。他アプリの資格情報ストアの undocumented 読出し = v6.1 §29 Phase 1 の「undocumented/private provider/auth loader」該当。物理削除（credential cascade の `oauth` 段を除去し、explicit/env/file のみに縮小）。

### F5. Claude hook direct DB write fallback
`packages/cli/src/commands/claude-hook-ingest.ts:128-199`（`directEnqueue` が daemon を介さず `connect()` で書込み）。Hard Invariant 4 違反（hook が write-capable handle を持つ）。Phase 1 で atomic spool のみに置換。

### F6. Codex hook direct DB write fallback
`packages/cli/src/commands/codex-hook-ingest.ts:128-197`。F5 と同一クラス。同置換。

**F5/F6 補遺（runtime-audit.md より）**: inject / file-context hook にも write-capable store の直接 open がある — `claude-hook-inject.ts:197-235`（viewer 不達時の local `MemoryStore` fallback、pack 構築が usage_events を書く）、`claude-hook-file-context.ts:263-370`（store open + retrieval ledger 書込み）。同一クラス（hook が write handle を持つ）として Phase 1 で同様に除去し、read は daemon RPC・記録は event 投入経由に置換。

### F7. workspace bootstrap template の直接 DB 書込み
`scripts/templates/workspace-codemem-bootstrap.sh:73` — シェルテンプレート内のインライン Node が better-sqlite3 を直接構築し peer を upsert。daemon 外の書込み経路 + テンプレート経由で配布される。削除（Core 1.0 では sync/peer 自体が範囲外）。

### F8. 外部 credential command loader
`packages/core/src/observer-auth.ts:185-206` — 設定値を任意コマンドとして実行し資格情報を取得。設定ファイル汚染 → 任意コマンド実行の面があり、v6.1 の credential 設計（env/file）に存在しない。削除（縮小後の cascade に含めない）。

## NON-FATAL — Phase 1 で thin RPC client 化 / daemon 内移設

- **CLI の MemoryStore 直接構築群**（memory/db/distill/embed/enqueue-raw-event/pack/recent/search/stats ほか、Appendix A の production 分）: daemon RPC client 化。
- **MCP stdio / MCP HTTP の store 所有**（`packages/mcp-server/src/stdio.ts:7-19`, `http.ts:89,214-230`）: RPC client 化。
- **viewer server の共有 store**（`packages/viewer-server/src/index.ts:48-61` + memory/raw-events/stats routes）: RPC client 化。
- **maintenance / backfill 群の `connect()`**（with-db/init-vacuum/各 backfill/vector-migration/sync-retention 等）: daemon 内 jobs へ移設。
- **`connectReadOnly()` 2 箇所**（status.ts:356, with-db.ts:36）: 存置可。ただし v6.1 の「read-only handle は DDL/bootstrap 禁止」検証対象に含める。
- **export/import**（`export-import.ts:309-728`）: daemon RPC 経由に置換（機能は §20/§14 で存続）。
- **hook の spool 経路**（direct fallback 除去後の残部）: v6.1 §8 の atomic spool 契約に適合させる。

## OUT-OF-SCOPE carve-out — Core 1.0 で無効化・除去（Phase 10 で v6.1 §22 設計に置換）

- **peer sync / replication 全面**: sync-pass / sync-replication / sync-bootstrap / sync-daemon / sync-discovery（mDNS）/ sync-http-client / sync-identity / sync-auth（Ed25519・keychain）。v6.1 §22 は signed op log + head-set CAS の別設計であり、この実装は引き継がない。
- **coordinator 全面**: better-sqlite / D1 両 store、coordinator-api/runtime/actions、Cloudflare worker package、13 本の D1 migrations。
- **sharing / recipient-policy 全面**: share-operation / share-provisioning / recipient-policy-* / scope-membership-cache / viewer sync routes（7,652 行の routes/sync.ts を含む）。
- **MCP HTTP の OAuth provider / OIDC**（oauth.ts / provider.ts / oidc.ts）: Core 1.0 は local stdio のみ（v6.1 §18）。remote MCP は Phase 10 で 2026-07-28 profile 準拠の別実装。

## 設計置換（v6.1 が別設計を規定 — 削除は設計都合であり fatal ではない）

- **embeddings**: `@xenova/transformers` 動的 import（embeddings.ts:124-190）→ v6.1 §15（sqlite-vec SHA pin、既定 off）。
- **observer config の OpenCode 依存**（observer-config.ts:102-134）: v6.1 §24 の自前 config へ。
- **extraction tier routing**（extraction-tier-routing.ts）: v6.1 §13 の単一 job runner + role data へ。
- **credential cascade**: `explicit -> env -> oauth -> file -> command` → `explicit/env/file` のみ（F4/F8 除去の帰結）。

## 集計と gate 所見

| 区分 | 件数 | Phase 1 での扱い |
|---|---|---|
| fatal | 8 経路 | 物理削除・非到達化（F1–F4, F8 = auth 系 / F5–F7 = sole-writer 系） |
| non-fatal 書込み表面 | 7 グループ | thin RPC client 化 / daemon 移設 |
| carve-out | 4 領域 | Core 1.0 で無効化（Phase 10 置換） |

**所見**: fatal 8 経路はすべて特定ファイル・特定関数に局在し（observer-auth.ts / observer-client.ts の dispatch 部 / 2 つの hook ingest fallback / 1 テンプレート）、削除により周辺機能が崩壊する構造ではない。dispatch 順序（`observer-client.ts:1886-1922`）から F1–F3 を外しても direct Anthropic/OpenAI HTTP（BYOK・API key）経路は独立に残る。**§4.3 gate の「unsafe path が除去可能であること」は成立見込み**。最終判定は T011 delta 比較と合わせて T013 base ADR で行う。
