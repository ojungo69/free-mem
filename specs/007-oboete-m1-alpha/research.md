# Phase 0 Research: oboete M1 Self-Use Alpha

**Date**: 2026-09-02 | **Inputs**: `spec.md`, `CONSTITUTION.md` 3.0.0,
`docs/research/oboete-contracts-2026-09-02.md`, `codex-plan.json` (independent second plan)

Method: ten research topics were investigated in parallel with primary sources and local probes on
Node 24.16.0, then each was attacked by two independent refuters (source fidelity, feasibility under
the constitution's constraints), and the resulting plan was reviewed once more by an independent
Codex plan review (22 blocking findings, all resolved below or turned into explicit gates). Every
decision records what the reviewers changed. Where a decision deviates from the constitution's
literal text, the deviation is listed in `plan.md` Complexity Tracking and needs the owner's
approval before implementation starts.

## R1. SQLite runtime and write serialization

- **Decision**: One `~/.oboete/memory.db` in WAL mode; every `DatabaseSync` connection opens with an
  explicit `timeout` (the default busy timeout is 0 = fail immediately). The capture hook performs
  one autocommit `INSERT` into `raw_events` and, on `errcode` 5 (`SQLITE_BUSY`) or 6
  (`SQLITE_LOCKED`) or any other failure, writes the event to the spool and exits 0. Every worker
  read-then-write unit is a short `BEGIN IMMEDIATE` transaction (busy timeout is not honoured on a
  read-to-write lock upgrade); network calls never run inside a transaction. The worker owns
  checkpointing: `PRAGMA wal_checkpoint(PASSIVE)` after each batch and `TRUNCATE` before exit, so
  the WAL a hook closes is small; hook connections set `PRAGMA wal_autocheckpoint = 0`.
- **Rationale**: FTS5 with the trigram tokenizer is compiled into Node's bundled SQLite in both the
  v22.16.0 and v24.16.0 source trees; `node:sqlite` needs no flag from v22.13.0 (still labelled
  experimental until v25.7.0; the ExperimentalWarning on stderr is not shown to the user by any of
  the four agents). A live probe with one `BEGIN IMMEDIATE` holder and three concurrent writer
  processes serialized correctly with `timeout: 3000`; with the default timeout every writer failed
  at 0 ms. `loadExtension` exists behind `allowExtension: true`, so M2's `sqlite-vec` is not
  precluded.
- **Reviewer changes**: worker transactions must be `BEGIN IMMEDIATE`; a checkpoint owner is
  required because the last closing connection checkpoints the WAL inside the hook budget; commit
  order under contention is not arrival order.
- **Alternatives**: dedicated writer process (a daemon, forbidden); application-level retry loops
  (reimplements SQLite's busy handler); rollback-journal mode (blocks the viewer's reads).
- **Open**: the hook busy timeout (start at 150 ms) and the checkpoint discipline are validated by
  the fixture on Node 22.16 (SQLite 3.49.1) and 24.x (3.53.0), both in CI.

## R2. Build, bundle, and hook startup

- **Decision**: TypeScript compiled ahead of time with **esbuild** (dev dependency; zero runtime
  dependencies of its own) into one ESM file `dist/oboete.mjs`. The bundle **includes** the small
  ESM-only packages the hook path needs: `zod`, `smol-toml`, `@secretlint/core`,
  `@secretlint/secretlint-rule-preset-recommend`. It leaves `node:*` builtins and the heavy
  packages (`ai`, `@ai-sdk/*`, `workers-ai-provider`, `hono`, `@hono/node-server`, `preact`)
  external, loaded lazily with `import()` only by `observe`, `view`, `mcp`, and `setup`. The
  bundle keeps the `#!/usr/bin/env node` shebang; `tsc --noEmit` is the type gate; `eslint` with
  `typescript-eslint` is the lint gate the constitution's release evidence requires. Migrations are
  real numbered files `src/db/migrations/NNNN_name.sql` embedded by esbuild's text loader. Tests are
  compiled by the same esbuild step to `build/test/*.mjs` before `node --test`, because Node 22.16
  cannot run `.test.ts` directly. Setup writes hook commands in shell form with absolute paths:
  `"<process.execPath>" "<abs>/dist/oboete.mjs" hook` (Grok Build and Codex handlers have no `args`
  field). The Pi extension file that setup writes is a three-line `.js` loader whose default export
  imports `piExtension` from the bundle (Pi discovers only `.ts` / `.js`).
- **Rationale**: Node type stripping is default-on only from 22.18; tsup adds 17 dependencies;
  `tsc` alone cannot produce one file; bundling CommonJS-heavy packages (`ai`'s transitive `debug`
  and friends) into ESM output throws `Dynamic require` at runtime, while the four hook-path
  packages are pure ESM and small; `@secretlint/node` resolves rules by package name at runtime and
  is therefore not bundleable, which is why the core API with a statically imported preset is used.
- **Reviewer changes**: the hook needs `zod`, `smol-toml`, and the secret detector (R4), so a
  "node:* only" hook path was not honest; the Pi artifact must be a `.js` default-export loader;
  tests need a compile step on 22.16; a lint gate was missing.
- **Gate**: task 1 measures the real bundle's cold start on 22.16 and 24.x (`node -e ""` baseline
  18-40 ms on this host); the budget for process start plus bundle load plus detector init is
  100 ms, leaving 200 ms for the write; failure to meet it is reported before any adapter work.

## R3. Observer client and presets

- **Decision**: `ai` + `workers-ai-provider` in REST mode (`accountId`, `apiKey`; peers `ai` and
  `@ai-sdk/provider`) for the default preset `@cf/zai-org/glm-4.7-flash`, and
  `@ai-sdk/openai-compatible` for `ollama` (required local option), `nim`, `openrouter`, `gemini`,
  and `anthropic`. Structured output: JSON schema via the SDK's object output where the endpoint
  supports `response_format`; for `anthropic` (whose OpenAI-compatible endpoint ignores
  `response_format`) and for any preset whose probe shows no schema support, the prompt asks for a
  single JSON object and the reply text is parsed and validated with zod (failure = `unusable_output`).
  Every call: `maxRetries: 0`, `abortSignal: AbortSignal.timeout(60_000)`, and oboete's own error
  classification: HTTP 429 with Cloudflare code 3036 = daily allowance exhausted (authoritative stop,
  never retried), 403/5035 = model now paid, 408/3007 and 429/3040 = transient (one retry),
  `finish_reason: length` with null content or unparsable JSON = unusable output (one retry), a
  returned model id different from the requested id = `model_alias`. Neuron accounting: the
  `cf-ai-neurons` header when response headers are exposed, otherwise an estimate from token usage
  at 5,500 / 36,400 neurons per million input / output tokens; either way a pacing estimate.
- **Rationale**: Cloudflare's own provider posts to the native `/ai/run/{model}` endpoint with a bare
  JSON schema, which the evidence probe showed working; the OpenAI-compatible provider covers the
  rest with one `createOpenAICompatible({ baseURL, apiKey })` each.
- **Reviewer changes**: retries disabled (the default policy retried a 3036 three times); the
  provider's error table applies only to the Workers binding path, so HTTP status plus body code is
  parsed by oboete; a wall-clock deadline is mandatory or a hung fetch keeps the lease alive forever;
  Anthropic is shipped as a text-JSON preset instead of being dropped from the constitution's list.
- **Open**: NIM structured output is probed when the preset is wired; `ai` republishes daily, so
  versions are pinned.

## R4. Secret detection and redaction (before any write)

- **Decision**: The hook runs the complete detector **before the first write anywhere** (database,
  spool, or log): strip `<private>...</private>` spans (an unclosed tag removes the rest of the
  text); apply repository path rules (a matched path stores metadata only, class `secret`); run
  `@secretlint/core` `lintSource()` with the statically imported recommend preset (about 30 ms cold,
  2 ms warm, measured three times) plus an entropy check applied only to candidates captured by a
  secret-shaped regex (gitleaks style: entropy is a secondary filter; thresholds 3.0 bits/char for
  hex strings and 4.0 for base64 strings of at least 32 characters; never on bare words, git SHAs,
  UUIDs, or paths); replace every hit with `[REDACTED:<rule>]`; store the row `local_only`, or
  `secret` when a rule fired. The worker runs the same detector again on every candidate memory
  title and body before insert (defense in depth) and decides promotion to `eligible`. Batch
  composition is split by destination (R10). AWS access-key id scanning is enabled explicitly.
- **Rationale**: FR-018 and Principle III require redaction before storage, so a fast regex in the
  hook with a full scan later would store plaintext for anything the regex missed. The core API
  with a static preset costs about 30 ms, which fits the 300 ms budget; `@secretlint/node`'s
  `createEngine` costs 120-145 ms and resolves rules by package name at runtime. secretlint ships no
  entropy rule.
- **Reviewer changes**: the two-stage draft (fast regex in the hook, full scan in the worker)
  violated FR-018; standalone entropy over arbitrary tokens flagged every git SHA and had a
  mathematical dead zone for short strings, so entropy is gated on regex candidates.
- **Deviation**: Principle VI names `@secretlint/node`; the plan uses `@secretlint/core` and the
  recommend preset (Complexity Tracking, PATCH amendment).

## R5. Lexical retrieval

- **Decision**: Two external-content FTS5 tables over `memories`: `memories_fts` (`tokenize =
  'trigram'`, title + body) and `memories_fts_cjk` (`tokenize = 'unicode61'`, over a
  TypeScript-generated column of overlapping bigrams for CJK runs; run detection includes the Common
  script marks used inside Japanese words: U+30FC ー, U+3005 々, U+30FB ・). Query: `Intl.Segmenter`
  word segments; non-CJK segments of three or more characters become trigram `MATCH` terms; CJK
  segments become bigram terms; one-character Japanese particles and function words are dropped;
  `LIKE` runs only when no indexed term remains. Ranking: BM25 per table normalized as
  `score / best_score`; the relevance threshold (config `retrieval.threshold`, default 0.3) applies
  to normalized BM25; Reciprocal Rank Fusion (k = 60) orders candidates across the two tables (a
  `LIKE` list never votes); MMR (lambda 0.5) with character-trigram cosine similarity removes near
  duplicates; the result is cut at the caller's character budget. Repository scope is a join on
  `memories.repo_id`. FTS5 virtual tables are not `STRICT` (the keyword applies to ordinary tables).
- **Rationale**: FTS5 trigram cannot match queries shorter than three characters (documented and
  reproduced); unicode61 alone turns unspaced Japanese into one token; the RRF range is bounded, so
  the threshold must apply to normalized BM25.
- **Reviewer changes**: threshold moved from RRF to BM25; particles removed from the short-term
  bucket; the `LIKE` list no longer votes; long-vowel marks added; the `UNINDEXED` shortcut and the
  `STRICT` on virtual tables dropped.
- **Open**: threshold and lambda are calibrated on the SC-009 fixture.

## R6. Detached worker, lease, spool, retention

- **Decision**: Hooks spawn `oboete observe` with `spawn(execPath, [bundle, 'observe'],
  { detached: true, stdio: 'ignore' }).unref()` only when `worker_lease` is stale or released.
  `worker_lease` is one row seeded by migration 0001. Claim, heartbeat, batch claim, apply, release
  are all single `BEGIN IMMEDIATE` transactions fenced by `owner_token` (`... WHERE id = 1 AND
  owner_token = ?`); a fenced statement that changes zero rows means the lease was lost and the
  worker exits without further writes. Claim condition: `owner_token IS NULL OR heartbeat_at <
  now - 6000 OR heartbeat_at > now + 60000` (a future heartbeat means the clock jumped). Heartbeat
  every 2 s. Release is atomic with the queue-empty check: inside one `BEGIN IMMEDIATE`, count
  claimable events; if zero, set `owner_token = NULL`; otherwise continue the loop. A stale worker's
  `running` batches are reclaimed by the new owner only after the lease takeover and only if the
  batch's `claimed_at` is older than 120 s; a reclaimed batch's provider call may repeat, but apply
  is idempotent per batch id. Provider calls: reservation (`provider_usage.calls + 1`, batch
  `running`) in a short transaction, the network call outside any transaction with a 60 s deadline,
  the result applied in a separate fenced transaction. Spool: one file per event under
  `~/.oboete/spool/`, written to a temporary name and renamed (append is not atomic for large
  records); recovered in name order with the same deterministic event id. Retention: every
  `raw_events` row has `expires_at`; at the start of each worker run, rows past `expires_at` whose
  batch is `applied` or `fallback` are deleted in bounded steps (`DELETE ... WHERE id IN (SELECT id
  ... LIMIT 500)`, because Node's SQLite lacks `DELETE ... LIMIT`); rows past `expires_at` whose
  batch is still pending are forced into a fallback batch first; `secret` rows (metadata only) are
  deleted the same way. When both the database and the spool are unwritable the hook still exits 0
  and increments an in-memory counter it prints to stderr; doctor reports the condition by probing
  writability (the spec's edge case is amended to say so).
- **Rationale**: the constitution forbids a daemon, `flock`, and `/proc`; SQLite's single-writer
  rule plus `BEGIN IMMEDIATE` and an owner fence give atomic claims; the detached spawn pattern is
  documented for Linux and Windows.
- **Reviewer changes**: seed row, `SQLITE_BUSY` on the claim, atomic release with the queue check,
  owner fencing on every write, per-batch claim tokens, clock-jump rule, non-atomic append, purge
  scope covering fallback and pending rows, `DELETE ... LIMIT` unsupported, loss counting when the
  disk is full, provider deadline and reservation transaction.
- **Open**: TTL values are validated against the fixture and the failure-injection matrix.

## R7. Hook normalization and per-agent adapters

- **Decision**: One discriminated union of normalized events (`session_start`, `prompt`,
  `tool_call`, `tool_result`, `tool_failure`, `turn_end`, `session_end`, `compaction_summary`,
  `last_assistant_message`) with a common envelope; no raw passthrough is stored; content is stored
  whole (redacted), and the 12,000-character bound applies only when a batch input is built.
  `raw_events.id` is derived from `(agent, native_session_id, kind, native event id or tool_call_id,
  turn ordinal, delivery ordinal, content_hash)` so a repeated identical prompt in one session is two
  events while a re-delivered hook is one. Injection policy per agent is in `contracts/agents.md`;
  essentials: Claude Code injects at `SessionStart` for `startup`, `clear`, `compact`, never for
  `resume` or `fork`, and at `UserPromptSubmit`; Codex injects at `SessionStart` with matcher
  `startup|clear|compact` (the source enum is verified) and at `UserPromptSubmit` with
  `additionalContextLimit = 0`; Grok Build follows the FR-045 state machine (pending pack, attempt
  on `PreToolUse`, confirmation or delivery on `PostToolUse`, retry on the next call after a deny,
  omission recorded at turn end); Pi captures `session_start`, `input`, `tool_result`,
  `agent_settled`, `session_shutdown` through a detached child and injects from
  `before_agent_start` by awaiting a bounded child (`AbortSignal.timeout`; child processes are
  asynchronous from Pi's event loop, unlike in-process sqlite). `PostToolUseFailure` maps to
  `tool_failure` on Claude Code and Grok Build. Agent detection: `GROK_HOOK_EVENT` or
  `GROK_SESSION_ID` → grok; `CODEX_HOME` or Codex-shaped stdin (`transcript_path` plus the verified
  universal `model` field) → codex; `PI_SESSION_ID` → pi; `CLAUDE_PROJECT_DIR` or Claude-shaped stdin
  → claude; else `unknown`.
- **Reviewer changes**: failed tool calls were unmapped; Grok's two channels are not redundant
  against deny, so the state machine replaces "post-only"; Codex matcher corrected to the verified
  `compact` source; `fork` added; raw passthrough removed; Pi `session_start` added; content stored
  whole; event id widened.
- **Open**: Codex and Grok have no confirmed free summary field comparable to `compact_summary`;
  Pi's compaction event is unconfirmed; native tool payload shapes are captured as fixtures under
  the verification gate (R13).

## R8. Configuration, paths, and repository identity

- **Decision**: `smol-toml` for `~/.oboete/config.toml` and for `.oboete.toml` repository rules.
  Data directory `~/.oboete/` via `os.homedir()` and `node:path`, overridable with `OBOETE_HOME`;
  XDG/AppData splitting deferred to a constitution amendment. Repository identity: the `origin`
  remote, else the first remote, normalized to `host/path` (scp-like → `ssh://`, userinfo removed,
  host lowercased, default port and trailing `.git` or `/` removed), SHA-256, first 16 hex; without a
  remote, the realpath of `git rev-parse --git-common-dir` (worktrees share one identity); a
  remote-less identity is machine-local, so import offers `--map-repo <old-id>=<current>` for such
  repositories. Foreign configuration files (`~/.codex/config.toml`, `~/.claude/settings.json`,
  `~/.grok/hooks/oboete.json`) are edited through an oboete-managed block: TOML gets
  `# oboete:begin` / `# oboete:end` comment fences around the appended tables, JSON files get
  handlers carrying `"oboete": true`; setup detects, replaces, or removes only that block, writes to
  a temporary file, re-parses the result, keeps a timestamped backup, then renames. Credentials come
  from `config.toml` (mode 0600; doctor warns otherwise) or `OBOETE_CF_API_TOKEN`,
  `OBOETE_CF_ACCOUNT_ID`, `OBOETE_PROVIDER_API_KEY`; values never appear in logs, spool, doctor
  output, or packs (fail-closed test).
- **Reviewer changes**: `--show-toplevel` split remote-less worktrees; a plain append to
  `config.toml` duplicated tables on re-setup; remote-less identities are not portable across
  installations.

## R9. Viewer and search surface

- **Decision**: Hono on `@hono/node-server`, bound to `127.0.0.1`, per-launch random token in the
  URL, `Origin` check on mutating routes; SSE via `hono/streaming`; change detection by polling
  `PRAGMA data_version` every 500 ms on a read connection. The Preact + Vite SPA is built by the
  `build` script and embedded as string assets. MCP: `oboete mcp` is a **legacy-era** stdio JSON-RPC
  server for M1: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`;
  `server/discover` returns `-32601` so modern clients fall back to `initialize`. Repository identity
  comes from the server's working directory; a client-supplied repository is rejected. Pi's tools
  call the CLI as child processes. Registration commands are verified against each real client in
  the E2E run and recorded in `docs/research/` (R13); if Grok Build has no user-scoped MCP
  registration, Grok uses the CLI child like Pi.
- **Reviewer changes**: a half-implemented `server/discover` would be a broken modern server; the
  `prepack` path does not run for git dependencies on npm 12; the viewer has no local write path.
- **Alternatives**: `@modelcontextprotocol/sdk` (93 packages, 28 MB); changeset API; committing `dist/`.

## R10. Summarizer contract, batch composition, fallback

- **Decision**: One JSON contract shared by the LLM observer and the fallback
  (`contracts/observer.md`). **Batch composition by destination**: after classification, a session
  batch is split into the eligible set and the restricted set (`local_only`, `private`); the remote
  observer receives only the eligible set; the restricted set goes to the local observer preset if
  one is configured, otherwise to the rule-based fallback; `secret` rows are never summarized. Each
  resulting memory records its source rows in `memory_sources` and takes the strictest sensitivity
  of those rows. Excerpting to 12,000 characters is recorded on the batch. Classification
  (ADD/UPDATE/DELETE/NOOP): candidates are the top 8 same-repository memories (including tombstoned
  rows) from R5 retrieval over the new observation's title and body; the provider returns a decision
  with a reason per observation whose `target` MUST be one of the supplied candidate ids (anything
  else is treated as ADD); the fallback uses a fixed rule: exact `content_hash` match on a tombstoned
  row → suppressed, on an active row → NOOP, otherwise ADD (never UPDATE or DELETE without a
  provider reason). Fallback output is language-neutral: only quoted source text, file lists, and
  commit ids, no generated labels. Degraded reasons: `no_provider`, `unreachable`, `unusable_output`,
  `daily_cap`, `provider_exhausted`, `provider_paid`, `model_alias`, `timeout`.
- **Reviewer changes**: mixed-sensitivity batches were undefined; tombstone-aware dedupe;
  classification target restriction; fallback classification rule; language neutrality; complete
  degraded enum.

## R11. Fixture, measurement, tests, isolated E2E

- **Decision**: `node:test` only, on compiled tests. The 1,000-event fixture is JSONL of **native
  hook payloads** per agent generated deterministically from synthetic git repositories (with and
  without remotes, two clones of one remote), replayed through the real bundle. Seeded content: three
  facts per SC-001 pair, Japanese and English fact pairs for SC-009, a synthetic secret corpus for
  SC-005 (data literals, narrowly scoped gitleaks allowlist). The replay harness records p99 capture
  hook time (capture hooks only; the session-start summary wait is measured separately with both
  ready and timeout paths), worker peak RSS via `process.resourceUsage().maxRSS` reported at exit,
  and database growth into `docs/evidence/m1-resource-envelope.md`. Failure matrix (test seam
  `OBOETE_TEST_FAULT`, honoured only under `NODE_ENV=test`): db missing, busy, corrupt, read-only
  home, ENOSPC, worker killed mid-batch, provider unreachable, provider hang, 429/3036, 403/5035,
  length, malformed JSON, Pi handler throw, Pi child hang, clock jump, mixed-sensitivity batch,
  resume/compact/fork/clear, setup repeat and remove, lease steal, pause. Migration smoke test runs
  every migration on an empty database and on the previous version's fixture database on 22.16 and
  24.x. Installed size is measured by installing the packed tarball into an empty prefix with
  dependencies. Setup probes run in parallel under one 90 s deadline; the SC-001 prompts force a
  tool call so the Grok clause is testable; SC-007 is a local scripted daily run. Pi 0.84.4 requires
  Node >= 22.19, so the engine floor stays 22.16 (CI) while the four-agent E2E and dogfood run on
  Node 24.x; the support matrix in `README.md` states both.
- **Reviewer changes**: fixture lines must not carry derived values; no catchable `SQLITE_BUSY`
  string (use `errcode`); `mount` needs root; samplers miss the RSS peak; `grok --print` does not
  exist (`grok -p`); `.test.ts` cannot run directly on 22.16; the failure matrix and size check were
  incomplete; sequential 30 s probes could exhaust SC-008.

## R12. Decisions for the remaining gaps

- **Injection marker**: packs start with the line `oboete memory context` and end with
  `end of oboete memory context`; both are labels, not instructions (FR-021). Memory bodies quoted
  from tool output are framed as data (`> ` prefix per line) and never as directives; a test rejects
  packs containing imperative wrapper text from either summarizer. Capture recognizes a pack by the
  `pack_hash` stored in `injections` for that conversation, with the marker line as a fallback.
- **Conversation identity**: `sessions.conversation_id` equals the agent session id for a fresh
  session and is inherited on resume; a fork is a new conversation that is not injected.
- **Allowance**: `provider_usage (utc_day, preset, calls, neurons_estimate, reset_at, exhausted_at)`;
  reservation before the call in its own short transaction; the day boundary compares against the
  stored `reset_at` so a clock change neither double-charges nor double-resets.
- **Free-model catalog**: `GET /accounts/{id}/ai/models/search`, read once per worker run with a
  24-hour cache in `runtime_state`; a paid-plan property or a 403/5035 response marks the preset
  `provider_paid` and doctor names it.
- **Citation staleness**: every pack builder (session start, prompt, Grok deferred, Pi) runs the
  same check: cited paths with `fs.existsSync`; cited commits through a worker-maintained cache
  keyed by the repository's current `HEAD` (`git merge-base --is-ancestor` batched per batch),
  invalidated when `HEAD` changes; a missing path or non-ancestor commit adds a stale note or omits
  the memory per the staleness policy, recorded in `injection_items`.
- **Pause**: the file `~/.oboete/paused` is checked before the database is opened; a paused hook
  writes nothing and exits 0.
- **Setup probes and consent**: one headless invocation per selected agent (`claude -p`,
  `codex exec`, `grok -p`, `pi -p`), run in parallel under a 90 s deadline, each asserting a probe
  event; trust state reported per agent. Remote consent is a stored record (`consent.remote =
  { preset, host, credential_source, cost_class, egress, accepted_at }`); `--yes` is accepted only
  when that record exists for the chosen preset, otherwise `--accept-egress` must be passed
  explicitly on the command line.
- **Export/import**: versioned JSONL (`{ "format": "oboete-export/1" }` header line), one memory or
  tombstone per line; import validates each line with zod under size limits (line 64 KB, file 256
  MB), recomputes every derived field (`content_hash`, `cjk_bigrams`, ids), unions on
  `content_hash`, keeps the stricter sensitivity, applies tombstones with precedence over active
  rows, ignores classification targets and citations it cannot resolve, and never marks an imported
  row eligible for the remote observer until the local classifier has run.
- **Concurrent sessions**: prompt-submit retrieval reads memories only, from applied or fallback
  batches, so an unfinished turn of another session is never injected.
- **Capture and injection SLAs**: capture hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `Stop`, `PostCompact`, `SessionEnd`, Pi capture child) 300 ms end to end; injection hooks
  (`SessionStart`, `UserPromptSubmit`, Grok `PreToolUse`/`PostToolUse` delivery, Pi inject child)
  300 ms when the summary is ready, up to 8 s at session start only while the previous session's
  summary is pending; setup writes hook timeouts of 12 s on injection hooks and 3 s on capture hooks
  (Claude Code and Codex default to 600 s, Grok Build to 5 s). SC-002 measures capture hooks; the
  session-start wait is measured on both paths and reported separately. This split needs a PATCH
  amendment of Principle IV (Complexity Tracking).

## R13. Verification gate before dependent implementation

The constitution requires third-party contracts to be verified and recorded before a plan depends on
them. The following items are unverified today and are gated: no code that depends on an item may
be written before its probe result is appended to `docs/research/oboete-contracts-2026-09-02.md`
(or a dated sibling file). `tasks.md` places these probes first.

| item | probe | fallback if the probe fails |
|---|---|---|
| Native tool payload shapes for read/write/edit/bash on all four agents | capture fixtures under `test/contracts/<agent>/` from headless runs | adapter stores `tool_name_native` and bounded JSON without field mapping |
| Codex rollout flush timing at `PostToolUse` and TUI trust path | grep the just-completed `tool_use_id` from `transcript_path` inside the hook; run setup against an interactive-trust config | capture from hook stdin only, never from the rollout |
| Codex `SessionStart` firing with `source = compact` and `clear` | headless run with forced compaction | inject on `startup` only and record the gap in doctor |
| Grok Build user-scoped MCP registration | write the configuration and call `search` from a headless run | Grok uses the CLI child path |
| Pi compaction event name and payload; Pi tool registration surface | extension probe on 0.84.4 | no compaction summary from Pi; tools through the CLI child |
| NIM / OpenRouter / Gemini `response_format` support | one call per preset with the observer schema | text-JSON path (R3) |
| MCP `initialize`-only server against Claude Code, Codex, Grok clients | headless `tools/list` + `tools/call` through each client | mark the failing client's MCP as unsupported in doctor and use the CLI child |
| Real bundle cold start on 22.16 and 24.x | replay harness | split the hook into a smaller entry only after measurement, with a constitution note |
| Installed size with dependencies | `npm pack` + install into an empty prefix | move a dependency to the text-JSON or hand-written path, or record a written reason above 30 MB |
