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

## Known gap: notices for code bundled into the publishable packages

Each publishable package is built with Vite, and whatever its `rollupOptions.external` does not
cover is inlined into the shipped output. Measured on 2026-08-17 by building the vendored tree and
reading the emitted source maps:

| Package | Bundled third-party code |
|---|---|
| `codemem` (cli) | `@clack/prompts`, `@clack/core`, `omelette`, `sisteransi`, `fast-string-width`, `fast-string-truncated-width`, `fast-wrap-ansi` |
| `@codemem/core` | `hono` (18 modules) |
| `@codemem/mcp` | none — its `external` list covers every dependency |
| `@codemem/server` | `@hono/node-server` (2 modules), plus `static/app.js` built from the private `@codemem/ui` package: `preact`, `@preact/signals`, `@radix-ui/*`, `dompurify` |

`static/app.js` emits no source map, so it was checked by identifier; it contains no license or
copyright text at all. Those licenses require their notices to travel with redistributed copies, and
a published tarball would carry only codemem's MIT `LICENSE`.

Nothing is published today — no tag, package, or release exists — so no redistribution has happened.
Shipping a bundled-dependency notice artifact and verifying it in the packed tarball is a blocker for
the first `npm publish`, tracked in [#50](https://github.com/ojungo69/free-mem/issues/50).
`harness/license-inclusion-check.mjs` does not cover this and does not claim to: it checks
package-level `LICENSE` files, not build output.

Re-run the scan whenever the lockfile changes; `evidence/adr-004-licensing.md` records how these
findings feed the license decision.
