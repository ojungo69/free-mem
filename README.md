# free-mem

> **Pre-release source.** This repository is under active development and is not a
> Core 1.0 release. Do not use it with production secrets or irreplaceable memory data.

free-mem is a local-first agent-memory continuity project for Claude Code and Codex.
The current work is Phase 1: establishing the sole-writer, authentication, redaction,
spool, migration, and backup safety boundary.

## Status

- Phase 1 is incomplete; follow the checked state in
  [`specs/001-agent-memory-core/tasks.md`](specs/001-agent-memory-core/tasks.md).
- No package, release artifact, compatibility promise, or support promise is made yet.
- Public source visibility does not change the local-only runtime and data boundary.

## Repository layout

- `vendor/codemem/`: modified pinned snapshot that contains the product workspace
- `specs/001-agent-memory-core/`: implementation plan, contracts, and task gates
- `evidence/`: frozen base-selection and safety evidence
- `harness/`: version-pinned adapter and sidecar contract fixtures

The base snapshot provenance is recorded in
[`vendor/codemem/VENDOR.md`](vendor/codemem/VENDOR.md).

## Development

The frozen toolchain is Node.js 24.16.0 and pnpm 11.8.0.

```sh
cd vendor/codemem
corepack pnpm install --frozen-lockfile
corepack pnpm run build
CI=true corepack pnpm run check
```

The build runs before the test gate because viewer assets and internal package outputs
are generated, ignored artifacts.

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
Never include real credentials, private memory content, or local artifact paths in an
issue or test fixture.

## Licensing

No repository-wide license grant has been made. Third-party material retains its own
license; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
