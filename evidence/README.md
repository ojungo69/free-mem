# Evidence 成果物索引

正本: `agent-memory-final-spec-v6.md` / `specs/001-agent-memory-core/phase-1-design.md` / `specs/001-agent-memory-core/tasks.md`

| 成果物 | パス | タスク |
|---|---|---|
| codemem upstream test ログ | codemem/upstream-test.log | T004 |
| codemem license/SBOM/native asset | codemem/sbom.md | T004 |
| ai-memory 同上 | ai-memory/ | T005 |
| remem 同上 | remem/ | T006 |
| codemem write-handle inventory（file:line） | codemem/write-handle-inventory.md | T007 |
| ai-memory/remem 簡易 inventory | */inventory-summary.md | T008 |
| codemem runtime audit / benchmark runner | codemem/runtime-audit.md | T009 |
| fatal/non-fatal 分類 | codemem/write-handle-classification.md | T010 |
| delta 比較 | delta-comparison.md | T011 |
| unsafe path action plan | unsafe-path-action-plan.md | T012 |
| base ADR | adr-001-base.md | T013 |
| clean install 検証 | clean-install.md | T015 |
| viewer 認証・read-only RPC security validation | phase1-t043-viewer-security-validation.md | T043 |
| CLI daemon RPC cutover validation | phase1-t044-cli-rpc-validation.md | T044 |
| daemon jobs・maintenance mode validation | phase1-t045-t046-daemon-jobs-validation.md | T045–T046 |
| export/import daemon operation validation | phase1-t047-operations-validation.md | T047 |
| daemon-only DB handle validation | phase1-t048-zero-external-db-handles-validation.md | T048 |
| legacy cutover validation | phase1-t051-legacy-cutover-validation.md | T051 |
| backup/restore baseline validation | phase1-t052-backup-restore-validation.md | T052 |
| static exit-gate validation | phase1-t053-static-scan-validation.md | T053 |
| runtime DB ownership validation | phase1-t054-runtime-db-open-validation.md | T054 |
| fault-injection validation | phase1-t055-fault-injection-validation.md | T055 |
| no-Agent-blockage validation | phase1-t056-no-agent-blockage-validation.md | T056 |
| backup/restore smoke validation | phase1-t057-backup-restore-smoke-validation.md | T057 |
| Phase 1 final candidate validation（machine 25/31 と manual 31/31 を分離） | phase1-t058-final-validation.md | T058 |
| Rust Local Core 再評価 ADR（#1 Stage 0。ADR-001 の却下理由分解・cutover gate の pass/defer 定義） | adr-003-rust-local-core.md | #1 Stage 0 |
| ライセンス決定 ADR（#10。候補比較・依存 license 実測・material 分類・inbound 方針） | adr-004-licensing.md | #10 |
| Rust Core 戦略 ADR（#1。標準実行基盤の段階移行方針・Stage 1 の再定義・正本連鎖との関係） | adr-005-rust-core-product-direction.md | #1 |
| 直接競合の positioning snapshot（commit pin 済みの公開情報のみ。benchmark 証拠ではない） | direct-competitor-positioning-2026-08-18.md | #8 / #79 |
| capability scenario manifest（§13 の manifest hash 規則） | phase3-capability-scenario-manifest.md | Phase 3 Task 4 |
| 継続 event の参照実装（§3.1 / §4.2 / §4.3 の導出と限界） | phase3-reference-model.md | Phase 3 Task 5 |

pin: codemem 26438e75ce1d0fec6be34981f15045a15c89658b / ai-memory a9e9a24d50f59e970fc01ae48efe647abf20702e / remem cde8bc05504c74794d044ef118f74d8f828adbf5
clone 元: ~/projects/free-mem-vendor/（ローカル clone のみ・公開 fork なし）
