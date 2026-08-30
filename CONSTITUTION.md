<!--
Sync Impact Report
- Version change: 1.0.0 -> 2.0.0 (product purpose and delivery model redefined)
- Modified principles:
  - Local-First -> Automatic Memory UX First
  - Zero Incremental Cost -> Local-First and Explicit Egress
  - Privacy Boundary -> Local-First and Explicit Egress
  - Safety Boundary -> Durable Capture and Honest Degradation
  - Deterministic Gates -> Bounded and Predictable Resources
  - Local-Only Development -> Product Slices Before Speculative Platforms
- Added sections: Product and Technical Constraints; Development Workflow and Gates
- Removed requirements:
  - checkpoint claim, revision fence, and Verified Continuity Engine scope
  - v6.1 as the canonical product specification and fixed Phase 0A-11 order
  - blanket prohibition on push, pull requests, and public repository operations
  - a mandatory zero-cost generation profile
- Follow-up work:
  - create the Product Reset feature specification and implementation plan
  - route or close legacy continuity issues after the new specification is authoritative
-->

# free-mem Constitution

## Core Principles

### I. Automatic Memory UX First

free-mem MUST let Claude Code and Codex users work normally while relevant activity is
captured, summarized, stored, retrieved, and injected without manual handoff bookkeeping.
The first supported product path MUST work in both Claude-to-Codex and Codex-to-Claude
directions. Background memory failures MUST NOT block either coding Agent. Features that do
not improve this end-to-end experience MUST NOT delay the Technical Alpha.

### II. Local-First and Explicit Egress

Memory, indexes, configuration, and operational state MUST be stored locally by default.
Cloud sync and hosted services MUST remain explicit opt-in extensions. Summary and embedding
providers MAY be local or remote, but setup MUST show the effective provider, endpoint host,
credential source, expected cost class, and data-egress behavior before activation. Remote
requests MUST use the redaction and sensitivity boundary; secrets and items marked local-only
or sensitive MUST NOT leave the device. Credentials MUST NOT be discovered from unrelated
Agent sessions or subscription stores without explicit user selection and a supported contract.

### III. Bounded and Predictable Resources

Every shipped profile MUST have measured limits for resident processes, queues, retries,
concurrency, storage growth, and injected tokens. Unbounded buffers, retry loops, duplicate
index writes, and orphan subprocesses are prohibited. Technical Alpha MUST NOT use a
Chroma/Python sidecar. Necessary memory use is acceptable when it preserves user experience
and retrieval quality, but usage MUST reach a stable, observable plateau for a fixed workload.
The product MUST NOT delete durable memories or silently disable semantic retrieval solely to
meet an arbitrary RSS target.

### IV. Durable Capture and Honest Degradation

The canonical store MUST have one daemon-owned writer. Hooks, adapters, MCP, and CLI clients
MUST submit mutations through the daemon or a bounded atomic spool. Accepted events MUST be
idempotent and recoverable after daemon or provider failure. When summarization or embeddings
are unavailable, free-mem MUST preserve pending work, serve the strongest available lexical
fallback, and expose the degraded reason through doctor and injection metadata. Empty or stale
results MUST NOT be reported as a healthy semantic result.

### V. Product Slices Before Speculative Platforms

Development MUST proceed through one user-visible vertical slice at a time. The Technical
Alpha is limited to Linux/WSL, Claude Code and Codex, automatic memory, local retrieval,
profile-based model configuration, doctor, and a minimal inspection/deletion surface. Rust,
macOS, native Windows, additional Agents, cloud sync, teams, shared-memory governance, and
advanced viewers MUST remain deferred until the Alpha flow is externally validated or a
measured blocker proves the change necessary. Active product blockers MUST be capped at five,
and only one product slice may be in progress.

## Product and Technical Constraints

- The implementation base is the existing pinned Codemem safety kernel: daemon sole writer,
  bounded spool, redaction, SQLite/FTS, optional sqlite-vec, hooks, observer, backup, CLI/MCP,
  and viewer assets. It is not an upstream-tracking fork.
- claude-mem is the UX and characterization-test reference. Its context rendering, prompt and
  parser behavior, health communication, and migration format MAY be selectively adapted with
  required Apache-2.0 attribution. Its runtime is not the product foundation.
- Technical Alpha uses TypeScript, Node.js, and SQLite. Rust is considered only after a
  reproducible comparison shows that lifecycle and packaging changes cannot meet the frozen
  resource envelope.
- Setup MUST compile a small resource preset plus independent summary and embedding provider
  choices into one versioned effective capability manifest. Runtime and doctor MUST consume
  that same manifest; direct configuration bypasses are prohibited.
- Retrieval MUST produce a bounded, versioned injection pack with stable selection behavior and
  an explanation of included, omitted, and degraded candidates.
- The Alpha support matrix is Linux and WSL on local Linux filesystems. macOS is the first
  post-Alpha platform milestone; native Windows follows separately.
- Pro features may later add encrypted cloud sync, multi-device backup, and a hosted viewer,
  but MUST NOT become dependencies of the local core.

## Development Workflow and Gates

- Use the Spec Kit sequence `specify -> clarify -> plan -> tasks -> implement -> verify-tasks`
  for this Product Reset and each subsequent non-trivial product slice.
- Perform implementation in an isolated branch and worktree. Preserve unrelated worktrees and
  never rewrite the shared checkout.
- Start with one fixed Claude-to-Codex and Codex-to-Claude scenario. Before changing a
  foundation or resource envelope, compare candidates with the same lifecycle milestones,
  expected facts, and result schema.
- New behavior requires the smallest regression test that fails without it. Release evidence
  MUST include build, typecheck, lint, focused tests, full relevant tests, clean-install or
  packed-artifact checks, real hook-to-injection E2E, provider-failure fallback, and a bounded
  resource soak.
- Correctness and security review MUST precede the over-engineering review. Valid findings are
  fixed and re-reviewed; review tools are evidence sources, not authorities. Quality cleanup
  unrelated to the active user-visible slice MUST NOT expand scope.
- Public pull requests and issue updates are allowed when requested and MUST follow the
  repository review, CI, and merge gates. Merge, release, and deployment remain separate
  explicit delivery decisions.

## Governance

This constitution supersedes the v6 continuity specification, its phase order, and legacy
continuity issues as active product authority. Those artifacts remain historical evidence only
until a new approved specification explicitly reactivates part of them. Amendments require an
updated Sync Impact Report, user approval for changes to product purpose or privacy boundaries,
and a migration or disposition plan for affected specifications and issues.

Versioning follows semantic versioning: MAJOR for removed or redefined principles, MINOR for a
new or materially expanded principle, and PATCH for non-semantic clarification. Every feature
plan and pull request MUST state whether it complies with Principles I-V and identify any
approved exception. Unexplained violations block implementation or merge.

**Version**: 2.0.0 | **Ratified**: 2026-08-12 | **Last Amended**: 2026-08-25
