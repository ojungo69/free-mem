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

Size cap (R4, A7): the hook reads at most 1 MB from stdin and stops; the part that was read goes
through the detector and is stored as a `partial` row (`classification_state = partial`,
`truncated = 1`, kind from the `--event` argument, session id and tool paths from a bounded scan
of the read bytes for the top-level `session_id` and path fields; when no session id is
recoverable only a diagnostics counter is incremented). Partial rows stay `local_only` for life,
contribute only metadata (tool name, paths) to the rule-based summarizer, never enter a provider
request, and are never injected; the viewer shows them marked truncated. Runner tolerance of
unread stdin is an R13 probe. The 12,000-character limit applies only when a
batch input is built. Normalized tool names: `read`, `write`, `edit`, `bash`, `grep`, `glob`,
`task`, `mcp:<server>/<tool>`, `other`; an agent/tool whose payload fixture (R13) does not exist
yet is stored metadata-only (`classification_state = failed`, reason `unmapped_payload`), never
as an unmapped payload. Grok `Stop` maps its verified `lastAssistantMessage` field to
`last_assistant_message`; Codex and Grok `PostCompact` map the field the R13 probe identifies.

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
Codex `resume`, Pi `resume` (`PI_SESSION_ID` continues and `session_start.reason` stays `startup`,
so resume is detected by id continuity, R13 probe 2026-09-03), and Grok Build resume
(`SessionStart.source = "load"`, same `sessionId`, `transcriptPath` present; `--fork-session` gives a
new id with `source = "load"`, R13 probe 2026-09-03) keep the root; `fork` and Grok `new` start a
new root. Codex `/new` fires `SessionEnd` and no `SessionStart` (A18): the new root is detected by
the session id changing on the next hook.

## Capture and injection per agent

| Agent | Capture events | Injection channel and policy | Cap | Setup writes |
|---|---|---|---|---|
| Claude Code | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure → `tool_failure`, Stop → `last_assistant_message` (and `turn_end`), PostCompact → `compaction_summary`, SessionEnd (capture only, 1.5 s shared budget) | plain stdout on SessionStart when `source` is `startup`, `clear`, or `compact`; nothing on `resume` or `fork` (transcript replay); plain stdout on UserPromptSubmit | 10,000 characters per value | oboete-owned handlers (`"oboete": true`) merged into `~/.claude/settings.json`; timeouts 12 s on injection hooks, 3 s on capture hooks; `claude mcp add oboete -- "<node>" "<bundle>" mcp` |
| Codex CLI | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PostCompact (no summary field: keys `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `trigger`; `compaction_summary` absent by contract, R13 probe 2026-09-03), SessionEnd (1 s default, capture only) | `hookSpecificOutput.additionalContext` on SessionStart with matcher `startup\|clear\|compact` (verified enum; `resume` excluded; `clear` never observed on `/new`, A18) and on UserPromptSubmit; `additionalContextLimit = 0` | provider context, no spill | `~/.codex/hooks.json` handlers; managed block in `~/.codex/config.toml` with `[hooks.state."<abs path>:<event>:<group>:<handler>"] trusted_hash = "sha256:<hex of canonical handler json>"` and `[mcp_servers.oboete]` |
| Grok Build | SessionStart (`source: "new"` when headless, `"load"` on resume and fork), UserPromptSubmit, PreToolUse, PostToolUse (a failed shell call arrives here with `exit_code`, not as PostToolUseFailure), PostToolUseFailure, PermissionDenied (fires only for a permission-rule deny, never for a hook deny; keys `hookEventName`, `sessionId`, `cwd`, `workspaceRoot`, `timestamp`, `transcriptPath`, `permissionMode`, `toolName`, `toolUseId`, `toolInput`, `toolInputTruncated`; no reason field), Stop (`reason: end_turn` only) → `last_assistant_message` from the verified `lastAssistantMessage` field, PostCompact (no summary field; `timestamp` is the per-compaction key; `compaction_summary` absent by contract, R13 probe 2026-09-03), SessionEnd | FR-045 state machine below | 10,000 characters (silent clip) | `~/.grok/hooks/oboete.json` with explicit `timeout` per hook (12 s injection, 3 s capture); handlers deduplicated against the Claude compat layer; MCP registration verified 2026-09-03 (`[mcp_servers.oboete]` in `~/.grok/config.toml` or `grok mcp add --scope user`; the tool name seen by hooks is `oboete__<tool>`) |
| Pi | `session_start` (from `session_start`), `input` (source filter), `tool_result` (input + content + isError), `agent_settled` → `turn_end` + `last_assistant_message` when available, `session_shutdown` (reason `quit|reload|new|resume|fork`), `session_compact` (`compactionEntry.id` is the per-compaction key; `session_before_compact` precedes it; R13 probe 2026-09-03) | `before_agent_start` returns the pack produced by a bounded child `oboete inject` (`AbortSignal.timeout`: 1.3 s at session start while a summary is pending, 300 ms otherwise); capture through a detached child `oboete capture --invocation <id>` that writes a two-phase acknowledgement (`<invocation>.started` before reading stdin → `.done`); the extension itself only try/catches, generates invocation ids, spawns, and counts failures in memory (message code only), handing the counters to the next child it spawns as `--prior-failures`; no in-process file or network write (FR-007; recording guarantee per amendment A8 and the R13 Pi error-surface probe) | provider context | `~/.pi/agent/extensions/oboete.js` loader importing `piExtension` from the bundle; tools call `oboete search\|timeline\|get --json` as child processes |

### Grok Build deferred delivery (FR-045)

Definitions: a pack is **planned** when it is built and its items are recorded `planned`; it is
**delivered** when the model has received it, and only then are its items `included` and its
memories counted for the conversation.

1. At SessionStart or UserPromptSubmit the pack is built and stored `pending`. If a `pending`
   record already exists for the conversation (no tool call happened since), the new pack merges
   into it: existing `planned` items stay, new items are added under the same budget, and the
   record gets a new `pack_hash`. One pending record per conversation at any time.
2. On every `PreToolUse` of the turn while the record is not yet `emitted`, the hook emits the
   pending pack as `additionalContext` and appends `{ tool_call_id, execution: pending,
   delivery: pending, at }` to `injections.attempts_json`. Grok delivers it with the results of
   the batch once the call has run (verified wording); a denied call never runs and delivers nothing. Attaching on
   every call until confirmation is what makes "the first call that actually runs" (FR-045) hold
   whatever the order of denies and executions inside a parallel batch; the price is that two
   calls of one parallel batch may both carry the pack. Whether Grok delivers `additionalContext`
   once per batch or once per call is the R13 probe: once per batch → no duplication exists and
   nothing more is needed; once per call → the Grok lane is **blocked** until the owner decides
   A15 (accept per-call duplication inside one parallel batch, with its effect on FR-026, User
   Story 1 scenario 2, SC-010, FR-028, and Principle IV's injection volume stated in the
   amendment) or removes parallel-batch delivery from M1. In either case every attempt's `execution` and
   `delivery` fields are persisted in `injections.attempts_json` (vocabulary and update rules in
   `data-model.md`) so `why` reports actual deliveries per attempt after the raw events have
   expired, and the E2E counts them.
3. On `PostToolUse` for any attempted `tool_call_id` that attempt becomes `execution = ran`,
   `delivery = delivered` (and on `PostToolUseFailure`, `execution = failed` with delivery
   `delivered` if the R13 probe shows the context survives a failed call); the first `delivered`
   attempt makes the record `emitted` and its items `included`. On `PostToolUse` with a `pending` record and no attempted id (oboete's own
   `PreToolUse` handler did not complete: timeout or crash) the hook emits the pack from
   `PostToolUse` and marks it `emitted` the same way.
4. A denied call produces no `PostToolUse`, and the next `PreToolUse` attaches the pack again
   (step 2). `PermissionDenied` (payload per R13 probe) marks that attempt `execution = denied`,
   `delivery = dropped`; `PostToolUseFailure` marks it `failed` with delivery `delivered` or
   `dropped` per the probe; `Stop` marks every pending attempt `dropped`. Execution and delivery
   are separate fields of `injections.attempts_json`.
5. At `Stop` (`end_turn`) a record still `pending` or `attempted` becomes `omitted` with reason
   `no_tool_call` when oboete observed no tool hook of any kind in the turn, otherwise
   `not_delivered` (a deny by an earlier handler stops the chain before oboete runs, so "all
   denied" is not distinguishable and is not claimed); its items become `omitted` /
   `not_delivered`, so the memories remain injectable in the next turn. Tests count the packs the
   model received in the success, execution-failure, oboete-deny, other-handler-deny, parallel
   batch, and no-tool cases.

## Injection policy shared by all agents

Same repository only (FR-044); never the same memory twice in one conversation (FR-026, counted
on delivery); the session-start pack is emitted at most once per context epoch (an epoch starts at the root
session and advances once per compaction, A12; the authoritative compaction event is one per
agent: `PostCompact` on Claude Code (carries `compact_summary`), Codex, and Grok Build, and the
`session_compact` event on Pi; the companion `SessionStart source = compact`
never advances the epoch and only reads it, except on Claude Code (A16, 2026-09-03), where that hook
runs about 24 ms before `PostCompact` and therefore opens the epoch itself, `PostCompact` only
confirming it. The epoch key is the native per-compaction value where the R13 probe found one
(Grok Build `PostCompact.timestamp`, Pi `compactionEntry.id`) and the `PostCompact` event id on
Claude Code and Codex (A16 default: byte-identical same-turn compactions collapse)), which gives FR-024's "not again on resume" and its
re-injection after compaction on every agent; session start
= latest session summary + pinned memories, bounded to the channel cap, pinned trimmed in pin
order; prompt submit = memories above the threshold up to a character
budget = min(channel cap, `context_fraction` × context window), `context_fraction` default 0.05.
The context window is the documented window of the reported `model` from
`docs/research/context-windows.md` (R12, maintained under R13); when the model is unknown or
absent, the budget uses the smallest verified window for that agent and the pack carries
`Degraded: window_unknown`; an agent with no verified window at all is blocked by the R13 gate
(no injection lane ships for it until a window is verified or the owner decides). Tokens convert at 4 characters per token for English and 1.5 for CJK.
Every pack builder runs the same staleness check (paths via `fs.existsSync`; commits via the
worker's `HEAD`-keyed cache) and records the outcome. Retrieval reads memories only, from applied
or fallback batches, never `secret` rows or rows with `classification_state = failed`, so another
session's unfinished turn and verbatim tool output are never injected.

## Pack format (all agents)

```text
oboete memory context
> repository: <normalized identity, userinfo removed>
> session summary (<relative time>):
> <text, one line per paragraph>
> pinned: <title>
> <body>
> related: <title> [<path or commit>; <stale note>]
> <body>
> degraded: <plain-language sentence>   (only when applicable)
end of oboete memory context
```

The first and last lines are the only unprefixed lines and are labels, not instructions; every
other line, including repository identity, titles, citations, and bodies, is prefixed with `> `
as data framing, and every external string is canonicalized to a single line first (newlines and
control characters removed), so no title, path, or remote can produce an unprefixed line. The
pack never starts with `{`; bodies are summarizer output or fallback records, never verbatim tool
output; the producing agent is not named in the pack. The `degraded:` line is a plain-language sentence mapped from the reason code (for example
`daily_cap` → "Today's free summary quota is used up, so these are rule-based notes."); the code
itself stays in the ledger, `why`, and doctor. The finished pack is validated as a whole
(secret detector, directive corpus, control characters) before it is emitted; a directive-corpus
test (`test/corpus/directives.jsonl`) plus malicious title, path, and remote-URL cases assert
that nothing escapes the framing (the directive phrases legitimately exist in raw events and the
spool).

## Hook process rules and SLAs

- Always exit `0`; never print anything but the pack to stdout; log to `~/.oboete/logs/hook.log`.
- Every hook has an absolute deadline measured from process start. Capture hooks (`PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `Stop`, `PostCompact`, `SessionEnd`, Pi capture child):
  300 ms. The budget is allocated in order: a spool reserve of 40 ms is held back
  first; the detector runs in a `worker_threads` Worker that the main thread terminates at a
  hard cutoff (deadline minus the spool reserve minus a 20 ms row-build margin); a terminated
  detector yields a metadata-only row (`classification_state = failed`, reason `deadline`),
  never unsanitized content. The database busy timeout is min(150 ms, remaining budget minus the
  spool reserve); when the remaining budget after the detector is below the reserve the database
  is not opened and the sanitized event goes straight to the spool; a storage failure after the
  detector → spool. A wall-time test combines a slow detector with a busy database. The full detector
  must finish a 1 MB payload inside the cutoff on Node 22.16 (R13 probe); if it cannot, no
  smaller bound is introduced silently: the capture lane is blocked and the measured bound goes
  to the owner as A14. Tests assert process wall time per event kind (worst-case 1 MB input and a
  detector that never returns) and 100% in-deadline exits under every fault; the replay p99 is an
  additional SC-002 measurement, not the guarantee.
- Injection hooks (`SessionStart`, `UserPromptSubmit`, Grok delivery hooks, Pi inject child):
  300 ms when the previous summary is ready; at session start only, up to 1 s while it is
  pending, then the latest raw activity labelled `summary pending`.
- The detector (stdin cap, private strip, path rules, secretlint core + gated entropy) runs before
  the first write anywhere, including the spool.
- The paused marker is checked before the database is opened.
