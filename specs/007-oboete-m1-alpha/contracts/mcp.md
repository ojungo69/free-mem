# MCP Contract: `oboete mcp` (M1)

Transport: stdio, newline-delimited JSON-RPC 2.0. Logging to stderr only. Implemented methods:
`initialize` (legacy handshake), `server/discover` (current spec revision), `notifications/initialized`,
`tools/list`, `tools/call`, `ping`. Unknown methods return JSON-RPC error `-32601`.

Repository boundary: the server derives the repository identity from its own working directory with
the same function as capture; a `repo` argument in any call is rejected with `-32602`. Sensitivity
boundary: the same query function as injection (`destination = injection`).

| tool | arguments | result |
|---|---|---|
| `search` | `query` (string), `limit` (int, default 10) | `{ memories: [{ id, type, title, body, sensitivity, created_at, citations, score, stale }], degraded: string \| null }` |
| `timeline` | `session` (string, optional), `limit` | `{ sessions: [{ id, agent, started_at, ended_at, turns: [{ ordinal, memory_ids }] }] }` |
| `get` | `id` (string) | one memory with provenance (`agent`, `session_id`, `batch_id`, `degraded_reason`) or `-32004` not found (also for out-of-boundary ids) |

Registration (verified in E2E):

- Claude Code: `claude mcp add oboete -- "<node>" "<bundle>" mcp` (user scope)
- Codex: `[mcp_servers.oboete] command = "<node>" args = ["<bundle>", "mcp"]` in `~/.codex/config.toml` (appended table)
- Grok Build: its MCP server configuration file with the same command
- Pi: not registered; Pi tools call the CLI as child processes

Server metadata: `name: oboete`, `version` from `package.json`; `capabilities.tools.listChanged =
false`.
