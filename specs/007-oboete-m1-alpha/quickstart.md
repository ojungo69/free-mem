# Quickstart: validating oboete M1

## Prerequisites

- Node.js 22.16 or newer for the engine; Node.js 24.x for the four-agent E2E (Pi 0.84.4 requires
  >= 22.19).
- For the E2E only: a separate Linux user (`oboete-dogfood`) on this WSL host with its own home and
  its own logins for all four agents. The maintainer's own agent environment is never used (FR-041).

## Build, lint, and tests

```bash
npm ci
npm run typecheck          # tsc --noEmit
npm run lint               # eslint
npm run build              # esbuild: dist/oboete.mjs, build/test/*.mjs, embedded viewer assets
npm test                   # node --test build/test with coverage (unit, migration smoke, contracts)
npm run pack-check         # npm pack, install the tarball into an empty prefix, measure unpacked size (<= 30 MB)
```

Expected: green on 22.16 and 24.x; `pack-check` prints the installed size including dependencies.

## Verification gate (research R13)

```bash
node scripts/e2e/probe-contracts.mjs --home $(mktemp -d)   # headless runs per agent; appends results to docs/research/
```

Expected: a dated section per probe item (tool payload fixtures, Codex SessionStart sources and
rollout flush, Grok MCP registration, Pi compaction event, NIM/OpenRouter/Gemini structured
output, MCP `initialize`-only server against each client, bundle cold start, installed size).
Dependent implementation tasks stay blocked until their row exists.

## Fixture replay (SC-002, SC-003, SC-005, SC-009, SC-010)

```bash
node scripts/fixtures/generate-1000-events.mjs
OBOETE_HOME=$(mktemp -d) node dist/oboete.mjs fixture replay test/fixtures/events-1000.jsonl
```

Expected (`docs/evidence/m1-resource-envelope.md`): capture-hook p99 under 300 ms with at least
99% under budget; session-start injection measured on both the ready path (under 300 ms) and the
pending path (under 8 s); worker peak RSS under 150 MB; database growth per 1,000 events; zero
secret corpus items in the database, spool, logs, or packs; at least 90% of seeded Japanese and
English facts retrieved; zero duplicate injections per conversation.

## Failure injection (User Story 2)

```bash
for f in db-missing busy corrupt readonly enospc worker-kill provider-unreachable provider-hang \
         provider-429-3036 provider-403-5035 provider-length provider-malformed pi-throw pi-child-hang \
         clock-jump mixed-sensitivity resume compact fork clear setup-repeat setup-remove lease-steal pause; do
  NODE_ENV=test OBOETE_TEST_FAULT=$f node --test build/test/fault-*.test.mjs
done
```

Expected: every hook exits 0 within its SLA, spooled events are recovered when the fault clears, no
batch is applied twice, a lost lease stops the old worker's writes, and doctor names the degraded
component with a reason.

## Setup and doctor on the isolated account (User Story 4, SC-008)

```bash
sudo -u oboete-dogfood -H env PATH="$PATH" bash -lc '
  npm install -g ./oboete-<version>.tgz &&
  time oboete setup --agents claude,codex,grok,pi --provider workers-ai --accept-egress &&
  oboete doctor --json'
```

Expected: setup completes in under 2 minutes (probes run in parallel) and reports each agent as
wired with a passed probe and its trust state; re-running setup leaves the foreign configuration
files byte-identical outside the managed blocks; `--remove` restores them; doctor reports every
item healthy; break one item at a time (remove a hook entry, chmod the database, kill the worker,
point the provider at an unreachable host, set the allowance counter to exhausted) and confirm
doctor names it.

## Cross-agent memory (User Story 1, SC-001, SC-004)

```bash
sudo -u oboete-dogfood -H env PATH="$PATH" node scripts/e2e/isolated-user.mjs --pairs all
```

The harness seeds three facts in a synthetic repository with agent A (headless: `claude -p`,
`codex exec`, `grok -p`, `pi -p`), then starts agent B in the same repository with a prompt that
forces one tool call and asks for the facts. Expected: 12 of 12 ordered pairs recall all three facts
on the first turn (Grok Build receiving: by the first tool result); the same run with credentials
removed still passes with `Degraded:` lines in every pack.

## Privacy (User Story 3, SC-005, SC-006)

```bash
npm test -- --test-name-pattern "privacy"
```

Expected: fail-closed tests block secret and local-only rows from the remote observer and
cross-repository injection, including a mixed-sensitivity batch whose outbound body contains only
eligible content; fail-open tests deliver eligible rows; eligibility decisions are identical when
only the producing agent changes; credential values never appear in logs, spool, doctor output, or
packs.

## Viewer and MCP (User Story 6, SC-011)

```bash
oboete view      # prints http://127.0.0.1:<port>/?token=...
node scripts/e2e/mcp-clients.mjs   # tools/list + tools/call through each agent's MCP client
```

Expected: a memory created by the worker appears in the viewer within 2 seconds; pin, delete, and
search work; the URL without the token and any non-loopback bind are refused; each supported
client lists and calls `search`, `timeline`, `get`.

## Export / import (User Story 7)

```bash
oboete export > memories.jsonl
OBOETE_HOME=$(mktemp -d) oboete import memories.jsonl --dry-run
```

Expected: counts match, tombstones are preserved, an imported row never lowers sensitivity, an
oversized or malformed line is rejected with exit `2`.

## Dogfood gate (SC-007)

Run `scripts/e2e/isolated-user.mjs --daily` on the isolated account once a day for 7 consecutive
days; each run records doctor output, provider usage, spool backlog, duplicate count, and viewer
latency under `docs/evidence/m1-dogfood.md`. M1 is a "done" candidate only after 7 green days;
installation into the maintainer's environment is a separate approval afterwards.
