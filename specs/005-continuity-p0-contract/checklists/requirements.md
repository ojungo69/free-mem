# Specification Quality Checklist: Continuity P0 + source-aware shared memory 契約の凍結

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-24
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No accidental implementation choices beyond the mandated TS/Rust/JSON-Schema cross-runtime contract and artifact paths
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are independent of implementation internals while explicitly naming the required TS/Rust parity targets
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation-specific algorithm leaks beyond the exact wire/hash/schema contract being frozen

## Notes

既存3件と、spec 005 / #132の統合方針はユーザー判断で解決済み（2026-08-24）。全項目 pass。

| 論点 | 決定 | 反映先 |
|---|---|---|
| 層 A / D の出し方 | **1つのcontract bundle/hashで同時freeze**。work state V2 / checkpoint V3 / capsule V2 / memory entity V1 | FR-015 / FR-015a〜e |
| 上限超過時の扱い | **上限ごとに規定**。選択型は絞る、容量型は拒否する | FR-024 / FR-024a / FR-024b |
| fixture の範囲 | **F0〜F7 contract corpusはS0へ統合**。層A〜Cのruntime fixtureは #66 / #67 / #8 へ | FR-029 / FR-029a〜d |
| canonical fact identity | **完全一致だけ自動統合**。言い換えは明示review後にmerge | FR-042 / F4 |

`spec.md` の「Success Criteria are technology-agnostic」については、`stateRevision` / `contentHash` /
`IsoTimestamp` など**正典仕様 v6.1 が定義する契約上の名前**は残している。これらは実装技術ではなく
凍結済み契約の語彙であり、置き換えると指している対象が曖昧になる。

FR-027 と SC-012 が TypeScript / Rust に触れているのは、この feature の目的が
「両者が同じ fixture で同一結果を出せる契約を凍結すること」だからで、実装技術の選定ではない。

## 次の段階

`/speckit-plan` へ進める状態。plan.md の Constitution Check では、Principle VI（ローカル完結）が
現在の GitHub PR 運用と矛盾している点を未解決として明記する（issue #74 で追跡中）。
