# Data Model: oboete M1

All tables live in `~/.oboete/memory.db`. Migrations are numbered SQL strings embedded in the
engine bundle (`0001_core.sql`, `0002_memory_search.sql`, `0003_operations.sql`), applied forward
only inside one transaction each by `setup`, the worker, and user-facing commands; the hook never
migrates and spools when it sees an older `user_version`. Time columns are Unix milliseconds
(INTEGER). Identifiers are text unless stated. Every table is `STRICT`.

## schema_migrations

| column | type | notes |
|---|---|---|
| version | INTEGER PK | matches `PRAGMA user_version` after apply |
| name | TEXT | |
| sha256 | TEXT | checksum of the SQL string; mismatch aborts |
| applied_at | INTEGER | |

## repos

| column | type | notes |
|---|---|---|
| id | TEXT PK | first 16 hex of sha256 over the normalized identity (FR-004) |
| identity_kind | TEXT | `remote` or `common_dir` |
| normalized_identity | TEXT UNIQUE | `host/path` or realpath of the git common dir |
| display_root | TEXT | last seen working tree, informational only |
| created_at, last_seen_at | INTEGER | |

## sessions

| column | type | notes |
|---|---|---|
| id | TEXT PK | oboete id |
| repo_id | TEXT FK repos | |
| agent | TEXT | `claude`, `codex`, `grok`, `pi`, `unknown`; provenance only (FR-005) |
| native_session_id | TEXT | the agent's own id |
| conversation_id | TEXT | equals `id` for a fresh session; inherited on resume; new on fork (FR-026) |
| started_at, ended_at | INTEGER | |
| status | TEXT | `active`, `ended` |
| turn_count | INTEGER | |
| latest_summary_memory_id | TEXT | filled when the session-end batch is applied (FR-024) |

UNIQUE (agent, native_session_id).

## turns

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| session_id | TEXT FK | |
| ordinal | INTEGER | UNIQUE with session_id |
| started_at, ended_at | INTEGER | `ended_at` NULL = unfinished; unfinished turns never feed retrieval |

## raw_events (append-only, acceptance point)

| column | type | notes |
|---|---|---|
| id | TEXT PK | deterministic from (agent, native ids, kind, content hash) so re-delivery is idempotent |
| repo_id, session_id, turn_id | TEXT | |
| agent | TEXT | |
| kind | TEXT | `session_start`, `prompt`, `tool_call`, `tool_result`, `tool_failure`, `turn_end`, `session_end`, `compaction_summary`, `last_assistant_message`, `probe` |
| content | TEXT | already `<private>`-stripped and hook-redacted; NULL for path-rule hits |
| payload_json | TEXT | normalized event fields (zod-validated), no raw passthrough |
| content_hash | TEXT | sha256 of `content` |
| sensitivity | TEXT | `local_only` (default), `eligible`, `secret`, `private` |
| classification_state | TEXT | `pending`, `done` |
| captured_at | INTEGER | |
| expires_at | INTEGER | captured_at + 7 days (FR-008) |
| batch_id | TEXT | set when claimed |
| via_spool | INTEGER | 1 if recovered from the spool |

Index: (session_id, captured_at), (expires_at), (batch_id).

## observation_batches

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| repo_id, session_id | TEXT | |
| through_event_id | TEXT | last event included; UNIQUE (session_id, through_event_id) makes apply idempotent |
| trigger | TEXT | `ten_turns`, `session_end` |
| state | TEXT | `pending`, `running`, `applied`, `fallback` |
| provider_attempts | INTEGER | |
| degraded_reason | TEXT | `no_provider`, `unreachable`, `unusable_output`, `daily_cap`, `provider_exhausted`, `provider_paid` |
| excerpted | INTEGER | 1 when input was excerpted to 12,000 characters (FR-015) |
| claimed_at, completed_at | INTEGER | |

## memories

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| repo_id | TEXT FK | |
| type | TEXT | `bugfix`, `feature`, `refactor`, `change`, `discovery`, `decision`, `security_alert`, `security_note`, `session_summary` |
| title | TEXT | <= 120 chars |
| body | TEXT | <= 2,000 chars |
| concepts | TEXT | JSON array of claude-mem concept ids |
| cjk_bigrams | TEXT | generated bigram shadow of title + body for CJK runs |
| content_hash | TEXT | sha256 over (repo_id, type, normalized title, normalized body); UNIQUE |
| sensitivity | TEXT | strictest of the batch's input rows |
| degraded_reason | TEXT | NULL for provider output |
| source_session_id, source_batch_id | TEXT | |
| valid_from, valid_to | INTEGER | bitemporal validity (valid_to set on supersession) |
| superseded_by | TEXT | memory id |
| pinned_at, pin_order | INTEGER | |
| last_injected_at | INTEGER | 90-day retirement counter (Assumptions) |
| citations_ok_at | INTEGER | last worker check of cited commits |
| deleted_at | INTEGER | tombstone; the row stays so the same content is never resurrected (FR-035) |
| created_at | INTEGER | |

Index: (repo_id, deleted_at, pinned_at), (repo_id, valid_to).

## memory_sources

| column | type | notes |
|---|---|---|
| memory_id, raw_event_id | TEXT PK pair | |
| citation_path, citation_commit | TEXT | |
| source_agent | TEXT | |

## memories_fts, memories_fts_cjk

External-content FTS5 tables over `memories` (`content = 'memories'`, `content_rowid = rowid`):
`memories_fts (title, body)` with `tokenize = 'trigram'`; `memories_fts_cjk (cjk_bigrams)` with
`tokenize = 'unicode61'`. Maintained by triggers on insert, update, delete. Queries join back to
`memories` for `repo_id`, `deleted_at`, `sensitivity`, and `valid_to`.

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

One function evaluates this table for every egress decision (FR-020, FR-023).

## injections

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| repo_id, session_id, conversation_id, turn_id | TEXT | |
| kind | TEXT | `session_start`, `prompt`, `grok_deferred` |
| channel | TEXT | e.g. `claude:SessionStart`, `codex:UserPromptSubmit`, `grok:PostToolUse`, `pi:before_agent_start` |
| state | TEXT | `built`, `emitted`, `omitted`, `pending` (Grok, awaiting first tool call) |
| pack_hash | TEXT | recognized on capture (FR-021) |
| char_budget, chars_used | INTEGER | |
| degraded_reason | TEXT | including `summary_pending`, `index_unavailable`, `empty` |
| created_at, emitted_at | INTEGER | |

## injection_items

| column | type | notes |
|---|---|---|
| injection_id, memory_id | TEXT PK pair | |
| decision | TEXT | `included`, `omitted` |
| reason | TEXT | `below_threshold`, `budget`, `duplicate_in_conversation`, `stale`, `retired`, `mmr_redundant`, `pinned`, `summary` |
| rank | INTEGER | |
| score_bm25, score_rrf, score_mmr | REAL | |
| stale | INTEGER | |

Partial unique index on (conversation_id via injections, memory_id) where decision = `included`
(SC-010).

## worker_lease (single row, seeded)

| column | type | notes |
|---|---|---|
| id | INTEGER PK CHECK (id = 1) | |
| owner_token | TEXT | NULL when released |
| pid | INTEGER | informational |
| started_at, heartbeat_at | INTEGER | stale when older than 6 s or more than 60 s in the future |

## provider_usage

| column | type | notes |
|---|---|---|
| utc_day | TEXT | `YYYY-MM-DD`, compared against `reset_at` |
| preset | TEXT | PK with utc_day |
| calls | INTEGER | incremented before the outbound call |
| neurons_estimate | REAL | |
| reset_at | INTEGER | stored reset instant |
| exhausted_at | INTEGER | set on 3036 |
| resolved_model | TEXT | model id returned by the provider, compared with the requested id |

## runtime_state

Key/value (`key TEXT PK`, `value_json TEXT`, `updated_at INTEGER`) for last purge time, last
checkpoint, catalog cache, schema notes. The pause flag is the file `~/.oboete/paused`, not a row.

## diagnostics

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| kind, severity, agent, message_code | TEXT | no secret values |
| details_json | TEXT | |
| count | INTEGER | |
| first_seen_at, last_seen_at, cleared_at | INTEGER | |

## sync_conflicts (M2 reservation)

`id, repo_id, content_hash, local_state_json, remote_state_json, status, created_at`; no M1 code
writes it.

## Spool entry (filesystem)

`~/.oboete/spool/<captured_at>-<event_id>.json`, written to a temporary name and renamed; content is
the normalized, already redacted event. Recovered in name order; recovery inserts with the same
deterministic `raw_events.id`, so duplicates are ignored.

## State transitions

- raw_events.sensitivity: `local_only` → `eligible` (worker checks pass) | `secret` (rule or
  detector hit); `private` is set at capture from `.oboete.toml` or config and never promoted.
- observation_batches.state: `pending` → `running` → `applied` | `fallback`.
- memories: active → superseded (`valid_to`, `superseded_by`) | deleted (`deleted_at`); a deleted
  memory never returns to active.
- worker_lease: released → held (claim) → released (exit) | stale (missed heartbeats, clock jump).
- injections.state: `built` → `emitted` | `omitted`; Grok: `pending` → `emitted` | `omitted`.
