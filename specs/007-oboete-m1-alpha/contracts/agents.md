# Agent Adapter Contract (M1)

Source of truth for payload shapes: `docs/research/oboete-contracts-2026-09-02.md` plus the
verification-gate probes (research R13) appended to `docs/research/`. Versions verified: Claude
Code 2.1.258, Codex CLI 0.152.1, Grok Build 1.0.17, Pi 0.84.4 (requires Node >= 22.19).

## Normalized events (zod discriminated union)

Envelope on every event: `event` (kind, from the handler's fixed `--event` argument written by
setup, cross-checked against the payload when one is parsed), `agent` (`claude|codex|grok|pi|unknown`,
from the fixed selector below, never from the payload), `native_session_id`, `conversation_id`,
`cwd`, `captured_at`, optional `agent_id`, `agent_type` (subagents), optional `model`.

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

Size cap (R4): the hook reads at most 1 MB from stdin and stops; a larger payload is handled as
a detector failure: no content is stored, one metadata-only row (`classification_state = failed`,
reason `oversized`, kind from the `--event` argument, session id from `GROK_SESSION_ID` /
`PI_SESSION_ID` or a bounded scan of the read bytes for the top-level `session_id`) is written,
and when no session id is recoverable only a diagnostics counter is incremented. Such rows are
never summarized or injected. Runner tolerance of unread stdin is an R13 probe (A7). The 12,000-character limit applies only when a
batch input is built. Normalized tool names: `read`, `write`, `edit`, `bash`, `grep`, `glob`,
`task`, `mcp:<server>/<tool>`, `other`; until the R13 payload fixtures exist, adapters store
`tool_name_native` and the redacted JSON without field mapping.

## Agent identity (fixed selectors)

Setup writes a distinct handler command per agent, so the adapter is chosen by the command line,
never by payload heuristics:

| agent | handler written by setup | resolution |
|---|---|---|
| Codex | `oboete hook --agent codex --event <name>` | fixed |
| Pi | `oboete capture --agent pi --event <name>`, `oboete inject --agent pi` | fixed |
| Claude Code, Grok Build | `oboete hook --agent claude-or-grok --event <name>` (Grok Build also reads Claude-compat hooks from `$HOME`) | `GROK_HOOK_EVENT` or `GROK_SESSION_ID` present → grok; else claude |

An invocation without `--agent` is stored as `unknown` and reported by doctor; payload shape is
used only to label it for diagnosis.

## Event identity and conversation identity

`raw_events.id` uses the most specific stable key available (R7), and every form includes the
event kind: tool events use (kind, `tool_call_id`), so a `tool_call` and its `tool_result` never
share an id; prompts use (kind, `prompt_id`) where the agent supplies one; everything else uses
(turn ordinal, kind, content hash). No per-delivery counter is used, so a re-delivered event
always collapses and the hook needs no database read to compute the id. Accepted limit: two
byte-identical events of the last form inside one turn collapse to one row; a repeated identical
prompt in a later turn does not.

`conversation_id` is the oboete id of the root session. Claude Code `resume` (same `session_id`),
Codex `resume`, Pi `resume` (when `PI_SESSION_ID` continues, R13 probe), and Grok Build resume
(the `SessionStart` source value and session id continuity are an R13 probe; until it passes a
Grok session whose native id already exists is treated as a resume of that root) keep the root;
`fork` and Grok `new` start a new root.

## Capture and injection per agent

| Agent | Capture events | Injection channel and policy | Cap | Setup writes |
|---|---|---|---|---|
| Claude Code | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure → `tool_failure`, Stop → `last_assistant_message` (and `turn_end`), PostCompact → `compaction_summary`, SessionEnd (capture only, 1.5 s shared budget) | plain stdout on SessionStart when `source` is `startup`, `clear`, or `compact`; nothing on `resume` or `fork` (transcript replay); plain stdout on UserPromptSubmit | 10,000 characters per value | oboete-owned handlers (`"oboete": true`) merged into `~/.claude/settings.json`; timeouts 12 s on injection hooks, 3 s on capture hooks; `claude mcp add oboete -- "<node>" "<bundle>" mcp` |
| Codex CLI | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd (1 s default, capture only) | `hookSpecificOutput.additionalContext` on SessionStart with matcher `startup\|clear\|compact` (verified enum; `resume` excluded) and on UserPromptSubmit; `additionalContextLimit = 0` | provider context, no spill | `~/.codex/hooks.json` handlers; managed block in `~/.codex/config.toml` with `[hooks.state."<abs path>:<event>:<group>:<handler>"] trusted_hash = "sha256:<hex of canonical handler json>"` and `[mcp_servers.oboete]` |
| Grok Build | SessionStart (`source: "new"` when headless; resume value per R13 probe), UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop (`reason: end_turn` only), SessionEnd | FR-045 state machine below | 10,000 characters (silent clip) | `~/.grok/hooks/oboete.json` with explicit `timeout` per hook (12 s injection, 3 s capture); handlers deduplicated against the Claude compat layer; MCP registration per R13 probe (blocked for FR-030 if the probe fails) |
| Pi | `session_start` (from `session_start`), `input` (source filter), `tool_result` (input + content + isError), `agent_settled` → `turn_end` + `last_assistant_message` when available, `session_shutdown` (reason `quit|reload|new|resume|fork`), compaction event (R13 probe) | `before_agent_start` returns the pack produced by a bounded child `oboete inject` (`AbortSignal.timeout`: 8 s at session start, 2 s per prompt); capture through a detached child `oboete capture --invocation <id>` that writes a two-phase acknowledgement (`<invocation>.started` before reading stdin → `.done`); the extension itself only try/catches, generates invocation ids, spawns, and counts failures in memory (message code only), handing the counters to the next child it spawns as `--prior-failures`; no in-process file or network write (FR-007; recording guarantee per amendment A8 and the R13 Pi error-surface probe) | provider context | `~/.pi/agent/extensions/oboete.js` loader importing `piExtension` from the bundle; tools call `oboete search\|timeline\|get --json` as child processes |

### Grok Build deferred delivery (FR-045)

Definitions: a pack is **planned** when it is built and its items are recorded `planned`; it is
**delivered** when the model has received it, and only then are its items `included` and its
memories counted for the conversation.

1. At SessionStart or UserPromptSubmit the pack is built and stored `pending`. If a `pending`
   record already exists for the conversation (no tool call happened since), the new pack merges
   into it: existing `planned` items stay, new items are added under the same budget, and the
   record gets a new `pack_hash`. One pending record per conversation at any time.
2. On `PreToolUse` the hook emits the pending pack as `additionalContext`, records
   `attempt_tool_call_id`, and marks it `attempted`. Grok delivers it with the results of the
   batch once the call has run (verified wording); a denied call never runs and delivers nothing.
3. On `PostToolUse` whose `tool_call_id` equals `attempt_tool_call_id` the hook marks the record
   `emitted`, its items `included`. On `PostToolUse` with a `pending` record and no attempt
   (oboete's own `PreToolUse` handler did not complete: timeout or crash) the hook emits the pack
   from `PostToolUse` and marks it `emitted` the same way.
4. On `PostToolUseFailure` for `attempt_tool_call_id` (the call ran and failed) the R13 probe
   decides: if the probe shows the context reaches the model with the failed result, this event
   confirms delivery like step 3; if it shows the context is dropped, the record returns to
   `pending`. On a `PreToolUse` that arrives while the record is still `attempted` (the previous
   call was denied and nothing was delivered) the record returns to `pending` and step 2 repeats
   on this call. The ledger dedupes by `pack_hash`; the model never sees two copies because a
   denied call delivers nothing.
5. At `Stop` (`end_turn`) a record still `pending` or `attempted` becomes `omitted` with reason
   `no_tool_call` when oboete observed no tool hook of any kind in the turn, otherwise
   `not_delivered` (a deny by an earlier handler stops the chain before oboete runs, so "all
   denied" is not distinguishable and is not claimed); its items become `omitted` /
   `not_delivered`, so the memories remain injectable in the next turn. Tests count the packs the
   model received in the success, execution-failure, oboete-deny, other-handler-deny, and no-tool
   cases.

## Injection policy shared by all agents

Same repository only (FR-044); never the same memory twice in one conversation (FR-026, counted
on delivery); the session-start pack is emitted at most once per conversation except after
compaction (FR-024's "not again on resume", enforced by the ledger on every agent); session start
= latest session summary + pinned memories, bounded to the channel cap, pinned trimmed in pin
order; prompt submit = memories above the threshold up to a character
budget = min(channel cap, `context_fraction` × context window), `context_fraction` default 0.05.
The context window is the documented window of the reported `model` from
`docs/research/context-windows.md` (R12, maintained under R13); when the model is unknown or
absent, the budget uses the smallest verified window for that agent and the pack carries
`Degraded: window_unknown`; when the table has no verified window for that agent at all, the
prompt-submit pack is omitted with reason `window_unknown` (session-start packs, bounded by the
channel cap, are still delivered). Tokens convert at 4 characters per token for English and 1.5 for CJK.
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
asserts that no corpus phrase reaches accepted observer output, a stored memory, or a pack from
either summarizer (the phrases legitimately exist in raw events and the spool).

## Hook process rules and SLAs

- Always exit `0`; never print anything but the pack to stdout; log to `~/.oboete/logs/hook.log`.
- Capture hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PostCompact`,
  `SessionEnd`, Pi capture child): 300 ms end to end, busy timeout 150 ms, spool on any storage
  failure; detector or config failure stores metadata only (`classification_state = failed`).
- Injection hooks (`SessionStart`, `UserPromptSubmit`, Grok delivery hooks, Pi inject child):
  300 ms when the previous summary is ready; at session start, up to 8 s while it is pending, then
  the latest raw activity labelled `summary pending`.
- The detector (stdin cap, private strip, path rules, secretlint core + gated entropy) runs before
  the first write anywhere, including the spool.
- The paused marker is checked before the database is opened.
