# Observer Contract (M1)

One JSON schema is produced by the LLM observer and by the rule-based fallback; the worker treats
both identically except for `degraded_reason`.

## Batch composition

After classification, a session batch is split by destination using `destination_rules`:

| destination | receives | when |
|---|---|---|
| `remote_observer` | `eligible` rows only | a remote preset is configured and consented |
| `local_observer` | `eligible`, `local_only`, `private` rows of the same repository | a local preset (Ollama) is configured |
| `fallback` | whatever the other destinations did not take | always available |

`secret` rows are never summarized. Each memory records the rows it came from in `memory_sources`
and takes the strictest sensitivity of those rows. Tests assert the outbound request body of a
mixed batch contains only eligible content, and that the resulting memories carry the right
sensitivity and sources.

## Input (worker → summarizer)

```json
{
  "repo": "<normalized identity>",
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
  "session_summary": {
    "request": "", "investigated": "", "learned": "", "completed": "", "next_steps": ""
  }
}
```

Worker rules after either path: the detector runs again on every title and body; sensitivity =
strictest source row; `content_hash` = sha256(repo_id, type, normalized title, normalized body);
`target` must be one of the supplied `nearby` ids from the same repository, otherwise the decision
is treated as `add`; a hash matching a tombstoned memory suppresses the insert and is recorded for
`why`; `update` sets `valid_to` and `superseded_by` on the target; `delete` tombstones the target
only with a non-empty `reason`; the session summary becomes one `session_summary` memory linked from
`sessions.latest_summary_memory_id`. The observer is instructed to answer in the dominant language
of the input (FR-014) and the worker checks the dominant script of the output against the input.

## Provider presets

| preset | package | endpoint | credential | cost class | structured output |
|---|---|---|---|---|---|
| `workers-ai` (default) | `workers-ai-provider` REST | `api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/zai-org/glm-4.7-flash` | `OBOETE_CF_API_TOKEN` + `OBOETE_CF_ACCOUNT_ID` | free tier, 10,000 neurons/day, ~45 neurons per call | JSON schema (verified live) |
| `ollama` | `@ai-sdk/openai-compatible` | `http://127.0.0.1:11434/v1` | none | local | `response_format` |
| `nim`, `openrouter`, `gemini` | `@ai-sdk/openai-compatible` | provider base URL | `OBOETE_PROVIDER_API_KEY` | remote, provider-billed | `response_format` where the R13 probe confirms it, else text-JSON |
| `anthropic` | `@ai-sdk/openai-compatible` | `https://api.anthropic.com/v1` | `OBOETE_PROVIDER_API_KEY` | remote, provider-billed | text-JSON only (`response_format` is ignored by the endpoint) |

Text-JSON path: the prompt asks for exactly one JSON object; the reply is parsed and validated with
the same zod schema; failure counts as `unusable_output`.

## Call policy

1. Reservation: in one short `BEGIN IMMEDIATE` transaction, check the daily cap (150 calls) and
   `exhausted_at`, increment `provider_usage.calls`, mark the batch `running` with the worker's
   `owner_token`; commit.
2. Network call outside any transaction with `maxRetries: 0` and `abortSignal:
   AbortSignal.timeout(60_000)`.
3. Classification of the result: HTTP 429 with body code 3036 → `provider_exhausted` (set
   `exhausted_at`, never retry today); 403 or body code 5035 → `provider_paid`; 408/3007 or
   429/3040 → one retry; `finish_reason: length`, null content, or invalid JSON → one retry then
   `unusable_output`; abort → `timeout`; a returned model id different from the requested id →
   `model_alias`; network error → `unreachable`.
4. Apply in a separate fenced transaction (`... WHERE owner_token = ?`); a fenced statement that
   changes zero rows means the lease was lost and the result is discarded.
5. Neurons: `cf-ai-neurons` header when exposed, otherwise tokens × (5,500 / 36,400 per million),
   stored as an estimate.

## Rule-based fallback

Deterministic, no network, language-neutral. Produces: one `change` observation per cluster of
files modified in a turn (title = file list, body = quoted tool inputs prefixed with `> `), one
`bugfix` or `discovery` per `tool_failure` followed by a successful retry of the same tool, one
`decision` per paragraph of `last_assistant_message` or `compaction_summary`, and `next_steps`
quoted from the last unfinished turn. No generated labels or sentences; only quoted source text,
file lists, and commit ids. Classification: exact `content_hash` match on a tombstoned row →
suppressed, on an active row → `noop`, otherwise `add`; the fallback never emits `update` or
`delete`. `degraded_reason` is set by the worker.
