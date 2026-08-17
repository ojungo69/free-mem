# ADR-004: free-mem のライセンスと inbound contribution 方針

- Status: **Accepted**（2026-08-17 に repository owner が決定。ライセンス付与は事後に取り消せない）
- Date: 2026-08-16（決定: 2026-08-17）
- 関連: issue #10（Governance）、#9（namespace 移行と upstream attribution）、#12（Personal Cloud BYOC）
- 前提: ADR-001（vendored codemem を base にする決定）、`THIRD_PARTY_NOTICES.md`

## 背景

repository は public だが、README が明示するとおり **repository 全体への license grant が無い**。
この状態は source-available ではあっても、第三者が利用・改変・再配布・contribute できる状態ではない。
Core 1.0 の package / tag / release を作る前、または外部 contribution を本格的に受け入れる前に確定する必要がある。

本 ADR は候補を証拠付きで比較し、1 つを推奨した。owner は 2026-08-17 に推奨どおり採用を決定した。

## 決定

1. free-mem 独自コードの outbound license を **Apache-2.0** とする。
2. `vendor/codemem/` の MIT 表示は維持し、上書きしない。
3. inbound = outbound とし、**DCO sign-off を必須、CLA は求めない**。
4. AI 生成・AI 支援コードは PR で provenance を申告させる。

## 候補比較

| 観点 | MIT | **Apache-2.0（推奨）** | MPL-2.0 | AGPL-3.0 |
|---|---|---|---|---|
| 商用利用・再配布・改変 | 可 | 可 | 可 | 可（ただし network 配布で source 開示義務） |
| 特許許諾 | **無し**（黙示のみ） | **明示的に有り**（§3。特許訴訟時の終了条項付き） | 有り（§2.1(b)） | 有り |
| notice 義務 | license 文の同梱 | license + NOTICE の同梱（§4） | 改変ファイルの source 開示 | 改変全体の source 開示 |
| vendored MIT との両立 | そのまま | 可（MIT → Apache-2.0 の一方向で取り込み可能。ただし本件は取り込まず vendor 配下を MIT のまま維持する） | 可 | 可 |
| 採用側の摩擦 | 最小 | 小（npm / crates で標準的） | 中（file-level copyleft を嫌う組織がある） | 大（社内利用でも敬遠されやすい） |
| local-first という製品性質との整合 | 中立 | 中立 | 低（competitor 対策としての効果が薄い。ユーザは自分で動かすため） | 低（同左。かつ BYOC 構成のユーザに義務が及びうる） |

### なぜ Apache-2.0 を推すか

- **特許条項が唯一の実質的な差**である。free-mem は checkpoint の claim / fence / CAS といった機構を実装する。
  MIT には特許許諾が無く、利用者は黙示のライセンスに頼ることになる。Apache-2.0 は §3 で明示的に許諾し、
  かつ特許訴訟を起こした側の許諾を終了させる。infra 系 OSS で標準的に選ばれる理由がここにある。
- **copyleft は本製品では効果が薄い**。free-mem は local-first で、ユーザが自分の機械で動かす。
  MPL / AGPL が守ろうとする「改変版を SaaS として提供する第三者」というシナリオは、
  #12 の Personal Cloud（ユーザ自身の Cloudflare アカウントに載せる BYOC）とは異なる。
  義務を課す相手がユーザ自身になりやすく、採用障壁だけが残る。
- **依存関係と衝突しない**（下記スキャン結果）。prod 依存に copyleft-only は無い。
- MIT との差は「特許条項と NOTICE の有無」だけであり、採用側の摩擦は実務上ほぼ変わらない。

MIT を選ぶ合理性があるとすれば、upstream codemem と表記を揃えたい場合と、NOTICE 運用のコストを避けたい場合。
その場合は本 ADR の決定 1 を差し替えるだけでよく、他の決定（DCO・provenance・第三者表示）は変わらない。

## 依存関係ライセンスの実測

```bash
cd vendor/codemem && corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm licenses list --json          # 全体
corepack pnpm licenses list --json --prod   # 配布に載る範囲
```

実測日 2026-08-16、pnpm 11.8.0、lockfile 固定。

| 範囲 | package 数 | 内訳 |
|---|---|---|
| 全体（dev 含む） | 455 | MIT 366 / Apache-2.0 22 / BSD-3-Clause 20 / ISC 20 / BSD-2-Clause 9 / その他 18 |
| prod のみ | 261 | MIT 208 / Apache-2.0 17 / BSD-3-Clause 14 / ISC 12 / その他 10 |

判断に関わる個別の事実:

- **copyleft-only は prod に無い**。MPL-2.0 のみの package は `lightningcss` / `lightningcss-linux-x64-gnu` の 2 つで、
  いずれも build 時の依存（viewer の CSS 処理）であり配布物に載らない。
- `dompurify` は `(MPL-2.0 OR Apache-2.0)` のデュアル。**Apache-2.0 側を選択する**と記録する。
- `flatbuffers@1.12.0` は `pnpm licenses list` が `Unknown` と報告するが、これは package.json が
  `"license": "SEE LICENSE IN LICENSE.txt"` を使っているため。同梱の `LICENSE.txt` は Apache-2.0 で、
  upstream は `google/flatbuffers`。経路は `@codemem/core → @xenova/transformers → onnxruntime-web → flatbuffers`。
  **Unknown ではなく Apache-2.0 として扱う**。
- `sqlite-vec` / `sqlite-vec-linux-x64` は `MIT OR Apache` という非 SPDX 表記。**MIT 側を選択する**と記録する。
- `caniuse-lite` は CC-BY-4.0、`mdn-data` は CC0-1.0。いずれも dev 依存のデータセット。
- `json-schema` は `(AFL-2.1 OR BSD-3-Clause)`、`expand-template` は `(MIT OR WTFPL)`、
  `lru-cache` は BlueOak-1.0.0、`tslib` は 0BSD。いずれも permissive で、Apache-2.0 の配布と衝突しない。

## repository 内 material の分類

| 分類 | 場所 | license | copyright |
|---|---|---|---|
| free-mem 独自コード | `harness/`、将来の `src/`・Rust crate | Apache-2.0（本 ADR） | The free-mem Authors |
| upstream codemem 由来 | `vendor/codemem/` | MIT（変更しない） | 2026 Adam Kunicki |
| 仕様・設計文書 | `specs/`、`docs/`、`agent-memory-*.md` | Apache-2.0 | The free-mem Authors |
| evidence / 検証レポート | `evidence/` | Apache-2.0 | The free-mem Authors |
| capability fixture・golden matrix | `harness/fixtures/`、`harness/matrix/` | Apache-2.0 | The free-mem Authors |
| 第三者 dependency | `node_modules/`（配布しない） | 各 package の license | 各権利者 |
| creative asset（logo 等） | 現時点で無し | 追加時に本表へ追記する | — |

`vendor/codemem/` 配下のファイルに free-mem の header を付けない。分類の境界はディレクトリで判定できる状態を保つ。

## inbound contribution 方針

- **inbound = outbound**。contribution は outbound と同じ license で受け入れる。著作権の譲渡は求めない。
- **DCO sign-off を必須**（`Signed-off-by:` 行）。CLA は求めない。理由: 個人 repository で CLA の管理コストに
  見合う便益が無く、DCO で出所の表明としては足りる。
- **AI 生成・AI 支援コードは PR で申告する**。本 repository 自体が AI agent による実装を含むため、
  禁止ではなく申告を求める。申告内容は「どのツールを使ったか」と「第三者コードの丸写しが無いことの確認」。
- **第三者コードの持ち込みは出所・commit・license の記録を必須**とし、`THIRD_PARTY_NOTICES.md` を同じ PR で更新する。
- **fixture に実データを入れない**（実 credential・私的な memory 内容・ローカル固有パス）。既存の repo 規則と同じ。
- license 確定前に来た外部 PR は、確定後に改めて DCO 付きで出し直してもらう。

## 配布面のチェック

現時点で package / tag / release を作っていないため、ここは「作るときに満たすべき条件」として定義する。

- GitHub source archive: `LICENSE` / `NOTICE` / `THIRD_PARTY_NOTICES.md` が root にあること（本 PR で満たす）
- npm package: `license` フィールドと `LICENSE` の同梱。`vendor/codemem` 由来 package は MIT のまま
- Rust crate / binary archive: `license` フィールド + `LICENSE` + `NOTICE` の同梱
- SBOM / checksum bundle: release evidence に license scan の結果を含める
- documentation site: footer に license 表記

CI ゲート（本 PR で追加）: `harness/license-inclusion-check.mjs` が
`LICENSE` / `NOTICE` / `THIRD_PARTY_NOTICES.md` / `vendor/codemem/LICENSE` の存在、
README の SPDX 表記と `LICENSE` の一致、`vendor/codemem` 配下 package.json の `license` 維持を検査する。

## owner の決定（2026-08-17）

1. **outbound license は Apache-2.0**。MIT との比較は上記のとおりで、特許条項を理由に採用。
2. **著作権者の表記は `The free-mem Authors`**。個人名・法人名は使わない。
3. **CLA は求めず DCO のみ**。inbound = outbound を維持する。

license 付与は取り消せない。一度公開した version に対する grant は撤回できず、
後から変更する場合は以降の version にのみ効く。この前提を踏まえた上での決定である。

## 残る未決事項

- release 前の専門家確認（本 ADR は法的助言の代替ではない）。
- DCO は `CONTRIBUTING.md` と PR template に規定しているが、CI では強制していない。
  外部 contribution を受け入れ始める時点で自動検査を入れるか判断する。

## 帰結

- 第三者は Core 1.0 を明確な条件で利用・改変・再配布できる。
- vendored codemem の MIT 表示と権利関係は分離されたまま維持される。
- 外部 contribution は DCO を通り、provenance が PR に残る。
