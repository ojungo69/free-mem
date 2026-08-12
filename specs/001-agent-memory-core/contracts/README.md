# Contracts: Agent Memory Continuity Platform — Core 1.0

正本は v6.1。本ディレクトリは外部契約の索引のみ（複製しない）。
契約の実体ファイル（JSON Schema / fixture）は実装 Phase で `harness/` と `src/` 側に生成し、
Exit gate の検証対象にする。

| 契約面 | v6.1 正本 | 消費者 | 実装 Phase |
|---|---|---|---|
| Agent Adapter Contract（hook lifecycle / capability 申告 / adapterDeliveryId） | §7 | Claude Code / Codex adapter（0B で fixture 化、4 で完成） | 0B, 4 |
| Event Intake API（daemon RPC。schema allowlist / size bound / version handshake） | §8, §19 | hook / CLI / MCP クライアント | 1, 2 |
| Checkpoint claim API（CAS: id+revision+fence+destination、heartbeat lease） | §11 | resume 経路（memory_resume / viewer） | 3 |
| MCP surface（local stdio 5 tools + user-authority CAS、2026-07-28 profile: POST-only Streamable HTTP / Origin / header-body cross-validation は remote 時） | §18 | エージェント（MCP クライアント） | 5 |
| Generation contract（role/prompt/schema data、run ledger、client-side schema validation） | §13–14 | job runner ↔ provider adapters | 6 |
| Embedding contract（EmbeddingRequest / EmbeddingItemResult、per-item ledger） | §15.2 | embedding pipeline | 7 |
| Sidecar certification manifest（ToS 確認・effective_config・hostile fixture・process-tree/FD・JSON 耐性） | §13.6 | sidecar 有効化判定 | 0B（判定）, 6（optional PR） |
| claude-mem importer（tag-pinned one-way、canonical rows のみ） | §14 | importer CLI | 6 |
| Configuration surface（profile_resolution_order / free_profile_batching / embedding backend） | §24 | インストーラ / ユーザー設定 | 1–6 で段階導入 |

範囲外（Core 1.0 では契約定義のみ・実装なし）: Personal Cloud sync protocol（§22）、remote MCP（§18/§22）。
