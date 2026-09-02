# Observer Contract (M1)

One JSON schema is produced by the LLM observer and by the rule-based fallback; the worker treats
both identically except for `degraded_reason`.

## Batch composition and the outbound boundary

After classification, a session batch is split by destination; batch identity is
(session, through event, destination). Every batch produces observations only. The session
summary is never a provider output in M1: at session end the worker derives it deterministically
from the session's rows and the observations just applied (rules below), so session end costs
exactly one provider call (the observations batch) and the summary has one source. The matrix:

| configuration | session end provider calls | observations from | summary from |
|---|---|---|---|
| remote preset only | 1 (remote batch, eligible rows) | remote batch + fallback batch for the remaining rows | deterministic summary |
| local preset only | 1 (local batch, non-secret rows) | local batch | deterministic summary |
| remote + local | 1 remote (eligible) + 1 local (remaining rows); the Clarifications' "one call" is per batch (FR-010) | both, disjoint rows | deterministic summary |
| no preset / degraded | 0 | fallback batch | deterministic summary |

Rows are assigned to exactly one destination, so no observation is generated twice (tested with
a remote preset by asserting that the fallback batch of the same range contains no eligible row):

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

The producing agent is provenance only and never appears in the request. Each memory records its source rows in `memory_sources` and takes the strictest sensitivity of
those rows.

## Input (worker → summarizer)

```json
{
  "repo_ref": "<repository id>",
  "session": { "started_at": 0, "turns": [ ... ] },
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
  ]
}
```

Every observation must carry `source_event_ids`, a non-empty subset of the `id` values supplied
in `events`; an observation citing an unknown id is rejected as `unusable_output` (one retry).

**Session summary (deterministic, worker-side, no provider call)**: `type = session_summary`,
`title` = the session's first prompt truncated to 120 characters, `body` = five labelled lines:
`request` = the first prompt truncated to 200 characters; `investigated` = the distinct files read
(up to 20 paths); `learned` = the titles of the observations applied for the session (up to 10);
`completed` = the distinct files modified with tool counts (up to 20); `next_steps` = the last
unfinished turn's prompt truncated to 200 characters. Sensitivity = strictest source row;
`degraded_reason` = NULL (this is the designed path, not a degradation); language = the dominant
script of the copied text, which is preserved verbatim. SC-004 (three seeded facts recalled with
no credentials) is asserted against the fallback observations plus this summary.

Worker rules after either path: the detector runs again on every title and body; the
directive-corpus check rejects bodies that read as instructions; sensitivity on `add` = strictest
source row and detector result, on `update` = max(target's sensitivity, every source row, detector
result), fixed in the apply transaction so a `local_only` or `private` target can never be
relaxed by an eligible update (tested against the outbound body); `material_hash` and `content_hash` come from the shared identity helper (`material_hash` =
sha256(type, normalized title, normalized body), `content_hash` = sha256(repo_id, material_hash);
the same function serves import and tombstones); `target` must be
one of the supplied `nearby` ids from the same repository, otherwise the decision is `add`; a hash
matching a tombstoned memory suppresses the insert and is recorded for `why`; `update` sets
`valid_to` and `superseded_by`; `delete` tombstones the target only with a non-empty `reason`; the
observer answers in the dominant language of the input (FR-014); the worker compares the
dominant script of every title and body with the input's, retries once on mismatch, and on a
second mismatch discards the output and routes the batch to the fallback with
`language_mismatch` (fallback records copy input text verbatim, so their language is the
input's); a provider fixture returning English for Japanese input verifies this.

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
3. Classify by status **and** provider body code (table-driven, tested with the same status and
   different codes): 429 + 3036 → `provider_exhausted`; 403 + 5035 → `provider_paid`; 401, or 403
   without 5035, or any auth/permission body code → `auth_failed` (recovery: check the credential
   variable); 408/3007 or 429/3040 → one retry; `length`, null content, invalid JSON → one retry
   then `unusable_output`; abort → `timeout`; returned model id mismatch → `model_alias`; network
   error → `unreachable`.
4. **Exhaustion persistence**: a 3036 result writes `provider_usage.exhausted_at` (idempotent,
   monotonic, keyed by the reservation id) in its own transaction that is **not** fenced by the
   lease, so the signal survives a lost lease.
5. Apply: memory mutations (add, update, delete) and `state = applied` are written in **one**
   transaction fenced by `owner_token`; zero rows changed means the lease was lost and the whole
   result is discarded (the exhaustion signal from step 4 is not). A worker that dies after the
   response and before this transaction leaves the batch `running`; the next worker reclaims it
   after 120 s and makes a new call (at-least-once attempts, exactly-once applied effects, A11).
6. **Consent**: the consent tuple hash is recomputed from live configuration before step 1 and
   again immediately before step 2; a mismatch makes no call and degrades with `consent_changed`.
7. Neurons: `cf-ai-neurons` header when exposed, else tokens × (5,500 / 36,400 per million).

## Rule-based fallback

Deterministic, no network, copies input text verbatim (so the language is the input's), emits
records rather than prose, at most 20 observations per batch, every field of the schema filled by
rule:

| record | when | title | body | concepts | citations | classification |
|---|---|---|---|---|---|---|
| `change` | per turn with file modifications | the modified paths joined by `, ` (<= 120 chars) | one line per tool call: `<tool> <path> (+<added>/-<removed>)` | `what-changed` | `files_modified` = the paths; `commits` = commit ids seen in tool output | see below |
| `bugfix` | a `tool_failure` followed by a successful call of the same tool in the same turn | `<tool>: <first error line truncated to 80>` | first error line (200) + the successful call's first line (200) | `problem-solution` | `files_modified` of the retry | see below |
| `discovery` | a `tool_failure` with no successful retry | same as `bugfix` | first error line (200) | `gotcha` | `files_read` of the failed call | see below |
| `decision` | per `last_assistant_message` or `compaction_summary` | first sentence (120) | first paragraph (2,000), verbatim | `why-it-exists` | none | see below |

Fact retention for SC-004: the three seeded facts appear in prompts and tool outputs; the
`decision` record keeps the first paragraph of `last_assistant_message` verbatim and the
`change` record keeps every modified path, which is where the fixture plants them.
`classification.reason` = `rule:<record>`; decision = exact `content_hash` match on a tombstoned
row → suppressed, on an active row → `noop`, otherwise `add`; the fallback never emits `update`
or `delete`. `degraded_reason` is set by the worker (`no_provider`, `unreachable`, ...) and is
NULL only for the rows a remote batch could not take by design (local-only rows next to a healthy
remote preset), which are labelled `rule_based` instead.
