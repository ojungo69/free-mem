# Third-party notices

## codemem

- Upstream: [`kunickiaj/codemem`](https://github.com/kunickiaj/codemem)
- Snapshot: `26438e75ce1d0fec6be34981f15045a15c89658b` (upstream v0.40.2 equivalent)
- Location: `vendor/codemem/`
- License: MIT
- Copyright: 2026 Adam Kunicki

The upstream license text is retained at
[`vendor/codemem/LICENSE`](vendor/codemem/LICENSE). Local provenance and update
policy are recorded in [`vendor/codemem/VENDOR.md`](vendor/codemem/VENDOR.md).

This snapshot stays under MIT. The repository's own Apache-2.0 grant does not extend
to it, and free-mem headers are not added to files under `vendor/codemem/`.

## Dependency licenses

The dependency tree is not vendored — it is resolved from the lockfile at install time.
The inventory below was measured on 2026-08-16 with pnpm 11.8.0 against the committed
`vendor/codemem/pnpm-lock.yaml`:

```bash
cd vendor/codemem
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm licenses list --json          # all
corepack pnpm licenses list --json --prod   # what ships
```

| Scope | Packages | Breakdown |
|---|---|---|
| All (incl. dev) | 455 | MIT 366 / Apache-2.0 22 / BSD-3-Clause 20 / ISC 20 / BSD-2-Clause 9 / other 18 |
| Production only | 261 | MIT 208 / Apache-2.0 17 / BSD-3-Clause 14 / ISC 12 / other 10 |

Findings that need a recorded decision or correction:

| Package | Reported | Actual / choice |
|---|---|---|
| `flatbuffers@1.12.0` | `Unknown` | **Apache-2.0.** `package.json` says `SEE LICENSE IN LICENSE.txt`; the bundled `LICENSE.txt` is Apache-2.0 (upstream `google/flatbuffers`). Reached via `@codemem/core → @xenova/transformers → onnxruntime-web`. |
| `dompurify` | `(MPL-2.0 OR Apache-2.0)` | **Apache-2.0 branch chosen.** |
| `sqlite-vec`, `sqlite-vec-linux-x64` | `MIT OR Apache` (non-SPDX string) | **MIT branch chosen.** |
| `lightningcss`, `lightningcss-linux-x64-gnu` | `MPL-2.0` | Build-time only (viewer CSS). Not present in the production tree, not redistributed. |
| `caniuse-lite` | `CC-BY-4.0` | Dev-only dataset. |
| `mdn-data` | `CC0-1.0` | Dev-only dataset. |

No copyleft-only package is present in the production dependency tree.

## Notices for code bundled into the publishable packages

Each publishable package is built with Vite, and whatever its `rollupOptions.external` does not
cover is inlined into the shipped output. Every build now emits a `THIRD_PARTY_NOTICES.md` next to
that output, generated from the **bundler's module graph** rather than from the build artifact, so
it stays correct for outputs that carry no source map. Generation lives in one place,
`vendor/codemem/scripts/license-notice-plugin.mjs`.

Measured on 2026-08-18 against `origin/main`:

| Package | Notice location | Bundled third-party code |
|---|---|---|
| `codemem` (cli) | `dist/THIRD_PARTY_NOTICES.md` | none — the `--ssr` build keeps dependencies external |
| `codemem` (cli) | `dist/THIRD_PARTY_NOTICES.hook-runtime.md` | `commander`, `@codemem/core` |
| `@codemem/core` | `dist/THIRD_PARTY_NOTICES.md` | `hono` |
| `@codemem/mcp` | `dist/THIRD_PARTY_NOTICES.md` | none |
| `@codemem/server` | `dist/THIRD_PARTY_NOTICES.md` | none |
| `@codemem/server` | `static/THIRD_PARTY_NOTICES.md` | 47 packages — `preact`, `@preact/signals(-core)`, 21 × `@radix-ui/*`, 4 × `@floating-ui/*`, `dompurify`, `marked`, `tslib`, `aria-hidden`, `get-nonce`, `react-remove-scroll(-bar)`, `react-style-singleton`, `use-callback-ref`, `use-sidecar` |

A package that bundles nothing still ships a notice file saying so. The absence of a file is treated
as a failure, not as "zero dependencies" — otherwise a broken generator would be indistinguishable
from an artifact that genuinely bundles nothing.

Eleven of the 47 packages in `static/THIRD_PARTY_NOTICES.md` ship no license file of their own
(several `@radix-ui/*` sub-packages among them). Their entries record the SPDX identifier declared in
`package.json` and state explicitly that upstream ships no license file, rather than omitting the
entry. Whether recording the SPDX identifier is sufficient where upstream ships neither a license file
nor a copyright line — as opposed to supplying the canonical license text under a copyright holder we
would have to infer — is an open question, tracked in
[#81](https://github.com/ojungo69/free-mem/issues/81).

`harness/notice-inclusion-check.mjs` enforces this. It runs the install and the build itself, packs
each publishable package with `pnpm pack`, extracts the tarball, and checks the notices inside it.
The expected dependency names — and a SHA-256 digest of each license body — are pinned as a
**complete set** in `harness/notice-baseline.json`, and the set of notice files is compared too, so a
missing dependency, a missing file, an unexpected addition, and a license text that no longer matches
all fail. Regenerate with `--write-baseline` when dependencies legitimately change; the diff
is then part of the commit under review, the same arrangement as `harness/contract-hashes.json`. It
runs from three places: its own CI job, `scripts/release-tag-preflight.sh` (which the release
workflow calls before tagging), and each publishable package's `prepublishOnly` script. It does not
cover `npm publish --ignore-scripts`, nor a publish made outside the release workflow — restricting
publish rights to the protected workflow is tracked in
[#83](https://github.com/ojungo69/free-mem/issues/83).
`harness/license-inclusion-check.mjs` remains separate and still does not look at build
output: it checks package-level `LICENSE` files.

### Bundled code outside the npm packages

`vendor/codemem/plugins/claude/scripts/hook-runtime.mjs` and its `plugins/codex/` counterpart are
committed copies of the `hook-runtime` bundle, produced by `packages/cli/scripts/sync-hook-runtime.mjs`.
They contain `commander` (MIT, Copyright (c) 2011 TJ Holowaychuk) and carry no copyright text of
their own. They are not part of any npm package's `files`, so the tarball gate does not cover them;
they are redistributed through the GitHub source archive, and this file is the notice that travels
with that archive.

`@codemem/opencode-plugin` is a permanent blind spot for the module-graph approach: its shipped
artifacts are committed to git rather than produced by a rollup build. Measured on 2026-08-18 it
bundles no third-party code — every import is external — so no notice is generated for it.

Re-run the scan whenever the lockfile changes; `evidence/adr-004-licensing.md` records how these
findings feed the license decision.
