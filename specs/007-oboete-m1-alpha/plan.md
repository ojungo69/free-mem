# Implementation Plan: oboete M1 Self-Use Alpha

**Branch**: `007-oboete-m1-alpha` | **Date**: 2026-09-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-oboete-m1-alpha/spec.md`

## Summary

Build the first usable oboete: four coding agents (Claude Code, Codex CLI, Grok Build, Pi) capture
their sessions into one SQLite file through short-lived hook processes, a detached single worker
summarizes batches into typed memories with a Workers AI observer or a rule-based fallback, and
session start and prompt submit inject same-repository memories under a relevance threshold and an
adaptive cap. Sensitivity is decided at capture and fails closed; availability fails open. The
product ships as one npm package with a single-file engine bundle, a local viewer, `setup` and
`doctor`, and evidence from a committed 1,000-event fixture and an isolated dogfood account.

Research (`research.md`) resolved every technical unknown with primary sources and local probes,
and an independent Codex plan (`codex-plan.json`) was merged: its schema additions
(`observation_batches`, `injection_items`, `provider_usage`, `runtime_state`, `diagnostics`) and
its phase order (safety boundary first, Claude Code and Codex vertical slice before Grok and Pi) are
adopted; its proposals to bundle the viewer through Vite into the CLI and to take
`@modelcontextprotocol/sdk` are not (see research R2 and R9).

## Technical Context

**Language/Version**: TypeScript 5.x compiled by esbuild to ESM; runtime Node.js >= 22.16
(`node:sqlite` unflagged, FTS5 compiled in). CI matrix: 22.16 and 24.x.

**Primary Dependencies** (runtime, all external to the bundle and lazily imported off the hook
path): `ai`, `@ai-sdk/provider`, `workers-ai-provider`, `@ai-sdk/openai-compatible`, `zod`,
`@secretlint/core`, `@secretlint/secretlint-rule-preset-recommend`, `smol-toml`, `hono`,
`@hono/node-server`, `preact`. Dev: `typescript`, `esbuild`, `vite`, `@preact/preset-vite`,
`@secretlint/types`, `@types/node`. Additions to the constitution's allow-list are justified in
Complexity Tracking.

**Storage**: one SQLite file `~/.oboete/memory.db` (WAL, FTS5 trigram + CJK bigram tables),
numbered SQL migrations embedded in the bundle as strings, spool directory of one file per
overflow event, `config.toml`, `paused` marker, `logs/`.

**Testing**: `node:test` with `--experimental-test-coverage`; unit tests per module; fixture replay
through the real bundle; isolated four-agent E2E on a separate Linux user (local job, not CI).

**Target Platform**: Linux/WSL for M1 with no Linux-only facility (no sockets, `flock`, `/proc`,
bash-only hooks); paths via `os.homedir()` and `node:path`.

**Project Type**: CLI + agent hooks + in-process Pi extension loader + local web viewer + stdio MCP.

**Performance Goals**: hook process returns within 300 ms for 99% of fixture events (SC-002);
worker peak RSS under 150 MB (SC-003); viewer shows a new memory within 2 s (SC-011); setup for
four agents under 2 minutes (SC-008).

**Constraints**: no resident process; budgets from the constitution (300 ms, 150 MB, 12,000
characters observer input, 7-day raw retention, 8-second summary wait); provider calls capped at 150
per day and batched (session end and every 10 turns); installed size target 30 MB unpacked;
injection packs never start with `{`; secrets redacted before storage.

**Scale/Scope**: one developer, one machine, roughly 1,000 events per day, four agents, tens of
repositories, memories in the low thousands during M1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Automatic, agent-neutral memory | PASS | One store, one normalized event schema, eligibility from sensitivity and repository only (FR-005); Grok Build's deferred channel is a delivery difference, not an eligibility one (FR-045). |
| II. One file, no daemon | PASS with note | WAL, short-lived hooks, detached `observe` with `worker_lease`; engine code is one ESM file. Runtime dependencies stay in `node_modules` and are imported lazily; the constitution's "bundled into a single file" is read as oboete's own code (see Complexity Tracking). |
| III. Local-first, fail-closed classification | PASS | Hook redacts and stores `local_only`; worker promotes after secretlint plus gated entropy; one egress rule table (`destination_rules`); packs marked and recognized on capture; setup shows destination, credential source, cost class, egress before enabling. |
| IV. Honest degradation and bounded resources | PASS | Rule-based fallback in the same schema; degraded reasons on packs and in doctor; budgets enforced in code and measured by the fixture; allowance self-counted with the provider error as the authoritative stop. |
| V. Parity target and milestones | PASS | M1 scope only; `sync_conflicts`, `memory_vec`, RRF fusion hook, and `loadExtension` keep M2 possible without migration. |
| VI. Portable and minimal | PASS with exceptions | No Linux-only facility; dependency additions listed below with reasons; hand-written MCP transport instead of the SDK; no daemon, manifest compiler, sidecar, or hosted viewer. |
| Workflow gates | PASS | Spec Kit sequence followed; contracts verified in `docs/research/`; isolated dogfood; security-related code (redaction, credentials, trust hash, viewer auth) implemented by Claude Code, not delegated. |

Post-design re-check (after Phase 1): no new violation; the exceptions below stand.

## Project Structure

### Documentation (this feature)

```text
specs/007-oboete-m1-alpha/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output: cli.md, agents.md, observer.md, mcp.md
├── codex-plan.json      # Independent second plan (evidence)
├── checklists/requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
package.json             # name oboete, bin, engines >=22.16, scripts: build/typecheck/test/pack-check
tsconfig.json
scripts/
├── build.mjs            # esbuild: src/cli.ts -> dist/oboete.mjs (externals, shebang), embeds viewer assets
├── fixtures/generate-1000-events.mjs
├── fixtures/replay.mjs  # spawns the real hook per event, records p99 / RSS / growth
└── e2e/isolated-user.mjs
src/
├── cli.ts               # parseArgs dispatch, exit codes (contracts/cli.md)
├── config.ts            # OBOETE_HOME, config.toml (smol-toml), credentials, paused marker
├── paths.ts             # home resolution, spool/log paths
├── repo-identity.ts     # remote normalization, git-common-dir fallback, sha256 prefix
├── db/
│   ├── open.ts          # DatabaseSync with timeout, WAL pragmas, migration runner
│   ├── migrations.ts    # numbered SQL strings 0001.., checksums
│   └── queries.ts       # shared scope+sensitivity filter used by injection, CLI, MCP, viewer
├── events.ts            # normalized event union (zod), agent detection order
├── agents/
│   ├── claude.ts        # Claude Code adapter (also used by Grok Build's compat layer)
│   ├── grok.ts          # Grok envelope, native tool names, deferred injection state
│   ├── codex.ts         # hooks.json handler, trusted_hash, rollout shapes
│   └── pi.ts            # extension factory exported for the setup-written loader
├── capture.ts           # hook fast path: private strip, path rules, regex redaction, insert or spool
├── privacy/
│   ├── redact-fast.ts   # hook-stage patterns and [REDACTED:<rule>] marker
│   ├── classify.ts      # worker stage: @secretlint/core + gated entropy, promotion
│   └── egress.ts        # destination_rules evaluation
├── worker/
│   ├── observe.ts       # lease claim, spool recovery, batches, purge, checkpoint
│   ├── lease.ts
│   └── batches.ts
├── observer/
│   ├── contract.ts      # shared JSON schema (contracts/observer.md)
│   ├── providers.ts     # presets: workers-ai (REST), ollama, nim, openrouter, gemini
│   ├── llm.ts           # generate with maxRetries 0, error classification, neuron estimate
│   ├── fallback.ts      # rule-based summarizer
│   └── classify.ts      # ADD/UPDATE/DELETE/NOOP against nearby memories
├── retrieval/
│   ├── fts.ts           # trigram + CJK bigram maintenance, cjk run detection
│   ├── query.ts         # segmentation, term routing, BM25 normalization
│   └── rank.ts          # RRF, MMR, character budget
├── injection/
│   ├── pack.ts          # session-start and prompt packs, marker, ledger, why
│   └── deferred.ts      # Grok Build first-tool-call delivery
├── setup/
│   ├── detect.ts        # installed agents, native memory features
│   ├── write-claude.ts  # settings.json merge (oboete-owned handlers only)
│   ├── write-codex.ts   # hooks.json + config.toml trust row append
│   ├── write-grok.ts    # ~/.grok/hooks/oboete.json with explicit timeouts
│   ├── write-pi.ts      # ~/.pi/agent/extensions/oboete.js loader
│   └── probe.ts         # headless one-shot probe per agent
├── doctor.ts
├── transfer.ts          # export / import JSONL
├── mcp.ts               # stdio JSON-RPC server (initialize, server/discover, tools/*)
└── viewer/
    ├── server.ts        # Hono on @hono/node-server, loopback, token, SSE via data_version polling
    └── app/             # Preact + Vite SPA (built into string assets by scripts/build.mjs)
test/
├── unit/*.test.ts
├── contracts/<agent>/*.json   # captured native payload fixtures (versioned)
└── fixtures/events-1000.jsonl
docs/evidence/m1-resource-envelope.md
```

**Structure Decision**: single package, single engine bundle, viewer source under `src/viewer/app`
built by Vite and embedded as strings; no workspace or second package. Frontend (viewer) is
implemented by Claude Code directly; security-related modules (`privacy/*`, `config.ts` credential
handling, `setup/write-codex.ts` trust hash, `viewer/server.ts` auth) are implemented by Claude Code
and not delegated; the rest is delegated to Codex or Grok Build per task.

## Delivery order (input to /speckit-tasks)

1. **Foundation**: package, build, migrations 0001-0003, `open.ts`, repo identity, config, paused
   marker; the fixture generator and replay harness skeleton; measure bundle cold start.
2. **Capture kernel and privacy boundary**: normalized events, agent detection, fast redaction,
   path rules, insert-or-spool, egress rule table, both-direction privacy tests.
3. **Worker and observer**: lease, spool recovery, batches, purge, checkpoint; provider presets,
   error classification, allowance table; fallback summarizer; classification against nearby
   memories; memory insert with tombstone-aware dedupe.
4. **Retrieval and injection**: FTS tables, query routing, ranking, character budget from the
   agent's documented context limit, packs, marker, ledger, `why`, staleness notes.
5. **Claude Code and Codex vertical slice**: setup writers, probes, session-start and prompt-submit
   injection, resume and compaction behaviour, cross-agent E2E for the two lanes.
6. **Grok Build and Pi**: deferred injection state machine, Pi loader and child processes, setup
   writers, probes, E2E for the remaining pairs.
7. **User surface**: CLI commands, MCP server and registrations, viewer, export/import, doctor,
   pause/resume.
8. **Evidence**: 1,000-event replay numbers, failure-injection matrix, isolated dogfood harness,
   7-day run, `npm pack` size check.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| `@secretlint/core` + `@secretlint/secretlint-rule-preset-recommend` instead of the listed `@secretlint/node` | `@secretlint/node` costs 120-145 ms cold start per process and resolves rules by package name at runtime, so it cannot run in the hook or inside a bundle; the core API with a statically imported preset costs about 30 ms | Using `@secretlint/node` only in the worker still leaves the hook without the preset's coverage and leaves the bundle unable to include it; requires a PATCH amendment of Principle VI |
| `esbuild` (dev) | The constitution requires a single-file engine bundle; `tsc` cannot produce one and type stripping is flagged below Node 22.18 | tsup wraps esbuild with 17 extra dependencies |
| `@hono/node-server` | Hono cannot bind a Node HTTP server without its Node adapter | Writing the adapter by hand duplicates the package |
| `smol-toml` | The constitution mandates `config.toml`; Node has no TOML parser; setup writes config values | JSON config contradicts the constitution's file name; other TOML packages are stale or parse-only |
| `@ai-sdk/provider` (peer of `workers-ai-provider`) | Required peer, not optional | None |
| Runtime dependencies left outside the engine bundle | Bundling the AI SDK, Hono, Preact and secretlint into the hook file breaks CommonJS requires and loads megabytes on every 300 ms hook | A second "hook-only" bundle would be two engine files; lazy `import()` of external packages keeps one engine file and the hook path dependency-free |
| Codex hooks written to `~/.codex/hooks.json` with the trust row in `config.toml` | Codex reads both files with the same trust identity; a minimal append to `config.toml` avoids re-serializing a user-maintained 300-line file | Writing the handler into `config.toml` requires a full TOML rewrite with comment loss; constitution wording is clarified, not violated |
| `~/.oboete/` instead of XDG/AppData split | The constitution's Product Constraints fix the directory; Principle VI's convention sentence conflicts | Deferred to an amendment; `OBOETE_HOME` provides relocation now |
| `.oboete.toml` for repository path rules | Same parser as the user config; a committed file may only add rules | YAML would add a parser |
| Hand-written stdio MCP server | `@modelcontextprotocol/sdk` pulls 93 packages / 28 MB for transports oboete never uses | Owning `initialize`, `server/discover`, `tools/list`, `tools/call` is under 200 lines and is verified against each agent in E2E |
