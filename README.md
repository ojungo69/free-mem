# free-mem

> **Pre-release source.** This repository is under active development and is not a
> Core 1.0 release. Do not use it with production secrets or irreplaceable memory data.

**Crash-safe continuity for coding agents.**

free-mem is a local-first project for preserving coding work across session exits,
context compaction, crashes, and Agent switches. Its target is not only to retrieve
related history, but to determine whether a previous task can be resumed safely in the
current workspace.

The initial supported continuity path is Claude Code and Codex. Broader Agent and MCP
support is planned through thin, capability-tested adapters rather than client-specific
copies of the memory store.

## Product hypothesis

Many memory tools can store and search prior conversations. free-mem is designed around
a narrower continuity problem:

- identify the logical task lineage rather than assuming the latest session is relevant;
- reconcile repository, branch, worktree, HEAD, dirty state, and file drift before full resume;
- preserve in-flight commands, tests, tools, and file mutations as typed operations;
- mark unknown results as `verify_first` or `never_auto` instead of guessing or replaying;
- claim, deliver, engage, and accept checkpoints as separate fenced states;
- downgrade unsupported or unverified Agent versions instead of overstating compatibility;
- keep deterministic continuation available when generation, embeddings, or providers fail.

These are release targets, not blanket claims about the current pre-release implementation.
See [`specs/001-agent-memory-core/spec.md`](specs/001-agent-memory-core/spec.md) and
[`evidence/phase3-resume-oss-comparison.md`](evidence/phase3-resume-oss-comparison.md).

## Status

- The Phase 1 safety boundary is implemented and candidate-validated; see
  [`specs/001-agent-memory-core/tasks.md`](specs/001-agent-memory-core/tasks.md) and
  [`evidence/phase1-t058-final-validation.md`](evidence/phase1-t058-final-validation.md).
- Runtime-neutral continuity schema, fixtures, and reference-model work are in progress.
- The local Core Runtime's strategic target is Rust, with the existing TypeScript runtime
  retained as the reference and migration source until verified cutover; see
  [`evidence/adr-005-rust-core-product-direction.md`](evidence/adr-005-rust-core-product-direction.md).
- Direct competitors and the intended measurable differentiation are recorded in
  [`evidence/direct-competitor-positioning-2026-08-18.md`](evidence/direct-competitor-positioning-2026-08-18.md).
- The broader project remains pre-release; later phases are not complete.
- No package, release artifact, compatibility promise, performance claim, or support
  promise is made yet.
- Public source visibility does not change the local-only runtime and data boundary.

## Architecture direction

The intended product boundary is **Rust Core + host-native thin adapters**, not a
repository-wide rewrite into one language.

```text
Claude Code / Codex / other Agents
              │
        thin adapter / hook / plugin
              │ versioned RPC / MCP contract
              ▼
      free-mem Core Runtime (Rust target)
      daemon · SQLite sole writer · spool · checkpoints
      retrieval · provider routing · backup / repair · CLI / MCP
              │
         SQLite + FTS5
              │
React / TypeScript viewer through authenticated local API
```

The Core clean-install target does not require Node.js, Bun, Python, Chroma, Redis, or
Postgres at runtime. Agent plugins, the React viewer build, and Cloudflare components may
continue using their native toolchains.

Rust, a single binary, SQLite, local-first operation, MCP, and multi-Agent support are not
sufficient differentiation by themselves. free-mem must demonstrate its advantage through
reproducible continuity scenarios: wrong-resume prevention, workspace reconciliation,
unknown-operation safety, at-most-one delivery, reduced re-explanation, and faster first
useful action.

## Repository layout

- `vendor/codemem/`: modified pinned snapshot containing the current TypeScript product
  workspace and reference implementation
- `specs/001-agent-memory-core/`: implementation plan, contracts, and task gates
- `evidence/`: base-selection, architecture decisions, competitor research, and safety evidence
- `harness/`: version-pinned adapter, schema, continuity, and conformance fixtures
- future `crates/`: first-party Rust Core workspace after the Stage 1 vertical slice

The base snapshot provenance is recorded in
[`vendor/codemem/VENDOR.md`](vendor/codemem/VENDOR.md).

## Current development workflow

The current TypeScript reference toolchain is frozen to Node.js 24.16.0 and pnpm 11.8.0.

```sh
cd vendor/codemem
corepack pnpm install --frozen-lockfile
corepack pnpm run build
CI=true corepack pnpm run check
```

The build runs before the test gate because viewer assets and internal package outputs
are generated, ignored artifacts.

Pre-release editor setup must run the built CLI directly from this checkout:

```sh
node vendor/codemem/packages/cli/dist/index.js setup --opencode-only # or --claude-only / --codex-only
```

Setup records the absolute CLI, plugin, and hook runtime artifacts and their fingerprints.
Rebuild and rerun setup after moving or updating the checkout. npm/PATH-resolved codemem
runtimes are intentionally unsupported until free-mem publishes a release artifact.

## Release standard

Core 1.0 must be supported by evidence rather than feature presence alone. Planned
blocking evidence includes:

- sole-writer, authentication, redaction, spool, migration, and backup invariants;
- fault injection with no data loss, duplicate commit, split brain, or Agent blockage;
- deterministic same-Agent and Claude Code ↔ Codex continuation;
- wrong-project/workspace resume and unsafe unknown-operation replay count of zero;
- reproducible behavioral comparison against pinned public baselines;
- clean install, update, migration, rollback, doctor, backup/restore, and uninstall;
- signed artifacts, checksums, SBOM, and documented support dispositions.

The quality-gate plan is tracked in GitHub issue #8. Rust cutover is tracked in issue #1,
and namespace/data migration in issue #9.

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
Never include real credentials, private memory content, or local artifact paths in an
issue or test fixture.

## Licensing

free-mem is licensed under the Apache License 2.0 — see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE). The reasoning, dependency license scan, and per-directory material
breakdown are in [`evidence/adr-004-licensing.md`](evidence/adr-004-licensing.md).

Third-party material retains its own license. In particular `vendor/codemem/` is a pinned
MIT snapshot and is **not** relicensed by this repository; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Contributions are accepted under the same license, with a DCO sign-off — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).
