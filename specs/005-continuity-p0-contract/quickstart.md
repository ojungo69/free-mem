# Quickstart: S0 contract validation

Run from the repository root. Node.js 24 is required. No new package is installed by this feature.

## 1. Focused source-aware contract gate

```bash
node --experimental-strip-types --test \
  harness/continuity/source-aware-contract.test.ts
```

Expected: schema/TS mirror, contract manifest/hash, machine inventory, restore semantic-validation rules, exact F0–F7 set,
cross-references, case-specific invariants, and in-memory negative mutations all pass.

## 2. Harness typecheck

After the existing vendor workspace dependencies are installed:

```bash
vendor/codemem/node_modules/.bin/tsc -p harness/tsconfig.json
```

Expected: no diagnostics. The successor TS mirror and JSON Schema field/enum/version tables agree.

## 3. Full continuity contract tests

```bash
node --experimental-strip-types --test harness/continuity/*.test.ts
```

Expected: all tests pass, including legacy V1 reference-model and old-shape parity tests.

## 4. Raw-byte contract hash regeneration check

```bash
S0_HASH_TMP=$(mktemp)
node harness/contract-hashes.mjs > "$S0_HASH_TMP"
diff harness/contract-hashes.json "$S0_HASH_TMP"
rm "$S0_HASH_TMP"
```

Expected: empty diff. The new schema, inventory manifest, contract manifest, and F0–F7 corpus are all present in the
committed raw-byte hash manifest.

## 5. Old-shape parity check

```bash
S0_OLD_SHAPE_TMP=$(mktemp)
node --experimental-strip-types harness/continuity/old-shape-baseline.mjs \
  --output "$S0_OLD_SHAPE_TMP"
diff harness/fixtures/continuity/old-shape-parity.json "$S0_OLD_SHAPE_TMP"
rm "$S0_OLD_SHAPE_TMP"
```

Expected: empty diff. S0 adds successor contracts without changing V1 behavior or its pinned corpus.

## 6. Existing continuity mutation gate

```bash
bash harness/continuity/mutate.sh
```

Expected: every existing reducer mutation is killed, executed count matches the script manifest, and survivors are zero.
The source-aware static corpus uses its own in-memory negative mutations and is not added to this reducer mutation script.

## 7. Scope check

```bash
set -euo pipefail
S0_SCOPE_TMP=$(mktemp)
trap 'rm -f "$S0_SCOPE_TMP"' EXIT
git diff --name-only origin/main...HEAD > "$S0_SCOPE_TMP"
git diff --name-only >> "$S0_SCOPE_TMP"
git diff --cached --name-only >> "$S0_SCOPE_TMP"
git ls-files --others --exclude-standard >> "$S0_SCOPE_TMP"
sort -u "$S0_SCOPE_TMP"
if sort -u "$S0_SCOPE_TMP" | rg '^(vendor/codemem/|\.github/workflows/|harness/continuity/reference-model\.ts$|harness/fixtures/continuity/old-shape-parity\.json$|harness/continuity/mutate\.sh$|harness/contract-hashes\.mjs$)'; then
  exit 1
fi
```

Expected: the final command prints nothing across committed, unstaged, staged, and untracked scope. S0 contains docs,
schema/manifest/corpus, tests, and generated hashes only.

## 8. Spec Kit completion check

After implementation, run the installed verify-tasks extension exactly once. Every checked task must point to a committed
artifact and runnable evidence; no task is complete merely because the contract describes it.
