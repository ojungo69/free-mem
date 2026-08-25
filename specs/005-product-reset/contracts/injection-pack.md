# Contract: InjectionPack

## Purpose

Define the stable, explainable context product supplied to Claude Code and Codex.

## Inputs

- target Agent/model destination class, session, and repository scope
- active capability manifest and its destination-policy map
- normalized candidates from `exact_session`, `lexical`, `semantic`, and `recency` lanes
- hard time, byte, item, and token budgets
- manifest-defined per-lane minimum and maximum budgets

## Selection behavior

1. Resolve the concrete destination class against the manifest policy map, then reject candidates
   outside repository scope, deleted, superseded, secret-bearing, or otherwise ineligible. Missing
   or unknown destinations are remote/ineligible for local-only data. Local-only candidates require
   an explicit matching on-device policy in the same repository scope and are never rendered to a
   remote provider or off-host destination.
2. Normalize lane scores without erasing lane identity.
3. Keep only the active revision of each memory lineage, then deduplicate repeated candidates for
   that revision using stable precedence.
4. Apply lane precedence `exact_session > lexical > semantic > recency`.
5. Allocate each lane's minimum in precedence order without exceeding any global budget. If the
   sum of minima cannot fit, lower-precedence minima receive no allocation and every affected
   candidate records `lane_minimum_not_funded`.
6. Enforce each lane maximum. Fill remaining global budget by normalized score; ties use lane
   precedence, then memory revision, then stable memory identity.
7. Stop before any global time, byte, item, or token budget is exceeded.
8. Record an inclusion or omission reason for every considered candidate.

## Output requirements

- version and pack identity
- target destination class, resolved destination policy, and manifest identity
- ordered rendered sections and source memories
- total items, bytes, tokens, and elapsed selection time
- per-item provenance and `sourceLane`
- omission reasons for budgeted-out or ineligible candidates
- semantic or provider degradation and the fallback used

Claude Code and Codex renderers may differ in syntax but must preserve the same selected facts,
order, provenance, and degradation meaning.

## Failure behavior

- A missing semantic lane uses lexical and recency lanes and marks semantic degradation.
- A time budget expiration returns a valid partial pack with an explicit deadline reason.
- A scope or sensitivity validation failure excludes the candidate and is never overridden by
  relevance score.
- Compilation failure returns no fabricated context and must not block the Agent.
