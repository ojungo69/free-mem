# Phase 3 capability scenario manifest — v1 の由来

`harness/schema/capability-scenarios.v1.json` の根拠を記録する。addendum §13 は
「Adding or removing a required scenario requires a manifest version bump recorded in the
evidence file」と定めており、本ファイルがその evidence file にあたる。

正本: `specs/001-agent-memory-core/resume-continuity-addendum-v6.2.md`

## manifestVersion 1 — 収録した 7 scenario

すべて addendum §8 の次の 1 文を出典とする。

> Tier A requires exact-version proof of hint delivery, claimed prompt-gate delivery, compact
> persistence/fallback, exactly-one compact restore, retry dedupe, crash/restart semantics, and
> size/malformed behavior.

| `scenarioId` | 出典の語句 | `requiredFor` |
|---|---|---|
| `claimed-prompt-gate-delivery` | claimed prompt-gate delivery | `tier_a` |
| `compact-persistence-fallback` | compact persistence/fallback | `tier_a` |
| `crash-restart-semantics` | crash/restart semantics | `tier_a` |
| `exactly-one-compact-restore` | exactly-one compact restore | `tier_a` |
| `hint-delivery` | hint delivery | `tier_a` |
| `retry-dedupe` | retry dedupe | `tier_a` |
| `size-malformed-behavior` | size/malformed behavior | `tier_a` |

`appliesToAgents` は 2 つとも `["claude", "codex"]`。Phase 3 の対象 CLI がこの 2 つだけであるため。

### `scenarioId` は導出値である

addendum は scenario の ID を与えていない。上表の ID は出典の語句から機械的に kebab-case 化した
**導出値**であり、正本に文字列として存在するものではない。§13 の manifest check は exact-set
equality なので、生成側（report / matrix）もこの ID 集合に揃える必要がある。ID を変えるなら
manifest version を上げ、本ファイルに記録する。

### `requiredFor` を `tier_a` だけにした理由

出典が「Tier A requires …」であり、addendum はこれらを `generic_phase3` や `automatic_strategy` の
要件としては挙げていない。§13 の union には 3 つの値があるが、正本に根拠のない分類を足すのは
transcription ではなく設計判断になるため、書かれているものだけを採った。

## `manifestHash` の正規化

§13 は `manifestHash` の不一致を preflight 失敗としているが、**算出方法を定義していない**。
再計算できない hash は「一致を確認したつもり」を作るだけなので、ここで規則を固定する。

```
manifestHash = SHA-256hex( JSON.stringify({ manifestVersion, scenarios }) )
```

- `scenarios` は `scenarioId` の昇順
- 各 scenario のキー順は `scenarioId`, `title`, `appliesToAgents`, `requiredFor`
- 区切りは `JSON.stringify` の既定（空白なし）
- `manifestHash` 自身は入力に含めない

ponytail: 現時点でこの規則を強制する checker は無い（値は手で計算して埋めた）。§13 の
preflight predicate を実装する Task 5 で、この規則どおりに再計算して照合するゲートを入れる。
それまでこの hash は「宣言」であって「検証済み」ではない。

## disposition はここに書かない

§13 の `RequiredCapabilityScenarioV1` に `disposition` フィールドは無く、JSON Schema も
`additionalProperties: false` の closed schema である。§13 は disposition を
「the generated report/matrix」側に置いている。manifest は **何が証明されるべきか** だけを
宣言し、**何が証明されたか** は生成物が持つ。
