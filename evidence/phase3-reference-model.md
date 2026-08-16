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
| `evidenceKind` / `ingestAttestation` は intake が割り当て、caller の値を信頼しない | §3.1 | `stampIntakeEvidence` は caller の `ingestAttestation` を読まずに捨て、認証済み経路の受領証（`IntakeContextV1.attestation`）で置き換える |
| native は attestation・active capability hash 一致・`(scenarioId, captureMethod, channel)` が proven の 4 条件 | §3.1 | 1 つでも欠ければ `synthesized`。channel は受領証側の値を使う（caller の主張は使わない） |
| exact version でない `sourceAgentVersion` は native authority を失う | §3.1 | `IntakeContextV1.exactAgentVersion` との一致を要求 |
| kind は「認証済み peer identity・channel・captureMethod・capability matrix」から導く | §3.1 | `event.sourceAgent` が受領証の Agent（`expectedSourceAgent`）と一致しなければ native にしない。認証済みの adapter が他 Agent 名義で native authority を得られないようにする |
| `turnIdSource="native"` は exact version について proven な native turn identifier を要求する | §3.1 | `IntakeContextV1.nativeTurnIdentityProven` が false なら caller の native 主張を `unavailable` へ降格し `turnId` を落とす。証明は version に紐づくので、受領証・`sourceAgent`・`sourceAgentVersion` の束縛（`authenticatedVersion`）が成り立たない event にも適用しない。`capabilityHash` は capability matrix にまだ turn identity の cell が無い（#40）ため turn の判定には使わない。`synthesized_monotonic` は adapter 由来なので触らない |
| どちらかの turn が unavailable なら rule 2 は適用されず operation は `unknown` になる | §4.3 | 同じ match key の open な候補を `unresolvedOperationIds` として返し、還元側で `unknown` にする。閉じられるのは rule 1 だけ |
| turn scoping を要求する規則は unavailable に fail closed になり、downgrade の理由は doctor が報告する | §3.1 | intake の降格は `turn_identity_downgraded` 診断を返す。`stampIntakeEvidence` の戻り値は `{ event, diagnostics }` |
| `turnId` は native / synthesized_monotonic のとき必須、unavailable のとき不在 | §3.1 | `assertTurnIdentity`（schema 側にも if/then があり二重に守る） |
| operation event は `operation` envelope 必須。correlation 値を `payload` から読まない | §3.1 | `assertOperationEnvelope`。correlation 関数は `payload` を参照しない |
| dedupe authority は `adapterDeliveryId`、無ければ canonical fingerprint | v6 §8.2 | `idempotencyKeyOf` は fallback（union ではない。正本の導出式が `??` で書かれている）。schema が `adapterDeliveryId` に minLength を持たないので、空文字は「無い」として fingerprint へ落とす |
| dedupe は revision 採番の**前** | §4.2 | `reduceTaskWorkState` は ledger 照合を最初に行い、重複なら何も採番しない |
| 重複した論理 event は no-op（同じ state bytes・content hash・revision・history） | §4.2 | 重複経路は入力の snapshot をそのまま返す。ledger も同一参照 |
| 遅れて届いた event も後続 revision を作り、証跡を書き換えない | §4.2 | 適用は常に新しい revision を作る。既存 `sourceEventIds` は追記のみ |
| terminal 照合は 1) `nativeOperationId` 一致 2) `operationMatchKey` + turn/kind 一致かつ open な候補が 1 件 3) それ以外は不一致 | §4.3 | `correlateTerminalEvent`。`nativeOperationId` を名乗った terminal は rule 1 だけで判定する（一致しないときに rule 2 へ落とすと、matchKey の導出が §4.3 どおりでない adapter 相手に別 operation を診断なしで閉じてしまう。wire 越しに導出は検証できない） |
| terminal は start より後（権威順序）・未適用・hash 非衝突 | §4.3 | ingestSeq 比較 / status 判定 / `canonicalInputHash` 比較 |
| 0 件または複数一致の terminal は何も閉じず、診断を出す | §4.3 | `terminal_unmatched` / `terminal_ambiguous` を返す。曖昧な候補は open のまま `unknown` にする |
| correlation / hash の衝突は隔離する | §4.3・v6「same op ID + different hash: quarantine corruption」 | `outcome: "quarantined"`。状態にも台帳にも入れない（入れると訂正版の再配送が重複 no-op になる） |
| rule 2 は双方が同じ `turnIdSource` 種別の turn 同一性を持つことを要求する | §4.3 | start 側の種別を側索引 `operationStarts` に保持して照合する |
| 放棄・復帰時に証跡が無い operation は `unknown` | §4.3 | `finalizeAbandonedState`。§4.2 の重複 no-op はこの経路にも掛かるので、台帳を受け取り、同じ放棄 event の再配送では revision を採番し直さない |
| 閉じられなかった terminal は unmatched evidence として保つ | §4.3 | `unknown` にした候補の `sourceEventIds` にその terminal を足す。状態が変わった理由を状態から辿れるようにする（放棄経路と扱いを揃える） |
| 状態は lineage ごとに 1 つ | §4 | `assertSameScope` は lineage に加えて `sourceAgent` も束縛する。`OperationCorrelationV1` は Agent を持たず scope が sessionId + taskLineageId だけなので、束縛しないと別 Agent の terminal が同じ session に居る他 Agent の operation を閉じられる |
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

### 2.4 `updatedAt` は単調でない

`updatedAt` は revision を作った event の `occurredAt` にする。`lastIngestSeq`（単調な
watermark）と違って遅れて届いた event では後退し得るが、これは「この revision の証跡が
いつ観測されたか」を指す値なので、最大値へ丸めると嘘になる。順序が要る比較には
`lastIngestSeq` を使う。

### 2.5 還元の結果は 3 値

`applied` / `duplicate` / `quarantined` を `outcome` として返す。`quarantined` は状態も台帳も
更新しないので、訂正した event を後から入れ直せる。

### 2.6 intake が付ける kind は native / synthesized の 2 値

§3.1 は intake の導出元（peer identity・channel・captureMethod・capability matrix）を挙げるが、
`derived` は AI 由来の派生物に付く種別で、event intake の出力ではない。よって
`stampIntakeEvidence` は `native` か `synthesized` しか返さない。

### 2.7 別 lineage の event は適用しない

状態は lineage ごとに 1 つ（§4）。`taskLineageId` が状態と食い違う event を還元すると、
境界の確定（§2.2）を経ずに前の task の状態が書き換わるため拒否する。`taskLineageId` を持たない
event は、還元先の状態の lineage に属するものとして扱う。

### 2.8 成否を主張しない terminal

`successful` が無い terminal は成功とも失敗とも言えないので `unknown` にする
（§4.3「Missing or ambiguous terminal evidence establishes `unknown`」の同じ扱い）。

### 2.9 配列上限の保持方針（#39）

frozen schema は `pendingOperations` も `sourceEventIds` も 256 件（§10 の `arrayItems`）に制限して
いるが、addendum に保持・退避の規則が無い。tool 呼び出しの多い session では上限を超えるので:

- 上限に達した状態へ新しい start が来たら、`succeeded` → `failed` → `unknown` → `started` の順に
  古いものから落として場所を空ける。落とした `operationId` は `pending_operations_evicted` に並べる
- **落とせるものが無いから取り込まない、にはしない**。`unknown` を状態から消す経路が他に無いので、
  枠が open な operation で埋まると以後すべての start が入らなくなる。訂正版の存在しない隔離を
  adapter が再送し続けるだけで、回復経路が無い（詰まった session は以後どの tool 呼び出しも
  記録できない）。失って影響の小さい順に落として、落とした事実を診断に出すほうを選んだ
- `sourceEventIds` は上限で頭打ちにし、`source_events_truncated` を出す。`unknown` は open のままなので
  同じ operation に terminal が何度でも再照合され、上限を見ないと還元器自身が schema 違反の
  状態を出す（test で `CanonicalWorkStateV1` として検証している）

落ちた event 自体は event store に残る（状態は projection で、証跡の正本ではない）。ただし退避後に
その operation の訂正 terminal が来ると unmatched になる。完了した operation の永続的な置き場は
per-kind projection（§3 の未実装項目）で、そこが入るまでは上限に達した長い session で相関の履歴が
短くなる。この扱いも #39 で決める。

### 2.10 権威順序を「破った」と「確かめられない」を分ける

§4.3 は「terminal は start より後」と要求するが、破ったときの扱いを書いていない。2 つに分けた:

- **順序を確かめて破っている**（start の `ingestSeq` が状態にあり、terminal がそれ以前）:
  terminal の証跡が来ている以上「まだ走っている」とは言えないので、閉じずに一致した 1 件を
  `unknown` にする。同じ match key の無関係な open は巻き込まない
- **順序を確かめられない**（checkpoint から復元して `operationStarts` が空: #35）:
  terminal 自体は健全なので、状態にも台帳にも入れずに隔離する（`terminal_order_unverifiable`）。
  「順序違反」として台帳に入れると、start を取り込み直しても同じ terminal は重複 no-op になり、
  その operation は二度と閉じられない

### 2.11 event kind の分類（#29）

`operation` envelope を要求する kind の集合は正本に無い。harness の正規化語彙
（`harness/schema/capability.ts` の `EventKind`）に対する分類を
`OPERATION_EVENT_PHASES` / `NON_OPERATION_EVENT_KINDS` として `harness/schema/continuity.ts` に置いた。
test は「2 つの和が `EVENT_KINDS` に過不足なく一致する」ことを `EVENT_KINDS` から導いて検査するので、
kind を足すと分類を決めるまで CI が落ちる。語彙に無い adapter 固有の kind は未分類として
envelope を要求しない（既知の非 operation kind が envelope を持つ場合だけ拒否する）。

## 3. 限界

- **per-kind の状態投影は未実装**。prompt / file / command / test を `Observed*` へ写す規則が addendum に
  無いため、還元は bookkeeping（watermark・revision・pendingOperations）だけを行う。
- **§4.3 の権威順序と turn 種別の検査は状態の外の索引に依存する**（#35）。`PendingOperation` /
  `OperationCorrelationV1` は start の `ingestSeq` も `turnIdSource` も持たないので、
  `TaskWorkStateSnapshotV1.operationStarts` を frozen schema の外に置いた。
- **boundary authority（§2.2）は未実装**。§3.1 の必須 negative の後半
  「forged native event は task boundary を confirm できない」は、confirm 側が入るまで
  「synthesized へ降格する」ところまでしか検証していない。
- **`finalizeAbandonedState` は history を作らない**。戻り値が `CanonicalWorkStateV1` であって
  snapshot ではないため、revision の履歴を積むのは呼び出し側の責務。冪等台帳は受け取るので、
  同じ放棄 event の再配送で revision を採番し直すことは無い。
- **intake の診断は呼び出し側が集める**。`stampIntakeEvidence` は `{ event, diagnostics }` を返すが、
  それを還元結果の診断と併せて doctor へ渡すのは daemon 側の仕事で、参照実装は連結しない。
- **`lastIngestSeq` の意味は正本に無い**（#38）。ここでは単調な watermark として実装している。
- **session 全体を 1 回の fold で流す用途には向かない**。`commit` は event ごとに冪等台帳と
  history を複製するので、fold の長さに対して二乗で伸びる（実測: 1,000 event 61ms、
  5,000 event 1,024ms、20,000 event 23,332ms）。参照実装は「同じ fixture から TS と Rust が
  同じ値を出すか」を確かめるためのもので、常駐 daemon の還元器はこの複製をしない実装にする。
  台帳と history を呼び出し側が持つ append-only 構造にすれば線形になるが、それをやると
  「直前の snapshot は書き換わらない」という比較の前提が崩れるので、ここでは複製のままにした。

## 4. 再現方法

```bash
node --experimental-strip-types --test harness/continuity/reference-model.test.ts
node harness/contract-hashes.mjs > harness/contract-hashes.json   # fixture を足したら再生成
```

`harness/fixtures/continuity/tool-lifecycle-reduction.json` の `expected` は参照実装の出力そのもの。
導出（2.1）を変えたら test が期待値との差分で落ちるので、意図した変更であることを確認してから
`expected` を書き直す。

## 5. 変異テスト（2026-08-17）

各ゲートをわざと壊し、対応する test が落ちることを確認した。33 件すべてで 1 件以上が失敗し、
復元後は 56/56 green。

| 壊した箇所 | 落ちた test 数 |
|---|---:|
| dedupe 判定を外す | 3 |
| lastIngestSeq の max を外す | 1 |
| ingestSeq を数値比較にする | 1 |
| envelope 必須を外す | 2 |
| intake の attestation 必須を外す | 3 |
| caller の attestation を信じる | 1 |
| sourceAgent の束縛を外す | 2 |
| 空の Agent 名を素通しする | 1 |
| native turn の証明要求を外す | 3 |
| turn 証明の version 束縛を外す | 2 |
| turn 降格を黙って行う | 1 |
| turn 同一性の不変条件を外す | 1 |
| state への Agent 束縛を外す | 1 |
| 空 adapterDeliveryId の fallback を外す | 1 |
| rule 1 の排他を外す | 1 |
| rule 2 の turn 同一性要求を外す | 2 |
| turnIdSource 種別の一致要求を外す | 1 |
| 候補が複数のときの拒否を外す | 1 |
| canonicalInputHash 衝突検査を外す | 2 |
| start 不在の隔離を外す | 1 |
| terminal の権威順序検査を外す | 2 |
| 順序違反で候補を巻き込む | 1 |
| 順序不明の terminal を台帳に入れる | 1 |
| 候補の unknown 化を外す | 4 |
| unknown 化で証跡を残さない | 1 |
| sourceEventIds の上限を外す | 1 |
| pendingOperations の上限を外す | 1 |
| 退避対象から open を外す（詰まる） | 1 |
| 退避件数の上限を外す | 2 |
| 退避を黙って行う | 2 |
| revision ごとの配列分離を外す | 1 |
| 放棄経路の dedupe を外す | 1 |
| sensitivity 集約を normal 固定にする | 2 |

「通るべきものが通る」側も対で置いている: 語彙外 kind の envelope、非 operation kind の envelope 無し、
turn 同一性の 3 通りの正しい組み合わせ、optional が全部無い状態の hash、turn が unavailable でも
rule 1 なら閉じること、上限に達していても start は必ず取り込むこと、上限に余裕があれば退避の
診断を出さないこと、proven な version の native turn と adapter の `synthesized_monotonic` は
降格しないこと、`capabilityHash` の不一致は evidence だけを降格させて turn には触れないこと、
同じ Agent の terminal は通ること、隔離した terminal も start を入れ直せば閉じられること、
巻き込まれなかった候補には証跡が付かないこと、negative fixture の `intakeContext` に欠落があれば
（何をしても synthesized になって intake の case が素通りするので）落ちること。

還元後の状態は `validateContractValue("CanonicalWorkStateV1", ...)` で凍結 schema に対して検証する
（terminal を 300 回投げても違反しないこと）。ゲートの test だけだと、還元器が schema 違反の状態を
出しても緑のままになる。
