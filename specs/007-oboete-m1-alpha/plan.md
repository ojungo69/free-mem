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
code. An independent Codex plan (`codex-plan.json`) was merged for schema and phase order, and an
independent Codex plan review contributed 22 corrections that are now part of the research record.

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
failure-injection matrix through a test-only seam; isolated four-agent E2E on a separate Linux
user (local job, not CI); `eslint` and `tsc --noEmit` gates.

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
start with `{`; secrets redacted before the first write.

**Scale/Scope**: one developer, one machine, roughly 1,000 events per day, four agents, tens of
repositories, memories in the low thousands during M1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Automatic, agent-neutral memory | PASS | One store, one normalized event schema, eligibility from sensitivity and repository only (FR-005); Grok Build's deferred channel is a delivery difference, not an eligibility one (FR-045). |
| II. One file, no daemon | PASS, amendment needed | WAL, short-lived hooks, detached `observe` with a fenced `worker_lease`; engine code plus its hook-path dependencies are one ESM file; heavy dependencies stay in `node_modules`. The constitution's "bundled into a single file" needs a PATCH clarification (exception 1). |
| III. Local-first, fail-closed classification | PASS | The complete detector runs in the hook before any write; batches split by destination so the remote observer only ever receives eligible rows; one egress rule table; packs marked and recognized; setup shows destination, credential source, cost class, egress and stores consent. |
| IV. Honest degradation and bounded resources | PASS, amendment needed | Rule-based fallback in the same schema; degraded reasons on packs and in doctor; budgets enforced and measured. The 8-second session-start wait (spec FR-024) exceeds the 300 ms hook budget as written in Principle IV; exception 2 defines the capture / injection split and needs a PATCH amendment. |
| V. Parity target and milestones | PASS | M1 scope only; `sync_conflicts`, RRF fusion hook, and `loadExtension` keep M2 possible without migration. |
| VI. Portable and minimal | PASS, exceptions listed | No Linux-only facility; every added package has a reason; hand-written MCP transport; `@secretlint/core` replaces `@secretlint/node` (exception 3); `~/.oboete/` kept over XDG (exception 4). |
| Workflow gates | PASS with gate | Spec Kit sequence followed; unverified contracts are blocked behind R13 probes recorded in `docs/research/`; isolated dogfood; security-related code implemented by Claude Code, not delegated. |

**Approval required before implementation**: exceptions 1-4 in Complexity Tracking amend the
constitution (PATCH: wording clarifications and the dependency substitution). Per Governance, the
owner approves them; `tasks.md` starts with the amendment task.

Post-design re-check: no new violation beyond the four listed exceptions.

## Requirement traceability

| Requirement | Where it is designed | Where it is verified |
|---|---|---|
| FR-001..FR-009 capture | research R1, R2, R4, R6, R7; contracts/agents.md; data-model raw_events, spool | fixture replay, failure matrix, contract fixtures (R13) |
| FR-010..FR-016 summarization | R3, R6, R10; contracts/observer.md; observation_batches, provider_usage | provider fault tests, fallback tests, batch-split tests, language tests |
| FR-017..FR-023 privacy | R4, R10; data-model destination_rules; privacy tests both directions | SC-005, SC-006 |
| FR-024..FR-030 retrieval and injection | R5, R7, R12; contracts/agents.md pack format; injections ledger | SC-001, SC-009, SC-010, staleness tests |
| FR-031..FR-036 setup, doctor, lifecycle | R8, R12; contracts/cli.md; managed blocks, probes, consent | SC-008, setup repeat/remove tests, import validation tests |
| FR-037, FR-038 viewer | R9; contracts/cli.md `view` | SC-011, loopback and token tests |
| FR-039..FR-041 platform and evidence | R2, R11 | CI matrix, `docs/evidence/`, isolated E2E |
| FR-042..FR-045 clarifications | R7 (Grok state machine), R10 (store-then-review), R8 (native memory warnings), R5 (same repository) | Grok deny/no-tool tests, native-memory detection tests |
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
└── e2e/isolated-user.mjs
src/
├── cli.ts               # parseArgs dispatch, exit codes (contracts/cli.md)
├── config.ts            # OBOETE_HOME, config.toml, consent record, credentials, paused marker
├── paths.ts
├── repo-identity.ts     # remote normalization, git-common-dir fallback, sha256 prefix
├── db/
│   ├── open.ts          # DatabaseSync with timeout, WAL pragmas, migration runner
│   ├── migrations/0001_core.sql, 0002_memory_search.sql, 0003_operations.sql
│   └── queries.ts       # shared scope + sensitivity filter used by injection, CLI, MCP, viewer
├── events.ts            # normalized event union (zod), agent detection order, event id derivation
├── agents/claude.ts, grok.ts, codex.ts, pi.ts
├── capture.ts           # hook path: paused check, private strip, path rules, detector, insert or spool
├── privacy/
│   ├── detect.ts        # @secretlint/core + preset + gated entropy, [REDACTED:<rule>]
│   ├── classify.ts      # worker promotion, batch split by destination
│   └── egress.ts        # destination_rules evaluation
├── worker/observe.ts, lease.ts, batches.ts, purge.ts
├── observer/contract.ts, providers.ts, llm.ts, fallback.ts, classify.ts, catalog.ts
├── retrieval/fts.ts, query.ts, rank.ts
├── injection/pack.ts, deferred.ts, staleness.ts
├── setup/detect.ts, managed-block.ts, write-claude.ts, write-codex.ts, write-grok.ts, write-pi.ts, probe.ts, consent.ts
├── doctor.ts
├── transfer.ts          # export / import with per-line validation and derived-field recomputation
├── mcp.ts               # legacy-era stdio JSON-RPC server
└── viewer/server.ts, app/
test/
├── unit/*.test.ts       # compiled to build/test before node --test
├── migrations/*.test.ts # empty and previous-version databases
├── contracts/<agent>/*.json
└── fixtures/events-1000.jsonl
docs/evidence/m1-resource-envelope.md, m1-dogfood.md
docs/research/            # verification-gate probe results appended
```

**Structure Decision**: single package, single engine bundle. Frontend (viewer) is implemented by
Claude Code directly; security-related modules (`privacy/*`, `config.ts`, `setup/write-codex.ts`,
`setup/managed-block.ts`, `transfer.ts` import validation, `viewer/server.ts` auth) are
implemented by Claude Code and not delegated; the rest is delegated to Codex or Grok Build per task.

## Delivery order (input to /speckit-tasks)

0. **Amendments and verification gate**: owner approval of exceptions 1-4; the R13 probes recorded
   in `docs/research/`; measured bundle cold start and installed size.
1. **Foundation**: package, build, lint, migrations 0001-0003 with smoke tests on 22.16 and 24.x,
   `open.ts`, repo identity, config, consent, paused marker; fixture generator and replay skeleton.
2. **Capture kernel and privacy boundary**: normalized events, agent detection, detector in the hook,
   path rules, insert-or-spool, egress rule table, both-direction privacy tests, mixed-sensitivity
   batch split.
3. **Worker and observer**: fenced lease, spool recovery, batches, purge, checkpoint; provider
   presets with deadlines and reservations, allowance table, catalog check; fallback summarizer;
   classification with target restriction; tombstone-aware insert.
4. **Retrieval and injection**: FTS tables, query routing, ranking, character budget, common pack
   builder with staleness checks, marker, ledger, `why`.
5. **Claude Code and Codex vertical slice**: managed-block writers, probes, session-start policy per
   source, resume/compact/fork/clear behaviour, cross-agent E2E for the two lanes.
6. **Grok Build and Pi**: deferred delivery state machine, Pi loader and child processes with
   durable diagnostics, writers, probes, E2E for the remaining pairs.
7. **User surface**: CLI commands, MCP server and registrations, viewer, export/import, doctor,
   pause/resume.
8. **Evidence**: 1,000-event replay numbers, failure matrix, isolated dogfood harness, 7-day run,
   installed-size measurement.

## Complexity Tracking

| # | Violation | Why Needed | Simpler Alternative Rejected Because |
|---|-----------|------------|-------------------------------------|
| 1 | Engine file bundles only the hook-path packages; `ai`, `@ai-sdk/*`, `workers-ai-provider`, `hono`, `@hono/node-server`, `preact` stay in `node_modules` and are lazily imported | Bundling them into ESM output throws `Dynamic require` for CommonJS transitive packages and loads megabytes on every 300 ms hook | A second hook-only bundle would be two engine files; needs a PATCH clarification of Principle II ("single file" = oboete's engine code) |
| 2 | Session-start injection may take up to 8 s while a summary is pending (spec FR-024) although Principle IV budgets a hook process at 300 ms | The wait is a spec requirement (User Story 1, scenario 3) and only applies to the session-start injection path; capture hooks keep 300 ms | Dropping the wait breaks scenario 3; needs a PATCH amendment of Principle IV distinguishing capture and injection SLAs |
| 3 | `@secretlint/core` + `@secretlint/secretlint-rule-preset-recommend` (+ `@secretlint/types` dev) instead of the listed `@secretlint/node` | `@secretlint/node` costs 120-145 ms cold start per process and resolves rules by package name at runtime, so it cannot run in the hook or be bundled; the core API with a static preset costs about 30 ms and is required for redaction before the first write (FR-018) | `@secretlint/node` only in the worker violates FR-018; needs a PATCH amendment of Principle VI |
| 4 | `~/.oboete/` instead of an XDG/AppData split | The constitution's Product Constraints fix the directory; Principle VI's convention sentence conflicts | Deferred to an amendment that picks one; `OBOETE_HOME` provides relocation now |
| 5 | `esbuild` (dev) | A single-file engine bundle is required; `tsc` cannot produce one; type stripping is flagged below 22.18 | tsup wraps esbuild with 17 extra dependencies |
| 6 | `@hono/node-server` | Hono cannot bind a Node HTTP server without its adapter | Hand-written adapter duplicates the package |
| 7 | `smol-toml` | The constitution mandates `config.toml`; Node has no TOML parser; setup writes values | JSON config contradicts the file name; other TOML packages are stale or parse-only |
| 8 | `@ai-sdk/provider` | Required peer of `workers-ai-provider` | None |
| 9 | `eslint` + `typescript-eslint` (dev) | The constitution's release evidence requires a lint gate | `tsc --noEmit` alone is not a linter |
| 10 | `vite` + `@preact/preset-vite` (dev) | Listed Vite and Preact need the preset to compile TSX | Hand-rolled JSX transform |
| 11 | `typescript`, `@types/node` (dev) | Type gate | None |
| 12 | Codex hooks written to `~/.codex/hooks.json` with the trust row in `config.toml` | Codex reads both files with one trust identity; a managed block appended to `config.toml` avoids re-serializing a user-maintained file | Writing the handler itself into `config.toml` requires a full TOML rewrite; wording clarification, not a violation |
| 13 | `.oboete.toml` for repository path rules | Same parser as the user config; a committed file may only add rules | YAML would add a parser |
| 14 | Hand-written legacy-era stdio MCP server | `@modelcontextprotocol/sdk` pulls 93 packages / 28 MB for transports oboete never uses | Owning the legacy handshake is small; a dual-era server is out of M1 scope and clients fall back |
| 15 | Anthropic preset without schema-constrained output | Anthropic's OpenAI-compatible endpoint ignores `response_format` | Dropping the listed preset; text-JSON with zod validation keeps it |
