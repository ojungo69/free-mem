# MCP Contract: `oboete mcp` (M1, legacy era)

Transport: stdio, newline-delimited JSON-RPC 2.0. Logging to stderr only. M1 implements the
legacy-era handshake only: `initialize` (protocol version negotiated from the client's request,
`capabilities.tools.listChanged = false`), `notifications/initialized`, `tools/list`, `tools/call`,
`ping`. `server/discover` and every other unknown method return JSON-RPC error `-32601` so clients
that implement the 2026-07-28 revision fall back to `initialize`. Whether Claude Code, Codex, and
Grok Build clients complete `tools/list` and `tools/call` against this server is a verification-gate
probe (research R13); a client that does not is marked unsupported in doctor and that agent uses
the CLI child path instead. A dual-era server is out of M1 scope.

Repository boundary: the server derives the repository identity from its own working directory with
the same function as capture; a `repo` argument in any call is rejected with `-32602`. Sensitivity
boundary: the shared query function with `destination = injection`.

| tool | arguments | result |
|---|---|---|
| `search` | `query` (string), `limit` (int, default 10) | `{ memories: [{ id, type, title, body, sensitivity, created_at, citations, score, stale }], degraded: string \| null }` |
| `timeline` | `session` (string, optional), `limit` | `{ sessions: [{ id, agent, started_at, ended_at, turns: [{ ordinal, memory_ids }] }] }` |
| `get` | `id` (string) | one memory with provenance, or `-32004` not found (also for out-of-boundary ids) |

Registration (verified by the R13 probe and the E2E run):

- Claude Code: `claude mcp add oboete -- "<node>" "<bundle>" mcp` (user scope)
- Codex: `[mcp_servers.oboete] command = "<node>" args = ["<bundle>", "mcp"]` inside the managed
  block of `~/.codex/config.toml`
- Grok Build: its MCP server configuration if the probe confirms one; otherwise the CLI child path
- Pi: not registered; Pi tools call the CLI as child processes
