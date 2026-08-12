# Phase 0B contract harness

v6.1 §29 Phase 0B / §7.2 capability matrix を real CLI fixture から組み立てる最小 harness。依存ゼロ。Node 24 直接実行。

```bash
node --experimental-strip-types harness/assemble.ts <fixturesDir> <outFile>
node --experimental-strip-types harness/assemble.ts --self-test
```

- `schema/` — Capability / CaptureFixture 型 + JSON Schema
- `fixtures/claude/` · `fixtures/codex/` — CaptureFixture JSON（後続）
- `matrix/` — assemble 出力（後続）
- `rig/` · `sidecar/` — 隔離 capture / sidecar（後続タスク。mkdir 不要）

assemble: fixtures 直下 `*.json` を検証し、観測 EventKind を `native` にした AdapterCapabilities を書く。高位 cell（injection 等）は unknown のまま。
