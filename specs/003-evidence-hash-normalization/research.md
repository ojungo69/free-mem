# Phase 0 Research: 証拠 digest による real-cli-e2e 昇格の裏付け

すべて `origin/main` 5bbf292 を基点とする worktree `/home/jura/projects/free-mem-wt/evidence-hash`
での実測に基づく。推測で書いた項目は無い。

---

## R0. 現状の穴（測定）

`harness/assemble.ts` は 3 箇所で `real-cli-e2e` を刻む。3 箇所とも判断材料は
`Boolean(fixture.evidenceHash)` だけで、値の裏取りは無い。

| 行 | 対象 | 判定式 |
|---|---|---|
| 280 | capture cell | `evidenceKind: hashed ? "real-cli-e2e" : "source-test"` |
| 349 | highLevel cell | 同上 |
| 383 | prompt 対の再刻印 | `evidenceKind: "real-cli-e2e"`（到達条件 `pairFixture` が `f.evidenceHash` を要求） |

`harness/fixtures/*/raw/` を読むコードは 1 行も無い（`assemble.ts:270` のコメントが自認）。
committed fixture で `evidenceHash` を申告しているものは 0 件、現在の matrix は
`real-cli-e2e` 0 件・`source-test` 21 件。**塞ぐべき穴はあるが、汚染された成果物はまだ無い。**

**Decision**: 3 箇所すべてを同じ検査に通す。1 箇所でも残すと別識別子で同じ欠陥が生き残る。

---

## R1. 何が揮発し、何が安定か（16 件の観測記録から測定）

観測記録は 1 行 1 JSON の NDJSON。top-level は `event` / `at` / `payload` の 3 キーのみ。
`payload` に現れるキーは 23 種。

**揮発する（取得のたびに変わる）**

| キー | 変わる理由 |
|---|---|
| `at`（top-level） | 実行時刻 |
| `session_id`, `prompt_id`, `turn_id`, `tool_use_id`, `agent_id` | run ごとに新規発番 |
| `transcript_path`, `agent_transcript_path`, `cwd` | 実行環境の絶対 path。`/tmp/free-mem-rig-$USER/...` を含む |
| `duration_ms` | 実行時間 |
| `model` | 既定モデルの更新で変わる |
| `last_assistant_message` | モデルが書く自由文。同一 scenario の 2 回で「Exit code: \`1\`」と「The exit code is **1**. ...」のように別物になる（`claude-tool-fail` / `claude-tool-fail2` で実測） |
| `tool_input.*`, `tool_response.*` | モデルが組み立てた引数と実行結果。`description` が「Run the false command」と「Run the false command to return a non-zero exit code」で揺れることを実測 |

**安定かつ substantive**

`event` / `hook_event_name` / `tool_name` / `source` / `reason` / `permission_mode` / `agent_type` / `prompt`

`prompt` は scenario が投入する指示そのもので、モデルの出力ではないため安定する。
唯一の例外は注入 scenario の `RIG_INJECT_<token>` で、これは rig の呼び出し側が `INJECT_MARKER`
環境変数で渡す値（`harness/rig/rig.sh:65`）。

**Decision**:
- 除外は「キー名を列挙して落とす」ではなく **「値を伏せ字に置き換え、キーは必ず残す」** とする。
  キーを落とすと、新しい欄が増えたり消えたりしたことが digest に現れなくなる（FR-010）。
- 既定は伏せ字。verbatim にするのは上記 8 キーだけ。これにより、将来 CLI が追加する未知の欄の
  中身が成果物へ漏れる経路が原理的に無くなる（FR-015 を既定動作で満たす）。
- `RIG_INJECT_[A-Za-z0-9_]+` は `RIG_INJECT_<marker>` へ置換する。marker を verbatim に
  残すと注入 scenario だけ再取得で digest が変わる。

**Alternatives considered**:
- *生ファイル全体の SHA-256*: owner が明示的に不採用。時刻と session id が入るので再取得のたびに不一致になる
- *揮発キーの denylist を作り、残りは verbatim*: 新しい欄が増えたときに既定で verbatim になるため、
  未知の欄経由で絶対 path や会話内容が digest 経由で成果物へ出る。privacy 境界（constitution III）を
  既定で破る向きなので不採用
- *event 名の並びだけを digest にする*: 下の R2 で衝突が多発する（`tool-denied` と `tool-ok` が同じになる）

---

## R2. 提案規則を 16 件へ当てた結果（測定）

規則: 各行を `{event, payload}` にし `at` を落とす / object はキーを全保持して codepoint 順に整列 /
`null` と boolean は verbatim / number は `<number>` / string は上記 8 キーのみ verbatim（marker 置換あり）で
それ以外は `<string>` か `<string:empty>` / array は要素ごとに再帰し長さを保持 / LF 区切りの NDJSON。

結果は **16 件で 14 種の digest**。一致したのは 2 組だけ。

| 組 | 判定 | 根拠 |
|---|---|---|
| `claude-interrupt3` ≡ `claude-interrupt4` | **正しい一致** | 同一 prompt「Write a 600 word essay about the ocean. Be thorough.」・同一 event 列 `SessionStart,UserPromptSubmit,SessionEnd`。異なるのは session id・時刻・transcript path だけ。**同一 scenario の再取得が同じ digest になることの実データによる証明**（SC-003） |
| `claude-hook-timeout` ≡ `claude-lifecycle-basic` | **正しい一致** | 揮発欄を除くと 2 ファイルの差分が 0 行。hook を 15 秒ブロックしても hook event 列には何も現れない、という観測結果そのものが同一。過剰除外ではない |

一致しなかった重要な組:

| 組 | digest | 意味 |
|---|---|---|
| `claude-tool-denied` vs `claude-tool-ok` | `1ac174c9…` vs `89a8fe38…` | 許可拒否と成功実行を取り違えない |
| `claude-inject` vs `claude-lifecycle-basic` | `44fd86a7…` vs `24a74e6c…` | 注入 scenario と最小 run を取り違えない |
| `claude-tool-fail` vs `claude-tool-fail2` | `67d11705…` vs `bb2efa68…` | prompt が実際に違う（「the single command: false」と「exactly: false 」）ので別物として正しい |
| `codex-tool-ok` vs `codex-tool-fail` | `49454289…` vs `94f87d4a…` | `tool_response` が非空文字列と空文字列で分かれる |

**`prompt` を verbatim から外した場合の測定**: 衝突が 5 組へ増え、`claude-tool-denied` と
`claude-tool-ok` が同一 digest になった。許可拒否と成功実行の取り違えは substantive な誤りなので、
`prompt` は verbatim 側に必須。

**Decision**: 上記の規則をそのまま `normalizationVersion: 1` として凍結する。

---

## R3. 共有 normalizer の置き方

取得側は `harness/rig/rig.sh`（POSIX shell）、検証側は `harness/assemble.ts`（TypeScript）。
shell から TypeScript の関数を直接呼ぶ手段は無い。

**Decision**: normalizer を TypeScript のモジュール 1 本にし、
- `assemble.ts` は `import` する
- `rig.sh` は同じファイルを `node` で CLI として起動する（`harness/dco-check.mjs` が既に使っている
  「モジュールとしても CLI としても動く」形と同じ）

**Alternatives considered**:
- *shell 側にも同じ規則を書く*: 二重実装は必ず drift する。「片方だけ直して緑のまま」は
  この repo で既に起きている失敗の形
- *rig を TypeScript へ書き換える*: 本 issue の範囲を超える。rig の隔離設定は shell の
  環境変数注入に強く依存している

---

## R4. 証拠の置き場と path 解決

rig は `$RIG_BASE/capture/{claude,codex}-<label>.jsonl` へ書く（`harness/rig/rig.sh:73,88`）。
`$RIG_BASE` の既定は `/tmp/free-mem-rig-$USER` で、repo の外。
一方 committed 済みの証拠は `harness/fixtures/<cli>/raw/` にある。

**Decision**:
- 証拠置き場は `harness/fixtures/<cli>/raw/` のみとする
- fixture が名指しする値は「置き場からの相対 path」に限る。絶対 path・`..` を含む path は拒否
- 実体解決（realpath）後も置き場の内側であることを確認する。symlink で外へ出る参照を拒否
- rig は capture を置き場へ byte 同一で持ち込む工程を持つ。持ち込んだ後のファイルに対して
  digest を出す（持ち込み前に出すと、持ち込みで内容が変わっても気づけない）

---

## R5. 移行（backfill）

観測記録 16 件と fixture 8 件の対応は scenario 記述から一意に決まる。

| fixture | 観測記録 |
|---|---|
| `claude/lifecycle-basic` | `claude-lifecycle-basic.jsonl` |
| `claude/tool-lifecycle` | `claude-tool-ok.jsonl`, `claude-tool-denied.jsonl` |
| `claude/tool-failed-executed` | `claude-tool-fail.jsonl`, `claude-tool-fail2.jsonl` |
| `claude/injection-and-subagent` | `claude-inject.jsonl`, `claude-subagent.jsonl` |
| `claude/interrupt-and-hook-timeout` | `claude-interrupt.jsonl`, `claude-interrupt2.jsonl`, `claude-interrupt3.jsonl`, `claude-interrupt4.jsonl`, `claude-hook-timeout.jsonl` |
| `codex/lifecycle-basic` | `codex-lifecycle-basic.jsonl` |
| `codex/injection` | `codex-inject.jsonl` |
| `codex/tool-lifecycle-and-failure` | `codex-tool-ok.jsonl`, `codex-tool-fail.jsonl` |

`claude/interrupt-and-hook-timeout` が 5 本を参照する。**証拠参照は配列でなければならない**
（単数欄だと最初の 1 本しか結び付かず、残り 4 本は検査対象から外れる）。

`claude-tool-denied.jsonl` はどの fixture の散文からも参照されていない。`toolFailurePhasesObserved`
に `permission_denied` を記録している fixture も無い。取得はされたが cell の根拠として使われていない
記録なので、`claude/tool-lifecycle` の証拠配列へ含める（同一 scenario 系列の観測であり、
含めても cell の値は変わらない）。

**Decision**: 8 fixture すべてに証拠配列と digest を埋める。これにより 21 cell が
`source-test` から `real-cli-e2e` へ**昇格**する。降格は 1 件も発生しない。

---

## R6. 退役させる既存記述

`new-decision-doc-must-retire-old-statements` に従い、新しい定義と食い違う既存記述を先に洗い出した。

| 場所 | 現在の記述 | 扱い |
|---|---|---|
| `harness/schema/capability.ts:44` | 「その capture の raw transcript の SHA-256」 | **書き換える**。owner が不採用とした「生ファイル全体の SHA-256」そのものなので、正規化抜粋の digest である旨へ改める |
| `harness/assemble.ts:270-273` | 「evidenceHash が付くまでは弱い証跡種別に落とす」 | **書き換える**。hash の存在ではなく再計算の一致が条件になる |
| `harness/assemble.ts:341-344` | 「Task 2/3 の実 CLI rig が hash を記録したら昇格する」 | **書き換える**。記録するだけでは昇格しない |
| `harness/matrix/README.md:13` | 「evidenceKind: 全 cell `real-cli-e2e`（隔離 rig 下の実 CLI 実行）」 | **書き換える**。現在の matrix は `source-test` 21 件で、この行は既に事実と違う。移行後の実際の値へ合わせる |
| `agent-memory-final-spec-v6.md:521` | 証拠強度の語彙定義 | **変えない**。語彙は据え置き、判定条件だけを足す |

---

## R7. schema と型と fixture の同時変更

`harness/assemble.ts:147` の `unknown top-level key` 検査により、JSON Schema が知らないキーを
fixture が持つと弾かれる。したがって schema・TypeScript 型・fixture は同一 commit で動かす必要がある。

`harness/fixtures/continuity/*.json` は別種の fixture（`cases` / `intakeContext` を持つ）で、
CaptureFixture の schema 変更の影響を受けない。回帰で確認する。

**Decision**: 「fixture だけ先に新しい欄を足すと落ちる」方向も test で固定する。片方向だけの test は
偽陽性を仕様として守ってしまう（`declarative-constraint-needs-firing-test`）。
