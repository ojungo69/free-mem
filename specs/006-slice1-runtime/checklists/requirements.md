# Specification Quality Checklist: Slice 1 Automatic Memory Runtime

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-30
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No source-file/framework implementation plan leaks into the spec; named wire/security/state
  contracts are intentional user-supplied invariants
- [x] Focused on user value and business needs
- [x] User stories lead with user value; technical contract detail is confined to requirements and
  edge cases needed for deterministic implementation
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are observable at contract/runtime boundaries and contain no source-path tasks
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] Implementation paths remain in plan/tasks; specification names only required observable
  contracts and persistence/lifecycle invariants

## Source-Hardening Review

- [x] Provider proposal is closed and buildable: two wire protocols, complete canonical endpoint,
  explicit CredentialRefV1, exact auth/request/response/no-auth behavior and resource limits,
  computed provider/manifest fingerprints, and compiler-derived policy
- [x] Contract/fixture correction is a separate first checkpoint; no runtime consumer precedes setup
  activation
- [x] Base/local/repaired manifests and resume/redirect/downgrade fingerprints are complete; v2/max17
  remains a runner-only fault successor and static PR 0 makes no runtime claim
- [x] Fixed resource profile includes periodic, idle, debounce, stuck-claim, retention, and 100-event
  job fields with enforcement ownership named by PR
- [x] Privacy covers provider, maintenance, all Store/reference/daemon/MCP/viewer/pack/trace/export/
  import/dedup consumers through one DestinationBoundary, including viewer artifacts and export-v2
  prompt/legacy-summary/safe-session projections
- [x] Claude/Codex/MCP model egress is remote/unknown by default; no caller/local-process claim can
  select runner-only on-device destination classes
- [x] Repository authority uses verified Git remote or realpathed primary Git anchor, never basename or
  project label
- [x] Schema v21 durable jobs, retry-exhausted capacity, one-shot resume, attempt/admission provenance,
  atomic completion, retention safety, and legacy `gave_up` handling precede #130 closure
- [x] RawEventSweeper production nudge and stop-race, content-free diagnostics, semantic-disabled
  vector retention, and generated artifacts have named source/tests
- [x] Setup pointer/editor activation publishes `current` last and has owner-only interruption-journal
  recovery plus shared setup/daemon lifecycle-lock exclusion before provider startup
- [x] Activation receipt, persisted provider health edge, and user-confirmed doctor retry are the only
  crash-idempotent resume-signal producers
- [x] Closed runner-evidence schema owns raw plateau/TLS evidence; result fingerprints/aggregates bind
  it while conflict and exact 16+1 evidence remain closed
- [x] Tasks are sequential T001-T060 and every independent PR boundary/dependency/range is explicit

## Notes

- Validated against issues #130/#137, current Codemem source/test paths, and Product Reset intent.
- Current `specs/005-product-reset/` fixture/schema/validators/bound evidence require the separate
  contract-first mechanical correction recorded in T002-T005; this 006 hardening does not edit them.
- No clarification marker or unchecked checklist item remains; the artifacts are ready for the PR 0
  contract checkpoint.
