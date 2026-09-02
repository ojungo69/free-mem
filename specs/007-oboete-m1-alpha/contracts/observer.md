# Observer Contract (M1)

One JSON schema is produced by the LLM observer and by the rule-based fallback; the worker treats
both identically except for `degraded_reason`.

## Batch composition and the outbound boundary

After classification, a session batch is split by destination; batch identity is
(session, through event, destination, purpose). Purpose `observations` produces memories; purpose
`session_summary` is one extra batch per session end over all non-secret rows, run by the local
path only (local observer if configured, else the fallback):

| destination | receives | when |
|---|---|---|
| `remote_observer` | `eligible` rows only | a remote preset is configured and consented |
| `local_observer` | `eligible`, `local_only`, `private` rows of the same repository | a local preset (Ollama) is configured |
| `fallback` | rows no other destination took | always |

`secret` rows are never summarized. **One request builder** (`observer/request.ts`,
security-owned) assembles every outbound request and applies `destination_rules` to every field:
`events`, `free_summaries`, `nearby` (a remote request contains only `eligible` memories),
`citations`, and repository metadata (a remote request carries an opaque `repo_ref` = the repository
id, never the normalized remote or path). Tests assert the actual request body of a mixed batch.

An `observations` batch ignores any `session_summary` field in the output and a `session_summary`
batch ignores `observations`, so the shared schema below serves both purposes without double
generation. Each memory records its source rows in `memory_sources` and takes the strictest sensitivity of
those rows.

## Input (worker → summarizer)

```json
{
  "repo_ref": "<repository id>",
  "session": { "agent": "claude", "started_at": 0, "turns": [ ... ] },
  "events": [ { "kind": "prompt", "text": "..." }, { "kind": "tool_call", "tool_name": "edit", "input": { ... } } ],
  "free_summaries": { "last_assistant_message": "...", "compaction_summary": "..." },
  "nearby": [ { "id": "m1", "type": "decision", "title": "...", "body": "...", "deleted": false } ],
  "language_hint": "ja"
}
```

Total input is excerpted to 12,000 characters (FR-015): free summaries first, then prompts, then
tool inputs and outputs by recency; `observation_batches.excerpted` records it.

## Output (both paths)

```json
{
  "observations": [
    {
      "type": "bugfix | feature | refactor | change | discovery | decision | security_alert | security_note",
      "title": "<= 120 chars, language of the content",
      "body": "<= 2000 chars",
      "concepts": ["how-it-works", "why-it-exists", "what-changed", "problem-solution", "gotcha", "pattern", "trade-off"],
      "citations": { "files_read": [], "files_modified": [], "commits": [] },
      "classification": { "decision": "add | update | delete | noop", "target": "<nearby id or null>", "reason": "<short reason>" }
    }
  ],
  "session_summary": { "request": "", "investigated": "", "learned": "", "completed": "", "next_steps": "" }
}
```

`observations` is read only for purpose `observations`; `session_summary` only for purpose
`session_summary`. The request carries `"purpose"` so the prompt asks for one or the other.

Worker rules after either path: the detector runs again on every title and body; the
directive-corpus check rejects bodies that read as instructions; sensitivity = strictest source
row; `material_hash` and `content_hash` come from the shared identity helper (`material_hash` =
sha256(type, normalized title, normalized body), `content_hash` = sha256(repo_id, material_hash);
the same function serves import and tombstones); `target` must be
one of the supplied `nearby` ids from the same repository, otherwise the decision is `add`; a hash
matching a tombstoned memory suppresses the insert and is recorded for `why`; `update` sets
`valid_to` and `superseded_by`; `delete` tombstones the target only with a non-empty `reason`; the
observer answers in the dominant language of the input (FR-014) and the worker compares the
dominant script of the output with the input.

## Provider presets

| preset | package | endpoint | credential | cost class | structured output |
|---|---|---|---|---|---|
| `workers-ai` (default) | `workers-ai-provider` REST | `.../accounts/<id>/ai/run/@cf/zai-org/glm-4.7-flash` | `OBOETE_CF_API_TOKEN` + `OBOETE_CF_ACCOUNT_ID` | free tier, ~45 neurons per call | JSON schema (verified live) |
| `ollama` | `@ai-sdk/openai-compatible` | `http://127.0.0.1:11434/v1` | none | local | `response_format` |
| `nim`, `openrouter`, `gemini` | `@ai-sdk/openai-compatible` | provider base URL | `OBOETE_PROVIDER_API_KEY` | remote | `response_format` where the R13 probe confirms it, else text-JSON |
| `anthropic` | `@ai-sdk/openai-compatible` | `https://api.anthropic.com/v1` (R13 verifies path, model ids, auth header) | `OBOETE_PROVIDER_API_KEY` | remote | text-JSON only |

Text-JSON path: the prompt asks for exactly one JSON object; the reply is parsed and validated with
the same zod schema; failure counts as `unusable_output`.

## Call policy

1. **Per attempt**: in one short `BEGIN IMMEDIATE` transaction, check the daily cap (FR-012: 150
   HTTP attempts per UTC day summed over all presets; attempt 150 allowed, 151 refused) and the
   preset's `exhausted_at`; if either blocks, mark the batch degraded
   (`daily_cap` or `provider_exhausted`) and route it to the fallback; otherwise increment
   `provider_usage.calls` and `observation_batches.provider_attempts`, record a reservation id,
   set the batch `running`; commit. A retry is a new attempt and a new reservation.
2. Network call outside any transaction, `maxRetries: 0`, `abortSignal: AbortSignal.timeout(60_000)`.
3. Classify: 429 + body code 3036 → `provider_exhausted`; 403 or 5035 → `provider_paid`; 408/3007
   or 429/3040 → one retry; `length`, null content, invalid JSON → one retry then `unusable_output`;
   abort → `timeout`; returned model id mismatch → `model_alias`; network error → `unreachable`.
4. **Exhaustion persistence**: a 3036 result writes `provider_usage.exhausted_at` (idempotent,
   monotonic, keyed by the reservation id) in its own transaction that is **not** fenced by the
   lease, so the signal survives a lost lease.
5. Apply results in a separate transaction fenced by `owner_token`; zero rows changed means the
   lease was lost and the result is discarded (the exhaustion signal from step 4 is not).
6. Neurons: `cf-ai-neurons` header when exposed, else tokens × (5,500 / 36,400 per million).

## Rule-based fallback

Deterministic, no network, language-neutral, emits records rather than prose: one `change`
observation per cluster of files modified in a turn (title = file list; body = tool names, file
paths, line counts), one `bugfix` or `discovery` per `tool_failure` followed by a successful retry
of the same tool (body = tool name, first error line truncated to 200 characters, retried command
name), one `decision` per `last_assistant_message` or `compaction_summary` (body = the first
sentence, truncated to 200 characters, prefixed by the agent name), and `next_steps` = the last
unfinished turn's prompt truncated to 200 characters. Verbatim tool output is never placed in a
body. Classification: exact `content_hash` match on a tombstoned row → suppressed, on an active
row → `noop`, otherwise `add`; the fallback never emits `update` or `delete`. `degraded_reason` is
set by the worker.
