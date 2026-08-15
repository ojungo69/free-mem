# T058 Phase 1 final candidate validation

日付: 2026-08-15

対象: product candidate `f44a9880d357e2bbb0c5e568fe18deac651b543a`（`fix(viewer): bound streamed JSON requests`）

## 結論

SC-1 の候補検証は完了した。`main` へのマージはこの候補検証の外にある最終外部ステップであり、本記録はマージ済みとは主張しない。

## Final gates

- toolchain: Node `v24.16.0` / Corepack pnpm `11.8.0`。
- CI `check`: `1,854 = 1,851 passed + 3 todo`、failure 0。
- test-set comparator: `4,037`（事前）`- 2,376`（retire）`+ 193`（登録済み追加）`= 1,854`（最終）。
- T055 fault injection: pass。T056 no-Agent-blockage: pass、最終 p95 は Claude `133.1ms` / Codex `147.6ms` で 150ms 目標内。T057 backup/restore smoke: pass。
- T029 の disposition は T053 static scan で再照合済み（279 production files / 0 violations）。
- CLI help と viewer smoke は candidate build で pass。clean checkout は frozen lockfile install → build → check の順で pass。
- 最終 viewer body-limit 修正後も tsc、Biome 393 files、viewer build、serial full suite 114 files / 1,854 tests（1,851 passed + 3 todo）は pass。

## Machine verifier と手動照合

`verify-tasks-report.md` の machine verdict は意図的に **25 / 31** のまま保持する。これは evidence-aware verifier の branch/diff/presence matcher の到達範囲であり、未完了数ではない。

手動照合は T027–T057 の **31 / 31** を candidate、実装、test/evidence、exit gate で突合して完了した。machine score と一致しない6件の理由は次のとおり。

| Task | machine verdict | scope-limit reason | manual reconciliation |
|---|---|---|---|
| T027 | PARTIAL | worktree/branch は repository diff artifact ではない | 現在の isolated worktree と branch を確認 |
| T028 | PARTIAL | frozen baseline は candidate diff に再出現しない | baseline、retire manifest、final comparator を照合 |
| T030 | PARTIAL | deletion は presence matcher では陽性化できない | consumer/credential path の不在を source と static scan で確認 |
| T031 | NOT_FOUND | task が deletion target の source path を指定していない | sidecar dispatch の不在、T053 denylist、build/test を確認 |
| T032 | SKIPPED | bootstrap deletion に path/symbol/acceptance artifact がない | template 参照なしを source/CLI help で確認 |
| T037 | PARTIAL | referenced test は candidate diff の変更対象外 | peer error mapping と production caller/export を確認 |

## Security review matrix

| Finding | Disposition | candidate evidence |
|---|---|---|
| degraded redaction worker failure could admit a persisted control identifier | fixed | `isSafePersistedText` now rejects `intake.degraded`; regression test covers injected worker failure |
| legacy cutover could publish the current pointer before tombstone/final owner checks | fixed | migration/publication moved after identity, tombstone, owner-scan, and manifest checks; ordering regression test added |
| process loss after tombstone but before pointer publication required manual recovery | fixed | startup verifies the exact tombstone and matching recovery hardlink, restores the legacy path, and reruns cutover; preserved-row regression added |
| unauthenticated viewer JSON handling buffered a chunked body before enforcing its size limit | fixed | installed Hono `bodyLimit` now rejects both JSON POST routes before `readBoundedJson`; the existing auth security case proves 413 before the full stream or RPC dispatch |
| daemon-job POST/GET lifecycle was reported as a retry concern | rejected by contract | T045 Class-C contract is one POST plus GET polling; restart marks orphaned work failed and automatic retry is prohibited |

All four valid final findings were fixed through `f44a988`; the daemon-job report is not a defect under the explicit Class-C contract. The streamed-body fix was found by the independent agy security review and its focused re-review returned `ok: true`; Semgrep `p/default` findings were reviewed with no remaining valid High/Critical issue.

## Upgrade and rollback commands

Run from the target installation after selecting the canonical SQLite path with `--db-path`; backup IDs are returned by `backup create|list`.

```bash
# pre-upgrade: create and verify a local recovery point
codemem backup create --reason pre-upgrade --json --db-path <path-to-mem.sqlite>
codemem backup list --json --db-path <path-to-mem.sqlite>
codemem backup verify <backup-id> --json --db-path <path-to-mem.sqlite>

# candidate checkout validation
corepack pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm run codemem --help

# rollback: restore only a verified local backup, then restart the daemon
codemem backup restore <backup-id> --json --db-path <path-to-mem.sqlite>
codemem status --json --db-path <path-to-mem.sqlite>
```

Backups can contain private/local-only data; Phase 1 supports local backup only.

## Terminal external step

Before merging `f44a988` to `main`, obtain the independent approval required by the repository workflow, then perform the merge and recheck the resulting `main` CI. Neither action was performed by this candidate validation.
