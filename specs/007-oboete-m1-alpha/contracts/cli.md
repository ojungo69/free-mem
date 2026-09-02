# CLI Contract: `oboete` (M1)

Binary: `oboete` (npm `bin`), engine `dist/oboete.mjs`. All commands accept `--json` where output
is listed as structured. Exit codes: `0` success or explicit empty/degraded result, `1` target not
found or partially degraded, `2` invalid input or confirmation missing, `3` storage or I/O failure.
Commands invoked by agents (`hook`, `capture`, `inject`) always exit `0`.

| Command | Purpose | Input | Output |
|---|---|---|---|
| `oboete setup [--agents claude,codex,grok,pi] [--provider <preset>] [--accept-egress] [--yes] [--remove]` | Detect installed agents; for a remote preset show destination host, credential source, cost class, and egress, then require confirmation (`--accept-egress` on the command line, or `--yes` only when the stored consent hash equals the hash of the tuple setup would display now: preset, host, credential source, cost class, egress classes); write hook and extension configuration through oboete-managed blocks (backup preserving mode and owner, 0600 for credential-bearing files; write to a temporary file, re-parse, rename); handlers carry fixed `--agent` selectors; write trust entries; run headless probes for all selected agents in parallel under a 90 s deadline; report trust state and native-memory warnings | flags | table or JSON: per agent `wired`, `probe`, `trust`, `native_memory`; exit `1` if any probe failed, `2` if consent is missing |
| `oboete doctor [--probe-provider]` | Hook wiring by last probe result and trust state, storage integrity and FTS5, migration level, worker liveness, spool backlog and writability, provider reachability, estimated allowance and exhaustion flag, catalog paid-plan flag, unrecognized agents, native memory coexistence, config file mode, Pi diagnostics | | table or JSON; exit `1` when any item is degraded, `3` on storage integrity failure |
| `oboete hook --agent codex\|claude-or-grok` | Agent-invoked entry: reads stdin JSON, resolves `claude-or-grok` from `GROK_HOOK_EVENT`/`GROK_SESSION_ID`, checks the paused marker, applies the size cap and detector before any write, captures or spools, prints a plain-text pack on injection events | stdin JSON | pack or nothing; exit `0` |
| `oboete capture --agent pi --event <name>` | Pi's detached capture child; writes `spool/pi-ack/<event id>` on completion | stdin normalized event | none; exit `0` |
| `oboete inject --agent pi --kind start\|prompt` | Pi's bounded injection child | stdin `{ cwd, session_id, prompt? }` | pack or empty; exit `0` |
| `oboete observe` | Detached worker: recover spool, claim the fenced lease, purge expired rows, batch by destination, classify, summarize with deadlines, apply, checkpoint, release atomically with the empty-queue check | | `~/.oboete/logs/observe.log`; exit `0` (done or another worker live), `1` fallback used, `3` unrecoverable storage error |
| `oboete search <query> [--limit N]` | Same-repository active memories by relevance (repository from cwd; shared query function, `destination = injection`) | | list with scores and reasons; empty result exit `0` with a reason |
| `oboete timeline [--session <id>]` | Sessions, turns, memory metadata | | list |
| `oboete get <memory-id>` | One memory with provenance within the cwd repository boundary | | record; `1` if absent or out of boundary |
| `oboete why <session-id> [--turn N]` | Injection ledger with reasons, trims, staleness, deferred and degraded state | | report |
| `oboete pin <id> [--order N]`, `unpin <id>`, `delete <id>` | Pin state and tombstone | | confirmation |
| `oboete pause`, `oboete resume` | Create or remove `~/.oboete/paused` | | confirmation |
| `oboete export [file\|-]` | JSONL `oboete-export/1` with active memories and tombstones | | count |
| `oboete import [file\|-] [--dry-run] [--map-repo <old-id>=<current>]` | Per-line validated import (64 KB per line, 256 MB per file), derived fields recomputed, `content_hash` verified against the body, union on `content_hash`, lattice `secret > private > local_only > eligible`, tombstones win, active rows land as `local_only` / `review_state = imported`; `--map-repo` maps a machine-local (`common_dir`) repository identity from another installation onto a repository here | | counts; `2` on invalid format |
| `oboete mcp` | Legacy-era stdio MCP server (`search`, `timeline`, `get`) under the cwd boundary | stdio JSON-RPC | see `mcp.md` |
| `oboete view [--port N]` | Local viewer on `127.0.0.1` with a per-launch token | | URL; foreground; `2` on non-loopback host |
| `oboete fixture replay <file>` | Replay native payloads through the real hook and record evidence | | `docs/evidence/m1-resource-envelope.md` |

Environment: `OBOETE_HOME` relocates the data directory; `OBOETE_CF_API_TOKEN`,
`OBOETE_CF_ACCOUNT_ID`, `OBOETE_PROVIDER_API_KEY` supply credentials without writing them to the
config file; `OBOETE_TEST_FAULT` is honoured only when `NODE_ENV=test`.

Output rules: packs are plain factual text framed by the label lines `oboete memory context` and
`end of oboete memory context`, never start with `{`, and quote bodies with a `> ` prefix.
Diagnostics and logs never contain credential values or redacted content. The remote observer never receives the normalized repository identity or path, only the repository id.
