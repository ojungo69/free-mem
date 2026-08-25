# Quickstart: Validate the Product Reset M0

Run from the Product Reset worktree root.

## 1. Confirm the isolated baseline

```sh
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

```sh
rg -n "automatic memory|Product Reset|historical|Linux/WSL" \
  README.md evidence/README.md specs/005-product-reset
rg -n "claude-mem|Codemem|fork" evidence/adr-006-product-reset.md
```

Expected:

- README points to `specs/005-product-reset/spec.md` as active authority
- evidence index marks v6 continuity and Rust-first artifacts historical
- ADR records Codemem as the conditional base and rejects a claude-mem runtime fork

## 3. Prove M0 did not change runtime code

```sh
git status --short
git diff --name-only origin/main --
unexpected=$({ git diff --name-only origin/main --; git ls-files --others --exclude-standard; } \
  | sort -u \
  | rg -v '^(README\.md|evidence/(README\.md|adr-006-product-reset\.md)|specs/005-product-reset/.*\.(md|json))$' \
  || true)
test -z "$unexpected"
git diff --quiet origin/main -- vendor/codemem harness
git diff --check
git diff --cached --check
```

Expected: only root/evidence/specification documentation is changed; the final command exits 0.

## 4. Verify GitHub routing after the documentation commit is pushed

```sh
gh pr view 133 --json state,mergedAt,title,url
gh pr view 133 --json state,mergedAt \
  | jq -e '.state == "CLOSED" and .mergedAt == null'
for n in 134 135; do
  gh issue view "$n" --json state | jq -e '.state == "CLOSED"'
done
for n in 136 137 138 139; do
  gh issue view "$n" --json state | jq -e '.state == "OPEN"'
done
active=$(gh issue list --state open --limit 200 --json labels \
  | jq '[.[] | select(any(.labels[]; .name == "status: in progress" or .name == "status: ready for implementation"))] | length')
test "$active" -le 5
```

Expected:

- PR #133 is closed and unmerged
- #134 and #135 are closed as superseded
- one Product Reset parent and three child implementation issues exist
- no more than five issues have an active status

## 5. Review future runtime contracts

Validate the fixed Slice 1 fixture:

```sh
jq -e '
  . as $root
  |
  .fixtureVersion == 1
  and .ownerSlice == 1
  and .factMatch == "exact"
  and .pins.freeMemBaseCommit == "accaa29f5627c20c7e4c106a81211067fcf2bc42"
  and .pins.claudeCodeVersion == "2.1.243"
  and .pins.codexVersion == "0.149.1"
  and .thresholds.orphanProductProcessCount == 0
  and .thresholds.maxInjectedTokens == 800
  and ([.scenarios[].scenarioId] | sort) == ([
    "claude-to-codex",
    "codex-to-claude",
    "runtime-unavailable-spool-recovery",
    "summary-provider-retry-exhausted"
  ] | sort)
  and (.scenarios[]
    | select(.scenarioId == "summary-provider-retry-exhausted")
    | .drainCondition.eventDeliveryState == "committed"
      and .drainCondition.summaryJobState == "retry-exhausted")
  and all(.scenarios[];
    . as $scenario
    | (.events | length) > 0
    and (.retrievalQuery | length) > 0
    and (.forbiddenFacts | length) > 0
    and .drainCondition.drainConditionId != null
    and all(.events[];
      .kind as $kind
      | ($root.kindContract.capturedEventKinds | index($kind)) != null)
    and all(.summaryProviderStub.memoryItems[]?;
      .kind as $kind
      | ($root.kindContract.memoryItemKinds | index($kind)) != null)
    and all(.requiredFacts[]?;
      . as $fact
      | any($scenario.summaryProviderStub.memoryItems[]?; .text == $fact))
    and .expectedCounters.agentBlockageCount == 0
    and .expectedCounters.acceptedEventLossCount == 0
    and .expectedCounters.duplicateDurableMemoryCount == 0
    and .expectedCounters.secretEgressCount == 0
    and .expectedCounters.incompatibleScopeInjectionCount == 0)
' specs/005-product-reset/fixtures/slice1-bidirectional-en-v1.json
```

- [Alpha comparison](contracts/alpha-comparison.md)
- [Effective capability manifest](contracts/capability-manifest.md)
- [InjectionPack](contracts/injection-pack.md)
- [Slice 1 fixed fixture](fixtures/slice1-bidirectional-en-v1.json)
- [M0 rollback](rollback.md)

These contracts guide later focused specs; M0 does not claim the runtime behaviors are implemented.

## Validation result — 2026-08-25T10:34:15+09:00

| Check | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | PASS, exit 0 |
| `corepack pnpm run build` | PASS, exit 0 |
| `CI=true corepack pnpm run check` | PASS, exit 0; 124 test files and 1,895 tests passed, three todo |
| Product authority grep | PASS |
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
- No command required a changed path, flag, retry, or skipped gate.
