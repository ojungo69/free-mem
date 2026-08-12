# T025 — Sidecar Isolation Certification 判定（v6.1 §13.6）

日付: 2026-08-12 / 判定者: Claude Code（セキュリティ関連のため委譲なし）
入力: `supervisor.sh` + `run-tests.sh`（プロセス隔離の実証）、`hostile-fixture.sh` + `hostile-e2e.sh`（hostile 設定下の side effect 検査）、T023 の provider ToS 一次ソース確認。

**結論: Claude sidecar = 未認定（default disabled） / Codex sidecar = 未認定（default disabled）。**
両者とも Core 1.0 では sidecar 経路を実装しない。§13.6 の「未認定・期限切れ・version 不一致は default disabled」に従う正当な Exit であり、Phase 0B の失敗ではない。

## 共通: supervisor（§13.6 の必須項目のうち実装・実証できた部分）

`harness/sidecar/run-tests.sh` — stub subprocess に対して全 PASS（資格情報不要・不活性）:

| §13.6 要件 | 実証内容 | 結果 |
|---|---|---|
| external supervisor による hard deadline | `DEADLINE` 秒で TERM → KILL 昇格 | PASS（hang stub を 3 秒で刈る） |
| process-group / job-object 単位の kill | `setsid` で専用 PGID を作り `kill -- -PGID` | PASS（SIGTERM を無視する子×2 も全滅） |
| pipe close / 出力上限 | `head -c $CAP` で上限打ち切り後に close | PASS |
| wait / reap + 残存 descendant 検査 | reap 後に同 PGID の生存を走査し、検出時は再 kill して exit 70 | PASS（survivors=[] を確認） |
| invalid / truncated JSON 耐性 | 切断 JSON を parse error として表面化（ハングしない） | PASS |

## Claude sidecar

| manifest 欄 | 内容 |
|---|---|
| sidecar_profile_id | `claude-cli-bare`（未認定） |
| cli_id / exact_cli_version / os | claude / `2.1.228 (Claude Code)` / Linux WSL2 6.18.33.2 |
| provider ToS / documented-permission | **禁止（明文）**。Anthropic は Free/Pro/Max サブスク資格情報を第三者ツール経由でルーティングすることを許可していない（B-06 で一次ソース逐語確認済み。v6.1 付録 B.3）。したがって `--bare` + `ANTHROPIC_API_KEY`（BYOK）以外の経路は取り得ない |
| effective_config inspection | `--bare` は hooks / LSP / plugin sync / auto-memory / keychain 読み取り / CLAUDE.md 自動探索をスキップし、認証は `ANTHROPIC_API_KEY` または `apiKeyHelper` のみ（OAuth・keychain を読まない）と公式ヘルプに明記。hostile 設定下の実測でも偽 hook の marker は 1 件も作られなかった |
| hostile fixture E2E | **不能（key 不在）**。`--bare` は API key が無いと `Not logged in · Please run /login` で rc=1 終了する。サブスク資格情報へフォールバックしないことは実証できたが、**実際に応答を得る E2E は BYOK key が無いため実行できない** |
| process-tree / FD leak test | supervisor 共通結果（PASS）。ただし対象は stub であり、実 CLI での測定は未実施 |
| invalid/truncated JSON 耐性 | 共通結果（PASS。stub 対象） |
| verified_at / expires | 2026-08-12 / — |

**判定: 未認定（default disabled）**。理由は「不合格」ではなく **前提となる BYOK 資格情報が無いため certification E2E を実行できない**こと。ユーザーが `ANTHROPIC_API_KEY` を用意した時点で本 harness を再実行すれば認定可否を出せる（Phase 6 の optional PR で扱う）。

## Codex sidecar

| manifest 欄 | 内容 |
|---|---|
| sidecar_profile_id | `codex-cli-ephemeral`（未認定） |
| cli_id / exact_cli_version / os | codex / `codex-cli 0.147.0` / Linux WSL2 6.18.33.2 |
| provider ToS / documented-permission | T023 の一次ソース調査結果を参照（下記「ToS 判定」節） |
| effective_config inspection | `--ephemeral`（session ファイルを永続化しない）と `--ignore-user-config`（`$CODEX_HOME/config.toml` を読まない。認証のみ `CODEX_HOME` を使用）がヘルプに明記。両者を組み合わせた hostile E2E は `hostile-e2e.sh` に実装済みだが、実行はサブスク資格情報を消費するため ToS 確認を前提に `RUN_CODEX=1` でのみ実行する設計 |
| hostile fixture E2E | **未実行**（上記の理由。harness 自体は実装・待機状態） |
| process-tree / FD leak test | supervisor 共通結果（PASS。stub 対象） |
| invalid/truncated JSON 耐性 | 共通結果（PASS。stub 対象） |
| verified_at / expires | 2026-08-12 / — |

**判定: 未認定（default disabled）**。§13.6 が要求する「documented な『全 tool 無効・hook 無効』の単一契約」は `--ignore-user-config` + `--ephemeral` の組み合わせで近似できるが、**実 CLI での hostile E2E が未実行**であり、加えて ToS 面の確認結果（次節）が認定の前提になる。

## ToS 判定（T023 入力）

<!-- T023 researcher の一次ソース結果をここに転記する -->

## 再認定の手順

1. Claude: `ANTHROPIC_API_KEY` を用意 → `hostile-e2e.sh`（claude 節）を key 付きで実行 → marker 不在 + `PWNED` 不出力 + survivors=[] を確認。
2. Codex: ToS 確認が「許可の明文あり」になった場合のみ `RUN_CODEX=1 hostile-e2e.sh` を実行。
3. いずれも exact version を manifest に記録し直す（version が変われば認定は失効。§13.6）。
