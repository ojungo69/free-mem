# Agent Adapter Contract (M1)

Source of truth for payload shapes: `docs/research/oboete-contracts-2026-09-02.md` plus the
verification-gate probes (research R13) appended to `docs/research/`. Versions verified: Claude
Code 2.1.258, Codex CLI 0.152.1, Grok Build 1.0.17, Pi 0.84.4 (requires Node >= 22.19).

## Normalized events (zod discriminated union)

Envelope on every event: `event` (kind), `agent` (`claude|codex|grok|pi|unknown`, derived from the
environment, never from the payload), `native_session_id`, `conversation_id`, `cwd`, `captured_at`,
`delivery_ordinal`, optional `agent_id`, `agent_type` (subagents), optional `model`.

| kind | fields |
|---|---|
| session_start | `source` (`startup`, `resume`, `clear`, `compact`, `fork`, `new`) |
| prompt | `text`, `input_source` (`user`, `rpc`, `extension`) |
| tool_call | `tool_call_id`, `tool_name_native`, `tool_name`, `input` (whole, redacted) |
| tool_result | `tool_call_id`, `output` (whole, redacted), `is_error` |
| tool_failure | `tool_call_id`, `error` |
| turn_end | `turn_index`, `reason` |
| session_end | `reason` |
| compaction_summary | `text` |
| last_assistant_message | `text` |

Content is stored whole; the 12,000-character limit applies only when a batch input is built.
Normalized tool names: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `task`,
`mcp:<server>/<tool>`, `other`; until the R13 payload fixtures exist, adapters store
`tool_name_native` and the redacted JSON without field mapping.

## Capture and injection per agent

| Agent | Capture events | Injection channel and policy | Cap | Setup writes |
|---|---|---|---|---|
| Claude Code | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure → `tool_failure`, Stop → `last_assistant_message` (and `turn_end`), PostCompact → `compaction_summary`, SessionEnd (capture only, 1.5 s shared budget) | plain stdout on SessionStart when `source` is `startup`, `clear`, or `compact`; nothing on `resume` or `fork` (transcript replay); plain stdout on UserPromptSubmit | 10,000 characters per value | oboete-owned handlers (`"oboete": true`) merged into `~/.claude/settings.json`; timeouts 12 s on injection hooks, 3 s on capture hooks; `claude mcp add oboete -- "<node>" "<bundle>" mcp` |
| Codex CLI | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd (1 s default, capture only) | `hookSpecificOutput.additionalContext` on SessionStart with matcher `startup\|clear\|compact` (verified enum; `resume` excluded) and on UserPromptSubmit; `additionalContextLimit = 0` | provider context, no spill | `~/.codex/hooks.json` handlers; managed block in `~/.codex/config.toml` with `[hooks.state."<abs path>:<event>:<group>:<handler>"] trusted_hash = "sha256:<hex of canonical handler json>"` and `[mcp_servers.oboete]` |
| Grok Build | SessionStart (`source: "new"` when headless), UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop (`reason: end_turn` only), SessionEnd | FR-045 state machine below | 10,000 characters (silent clip) | `~/.grok/hooks/oboete.json` with explicit `timeout` per hook (12 s injection, 3 s capture); handlers deduplicated against the Claude compat layer; MCP registration per R13 probe, else CLI child |
| Pi | `session_start` (from `session_start`), `input` (source filter), `tool_result` (input + content + isError), `agent_settled` → `turn_end` + `last_assistant_message` when available, `session_shutdown`, compaction event (R13 probe) | `before_agent_start` returns the pack produced by a bounded child `oboete inject` (`AbortSignal.timeout`: 8 s at session start, 2 s per prompt); capture through a detached child `oboete capture`; handler exceptions and child timeouts are written to `~/.oboete/logs/pi.jsonl` | provider context | `~/.pi/agent/extensions/oboete.js` loader importing `piExtension` from the bundle; tools call `oboete search\|timeline\|get --json` as child processes |

### Grok Build deferred delivery (FR-045)

1. At SessionStart or UserPromptSubmit the pack is built and stored `pending` in `injections`.
2. On the first `PreToolUse` of the turn, the hook emits the pending pack as `additionalContext`
   and marks it `attempted`. Grok delivers it after the call runs; a `deny` by any handler drops
   it, so the record stays `attempted` until confirmed.
3. On `PostToolUse` of that call the hook marks the pack `emitted`. If `PostToolUse` fires without
   a prior `attempted` record (an earlier handler denied the `PreToolUse` chain before oboete ran),
   the hook emits the pack from `PostToolUse` and marks it `emitted`.
4. On `PostToolUseFailure` or when the next `PreToolUse` arrives while the record is still
   `attempted` (the previous call was denied), the pack is emitted again (the ledger dedupes by
   `pack_hash`; the model never sees two copies because a denied call delivers nothing).
5. At `Stop` (`end_turn`) a record still `pending` or `attempted` becomes `omitted` with reason
   `no_tool_call` or `all_denied`, visible in `why` and doctor.

Agent detection order in `oboete hook`: `GROK_HOOK_EVENT` / `GROK_SESSION_ID` → grok;
`CODEX_HOME` or Codex-shaped stdin (`transcript_path` present and the verified universal `model`
field) → codex; `PI_SESSION_ID` → pi; `CLAUDE_PROJECT_DIR` or Claude-shaped stdin → claude; else
`unknown` (stored, reported by doctor).

## Injection policy shared by all agents

Same repository only (FR-044); never the same memory twice in one conversation (FR-026); session
start = latest session summary + pinned memories, bounded to the channel cap, pinned trimmed in
pin order; prompt submit = memories above the threshold up to a character budget =
min(channel cap, `context_fraction` × context window), `context_fraction` default 0.05. The context
window comes from a per-agent table in `config.toml` seeded by setup with a conservative default
of 128,000 tokens per agent and refreshed when the agent reports a `model` whose documented window
setup can look up; the table is an assumption, not a verified contract. Tokens convert at 4
characters per token for English and 1.5 for CJK. Every pack builder runs the same staleness check
(paths via `fs.existsSync`; commits via the worker's `HEAD`-keyed cache) and records the outcome.
Retrieval reads memories only, from applied or fallback batches, so another session's unfinished
turn is never injected.

## Pack format (all agents)

```text
oboete memory context
Repository: <normalized identity>
Session summary (<agent>, <relative time>):
> <text, one line per paragraph>
Pinned: <title>
> <body>
Related: <title> [<path or commit>; <stale note>]
> <body>
Degraded: <reason>            (only when applicable)
end of oboete memory context
```

The first and last lines are labels, not instructions; every quoted body line is prefixed with
`> ` as data framing; the pack never starts with `{`; a test rejects packs that contain imperative
wrapper text produced by either summarizer.

## Hook process rules and SLAs

- Always exit `0`; never print anything but the pack to stdout; log to `~/.oboete/logs/hook.log`.
- Capture hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PostCompact`,
  `SessionEnd`, Pi capture child): 300 ms end to end, busy timeout 150 ms, spool on any failure.
- Injection hooks (`SessionStart`, `UserPromptSubmit`, Grok delivery hooks, Pi inject child):
  300 ms when the previous summary is ready; at session start, up to 8 s while it is pending, then
  the latest raw activity labelled `summary pending`.
- The detector (private strip, path rules, secretlint core + gated entropy) runs before the first
  write anywhere.
- The paused marker is checked before the database is opened.
