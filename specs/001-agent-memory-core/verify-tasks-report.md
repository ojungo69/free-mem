# Verify Tasks Report — T036 / T050

日付: 2026-08-14 / scope: `uncommitted`（HEAD `9ecaaad` → working tree） / 対象: 2 tasks

> ⚠️ **FRESH SESSION ADVISORY**: For maximum reliability, run `/speckit.verify-tasks`
> in a **separate** agent session from the one that performed `/speckit.implement`.
> The implementing agent's context biases it toward confirming its own work.

## Scorecard

| Verdict | 件数 |
|---|---:|
| ✅ VERIFIED | 2 |
| 🔍 PARTIAL | 0 |
| ❌ NOT_FOUND | 0 |
| ⚠️ WEAK | 0 |
| ⏭️ SKIPPED | 0 |

## Verified Items

| Task | Verdict | Summary |
|---|---|---|
| T036 | ✅ VERIFIED | receipt schema、共有 class-A dispatcher、canonical writer、RPC allowlist/route、scope-aware viewer read が実装・配線・回帰試験済み |
| T050 | ✅ VERIFIED | SQLite online backup、standalone/hash/integrity verify、migration gate、canonical backup RPC が実装・配線・回帰試験済み |

## Per-layer evidence

### T036

| Layer | Result | Evidence |
|---|---|---|
| L1 file existence | positive | `vendor/codemem/packages/core/src/mutation-dispatcher.ts`、`daemon-canonical.ts`、`daemon-rpc.ts`、`mutation-dispatcher.test.ts` が存在 |
| L2 diff cross-reference | positive | 上記全ファイルが `git diff HEAD --name-only` に存在 |
| L3 content matching | positive | `ensureMutationReceiptSchema`、`dispatchClassA`、`openCanonicalWriter`、events/memory/search/view routes を確認 |
| L4 dead-code detection | positive | lifecycle→`openCanonicalWriter`、RPC各class-A route→`dispatchClassA`、index export、testsから参照あり |
| L5 semantic assessment | positive | ⚠️ Interpretive: side effectとreceiptが同一transaction、replay/conflict、normalized event、filter/scope境界が実処理として接続され、stub対象は後続T045/T047へ明示分離 |

### T050

| Layer | Result | Evidence |
|---|---|---|
| L1 file existence | positive | `vendor/codemem/packages/core/src/online-backup.ts` と `online-backup.test.ts` が存在 |
| L2 diff cross-reference | positive | 両ファイルとmigration/canonical wiringが `git diff HEAD --name-only` に存在 |
| L3 content matching | positive | `createOnlineBackup`、`verifyOnlineBackup`、`runGatedMigration`、`requireVerifiedBackup` を確認 |
| L4 dead-code detection | positive | canonical writer/RPC/index export/testsから全主要symbolへの参照あり |
| L5 semantic assessment | positive | ⚠️ Interpretive: upgrade時だけbackupを作成し、regular-file/WAL/hash/SQLite integrity再検証後にだけmigrationへ進む。fresh bootstrapと失敗時未変更も試験済み |

## Machine-readable verdicts

| Task | Verdict | Summary |
|---|---|---|
| T036 | ✅ VERIFIED | implemented and wired |
| T050 | ✅ VERIFIED | implemented and wired |

✅ No flagged items — verification complete.
