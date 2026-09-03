# verify-tasks report

Date: 2026-09-03 | Scope: all (origin/main...HEAD plus staged changes) | Completed tasks checked: 6

> ⚠️ FRESH SESSION ADVISORY: this run was performed inline by the implementing session (the optional
> `speckit.verify-tasks.run` hook re-runs it in a fresh session; not executed here).

## Scorecard

| verdict | count |
|---|---|
| ✅ VERIFIED | 6 |
| 🔍 PARTIAL | 0 |
| ⚠️ WEAK | 0 |
| ❌ NOT_FOUND | 0 |
| ⏭️ SKIPPED | 0 |

## Flagged items

None.

## Verified items

| task | verdict | summary |
|---|---|---|
| T001 | ✅ VERIFIED | docs/research/m1-amendments-2026-09.md, CONSTITUTION.md and .specify/memory/constitution.md exist and changed on the branch; both constitution copies carry version 3.1.0; spec.md amended. ⚠️ Interpretive: decision table A1-A17 present with rationale. |
| T002 | ✅ VERIFIED | docs/research/isolated-user-setup.md exists and changed; `id oboete-dogfood` resolves (uid 1001); the four CLIs answered headless in this session. ⚠️ Interpretive: the handbook covers user creation, Node, four logins, clone, credentials file. |
| T003 | ✅ VERIFIED | scripts/e2e/probe-contracts.mjs plus probe-lib/ and probes/ exist (staged); docs/research/oboete-contracts-probes.md carries one dated section written by `--report`; every exported helper in probe-lib/agents.mjs is referenced from the runner or a probe file (SESSION_MS is used as the runTimed default). ⚠️ Interpretive: the runner loads probes/*.mjs, isolates each agent's configuration, writes report.json and appends the markdown section; a full `--all` run reproduced 13 of 14 statuses independently, and the one mismatch (Pi thinking block) was fixed and re-run. |
| T004 | ✅ VERIFIED | 16 fixtures under test/contracts/{claude,codex,grok,pi}/ (4 per agent) with native_tool, normalized_tool and both hook payloads; no `oboete-dogfood` string remains. |
| T009 | ✅ VERIFIED | probes doc rows claude/codex/grok-oversized-stdin = pass, pi = skipped with reason; Findings section records the runner payload caps. |
| T010 | ✅ VERIFIED | docs/research/context-windows.md with 11 verified rows, runtime-id mapping rules and the smallest window per agent; every row names a primary source and its quoted statement. |

## Unassessable items

None.

## Verdict lines

| T001 | ✅ VERIFIED | amendments recorded, constitution 3.1.0 |
| T002 | ✅ VERIFIED | isolated user exists, handbook committed |
| T003 | ✅ VERIFIED | probe harness present, runs, appends report |
| T004 | ✅ VERIFIED | 16 payload fixtures |
| T009 | ✅ VERIFIED | oversized-stdin rows recorded |
| T010 | ✅ VERIFIED | context-windows.md |
