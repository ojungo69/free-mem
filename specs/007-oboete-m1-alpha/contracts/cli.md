# CLI Contract: `oboete` (M1)

Binary: `oboete` (npm `bin`), engine `dist/oboete.mjs`. All commands accept `--json` where output
is listed as structured. Exit codes: `0` success or explicit empty/degraded result, `1` target not
found or partially degraded, `2` invalid input or confirmation missing, `3` storage or I/O failure.
Commands invoked by agents (`hook`, `capture`, `inject`) always exit `0`.

| Command | Purpose | Input | Output |
|---|---|---|---|
| `oboete setup [--agents claude,codex,grok,pi] [--provider <preset>] [--yes] [--remove]` | Detect installed agents, show egress summary for a remote preset and require confirmation, write hook/extension configuration, write trust entries, run a headless probe per agent, report trust state and native-memory warnings | flags; `--yes` for non-interactive runs with a preset already confirmed in config | table or JSON: per agent `wired`, `probe`, `trust`, `native_memory` |
| `oboete doctor [--probe-provider]` | Health of hook wiring (by probe result and trust state), storage integrity and FTS5, worker liveness, spool backlog and writability, provider reachability, estimated allowance remaining and exhaustion flag, unrecognized agents, native memory coexistence, config file mode | | table or JSON; exit `1` when any item is degraded, `3` on storage integrity failure |
| `oboete hook` | Agent-invoked capture and injection entry for Claude Code, Grok Build, and Codex; reads the agent's JSON on stdin, detects the agent from the environment, captures, and prints a plain-text pack on injection events | stdin JSON | plain text pack or nothing; always exit `0` |
| `oboete capture --agent pi --event <name>` | Pi's detached capture child | stdin normalized event | none; exit `0` |
| `oboete inject --agent pi --kind start\|prompt` | Pi's bounded injection child | stdin `{ cwd, session_id, prompt? }` | plain text pack or empty; exit `0` |
| `oboete observe` | Detached worker: recover spool, claim lease, batch, classify, summarize, apply, purge, checkpoint, release | | logs to `~/.oboete/logs/observe.log`; exit `0` (done or another worker live), `1` fallback used, `3` unrecoverable storage error |
| `oboete search <query> [--limit N]` | Same-repository active memories by relevance (derives repository from cwd) | | list with scores and reasons; empty result still exit `0` with a reason |
| `oboete timeline [--session <id>]` | Sessions, turns, and memory metadata in order | | list |
| `oboete get <memory-id>` | One memory with provenance, citations, state, within the cwd repository boundary | | record; exit `1` if absent or out of boundary |
| `oboete why <session-id> [--turn N]` | Injection ledger: included and omitted candidates with reasons, trims, staleness, deferred and degraded state | | report |
| `oboete pin <id> [--order N]`, `oboete unpin <id>`, `oboete delete <id>` | Pin state and tombstone; delete never resurrects | | confirmation |
| `oboete pause`, `oboete resume` | Create or remove `~/.oboete/paused`; memories untouched | | confirmation |
| `oboete export [file\|-]`, `oboete import [file\|-] [--dry-run]` | JSONL transfer; import merges by `content_hash`, keeps deletions, never lowers sensitivity | | counts |
| `oboete mcp` | stdio MCP server exposing `search`, `timeline`, `get` under the cwd repository boundary | stdio JSON-RPC | see `mcp.md` |
| `oboete view [--port N]` | Local viewer bound to `127.0.0.1` with a per-launch token in the printed URL | | URL; runs in foreground; `2` on non-loopback host |
| `oboete fixture replay <file>` | Replay native payloads through the real hook and record evidence | | `docs/evidence/m1-resource-envelope.md` |

Environment: `OBOETE_HOME` relocates the data directory; `OBOETE_CF_API_TOKEN`,
`OBOETE_CF_ACCOUNT_ID`, `OBOETE_PROVIDER_API_KEY` supply credentials without writing them to the
config file; `OBOETE_TEST_FAULT` is honoured only when `NODE_ENV=test`.

Output rules: injection packs are plain factual text, never start with `{`, and carry the marker
lines `oboete memory context (do not restate)` / `end of oboete memory context`. Diagnostics and
logs never contain credential values or redacted content.
