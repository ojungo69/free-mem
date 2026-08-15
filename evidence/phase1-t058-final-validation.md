# T058 Phase 1 final candidate validation

日付: 2026-08-15

対象: product candidate `3da6826f4aaa90ce61f17b9e3c65bfe0e47a40e5`（`fix: close final analysis findings`）

## 結論

SC-1 の候補検証は完了した。`main` へのマージはこの候補検証の外にある最終外部ステップであり、本記録はマージ済みとは主張しない。

## Final gates

- toolchain: Node `v24.16.0` / Corepack pnpm `11.8.0`。
- clean checkout `check`: 114 files、`1,854 = 1,851 passed + 3 todo`、failure 0。
- test-set comparator: `4,037`（事前）`- 2,376`（retire）`+ 193`（登録済み追加）`= 1,854`（最終）。
- T055 fault injection: built surface / Class A / lifecycle / Class B 全 pass、focused 5 files / 34 tests。T056 no-Agent-blockage: pass、最終 p95 は Claude `148.3ms` / Codex `139.3ms` で 150ms 目標内、13 files / 314 tests と packed artifact も pass。T057 backup/restore smoke: real-process gate と focused 4 files / 19 tests が pass。
- T029 の disposition は T053 static scan で再照合済み（279 production files / 0 violations）。
- clean checkout は frozen lockfile install → build → check → CLI help → 実 viewer 起動 / health / 正常停止の順で pass。
- full coverage は statements `76.86%`、branches `69.10%`、functions `81.48%`、lines `79.18%`。LCOV と `origin/main...a8ff359` の追加 executable line / branch outcome を照合した Sonar new-code 近似は `5,595 / 6,929 = 80.75%`。Sonar の SCM 判定と Quality Gate は push 後の解析を正本とする。
- PR `#5` の `61acb3d` 解析では Sonar new-code coverage `81.551%`、security / maintainability `A`、duplication `0.884%`、hotspots reviewed `100%`。ASCII operation ID の locale 非依存 sort を誤って BUG とした1件は根拠付き false positive とし、Quality Gate は pass に再評価された。
- Vitest JSON SHA-256: `8d1dca8e36871c1dd0ae25fb19b321c429c06fbd711920cfe94aadb480740b83`。LCOV SHA-256: `149e5691ae96496053d09aef38c1e160f75857528e50d0f03e793ced999c1746`。
- tsc、Biome 393 files、workspace build、3 standalone hook bundle の byte 一致（SHA-256 `9cd97306668ba5a159a2bed1591b11e2ec78bf725b6ac7c2d137f0d220a82ac8`）も pass。
- final analysis closure は focused 6 files / 176 tests、viewer API 2 files / 2 tests、UI production build、tsc、targeted Biome、GitNexus caller impact、independent correctness/security review、Ponytail review が pass。

## Machine verifier と手動照合

`verify-tasks-report.md` の machine verdict は意図的に **25 / 31** のまま保持する。これは evidence-aware verifier の branch/diff/presence matcher の到達範囲であり、未完了数ではない。

手動照合は T027–T057 の **31 / 31** を candidate、実装、test/evidence、exit gate で突合して完了した。machine score と一致しない6件の理由は次のとおり。

Fresh-session verifier の immutable report は `61acb3d` で生成した。その後の `3da6826` は Codacy / Sonar の最終解析対応に限定され、上記 focused gate と全 caller review で別途検証した。T027–T057 の手動照合結果は変わらない。

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
| loopback-port cookie scope exposed viewer sessions to another local listener | fixed | cookie auth was retired; the browser holds an origin-scoped `Authorization: Session` value, and cookie-only requests are rejected |
| existing-viewer login and custom DB viewer ownership were not bound to one runtime endpoint | fixed | PID ownership now lives under the resolved private runtime root; exact host family / port and daemon-issued nonce exchange are required before reuse or stop |
| custom `--db-path` runtimes shared parent control paths and callers dropped the explicit DB path | fixed | fixed-length path-hash runtime roots are resolved once and propagated through CLI hooks, MCP, viewer, setup, and legacy cutover recovery |
| backup create / restore could exceed the shared 2-second RPC deadline after committing | fixed | backup methods use durable operation journals and GET recovery; same-ID replay is stable and restore stop runs after late completion |
| interrupted restore recovery trusted a result sidecar without rechecking the activated SQLite artifact | fixed | before writer open, noncommitted restore journals require the saved main-file SHA-256 and absence of WAL/SHM; mismatch preserves pointer, journal, artifact, and sidecars and fails closed |
| viewer API helper could attach its session header to a future absolute-URL caller | fixed | `viewerFetch` accepts only relative `/api/` paths before adding authorization; the existing browser-auth test proves a cross-origin URL is rejected before `fetch` |
| viewer config projection exposed `observer_api_key` | fixed | the browser-facing projection now redacts the supported plaintext credential and has a literal-key regression |
| daemon-job POST/GET lifecycle was reported as a retry concern | rejected by contract | T045 Class-C contract is one POST plus GET polling; restart marks orphaned work failed and automatic retry is prohibited |

All valid findings above were fixed through `3da6826`; the daemon-job report is not a defect under the explicit Class-C contract. Independent correctness, manual security, and Ponytail re-reviews returned blocker-free. The dedicated Codex Security runner could not start because the active global config combines `multi_agent_v2` with `agents.max_threads`; persistent user configuration was not changed, and the same final diff received the manual security review instead. Semgrep findings were reviewed with no remaining valid High/Critical issue. CodeQL alerts `#29` / `#30` were dismissed as false positives because their test-only `/tmp` sources reach non-creating `r` / `r+` opens on existing private paths; the aggregate check then passed.

`.codacy.yml` uses documented `include_paths` to include the vendored product source and engine-specific Lizard exclusions only; this is a scope override, not an allowlist. Live Codacy status remains an external push-time check. See [Codacy configuration file](https://docs.codacy.com/repositories-configure/codacy-configuration-file/).

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

Before merging `3da6826` to `main`, obtain the independent approval required by the repository workflow, then perform the merge and recheck the resulting `main` CI. Neither action was performed by this candidate validation.
