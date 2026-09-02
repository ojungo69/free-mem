# Agent Adapter Contract (M1)

Source of truth for payload shapes: `docs/research/oboete-contracts-2026-09-02.md` plus the
verification-gate probes (research R13) appended to `docs/research/`. Versions verified: Claude
Code 2.1.258, Codex CLI 0.152.1, Grok Build 1.0.17, Pi 0.84.4 (requires Node >= 22.19).

## Normalized events (zod discriminated union)

Envelope on every event: `event` (kind), `agent` (`claude|codex|grok|pi|unknown`, from the fixed
selector below, never from the payload), `native_session_id`, `conversation_id`, `cwd`,
`captured_at`, `delivery_ordinal`, optional `agent_id`, `agent_type` (subagents), optional `model`.

| kind | fields |
|---|---|
| session_start | `source` (`startup`, `resume`, `clear`, `compact`, `fork`, `new`) |
| prompt | `text`, `input_source` (`user`, `rpc`, `extension`), optional `prompt_id` |
| tool_call | `tool_call_id`, `tool_name_native`, `tool_name`, `input` (redacted, size-capped) |
| tool_result | `tool_call_id`, `output` (redacted, size-capped), `is_error` |
| tool_failure | `tool_call_id`, `error` |
| turn_end | `turn_index`, `reason` |
| session_end | `reason` |
| compaction_summary | `text` |
| last_assistant_message | `text` |

Size cap (R4): any single text field is read up to 1 MB; beyond that the hook stores a redacted
head (64 KB) and tail (16 KB) with `truncated_bytes`. The 12,000-character limit applies only when a
batch input is built. Normalized tool names: `read`, `write`, `edit`, `bash`, `grep`, `glob`,
`task`, `mcp:<server>/<tool>`, `other`; until the R13 payload fixtures exist, adapters store
`tool_name_native` and the redacted JSON without field mapping.

## Agent identity (fixed selectors)

Setup writes a distinct handler command per agent, so the adapter is chosen by the command line,
never by payload heuristics:

| agent | handler written by setup | resolution |
|---|---|---|
| Codex | `oboete hook --agent codex` | fixed |
| Pi | `oboete capture --agent pi`, `oboete inject --agent pi` | fixed |
| Claude Code, Grok Build | `oboete hook --agent claude-or-grok` (Grok Build also reads Claude-compat hooks from `$HOME`) | `GROK_HOOK_EVENT` or `GROK_SESSION_ID` present → grok; else claude |

An invocation without `--agent` is stored as `unknown` and reported by doctor; payload shape is
used only to label it for diagnosis.

## Event identity and conversation identity

`raw_events.id` uses the most specific stable key available (R7): tool events use
`tool_call_id`; prompts use `prompt_id` where the agent supplies one; everything else uses
(turn ordinal, kind, content hash, `delivery_ordinal`), where `delivery_ordinal` is a counter oboete
keeps per native session in `runtime_state`. Limit: an identical event delivered twice inside the
same turn with the last key form collapses to one row; a repeated identical prompt in a later turn
does not.

`conversation_id` is the oboete id of the root session. Claude Code `resume` (same `session_id`)
and Codex `resume` keep the root; `fork`, Grok `new`, and every Pi session start a new root.

## Capture and injection per agent

| Agent | Capture events | Injection channel and policy | Cap | Setup writes |
|---|---|---|---|---|
| Claude Code | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure → `tool_failure`, Stop → `last_assistant_message` (and `turn_end`), PostCompact → `compaction_summary`, SessionEnd (capture only, 1.5 s shared budget) | plain stdout on SessionStart when `source` is `startup`, `clear`, or `compact`; nothing on `resume` or `fork` (transcript replay); plain stdout on UserPromptSubmit | 10,000 characters per value | oboete-owned handlers (`"oboete": true`) merged into `~/.claude/settings.json`; timeouts 12 s on injection hooks, 3 s on capture hooks; `claude mcp add oboete -- "<node>" "<bundle>" mcp` |
| Codex CLI | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd (1 s default, capture only) | `hookSpecificOutput.additionalContext` on SessionStart with matcher `startup\|clear\|compact` (verified enum; `resume` excluded) and on UserPromptSubmit; `additionalContextLimit = 0` | provider context, no spill | `~/.codex/hooks.json` handlers; managed block in `~/.codex/config.toml` with `[hooks.state."<abs path>:<event>:<group>:<handler>"] trusted_hash = "sha256:<hex of canonical handler json>"` and `[mcp_servers.oboete]` |
| Grok Build | SessionStart (`source: "new"` when headless), UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop (`reason: end_turn` only), SessionEnd | FR-045 state machine below | 10,000 characters (silent clip) | `~/.grok/hooks/oboete.json` with explicit `timeout` per hook (12 s injection, 3 s capture); handlers deduplicated against the Claude compat layer; MCP registration per R13 probe (blocked for FR-030 if the probe fails) |
| Pi | `session_start` (from `session_start`), `input` (source filter), `tool_result` (input + content + isError), `agent_settled` → `turn_end` + `last_assistant_message` when available, `session_shutdown`, compaction event (R13 probe) | `before_agent_start` returns the pack produced by a bounded child `oboete inject` (`AbortSignal.timeout`: 8 s at session start, 2 s per prompt); capture through a detached child `oboete capture` that writes an acknowledgement file; the extension itself only try/catches, spawns, and writes one stderr line | provider context | `~/.pi/agent/extensions/oboete.js` loader importing `piExtension` from the bundle; tools call `oboete search\|timeline\|get --json` as child processes |

### Grok Build deferred delivery (FR-045)

Definitions: a pack is **planned** when it is built and its items are recorded `planned`; it is
**delivered** when the model has received it, and only then are its items `included` and its
memories counted for the conversation.

1. At SessionStart or UserPromptSubmit the pack is built and stored `pending`. If a `pending`
   record already exists for the conversation (no tool call happened since), the new pack merges
   into it: existing `planned` items stay, new items are added under the same budget, and the
   record gets a new `pack_hash`. One pending record per conversation at any time.
2. On `PreToolUse` the hook emits the pending pack as `additionalContext`, records
   `attempt_tool_call_id`, and marks it `attempted`. Grok delivers it only after the call runs.
3. On `PostToolUse` whose `tool_call_id` equals `attempt_tool_call_id` the hook marks the record
   `emitted`, its items `included`. On `PostToolUse` without a matching attempt (an earlier handler
   denied the `PreToolUse` chain before oboete ran) the hook emits the pack from `PostToolUse` and
   marks it `emitted` the same way.
4. On `PostToolUseFailure` for `attempt_tool_call_id`, or on a `PreToolUse` that arrives while the
   record is still `attempted` (the previous call was denied and nothing was delivered), the
   record returns to `pending` and step 2 repeats on this call. The ledger dedupes by `pack_hash`;
   the model never sees two copies because a denied or failed call delivers nothing.
5. At `Stop` (`end_turn`) a record still `pending` or `attempted` becomes `omitted` with reason
   `no_tool_call` or `all_denied`; its items become `omitted` / `not_delivered`, so the memories
   remain injectable in the next turn. Tests count the packs the model received in the success,
   execution-failure, deny, all-denied, and no-tool cases.

## Injection policy shared by all agents

Same repository only (FR-044); never the same memory twice in one conversation (FR-026, counted
on delivery); session start = latest session summary + pinned memories, bounded to the channel
cap, pinned trimmed in pin order; prompt submit = memories above the threshold up to a character
budget = min(channel cap, `context_fraction` × context window), `context_fraction` default 0.05.
The context window is the documented window of the reported `model` from
`docs/research/context-windows.md` (R12, maintained under R13); when the model is unknown or
absent, the budget uses the smallest verified window for that agent and the pack carries
`Degraded: window_unknown`. Tokens convert at 4 characters per token for English and 1.5 for CJK.
Every pack builder runs the same staleness check (paths via `fs.existsSync`; commits via the
worker's `HEAD`-keyed cache) and records the outcome. Retrieval reads memories only, from applied
or fallback batches, never `secret` rows or rows with `classification_state = failed`, so another
session's unfinished turn and verbatim tool output are never injected.

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
`> ` as data framing; the pack never starts with `{`; bodies are summarizer output or fallback
records, never verbatim tool output; a directive-corpus test (`test/corpus/directives.jsonl`)
asserts that no corpus phrase reaches a pack from either summarizer.

## Hook process rules and SLAs

- Always exit `0`; never print anything but the pack to stdout; log to `~/.oboete/logs/hook.log`.
- Capture hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PostCompact`,
  `SessionEnd`, Pi capture child): 300 ms end to end, busy timeout 150 ms, spool on any storage
  failure; detector or config failure stores metadata only (`classification_state = failed`).
- Injection hooks (`SessionStart`, `UserPromptSubmit`, Grok delivery hooks, Pi inject child):
  300 ms when the previous summary is ready; at session start, up to 8 s while it is pending, then
  the latest raw activity labelled `summary pending`.
- The detector (size cap, private strip, path rules, secretlint core + gated entropy) runs before
  the first write anywhere, including the spool.
- The paused marker is checked before the database is opened.
