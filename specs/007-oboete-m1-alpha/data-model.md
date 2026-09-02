# Data Model: oboete M1

All tables live in `~/.oboete/memory.db`. Migrations are numbered SQL files
(`src/db/migrations/0001_core.sql`, `0002_memory_search.sql`, `0003_operations.sql`) embedded at
build time and applied forward only, one transaction each, by `setup`, the worker, and user-facing
commands; the hook never migrates and spools when `PRAGMA user_version` is older than the bundle's
latest migration. A smoke test applies every migration on an empty database and on the previous
version's fixture database on Node 22.16 and 24.x. Time columns are Unix milliseconds. Ordinary
tables are `STRICT`; FTS5 virtual tables cannot be. Every write from the worker is fenced by
`worker_lease.owner_token`.

## schema_migrations

| column | type | notes |
|---|---|---|
| version | INTEGER PK | matches `PRAGMA user_version` after apply |
| name, sha256 | TEXT | checksum of the SQL text; mismatch aborts |
| applied_at | INTEGER | |

## repos

| column | type | notes |
|---|---|---|
| id | TEXT PK | first 16 hex of sha256 over the normalized identity (FR-004) |
| identity_kind | TEXT | `remote` or `common_dir` (machine-local; see import mapping) |
| normalized_identity | TEXT UNIQUE | `host/path` or realpath of the git common dir |
| display_root | TEXT | last seen working tree |
| created_at, last_seen_at | INTEGER | |

## sessions

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| repo_id | TEXT FK | |
| agent | TEXT | `claude`, `codex`, `grok`, `pi`, `unknown`; provenance only |
| native_session_id | TEXT | UNIQUE with agent |
| conversation_id | TEXT | equals `id` for a fresh session; inherited on resume; new on fork |
| model | TEXT | reported model when the agent supplies one (context window lookup) |
| started_at, ended_at | INTEGER | |
| status | TEXT | `active`, `ended` |
| turn_count | INTEGER | |
| latest_summary_memory_id | TEXT | set when the session-end batch is applied |

## turns

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| session_id | TEXT FK | |
| ordinal | INTEGER | UNIQUE with session_id |
| started_at, ended_at | INTEGER | `ended_at` NULL = unfinished; never feeds retrieval |

## raw_events (append-only acceptance point)

| column | type | notes |
|---|---|---|
| id | TEXT PK | sha256 over (agent, native_session_id, kind, native event id or tool_call_id, turn ordinal, delivery ordinal, content_hash); identical re-delivery collapses, a repeated identical prompt does not |
| repo_id, session_id, turn_id | TEXT | |
| agent | TEXT | |
| kind | TEXT | `session_start`, `prompt`, `tool_call`, `tool_result`, `tool_failure`, `turn_end`, `session_end`, `compaction_summary`, `last_assistant_message`, `probe` |
| content | TEXT | stored whole after `<private>` removal and redaction; NULL for path-rule hits |
| payload_json | TEXT | normalized fields (zod-validated); no raw passthrough |
| content_hash | TEXT | |
| sensitivity | TEXT | `local_only` (default), `eligible`, `secret`, `private` |
| classification_state | TEXT | `pending`, `done` |
| captured_at, expires_at | INTEGER | `expires_at` = captured_at + 7 days |
| batch_id | TEXT | set when claimed |
| via_spool | INTEGER | |

Indexes: (session_id, captured_at), (expires_at), (batch_id).

## observation_batches

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| repo_id, session_id | TEXT | |
| through_event_id | TEXT | UNIQUE (session_id, through_event_id) makes apply idempotent |
| destination | TEXT | `remote_observer`, `local_observer`, `fallback` (batch split by sensitivity, R10) |
| trigger | TEXT | `ten_turns`, `session_end`, `retention` (forced before purge) |
| state | TEXT | `pending`, `running`, `applied`, `fallback` |
| owner_token | TEXT | worker that claimed it; reclaimable after 120 s when the lease changed hands |
| provider_attempts | INTEGER | |
| degraded_reason | TEXT | `no_provider`, `unreachable`, `unusable_output`, `daily_cap`, `provider_exhausted`, `provider_paid`, `model_alias`, `timeout` |
| excerpted | INTEGER | input excerpted to 12,000 characters (FR-015) |
| claimed_at, completed_at | INTEGER | |

## memories

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| repo_id | TEXT FK | |
| type | TEXT | `bugfix`, `feature`, `refactor`, `change`, `discovery`, `decision`, `security_alert`, `security_note`, `session_summary` |
| title, body | TEXT | <= 120 / <= 2,000 characters |
| concepts | TEXT | JSON array |
| cjk_bigrams | TEXT | generated shadow column for the CJK FTS table |
| content_hash | TEXT UNIQUE | sha256 over (repo_id, type, normalized title, normalized body) |
| sensitivity | TEXT | strictest of the source rows |
| degraded_reason | TEXT | NULL for provider output |
| source_session_id, source_batch_id | TEXT | |
| valid_from, valid_to | INTEGER | bitemporal validity; `valid_to` set on supersession |
| superseded_by | TEXT | |
| pinned_at, pin_order | INTEGER | |
| last_injected_at | INTEGER | 90-day retirement |
| citations_head | TEXT | repository `HEAD` at the last worker citation check |
| citations_ok | INTEGER | 1 when every cited commit is an ancestor of `citations_head` |
| deleted_at | INTEGER | tombstone; the row stays so the same content never resurrects |
| created_at | INTEGER | |

Indexes: (repo_id, deleted_at, pinned_at), (repo_id, valid_to).

## memory_sources

| column | type | notes |
|---|---|---|
| id | INTEGER PK | one row per (memory, source event, citation) |
| memory_id, raw_event_id | TEXT | index on memory_id |
| citation_kind | TEXT | `file_read`, `file_modified`, `commit`, NULL |
| citation_value | TEXT | path or commit id |
| source_agent | TEXT | |

## memories_fts, memories_fts_cjk

External-content FTS5 tables over `memories` (`content = 'memories'`, `content_rowid = rowid`):
`memories_fts (title, body)` with `tokenize = 'trigram'`; `memories_fts_cjk (cjk_bigrams)` with
`tokenize = 'unicode61'`. Maintained by triggers on insert, update, delete. Queries join back to
`memories` for scope, tombstone, sensitivity, and validity.

## destination_rules (seeded)

| destination | sensitivity | allowed | same_repo_required |
|---|---|---|---|
| remote_observer | eligible | 1 | 0 |
| remote_observer | local_only / private / secret | 0 | - |
| local_observer | eligible / local_only / private | 1 | 1 |
| local_observer | secret | 0 | - |
| injection | eligible / local_only / private | 1 | 1 |
| injection | secret | 0 | - |
| sync (M2) | everything except secret | 1 | 0 |

One function evaluates the table for every egress decision, including batch composition.

## injections

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| repo_id, session_id, conversation_id, turn_id | TEXT | |
| kind | TEXT | `session_start`, `prompt`, `grok_deferred` |
| channel | TEXT | e.g. `claude:SessionStart`, `codex:UserPromptSubmit`, `grok:PostToolUse`, `pi:before_agent_start` |
| state | TEXT | `built`, `attempted` (Grok PreToolUse emitted), `emitted`, `omitted`, `pending` (Grok, awaiting a tool call) |
| pack_hash | TEXT | recognized on capture (FR-021) |
| char_budget, chars_used | INTEGER | |
| degraded_reason | TEXT | `summary_pending`, `index_unavailable`, `empty`, `no_tool_call`, `all_denied`, plus batch reasons |
| created_at, emitted_at | INTEGER | |

## injection_items

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| injection_id | TEXT FK | |
| conversation_id | TEXT | copied from the injection so the uniqueness index is local to this table |
| source_kind | TEXT | `memory`, `raw_activity` (summary-pending fallback), `session_summary` |
| memory_id | TEXT | NULL for raw activity |
| raw_event_id | TEXT | NULL for memories |
| decision | TEXT | `included`, `omitted` |
| reason | TEXT | `below_threshold`, `budget`, `duplicate_in_conversation`, `stale_path`, `stale_commit`, `retired`, `mmr_redundant`, `pinned`, `summary` |
| rank | INTEGER | |
| score_bm25, score_rrf, score_mmr | REAL | |
| stale | INTEGER | |

Partial unique index on (conversation_id, memory_id) where decision = `included` and memory_id is
not NULL (SC-010).

## worker_lease (single row, seeded by 0001)

| column | type | notes |
|---|---|---|
| id | INTEGER PK CHECK (id = 1) | |
| owner_token | TEXT | NULL when released; every worker write is fenced on it |
| pid | INTEGER | informational |
| started_at, heartbeat_at | INTEGER | stale when older than 6 s or more than 60 s in the future |

## provider_usage

| column | type | notes |
|---|---|---|
| utc_day, preset | TEXT | PK pair |
| calls | INTEGER | reserved before the outbound call in its own transaction |
| neurons_estimate | REAL | |
| reset_at | INTEGER | stored reset instant; day boundary compares against it |
| exhausted_at | INTEGER | set on 3036 |
| resolved_model | TEXT | model id returned by the provider |

## runtime_state

Key/value (`key TEXT PK`, `value_json TEXT`, `updated_at INTEGER`): last purge, last checkpoint,
catalog cache, per-agent context window table, consent record mirror. The pause flag is the file
`~/.oboete/paused`.

## diagnostics

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| kind, severity, agent, message_code | TEXT | no secret values |
| details_json | TEXT | |
| count | INTEGER | |
| first_seen_at, last_seen_at, cleared_at | INTEGER | |

Pi's extension writes its own diagnostics (handler throw, child timeout) to
`~/.oboete/logs/pi.jsonl` best-effort; the worker folds that file into `diagnostics` on each run.

## sync_conflicts (M2 reservation)

`id, repo_id, content_hash, local_state_json, remote_state_json, status, created_at`; no M1 code
writes it.

## Spool entry (filesystem)

`~/.oboete/spool/<captured_at>-<event_id>.json`, written to a temporary name and renamed; content is
the normalized, already redacted event. Recovered in name order with the same deterministic id.

## Export line (JSONL, `oboete-export/1`)

Header line `{ "format": "oboete-export/1", "exported_at": ..., "repos": [ { id, identity_kind,
normalized_identity } ] }`, then one line per memory: `{ id, repo_id, type, title, body, concepts,
sensitivity, degraded_reason, valid_from, valid_to, superseded_by, pinned_at, pin_order,
deleted_at, created_at, sources: [ { citation_kind, citation_value, source_agent } ] }`.
Tombstones are exported as lines with `deleted_at` set and empty `body`. Import validates each
line (64 KB max), recomputes `content_hash`, `cjk_bigrams`, and ids, unions on `content_hash`,
keeps the stricter sensitivity, and lets tombstones win over active rows.

## State transitions

- raw_events.sensitivity: `local_only` → `eligible` (worker checks pass) | `secret`; `private` is
  set at capture and never promoted.
- observation_batches.state: `pending` → `running` → `applied` | `fallback`.
- memories: active → superseded | deleted; deleted never returns to active.
- worker_lease: released → held (fenced claim) → released (atomic with the empty-queue check) |
  stale (missed heartbeats, clock jump) → reclaimed.
- injections.state: `built` → `emitted` | `omitted`; Grok: `pending` → `attempted` → `emitted` |
  `pending` (deny) → `omitted` (turn end).
