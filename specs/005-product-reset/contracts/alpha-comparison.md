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
6. **Slice 1**: Summary provider returns either a cross-host HTTPS redirect or a same-host
   HTTPS-to-HTTP downgrade; no request or payload is sent to either redirect location and doctor
   reports the bounded rejection reason.
7. **Slice 1**: Remote HTTP providers with and without configured credentials are each rejected with
   a non-empty redacted payload before activation, credential transmission, request, or payload
   transmission. Verified-HTTPS activation is separately rejected for an invalid certificate chain
   and a hostname mismatch with the same zero-egress evidence.
8. **Slice 1**: Local-only content is considered for a remote summary provider but produces zero
   remote requests or payloads.
9. **Slice 1**: A mixed eligible/local-only/private/secret batch sends one allowed-only projection
   while restricted sentinels contribute zero transmitted bytes.
10. **Slice 1**: Private content is considered for a remote summary provider but produces zero remote
   requests, payloads, or injection.
11. **Slice 1**: Memory derived locally from a local-only source retains `local_only` and is omitted
   from a remote InjectionPack destination.
12. **Slice 1**: A candidate from another repository scope is considered and omitted before
   injection.
13. **Slice 2**: Semantic provider or index unavailable, with lexical fallback and InjectionPack
   reasons.
14. **Slice 3**: Deleting a fact prevents regeneration after profile, model, or semantic-kind
   reclassification while sibling source facts remain available.
15. **Resource samples**:
    - Slice 1: cold and warm short-run samples only;
    - Slice 3: long, burst, packed-artifact, and eight-hour soak samples.

An owner slice is required to implement only its scenarios. Later-slice scenarios are recorded as
`not_run`, never inferred from a disabled capability or used to block an earlier slice.

## Fixture requirements

Each fixture defines:

- pinned Agent and candidate versions
- isolated configuration and data locations plus pinned OS/kernel, CPU, memory, and filesystem
  descriptors for the reference runner
- ordered input events and lifecycle milestones
- ordered expected injected items binding fact, memory kind, source events, lane, and selection
  reason; expected omissions; forbidden facts; and retrieval queries
- expected durable event and MemoryItem counts, including persisted summaries
- declared effective-manifest identity/fingerprint, the validated local-derivation and output-limit
  recovery manifests with their activation boundaries, profile/provider identities, and a versioned
  destination-policy map resolving every scenario target class
- the complete pinned InjectionPack selection envelope, including time, candidate, byte, item,
  token, and per-lane budgets
- latency, process, memory-growth, queue, storage, and token thresholds, plus fixed repetitions,
  warm-up/reset rules, sample boundaries, and percentile calculation
- an explicit drain condition proving comparable completion across candidates
- a versioned structural fixture schema and mandatory semantic validation path; neither check alone
  establishes fixture conformance
- a domain-separated fingerprint over the entire fixed fixture except the fingerprint field itself,
  and additionally over its structural schema, semantic validator text, and canonical executable
  validator text, plus the result schema/semantic/canonical-validator artifacts; text is normalized
  to LF and the fixture executable's pinned-fingerprint literal is normalized to a placeholder to
  avoid a self-hash cycle. All imported result-validator modules and the shared JCS/schema runtime
  implementations are included too. Changing any included element requires a new pinned
  fingerprint/version review

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

Every candidate/scenario comparison emits one machine-readable aggregate record containing:

- fixture and candidate identity
- resolved target destination class and effective-manifest fingerprint
- the fixture-pinned execution environment and candidate artifact metadata, each with a
  domain-separated JCS fingerprint
- cold or warm mode
- milestone timestamps and completion state
- `drainConditionId`, `drainStatus`, and `drainTimedOut`
- a boolean before-model injection marker derived from observed injection-acknowledgment and
  target-model-dispatch milestones; otherwise null
- a fixed negative fixture that reverses those milestones, sets the marker false, and requires a
  non-eligible `scenario_oracle_mismatch` result
- host-observed Agent/repository/session identity plus three single-field caller-claim mismatch
  decisions; caller claims authorize zero persistence or injection
- captured, committed, duplicate, lost, pending, summary, and durable-memory counts
- observed retry signal delivery, consumed/ignored signal identities, provider-attempt/outcome,
  budget transitions, state, and the exact recovered durable output when applicable
- the payload-free identity-conflict receipt, canonical/incoming states, reason, preservation flag,
  and durable-memory delta when applicable
- the closed payload-free failure metadata record when an output-limit rejection applies
- individual zero-tolerance counters for Agent blockage, accepted-event loss, duplicate durable
  memory, secret egress, and incompatible-scope injection
- positive considered-event/candidate/activation denominators plus remote request, payload,
  injection, exact aggregate credential/payload wire bytes, provider cost units, and
  forbidden-sentinel observations for security rejection scenarios
- expected-injection recall, expected-omission match, and forbidden-fact count
- attempted and delivered rendered bytes/tokens, selection elapsed time,
  input/traced/deadline-unprocessed/admitted/selected candidate counts, and per-item source lane and
  selection reason
- exact attempted/final UTF-8 render payload evidence plus pinned renderer/tokenizer identity and
  ordered token-ID records; aggregate byte/token counts are recomputed from this evidence
- a nullable pack-compilation failure; `injection_pack_limit_exceeded` requires an oversized
  attempted render and zero final delivered items, bytes, and tokens
- all 22 ordinal latency runs, discarded-run markers, event-ordered capture samples, applicable
  warm/cold injection samples, per-run repository/session namespaces and ordinal-scoped event IDs,
  and recomputed nearest-rank P95 aggregates
- process-tree samples, resource plateau, queue depth, and storage growth
- effective provider cost units when known
- healthy, degraded, failed, unsupported, or not-run disposition with reason
- effective profile and bounded safe recovery action for pending or failed work

The authoritative format is
[`alpha-result-v1.schema.json`](alpha-result-v1.schema.json), with cross-field rules in
[`alpha-result-v1.semantic.jq`](alpha-result-v1.semantic.jq) and executable fixture/result checks in
[`validate-alpha-result.mjs`](validate-alpha-result.mjs). Runner-specific records are not comparable
until this canonical validator exits 0.

A single `--result` validates one inspectable scenario record only. Candidate comparison requires
suite mode: pass one `--result PATH` per positive scenario and the required late-injection record as
`--negative-result PATH`. The validator requires the positive scenario-ID multiset to equal the
complete fixed fixture, a common candidate/environment/artifact identity, and every positive record
to be comparison-eligible. The negative record applies `beforeModelNegativeFixture` to its named
base scenario; it must reverse the two observed milestones and match the fixed failed, non-eligible
disposition.

The schema and semantic rules define the Alpha v1 vocabulary for Slice 1, including its fixed retry
signal and provider identity. The current executable validator is deliberately bound to that
fingerprinted fixture bundle; neither the schema nor validator is a generic fixture-plugin interface.
Slice 2 and Slice 3 add their own fingerprinted fixture validator, reuse compatible core fields, and
version-review any new retry family rather than weakening the Slice 1 evidence shape.
The schema owns structure, the jq layer owns fixture-independent record arithmetic and ordering, and
the executable validator alone derives fixture-oracle matches, thresholds, failure priority, and
comparison eligibility; consumers do not combine partial verdicts from those layers.

`environmentFingerprint` is SHA-256 over the execution-environment object with domain
`free-mem:alpha-execution-environment:v1\0`. `artifactFingerprint` uses the same JCS construction
over artifact metadata with domain `free-mem:alpha-candidate-artifact:v1\0`. The validator requires
the environment pins/descriptors and artifact base commit to match the fixed fixture. The artifact
manifest itself is JCS-hashed with `free-mem:alpha-artifact-content:v1\0`; that digest must equal
`contentSha256` before the metadata fingerprint is accepted.

## Comparison rules

- Candidates are compared only after their equivalent drain condition completes or times out.
- `drainTimedOut=true` is always a non-success `failed` or `degraded` disposition. Its record remains
  inspectable but is excluded from successful candidate comparison and cannot pass completion,
  quality, or resource gates. Periodic process observation must reach the pinned timeout boundary;
  safety counters and zero-tolerance security evidence remain independently required to be zero.
- After a completed drain, a positive `deadlineUnprocessed` count is non-eligible with result reason
  `selection_deadline_exceeded`; it is not a quality-threshold failure. `drain_timed_out` remains the
  higher-priority reason when the drain itself times out.
- Selection elapsed time that reaches or exceeds the profile deadline has the same
  `selection_deadline_exceeded` result. Rendered-byte or token overflow is
  `injection_pack_limit_exceeded`; attempted size remains inspectable and may exceed the envelope
  during deterministic pruning, while only the final rendered byte/token values gate eligibility.
  Delivered items, bytes, and tokens remain zero for every late or oversized pack.
- Run ordinals are exactly 1 through 22, ordinals 1-2 are discarded, and the remaining 20 runs feed
  nearest-rank P95. Capture samples bind the fixed event order and flatten across the 20 measured
  runs within that scenario; warm/cold injection contributes one sample per measured run only for
  scenarios named by the fixture metric. A missing sample, false aggregate, or threshold miss is
  non-eligible with `latency_threshold_exceeded`.
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
- The two HTTP configuration-rejection scenarios end before capture and therefore have zero
  accepted/committed-event denominators. They do not use `acceptedEventLossCount=0` as safety
  evidence; their positive activation-proposal denominators and zero credential/request/transmitted-
  byte evidence prove pre-send rejection instead.
- For the deterministic redirect stub only, the initial request wire body is exactly the event's
  UTF-8 `redactedPayload`. Its positive configured-endpoint byte count and zero redirect-location
  request/byte/resend counters are independently recorded.
- Credential/payload byte evidence is the fixture-pinned aggregate across the configured-endpoint
  attempt set. Allowed verified-HTTPS attempts must match that exact aggregate; local providers and
  rejected activations record zero. The fixed `fixture` and `local_zero` cost classes both record
  exactly zero provider cost units.
- Remote request/payload counts cover the initial drain attempt set only; independent recovery cases
  keep their own observed provider-attempt evidence. Redirect recovery additionally records exact
  zero request/payload/resend evidence for the rejected Location. The initial count is one unless the
  fixture explicitly pins an exhausted attempt count, and zero for rejected or local-provider routes.
- Resource or quality thresholds are frozen before candidate results are inspected.
- Raw records remain available beside the human summary.

Slice 1 candidate terminal reasons are the permanent minimal subset `exact_session`, `lexical`,
`recency`, `duplicate_revision`, `omitted_budget`, and `omitted_ineligible` from the authoritative
InjectionPack enumeration. The separate pack-level degradation reason is `semantic_disabled`; it is
never recorded as a candidate terminal reason. Slice 1 does not emit the remaining Slice 2-owned
lane-minimum, candidate-cap, semantic-scoring, or full-trace reasons.
