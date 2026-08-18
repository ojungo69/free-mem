# Implementation Plan: 証拠 digest による real-cli-e2e 昇格の裏付け

**Branch**: `feat/evidence-hash-normalization` | **Date**: 2026-08-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-evidence-hash-normalization/spec.md`（GitHub issue #20 / p0）

## Summary

`harness/assemble.ts` は 3 箇所で `Boolean(fixture.evidenceHash)` だけを見て `real-cli-e2e` を刻む。
64 桁 hex を書けば最高位の証拠強度を名乗れる。これを「fixture が名指しした観測記録から
正規化抜粋の SHA-256 を再計算し、一致したときにだけ刻む」へ変える。

正規化規則は committed 済みの観測記録 16 件で実測して決めた（research.md R1/R2）。
値は既定で伏せ字にし、キーは必ず残す。verbatim にするのは実測で安定と確認できた 8 キーのみ。
これにより「同一 scenario の再取得で同じ digest」と「未知の欄の中身が成果物へ漏れない」を
同時に満たす。

移行では 8 fixture すべてに証拠配列と digest を埋め、21 cell が `source-test` から
`real-cli-e2e` へ昇格する。降格は 1 件も発生しない。

## Technical Context

**Language/Version**: TypeScript / Node.js 24.16.0（`harness/` 既存構成）

**Primary Dependencies**: 追加なし。`node:crypto` の `createHash("sha256")`、`node:fs`、`node:path` のみ

**Storage**: ファイル。観測記録は `harness/fixtures/<cli>/raw/*.jsonl`、成果物は `harness/matrix/*.json`

**Testing**: `node --test`（既存の `harness/**/*.test.mjs` / `assemble.ts` 内の自己 assert と同じ形）

**Target Platform**: Linux（WSL2）。CI は `ubuntu-24.04`

**Project Type**: 単一 repo 内の検証 harness

**Performance Goals**: 観測記録 16 件の合計が 40KB 未満。組み立て時間への影響は無視できる範囲

**Constraints**:
- 凍結済み語彙 `official-doc` / `source-test` / `real-cli-e2e` を変えない
- `harness/assemble.ts:147` の未知キー拒否があるため schema・型・fixture は同一 commit で動かす
- 成果物・診断出力・CI ログへ観測記録の本文・投入指示・モデル出力・絶対 path を出さない

**Scale/Scope**: 観測記録 16 件、capture fixture 8 件、matrix cell 38 件（Claude 19 / Codex 19）

## Constitution Check

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. ローカルファースト | 通過 | 追加の外部通信なし |
| II. ゼロ増分コスト | 通過 | 依存追加なし。標準ライブラリのみ |
| III. プライバシー境界（NON-NEGOTIABLE） | 通過。**ただし実装者の指定あり** | 正規化は既定で伏せ字にし、verbatim 8 キー以外を digest にも出力にも出さない。本件は完全性 digest・path traversal 拒否・入力検証を含むため「セキュリティ関連コードは外部 CLI へ委譲せず Claude Code が直接実装する（MUST）」に該当する。issue #20 の実装順序は task 2 を Codex CLI へ割り当てているが、**この点は逸脱して Claude Code が実装する** |
| IV. 安全境界（fail-closed） | 通過 | 観測記録の不在・読み取り失敗・digest 不一致・未知の版のすべてで組み立てを失敗させる。降格して続行しない |
| V. 決定論的ゲート | 通過 | 判定は SHA-256 の一致という機械比較のみ。LLM 判定を含まない |
| VI. ローカル完結（push / PR 禁止） | **食い違いあり。本 plan では解消しない** | 本 repo は現在 GitHub 上で PR 運用しており、原則 VI と食い違う。その解消は issue #74 の担当で、本 feature の範囲外 |

Phase 1 設計後の再評価: 変更なし。設計で新たな外部送信・新規依存・非決定的判定は増えていない。

## Project Structure

### Documentation (this feature)

```text
specs/003-evidence-hash-normalization/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── evidence-normalizer.md
├── checklists/
│   └── requirements.md
└── tasks.md              # /speckit-tasks が生成する
```

### Source Code (repository root)

```text
harness/
├── evidence/
│   ├── normalize.mjs           # 新規: 正規化 + digest + path 解決。module 兼 CLI
│   └── normalize.test.mjs      # 新規: 正規化と path 解決の test
├── assemble.ts                 # 変更: 3 箇所の昇格判定を再計算の一致へ
├── schema/
│   ├── capability.ts           # 変更: evidence[] 追加 / top-level evidenceHash 廃止
│   └── capability.schema.json  # 変更: 同上
├── fixtures/
│   ├── claude/*.json           # 変更: evidence[] を埋める（5 件）
│   ├── codex/*.json            # 変更: evidence[] を埋める（3 件）
│   ├── claude/raw/*.jsonl      # 変更なし（証拠置き場）
│   └── codex/raw/*.jsonl       # 変更なし
├── matrix/
│   ├── claude.json             # 再生成
│   ├── codex.json              # 再生成
│   └── README.md               # 変更: evidenceKind の記述を実態へ
└── rig/
    └── rig.sh                  # 変更: capture を置き場へ持ち込み、digest を出す
```

**Structure Decision**: 新規コードは `harness/evidence/` に 1 モジュールだけ置く。
`harness/` 直下は既に平坦で用途が混在しているため、証拠まわりを 1 ディレクトリへ寄せる。
`.mjs` にするのは `rig.sh` から `node` で直接起動するため（`harness/dco-check.mjs` と同じ形）。

## 実装順序

issue #20 の H0〜H3 を、この repo での作業単位へ落としたもの。

| 段 | 内容 | 対応 | 完了条件 |
|---|---|---|---|
| 1 | 正規化規則の凍結（H0） | spec.md / research.md / data-model.md / contracts | 実測に基づく規則が文書として確定している（**本 plan の時点で完了**） |
| 2 | normalizer の実装（H0/H1） | `harness/evidence/normalize.mjs` + test | data-model.md §6 の M5〜M12 が kill される |
| 3 | schema と型（H1） | `capability.ts` / `capability.schema.json` | M13 が kill される。continuity fixture が壊れない |
| 4 | 昇格判定（H2） | `assemble.ts` の 3 箇所 | M1〜M4 が kill される |
| 5 | 移行 backfill（H2） | fixture 8 件 + matrix 再生成 | 21 cell が昇格し、降格 0 件 |
| 6 | rig の持ち込みと digest（H2） | `rig.sh` | capture が置き場へ byte 同一で入り、digest が出る |
| 7 | provenance と退役（H3） | `matrix/README.md` ほか research.md R6 の 5 箇所 | 古い記述が残っていない。M14 が kill される |

段 2〜4 は先に失敗する test を書いてから実装する。段 5 は段 4 が通ってからでないと
「昇格した」ことを確認できない。

## 主要な設計判断

### 共有 normalizer は 1 本、CLI としても動く

取得側は shell、検証側は TypeScript。shell から TS の関数を呼ぶ手段が無いため、
同じファイルを `import` と `node <file>` の両方から使う。二重実装は必ず drift する。

### 昇格箇所は 3 つあり、3 つとも塞ぐ

`assemble.ts:280`（capture cell）、`:349`（highLevel cell）、`:383`（prompt 対の再刻印）。
`:383` は `pairFixture` の抽出条件が `f.evidenceHash` を見ているので、
そこも `verified` を見る形へ変える。1 箇所でも残すと別識別子で同じ欠陥が生き残る。

### 証拠参照は配列

`claude/interrupt-and-hook-timeout` が 5 本の観測記録を根拠にしている。
単数欄だと 4 本が検査対象から外れ、この fixture の主張の中心である中断の証跡が裏取り無しで残る。

### `evidence` を schema の `required` に入れない

入れると `official-doc` 由来の fixture が書けなくなり、語彙 3 種のうち 2 種が到達不能になる。
条件付きの要求（実 CLI 観測を名乗るときだけ必要）は assemble 側の検査で表す。

### rig は置き場へ持ち込んでから digest を出す

rig は `$RIG_BASE/capture/` へ書く（repo の外）。置き場 `harness/fixtures/<cli>/raw/` へ
byte 同一で持ち込み、**持ち込んだ後のファイル**に対して digest を出す。
持ち込み前に出すと、持ち込みで内容が変わっても気づけない。

### 既定は伏せ字、verbatim は 8 キーだけ

denylist（揮発キーを落として残りは verbatim）にすると、CLI が将来追加する未知の欄が
既定で verbatim になり、絶対 path や会話内容が digest 経由で成果物へ出る。
constitution III を既定で破る向きなので採らない。

## test の設計

両方向を書く。片方向だけの test は偽陽性を仕様として守ってしまう。

| 向き | 内容 |
|---|---|
| 攻撃側 | 形式は正しい 64 桁 hex + 実在しない path / 別物の path / 未知の版 → いずれも棄却。`..`・絶対 path・脱出 symlink → 拒否 |
| 通過側 | 許容した環境差だけが違う再取得（`claude-interrupt3` / `claude-interrupt4`）→ 同じ digest で昇格が成功する |
| 過剰正規化側 | substantive に違う 2 記録（`claude-tool-denied` / `claude-tool-ok`）→ digest が異なる |
| 方向拘束 | fixture だけ先に `evidence` を足した状態 → schema の未知キー拒否で落ちる |

変異と kill 対応表は data-model.md §6（M1〜M14）。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| constitution VI（push / PR 禁止）との食い違い | 本 repo は既に GitHub で PR 運用しており、本 feature だけ運用を変えられない | 原則側の改訂は issue #74 が扱う。本 feature で先に決めると、未決事項を別 issue へ分離した意味が消える |
| issue #20 の実装順序（task 2 を Codex CLI へ）からの逸脱 | 完全性 digest・path traversal 拒否・入力検証はセキュリティ関連にあたり、constitution III が外部 CLI への委譲を禁じている（MUST） | 委譲して事後レビューする案は、原則が「委譲しない」と書いている以上、レビューの有無で置き換えられない |
