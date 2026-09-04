# oboete M1 dogfood evidence

Isolated-user cross-agent runs for SC-001, SC-004, and SC-007.

## 2026-09-04 run 2026-09-04T15-18-20-953Z

- 6 of 12 pairs pass
- No provider credentials: no
- Report: <run>/report.json

| seed | receive | status | elapsed ms | missing facts |
|---|---|---:|---:|---|
| claude | codex | pass | 93189 | none |
| claude | grok | fail | 42660 | fact-2026-09-04T15-18-20-953Z-claude-to-grok-1: the build token is cedar.; fact-2026-09-04T15-18-20-953Z-claude-to-grok-2: the release bird is heron.; fact-2026-09-04T15-18-20-953Z-claude-to-grok-3: 配布色は琥珀。 |
| claude | pi | pass | 67683 | none |
| codex | claude | pass | 65183 | none |
| codex | grok | fail | 64271 | fact-2026-09-04T15-18-20-953Z-codex-to-grok-1: the build token is cedar.; fact-2026-09-04T15-18-20-953Z-codex-to-grok-2: the release bird is heron.; fact-2026-09-04T15-18-20-953Z-codex-to-grok-3: 配布色は琥珀。 |
| codex | pi | pass | 75516 | none |
| grok | claude | fail | 2242 | fact-2026-09-04T15-18-20-953Z-grok-to-claude-1: the build token is cedar.; fact-2026-09-04T15-18-20-953Z-grok-to-claude-2: the release bird is heron.; fact-2026-09-04T15-18-20-953Z-grok-to-claude-3: 配布色は琥珀。 |
| grok | codex | fail | 2150 | fact-2026-09-04T15-18-20-953Z-grok-to-codex-1: the build token is cedar.; fact-2026-09-04T15-18-20-953Z-grok-to-codex-2: the release bird is heron.; fact-2026-09-04T15-18-20-953Z-grok-to-codex-3: 配布色は琥珀。 |
| grok | pi | fail | 2506 | fact-2026-09-04T15-18-20-953Z-grok-to-pi-1: the build token is cedar.; fact-2026-09-04T15-18-20-953Z-grok-to-pi-2: the release bird is heron.; fact-2026-09-04T15-18-20-953Z-grok-to-pi-3: 配布色は琥珀。 |
| pi | claude | pass | 62417 | none |
| pi | codex | pass | 72459 | none |
| pi | grok | fail | 63601 | fact-2026-09-04T15-18-20-953Z-pi-to-grok-1: the build token is cedar.; fact-2026-09-04T15-18-20-953Z-pi-to-grok-2: the release bird is heron.; fact-2026-09-04T15-18-20-953Z-pi-to-grok-3: 配布色は琥珀。 |

### Why the six Grok Build pairs failed

Every failing pair is a Grok Build leg. The Grok Build account the isolated user holds has no
credit left, so `grok -p` exits 1 without reaching a hook:

```
{"type":"error","message":"Internal error: {\n  \"message\": \"API error (status 402 Payment Required): Grok Build usage balance exhausted\",\n  \"http_status\": 402\n}"}
```

The three `grok` seeding pairs fail in about 2 s (the account cannot start a session at all) and the
three `grok` receiving pairs fail after the seed and the summary succeeded. Nothing in oboete is
implicated: the six pairs among Claude Code, Codex and Pi pass, including both directions of every
one of those three agents. SC-001 stays open until the balance is restored and the run repeats.

### What this run does and does not prove

The Codex legs run with `--dangerously-bypass-hook-trust`, because the harness copies `hooks.json`
into the pair directory while a Codex trust key names the absolute path of the original file. So
this run does not gate the trust-hash rule; that gap is being closed separately.
