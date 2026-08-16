# Phase 3 参照実装: event intake・冪等な状態還元・operation correlation

対象: `harness/continuity/reference-model.ts` / `harness/continuity/reference-model.test.ts` /
`harness/fixtures/continuity/**`。

正本: `specs/001-agent-memory-core/resume-continuity-addendum-v6.2.md` §3.1 / §4.2 / §4.3、
`agent-memory-final-spec-v6.md` §8.2（idempotency key 導出）/ §22.6（decimal string・JCS）。

この文書は「正本にそう書いてあるので実装した規則」と「正本に無いので harness 側で決めた導出」を
分けて記録する。後者は Rust 側が同じ値を出すために必要な情報であり、同時に正本へ戻すべき宿題でもある。

## 1. 正本どおり実装した規則

| 規則 | 正本 | 実装 |
|---|---|---|
| `evidenceKind` / `ingestAttestation` は intake が割り当て、caller の値を信頼しない | §3.1 | `stampIntakeEvidence` が caller の値を無視して再計算する |
| native は attestation・active capability hash 一致・`(scenarioId, captureMethod, channel)` が proven の 4 条件 | §3.1 | 1 つでも欠ければ `synthesized` |
| exact version でない `sourceAgentVersion` は native authority を失う | §3.1 | `IntakeContextV1.exactAgentVersion` との一致を要求 |
| `turnId` は native / synthesized_monotonic のとき必須、unavailable のとき不在 | §3.1 | `assertTurnIdentity`（schema 側にも if/then があり二重に守る） |
| operation event は `operation` envelope 必須。correlation 値を `payload` から読まない | §3.1 | `assertOperationEnvelope`。correlation 関数は `payload` を参照しない |
| dedupe authority は `adapterDeliveryId`、無ければ canonical fingerprint | v6 §8.2 | `idempotencyKeyOf` は `??`（union ではなく fallback。正本の導出式が `??` で書かれている） |
| dedupe は revision 採番の**前** | §4.2 | `reduceTaskWorkState` は ledger 照合を最初に行い、重複なら何も採番しない |
| 重複した論理 event は no-op（同じ state bytes・content hash・revision・history） | §4.2 | 重複経路は入力の snapshot をそのまま返す。ledger も同一参照 |
| 遅れて届いた event も後続 revision を作り、証跡を書き換えない | §4.2 | 適用は常に新しい revision を作る。既存 `sourceEventIds` は追記のみ |
| terminal 照合は 1) `nativeOperationId` 一致 2) `operationMatchKey` + turn/kind 一致かつ open な候補が 1 件 3) それ以外は不一致 | §4.3 | `correlateTerminalEvent` |
| terminal は start より後（権威順序）・未適用・hash 非衝突 | §4.3 | ingestSeq 比較 / status 判定 / `canonicalInputHash` 比較 |
| 0 件または複数一致の terminal は何も閉じず、診断を出す | §4.3 | `terminal_unmatched` / `terminal_ambiguous` を返し、候補の status は変えない |
| 放棄・復帰時に証跡が無い operation は `unknown` | §4.3 | `finalizeAbandonedState` |
| seq は safe integer を超える decimal string | v6 §22.6 | `compareIngestSeq` は桁数 → 辞書順の 2 段比較。`Number()` を使わない |

## 2. 正本に無いので harness 側で決めたこと

いずれも hash に効くので、Rust 側は同じ式でなければ parity が取れない。

### 2.1 content hash と revision

```text
contentHash   = SHA-256( JCS( state から stateRevision を除いたもの ) )
stateRevision = SHA-256( JCS({ schema: "free-mem/work-state-revision/v1",
                               previousRevision, eventId, contentHash }) )
operationId   = SHA-256( JCS({ schema: "free-mem/operation-id/v1",
                               startEventId, operationMatchKey }) )
```

- JCS は §22.6 の要求（RFC 8785）。`harness/schema/jcs.ts` の `canonicalizeJson` を使う。
- `stateRevision` を hash 対象から外すのは循環を避けるため。除外は列挙ではなく
  `Omit<CanonicalWorkStateV1, "stateRevision">` と「その形で組み立てる」ことで担保している
  （手で除外リストを持つと欄が増えたとき守られなくなる）。
- 時刻・乱数・連番を使わないので、同じ入力からは常に同じ値になる。

### 2.2 `lastIngestSeq` は単調な watermark

addendum は `CanonicalWorkStateV1.lastIngestSeq` の意味を定義していない。同じ addendum が
event store の watermark を「highest applied `ingestSeq`」と定義している（§6.4 の acceptance）ので、
状態側も **max（後退しない）** とした。遅れて届いた event は revision を作るが watermark は動かさない。

### 2.3 fail-closed に倒した既定（#36）

`operationKind` は自由文字列で、どれが shell / 破壊的 / 外部 / 資格情報かの表が正本にも
capability matrix にも無い。表が来るまでは:

- `PendingOperation.kind` = `tool` 固定
- `replayPolicy` = `never_auto` 固定（§4.3 の `verify_first` は誰にも付かない）
- `sensitivity` = `private` 固定（内容を見ずに `normal` と申告しない）

`CanonicalWorkStateV1.sensitivity` は「構成要素の最大」なので、pending operation が 1 件でもあれば
`private` 以上になる。remote routing を実装する前に #36 を閉じる必要がある。

### 2.4 intake が付ける kind は native / synthesized の 2 値

§3.1 は intake の導出元（peer identity・channel・captureMethod・capability matrix）を挙げるが、
`derived` は AI 由来の派生物に付く種別で、event intake の出力ではない。よって
`stampIntakeEvidence` は `native` か `synthesized` しか返さない。

### 2.5 別 lineage の event は適用しない

状態は lineage ごとに 1 つ（§4）。`taskLineageId` が状態と食い違う event を還元すると、
境界の確定（§4.4）を経ずに前の task の状態が書き換わるため拒否する。`taskLineageId` を持たない
event は、還元先の状態の lineage に属するものとして扱う。

### 2.6 成否を主張しない terminal

`successful` が無い terminal は成功とも失敗とも言えないので `unknown` にする
（§4.3「Missing or ambiguous terminal evidence establishes `unknown`」の同じ扱い）。

### 2.7 event kind の分類（#29）

`operation` envelope を要求する kind の集合は正本に無い。harness の正規化語彙
（`harness/schema/capability.ts` の `EventKind`）に対する分類を
`OPERATION_EVENT_PHASES` / `NON_OPERATION_EVENT_KINDS` として `harness/schema/continuity.ts` に置いた。
test は「2 つの和が `EVENT_KINDS` に過不足なく一致する」ことを `EVENT_KINDS` から導いて検査するので、
kind を足すと分類を決めるまで CI が落ちる。語彙に無い adapter 固有の kind は未分類として
envelope を要求しない（既知の非 operation kind が envelope を持つ場合だけ拒否する）。

## 3. 限界

- **per-kind の状態投影は未実装**。prompt / file / command / test を `Observed*` へ写す規則が addendum に
  無いため、還元は bookkeeping（watermark・revision・pendingOperations）だけを行う。
- **§4.3 の権威順序検査は状態の外の索引に依存する**（#35）。`PendingOperation` は start の
  `ingestSeq` を持たないので、`TaskWorkStateSnapshotV1.operationStartSeq` を frozen schema の外に置いた。
- **boundary authority（§2.2 / §4.4）は未実装**。§3.1 の必須 negative の後半
  「forged native event は task boundary を confirm できない」は、confirm 側が入るまで
  「synthesized へ降格する」ところまでしか検証していない。
- **unmatched terminal evidence は診断として返すだけ**。永続化は daemon の event store の責務で、
  参照実装は状態を持たない。

## 4. 再現方法

```bash
node --experimental-strip-types --test harness/continuity/reference-model.test.ts
node harness/contract-hashes.mjs > harness/contract-hashes.json   # fixture を足したら再生成
```

`harness/fixtures/continuity/tool-lifecycle-reduction.json` の `expected` は参照実装の出力そのもの。
導出（2.1）を変えたら test が期待値との差分で落ちるので、意図した変更であることを確認してから
`expected` を書き直す。

## 5. 変異テスト（2026-08-17）

各ゲートをわざと壊し、対応する test が落ちることを確認した。11 件すべてで 1 件以上が失敗し、
復元後は 36/36 green。

| 壊した箇所 | 落ちた test 数 |
|---|---|
| dedupe 判定を外す | 3 |
| `lastIngestSeq` の max を外す | 1 |
| `ingestSeq` を数値比較にする | 1 |
| operation envelope 必須を外す | 2 |
| intake の attestation 必須を外す | 1 |
| rule 2 の turn 同一性要求を外す | 1 |
| turn 同一性の不変条件を外す | 1 |
| terminal の権威順序検査を外す | 1 |
| 候補が複数のときの拒否を外す | 1 |
| sensitivity 集約を `normal` 固定にする | 2 |
| `canonicalInputHash` 衝突検査を外す | 1 |

「通るべきものが通る」側も対で置いている: 語彙外 kind の envelope、非 operation kind の envelope 無し、
turn 同一性の 3 通りの正しい組み合わせ、optional が全部無い状態の hash。
