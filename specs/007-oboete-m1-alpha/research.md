# Phase 0 Research: oboete M1 Self-Use Alpha

**Date**: 2026-09-02 | **Inputs**: `spec.md`, `CONSTITUTION.md` 3.0.0,
`docs/research/oboete-contracts-2026-09-02.md`, `codex-plan.json` (independent second plan)

Method: ten research topics were investigated in parallel with primary sources and local probes on
Node 24.16.0, then each was attacked by two independent refuters (source fidelity, feasibility under
the constitution's constraints). Every decision below records what the refuters changed. Claims that
did not survive are not repeated. Where a decision deviates from the constitution's literal text, the
deviation is listed in `plan.md` Complexity Tracking.

## R1. SQLite runtime and write serialization

- **Decision**: One `~/.oboete/memory.db` in WAL mode; every `DatabaseSync` connection opens with an
  explicit `timeout` (busy timeout; the default is 0 = fail immediately). The capture hook performs
  one autocommit `INSERT` into `raw_events` and, on `errcode` 5 (`SQLITE_BUSY`) or 6
  (`SQLITE_LOCKED`) or any other failure, writes the event to the spool and exits 0. The worker keeps
  provider calls outside transactions and opens every read-then-write unit with `BEGIN IMMEDIATE`
  (busy timeout is not honoured on a read-to-write lock upgrade). The worker owns checkpointing:
  `PRAGMA wal_checkpoint(PASSIVE)` after each batch and `TRUNCATE` before exit, so the WAL a hook
  closes is small. Hook connections set `PRAGMA wal_autocheckpoint = 0`.
- **Rationale**: FTS5 (including the trigram tokenizer) is compiled into Node's bundled SQLite in
  both the v22.16.0 and v24.16.0 source trees; `node:sqlite` needs no flag from v22.13.0 (the module
  is still labelled experimental until v25.7.0; importing it prints an ExperimentalWarning on the
  22.x line, which is acceptable because the hook's stderr is not shown to the user by any of the
  four agents). A live probe with one holder of `BEGIN IMMEDIATE` and three concurrent writer
  processes serialized correctly with `timeout: 3000`; with the default timeout all writers failed at
  0 ms. `loadExtension` exists behind `allowExtension: true`, so M2's `sqlite-vec` is not precluded.
- **Refuter changes**: worker transactions must be `BEGIN IMMEDIATE`; a checkpoint owner is
  required because the last closing connection checkpoints the WAL inside the hook budget; commit
  order under contention is not arrival order (never rely on it).
- **Alternatives**: dedicated writer process (a daemon, forbidden by Principle II); application-level
  retry loops (reimplements SQLite's busy handler); rollback-journal mode (blocks the viewer's reads).
- **Open**: the hook busy timeout (start at 150 ms) and the checkpoint discipline are validated by
  the 1,000-event fixture, not by argument. The bundled SQLite differs between Node 22.16 (3.49.1)
  and 24.16 (3.53.0); the fixture runs on both in CI.

## R2. Build, bundle, and hook startup

- **Decision**: TypeScript compiled ahead of time with **esbuild** (dev dependency; zero runtime
  dependencies of its own) into one ESM file `dist/oboete.mjs` containing all of oboete's own code,
  with `node:*` builtins and all npm runtime dependencies left **external** and loaded lazily with
  `import()` only by the commands that need them (`observe`, `view`, `mcp`, `setup`). The hook path
  imports only `node:sqlite`, `node:fs`, `node:path`, `node:crypto`, `node:child_process`. The
  bundle keeps the `#!/usr/bin/env node` shebang. `tsc --noEmit` stays the type gate. Setup writes
  hook commands in shell form with absolute paths: `"<process.execPath>" "<abs>/dist/oboete.mjs" hook`
  (Grok Build and Codex hook handlers have no `args` field; Claude Code accepts the same string).
  The Pi extension file that setup writes is a three-line `.js` loader whose default export imports
  the bundle's `piExtension` factory (Pi discovers only `.ts`/`.js`).
- **Rationale**: Node type stripping is default-on only from 22.18, below which a hook would need a
  flag; tsup adds 17 dependencies for features M1 does not use; `tsc` alone cannot produce one file.
  Leaving runtime dependencies external keeps the hook bundle small (the AI SDK, Hono, Preact and
  secretlint never load on the capture path) and avoids esbuild's ESM-output `Dynamic require`
  failure for CommonJS dependencies. Local baseline: `node -e ""` 18-40 ms on this WSL host.
- **Refuter changes**: bundling every dependency into one file breaks at runtime (`debug` and other
  CJS packages) and would load megabytes on every hook; `@secretlint/node` resolves rule packages by
  name at runtime and cannot be bundled; the Pi artifact must be `.js` with a default-export factory.
- **Alternatives**: run `.ts` directly (flagged below 22.18); tsup (dependency weight); full bundle
  including dependencies (startup and CJS breakage); rely on PATH lookup (agents inherit a different
  environment than the user's shell).
- **Open**: the first implementation task measures the real bundle's cold start with the fixture;
  the plan's budget is 60 ms for process start plus bundle load, leaving 240 ms for work.

## R3. Observer client and presets

- **Decision**: `ai` (Vercel AI SDK core) + `workers-ai-provider` in REST mode (`accountId`,
  `apiKey`; requires peers `ai` and `@ai-sdk/provider`) for the default preset
  `@cf/zai-org/glm-4.7-flash`, and `@ai-sdk/openai-compatible` for Ollama (the required local-model
  preset), NVIDIA NIM, OpenRouter, and Gemini. Structured output through the SDK's object output with
  the observer JSON schema. `maxRetries: 0` on every call; oboete classifies errors itself:
  HTTP 429 with Cloudflare code 3036 = daily allowance exhausted (authoritative stop, never retried),
  403/5035 = model now requires a paid plan, 408/3007 and 429/3040 = transient (one retry), any
  `finish_reason: length` with null content = unusable output. Neuron accounting: read the
  `cf-ai-neurons` response header when the SDK exposes response headers, otherwise estimate from
  token usage at the published rates (5,500 / 36,400 neurons per million input / output tokens);
  either way the value is a pacing estimate (FR-012). The Anthropic preset is deferred: Anthropic's
  OpenAI-compatible endpoint ignores `response_format`, so it cannot meet the shared schema.
- **Rationale**: Cloudflare's own provider posts to the native `/ai/run/{model}` endpoint and sends a
  bare JSON schema, which is what the evidence probe showed working; the OpenAI-compatible provider
  covers the other four presets with one `createOpenAICompatible({ baseURL, apiKey })` each.
- **Refuter changes**: `usage.neurons` and the `cf-ai-neurons` header do exist on the REST API (the
  evidence probe recorded them) but the SDK does not surface `usage.neurons`; the SDK's default retry
  policy would retry a 3036 three times, so retries are disabled; the provider's error-code table
  applies only to the Workers binding path, so HTTP status plus body code must be parsed by oboete.
- **Alternatives**: route Workers AI through the OpenAI-compatible endpoint (loses the native schema
  path); dedicated Ollama provider (unnecessary); Anthropic as a first-class preset (no structured
  output).
- **Open**: NVIDIA NIM structured-output support is unconfirmed and is probed when the preset is
  wired; `ai` republishes daily, so versions are pinned in `package.json`.

## R4. Secret detection and redaction

- **Decision**: Two stages, both redacting before storage. **Hook (capture)**: strip
  `<private>...</private>` spans (an unclosed tag removes the rest of the text); apply repository path
  rules (a matched path stores metadata only, no content, class `secret`); run a small built-in set
  of high-precision regexes (private-key blocks, AWS access keys, GitHub/GitLab/Slack/OpenAI-style
  prefixed tokens, JWTs, `key=value` assignments whose key names a secret) and replace matches with
  `[REDACTED:<rule>]`; store the row `local_only`. **Worker (promotion)**: run `@secretlint/core`
  `lintSource()` with the statically imported `@secretlint/secretlint-rule-preset-recommend` creator
  (about 30 ms cold, bundle-friendly), then an entropy check applied only to candidates that a
  secret-shaped regex already captured (gitleaks style: entropy is a secondary filter, thresholds
  3.0 bits/char for hex-only strings, 4.0 for base64 strings of at least 32 characters, never on bare
  words, git SHAs, UUIDs, or paths). A hit redacts again and classifies `secret`; otherwise the row is
  promoted to `eligible`. Memories produced by either summarizer pass the worker stage once more
  before insert.
- **Rationale**: FR-018 requires redaction before storage, so the hook cannot store plaintext and
  defer everything to the worker; but `@secretlint/node`'s `createEngine` costs 120-145 ms of cold
  start per process (measured three times) and resolves rules by package name at runtime, so it fits
  neither the 300 ms budget nor the bundle. The core API plus a statically imported preset avoids
  both problems. secretlint ships no entropy rule.
- **Refuter changes**: the first draft ran no content scan in the hook (violates FR-018 and User
  Story 3 scenario 1) and stored plaintext for path-rule hits; standalone entropy thresholds over
  arbitrary tokens flag every git SHA and UUID and have a mathematical dead zone for short strings,
  so entropy is now gated on regex candidates.
- **Alternatives**: `@secretlint/node` (cold start, bundle-hostile); full secretlint in the hook
  (budget); secretlint's `maskSecrets` formatter (lives on the bypassed path).
- **Deviation**: Principle VI names `@secretlint/node`; the plan uses `@secretlint/core` and the
  recommend preset instead (Complexity Tracking).

## R5. Lexical retrieval

- **Decision**: Two external-content FTS5 tables over `memories`: `memories_fts` (`tokenize =
  'trigram'`, over title + body) and `memories_fts_cjk` (`tokenize = 'unicode61'`, over a
  TypeScript-generated column of overlapping bigrams for CJK runs; run detection includes the Common
  script marks used inside Japanese words: U+30FC ー, U+3005 々, U+30FB ・). Query construction:
  `Intl.Segmenter` word segments; segments of three or more non-CJK characters become trigram
  `MATCH` terms; CJK segments become bigram terms against the CJK table; one-character Japanese
  particles and function words (の は が を に と で も へ や か な) are dropped; the `LIKE` fallback
  runs only when no indexed term remains. Ranking: BM25 per table, normalized per table as
  `score / best_score`; the relevance threshold (config `retrieval.threshold`, default 0.3) applies
  to the normalized BM25; Reciprocal Rank Fusion (k = 60) orders candidates across the two tables
  (a `LIKE` list never votes); MMR (lambda 0.5) with character-trigram cosine similarity removes near
  duplicates; the result is cut at a character budget supplied by the caller (FR-025). Repository
  scope is a join on `memories.repo_id` (an `UNINDEXED` column on an external-content table is not a
  stored filter).
- **Rationale**: FTS5 trigram cannot match queries shorter than three characters (documented and
  reproduced); unicode61 alone turns unspaced Japanese into one token. The RRF score range is
  bounded, so a threshold must be applied to normalized BM25, not to RRF.
- **Refuter changes**: threshold moved from RRF to normalized BM25; particles removed from the
  short-term bucket (otherwise every Japanese prompt fell into a full-table `LIKE` scan); the `LIKE`
  list no longer votes in fusion; long-vowel marks added to CJK runs; the `UNINDEXED` shortcut
  dropped.
- **Alternatives**: word tokenizers (cannot segment Japanese); `LIKE` only for CJK (no ranking);
  contentless FTS5 (restricts auxiliary functions); a dependency for n-gram similarity (30 lines).
- **Open**: threshold and lambda defaults are calibrated on the SC-009 fixture; the per-agent
  documented context limits used for the cap are recorded in `contracts/agents.md`.

## R6. Detached worker and lease

- **Decision**: Hooks that see new work spawn `oboete observe` with `child_process.spawn(execPath,
  [bundle, 'observe'], { detached: true, stdio: 'ignore' }).unref()` only when `worker_lease` is
  stale. `worker_lease` is a single row seeded by the first migration (`id = 1`, empty owner).
  Claim: `BEGIN IMMEDIATE; UPDATE worker_lease SET owner_token = ?, pid = ?, heartbeat_at = ?
  WHERE id = 1 AND (owner_token IS NULL OR heartbeat_at < ? - 6000 OR heartbeat_at > ? + 60000)`;
  `changes = 0` means another worker is live, and `SQLITE_BUSY` after the busy timeout is treated the
  same way. Heartbeat every 2 s; stale after 6 s; a heartbeat more than 60 s in the future means the
  clock jumped and the lease is treated as stale. Batches are claimed with a per-batch id
  (`observation_batches`, `UNIQUE (session_id, through_event_id)`), so a reclaimed batch is applied at
  most once even if the provider was called twice. Before exiting, the worker releases the lease and
  re-checks for new events; the next hook respawns if anything arrived in the gap. Spool entries are
  one file per event written with write-then-rename (append is not atomic for large records) under
  `~/.oboete/spool/`; the worker recovers them in name order before building batches. When both the
  database and the spool are unwritable, the hook exits 0, increments nothing durable, and doctor
  reports the condition by probing writability. Raw events older than 7 days that belong to an
  applied batch are purged in bounded `DELETE ... LIMIT` steps at the start of every worker run.
- **Rationale**: the constitution forbids a daemon, `flock`, and `/proc` introspection; SQLite's
  single-writer rule plus `BEGIN IMMEDIATE` gives the atomic claim; Node's documented detached spawn
  works on Linux and Windows unchanged.
- **Refuter changes**: seed row (otherwise no worker ever runs), `SQLITE_BUSY` on the claim, lease
  release on exit (lost wakeup), per-batch claim tokens, clock-jump rule, non-atomic append,
  loss counting when the disk is full.
- **Alternatives**: legacy lock-file protocol (Linux-only `/proc`); `flock` (forbidden); heap-based
  memory management (RSS growth is allocator fragmentation).
- **Open**: TTL values are validated against the fixture; the 8-second session-start wait applies to
  Claude Code and Codex, whose hook timeouts setup raises to 12 s; Grok Build's deferred injection
  does not wait (FR-045).

## R7. Hook normalization and per-agent adapters

- **Decision**: One discriminated union of normalized events (`session_start`, `prompt`,
  `tool_call`, `tool_result`, `tool_failure`, `turn_end`, `session_end`, `compaction_summary`,
  `last_assistant_message`) with a common envelope (`agent` derived from the environment, `session_id`,
  `conversation_id`, `repo_id` derived by oboete, `captured_at`, optional `agent_id`/`agent_type`
  for subagents). No raw passthrough is stored. Injection policy per agent is in
  `contracts/agents.md`; the essentials: Claude Code injects at `SessionStart` for `startup`, `clear`
  and `compact`, never for `resume` or `fork` (the transcript replays the earlier pack), and at
  `UserPromptSubmit`; Codex injects at `SessionStart` (matcher `startup`; whether a compaction source
  exists is probed in the implement phase) and `UserPromptSubmit` with `additionalContextLimit = 0`;
  Grok Build injects only after the first successful tool call of a turn (`PostToolUse`), with
  `PreToolUse` used only to record the attempt, because a denied call drops both channels; Pi injects
  from `before_agent_start` by awaiting a bounded child `oboete inject` (all storage access happens in
  the child, never in Pi's event loop), and captures through a detached child. `PostToolUseFailure`
  maps to `tool_failure` on Claude Code and Grok Build.
- **Rationale**: every mapping traces to the verified evidence; the corrections came from refuters
  reading the same evidence.
- **Refuter changes**: failed tool calls were unmapped; Grok's two channels are not redundant
  against deny; Codex `startup|resume` inverted FR-024; `fork` was missing from the source values;
  the raw passthrough duplicated unredacted content; in-process sqlite in Pi cannot be interrupted.
- **Open**: Codex and Grok have no confirmed free summary field comparable to Claude Code's
  `compact_summary`; Pi's compaction event is unconfirmed; real tool payload shapes for Read, Edit,
  Write, and Bash on all four agents are captured as versioned fixtures in the first implementation
  task (evidence open item 4).

## R8. Configuration, paths, and repository identity

- **Decision**: `smol-toml` (parse and stringify, zero dependencies, TOML 1.0) for
  `~/.oboete/config.toml`. Data directory `~/.oboete/` resolved with `os.homedir()` and `node:path`,
  overridable with `OBOETE_HOME`; XDG/AppData splitting is deferred to a constitution amendment
  (Complexity Tracking). Repository identity: the `origin` remote, else the first remote, normalized
  to `host/path` (scp-like rewritten as `ssh://`, userinfo removed, host lowercased, default port and
  trailing `.git` or `/` removed), hashed with SHA-256, first 16 hex characters; without a remote,
  the realpath of `git rev-parse --git-common-dir` (so every worktree of the same repository shares
  one identity). Repository-level rules live in `.oboete.toml` at the repository root (same parser;
  a committed file can only add path rules, never relax sensitivity). The Codex trust entry is added
  to the user's `config.toml` by a minimal textual append of one `[hooks.state."<key>"]` table (never
  a full re-serialization of a user-maintained file). Provider credentials come from
  `~/.oboete/config.toml` (file mode 0600, doctor warns otherwise) or an environment variable named
  in the preset (`OBOETE_CF_API_TOKEN`, `OBOETE_PROVIDER_API_KEY`); the value never appears in logs,
  spool entries, doctor output, or packs (fail-closed test).
- **Refuter changes**: `--show-toplevel` split remote-less worktrees; the foreign-TOML write for the
  Codex trust row was unaddressed; `sudo -iu` on this host sanitizes `PATH`, so the dogfood harness
  passes the environment explicitly.
- **Alternatives**: `@iarna/toml` (stale, pre-1.0 spec); `toml` (parse only); JSON config (violates
  the constitution's literal file name); a git-URL parsing dependency (still needs the same rules).

## R9. Viewer and search surface

- **Decision**: Hono on `@hono/node-server` (the Node adapter Hono requires; treated as implied by
  the allow-list's "Hono"), bound to `127.0.0.1` with a per-launch random token in the URL and an
  `Origin` check on mutating routes; SSE via `hono/streaming`; change detection by polling
  `PRAGMA data_version` on a read connection every 500 ms (node:sqlite has no update hook). The
  Preact + Vite SPA is built by the `build` script and its output is embedded into the bundle as
  string assets at build time (no separate asset directory; nothing committed). MCP: a hand-written
  stdio JSON-RPC 2.0 server implementing `initialize`, `server/discover`,
  `notifications/initialized`, `tools/list`, and `tools/call` for `search`, `timeline`, `get`;
  repository identity is derived from the server's own working directory with the same function as
  capture, and a client-supplied repository identity is rejected. Pi's tool surface calls
  `oboete search --json` and friends as child processes (no in-process sqlite). Registration:
  Claude Code `claude mcp add`, Codex `[mcp_servers.oboete]` in `config.toml`, Grok Build's MCP
  configuration, Pi settings; the exact commands are recorded in `contracts/agents.md` and verified
  in the E2E run.
- **Refuter changes**: the MCP spec revision of 2026-07-28 makes `server/discover` mandatory for a
  modern server; `prepack` does not run for git dependencies on npm 12, so assets are embedded at
  build time; the viewer has no local write path, so polling is the only signal.
- **Alternatives**: `@modelcontextprotocol/sdk` (93 packages, 28 MB, HTTP and OAuth transports
  oboete never uses); `Session`/changeset API (writer-side opt-in); committing `dist/`.

## R10. Summarizer contract and rule-based fallback

- **Decision**: One JSON contract shared by the LLM observer and the fallback (`contracts/observer.md`):
  a list of observations (`type` from claude-mem's eight ids: bugfix, feature, refactor, change,
  discovery, decision, security_alert, security_note; `title`; `body`; `concepts`; `citations` with
  files read, files modified, commits) plus one session summary (request, investigated, learned,
  completed, next steps). The worker stamps `repo_id`, `session_id`, sensitivity (the strictest of
  the batch's input rows on both paths), `degraded_reason`, `content_hash`. Fallback heuristics:
  file-touch clustering per turn, failed-command and error extraction from tool failures, decisions
  from the agent's own last assistant message and compaction summary (free hook text), next actions
  from unfinished turns; all emitted text is quoted from the source, section labels are chosen by
  the dominant script of the input (FR-014). Degraded reasons: `no_provider`, `unreachable`,
  `unusable_output`, `daily_cap`, `provider_exhausted`. The ADD/UPDATE/DELETE/NOOP step selects
  nearby candidates with the R5 retrieval over the new observation's title and body (same repo, top
  8, including tombstoned rows), asks the provider for a decision per candidate in the same call, and
  applies: a tombstoned hit suppresses the insert and records it for `why`; an active hit is NOOP or
  UPDATE (supersession link); no hit is ADD. Excerpting is recorded on the batch, not on the
  append-only event row.
- **Refuter changes**: tombstone-aware dedupe (FR-035); no porting of legacy helpers; language
  neutrality; separate `daily_cap` from `provider_exhausted`; batch-level excerpt record.
- **Alternatives**: nested claude-mem fields (kept flat to keep the schema cheap); the legacy
  eight-kind enum; content hash over raw payloads.

## R11. Fixture, measurement, and isolated E2E

- **Decision**: `node:test` only. The 1,000-event fixture is a JSONL of **native hook payloads**
  per agent (as the agents send them), generated deterministically by a zero-dependency script from
  a set of synthetic git repositories created on the fly (with and without remotes, two clones of one
  remote), so replaying it through the real bundle exercises identity derivation, redaction, and
  spool paths. Seeded content: three facts per SC-001 pair, Japanese and English fact pairs for
  SC-009, and a synthetic secret corpus for SC-005 held as data literals with a narrowly scoped
  gitleaks allowlist entry. The replay harness spawns the real hook per event (cold start), records
  p99 hook time, worker peak RSS from `process.resourceUsage().maxRSS` reported by the worker at
  exit, and database growth, and writes `docs/evidence/m1-resource-envelope.md`. Failure injection
  uses a test-only seam (`OBOETE_TEST_FAULT=busy|corrupt|readonly|enospc|provider:<code>`) because
  mounting a small filesystem needs root. The isolated dogfood user has all four agent logins; the
  SC-001 matrix prompts force a tool call so the Grok clause is testable; SC-007 is a local, scripted
  daily run, not CI.
- **Refuter changes**: fixture lines must not carry values the system derives (repo id, session id);
  no catchable `SQLITE_BUSY` string exists (use `errcode`); `mount` needs root; samplers miss the
  worker's RSS peak; `grok --print` does not exist (`grok -p`).

## R12. Decisions added for the critic's gaps

- Injection marker: every pack starts with the line `oboete memory context (do not restate)` and
  ends with `end of oboete memory context`; capture recognizes a pack by matching the pack hash stored
  in `injections` for that conversation, with the marker line as a fallback (FR-021).
- Conversation identity: `sessions.conversation_id` equals the agent session id for a fresh session
  and is inherited on resume; a fork is a new conversation that is not injected (FR-024, FR-026).
- Allowance: `provider_usage (utc_day, preset, calls, neurons_estimate, exhausted_at)` updated in
  the batch transaction; the day boundary is compared against the stored reset instant so a clock
  change neither double-charges nor double-resets.
- Free-model catalog: `GET /accounts/{id}/ai/models/search` is read once per worker run with a
  24-hour cache; a model whose catalog entry carries the paid-plan property, or a 403/5035 response,
  switches the preset to degraded `provider_paid` and doctor names it.
- Citation staleness: the prompt-submit hook checks cited paths with `fs.existsSync` only; commit
  existence is checked by the worker (one batched `git cat-file --batch-check`) and cached on the
  memory row.
- Pause: the file `~/.oboete/paused` is checked before the database is opened; a paused hook writes
  nothing and exits 0.
- Setup probes: after writing configuration, setup runs one headless invocation per selected agent
  (`claude -p`, `codex exec`, `grok -p`, `pi -p`) with a probe prompt and asserts that a probe event
  landed; each probe has a 30-second budget and setup reports trust state per agent.
- Export/import: JSONL, one memory per line with repository identity, sensitivity, provenance,
  citations, `deleted_at`, `superseded_by`; import unions on `content_hash`, keeps the stricter
  sensitivity, and applies tombstones.
- Codex hook file: `~/.codex/hooks.json` is the primary write (same handler shape as Claude Code,
  same trust identity); the `[hooks.state]` trust row goes into `config.toml`. The constitution's
  sentence "Codex uses `~/.codex/config.toml` hooks" is satisfied by the trust row and is clarified
  in Complexity Tracking.
- Installed size: the plan budgets 30 MB unpacked for the package plus runtime dependencies; the
  first implementation task runs `npm pack` on the final `package.json` and records the number.
- Concurrent sessions: prompt-submit retrieval reads memories only (never raw events), and only from
  applied batches, so an unfinished turn of another session is never injected.
- Unrecognized agent: detection order is `GROK_HOOK_EVENT` or `GROK_SESSION_ID` → Grok Build;
  `CODEX_*` environment or Codex-shaped stdin → Codex; `PI_SESSION_ID` → Pi; `CLAUDE_*` environment
  or Claude-shaped stdin → Claude Code; anything else is stored with provenance `unknown` and
  reported by doctor.
