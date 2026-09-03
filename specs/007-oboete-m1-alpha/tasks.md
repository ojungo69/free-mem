# Tasks: oboete M1 Self-Use Alpha

**Input**: Design documents from `/specs/007-oboete-m1-alpha/` (plan.md, spec.md, research.md,
data-model.md, contracts/{cli,agents,observer,mcp}.md, quickstart.md)

**Tests**: The specification mandates tests (FR-023 both-direction privacy tests, FR-040 fixture
evidence, R11 failure matrix, R13 probes), so test tasks are included where the spec or plan
requires them. Tests are written before the code they gate (red first).

**Organization**: Phase 1 = amendments and verification gate (task 0 of the plan), Phase 2 =
foundation and the capture/privacy/worker/retrieval kernel every story needs, then one phase per
user story in priority order, then evidence and polish.

**Execution lanes** (plan.md "Structure Decision"): tasks tagged `[CC]` touch security-owned
paths (`src/privacy/*`, `src/capture.ts`, `src/config.ts`, `src/repo-identity.ts`,
`src/setup/managed-block.ts`, `src/setup/consent.ts`, `src/setup/write-*.ts`, `src/db/queries.ts`,
`src/worker/batches.ts`, `src/observer/request.ts`, `src/observer/classify.ts`,
`src/injection/*`, `src/mcp.ts`, `src/transfer.ts`, `src/viewer/server.ts`, `scripts/build.mjs`,
`src/agents/*.ts`) or the viewer frontend and are implemented by Claude Code. Tasks tagged
`[EXT]` are delegated to Grok Build (declared file scope) or Codex per `rules/coding.md`; a
delegated result that touches a security-owned path is returned to Claude Code. Every task's file
list is its scope fence.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story label for story phases only (US1..US7)
- File paths are repository-relative

## Path Conventions

Single package at the repository root: `src/`, `test/`, `scripts/`, `docs/` (plan.md "Source
Code"). Node >= 22.16; tests compile to `build/test/*.mjs`.

---

## Phase 1: Amendments and verification gate (plan delivery order 0)

**Purpose**: Owner decisions on the constitution and spec amendments, and the third-party probes
that need no oboete code. A failed probe blocks its dependents (research.md R13) instead of
switching to a fallback.

- [X] T001 Record the owner's decision on A1-A7 and A9-A13 (plan.md "Amendments and spec corrections") in docs/research/m1-amendments-2026-09.md and apply approved PATCH/MINOR edits to CONSTITUTION.md, .specify/memory/constitution.md, and specs/007-oboete-m1-alpha/spec.md with a Sync Impact Report (done 2026-09-03: constitution 3.1.0; decisions delegated by the owner under the "better than claude-mem" criterion)
- [X] T002 [P] [EXT] Create the isolated `oboete-dogfood` Linux user with its own HOME and logins for Claude Code, Codex CLI, Grok Build, and Pi, documented in docs/research/isolated-user-setup.md (no oboete installed in the maintainer's environment, FR-041) (done 2026-09-03 by the owner; verified headless: Claude Code 2.1.259, Codex CLI 0.153.0, Grok Build 1.0.17 alpha, Pi 0.84.4, Node 24.20; `~/.oboete-credentials` still empty)
- [X] T003 [P] [EXT] Write the probe harness scripts/e2e/probe-contracts.mjs that runs each R13 row under the isolated user and appends a dated section to docs/research/oboete-contracts-probes.md (done 2026-09-03: runner + scripts/e2e/probe-lib/ + scripts/e2e/probes/ + scripts/e2e/dogfood.sh; Grok Build implementation, reviewed)
- [X] T004 [EXT] Run the payload-shape probes (read/write/edit/bash on all four agents) and commit fixtures to test/contracts/{claude,codex,grok,pi}/*.json (R13 row 1) (done 2026-09-03: 16 fixtures, run 2026-09-03T10-22-04-666Z)
- [ ] T005 [P] [EXT] Run the Codex probes: SessionStart source = compact and clear, rollout flush at PostToolUse, TUI trust path, PostCompact payload; record in docs/research/oboete-contracts-probes.md
- [ ] T006 [P] [EXT] Run the Grok Build probes: user-scoped MCP registration, PreToolUse context on a failed call, parallel-batch delivery once-per-batch vs once-per-call, PermissionDenied payload, PostCompact payload and Stop lastAssistantMessage, resume SessionStart source and session id continuity; record results
- [ ] T007 [P] [EXT] Run the Pi probes: compaction event, tool registration surface, resume/fork PI_SESSION_ID continuity, durable error surface for extension throws; record results
- [ ] T008 [P] [EXT] Run the provider probes for nim, openrouter, gemini, anthropic: transport, auth header, model id (blocking rows) and response_format support (text-JSON fallback row), plus the `agent-cli` headless JSON probe for `claude -p`, `codex exec`, `grok -p`; record results (2026-09-03: `agent-cli-json` passes for all four CLIs; provider rows blocked: no `OBOETE_<PRESET>_API_KEY` in `~/.oboete-credentials` yet, probes skip with "credential absent")
- [X] T009 [P] [EXT] Run the hook-runner probe: each agent's behaviour when the hook exits with unread stdin above 1 MB; record results (done 2026-09-03 for the three hook runners: Claude Code, Codex, Grok Build tolerate an unread hook; runners cap the delivered payload at about 31 KB / 5 KB / 165-190 KB. Pi has no hook process, so this row does not apply to it; the in-process equivalent is oboete's capture child, covered by T051/T061)
- [X] T010 [P] [EXT] Build docs/research/context-windows.md (model id → documented window, source URL) for every model each agent reports in the probes (done 2026-09-03: 11 verified rows, runtime-id → catalog-id rules, adversarially verified)
- [ ] T011 Evaluate every R13 row against its pass condition, list blocked lanes, and record conditional decisions A8, A14, A15, A16 with the owner in docs/research/m1-amendments-2026-09.md

**Checkpoint**: amendments recorded; every R13 row is pass or explicitly blocked.

---

## Phase 2: Foundation and kernel (plan delivery order 1-4)

**Purpose**: package, build, schema, capture path with the privacy boundary, worker, observer,
retrieval and the shared pack builder. Every user story depends on this phase.

### Package and build

- [ ] T012 [EXT] Create package.json (name oboete, bin, engines >= 22.16, scripts build/typecheck/lint/test/pack-check), tsconfig.json, eslint.config.js, .npmignore, and the src/ and test/ directory skeleton from plan.md "Source Code"
- [ ] T013 [CC] Write scripts/build.mjs: esbuild ESM bundle dist/oboete.mjs with hook-path packages bundled (zod, smol-toml, @secretlint/core, preset) and ai, @ai-sdk/*, workers-ai-provider, hono, @hono/node-server, preact external; migrations embedded as text; tests compiled to build/test; viewer assets embedded
- [ ] T014 [P] [EXT] Add the CI workflow matrix (Node 22.16 and 24.x) running typecheck, lint, build, test, pack-check in .github/workflows/ci.yml
- [ ] T015 [EXT] Measure real bundle cold start on 22.16 and 24.x and installed size in an empty prefix (R13 rows "cold start" and "installed size") and record in docs/evidence/m1-resource-envelope.md; block if over 100 ms or 30 MB

### Storage

- [ ] T016 [EXT] Write migrations src/db/migrations/0001_core.sql (schema_migrations, repos, sessions incl. conversation_id/context_epoch/last_compaction_key/summary_state, turns, raw_events, observation_batches, worker_lease seeded row, runtime_state, diagnostics) per data-model.md
- [ ] T017 [P] [EXT] Write src/db/migrations/0002_memory_search.sql (memories with material_hash/content_hash/review_state, memory_sources, memories_fts trigram, memories_fts_cjk, triggers, destination_rules seeded) per data-model.md
- [ ] T018 [P] [EXT] Write src/db/migrations/0003_operations.sql (injections incl. context_epoch/attempts_json/delivery_count, injection_items with the partial unique index on (conversation_id, context_epoch, memory_id), provider_usage, sync_conflicts) per data-model.md
- [ ] T019 [EXT] Implement src/db/open.ts: DatabaseSync with explicit timeout, WAL, wal_autocheckpoint = 0 for hooks, forward-only migration runner with sha256 check, hook spools when user_version is behind
- [ ] T020 [P] [EXT] Write migration smoke tests test/migrations/apply.test.ts on an empty database and on test/fixtures/previous-version.db for both Node versions
- [ ] T021 [CC] Implement src/db/identity.ts (material_hash, content_hash) and src/db/queries.ts: the shared scope + sensitivity + review_state filter used by injection, CLI, MCP, and viewer, with tests test/unit/queries.test.ts (cross-repository and secret rows excluded, imported rows quarantined)

### Configuration, identity, paths

- [ ] T022 [CC] Implement src/paths.ts and src/config.ts: OBOETE_HOME, config.toml via smol-toml, .oboete.toml path rules, credentials only from OBOETE_* variables, consent record (hash of preset/host/credential source/cost class/egress classes), paused marker check before opening the database; tests test/unit/config.test.ts
- [ ] T023 [P] [CC] Implement src/repo-identity.ts: normalized remote (userinfo, query, fragment removed) or realpath of git rev-parse --git-common-dir, sha256 prefix id; tests test/unit/repo-identity.test.ts including a credential-bearing remote URL

### Capture path and privacy boundary

- [ ] T024 [CC] Write red tests first in test/unit/privacy.test.ts: fail-closed (secret corpus test/corpus/secrets.jsonl redacted before any write, `<private>` stripped incl. unclosed tag, path-rule hits stored as metadata only, detector throw and malformed .oboete.toml → classification_state = failed, stdin above 1 MB → metadata-only failed row) and fail-open (eligible content stored whole)
- [ ] T025 [CC] Implement src/privacy/detect.ts: private strip, path rules, @secretlint/core lintSource with the statically imported recommend preset, gated entropy, `[REDACTED:<rule>]`, run inside a worker_threads Worker with a hard cutoff
- [ ] T026 [CC] Implement src/events.ts: zod discriminated union of normalized events, event id derivation (kind in every key, no delivery counter), conversation id rules (resume keeps the root, fork and Grok new start one)
- [ ] T027 [CC] Implement src/capture.ts: absolute deadline with spool reserve, 1 MB stdin bound, detector before the first write, insert into raw_events or spool file (write-then-rename), busy timeout min(150 ms, remaining − reserve), worker spawn when the lease is free; wire src/cli.ts `hook --agent <selector> --event <name>`, `capture --agent pi --invocation <id>`
- [ ] T028 [CC] Implement src/agents/claude.ts, codex.ts, grok.ts, pi.ts payload mapping from the T004 fixtures (tool names, content fields, paths) plus the bounded prefix scan for partial rows; an agent/tool without a fixture stores metadata only with reason unmapped_payload; tests test/unit/agents.test.ts plant a path-rule secret inside an unknown payload
- [ ] T029 [CC] Implement src/privacy/egress.ts (destination_rules evaluation) and src/privacy/classify.ts (worker promotion local_only → eligible after detector and entropy checks); tests in test/unit/privacy.test.ts assert identical decisions when only the producing agent changes (SC-006)

### Worker and observer

- [ ] T030 [EXT] Implement src/worker/lease.ts: claim/heartbeat/release of the seeded worker_lease row in BEGIN IMMEDIATE transactions fenced by owner_token, staleness (6 s old or 60 s in the future), atomic release with the empty-queue check; tests test/unit/lease.test.ts (lease steal, clock jump)
- [ ] T031 [CC] Implement src/worker/batches.ts: spool recovery, batch creation per (session, through event, destination) after classification, ten-turn and session-end triggers, retention-forced batches, reclaim after 120 s; tests test/unit/batches.test.ts assert a mixed-sensitivity session yields disjoint remote and fallback batches
- [ ] T032 [P] [EXT] Implement src/worker/purge.ts: bounded deletes of expired raw_events in applied/fallback batches, forced fallback for expired pending rows, pi-ack cleanup, PASSIVE/TRUNCATE checkpoints; tests test/unit/purge.test.ts
- [ ] T033 [EXT] Implement src/observer/contract.ts: shared zod schema for observer input and output (observations ≤ 20, source_event_ids subset ≤ 50, citation strings ≤ 512, ≤ 20 paths and 10 commits, titles 120, bodies 2,000) per contracts/observer.md
- [ ] T034 [CC] Implement src/observer/request.ts: the single outbound request builder that applies destination_rules to events, free_summaries, nearby (eligible only for remote), citations, and repo_ref (opaque id), and re-checks the consent hash before reservation and before send; tests test/unit/request.test.ts assert the actual outbound body of a mixed batch
- [ ] T035 [P] [EXT] Implement src/observer/providers.ts and src/observer/llm.ts: presets workers-ai (workers-ai-provider REST, JSON schema), ollama/nim/openrouter/gemini/anthropic via @ai-sdk/openai-compatible (response_format or text-JSON), optional agent-cli (child process `claude -p` / `codex exec` / `grok -p`, text-JSON, uncapped), maxRetries 0, 60 s abort, 1 MB response cap, status + body-code classification table (3036, 5035, 401/403 auth_failed, 3007/3040 retry once), model id check, neuron estimate, single enabled preset
- [ ] T036 [EXT] Implement per-attempt reservations and the daily cap in src/observer/llm.ts + src/worker/observe.ts: BEGIN IMMEDIATE check of the 150-per-UTC-day sum across capped presets and exhausted_at, session-end reservation when 10 or fewer calls remain, provider_usage.calls and provider_attempts increments, unfenced monotonic exhausted_at write on 3036, fenced apply in one transaction with state = applied; tests test/unit/callpolicy.test.ts (attempt 150 allowed, 151 refused; lease lost after 3036; worker kill after response → 2 calls, 1 apply)
- [ ] T037 [P] [EXT] Implement src/observer/fallback.ts: the deterministic record rules table (change, bugfix, discovery, decision), source_event_ids by rule, output budget and trim order, no agent name anywhere; tests test/unit/fallback.test.ts (long paths, 60 tool calls, language of copied text)
- [ ] T038 [CC] Implement src/observer/classify.ts: target restricted to supplied nearby ids of the same repository, tombstone-aware suppression by content_hash, sensitivity on add = strictest source + detector and on update = max(target, sources, detector) in the apply transaction, delete only with a reason, directive-corpus rejection (test/corpus/directives.jsonl), language check with one retry then language_mismatch; tests test/unit/classify.test.ts (eligible update never relaxes a local-only target; English output for Japanese input)
- [ ] T039 [EXT] Implement src/worker/observe.ts: worker main loop (recover spool, claim lease, purge, batch, classify, summarize, apply, deterministic session summary with reconciliation of summary_state = pending, no_content sessions, degraded precedence, checkpoint, release), exit codes per contracts/cli.md; tests test/unit/observe.test.ts (session_start + fully private prompt + session_end produces no memory)
- [ ] T040 [P] [EXT] Implement src/observer/catalog.ts: Workers AI model search once per run with a 24-hour cache in runtime_state, paid-plan flag for doctor

### Retrieval and injection

- [ ] T041 [EXT] Implement src/retrieval/fts.ts and src/retrieval/query.ts: Intl.Segmenter routing, trigram terms ≥ 3 chars, CJK bigrams (ー 々 ・ included), particle drop, LIKE only when no indexed term, BM25 normalization; tests test/unit/retrieval.test.ts with seeded Japanese and English facts
- [ ] T042 [P] [EXT] Implement src/retrieval/rank.ts: normalized-BM25 threshold (default 0.3), RRF k = 60 across tables (LIKE never votes), MMR lambda 0.5 with character-trigram cosine, character budget cut; tests in test/unit/retrieval.test.ts
- [ ] T043 [CC] Implement src/injection/budget.ts: character budget = min(channel cap, context_fraction × documented window from docs/research/context-windows.md), window_unknown for unknown models, lane blocked for agents without any verified window; tests test/unit/budget.test.ts
- [ ] T044 [CC] Implement src/injection/staleness.ts (fs.existsSync paths, HEAD-keyed ancestor cache for commits) and src/injection/pack.ts: the common pack builder (labels, every content line `> `-framed and single-line canonicalized, no agent name, plain-language `degraded:` sentences mapped from reason codes, whole-pack validation with secret detector, directive corpus, control characters), ledger rows planned → included on delivery, per-epoch uniqueness, session-start pack once per epoch, summary-pending wait of 8 s then raw activity; tests test/unit/pack.test.ts (malicious title, path, remote URL; `{` guard; stale path and commit)
- [ ] T045 [CC] Implement src/injection/deferred.ts: the Grok state machine (pending record merge, attach on every PreToolUse until confirmed, attempts_json execution/delivery updates from PostToolUse, PostToolUseFailure, PermissionDenied, Stop in single-row BEGIN IMMEDIATE transactions, delivery_count per probe result, omitted reasons no_tool_call / not_delivered); tests test/unit/deferred.test.ts counting packs the model received in success, execution-failure, oboete-deny, other-handler-deny, parallel-batch, no-tool cases
- [ ] T046 [EXT] Implement `oboete inject --agent pi --kind start|prompt` and the injection branches of `oboete hook` in src/cli.ts using src/injection/*, plain stdout output rules per contracts/agents.md

**Checkpoint**: unit suites green on 22.16 and 24.x; replay skeleton runs one event end to end.

---

## Phase 3: User Story 1 - Memory follows the developer across agents (Priority: P1) 🎯 MVP

**Goal**: a session in any of the four agents receives the previous session's summary, pinned
memories, and prompt-relevant memories of the same repository, marked as oboete's.

**Independent Test**: scripts/e2e/isolated-user.mjs --pairs all seeds three facts with agent A and
asserts agent B's first turn contains all three for 12 of 12 ordered pairs (Grok by the first tool
result).

- [ ] T047 [CC] [US1] Implement src/setup/managed-block.ts: managed blocks for TOML (`# oboete:begin/end`) and JSON (`"oboete": true` handlers), backup preserving mode/owner (0600 for credential-bearing files), temp file → re-parse → rename; tests test/unit/managed-block.test.ts (repeat leaves files byte-identical, remove restores)
- [ ] T048 [P] [CC] [US1] Implement src/setup/write-claude.ts: handlers for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, PostCompact, SessionEnd with `--agent claude-or-grok --event <name>`, timeouts 12 s / 3 s, `claude mcp add oboete`
- [ ] T049 [P] [CC] [US1] Implement src/setup/write-codex.ts: ~/.codex/hooks.json handlers (SessionStart matcher startup|clear|compact, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PostCompact, SessionEnd), managed block in ~/.codex/config.toml with [hooks.state] trusted_hash (sha256 of canonical handler JSON), additionalContextLimit = 0, [mcp_servers.oboete]
- [ ] T050 [P] [CC] [US1] Implement src/setup/write-grok.ts: ~/.grok/hooks/oboete.json with explicit per-hook timeout, handlers deduplicated against the Claude compat layer, PermissionDenied and PostCompact included, MCP registration per the T006 probe
- [ ] T051 [P] [CC] [US1] Implement src/setup/write-pi.ts and src/pi-extension.ts: three-line loader ~/.pi/agent/extensions/oboete.js, extension with try/catch only, invocation ids, detached capture child with `--invocation`, bounded inject child (8 s at session start, 300 ms per prompt), in-memory failure counters passed as `--prior-failures`, tools search/timeline/get calling the CLI; tests test/unit/pi-extension.test.ts assert no fs or network call from the extension
- [ ] T052 [EXT] [US1] Implement src/setup/detect.ts and src/setup/probe.ts: installed-agent detection, parallel headless probes under a 90 s deadline asserting a probe event, trust state per agent, native-memory warnings (Codex memories, Claude Code auto-memory, Grok native memory) reported but never changed
- [ ] T053 [CC] [US1] Implement src/setup/consent.ts and the `oboete setup` command in src/cli.ts: consent display (host, credential source, cost class, egress classes; agent-cli shows the subscription it consumes), --accept-egress, --yes only when the stored hash matches the current tuple, --remove, missing-credential guidance (Cloudflare steps with URLs; offer ollama, agent-cli, or no provider), the `oboete view --open` launch line; tests test/unit/consent.test.ts (--yes refused after host, credential source, or egress class changed)
- [ ] T054 [EXT] [US1] Write scripts/e2e/isolated-user.mjs: seeds three facts with agent A (claude -p, codex exec, grok -p, pi -p), starts agent B in the same synthetic repository with a prompt forcing one tool call, asserts all three facts, supports --pairs all, --no-credentials, --daily
- [ ] T055 [EXT] [US1] Run the Claude Code ↔ Codex vertical slice under the isolated user (resume, compact, fork, clear behaviour; SessionStart source policy) and fix adapter mappings until the four Claude/Codex pairs pass
- [ ] T056 [EXT] [US1] Run the remaining pairs (Grok Build and Pi as sender and receiver) under the isolated user, including the Grok deferred delivery and the Pi child processes, until 12 of 12 pass; record in docs/evidence/m1-dogfood.md

**Checkpoint**: SC-001 and SC-009 pass on the isolated account.

---

## Phase 4: User Story 2 - The agent is never blocked or slowed by memory (Priority: P1)

**Goal**: every capture step exits 0 inside its deadline under every injected failure; spooled
events are recovered; no batch is applied twice.

**Independent Test**: the failure matrix in quickstart.md ("Failure injection") passes: every hook
in deadline, spool recovery, HTTP and apply counts as specified, doctor names the component.

- [ ] T057 [EXT] [US2] Implement the test-only fault seam (OBOETE_TEST_FAULT honoured only when NODE_ENV=test) in src/testing/faults.ts and wire it into open.ts, capture.ts, llm.ts, lease.ts, pi child spawn
- [ ] T058 [EXT] [US2] Write test/fault-storage.test.ts: db-missing, busy, corrupt, readonly, enospc, oversized-payload, detector-never-returns (process wall time per event kind asserted, 1 MB input, slow detector + busy database)
- [ ] T059 [P] [EXT] [US2] Write test/fault-worker.test.ts: worker-kill, worker-kill-after-response (HTTP 2 / apply 1), lease-steal, lease-lost-after-3036, clock-jump, resume/compact/fork/clear epochs, pause
- [ ] T060 [P] [EXT] [US2] Write test/fault-provider.test.ts: provider-unreachable, provider-hang, provider-429-3036, provider-403-5035, provider-401, provider-length, provider-malformed, provider-wrong-language, cap-boundary, consent-changed
- [ ] T061 [P] [CC] [US2] Write test/fault-pi.test.ts: pi-throw, pi-child-hang (stale .started), pi-spawn-failure (doctor probe), prior-failure counters recorded
- [ ] T062 [CC] [US2] Write test/fault-grok.test.ts: grok-success, grok-exec-failure, grok-oboete-deny, grok-other-handler-deny, grok-parallel-batch, grok-no-tool, asserting packs received and attempts_json outcomes after raw-event purge
- [ ] T063 [EXT] [US2] Fix every failure surfaced by T058-T062 in the owning module (returning security-owned fixes to Claude Code) until the matrix is green on 22.16 and 24.x

**Checkpoint**: SC-002 "100% of turns complete under every injected failure" holds.

---

## Phase 5: User Story 3 - Nothing sensitive leaves the machine (Priority: P1)

**Goal**: secrets, private spans, path-rule files, local-only rows, and other repositories'
memories never reach a remote request or a foreign pack; consent gates every remote destination.

**Independent Test**: the privacy suite (`npm test -- --test-name-pattern privacy`) and the
replay scan report zero secret corpus items in memories, outbound bodies, and packs, and zero
local-only or private rows in any outbound request.

- [ ] T064 [CC] [US3] Extend test/unit/privacy.test.ts with the mixed-sensitivity outbound body assertion (events, nearby, citations, repo_ref), cross-repository injection refusal, pack recognition on re-capture (pack_hash), and the agent-swap invariance over hashes, bodies, and decisions
- [ ] T065 [CC] [US3] Implement the pack recognition path in src/capture.ts (injected text matched by pack_hash is stored as recognized, never summarized) and the credential scan in test/unit/logs.test.ts (no credential value in logs, spool, doctor output, packs)
- [ ] T066 [CC] [US3] Implement the imported-row quarantine reclassification in src/worker/observe.ts + src/privacy/classify.ts (detector and directive check move imported → unreviewed or secret) with tests
- [ ] T067 [EXT] [US3] Write scripts/fixtures/generate-1000-events.mjs and test/fixtures/events-1000.jsonl: native hook payloads for all four agents from the T004 fixtures, seeded facts (ja/en), the secret corpus, the directive corpus, payloads at and above 1 MB, resume/compact/fork/clear sequences
- [ ] T068 [EXT] [US3] Implement `oboete fixture replay` in src/cli.ts + scripts/fixtures/replay.mjs: spawn the real hook per event, measure p99, session-start wait on ready and pending paths, worker maxRSS, database growth, secret and directive corpus scans, duplicate count per (conversation, epoch), fact recall; write docs/evidence/m1-resource-envelope.md

**Checkpoint**: SC-005 and SC-006 pass in CI; the replay evidence file exists.

---

## Phase 6: User Story 4 - Setup and doctor (Priority: P2)

**Goal**: one setup command wires the selected agents with probes and trust state; doctor names
every degraded item with reason, consequence, and recovery.

**Independent Test**: quickstart.md "Setup and doctor on the isolated account": setup under 2
minutes, doctor healthy, then break one item at a time and confirm doctor names it and its
recovery step turns it green.

- [ ] T069 [EXT] [US4] Implement src/doctor.ts and `oboete doctor [--probe-provider] [--no-probe-agents]`: items with { item, status, reason, consequence, recovery } for wiring probes (default on) and trust state, storage integrity and FTS5, migration level, worker liveness, spool backlog and writability, provider (live only with --probe-provider, else unverified), allowance estimate and exhaustion, catalog paid flag, unrecognized agents, native memory coexistence, config file mode, Pi diagnostics (pi_child_hang, pi_child_failed, pi_spawn_failed); corrupt-storage recovery steps
- [ ] T070 [P] [EXT] [US4] Implement `oboete pause` / `oboete resume` (marker file checked before the database is opened) in src/cli.ts with tests test/unit/pause.test.ts (memories untouched)
- [ ] T071 [EXT] [US4] Write test/unit/doctor.test.ts: break-one-at-a-time (hook entry removed, database chmod, corrupted header, worker killed, unreachable provider, exhausted counter, stale Pi .started, Pi extension unable to spawn) asserting reason, consequence, recovery, and that recovery turns the item green
- [ ] T072 [EXT] [US4] Run setup and doctor on the isolated account (quickstart.md), record timing and the break-one results in docs/evidence/m1-dogfood.md (SC-008)

**Checkpoint**: SC-008 recorded.

---

## Phase 7: User Story 5 - Zero-credential operation and honest degradation (Priority: P2)

**Goal**: without credentials or after exhaustion, memories still come from the fallback and every
pack and doctor output says so.

**Independent Test**: scripts/e2e/isolated-user.mjs --pairs all --no-credentials passes SC-001
with `Degraded:` in every pack; the exhausted-counter fixture switches to the fallback without
retrying and shows the switch in doctor and packs.

- [ ] T073 [EXT] [US5] Verify the degraded labelling end to end: summary degraded_reason precedence, `Degraded:` line in packs (summary_pending, index_unavailable, empty, window_unknown, batch reasons), doctor exhaustion flag; tests test/unit/degraded.test.ts
- [ ] T074 [EXT] [US5] Implement `oboete why <session-id> [--turn N]` in src/cli.ts reading injections, injection_items, attempts_json (deliveries per attempt), trims, staleness, deferred and degraded state; tests test/unit/why.test.ts
- [ ] T075 [EXT] [US5] Run the no-credentials and exhausted-allowance runs on the isolated account and record SC-004 in docs/evidence/m1-dogfood.md

**Checkpoint**: SC-004 recorded.

---

## Phase 8: User Story 6 - Inspect, search, pin, and delete memories (Priority: P3)

**Goal**: viewer and CLI expose sessions, memories with sensitivity and provenance, search, pin,
delete, review state, and `why`; the tool interface exposes search, timeline, get under the same
boundaries.

**Independent Test**: quickstart.md "Viewer and MCP": a new memory appears within 2 s, pin/delete/
search work, non-loopback and token-less access refused, each supported MCP client lists and calls
the three tools, a `repo` argument is rejected.

- [ ] T076 [EXT] [US6] Implement `oboete search` (empty result states that M1 search is lexical), `timeline`, `get`, `pin`, `unpin`, `delete` in src/cli.ts on top of src/db/queries.ts with --json output and exit codes per contracts/cli.md; tests test/unit/cli-memories.test.ts (tombstone never re-created from identical title/body, including under another observation type per A13)
- [ ] T077 [CC] [US6] Implement src/mcp.ts: legacy-era stdio JSON-RPC (initialize echo, notifications/initialized, tools/list with inputSchema, tools/call with content + structuredContent, isError results, -32601 for server/discover, -32602 for a repo argument); tests test/unit/mcp.test.ts with the raw frames from contracts/mcp.md
- [ ] T078 [CC] [US6] Implement src/viewer/server.ts: Hono on @hono/node-server bound to 127.0.0.1, per-launch token, Origin check on mutating routes, SSE via PRAGMA data_version polling every 500 ms, routes for sessions/turns, memories (review, pin, delete), search, `--open` launching the browser; tests test/unit/viewer-server.test.ts (non-loopback bind and token-less request refused)
- [ ] T079 [CC] [US6] Implement the viewer frontend in src/viewer/app/ (Preact + Vite, embedded at build): session/turn list, memory cards with sensitivity, provenance, review state, degraded reason, pin/delete/review actions, search, live updates; polite user-facing copy (no abbreviations)
- [ ] T080 [EXT] [US6] Write scripts/e2e/mcp-clients.mjs running tools/list and tools/call through the Claude Code, Codex, and Grok MCP clients under the isolated user with raw frames recorded, and the Pi tool path through the extension
- [ ] T081 [EXT] [US6] Run the viewer timing (SC-011) and the MCP client runs on the isolated account and record in docs/evidence/m1-dogfood.md

**Checkpoint**: SC-011 recorded; MCP client rows of R13 pass or are blocked.

---

## Phase 9: User Story 7 - Export, import, and evidence (Priority: P3)

**Goal**: portable export with sensitivity, provenance, and repository identity; import that
merges by content, keeps deletions, never lowers sensitivity, and quarantines imported rows.

**Independent Test**: quickstart.md "Export / import": counts match, tombstones preserved, hash
mismatch and oversized lines rejected with exit 2, imported rows absent from search and packs until
classified, tombstone under --map-repo still suppresses.

- [ ] T082 [CC] [US7] Implement src/transfer.ts export (`oboete-export/1` header + lines with material_hash, content_hash, provenance, sources) and import (64 KB per line, 256 MB per file, material_hash verified, content_hash recomputed for the local repo id incl. --map-repo, union on content_hash, sensitivity lattice, tombstones win, active rows land local_only / imported); tests test/unit/transfer.test.ts
- [ ] T083 [EXT] [US7] Wire `oboete export [file|-]` and `oboete import [file|-] [--dry-run] [--map-repo]` in src/cli.ts with the exit codes of contracts/cli.md
- [ ] T084 [EXT] [US7] Run the export → import round trip between two isolated installations and the 1,000-event replay comparison against docs/evidence/m1-resource-envelope.md; record in docs/evidence/m1-dogfood.md (SC-003)

**Checkpoint**: SC-003 recorded.

---

## Phase 10: Evidence, dogfood, and polish

**Purpose**: the 7-day dogfood gate, documentation, and the review gates the workflow requires.

- [ ] T085 [EXT] Run scripts/e2e/isolated-user.mjs --daily on the isolated account for 7 consecutive days, appending doctor output, provider usage, spool backlog, duplicate count, and viewer latency to docs/evidence/m1-dogfood.md (SC-007)
- [ ] T086 [P] [EXT] Write README.md (install, setup, doctor, privacy model, support matrix 22.16 / 24.x, degraded modes) and docs/agents/*.md per-agent notes; user-facing copy in full sentences
- [ ] T087 [P] [EXT] Add `npm run pack-check` (npm pack, install into an empty prefix, unpacked size ≤ 30 MB) to package.json and CI
- [ ] T088 Run the review gates on the implementation branch: `/code-review` then `ponytail-review`, plus `rules/security.md` tooling (semgrep, `/codex-review mode=security`, `/codex:adversarial-review`) for the security-owned modules, and record `~/.claude/review-status.json`
- [ ] T089 Run `speckit-verify-tasks` against this file and resolve every phantom completion before opening the PR from `007-oboete-m1-alpha` to main

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (amendments, probes)**: T001 and T002 first; T003-T010 after T002; T011 last. Blocks every dependent lane listed in research.md R13.
- **Phase 2 (foundation, kernel)**: T012-T013 first; T014-T015 after T013; storage T016-T021 after T012; capture T024-T029 after T021-T023 and T004; worker T030-T040 after T029; retrieval and injection T041-T046 after T021 and T033. Blocks all stories.
- **US1 (Phase 3)**: after Phase 2; T047 before T048-T051; T052-T053 before T054; T055 before T056.
- **US2 (Phase 4)**: after Phase 2; T057 before T058-T062; T063 last.
- **US3 (Phase 5)**: after Phase 2; T067 before T068.
- **US4 (Phase 6)**: after US1 (needs the writers and probes); T069 before T071-T072.
- **US5 (Phase 7)**: after Phase 2 and US1's E2E harness (T054).
- **US6 (Phase 8)**: after Phase 2; T078 before T079; T080 after T077.
- **US7 (Phase 9)**: after Phase 2; T082 before T083-T084.
- **Phase 10**: after every story; T085 needs 7 calendar days.

### Parallel Opportunities

- Phase 1: T003, T005-T010 in parallel once T002 exists.
- Phase 2: T017/T018 with T016; T020 with T019; T023 with T022; T032, T035, T037, T040 with their neighbours; T042 with T041.
- US1: T048-T051 in parallel after T047.
- US2: T059-T061 in parallel after T058's seam.
- Phase 10: T086 and T087 in parallel with T085.

## Parallel Example: Phase 2 storage

```bash
# After T016 lands:
Task: "T017 Write src/db/migrations/0002_memory_search.sql"
Task: "T018 Write src/db/migrations/0003_operations.sql"
# After T019:
Task: "T020 Migration smoke tests test/migrations/apply.test.ts"
Task: "T023 src/repo-identity.ts + tests"
```

## Implementation Strategy

### MVP First (US1 + US2 + US3 are all P1)

1. Phase 1: amendments decided, probes recorded, blocked lanes listed.
2. Phase 2: kernel green on both Node versions with the privacy suite red-then-green.
3. Phase 3 (US1): 12 of 12 pairs on the isolated account.
4. Phases 4 and 5 (US2, US3): failure matrix and privacy evidence.
5. **STOP and VALIDATE**: SC-001, SC-002, SC-005, SC-006, SC-009, SC-010 recorded.

### Incremental Delivery

- Add US4 (setup, doctor) → SC-008; add US5 (degradation) → SC-004; add US6 (viewer, MCP) → SC-011;
  add US7 (export, evidence) → SC-003; then the 7-day dogfood → SC-007.

## Notes

- `[CC]` tasks never leave Claude Code; `[EXT]` tasks are delegated with their file list as the
  scope fence (Grok Build `--allowed-file`, or Codex for exploratory work).
- Every delegated task is followed by `speckit-verify-tasks`, `/code-review`, and
  `ponytail-review` before its checkbox is marked.
- R13-blocked lanes stay unchecked with a `blocked: <row>` note until the owner decides.
