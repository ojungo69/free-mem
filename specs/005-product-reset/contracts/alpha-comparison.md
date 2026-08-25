# Contract: Alpha Foundation Comparison

## Purpose

Provide one small, reproducible contract for comparing a candidate foundation or resource-policy
change before adopting it. This contract is not a general benchmark framework.

## Required scenarios and owner slices

1. **Slice 1**: Claude Code capture followed by Codex lexical retrieval and injection.
2. **Slice 1**: Codex capture followed by Claude Code lexical retrieval and injection.
3. **Slice 1**: Runtime unavailable during capture, followed by duplicate delivery of the same
   stable event identities during spool recovery and a same-ID/different-digest conflict probe.
4. **Slice 1**: Summary provider unavailable or malformed, followed by each authorized resume
   signal and duplicate/out-of-order signal delivery.
5. **Slice 1**: Summary provider returns an HTTP redirect; no request or payload is sent to the
   redirect location and doctor reports the bounded rejection reason.
6. **Slice 1**: Local-only content is considered for a remote summary provider but produces zero
   remote requests or payloads.
7. **Slice 1**: A candidate from another repository scope is considered and omitted before
   injection.
8. **Slice 2**: Semantic provider or index unavailable, with lexical fallback and InjectionPack
   reasons.
9. **Slice 3**: Deleting a fact prevents regeneration after profile, model, or semantic-kind
   reclassification while sibling source facts remain available.
10. **Resource samples**:
    - Slice 1: cold and warm short-run samples only;
    - Slice 3: long, burst, packed-artifact, and eight-hour soak samples.

An owner slice is required to implement only its scenarios. Later-slice scenarios are recorded as
`not_run`, never inferred from a disabled capability or used to block an earlier slice.

## Fixture requirements

Each fixture defines:

- pinned Agent and candidate versions
- isolated configuration and data locations
- ordered input events and lifecycle milestones
- ordered expected injected items binding fact, memory kind, source events, lane, and selection
  reason; expected omissions; forbidden facts; and retrieval queries
- expected durable event and MemoryItem counts, including persisted summaries
- declared profile and provider identities
- latency, process, memory-growth, queue, storage, and token thresholds, plus fixed repetitions,
  warm-up/reset rules, sample boundaries, and percentile calculation
- an explicit drain condition proving comparable completion across candidates
- a versioned structural fixture schema and mandatory semantic validation path; neither check alone
  establishes fixture conformance
- a domain-separated fingerprint over the entire fixed fixture except the fingerprint field itself;
  changing any scenario or contract field requires a new pinned fingerprint/version review

The committed Slice 1 fixture is
[`../fixtures/slice1-bidirectional-en-v1.json`](../fixtures/slice1-bidirectional-en-v1.json), with
structure fixed by
[`../fixtures/slice1-bidirectional-en-v1.schema.json`](../fixtures/slice1-bidirectional-en-v1.schema.json)
and cross-field invariants enforced by
[`../fixtures/slice1-bidirectional-en-v1.semantic.jq`](../fixtures/slice1-bidirectional-en-v1.semantic.jq).
The canonical executable validation path is
[`../fixtures/validate-slice1-fixture.mjs`](../fixtures/validate-slice1-fixture.mjs); consumers do not
claim conformance by running only one underlying layer.

Real credentials, private transcripts, and local absolute paths are forbidden in committed fixtures.

## Result record

Every run emits one machine-readable record containing:

- fixture and candidate identity
- environment and artifact fingerprints
- cold or warm mode
- milestone timestamps and completion state
- `drainConditionId`, `drainStatus`, and `drainTimedOut`
- captured, committed, duplicate, lost, and pending counts
- retry resume signal identity/order, budget transitions, attempt delta, ignored-signal count, and
  recovered output disposition when applicable
- individual zero-tolerance counters for Agent blockage, accepted-event loss, duplicate durable
  memory, secret egress, and incompatible-scope injection
- positive considered-event/candidate denominators for security rejection scenarios
- expected-injection recall, expected-omission match, and forbidden-fact count
- injected token count, input/traced/deadline-unprocessed/admitted/selected candidate counts, and
  per-item source lane and selection reason
- process-tree samples, resource plateau, queue depth, and storage growth
- effective provider cost units when known
- healthy, degraded, failed, unsupported, or not-run disposition with reason
- effective profile and bounded safe recovery action for pending or failed work

## Comparison rules

- Candidates are compared only after their equivalent drain condition completes or times out.
- `drainTimedOut=true` is always a non-success `failed` or `degraded` disposition. Its record remains
  inspectable but is excluded from successful candidate comparison and cannot pass completion,
  quality, or resource gates. Safety counters remain independently required to be zero.
- Actual injected items must exactly match `expectedInjectedItems` in order and in every bound field:
  fact, memory kind, source event identities, source lane, and selection reason. Actual omissions
  must likewise match the expected omission records.
- Provider extraction order is not assumed to equal injection order. Fixture validation compares
  provider outputs to dispositions as a multiset; the whole-fixture fingerprint pins the declared
  `expectedInjectedItems` order, and the runtime result must match that order exactly.
- `summaryCount` is included in `durableMemoryCount`; it is not an additional durable entity count.
- Unsupported, not-run, failed, and degraded are distinct states.
- Safety counts for Agent blockage, accepted-event loss, duplicate durable memory, secret egress,
  and incompatible-scope injection must be zero.
- Agent-blockage and accepted-loss zeroes are backed by each scenario's non-empty lifecycle and
  committed-event denominator; duplicate-durable-memory zero is backed by the spool scenario's
  positive duplicate replay count. Secret-egress and incompatible-scope zeroes require the matching
  `securityOracle` positive considered-event/candidate denominator and an absent forbidden sentinel
  at the protected destination.
- Resource or quality thresholds are frozen before candidate results are inspected.
- Raw records remain available beside the human summary.

Slice 1 candidate terminal reasons are the permanent minimal subset `exact_session`, `lexical`,
`duplicate_revision`, `omitted_budget`, and `omitted_ineligible` from the authoritative InjectionPack
enumeration. The separate pack-level degradation reason is `semantic_disabled`; it is never
recorded as a candidate terminal reason. Slice 1 does not emit the remaining Slice 2-owned
lane-minimum, candidate-cap, semantic-scoring, or full-trace reasons.
