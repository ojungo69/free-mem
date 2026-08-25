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
5. **Slice 1**: Summary provider returns one item above the active derivation limit; no partial
   output commits, and only a changed larger limit/provider resumes the retained job.
6. **Slice 1**: Summary provider returns an HTTP redirect; no request or payload is sent to the
   redirect location and doctor reports the bounded rejection reason.
7. **Slice 1**: A credentialless remote HTTP provider with a non-empty redacted payload is rejected
   before activation, external request, or payload transmission.
8. **Slice 1**: Local-only content is considered for a remote summary provider but produces zero
   remote requests or payloads.
9. **Slice 1**: Private content is considered for a remote summary provider but produces zero remote
   requests, payloads, or injection.
10. **Slice 1**: Memory derived locally from a local-only source retains `local_only` and is omitted
   from a remote InjectionPack destination.
11. **Slice 1**: A candidate from another repository scope is considered and omitted before
   injection.
12. **Slice 2**: Semantic provider or index unavailable, with lexical fallback and InjectionPack
   reasons.
13. **Slice 3**: Deleting a fact prevents regeneration after profile, model, or semantic-kind
   reclassification while sibling source facts remain available.
14. **Resource samples**:
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
- the complete pinned InjectionPack selection envelope, including time, candidate, byte, item,
  token, and per-lane budgets
- latency, process, memory-growth, queue, storage, and token thresholds, plus fixed repetitions,
  warm-up/reset rules, sample boundaries, and percentile calculation
- an explicit drain condition proving comparable completion across candidates
- a versioned structural fixture schema and mandatory semantic validation path; neither check alone
  establishes fixture conformance
- a domain-separated fingerprint over the entire fixed fixture except the fingerprint field itself,
  and additionally over its structural schema and semantic validator bytes; changing any included
  element requires a new pinned fingerprint/version review

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
- captured, committed, duplicate, lost, pending, summary, and durable-memory counts
- retry resume signal identity/order, budget transitions, attempt delta, ignored-signal count, and
  recovered output disposition when applicable
- the closed payload-free failure metadata record when an output-limit rejection applies
- individual zero-tolerance counters for Agent blockage, accepted-event loss, duplicate durable
  memory, secret egress, and incompatible-scope injection
- positive considered-event/candidate/activation denominators plus remote request, payload,
  injection, transmitted-byte, and forbidden-sentinel observations for security rejection scenarios
- expected-injection recall, expected-omission match, and forbidden-fact count
- injected token count, input/traced/deadline-unprocessed/admitted/selected candidate counts, and
  per-item source lane and selection reason
- process-tree samples, resource plateau, queue depth, and storage growth
- effective provider cost units when known
- healthy, degraded, failed, unsupported, or not-run disposition with reason
- effective profile and bounded safe recovery action for pending or failed work

The authoritative format is
[`alpha-result-v1.schema.json`](alpha-result-v1.schema.json), with cross-field rules in
[`alpha-result-v1.semantic.jq`](alpha-result-v1.semantic.jq) and executable fixture/result checks in
[`validate-alpha-result.mjs`](validate-alpha-result.mjs). Runner-specific records are not comparable
until this canonical validator exits 0.

The schema and semantic rules define the Alpha v1 vocabulary for Slice 1, including its fixed retry
signal and provider identity. The current executable validator is deliberately bound to that
fingerprinted fixture bundle; neither the schema nor validator is a generic fixture-plugin interface.
Slice 2 and Slice 3 add their own fingerprinted fixture validator, reuse compatible core fields, and
version-review any new retry family rather than weakening the Slice 1 evidence shape.
The schema owns structure, the jq layer owns fixture-independent record arithmetic and ordering, and
the executable validator alone derives fixture-oracle matches, thresholds, failure priority, and
comparison eligibility; consumers do not combine partial verdicts from those layers.

## Comparison rules

- Candidates are compared only after their equivalent drain condition completes or times out.
- `drainTimedOut=true` is always a non-success `failed` or `degraded` disposition. Its record remains
  inspectable but is excluded from successful candidate comparison and cannot pass completion,
  quality, or resource gates. Safety counters remain independently required to be zero.
- After a completed drain, a positive `deadlineUnprocessed` count is non-eligible with result reason
  `selection_deadline_exceeded`; it is not a quality-threshold failure. `drain_timed_out` remains the
  higher-priority reason when the drain itself times out.
- Actual injected items must exactly match `expectedInjectedItems` in order and in every bound field:
  fact, memory kind, source event identities, source lane, and selection reason. Actual omissions
  must likewise match the expected omission records.
- Provider extraction order is not assumed to equal injection order. Fixture validation compares
  provider outputs to dispositions as a multiset; the whole-fixture fingerprint pins the declared
  `expectedInjectedItems` order, and the runtime result must match that order exactly.
- `summaryCount` is included in `durableMemoryCount`; it is not an additional durable entity count.
- Unsupported, not-run, failed, and degraded are distinct states.
- `unsupported` and `not_run` are canonical no-activity records: all operation, evidence, resource,
  item, and token counts are zero; retry/failure/operational evidence is absent; and their reasons are
  `capability_unsupported` and `owner_slice_not_run`, respectively. They cannot wrap a failed run.
- Safety counts for Agent blockage, accepted-event loss, duplicate durable memory, secret egress,
  and incompatible-scope injection must be zero.
- Agent-blockage and accepted-loss zeroes are backed by each scenario's non-empty lifecycle and
  committed-event denominator; duplicate-durable-memory zero is backed by the spool scenario's
  positive duplicate replay count. Secret-egress and incompatible-scope zeroes require the matching
  `securityOracle` positive considered-event/candidate denominator and an absent forbidden sentinel
  at the protected destination.
- The credentialless-HTTP configuration-rejection scenario ends before capture and therefore has a
  zero accepted/committed-event denominator. It does not use `acceptedEventLossCount=0` as safety
  evidence; its positive activation-proposal denominator and zero request/transmitted-byte evidence
  prove the pre-send rejection instead.
- Resource or quality thresholds are frozen before candidate results are inspected.
- Raw records remain available beside the human summary.

Slice 1 candidate terminal reasons are the permanent minimal subset `exact_session`, `lexical`,
`duplicate_revision`, `omitted_budget`, and `omitted_ineligible` from the authoritative InjectionPack
enumeration. The separate pack-level degradation reason is `semantic_disabled`; it is never
recorded as a candidate terminal reason. Slice 1 does not emit the remaining Slice 2-owned
lane-minimum, candidate-cap, semantic-scoring, or full-trace reasons.
