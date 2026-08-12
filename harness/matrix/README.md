# T022 — Capability Golden Matrix（version-pinned）

生成物: `claude.json`（fixtures 5 件）/ `codex.json`（fixtures 3 件）。いずれも `harness/assemble.ts` が
`harness/fixtures/<cli>/*.json` から組み立てたもので、fixture 間で `nativeVersion` が一致しない場合は
組立自体が失敗する（version-pin の強制）。

| pin | 値 |
|---|---|
| Claude Code | `2.1.228 (Claude Code)` |
| Codex | `codex-cli 0.147.0` |
| OS | Linux WSL2 6.18.33.2-microsoft-standard-WSL2 |
| 取得日 | 2026-08-12 |
| evidenceKind | 全 cell `real-cli-e2e`（隔離 rig 下の実 CLI 実行） |

## capture cell 対照

| EventKind | Claude | Codex | 備考 |
|---|---|---|---|
| session_started | native | native | SessionStart |
| user_prompted | native | native | UserPromptSubmit |
| assistant_completed | synthesized | synthesized | 両者とも Stop.last_assistant_message から復元 |
| tool_started | native | native | PreToolUse |
| tool_completed | native | native | PostToolUse |
| tool_failed | synthesized | synthesized | **挙動が逆**: Claude は失敗時 PostToolUse を発火せず（2 回再現）、Codex は発火するが payload は `tool_response: ""` のみで成功と区別不能 |
| turn_completed | synthesized | **native** | Codex の Stop payload には `turn_id` があり turn 境界が native に取れる。Claude には無い |
| pre_compact / post_compact | unknown | unknown | 本 Phase では未観測（compact を発火させる長時間セッションが必要） |
| session_idle | unknown | unknown | 未観測 |
| session_interrupted | synthesized | unknown | Claude は「Stop 無しで SessionEnd」パターンで合成可能（SIGINT 実測）。Codex は未観測 |
| session_ended | native | native | 両者とも `reason` は正常終了でも `other` で、終了理由の判別には使えない |

## Tier について

**Tier A は宣言しない**（v6.1 §29 Phase 0B の明示要件 + HI-23）。未観測 cell は `unknown` のままであり、
本 matrix は「観測できたものだけを証跡付きで確定した」ものである。

高位 cell（`sessionStartInjection` / `promptAwareInjection` / `compactionRecoveryStrategy` /
`trueSessionEnd` / `subagentCapture` / `stableNativeSessionId`）は assembler が自動推定せず `unknown`
のままにしてある（判定は Phase 4 の vertical route 実装時に、実運用要件と突き合わせて行う）。ただし
注入については両 CLI とも **hook stdout の token を子セッションが逐語復唱する** ことを実測しており
（`fixtures/*/injection*.json`）、Phase 4 の判定材料は取得済み。

## 未観測を埋めるための追試（将来）

- pre_compact / post_compact: 長いセッションを実行して compact を誘発（子セッションの拡張思考は無効のまま）
- session_idle: idle 判定の発火条件を CLI 側ドキュメントで特定してから
- Codex の session_interrupted: SIGINT を送った際の hook 発火有無（Claude と同型の追試）
- tool failure phase の permission_denied / schema_invalid / unknown_tool: 権限拒否・不正 schema を意図的に起こす rig 拡張が必要
