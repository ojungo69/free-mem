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
start with `{`; secrets redacted before the first write; hook stdin is read up to 1 MB.

**Scale/Scope**: one developer, one machine, roughly 1,000 events per day, four agents, tens of
repositories, memories in the low thousands during M1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Automatic, agent-neutral memory | PASS | One store, one normalized event schema, eligibility from sensitivity and repository only (FR-005); Grok Build's deferred channel is a delivery difference, not an eligibility one (FR-045). |
| II. One file, no daemon | PASS, amendments needed | WAL, short-lived hooks, detached `observe` with a fenced `worker_lease`; engine code plus its hook-path dependencies are one ESM file; heavy dependencies stay in `node_modules` (A1). `oboete view` opens a loopback port only while the developer runs it in the foreground, which the principle's "no listening port" does not distinguish from a resident server (A9). |
| III. Local-first, fail-closed classification | PASS | The complete detector runs in the hook before any write and fails closed on its own failure; batches split by destination and one request builder applies the rule table to every outbound field, so the remote observer only ever receives eligible rows and an opaque repository id; packs marked and recognized; setup shows destination, credential source, cost class, egress and stores consent bound to that tuple. |
| IV. Honest degradation and bounded resources | PASS, amendment needed | Rule-based fallback in the same schema; degraded reasons on packs and in doctor; budgets enforced and measured. The 8-second session-start wait (spec FR-024) exceeds the 300 ms hook budget as written in Principle IV; amendment A2 defines the capture / injection split. |
| V. Parity target and milestones | PASS | M1 scope only; `sync_conflicts`, RRF fusion hook, and `loadExtension` keep M2 possible without migration. |
| VI. Portable and minimal | PASS, amendments listed | No Linux-only facility; every added package has a reason; hand-written MCP transport; `@secretlint/core` replaces `@secretlint/node` (A3); `~/.oboete/` kept over XDG (A4). |
| Product Constraints (agent integration) | PASS, amendment needed | Pi captures through a detached child instead of importing the capture functions in-process, as FR-007 requires; the constraint text says in-process with a timeout (A10). |
| Workflow gates | PASS with gate | Spec Kit sequence followed; unverified contracts are blocked behind R13 probes recorded in `docs/research/`; isolated dogfood; security-related code implemented by Claude Code, not delegated. |

### Amendments and spec corrections that need the owner's approval (task 0)

| id | document | change | kind |
|---|---|---|---|
| A1 | CONSTITUTION Principle II | "bundled into a single file" = oboete's engine code and its hook-path dependencies; heavy runtime packages may stay in `node_modules` and load lazily off the hook path | PATCH wording |
| A2 | CONSTITUTION Principle IV | capture hooks 300 ms; injection at session start may wait up to 8 s while a summary is pending, then degrade | PATCH wording |
| A3 | CONSTITUTION Principle VI allow-list | `@secretlint/core` + `@secretlint/secretlint-rule-preset-recommend` replace `@secretlint/node` | PATCH dependency substitution |
| A4 | CONSTITUTION Principle VI, Product Constraints; spec FR-039 and Assumptions | one data directory `~/.oboete/` relocatable by `OBOETE_HOME`; XDG/AppData split deferred to a later milestone | MINOR amendment with Sync Impact Report (semantic change), or a dated approved exception expiring at M2 |
| A5 | CONSTITUTION Product Constraints (Codex hook location) | Codex handlers live in `~/.codex/hooks.json` with the `[hooks.state]` trust row in `config.toml`, both inside managed blocks | PATCH wording |
| A6 | CONSTITUTION Development Workflow (dogfood command list) | headless Grok Build is `grok -p` (the verified flag), not `grok --print` | PATCH wording |
| A7 | spec edge case "tool output larger than the summarizer's input limit" | the hook reads at most 1 MB of stdin and stops; a larger payload is recorded as a metadata-only failed row (fail closed) and its content is dropped; runner tolerance verified by R13 | spec amendment |
| A8 | spec FR-007 | "every thrown error is recorded" is satisfied by in-memory counters handed to the next child spawn plus the doctor wiring probe, or by Pi's own durable error log when the R13 probe finds one; a failure that stops every later spawn is detected by the probe rather than recorded | spec amendment (only if the R13 probe finds no Pi-owned durable error surface) |
| A9 | CONSTITUTION Principle II ("no listening port") | a resident or background port stays forbidden; `oboete view` may bind a loopback-only port for the lifetime of the foreground command | PATCH clarification (if rejected: portless viewer design returns to research) |
| A10 | CONSTITUTION Product Constraints (Pi integration) | Pi's in-process extension only enqueues to a detached child under a cooperative deadline, per FR-007; the child imports the capture functions | PATCH wording aligned with FR-007 |
| A11 | spec User Story 2 ("no event is summarized twice") | read as applied twice: provider attempts are at-least-once (a worker crash between response and apply causes one extra call), applied effects exactly-once | spec clarification |
| A12 | spec FR-024 / FR-026, User Story 1 scenario 2, SC-010 | compaction opens a new context epoch; "never the same memory twice" is scoped to (conversation, epoch), so the post-compaction re-injection FR-024 requires is allowed and resume stays deduplicated; SC-010 counts duplicates per epoch | spec clarification (if rejected: FR-024 re-injects only items not yet injected in the conversation) |
| A13 | spec FR-035 ("not re-created from the same content") | "same content" = identical (type, normalized title, normalized body), which is `material_hash`, so a paraphrase or the same text under another type is a new memory; a tombstone test covers same title/body with a different type | spec clarification (owner may instead drop `type` from the identity, which changes `material_hash`) |
| A14 | spec FR-002, FR-001, edge case "tool output larger than the summarizer's input limit", Independent Test of User Story 2 | only if the R13 detector probe shows the full detector cannot finish 1 MB inside the capture cutoff: the measured bound becomes the content limit; events at or below it are captured whole, above it metadata-only | spec amendment (conditional) |
| A15 | spec FR-045, FR-026, User Story 1 scenario 2, SC-010, FR-028; CONSTITUTION Principle IV (injection volume) | only if the R13 probe shows Grok delivers `additionalContext` once per call: either accept that the two calls of one parallel batch both carry the pack (duplicates counted in `why` and SC-010 scoped to distinct calls) or exclude parallel-batch delivery from M1 | spec + constitution exception (conditional) |

Implementation starts only after these are approved or rejected in writing; a rejection returns
the affected decision to research. A8 is raised only if the R13 Pi error-surface probe fails.

Post-design re-check: no new violation beyond the amendments listed.

## Requirement traceability

One row per requirement, generated from the FR text in `spec.md`; "designed" names the artifact
section, "verified" names the test or evidence document that fails when the requirement is broken.

| FR | requirement (short) | designed in | verified by |
|---|---|---|---|
| FR-001 | capture session start, prompts, tool input/output, turn end, session end on all four agents | agents.md capture table; R7 | fixture replay per agent; contract fixtures (R13) |
| FR-002 | capture step returns within 300 ms, else spools and returns success | R1, R6; agents.md deadlines (absolute per hook, remaining budget per stage, detector content bound) | max time per event kind; 100% in-deadline exits under every fault; replay p99 as SC-002 |
| FR-003 | spool recovered before the next summarization pass, idempotently | R6 spool; R7 event identity | recovery tests (no duplicate, no loss) |
| FR-004 | repository identity derived by oboete, never accepted from agent or payload | R8; data-model repos; mcp.md boundary | identity tests; payload-supplied repo ignored; MCP `repo` argument rejected |
| FR-005 | agent recorded as provenance, never influences eligibility | data-model sessions.agent, destination_rules; R10 agent neutrality | SC-006 agent-swap test on decisions, hashes, and bodies |
| FR-006 | capture command determines the invoking agent; Grok never mistaken for Claude Code | agents.md fixed selectors | selector tests (`GROK_*` env); `unknown` reported by doctor |
| FR-007 | Pi handlers do no in-process storage or network; bounded enqueue; errors contained and recorded | R12 Pi diagnostics (A8); agents.md Pi row; data-model Pi ack | pi-throw, pi-child-hang, pi-spawn-failure tests; fs/network access assertion on the extension |
| FR-008 | raw events kept 7 days; memories permanent except tombstone or supersession | R6 retention; raw_events.expires_at; memories deleted_at, superseded_by | purge tests; tombstone round trip |
| FR-009 | no resident service; detached worker exits when its queue is empty | R6 lease; cli.md `observe` | process-tree assertion in replay; atomic release test |
| FR-010 | batch at session end and every 10 turns, one call per batch, claude-mem types, add/update/delete/noop against nearby, hook-supplied summaries as input | R10; observer.md (session-end matrix, deterministic summary); data-model observation_batches; R13 PostCompact / lastAssistantMessage probes; agents.md capture table (PostCompact on Codex and Grok) | trigger tests; one-call-at-session-end test; no-duplicate-observation test with a remote preset; classification tests; free-summary input tests per agent; handler-set contract test per agent |
| FR-011 | exactly one worker per machine; stale worker's work taken over without loss or duplication | R6 lease, owner fencing | lease-steal, worker-kill, reclaim-after-120 s tests |
| FR-012 | configured preset, free remote default, usage estimate reset at UTC midnight, exhaustion error never retried, 150 calls per day, local preset | R3, R6; observer.md presets and call policy; data-model provider_usage | 429/3036 no-retry test; cap boundary 150 allowed / 151 refused across presets; ollama preset test |
| FR-013 | rule-based fallback in the same shape; memories and packs labelled degraded with reason | R10 fallback; observer.md; agents.md pack `Degraded:` | fallback tests; degraded-label tests |
| FR-014 | summaries in the language of the content | observer.md worker rules (retry once, then `language_mismatch` fallback) | ja/en pair tests; English-for-Japanese provider fixture |
| FR-015 | summarizer input bounded to 12,000 characters; excerpting recorded | observer.md input; observation_batches.excerpted | excerpt tests |
| FR-016 | credentials only from oboete's config or a named environment variable | cli.md environment; config.ts | fs-access assertion (no agent session files read); config and log scans |
| FR-017 | local-only by default; promotion only after worker checks; secret on rule or path hit | R4; raw_events.sensitivity; privacy/classify.ts | promotion tests; path-rule tests; detector-throw fail-closed test |
| FR-018 | secrets redacted before storage and again in memories | R4; observer.md worker rules | secret corpus scan (db, spool, logs, packs, outbound) |
| FR-019 | `<private>` removed at capture, never stored | R4 | strip tests (closed and unclosed tag) |
| FR-020 | single egress rule table (remote: eligible; local: same-repo non-secret; injection: same repo; secret: never) | data-model destination_rules; observer/request.ts | mixed-batch outbound body; nearby and repo_ref assertions; cross-repository test |
| FR-021 | injected text marked and recognized; plain text; not `{...}`; not phrased as instructions | agents.md pack format; injections.pack_hash | re-capture recognition; `{` guard; directive corpus on packs |
| FR-022 | setup shows host, credential source, cost class, sensitivity classes; requires confirmation | R8 consent (re-checked before every send); cli.md setup; observer.md call policy | consent tuple hash tests; `--yes` mismatch refused; host / credential source / egress class changed after setup → no call |
| FR-023 | privacy tests in both directions | R11; quickstart privacy | fail-closed and fail-open suites |
| FR-024 | session-start and post-compaction injection of latest summary + pinned; none on resume; channel ceiling; pin-order trim recorded; 8 s wait then raw activity | agents.md injection policy and SLAs; R12; injections.context_epoch (A12) | ready/pending timing; resume no-reinject; compact reinject in a new epoch; pinned trim ledger |
| FR-025 | prompt-submit lexical retrieval incl. CJK; threshold; cap proportional to documented context, not fixed | R5; R12 context window; injection/budget.ts; R13 window row (lane block) | ja/en retrieval; threshold; window table; unknown-model `window_unknown` budget |
| FR-026 | no memory twice in one conversation, resumes included | injection_items partial index on (conversation, epoch, memory); sessions.conversation_id | resume/compact/fork/clear duplicate tests |
| FR-027 | Codex injection only at session start and prompt submit | agents.md Codex row | Codex handler set test |
| FR-045 | Grok deferred delivery with the first executed call; attempt, confirm, retry after deny; labelled deferred; omission recorded | agents.md state machine (attach on every call until confirmed; A15 if per-call delivery); data-model injections.attempts_json and delivery_count; R13 parallel-batch probe | Grok success / execution-failure / oboete-deny / other-handler-deny / parallel-batch / no-tool tests counting packs received |
| FR-028 | every pack records included, omitted with reason, degraded state; `why` shows it | injections, injection_items; cli.md `why` | ledger tests |
| FR-029 | citations carried; checked against current repository state before injection | memory_sources; memories.citations_head/ok; R12 staleness | stale path and stale commit tests |
| FR-030 | search, timeline, get via tool interface and CLI under injection boundaries | mcp.md; agents.md Pi tools; cli.md; db/queries.ts | MCP client probes (R13); `mcp-clients.mjs`; boundary tests |
| FR-031 | setup detects, selects, writes three installations, repeatable, removable, complete (trust hash, timeouts, output limits), probes, reports trust | R8, R12 setup probes; agents.md setup column; cli.md setup | setup repeat/remove byte-identity; trust hash test; timeout and `additionalContextLimit` tests; probe assertions |
| FR-032 | warn on agents' native memory, never change it | cli.md setup/doctor | native-memory detection tests |
| FR-033 | doctor reports wiring by probe with trust state, storage, FTS, worker, provider, estimate, exhaustion, spool, unrecognized agents | cli.md doctor; R12 Pi diagnostics | break-one-at-a-time tests |
| FR-034 | pause and resume without touching memories | R12 pause | pause test (no db open, memories unchanged) |
| FR-035 | pin, unpin, delete; deleted content never re-created | memories tombstone; content_hash / material_hash (A13); tombstone-aware classification | tombstone resurrection test (identical content on both paths); A13 documents that a paraphrase is new |
| FR-036 | export with sensitivity, provenance, repository identity; import merges by content, keeps deletions, never lowers sensitivity | R12 export/import; data-model export line; cli.md import | round trip; lattice; tombstone under `--map-repo`; hash mismatch; quarantine |
| FR-037 | viewer: sessions by turn, memories with sensitivity and provenance, updates within 2 s, search/pin/delete | R9 | SC-011 timing; viewer tests |
| FR-038 | viewer reachable only locally | R9 | bind and token refusal tests |
| FR-039 | no Linux-only facility; platform path conventions | R8 (A4 pending) | CI on both Node versions; path tests |
| FR-040 | committed 1,000-event fixture with measured capture time, worker memory, growth | R11; quickstart | `docs/evidence/m1-resource-envelope.md` |
| FR-041 | isolated-user E2E with real hooks; never the maintainer's environment | R11; quickstart | `docs/evidence/m1-dogfood.md` |
| FR-042 | new memories injectable at once; correction after the fact | memories.review_state (`unreviewed` injectable) | inject-after-store test |
| FR-043 | never read another agent's memory store; never disable it | R8 foreign files; FR-016 fence | fs-access assertion; setup leaves native settings untouched |
| FR-044 | same repository only; identity kept for later widening | destination_rules `same_repo_required`; memories.repo_id | cross-repository injection test |

| SC | command | assertion | evidence |
|---|---|---|---|
| SC-001 | `isolated-user.mjs --pairs all` | 12 of 12 ordered pairs recall three facts on the first turn; Grok by the first tool result | `m1-dogfood.md` |
| SC-002 | `fixture replay` + failure matrix | p99 < 300 ms for >= 99% of events; 100% of turns complete under every fault | `m1-resource-envelope.md` |
| SC-003 | `fixture replay` | worker maxRSS < 150 MB; growth per 1,000 events recorded | `m1-resource-envelope.md` |
| SC-004 | `isolated-user.mjs --pairs all --no-credentials` | SC-001 passes with fallback; every pack has `Degraded:` | `m1-dogfood.md` |
| SC-005 | replay scan + privacy suite | zero secret corpus items in memories, outbound bodies, packs | `m1-resource-envelope.md` |
| SC-006 | privacy suite | zero local-only/private rows in any outbound body; zero decisions differ on agent swap | test output in CI |
| SC-007 | `isolated-user.mjs --daily` × 7 | 7 consecutive green days | `m1-dogfood.md` |
| SC-008 | setup timing + break-one-at-a-time | setup < 2 min; doctor names each broken item | `m1-dogfood.md` |
| SC-009 | replay seeded facts | correct memory injected for >= 90% of matching ja/en prompts | `m1-resource-envelope.md` |
| SC-010 | replay ledger | zero duplicate injections per (conversation, context epoch) (A12) | `m1-resource-envelope.md` |
| SC-011 | viewer test | new memory visible within 2 s | test output in CI |

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
├── events.ts            # normalized event union (zod), event id derivation (kind in every key), conversation id
├── agents/claude.ts, grok.ts, codex.ts, pi.ts
├── capture.ts           # hook path: paused check, stdin cap, private strip, path rules, detector, insert or spool
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
`privacy/*`, `capture.ts`, `config.ts`, `repo-identity.ts`, `setup/managed-block.ts`,
`setup/consent.ts`, `setup/write-*.ts`, `db/queries.ts`, `worker/batches.ts`,
`observer/request.ts`, `observer/classify.ts`, `injection/*`, `mcp.ts`, `transfer.ts`,
`viewer/server.ts`, `scripts/build.mjs`, `agents/*.ts`. `agents/*.ts` is security-owned too: adapters
decide which payload fields become content and paths for the detector and the path rules.
External lanes (Codex or Grok Build per task) get UI components, fixture generators, retrieval
scoring, and test scaffolding; `tasks.md` states the owned paths as a fence on every delegated
task, and a delegated result that touches one is returned to Claude Code.

## Delivery order (input to /speckit-tasks)

0. **Amendments and verification gate**: owner decision on A1-A7 and A9-A13 (A8, A14, A15 only
   if their R13 probes fail); R13 probe scaffolding and the probes that need no oboete code, run under the
   isolated user and recorded in `docs/research/`; a failed probe blocks its dependents (R13
   table) rather than switching to a fallback.
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
| 16 | 1 MB stdin read bound; larger payloads dropped as metadata-only failed rows | Read, parse, and detector time are payload-size dependent; FR-002's 300 ms cannot hold without a bound on what the hook reads | Draining or storing a prefix keeps time or content unbounded and cannot evaluate path rules; amendment A7 |
| 17 | Pi errors recorded through the next child spawn and the doctor probe rather than in-process | FR-007 forbids in-process storage work | An in-process log write violates the same requirement; amendment A8 |
