# Agent Adapter Contract (M1)

Source of truth for payload shapes: `docs/research/oboete-contracts-2026-09-02.md`. Versions
verified: Claude Code 2.1.258, Codex CLI 0.152.1, Grok Build 1.0.17, Pi 0.84.4.

## Normalized events (zod discriminated union)

Envelope on every event: `event` (kind), `agent` (`claude|codex|grok|pi|unknown`, derived from the
environment, never from the payload), `native_session_id`, `conversation_id`, `cwd`, `captured_at`,
optional `agent_id`, `agent_type` (subagents).

| kind | fields |
|---|---|
| session_start | `source` (`startup`, `resume`, `clear`, `compact`, `fork`, `new`) |
| prompt | `text`, `input_source` (`user`, `rpc`, `extension`) |
| tool_call | `tool_call_id`, `tool_name_native`, `tool_name`, `input` (bounded) |
| tool_result | `tool_call_id`, `output` (bounded), `is_error` |
| tool_failure | `tool_call_id`, `error` |
| turn_end | `turn_index`, `reason` |
| session_end | `reason` |
| compaction_summary | `text` |
| last_assistant_message | `text` |

Normalized tool names: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `task`, `mcp:<server>/<tool>`,
`other`. Mapping tables per agent live in `src/agents/*.ts`; the real payload shapes for `read`,
`write`, `edit`, `bash` on every agent are captured as fixtures under `test/contracts/<agent>/` in
the first implementation task.

## Capture and injection per agent

| Agent | Capture events | Injection channel | Cap | Timing | Setup writes |
|---|---|---|---|---|---|
| Claude Code | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop (`last_assistant_message`), PostCompact (`compact_summary`), SessionEnd (capture only, 1.5 s shared budget) | plain stdout on SessionStart (`startup`, `clear`, `compact` only) and UserPromptSubmit | 10,000 characters per value | before the turn | oboete-owned handlers merged into `~/.claude/settings.json`; SessionStart timeout 12 s; `claude mcp add oboete -- <abs node> <abs bundle> mcp` |
| Codex CLI | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd (1 s default, capture only) | `hookSpecificOutput.additionalContext` on SessionStart (matcher `startup`; compaction source probed) and UserPromptSubmit; `additionalContextLimit = 0` | provider context, no spill | before the turn | `~/.codex/hooks.json` handlers; `[hooks.state."<abs path>:<event>:<group>:<handler>"] trusted_hash = "sha256:<canonical json>"` appended to `~/.codex/config.toml`; `[mcp_servers.oboete]` |
| Grok Build | SessionStart (`source: "new"` when headless), UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop (`reason: end_turn` only; second Stop at session end ignored), SessionEnd | `additionalContext` from PostToolUse of the first successful tool call; PreToolUse records the attempt; a turn without a tool call gets nothing and `why` records `omitted: no_tool_call` | 10,000 characters (silent clip) | after the first tool result (FR-045) | `~/.grok/hooks/oboete.json` with explicit `timeout` per hook (12 s on injection hooks); handlers deduplicated against the Claude compat layer |
| Pi | `input` (source filter), `tool_result` (input + content + isError), `agent_settled`, `session_shutdown`, compaction event (probed) | `before_agent_start` returns the pack produced by a bounded child `oboete inject` (AbortSignal timeout 8 s at session start, 2 s per prompt) | provider context | before the turn | `~/.pi/agent/extensions/oboete.js` loader importing `piExtension` from the bundle; MCP not used, tools call `oboete search|timeline|get --json` as child processes |

Agent detection order in `oboete hook`: `GROK_HOOK_EVENT` / `GROK_SESSION_ID` → grok; Codex-shaped
stdin (`hook_event_name` plus `model` field set, or `CODEX_HOME`) → codex; `PI_SESSION_ID` → pi;
`CLAUDE_PROJECT_DIR` or Claude-shaped stdin → claude; else `unknown` (stored, reported by doctor).

Injection policy shared by all agents: same repository only (FR-044); never the same memory twice
in one conversation (FR-026); session start = latest session summary + pinned memories (bounded to
the channel cap, pinned trimmed in pin order); prompt submit = memories above the threshold up to a
character budget = min(channel cap, `context_fraction` × documented context window of the agent's
model); `context_fraction` default 0.05; documented context windows (recorded here, refreshed by
setup when the agent reports a model): Claude Code 200,000 tokens, Codex 200,000 tokens (model
dependent), Grok Build 131,072 tokens, Pi = the configured model's window; tokens are converted at
4 characters per token for English and 1.5 for CJK.

Pack format (all agents):

```text
oboete memory context (do not restate)
Repository: <normalized identity>
Session summary (<agent>, <relative time>): <text>
Pinned: <title> — <body>
Related: <title> — <body> [<path or commit>, <stale note>]
Degraded: <reason>            (only when applicable)
end of oboete memory context
```

Hook process rules: exit `0` always; never print anything but the pack to stdout; log to
`~/.oboete/logs/hook.log`; total budget 300 ms with busy timeout 150 ms; on any failure write the
event to the spool and exit `0`.
