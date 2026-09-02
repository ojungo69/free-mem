# Quickstart: validating oboete M1

## Prerequisites

- Node.js 22.16 or newer (`node --version`); the CI matrix also runs 24.x.
- For the E2E only: a separate Linux user (`oboete-dogfood`) on this WSL host with its own home and
  its own logins for Claude Code, Codex CLI, Grok Build, and Pi. The maintainer's own agent
  environment is never used (FR-041).

## Build and unit tests

```bash
npm ci
npm run typecheck          # tsc --noEmit
npm run build              # esbuild -> dist/oboete.mjs (+ embedded viewer assets)
npm test                   # node --test with coverage; unit + contract fixtures
npm run pack-check         # npm pack --dry-run; fails above 30 MB unpacked or if dist/ is missing
```

Expected: all tests green on 22.16 and 24.x; `pack-check` prints the unpacked size.

## Fixture replay (SC-002, SC-003, SC-005, SC-009, SC-010)

```bash
node scripts/fixtures/generate-1000-events.mjs   # deterministic, creates synthetic repos under a temp dir
OBOETE_HOME=$(mktemp -d) node dist/oboete.mjs fixture replay test/fixtures/events-1000.jsonl
```

Expected output (`docs/evidence/m1-resource-envelope.md`): hook time p99 under 300 ms with at
least 99% under budget, worker peak RSS under 150 MB, database growth per 1,000 events, zero secret
corpus items in the database, spool, logs, or packs, at least 90% of seeded Japanese and English
facts retrieved, zero duplicate injections per conversation.

## Failure injection (User Story 2)

```bash
for f in busy corrupt readonly enospc provider:429 provider:3036 provider:length worker-kill; do
  NODE_ENV=test OBOETE_TEST_FAULT=$f node --test test/unit/fault-*.test.ts
done
```

Expected: every hook invocation exits 0 within 300 ms, spooled events are recovered when the fault
clears, no event is summarized twice, and doctor names the degraded component with a reason.

## Setup and doctor on the isolated account (User Story 4, SC-008)

```bash
sudo -u oboete-dogfood -H env PATH="$PATH" bash -lc '
  npm install -g ./oboete-<version>.tgz &&
  time oboete setup --agents claude,codex,grok,pi --provider workers-ai --yes &&
  oboete doctor --json'
```

Expected: setup completes in under 2 minutes and reports each agent as wired with a passed probe and
its trust state; doctor reports every item healthy; then break one item at a time (remove a hook
entry, chmod the database, kill the worker, point the provider at an unreachable host, exhaust the
allowance counter) and confirm doctor names it.

## Cross-agent memory (User Story 1, SC-001, SC-004)

```bash
sudo -u oboete-dogfood -H env PATH="$PATH" node scripts/e2e/isolated-user.mjs --pairs all
```

The harness seeds three facts in a synthetic repository with agent A (headless: `claude -p`,
`codex exec`, `grok -p`, `pi -p`), then starts agent B in the same repository with a prompt that
forces one tool call and asks for the facts. Expected: 12 of 12 ordered pairs recall all three facts
on the first turn (Grok Build receiving: by the first tool result); a second run with credentials
removed still passes with `Degraded:` lines in every pack.

## Privacy (User Story 3, SC-005, SC-006)

```bash
npm test -- --test-name-pattern "privacy"
```

Expected: fail-closed tests block secret and local-only rows from the remote observer and
cross-repository injection; fail-open tests deliver eligible rows; eligibility decisions are identical
when only the producing agent changes.

## Viewer (User Story 6, SC-011)

```bash
oboete view      # prints http://127.0.0.1:<port>/?token=...
```

Expected: a memory created by a running worker appears in the viewer within 2 seconds; pin, delete,
and search work; the URL without the token is rejected; binding to a non-loopback host is refused.

## Export / import (User Story 7)

```bash
oboete export > memories.jsonl
OBOETE_HOME=$(mktemp -d) oboete import memories.jsonl --dry-run
```

Expected: counts match, deletions are preserved, and an imported row never lowers sensitivity.

## Dogfood gate (SC-007)

Run `scripts/e2e/isolated-user.mjs --daily` once a day on the isolated account for 7 consecutive
days; each run records doctor output, provider usage, spool backlog, duplicate count, and viewer
latency under `docs/evidence/m1-dogfood.md`. M1 is a "done" candidate only after 7 green days, and
installation into the maintainer's environment is a separate approval afterwards.
