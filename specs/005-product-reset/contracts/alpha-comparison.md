# Contract: Alpha Foundation Comparison

## Purpose

Provide one small, reproducible contract for comparing a candidate foundation or resource-policy
change before adopting it. This contract is not a general benchmark framework.

## Required scenarios and owner slices

1. **Slice 1**: Claude Code capture followed by Codex lexical retrieval and injection.
2. **Slice 1**: Codex capture followed by Claude Code lexical retrieval and injection.
3. **Slice 1**: Runtime unavailable during capture, followed by duplicate delivery of the same
   stable event identities during spool recovery.
4. **Slice 1**: Summary provider unavailable or malformed.
5. **Slice 1**: Summary provider returns an HTTP redirect; no request or payload is sent to the
   redirect location and doctor reports the bounded rejection reason.
6. **Slice 2**: Semantic provider or index unavailable, with lexical fallback and InjectionPack
   reasons.
7. **Resource samples**:
   - Slice 1: cold and warm short-run samples only;
   - Slice 3: long, burst, packed-artifact, and eight-hour soak samples.

An owner slice is required to implement only its scenarios. Later-slice scenarios are recorded as
`not_run`, never inferred from a disabled capability or used to block an earlier slice.

## Fixture requirements

Each fixture defines:

- pinned Agent and candidate versions
- isolated configuration and data locations
- ordered input events and lifecycle milestones
- required facts, forbidden facts, and retrieval queries
- expected durable event and MemoryItem counts, including persisted summaries
- declared profile and provider identities
- latency, process, memory-growth, queue, storage, and token thresholds, plus fixed repetitions,
  warm-up/reset rules, sample boundaries, and percentile calculation
- an explicit drain condition proving comparable completion across candidates
- a versioned structural fixture schema and mandatory semantic validation path; neither check alone
  establishes fixture conformance

The committed Slice 1 fixture is
[`../fixtures/slice1-bidirectional-en-v1.json`](../fixtures/slice1-bidirectional-en-v1.json), with
structure fixed by
[`../fixtures/slice1-bidirectional-en-v1.schema.json`](../fixtures/slice1-bidirectional-en-v1.schema.json).

Real credentials, private transcripts, and local absolute paths are forbidden in committed fixtures.

## Result record

Every run emits one machine-readable record containing:

- fixture and candidate identity
- environment and artifact fingerprints
- cold or warm mode
- milestone timestamps and completion state
- `drainConditionId`, `drainStatus`, and `drainTimedOut`
- captured, committed, duplicate, lost, and pending counts
- individual zero-tolerance counters for Agent blockage, accepted-event loss, duplicate durable
  memory, secret egress, and incompatible-scope injection
- required-fact recall and forbidden-fact count
- injected token count and per-item selection reasons
- process-tree samples, resource plateau, queue depth, and storage growth
- effective provider cost units when known
- healthy, degraded, failed, unsupported, or not-run disposition with reason

## Comparison rules

- Candidates are compared only after their equivalent drain condition completes or times out.
- `summaryCount` is included in `durableMemoryCount`; it is not an additional durable entity count.
- Unsupported, not-run, failed, and degraded are distinct states.
- Safety counts for Agent blockage, accepted-event loss, duplicate durable memory, secret egress,
  and incompatible-scope injection must be zero.
- Resource or quality thresholds are frozen before candidate results are inspected.
- Raw records remain available beside the human summary.

Slice 1 uses the permanent minimal reason vocabulary `exact_session`, `lexical`,
`omitted_budget`, `omitted_ineligible`, and `semantic_disabled`. It records reasons for selected
items and any considered item it omits, but does not implement Slice 2 lane minima, semantic
scoring reasons, or the full InjectionPack trace.
