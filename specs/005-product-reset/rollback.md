# Rollback: Product Reset M0 GitHub State

Use this runbook only if the Product Reset documentation pull request is abandoned or reverted on
the default branch. Do not run it merely because a later implementation slice changes scope.

## Preconditions

1. Confirm the Product Reset branch will not become default-branch authority, or confirm its merge
   commit has been reverted.
2. Capture current issue, label, parent/sub-issue, blocked-by, and pull-request state before any
   mutation.
3. Announce the rollback on #136 so users do not follow child issues during the transition.
4. Run mutations serially with `set -e`; after any failure, re-query live state before resuming.

## Read-only preview

```sh
set -e
export GH_REPO='ojungo69/free-mem'
test "$(gh repo view --json nameWithOwner --jq .nameWithOwner)" = "$GH_REPO"
export RESET_ROLLBACK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/free-mem-reset-rollback.XXXXXX")
chmod 700 "$RESET_ROLLBACK_DIR"

gh issue list --state all --limit 200 --json number,state,labels \
  > "$RESET_ROLLBACK_DIR/issues-before.json"
gh pr view 131 --json number,state,mergedAt,headRefName \
  > "$RESET_ROLLBACK_DIR/pr-131-before.json"
gh pr view 133 --json number,state,mergedAt,headRefName \
  > "$RESET_ROLLBACK_DIR/pr-133-before.json"
gh api graphql -f query='query { repository(owner:"ojungo69", name:"free-mem") {
  i126: issue(number:126) { number parent { number } }
  i129: issue(number:129) { number parent { number } }
  i130: issue(number:130) { number parent { number } }
  i136: issue(number:136) { number state subIssues(first:20) { nodes { number state } } }
  i137: issue(number:137) { number state parent { number } blockedBy(first:20) { nodes { number } } }
  i138: issue(number:138) { number state parent { number } blockedBy(first:20) { nodes { number } } }
  i139: issue(number:139) { number state parent { number } blockedBy(first:20) { nodes { number } } }
} }' > "$RESET_ROLLBACK_DIR/relationships-before.json"

test -s "$RESET_ROLLBACK_DIR/issues-before.json"
test -s "$RESET_ROLLBACK_DIR/pr-131-before.json"
test -s "$RESET_ROLLBACK_DIR/pr-133-before.json"
test -s "$RESET_ROLLBACK_DIR/relationships-before.json"
printf 'Snapshot: %s\n' "$RESET_ROLLBACK_DIR"
```

Keep the same shell and `RESET_ROLLBACK_DIR` value through post-verification. Compare the snapshot
with `issue-routing.md`. Do not infer state from this document alone.

## Restore the former issue set

The M0 closure set is exact and contains 61 issues.

```sh
set -e

# Scope copied to Slice 1
for n in 19 40 45 46 49 61 62 68 69 80 91 93 96 100 101 102 108; do
  gh issue reopen "$n" --comment 'Product Reset M0 rollback: reopening because the replacement authority did not land or was reverted. Restore the pre-reset issue scope and re-triage before implementation.'
done

# Scope copied to Slice 2
for n in 8 11 32 67; do
  gh issue reopen "$n" --comment 'Product Reset M0 rollback: reopening because the replacement authority did not land or was reverted. Restore the pre-reset issue scope and re-triage before implementation.'
done

# Scope copied to Slice 3
for n in 9 10 22 56 57 66 72 82 83 90 94 95 97 98 103 105 106 107; do
  gh issue reopen "$n" --comment 'Product Reset M0 rollback: reopening because the replacement authority did not land or was reverted. Restore the pre-reset issue scope and re-triage before implementation.'
done

# Superseded/deferred set plus the resolved governance issue
for n in 1 12 13 24 31 53 54 58 64 65 70 71 73 74 76 79 84 99 104 132 134 135; do
  gh issue reopen "$n" --comment 'Product Reset M0 rollback: reopening because the replacement authority did not land or was reverted. The former product direction is restored pending a new owner decision.'
done
```

Remove only the `wontfix` labels M0 added to the superseded set:

```sh
set -e
gh issue edit 1 12 13 24 31 53 54 58 64 65 70 71 73 76 79 84 99 104 132 134 135 \
  --remove-label wontfix
```

## Restore labels on the eight kept issues

```sh
set -e
gh issue edit 81 --remove-label 'target: technical alpha' --add-label 'target: core 1.0'
gh issue edit 123 --remove-label 'target: technical alpha,status: deferred'
gh issue edit 124 --remove-label 'target: technical alpha'
gh issue edit 126 129 130 \
  --remove-label 'target: technical alpha,status: ready for implementation' \
  --add-label 'target: core 1.0'
gh issue edit 127 128 --remove-label 'target: technical alpha,status: deferred'
```

The new labels may remain unused; deleting repository labels is not required for functional
rollback and should be a separate owner decision.

## Restore the old pull request and retire replacement work

```sh
set -e
gh issue edit 126 129 130 --remove-parent
gh issue edit 137 138 139 --remove-parent
gh issue edit 138 --remove-blocked-by 137
gh issue edit 139 --remove-blocked-by 137 --remove-blocked-by 138

gh pr reopen 133 --comment 'Product Reset M0 rollback: reopening because the replacement authority did not land or was reverted. Review threads and checks must be re-evaluated from current head before any merge decision.'

for n in 137 138 139 136; do
  gh issue close "$n" --reason 'not planned' --comment 'Product Reset M0 rollback: this replacement issue is closed because its repository authority did not land or was reverted. See the reopened pre-reset issues.'
done
```

Do not delete the Product Reset issue bodies, branch, comments, or labels; they are rollback audit
evidence.

## Post-rollback verification

```sh
set -e
test -n "${RESET_ROLLBACK_DIR:-}"

gh issue list --state all --limit 200 --json number,state,labels \
  > "$RESET_ROLLBACK_DIR/issues-after.json"
gh pr view 131 --json number,state,mergedAt,headRefName \
  > "$RESET_ROLLBACK_DIR/pr-131-after.json"
gh pr view 133 --json number,state,mergedAt,headRefName \
  > "$RESET_ROLLBACK_DIR/pr-133-after.json"
gh api graphql -f query='query { repository(owner:"ojungo69", name:"free-mem") {
  i126: issue(number:126) { number parent { number } }
  i129: issue(number:129) { number parent { number } }
  i130: issue(number:130) { number parent { number } }
  i137: issue(number:137) { number state parent { number } blockedBy(first:20) { nodes { number } } }
  i138: issue(number:138) { number state parent { number } blockedBy(first:20) { nodes { number } } }
  i139: issue(number:139) { number state parent { number } blockedBy(first:20) { nodes { number } } }
} }' > "$RESET_ROLLBACK_DIR/relationships-after.json"

expected='[1,8,9,10,11,12,13,19,22,24,31,32,40,45,46,49,53,54,56,57,58,61,62,64,65,66,67,68,69,70,71,72,73,74,76,79,80,81,82,83,84,90,91,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,123,124,126,127,128,129,130,132,134,135]'
jq -e --argjson expected "$expected" '
  ([.[] | select(.number as $n | $expected | index($n)) | select(.state == "OPEN") | .number] | sort)
  == ($expected | sort)
' "$RESET_ROLLBACK_DIR/issues-after.json"

jq -e '
  def names: [.labels[].name];
  (map(select(.number == 81))[0] | (names | index("target: core 1.0")) != null and (names | index("target: technical alpha")) == null)
  and (all(.[] | select(.number == 123 or .number == 124 or .number == 127 or .number == 128); (names | index("status: deferred")) == null and (names | index("target: technical alpha")) == null))
  and (all(.[] | select(.number == 126 or .number == 129 or .number == 130); (names | index("status: ready for implementation")) == null and (names | index("target: technical alpha")) == null and (names | index("target: core 1.0")) != null))
' "$RESET_ROLLBACK_DIR/issues-after.json"

jq -S . "$RESET_ROLLBACK_DIR/pr-131-before.json" \
  > "$RESET_ROLLBACK_DIR/pr-131-before.sorted.json"
jq -S . "$RESET_ROLLBACK_DIR/pr-131-after.json" \
  > "$RESET_ROLLBACK_DIR/pr-131-after.sorted.json"
diff -u \
  "$RESET_ROLLBACK_DIR/pr-131-before.sorted.json" \
  "$RESET_ROLLBACK_DIR/pr-131-after.sorted.json"
jq -e '.state == "OPEN" and .mergedAt == null' "$RESET_ROLLBACK_DIR/pr-133-after.json"
jq -e '
  .data.repository
  | (.i126.parent == null and .i129.parent == null and .i130.parent == null)
  and all(.i137,.i138,.i139; .state == "CLOSED" and .parent == null and (.blockedBy.nodes | length) == 0)
' "$RESET_ROLLBACK_DIR/relationships-after.json"

for n in 136 137 138 139; do
  gh issue view "$n" --json state,comments \
    | jq -e '.state == "CLOSED" and any(.comments[]; .body | contains("Product Reset M0 rollback"))'
done
```

Expected minimum state:

- the original 69 issues are open again;
- PR #133 is open and remains unmerged;
- replacement issues #136-#139 are closed with rollback comments;
- #131 remains unchanged;
- no claim is made that the old continuity findings are fixed or merge-ready.

Record the actual timestamp, command results, and any deviations in a new rollback comment on
\#136. If any issue cannot be restored exactly, stop and document the difference rather than
guessing labels or relationships.
