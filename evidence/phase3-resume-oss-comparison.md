# Phase 3 resume / continuity OSS comparison

Date: 2026-08-16  
Scope: `free-mem` Phase 3 preflight  
Related: #1, #8, #13

## Purpose

This document compares public behavior, public documentation, and public source from memory and agent-runtime projects that directly inform reliable work resumption. It does not attempt to reproduce private prompts, private services, or undocumented implementation details.

The comparison is driven by nine concrete gaps found in the current `free-mem` v6.1 continuity design:

1. exact Claude/Codex prompt-aware and compact injection capability is not yet proven by the repository's real-CLI matrix;
2. `ContinuationCheckpoint.canonicalStateJson` is untyped;
3. one mutable `SessionWorkState` can mix unrelated tasks;
4. checkpoint delivery is accepted after the first successful turn even when the resume was wrong;
5. in-flight commands and tools lack a first-class `unknown result` representation;
6. checkpoint state is not reconciled precisely enough against the current workspace;
7. resume mode semantics conflict around `off` and compact recovery;
8. the injection envelope lacks a normative safe serialization contract;
9. v6.1 and #8 disagree on whether claude-mem non-inferiority blocks Core 1.0.

## Sources and reproducibility

| Project | Public source inspected | What was evaluated |
|---|---|---|
| claude-mem | `thedotmack/claude-mem`, public source around commit `d768ba364302d12b76e69e4f021f0bb1d2d50ed6`; `src/cli/handlers/context.ts`; `src/services/context/ContextBuilder.ts`; `src/servers/mcp-server.ts`; public hook architecture docs | SessionStart injection, timeline/summary construction, fail-open behavior, progressive disclosure |
| LangGraph | official persistence/checkpointer/time-travel documentation; `langchain-ai/langgraph` around commit `644815f9e5bc52ad8f7a5227a456227e9c3e639b` | thread checkpoints, task-level pending writes, replay, immutable fork, long-term store separation |
| Letta | official memory-block, archival-memory, context-hierarchy, and stateful-agent documentation | bounded always-visible working memory, archival retrieval, persistent messages, shared block behavior |
| Graphiti | official Graphiti/Zep docs and `getzep/graphiti` public source | temporal validity, invalidation rather than deletion, episode provenance, hybrid retrieval |
| Mem0 | official memory lifecycle, add/search, history, and async-memory documentation | additive extraction, scope isolation, explicit mutation, old/new change history |
| Hindsight | official retain/recall/observation documentation and `vectorize-io/hindsight` public docs around commit `396f63aafc9b618f04d446e2465cac95aa1cb426` | evidence-grounded observations, source-fact linkage, presentation-level dedupe, RRF and token budgets |
| Cline | official task-management/checkpoint documentation and public checkpoint manager source around commit `8bbdde2a5c1f972864fe1b954f639c21fac61a40` | resumable tasks, conversation/workspace checkpoint separation, shadow Git, restore and drift warning UX |

External documentation changes over time. The implementation phase must pin exact source commits or documentation captures in a benchmark manifest before using any behavior as a release claim.

## Comparison matrix

| Concern | claude-mem | LangGraph | Letta | Graphiti | Mem0 | Hindsight | Cline | free-mem decision |
|---|---|---|---|---|---|---|---|---|
| Immediate resume UX | silent SessionStart `additionalContext` | resume thread checkpoint | core blocks always visible | retrieval-driven | application calls search | application calls recall | reopen task with full history | retain silent bounded hint; full resume only after capability/relevance gate |
| Working state vs durable memory | observations/summaries are mixed into context timeline | checkpointer vs Store are separate | memory blocks vs archival memory | episodes vs derived facts | memory rows vs source input/history | facts vs observations | task history vs workspace snapshot | task-scoped work state, checkpoint, and DurableMemory remain separate |
| In-flight work | no public typed pending-operation contract found | task/node pending writes are durable | messages/tools persist, but not a coding-specific replay policy | episode provenance, not execution continuation | async operation status/history | async retain/consolidation operations | task and file checkpoints | first-class `PendingOperation` with `never_auto`, `verify_first`, or `safe_idempotent` |
| History/fork | session timeline | immutable checkpoint history and fork | persistent messages/blocks; shared block update can be LWW | temporal fact history | ADD/UPDATE/DELETE history with old/new | source facts remain behind observations | checkpoint history and restore options | immutable checkpoint revisions and separate delivery attempts; no silent overwrite |
| Stale facts | recent timeline but no explicit validity window in the inspected resume path | user updates state by creating a new checkpoint | blocks are current mutable state | `valid_at` / `invalid_at`, superseded facts retained | explicit update/delete and history | observations refine from source evidence | compare/restore workspace snapshot | reconciliation status plus temporal validity and source-event lineage |
| Concurrency | local worker/session behavior | checkpoint namespace, task writes, fork | shared blocks warn about last-write-wins | graph updates preserve temporal history | scoped operations/history | bank isolation and evidence links | task-scoped checkpoint manager | CAS/fence delivery attempt; task lineage; no LWW for canonical state |
| Workspace state | project name/worktree context in recent versions | application-defined state | external state can be mirrored in blocks | not coding-workspace specific | metadata filters | tags/scopes | shadow Git checkpoint with file/task/both restore | deterministic reconciliation in Core 1.0; optional snapshot provider later |
| Injection safety | hook output + bounded context settings | application owns prompt rendering | XML-like blocks | application owns rendering | application owns rendering | application owns rendering | native task UI | schema-validated JSON capsule, escaped wrapper, hash/length/version/provenance |
| Retrieval duplication | timeline + summary may overlap | application-defined | hierarchy avoids loading archival by default | hybrid graph retrieval | dedup during extraction/search | `prefer_observations` hides source duplicates without deleting them | not a memory retrieval engine | preserve raw evidence and derived observations; suppress duplicates at pack time |

## Detailed findings and adoption decisions

### 1. claude-mem: copy the smoothness, not the ambiguity

The inspected hook handler returns prior context through `hookSpecificOutput.additionalContext`, and returns an empty context when the worker path fails. `ContextBuilder` composes a bounded timeline from recent observations and session summaries, with optional full observations and previous messages.

This is the strongest immediately useful UX pattern:

- context arrives silently before the model works;
- memory failure does not block the coding agent;
- the user does not need to call a manual search tool for ordinary continuation;
- timeline, recent summary, and selected full observations support progressive disclosure.

However, the inspected path primarily selects by project/recent observations. It does not provide a coding-specific typed checkpoint that proves the current prompt continues the same task, nor a normative workspace reconciliation state machine.

**Adopt**

- silent `additionalContext` injection;
- empty-context fail-open result;
- a very small SessionStart hint;
- timeline/search/get progressive disclosure;
- per-platform output-size handling.

**Do not adopt**

- treating recent project context as proof of task continuation;
- direct reader-side SQLite access;
- automatically injecting a large previous timeline before seeing the new prompt.

### 2. LangGraph: checkpoint execution state separately from long-term memory

LangGraph explicitly separates a thread-scoped checkpointer from a cross-thread Store. A checkpoint is a state snapshot at a super-step boundary; individual task writes can be persisted before the whole step finishes. A prior checkpoint can be replayed, or `update_state` can create a fork without overwriting the original history.

This directly closes three free-mem gaps:

- DurableMemory must not substitute for execution continuation;
- successful and unfinished operations must be distinguishable after a crash;
- correcting a resume state must create a new revision/fork, not mutate historical evidence.

**Adopt**

- immutable checkpoint IDs and history;
- task-scoped checkpoint namespace;
- durable task/pending-operation records;
- explicit replay policy rather than automatic command replay;
- corrections as new revisions/forks.

### 3. Letta: use a bounded working-state capsule

Letta's memory blocks are named, purpose-described, bounded pieces of context that remain visible, while archival memory is retrieved only when needed. All messages remain persisted even after context eviction.

The useful lesson is not agent-editable memory itself; it is the hierarchy:

- the smallest critical current state is always easy to inject;
- large historical memory stays out of the prompt until queried;
- each working block has a clear purpose and size limit.

**Adopt**

- a bounded resume capsule with an explicit purpose;
- strict separation between current task state and archival DurableMemory;
- persistent evidence even after compact/eviction.

**Reject**

- agent-writable canonical observed state;
- last-write-wins shared state. Canonical state remains daemon-owned and evidence-derived.

### 4. Graphiti: make staleness and supersession explicit

Graphiti keeps temporal validity windows and traces derived facts to source episodes. When a fact changes, the old fact is invalidated rather than erased.

For coding continuity, the equivalent is:

- a file, test result, decision, or next action was valid at checkpoint time;
- current repository evidence may make it stale or incompatible;
- the historical record remains inspectable;
- the injected capsule must say which fields require verification.

**Adopt**

- `validFrom`, `invalidatedAt`, and superseding revision links where applicable;
- source-event lineage for every derived semantic note;
- reconciliation categories instead of a binary match/no-match;
- point-in-time diagnostics.

### 5. Mem0: preserve mutation history and make correction explicit

Mem0 exposes memory history with ADD/UPDATE/DELETE events and old/new values. Its additive path can add new facts without silently rewriting old ones; explicit update/delete operations remain available.

**Adopt**

- append-only work-state/checkpoint revision history;
- explicit supersede/dismiss/retract operations;
- old/new/source metadata for audit and debugging;
- strong scope filters.

**Do not adopt blindly**

- generic LLM extraction as authority for current repository state;
- vector retrieval as the sole source of truth.

### 6. Hindsight: derive observations without deleting evidence

Hindsight's observations are evidence-grounded consolidations that retain references to source facts. Retrieval may prefer an observation and hide duplicate source facts in the returned pack while keeping both in storage. Its retrieval uses several strategies, RRF, reranking, and token budgets.

**Adopt**

- semantic resume notes and consolidated memories must list source event/fact IDs;
- refinement never deletes raw evidence;
- pack-time `prefer_consolidated` dedupe rather than storage-time destruction;
- token-budget-first output selection;
- retain RRF rather than adding incomparable raw scores.

### 7. Cline: reconcile task context and workspace state independently

Cline persists tasks across sessions and uses a separate shadow Git repository for project-file checkpoints. Users can restore task context, workspace files, or both; task-only restore can warn when files changed after the checkpoint.

The important design boundary is that conversational/task state and filesystem state are separate artifacts.

**Adopt now**

- independent task-state and workspace-state reconciliation;
- explicit drift warnings;
- future interfaces that permit `task`, `workspace`, or `both` restore authority;
- compare-before-restore UX.

**Defer**

- mandatory shadow Git after every tool action. Core 1.0 only records repository identity, HEAD, dirty fingerprint, affected-file evidence, and pending operations. A `WorkspaceSnapshotProvider` can be evaluated after measured demand and security review.

## Resulting free-mem architecture

```text
NormalizedEvent stream
        │
        ├── immutable evidence / event history
        │
        ├── TaskWorkState (one canonical state per taskLineageId)
        │       ├── Observed<T> provenance
        │       ├── PendingOperation[]
        │       └── RepositoryStateSnapshot
        │
        ├── ContinuationCheckpoint revision
        │       └── immutable task-state snapshot
        │
        ├── CheckpointDeliveryAttempt
        │       └── claim / lease / fence / engagement / acceptance
        │
        └── DurableMemory / derived observations
                ├── source evidence links
                ├── temporal validity / supersession
                └── search-time consolidation preference
```

Before full injection:

```text
exact-version capability strategy
        +
current prompt relevance
        +
workspace reconciliation
        +
CAS delivery claim
        ↓
typed, bounded, safely serialized resume capsule
```

## Decisions that supersede v6.1 continuity details

The normative addendum `specs/001-agent-memory-core/resume-continuity-addendum-v6.2.md` supersedes v6.1 only for the following continuity details:

- session-scoped work state becomes task-lineage scoped;
- `canonicalStateJson: unknown` is not a release contract;
- delivery state is separated from immutable checkpoint content;
- acceptance requires engagement evidence;
- workspace reconciliation precedes automatic full injection;
- exact CLI capability determines the resume strategy;
- `off` disables every automatic hint/injection, including compact;
- the SessionStart hint budget is reduced;
- safe JSON capsule rendering is mandatory;
- #8 non-inferiority is a Core 1.0 blocking gate.

All Phase 1 safety invariants remain unchanged.

## Licensing and provenance

This document adopts architectural patterns, public behavior, and interface ideas only. It does not copy implementation code. Any future code-level port must identify the exact source file, commit, license, and copied/derived range, then pass #10 before merge.
