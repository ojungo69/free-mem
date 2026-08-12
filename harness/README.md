# Phase 0B contract harness

v6.1 §29 Phase 0B / §7.2 capability matrix を real CLI fixture から組み立てる最小 harness。依存ゼロ・Node 24 直接実行。

```bash
node --experimental-strip-types harness/assemble.ts harness/fixtures/claude harness/matrix/claude.json
node --experimental-strip-types harness/assemble.ts --self-test     # PASS を出す
harness/rig/rig.sh setup && harness/rig/rig.sh claude-run <label> "<prompt>"   # 隔離 capture
harness/sidecar/run-tests.sh                                        # supervisor self-check
harness/sidecar/hostile-e2e.sh                                      # hostile 設定下の side effect 検査
harness/rig/rig.sh teardown                                         # 資格情報コピーごと削除
```

- `schema/` — Capability / CaptureFixture 型（§7.2 逐語）+ JSON Schema
- `rig/` — 隔離 capture rig。scratch HOME / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` + capture 専用 hook のみ + `AGENT_MEMORY_INTERNAL_RUN=1` + 使い捨て workspace。ユーザー実環境の plugin・hook・メモリ DB を汚染しない
- `fixtures/<cli>/*.json` — CaptureFixture（人手で所見を確定したもの）。`fixtures/<cli>/raw/` は rig が吐いた生 JSONL
- `matrix/` — assemble 出力（version-pin 付き AdapterCapabilities）
- `sidecar/` — §13.6 supervisor（deadline / process-group kill / reap / 残存検査）と hostile fixture E2E、認定判定 `certification-decision.md`

assemble の方針: 観測できた EventKind のみ `native`、合成が必要なものは fixture 側で `capability: "synthesized"` + `sourceEvents` を明示（空だと検証エラー）。未観測 cell は `unknown` のまま残す（HI-23。Tier A は宣言しない）。fixture 間で `nativeVersion` が食い違えば version-pin 違反として exit 1。
