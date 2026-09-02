# Observer Contract (M1)

One JSON schema is produced by the LLM observer and by the rule-based fallback; the worker treats
both identically except for `degraded_reason`.

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
tool inputs and outputs by recency; excerpting is recorded on the batch.

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
      "classification": { "decision": "add | update | delete | noop", "target": "<nearby id or null>" }
    }
  ],
  "session_summary": {
    "request": "", "investigated": "", "learned": "", "completed": "", "next_steps": ""
  }
}
```

Rules applied by the worker after either path: redaction and classification run again on every
title and body; sensitivity = strictest input row of the batch; `content_hash` = sha256(repo_id,
type, normalized title, normalized body); a hash that matches a tombstoned memory suppresses the
insert and is recorded for `why`; `update` sets `valid_to` and `superseded_by` on the target;
`delete` tombstones the target only when the target's source session is the same repository and the
provider gave a reason; the session summary becomes one `session_summary` memory linked from
`sessions.latest_summary_memory_id`.

## Provider presets

| preset | package | endpoint | credential | cost class | structured output |
|---|---|---|---|---|---|
| `workers-ai` (default) | `workers-ai-provider` REST | `api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/zai-org/glm-4.7-flash` | `OBOETE_CF_API_TOKEN` + account id | free tier, 10,000 neurons/day, ~45 neurons per call | JSON schema (verified live, not officially listed) |
| `ollama` | `@ai-sdk/openai-compatible` | `http://127.0.0.1:11434/v1` | none | local | `response_format` |
| `nim`, `openrouter`, `gemini` | `@ai-sdk/openai-compatible` | provider base URL | `OBOETE_PROVIDER_API_KEY` | remote, provider-billed | `response_format` (NIM probed at wiring) |
| `anthropic` | deferred | | | | `response_format` ignored by the provider |

Call policy: `maxRetries: 0`; one retry only for 408/3007 and 429/3040; HTTP 429 with body code 3036
sets `provider_usage.exhausted_at` and switches to the fallback for the rest of the UTC day;
403/5035 marks the preset `provider_paid`; `finish_reason: length` or unparsable JSON counts as
`unusable_output` after one retry; the returned model id must equal the requested id or the batch is
marked degraded `model_alias`. The daily cap (150 calls) is enforced before the outbound call inside
the batch transaction. Neurons are estimated from token usage (5,500 / 36,400 per million) unless
the `cf-ai-neurons` header is available.

## Rule-based fallback

Deterministic, no network. Produces: one `change` observation per cluster of files modified in a
turn (title = the file list, body = quoted tool inputs), one `bugfix` or `discovery` per
`tool_failure` followed by a successful retry of the same tool, one `decision` from each
`last_assistant_message` or `compaction_summary` paragraph that contains a decision marker in the
content's language, and `next_steps` from the last unfinished turn. Section labels come from a
two-entry lookup keyed by the dominant script of the input (Japanese or English); everything else is
quoted source text. `degraded_reason` is set by the worker, never by the fallback.
