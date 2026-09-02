# Implementation Plan: oboete M1 Self-Use Alpha

**Branch**: `007-oboete-m1-alpha` | **Date**: 2026-09-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-oboete-m1-alpha/spec.md`

## Summary

Build the first usable oboete: four coding agents (Claude Code, Codex CLI, Grok Build, Pi) capture
their sessions into one SQLite file through short-lived hook processes, a detached single worker
summarizes batches into typed memories with a Workers AI observer or a rule-based fallback, and
session start and prompt submit inject same-repository memories under a relevance threshold and an
adaptive cap. Sensitivity is decided at capture, before the first write anywhere, and fails closed;
availability fails open. The product ships as one npm package with a single-file engine bundle, a
local viewer, `setup` and `doctor`, and evidence from a committed 1,000-event fixture and an
isolated dogfood account.

Research (`research.md`) resolved the technical unknowns with primary sources and local probes; the
items that remain unverified are listed as a verification gate (R13) that precedes any dependent
code and whose failures block the affected item instead of switching to a non-compliant fallback.
An independent Codex plan (`codex-plan.json`) was merged for schema and phase order, and two rounds
of independent Codex plan review contributed 38 corrections that are now part of the research
record.

## Technical Context

**Language/Version**: TypeScript 5.x compiled by esbuild to ESM; runtime Node.js >= 22.16 for the
engine (`node:sqlite` unflagged, FTS5 compiled in). CI matrix: 22.16 and 24.x. The four-agent E2E
and dogfood run on 24.x because Pi 0.84.4 requires Node >= 22.19 (support matrix in `README.md`).

**Primary Dependencies**: runtime, bundled into the engine file (pure ESM, needed on the hook
path): `zod`, `smol-toml`, `@secretlint/core`, `@secretlint/secretlint-rule-preset-recommend`.
Runtime, external and lazily imported off the hook path: `ai`, `@ai-sdk/provider`,
`workers-ai-provider`, `@ai-sdk/openai-compatible`, `hono`, `@hono/node-server`, `preact`. Dev:
`typescript`, `esbuild`, `vite`, `@preact/preset-vite`, `eslint`, `typescript-eslint`,
`@secretlint/types`, `@types/node`. Every package outside the constitution's allow-list has a
written reason in Complexity Tracking.

**Storage**: one SQLite file `~/.oboete/memory.db` (WAL, FTS5 trigram + CJK bigram tables), numbered
SQL migration files under `src/db/migrations/` embedded at build time, spool directory of one file
per overflow event, `config.toml`, `paused` marker, `logs/`.

**Testing**: `node:test` on esbuild-compiled tests with `--experimental-test-coverage`; migration
smoke tests on empty and previous-version databases; fixture replay through the real bundle;
failure-injection matrix through a test-only seam; isolated four-agent E2E and every third-party
probe on a separate Linux user (local job, not CI); `eslint` and `tsc --noEmit` gates.

**Target Platform**: Linux/WSL for M1 with no Linux-only facility; paths via `os.homedir()` and
`node:path`.

**Project Type**: CLI + agent hooks + Pi extension loader + local web viewer + stdio MCP (legacy era).

**Performance Goals**: capture hooks return within 300 ms for 99% of fixture events (SC-002);
session-start injection returns within 300 ms when the summary is ready and within 8 s when it is
pending (measured separately); worker peak RSS under 150 MB (SC-003); viewer shows a new memory
within 2 s (SC-011); setup for four agents under 2 minutes with parallel probes (SC-008).

**Constraints**: no resident process; constitution budgets (300 ms capture, 150 MB, 12,000
characters observer input, 7-day raw retention); provider calls capped at 150 per day, batched,
with a 60 s deadline each; installed size target 30 MB unpacked including dependencies; packs never
start with `{`; secrets redacted before the first write; a single text field is read up to 1 MB.

**Scale/Scope**: one developer, one machine, roughly 1,000 events per day, four agents, tens of
repositories, memories in the low thousands during M1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Automatic, agent-neutral memory | PASS | One store, one normalized event schema, eligibility from sensitivity and repository only (FR-005); Grok Build's deferred channel is a delivery difference, not an eligibility one (FR-045). |
| II. One file, no daemon | PASS, amendment needed | WAL, short-lived hooks, detached `observe` with a fenced `worker_lease`; engine code plus its hook-path dependencies are one ESM file; heavy dependencies stay in `node_modules`. The constitution's "bundled into a single file" needs a PATCH clarification (amendment A1). |
| III. Local-first, fail-closed classification | PASS | The complete detector runs in the hook before any write and fails closed on its own failure; batches split by destination and one request builder applies the rule table to every outbound field, so the remote observer only ever receives eligible rows and an opaque repository id; packs marked and recognized; setup shows destination, credential source, cost class, egress and stores consent bound to that tuple. |
| IV. Honest degradation and bounded resources | PASS, amendment needed | Rule-based fallback in the same schema; degraded reasons on packs and in doctor; budgets enforced and measured. The 8-second session-start wait (spec FR-024) exceeds the 300 ms hook budget as written in Principle IV; amendment A2 defines the capture / injection split. |
| V. Parity target and milestones | PASS | M1 scope only; `sync_conflicts`, RRF fusion hook, and `loadExtension` keep M2 possible without migration. |
| VI. Portable and minimal | PASS, amendments listed | No Linux-only facility; every added package has a reason; hand-written MCP transport; `@secretlint/core` replaces `@secretlint/node` (A3); `~/.oboete/` kept over XDG (A4). |
| Workflow gates | PASS with gate | Spec Kit sequence followed; unverified contracts are blocked behind R13 probes recorded in `docs/research/`; isolated dogfood; security-related code implemented by Claude Code, not delegated. |

### Amendments and spec corrections that need the owner's approval (task 0)

| id | document | change | kind |
|---|---|---|---|
| A1 | CONSTITUTION Principle II | "bundled into a single file" = oboete's engine code and its hook-path dependencies; heavy runtime packages may stay in `node_modules` and load lazily off the hook path | PATCH wording |
| A2 | CONSTITUTION Principle IV | capture hooks 300 ms; injection at session start may wait up to 8 s while a summary is pending, then degrade | PATCH wording |
| A3 | CONSTITUTION Principle VI allow-list | `@secretlint/core` + `@secretlint/secretlint-rule-preset-recommend` replace `@secretlint/node` | PATCH dependency substitution |
| A4 | CONSTITUTION Principle VI, Product Constraints; spec FR-039 and Assumptions | one data directory `~/.oboete/` relocatable by `OBOETE_HOME`; XDG/AppData split deferred to a later milestone | PATCH wording + spec amendment |
| A5 | CONSTITUTION Product Constraints (Codex hook location) | Codex handlers live in `~/.codex/hooks.json` with the `[hooks.state]` trust row in `config.toml`, both inside managed blocks | PATCH wording |
| A6 | spec Assumptions | headless Grok Build is `grok -p` (the verified flag), not `grok --print` | spec correction |
| A7 | spec edge case "tool output larger than the summarizer's input limit" | a single text field is read up to 1 MB; beyond that the hook stores a redacted head and tail with a `truncated_bytes` marker | spec amendment |

Implementation starts only after these are approved or rejected in writing; a rejection returns
the affected decision to research.

Post-design re-check: no new violation beyond the amendments listed.

## Requirement traceability

Per-requirement rows; "designed" names the artifact section, "verified" names the test or evidence
document that fails when the requirement is broken.

| FR | designed in | verified by |
|---|---|---|
| FR-001 capture on all four agents | agents.md capture table; R7 | fixture replay per agent; contract fixtures (R13) |
| FR-002 no daemon, short-lived hooks | R1, R6; cli.md `hook`/`observe` | process-tree assertion in replay; lease tests |
| FR-003 normalized event schema | agents.md union; data-model raw_events | zod contract tests; unknown-payload test |
| FR-004 repository identity | R8; data-model repos | identity tests (remote forms, common-dir, import mapping) |
| FR-005 eligibility independent of agent | data-model destination_rules; R10 | privacy test "same decision when only the agent changes" |
| FR-006 append-only acceptance, spool | R1, R6; data-model spool entry | failure matrix db-missing/busy/corrupt/readonly/enospc |
| FR-007 idempotent re-delivery | R7 event identity | duplicate-delivery test per key form |
| FR-008 turn boundaries | data-model turns; agents.md Stop/agent_settled | replay ordinal tests |
| FR-009 unfinished turns never retrieved | agents.md injection policy; data-model turns | retrieval test with an open turn |
| FR-010 batched summarization | R6, R10; observer.md | batch trigger tests (ten turns, session end, retention) |
| FR-011 remote observer default preset | R3; observer.md presets | live probe (R13) + provider fault tests |
| FR-012 rule-based fallback | R10; observer.md fallback | fallback determinism tests |
| FR-013 typed memories | data-model memories; observer.md output | schema validation tests |
| FR-014 language of content | observer.md worker rules | ja/en pair tests |
| FR-015 12,000-character input bound | observer.md input | excerpt tests |
| FR-016 daily cap | R6 reservations; observer.md call policy | cap boundary test (149 → 150) |
| FR-017 sensitivity at capture, fail closed | R4; capture.ts | detector tests, detector-throw test, malformed `.oboete.toml` test |
| FR-018 redaction before storage | R4; R11 corpus | secret-corpus scan of db, spool, logs, packs |
| FR-019 `<private>` and path rules | R4 | strip and path-rule tests |
| FR-020 remote receives eligible only | R10; observer.md boundary; data-model destination_rules | mixed-batch outbound body assertion; nearby and repo_ref assertions |
| FR-021 pack recognition on capture | data-model injections.pack_hash | re-capture of an emitted pack test |
| FR-022 consent before egress | R8; cli.md setup | consent hash tuple tests; `--yes` mismatch test |
| FR-023 credentials never stored in config | cli.md environment | config-file and log scans |
| FR-024 session-start injection with wait | agents.md SLAs; R12 | ready and pending path timing |
| FR-025 prompt-submit injection | agents.md capture table | replay of prompt events |
| FR-026 no duplicate in a conversation | data-model injection_items partial index; R7 conversation id | resume/compact/fork/clear tests |
| FR-027 relevance threshold and cap | R5; agents.md policy; R12 context window | threshold tests; `window_unknown` budget test |
| FR-028 citation staleness | R12; data-model citations_head/ok | stale path and stale commit tests |
| FR-029 `why` ledger | data-model injections, injection_items; cli.md `why` | ledger tests |
| FR-030 tool interface | mcp.md; agents.md Pi tools | MCP client probes (R13); `mcp-clients.mjs` |
| FR-031 setup writes managed blocks | R8; cli.md setup | setup repeat/remove byte-identity tests |
| FR-032 setup probes | R12 setup probes | probe event assertion per agent |
| FR-033 doctor | cli.md doctor; R12 Pi diagnostics | break-one-item tests; Pi ack tests |
| FR-034 pause/resume | R12 pause | pause test (no db open) |
| FR-035 export/import | R12; data-model export line; cli.md | round-trip, lattice, tombstone, oversized-line tests |
| FR-036 pin/delete | data-model memories | viewer and CLI tests |
| FR-037 viewer loopback and token | R9 | bind and token refusal tests |
| FR-038 viewer freshness | R9 data_version polling | SC-011 timing |
| FR-039 no Linux-only facility, paths | R8 (A4 pending) | CI on both Node versions; path tests |
| FR-040 fixture evidence | R11; quickstart | `docs/evidence/m1-resource-envelope.md` |
| FR-041 isolated dogfood | R11; quickstart | `docs/evidence/m1-dogfood.md` |
| FR-042 store-then-review | R10; data-model memories.review_state | viewer review flow test |
| FR-043 native memory coexistence | R8 foreign files; cli.md setup warnings | native-memory detection tests |
| FR-044 same repository only | data-model destination_rules `same_repo_required`; mcp.md boundary | cross-repository injection test; MCP `repo` argument rejection |
| FR-045 Grok deferred delivery | agents.md state machine; data-model injections | Grok success/failure/deny/all-denied/no-tool tests counting packs the model received |
| SC-001..SC-011 | quickstart.md maps each to a command | `docs/evidence/m1-resource-envelope.md`, `m1-dogfood.md` |

## Project Structure

### Documentation (this feature)

```text
specs/007-oboete-m1-alpha/
├── plan.md              # This file
├── research.md          # Phase 0 output (R1-R13)
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # cli.md, agents.md, observer.md, mcp.md
├── codex-plan.json      # Independent second plan (evidence)
├── checklists/requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
package.json             # name oboete, bin, engines >=22.16, scripts: build/typecheck/lint/test/pack-check
package-lock.json
tsconfig.json
eslint.config.js
scripts/
├── build.mjs            # esbuild: engine bundle (hook-path deps bundled, heavy deps external), test compile, viewer assets
├── fixtures/generate-1000-events.mjs
├── fixtures/replay.mjs  # spawns the real hook per event; p99, maxRSS, growth
└── e2e/isolated-user.mjs, probe-contracts.mjs, mcp-clients.mjs
src/
├── cli.ts               # parseArgs dispatch, exit codes (contracts/cli.md)
├── config.ts            # OBOETE_HOME, config.toml, consent record, credentials, paused marker
├── paths.ts
├── repo-identity.ts     # remote normalization, git-common-dir fallback, sha256 prefix
├── db/
│   ├── open.ts          # DatabaseSync with timeout, WAL pragmas, migration runner
│   ├── migrations/0001_core.sql, 0002_memory_search.sql, 0003_operations.sql
│   └── queries.ts       # shared scope + sensitivity filter used by injection, CLI, MCP, viewer
├── events.ts            # normalized event union (zod), event id derivation, conversation id
├── agents/claude.ts, grok.ts, codex.ts, pi.ts
├── capture.ts           # hook path: paused check, size cap, private strip, path rules, detector, insert or spool
├── privacy/
│   ├── detect.ts        # @secretlint/core + preset + gated entropy, [REDACTED:<rule>], fail closed
│   ├── classify.ts      # worker promotion
│   └── egress.ts        # destination_rules evaluation
├── worker/observe.ts, lease.ts, batches.ts (destination split), purge.ts
├── observer/contract.ts, providers.ts, request.ts (outbound builder), llm.ts, fallback.ts, classify.ts, catalog.ts
├── retrieval/fts.ts, query.ts, rank.ts
├── injection/pack.ts, deferred.ts, staleness.ts, budget.ts
├── setup/detect.ts, managed-block.ts, write-claude.ts, write-codex.ts, write-grok.ts, write-pi.ts, probe.ts, consent.ts
├── doctor.ts
├── transfer.ts          # export / import with per-line validation and derived-field recomputation
├── mcp.ts               # legacy-era stdio JSON-RPC server
└── viewer/server.ts, app/
test/
├── unit/*.test.ts       # compiled to build/test before node --test
├── migrations/*.test.ts # empty and previous-version databases
├── contracts/<agent>/*.json
├── corpus/secrets.jsonl, directives.jsonl
└── fixtures/events-1000.jsonl
docs/research/context-windows.md   # model id → documented window, source (R12)
docs/evidence/m1-resource-envelope.md, m1-dogfood.md
docs/research/            # verification-gate probe results appended
```

**Structure Decision**: single package, single engine bundle. Frontend (viewer) is implemented by
Claude Code directly. Security-owned modules (implemented by Claude Code, never delegated):
`privacy/*`, `config.ts`, `setup/managed-block.ts`, `setup/write-codex.ts`, `db/queries.ts`,
`worker/batches.ts`, `observer/request.ts`, `observer/classify.ts`, `injection/*`, `mcp.ts`,
`transfer.ts`, `viewer/server.ts`. External lanes (Codex or Grok Build per task) get UI components,
fixture generators, non-boundary adapters, retrieval scoring, and build scripts; a delegated task
that touches a security-owned file is returned to Claude Code.

## Delivery order (input to /speckit-tasks)

0. **Amendments and verification gate**: owner decision on A1-A7; R13 probe scaffolding and the
   probes that need no oboete code, run under the isolated user and recorded in `docs/research/`;
   a failed probe blocks its dependents (R13 table) rather than switching to a fallback.
1. **Foundation**: package, build, lint, migrations 0001-0003 with smoke tests on 22.16 and 24.x,
   `open.ts`, repo identity, config, consent, paused marker; fixture generator and replay skeleton;
   then the R13 cold-start and installed-size measurements.
2. **Capture kernel and privacy boundary**: normalized events, fixed agent selectors, size cap,
   detector in the hook with fail-closed failure handling, path rules, insert-or-spool, egress rule
   table, both-direction privacy tests, mixed-sensitivity batch split with outbound body assertions.
3. **Worker and observer**: fenced lease, spool recovery, batches by destination, purge, checkpoint;
   provider presets with deadlines and per-attempt reservations, durable exhaustion signal,
   allowance table, catalog check; fallback summarizer emitting records; classification with target
   restriction; tombstone-aware insert; single session-summary source.
4. **Retrieval and injection**: FTS tables, query routing, ranking, character budget from the
   context-window table with `window_unknown`, common pack builder with staleness checks, marker,
   ledger, `why`, directive-corpus test.
5. **Claude Code and Codex vertical slice**: managed-block writers, probes, session-start policy per
   source, resume/compact/fork/clear behaviour, cross-agent E2E for the two lanes.
6. **Grok Build and Pi**: deferred delivery state machine with planned/delivered accounting, Pi
   loader and child processes with acknowledgement files, writers, probes, E2E for the remaining
   pairs.
7. **User surface**: CLI commands, MCP server and registrations, viewer with review state,
   export/import, doctor, pause/resume.
8. **Evidence**: 1,000-event replay numbers, failure matrix, isolated dogfood harness, 7-day run,
   installed-size measurement.

## Complexity Tracking

| # | Violation | Why Needed | Simpler Alternative Rejected Because |
|---|-----------|------------|-------------------------------------|
| 1 | Engine file bundles only the hook-path packages; `ai`, `@ai-sdk/*`, `workers-ai-provider`, `hono`, `@hono/node-server`, `preact` stay in `node_modules` and are lazily imported | Bundling them into ESM output throws `Dynamic require` for CommonJS transitive packages and loads megabytes on every 300 ms hook | A second hook-only bundle would be two engine files; amendment A1 |
| 2 | Session-start injection may take up to 8 s while a summary is pending (spec FR-024) although Principle IV budgets a hook process at 300 ms | The wait is a spec requirement (User Story 1, scenario 3) and only applies to the session-start injection path; capture hooks keep 300 ms | Dropping the wait breaks scenario 3; amendment A2 |
| 3 | `@secretlint/core` + `@secretlint/secretlint-rule-preset-recommend` (+ `@secretlint/types` dev) instead of the listed `@secretlint/node` | `@secretlint/node` costs 120-145 ms cold start per process and resolves rules by package name at runtime, so it cannot run in the hook or be bundled; the core API with a static preset costs about 30 ms and is required for redaction before the first write (FR-018) | `@secretlint/node` only in the worker violates FR-018; amendment A3 |
| 4 | `~/.oboete/` instead of an XDG/AppData split | The constitution's Product Constraints fix the directory; Principle VI's convention sentence and spec FR-039/Assumptions conflict | Amendment A4 picks one; `OBOETE_HOME` provides relocation now |
| 5 | `esbuild` (dev) | A single-file engine bundle is required; `tsc` cannot produce one; type stripping is flagged below 22.18 | tsup wraps esbuild with 17 extra dependencies |
| 6 | `@hono/node-server` | Hono cannot bind a Node HTTP server without its adapter | Hand-written adapter duplicates the package |
| 7 | `smol-toml` | The constitution mandates `config.toml`; Node has no TOML parser; setup writes values | JSON config contradicts the file name; other TOML packages are stale or parse-only |
| 8 | `@ai-sdk/provider` | Required peer of `workers-ai-provider` | None |
| 9 | `eslint` + `typescript-eslint` (dev) | The constitution's release evidence requires a lint gate | `tsc --noEmit` alone is not a linter |
| 10 | `vite` + `@preact/preset-vite` (dev) | Listed Vite and Preact need the preset to compile TSX | Hand-rolled JSX transform |
| 11 | `typescript`, `@types/node` (dev) | Type gate | None |
| 12 | Codex hooks written to `~/.codex/hooks.json` with the trust row in `config.toml` | Codex reads both files with one trust identity; a managed block appended to `config.toml` avoids re-serializing a user-maintained file | Writing the handler itself into `config.toml` requires a full TOML rewrite; amendment A5 |
| 13 | `.oboete.toml` for repository path rules | Same parser as the user config; a committed file may only add rules | YAML would add a parser |
| 14 | Hand-written legacy-era stdio MCP server | `@modelcontextprotocol/sdk` pulls 93 packages / 28 MB for transports oboete never uses | Owning the legacy handshake is small; a dual-era server is out of M1 scope and clients fall back; a client that cannot use it blocks that agent's tool surface pending amendment |
| 15 | Anthropic preset without schema-constrained output | Anthropic's OpenAI-compatible endpoint ignores `response_format` | Dropping the listed preset; text-JSON with zod validation keeps it |
| 16 | 1 MB per-field read cap with head/tail truncation | Detector time is content-size dependent; the 300 ms capture SLA cannot be measured without a bound | Storing unbounded fields makes SC-002 unmeasurable; amendment A7 |
