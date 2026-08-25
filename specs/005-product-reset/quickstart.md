# Quickstart: Validate the Product Reset M0

Run from the Product Reset worktree root.

## 1. Confirm the isolated baseline

```bash
set -euo pipefail
git status --short --branch
cd vendor/codemem
corepack pnpm install --frozen-lockfile
corepack pnpm run build
CI=true corepack pnpm run check
cd ../..
```

Expected baseline before M0 documentation changes:

- build exits 0
- typecheck and lint exit 0
- 124 test files pass
- 1,895 tests pass and three remain marked todo

## 2. Verify Product Reset authority

```bash
set -euo pipefail
rg -n "automatic memory|Product Reset|historical|Linux/WSL" \
  README.md evidence/README.md specs/005-product-reset
rg -n "claude-mem|Codemem|fork" evidence/adr-006-product-reset.md
```

Expected:

- README points to `specs/005-product-reset/spec.md` as active authority
- evidence index marks v6 continuity and Rust-first artifacts historical
- ADR records Codemem as the conditional base and rejects a claude-mem runtime fork

## 3. Prove M0 did not change runtime code

```bash
set -euo pipefail
git status --short
changed=$(git diff --name-only origin/main --)
printf '%s\n' "$changed"
untracked=$(git ls-files --others --exclude-standard)
if unexpected=$(printf '%s\n%s\n' "$changed" "$untracked" \
  | sort -u \
  | rg -v '^(README\.md|evidence/(README\.md|adr-006-product-reset\.md)|specs/005-product-reset/.*\.(md|json))$'); then
  :
else
  status=$?
  test "$status" -eq 1
  unexpected=
fi
test -z "$unexpected"
git diff --quiet origin/main -- vendor/codemem harness
git diff --check
git diff --cached --check
```

Expected: only root/evidence/specification documentation is changed; the final command exits 0.

## 4. Verify GitHub routing after the documentation commit is pushed

```bash
set -euo pipefail
export GH_REPO='ojungo69/free-mem'
test "$(gh repo view --json nameWithOwner --jq .nameWithOwner)" = "$GH_REPO"
gh pr view 133 --json state,mergedAt,title,url
gh pr view 133 --json state,mergedAt \
  | jq -e '.state == "CLOSED" and .mergedAt == null'
for n in 134 135; do
  gh issue view "$n" --json state | jq -e '.state == "CLOSED"'
done
for n in 136 137 138 139; do
  gh issue view "$n" --json state | jq -e '.state == "OPEN"'
done
gh issue list --state open --limit 200 --json number,labels \
  | jq -e '
    [
      .[]
      | {
          number,
          activeStatuses: ([
            .labels[].name
            | select(. == "status: in progress" or . == "status: ready for implementation")
          ] | sort)
        }
      | select(.activeStatuses | length > 0)
    ]
    | sort_by(.number)
    == [
      {"number":126,"activeStatuses":["status: ready for implementation"]},
      {"number":129,"activeStatuses":["status: ready for implementation"]},
      {"number":130,"activeStatuses":["status: ready for implementation"]},
      {"number":136,"activeStatuses":["status: in progress"]},
      {"number":137,"activeStatuses":["status: ready for implementation"]}
    ]
  '
```

Expected:

- PR #133 is closed and unmerged
- #134 and #135 are closed as superseded
- one Product Reset parent and three child implementation issues exist
- the active-status mapping is exactly #126, #129, #130, #136, and #137 with the statuses above

## 5. Review future runtime contracts

Validate the fixed Slice 1 fixture. The schema owns structure and fixed values; the jq gate owns
cross-field counts, ordering, identity, and scenario relations. Both are mandatory and run in the
same fail-fast block:

```bash
set -euo pipefail
node --experimental-strip-types --input-type=module <<'NODE'
import { readIJsonFile } from "./harness/schema/jcs.ts";
import { validateAgainstSchema } from "./harness/schema/validate.ts";

const schema = readIJsonFile(
  "specs/005-product-reset/fixtures/slice1-bidirectional-en-v1.schema.json",
);
const fixture = readIJsonFile(
  "specs/005-product-reset/fixtures/slice1-bidirectional-en-v1.json",
);
const issues = validateAgainstSchema(fixture, schema, schema);

if (issues.length > 0) {
  console.error(JSON.stringify(issues, null, 2));
  process.exit(1);
}
NODE

jq -e '
  . as $root
  |
  ([.scenarios[].scenarioId] | sort) == ([
    "claude-to-codex",
    "codex-to-claude",
    "runtime-unavailable-spool-recovery",
    "summary-provider-retry-exhausted",
    "summary-provider-redirect-rejected"
  ] | sort)
  and ([.scenarios[].events[].eventId] as $ids
    | ($ids | length) == ($ids | unique | length))
  and all(.scenarios[];
    . as $scenario
    | [.events[].sequence] == [range(1; ((.events | length) + 1))]
    and .drainCondition.committedEventCount == (.events | length)
    and .drainCondition.summaryCount ==
      (if (.summaryProviderStub | has("summary")) then 1 else 0 end)
    and .drainCondition.durableMemoryCount ==
      (.drainCondition.summaryCount + (.summaryProviderStub.memoryItems | length))
    and all(.requiredFacts[]?;
      . as $fact
      | any($scenario.summaryProviderStub.memoryItems[]?; .body == $fact)))
  and (.scenarios[]
    | select(.scenarioId == "runtime-unavailable-spool-recovery")
    | [.events[].eventId] as $eventIds
    | ($eventIds | length) == 2
      and ($eventIds | unique | length) == 2
      and .fault.recovery == "restart_and_replay_same_batch_twice"
      and (.fault.replaySchedule | length) == 2
      and [.fault.replaySchedule[].attempt] == [1, 2]
      and all(.fault.replaySchedule[]; .eventIds == $eventIds)
      and .drainCondition.spooledEventCount == ($eventIds | length)
      and .drainCondition.replayCount == 2)
  and (.scenarios[]
    | select(.scenarioId == "summary-provider-retry-exhausted")
    | .drainCondition.eventDeliveryState == "committed"
      and .drainCondition.summaryJobState == "retry-exhausted"
      and .fault.attemptsUntilExhausted ==
        $root.effectiveConfiguration.resourceProfile.processingRetryLimit)
  and (.scenarios[]
    | select(.scenarioId == "summary-provider-redirect-rejected")
    | .summaryProviderStub.redirectResponse.status == 307
      and .drainCondition.eventDeliveryState == "committed"
      and .drainCondition.summaryJobState == "quarantined"
      and .drainCondition.redirectLocationRequestCount == 0
      and .drainCondition.resentPayloadCount == 0
      and .drainCondition.doctorReason == "provider_redirect_rejected")
' specs/005-product-reset/fixtures/slice1-bidirectional-en-v1.json
```

- [Alpha comparison](contracts/alpha-comparison.md)
- [Effective capability manifest](contracts/capability-manifest.md)
- [InjectionPack](contracts/injection-pack.md)
- [Slice 1 fixed fixture](fixtures/slice1-bidirectional-en-v1.json)
- [Slice 1 fixture schema](fixtures/slice1-bidirectional-en-v1.schema.json)
- [M0 rollback](rollback.md)

These contracts guide later focused specs; M0 does not claim the runtime behaviors are implemented.

## Validation result — 2026-08-25T13:48:57+09:00

| Check | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | PASS, exit 0 |
| `corepack pnpm run build` | PASS, exit 0 |
| `CI=true corepack pnpm run check` | PASS, exit 0; 124 test files and 1,895 tests passed, three todo |
| Product authority grep | PASS |
| Slice 1 fixture schema and semantic checks | PASS; positive fixture and 14 negative mutations |
| Local Markdown links (one-shot external validation) | PASS |
| `vendor/codemem/` and `harness/` diff | NONE |
| `git diff --check` and `git diff --cached --check` | PASS |
| GitHub routing | PASS; 12 open issues, five active-status issues, PR #133 closed/unmerged |

Environment-specific deviations:

- `pnpm install` reports that the vendored workspace has no nested `.git` directory when the
  Husky prepare script runs; prepare still exits 0 and the repository-level worktree remains the
  Git authority.
- Vitest intentionally emits failure-path setup, daemon-unavailable, and redaction fixture logs;
  the suite exits 0 with the counts above.
- The local Markdown link result was produced by a one-shot Node filesystem check during M0
  validation; no permanent link-checker dependency or script was added for this docs-only slice.
- The final local CodeRabbit CLI re-run reached its three-review limit after the prior completed run
  identified the redirect-oracle gap. That gap is fixed and the pushed head must receive a fresh
  GitHub CodeRabbit review before merge.
- No command required a changed path, flag, retry, or skipped gate.
