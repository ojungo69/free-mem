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
| turn_completed | synthesized | **native** | Codex の Stop payload には `turn_id` がある。**Claude も turn 対応付け自体は可能**（UserPromptSubmit / Stop / SessionEnd が同一 `prompt_id` を共有。生 capture で確認）。差は id の名称と、Codex の SessionEnd には turn_id が無い点。[2026-08-12 訂正: 初版の「Claude には無い」は誤り] |
| pre_compact / post_compact | unknown | unknown | 本 Phase では未観測（compact を発火させる長時間セッションが必要） |
| session_idle | unknown | unknown | 未観測 |
| session_interrupted | synthesized | unknown | Claude は「Stop 無しで SessionEnd」パターンで合成可能（SIGINT 実測）。Codex は未観測 |
| session_ended | native | native | 両者とも `reason` は正常終了でも `other` で、終了理由の判別には使えない |

## Tier について

**Tier A は宣言しない**（v6.1 §29 Phase 0B の明示要件 + HI-23）。未観測 cell は `unknown` のままであり、
本 matrix は「観測できたものだけを証跡付きで確定した」ものである。

高位 cell は fixture が `highLevel` で観測結果を明記したものだけを反映する（推定はしない）。実測で
確定したのは Claude の `sessionStartInjection` / `subagentCapture` / `stableNativeSessionId`（= native）
と Codex の `sessionStartInjection`（= native）で、残りは `unknown` のまま。`compactionRecoveryStrategy`
は §7.2 の union に "unknown" が無いため **null**（未計測）とし、`unsupported` とは書かない — 未計測を
否定的事実として断定しないため。

未観測 cell は `evidenceKind: null` / `verifiedAt: null` を持つ。観測していない cell に証跡種別と
検証時刻を書くと provenance の捏造になるため、埋めない（初版は組立時刻を書いていた。2026-08-12 訂正）。

`toolFailurePhases` は観測できた phase、`toolFailurePhasesUntested` は試していない phase。前者だけを
見て「非対応」と読まないための対。fixture 単位の caveat は `fixtureLimitations` に全件保持する。

## 未観測を埋めるための追試（将来）

- pre_compact / post_compact: 長いセッションを実行して compact を誘発（子セッションの拡張思考は無効のまま）
- session_idle: idle 判定の発火条件を CLI 側ドキュメントで特定してから
- Codex の session_interrupted: SIGINT を送った際の hook 発火有無（Claude と同型の追試）
- tool failure phase の permission_denied / schema_invalid / unknown_tool: 権限拒否・不正 schema を意図的に起こす rig 拡張が必要
