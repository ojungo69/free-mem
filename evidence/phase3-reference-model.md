# Phase 3 参照実装: event intake・冪等な状態還元・operation correlation

対象: `harness/continuity/reference-model.ts` / `harness/continuity/reference-model.test.ts` /
`harness/continuity/mutate.sh` / `harness/fixtures/continuity/**`。

正本: `specs/001-agent-memory-core/resume-continuity-addendum-v6.2.md` §3.1 / §4.2 / §4.3、
`agent-memory-final-spec-v6.md` §8.2（idempotency key 導出）/ §22.6（decimal string・JCS）。

この文書は「正本にそう書いてあるので実装した規則」と「正本に無いので harness 側で決めた導出」を
分けて記録する。後者は Rust 側が同じ値を出すために必要な情報であり、同時に正本へ戻すべき宿題でもある。

## 1. 正本どおり実装した規則

| 規則 | 正本 | 実装 |
|---|---|---|
| `evidenceKind` / `ingestAttestation` は intake が割り当て、caller の値を信頼しない | §3.1 | `stampIntakeEvidence` は caller の `ingestAttestation` を読まずに捨て、認証済み経路の受領証（`IntakeContextV1.attestation`）で置き換える |
| native は attestation・active capability hash 一致・`(scenarioId, captureMethod, channel)` が proven の 4 条件 | §3.1 | 1 つでも欠ければ `synthesized`。channel は受領証側の値を使う（caller の主張は使わない）。**authority 側の値が空なら一致は成立させない**（`activeCapabilityHash` / `expectedSourceAgent` / `exactAgentVersion`）: capability matrix が未整備の daemon で caller が同じ空値を名乗ると native が成立してしまう。「未設定」の表し方は空文字とは限らないので、identity 材料と同じ `isBlank`（空白・タブ・U+200B・U+FEFF まで）で落とす |
| exact version でない `sourceAgentVersion` は native authority を失う | §3.1 | `IntakeContextV1.exactAgentVersion` との一致を要求 |
| kind は「認証済み peer identity・channel・captureMethod・capability matrix」から導く | §3.1 | `event.sourceAgent` が受領証の Agent（`expectedSourceAgent`）と一致しなければ native にしない。認証済みの adapter が他 Agent 名義で native authority を得られないようにする |
| `turnIdSource="native"` は exact version について proven な native turn identifier を要求する | §3.1 | `IntakeContextV1.nativeTurnIdentityProven` が false なら caller の native 主張を `unavailable` へ降格し `turnId` を落とす。証明は version に紐づくので、受領証・`sourceAgent`・`sourceAgentVersion` の束縛（`authenticatedVersion`）が成り立たない event にも適用しない。`capabilityHash` は capability matrix にまだ turn identity の cell が無い（#40）ため turn の判定には使わない。`synthesized_monotonic` は adapter 由来なので触らない |
| どちらかの turn が unavailable なら rule 2 は適用されず operation は `unknown` になる | §4.3 | 同じ match key の open な候補を `unresolvedOperationIds` として返し、還元側で `unknown` にする。閉じられるのは rule 1 だけ。**turn 種別（`turnIdSource`）の一致は候補の絞り込みで見る**: 種別は start 側の材料（`operationStarts`。凍結 schema の外・#35）にしかないので、以前は候補を 1 件に絞ってから最後に比べていた。それだと「同じ matchKey・同じ turnId で種別だけ違う」候補が 2 件並んだとき、種別で 1 件に決まるはずのものが `terminal_ambiguous` になって**両方 `unknown` に倒れ、配送鍵も消費される**。絞り込み時に見れば rule 2 の「exactly one open candidate」が成立して閉じられる。ただし**材料がある候補だけ**種別で絞る（復元直後は `operationStarts` が空なので、材料が無いことを「種別が違う」と読むと理由を取り違える。§3.1 は降格の理由を doctor が報告することを求めている）。候補ゼロのときの診断も「turn 同一性が無い」と「種別が違う」で書き分け、`unknown` に倒す相手は種別違いならその候補だけにする |
| turn scoping を要求する規則は unavailable に fail closed になり、downgrade の理由は doctor が報告する | §3.1 | intake の降格は `turn_identity_downgraded` 診断を返す。`stampIntakeEvidence` の戻り値は `{ event, diagnostics }` |
| `turnId` は native / synthesized_monotonic のとき必須、unavailable のとき不在 | §3.1 | `assertTurnIdentity`（schema 側にも if/then があり二重に守る） |
| operation event は `operation` envelope 必須。correlation 値を `payload` から読まない | §3.1 | `assertOperationEnvelope`。correlation 関数は `payload` を参照しない。公開している `correlateTerminalEvent` も入口で同じ検査を行う（還元器を経由しない呼び出しで飛ばすと、既知の terminal kind が envelope 無しで届いたとき §3.1 違反が「照合できなかっただけ」の `terminal_unmatched` に化けて、壊れた adapter の証跡がそのまま保存される）。同じ理由で `assertSameScope` も入口で行う: 候補の絞り込みは session と lineage しか見ず、状態は Agent を 1 つしか持たないので、ここで比べないと別 Agent の terminal が「権威ある一致」として返り、consumer がそれを適用する |
| dedupe authority は `adapterDeliveryId`、無ければ canonical fingerprint | v6 §8.2 | `idempotencyKeyOf` は fallback（union ではない。正本の導出式が `??` で書かれている）。schema が `adapterDeliveryId` に minLength を持たないので、空文字は「無い」として fingerprint へ落とす |
| dedupe は revision 採番の**前** | §4.2 | `reduceTaskWorkState` は ledger 照合を最初に行い、重複なら何も採番しない |
| 重複した論理 event は no-op（同じ state bytes・content hash・revision・history） | §4.2 | 重複経路は入力の snapshot をそのまま返す。ledger も同一参照 |
| 遅れて届いた event も後続 revision を作り、証跡を書き換えない | §4.2 | 適用は常に新しい revision を作る。既存 `sourceEventIds` は追記のみ |
| terminal 照合は 1) `nativeOperationId` 一致 2) `operationMatchKey` + turn/kind 一致かつ open な候補が 1 件 3) それ以外は不一致 | §4.3 | `correlateTerminalEvent`。`nativeOperationId` を名乗った terminal は rule 1 だけで判定する（一致しないときに rule 2 へ落とすと、matchKey の導出が §4.3 どおりでない adapter 相手に別 operation を診断なしで閉じてしまう。wire 越しに導出は検証できない） |
| terminal は start より後（権威順序）・未適用・payload/source hash 非衝突 | §4.3 | ingestSeq 比較 / status 判定 / `canonicalInputHash` 比較。**「未適用」と「非衝突」は配送 ID が違う 2 通目で同時に問題になる**: dedupe は内容を比べられず、identity 衝突検査は kind と input hash しか見ないので、成否だけが逆の terminal が「適用済み」として黙って通っていた。受理済み terminal の source hash は状態に持っていない（凍結 schema に置き場が無い。#43）が、確定した status は持っているので、**成否の矛盾は `terminal_conflict` で隔離する**（どちらかが `unknown` = 成否を主張していない場合は矛盾ではない）。rule 2 の候補は同じ matchKey の兄弟をまとめて拾う（同じ turn で同じ tool を同じ入力で 2 回動かした場合など）ので、矛盾の判定は候補集合全体に対して行う: **成否が一致する候補が 1 件でもあれば再配送として説明がつく**ので隔離しない。兄弟の成否だけを見て隔離すると、健全な再配送が台帳に入らないまま無限に再送される。source hash（`canonicalFingerprint`）の衝突は correlation より前の dedupe で見る。冪等台帳が eventId だけを持つと、同じ配送 ID で内容が違う event が `duplicate` として捨てられて衝突検査が到達不能になるので、台帳は適用時の source hash も保持する（`LedgerEntryV1`）。衝突は `delivery_conflict` で隔離 |
| 0 件または複数一致の terminal は何も閉じず、診断を出す | §4.3 | `terminal_orphaned`（候補ゼロ）/ `terminal_unmatched` / `terminal_ambiguous` を返す。候補が居る場合は open のまま `unknown` にする |
| correlation / hash の衝突は隔離する | §4.3・v6「same op ID + different hash: quarantine corruption」 | `outcome: "quarantined"`。状態にも台帳にも入れない（入れると訂正版の再配送が重複 no-op になる）。判定材料は `operationKind`（= 保持側の `toolName`）と `canonicalInputHash` の直接比較で、terminal 側では `operationMatchKey` を比べない（§4.3 の matchKey は入力に「turn when present」を含むので、turn をまたいだ terminal が start と違う matchKey を持つのは仕様どおり。rule 1 は turn を要求しない = turn 両立は rule 2 の要件なので、ここで一致を求めると背景実行の完了や prompt 境界をまたいだ tool が永久に閉じない）。kind は matchKey の入力に含まれる identity の一部だが turn と違って start から terminal の間に変わらないので、rule 1 で選んだ候補にも要求できる（**§4.3 の rule 1 の字義は native ID + session/lineage だけなので、kind で絞るのは harness 判断**。identity の一部であること自体は §4.3 の matchKey 導出が担保している）。ただし `toolName` は凍結 schema の `required` に無いので、checkpoint から復元した状態や別実装が書いた状態では schema 妥当なまま欠けうる。素で比べると健全な terminal が永久に隔離され台帳にも入らない（= adapter が無限再送）ため、兄弟の `canonicalInputHash` と同じく**両方 present のときだけ**比べる。start の再配送側は `operationMatchKey` / `operationKind` / `nativeOperationId` / `canonicalInputHash` / `sessionId` / `turnId` を見る（同じ native ID は同じ呼び出しなので turn も同じはず）。`sessionId` を含めるのは、`operationId` が `eventId` + `matchKey` からの導出で session を含まず、`assertSameScope` も lineage と Agent しか束縛せず、状態が session を持たない（lineage は session をまたぐ）ため、ここで比べないと誰も比べないから。`OperationCorrelationV1` の `required` なので任意欄と違って両方 present ガードは要らない。`turnId` も同じく誰も比べていなかった（§4.3 は matchKey の入力に「turn when present」を含むので、正しく導出された matchKey なら turn が違えば matchKey も違うが、導出は wire 越しに検証できない）。記録された turn は rule 2 の候補選び（`eligible`）が使うので、古い turn のまま重複として台帳に入れると、その operation は本来の turn の terminal で閉じられず `terminal_unmatched` で `unknown` に倒れる。`turnId` は `required` に無く `turnIdSource: unavailable` では正当に不在なので、こちらは両方 present のときだけ比べる。start 側の `turnIdSource` は凍結 schema の外（`operationStarts`。#35）にあり、復元直後は空でちょうど必要なときに比べられないので、識別材料には含めない。**隔離するのは候補が全件衝突する場合だけ**にする: §4.3 どおりに matchKey を導出しない adapter では同じ matchKey で input hash が違う pending が並びうるので、identity が衝突する候補は「この terminal のものである可能性」から外すだけにして、他の候補の照合を妨げない。兄弟の identity を根拠に隔離すると live な operation が永久に閉じない。**免除ではなく絞り込みにする**のが要点で、「互換な候補が 1 件でもあれば全体を免除する」形にすると、確定済みの互換候補が囮になって衝突する open な候補に terminal が付く（確定済み A（hash A）＋ open な B（hash B）に A の terminal を再配送すると、B が診断ゼロで `succeeded` になる）。以降の open 選択・確定済み成否の照合はすべて互換な候補だけを見る。**terminal が識別材料を省いた場合は「衝突しない」ではなく「照合できない」**: 両方 present ガードは復元耐性のためにあるが、そのままだと `canonicalInputHash` を省くだけで検査を無効化でき、同じ matchKey の別 operation を閉じられる（省略は wire 側の自由なので攻撃者が選べる経路）。記録側が持つ欄を terminal が省いていたら適用せず、`terminal_identity_unverifiable` で候補を `unknown` に倒す（隔離ではないので台帳には入り、後から届いた本物の terminal がそのまま閉じられる）。`toolName` 側に対称のものが要らないのは、`operationKind` が envelope の必須欄で空も許さないため terminal から省けないから。**ただし発火は互換な候補が 2 件以上あるときに限る**: `canonicalInputHash` は凍結 envelope の任意欄（§3.1）なので省略自体は schema 妥当で、§4.3 が terminal に課すのは「non-conflicting な payload/source hash」＝衝突しないことであって不在は衝突ではない。§4.3 の matchKey は canonical input hash を入力に含むので、仕様どおりに導出する adapter では hash 違いの兄弟はそもそも候補に並ばず、候補が 1 件なら省略で付け替えられる相手が居ない（照合権限は rule 1 = `nativeOperationId`、rule 2 = matchKey + 互換な turn/kind が既に一意に決めている）。素で発火させると「terminal は入力ではなく結果なので hash を載せない」adapter の terminal が 1 通残らず閉じなくなる。候補が 2 件以上並ぶのは matchKey を仕様どおりに導出しない adapter だけで、そこでは hash が唯一の弁別子なので省略された時点で倒す。**判定の位置は成否矛盾検査より後**にする: 前に置くと、確定済みの候補に矛盾する terminal が hash を省くだけで隔離（台帳を消費しないので訂正版が後から効く）を回避して照合不能（台帳を消費する）に化け、訂正版の再配送が重複 no-op として捨てられる |
| 成否が曖昧な terminal は `unknown` を確定する | §4.3 | `successful` が無い場合に加え、kind が失敗を宣言しているのに `successful: true` を名乗る自己矛盾も `unknown` に倒し `terminal_evidence_contradicts` を出す（schema はどちらの欄も valid なので通るが、`succeeded` にすると壊れた adapter が失敗を握り潰せる）。矛盾は照合の成否と無関係な event 自身の性質なので、**照合前に判定して全経路（隔離・unmatched・適用）で出す**。照合できた場合しか出さないと、同じ壊れた adapter でも operation が既に閉じているときだけ `terminal_already_applied` に埋もれて見えなくなる |
| rule 2 は双方が同じ `turnIdSource` 種別の turn 同一性を持つことを要求する | §4.3 | start 側の種別を側索引 `operationStarts` に保持して照合する。照合は候補を 1 件に絞ってから行う（絞る前に種別を比べると、`operationStarts` が空の復元直後に「材料が無い」を「turn 同一性が無い」と報告してしまい、§3.1 が求める降格理由の報告が事実と食い違う） |
| 放棄・復帰時に証跡が無い operation は `unknown` | §4.3 | `finalizeAbandonedState`。§4.2 の重複 no-op はこの経路にも掛かるので、台帳を受け取り、同じ放棄 event の再配送では revision を採番し直さない。配送 ID の衝突判定も還元器と同じで、同じ配送 ID で source hash が違う放棄 event は `outcome: "quarantined"` にする（重複として黙って捨てると放棄が落ちて operation が `started` のまま残る）。放棄の kind は還元器の入口でも弾く（`reduceTaskWorkState` に渡すと operation envelope を持たないので汎用 commit に落ち、状態を変えないまま台帳の鍵だけ消費する。その台帳を渡された `finalizeAbandonedState` は重複として捨てるので、放棄が永久に適用されず operation が `started` のまま残る）。放棄するのはその event の session の operation だけ（lineage は session をまたいで続く。§5 の checkpoint は `sourceSessionId` と `taskLineageId` を別に持つので、絞らないと遅れて届いた旧 session の `session_ended` が resume 先の live な operation を潰す）。還元器の terminal 経路と同じく**黙って間引かない**: `sourceEventIds` が上限の operation は status だけ `unknown` に変わって、そう変えた理由の event が状態から落ちるので、`AbandonmentResultV1.diagnostics` に `source_events_truncated` を出す |
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

集約は状態の内容を走査して見つけた `sensitivity` の最大を取る（欄を手で並べると、状態に欄が
増えたとき集約から漏れるため）。**直前の revision の集約値を下限に含める**ので、集約は revision を
またいで単調非減少になる。§10 が集約値を実体に持たせる理由は「raw event の TTL 後には遡って判定
できない」ことなので、構成要素が状態から消えても機密度は下げない（`retainPendingOperations` の退避は
保管上の都合であって「機密ではなくなった」という証跡ではない）。含めないと、唯一の `secret` な
構成要素が退避された次の revision で `private` / `normal` に落ち、§9.2 の remote 送信ゲートが開く。
この模型に格下げの event は無いので、単調にしても失うものは無い。§10 の語彙（`normal` / `private` / `secret`）に無い値を見つけた
ときは最上位に倒す。`indexOf` の `-1` をそのまま順位に使うと最下位（`normal`）に落ちて fail open
になるので、「機密度不明」は自動 resume を止める側へ倒す。

語彙外の値は schema 不正とは限らない。宣言されている `sensitivity` 欄はすべて `$ref: Sensitivity`
（`enum: ["normal","private","secret"]`）だが、集約は状態の内容を再帰して「`sensitivity` という名前の
string キー」を全部拾うので、`Observed.value`（`$ref: JsonValue` = 任意ネストの自由形式）の中に
入った `sensitivity` キーは enum の制約を受けない = **schema 妥当なまま語彙外が入りうる**。
`nativeTodoState` がその経路。

**単調化の代償**（どちらも fail closed 方向なので穴ではないが、#36 が実分類器を入れるときに
移行経路が要る）:

- 語彙外を 1 回混ぜると lineage が恒久的に `secret` になる（原因の payload を直しても戻らない）。
  単調化前は、その構成要素が状態から消えれば戻っていた。
- `sensitivity: private` 固定のプレースホルダが恒久化する。`tool_started` が 1 本でも通れば
  lineage は永久に `private` 以上になり、v6:1001 が `private` 以上を remote refinement / extraction の
  ゲート対象にするので、**tool を 1 度でも使った lineage は §9.2 の送信から恒久的に外れる**。
  #36 で実分類器を入れるときは、集約値の再導出（または移行）の経路を用意する必要がある。

同じ向きの既定が 2 つある:

- **capability matrix が空の daemon には native を与えない**。`activeCapabilityHash` が空文字のとき、
  caller も空文字を名乗れば「一致」してしまう。§3.1 の proven は「active exact-version capability
  matrix hash と等しいこと」なので、matrix が無いなら proven も無い（`sourceAgent` /
  `sourceAgentVersion` の空文字ガードと同じ扱い）。
- **冪等台帳の内部鍵は authority ごとに分ける**。v6 §8.2 の導出式は `adapterDeliveryId` と
  canonical fingerprint を同じ keyspace に置くが、`adapterDeliveryId` は adapter が自由に採番する
  値なので、他 event の `canonicalFingerprint` を写した event を先に送ると本物が診断ゼロの重複と
  して消える。wire に出る導出式（`idempotencyKeyOf`）は正本のままにして、台帳の中だけ
  `d:` / `f:` で分ける。分離は wire にも hash にも出ないので契約に影響しない。

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

状態は projection なので、退避した operation の event 自体は daemon の event store 側に残りうる
（§6.4 は acceptance transaction の中で event store を再照会する）。ただし **event の保持期間は
addendum に無い**ので、「必ず残る」とは書けない。退避を状態に記録する場所も frozen schema には
無く、`started` を落とした場合その operation は状態から痕跡ごと消える（診断には出るが、診断は
永続化されない）。完了した operation の永続的な置き場は per-kind projection（§3 の未実装項目）で、
そこが入るまでは上限に達した長い session で相関の履歴が短くなる。この扱いも #39 で決める。

側索引 `operationStarts` は frozen schema の外にあるので上限を持たないが、退避した
`operationId` は同時に削る。削らないと `pendingOperations` が 256 件で頭打ちの一方でこの表だけが
単調増加する。

### 2.10 閉じられない terminal を「記録できる」と「記録できない」で分ける

§4.3 は「zero or multiple にマッチした terminal は何も閉じず、unmatched evidence として保ち、
候補を `unknown` のままにし、診断を出す」と要求するが、`outcome` と冪等台帳の扱いは書いていない。
**状態に記録できる相手が居るかどうか**で分けた。

**隔離する（状態にも台帳にも入れない）**:

- `terminal_conflict`（v6「same op ID + different hash: quarantine corruption」）。台帳に入れると
  訂正版の再配送が重複 no-op として黙って捨てられる
- `terminal_orphaned`（候補が 1 件も無い）。start より先に terminal が届く順序前後は正常運用で
  起きる（hook と transcript scan の取り込み順、再起動後の catch-up）。台帳に入れると、後から
  start が届いても同じ terminal は重複 no-op になり二度と閉じられない。隔離しておけば再配送で
  拾い直せるし、閉じられない operation が状態に残るわけでもない

**候補を `unknown` に倒して台帳へ入れる**:

- `terminal_unmatched`（候補は居るが turn 両立などで 1 件に絞れない）/ `terminal_ambiguous`
- `terminal_out_of_order`（start の `ingestSeq` が状態にあり、terminal がそれ以前）。terminal の
  証跡が来ている以上「まだ走っている」とは言えない。`unknown` にするのは一致した 1 件だけで、
  同じ match key の無関係な open は巻き込まない
- `terminal_order_unverifiable`（checkpoint から復元して `operationStarts` が空: #35）。**ここを
  隔離にしてはいけない**。復元直後は全 terminal がこの分岐に落ちるため、隔離すると operation が
  `started` のまま二度と閉じられず、resume capsule が「まだ実行中」と偽る（`unknown` より悪い）。
  §3.1 の fail closed（自動経路を降格し、理由を doctor に出す）どおり `unknown` へ倒す

`terminal_orphaned` を `terminal_unmatched` と別 code にしたのは、同じ code で `outcome` が
分かれると doctor が「start 待ちの孤児」と「候補は居るが絞れない」を区別できないため。

**この隔離は §4.3 の文面からの明示的な乖離**。§4.3 は「zero **or multiple** にマッチした terminal は
… unmatched evidence として保つ」と書き、隔離は「correlation/hash conflict」に限っている。しかし
`CanonicalWorkStateV1` には unmatched evidence の置き場が無く（候補が 0 件なので `sourceEventIds` を
足す相手が居ない）、frozen schema のままでは正本どおりに実装できない。台帳へ入れる側に倒すと
上記のとおり順序前後の孤児を永久に殺すので隔離を選んだ。Rust 実装が同じ選択をできるよう、
schema 側の穴として起票する（#39 の配列上限とは別件）。

**復元後に再配送された start で `operationStarts` を埋めない。** §6.4 は `ingestSeq` を
「authoritative event-store watermark（適用済みの最大 `ingestSeq`）」と定義しており、採番するのは
daemon の event store である。したがって再配送 event が運ぶ `ingestSeq` は再配送時の取り込み位置で
あって、元の start の権威順序ではない。埋めると 2 つの意味で壊れる:

1. **正しさ**: 再配送の位置を元の start の位置として順序検査に使うことになる
2. **信頼境界**: 復元直後（`operationStarts` が空）に、被害者の `startEventId` か `nativeOperationId`
   と `operationMatchKey` を写した start を**小さい `ingestSeq`** で送ると、正規の terminal が順序検査を
   通って `unknown` ではなく `succeeded` になる。§14 の zero-tolerance カウンタ
   `unsafe unknown replay` に直結する（材料は §10 の `ResumeCapsuleV1.workState` がそのまま運ぶ）

よって復元後は `terminal_order_unverifiable` で `unknown` に倒れる。これが §3.1 の fail closed どおり
であり、順序材料の復旧は #35（start の `ingestSeq` を `PendingOperation` に持たせる）が本筋。

**台帳だけを失った復元**では、再配送された start が還元器に届く。再送契約では再配送の
`eventId` が変わるので、`operationId = SHA-256(JCS({schema, startEventId, operationMatchKey}))` は
一致しない。そのままだと同じ operation が 2 件積まれ、以後 rule 1 の terminal が候補 2 件で
何も閉じられなくなる。`nativeOperationId` は本物の呼び出しごとに一意なので、それが一致する
pending があれば再配送として扱う。`nativeOperationId` を出さない adapter では 2 回目の本物の
呼び出しと区別できないので、この経路は使わない（§4.3 が rule 1 だけに閉じる権限を与えているのと
同じ非対称）。

同じ `nativeOperationId` を名乗りながら `operationMatchKey` か `operationKind` か `canonicalInputHash`
が違う start は再配送ではなく corruption なので `start_conflict` で隔離する（再配送として台帳に
入れると、訂正版が同じ配送 ID で来ても重複 no-op になって戻せない）。terminal 側と違って matchKey も
比べるのは、同じ native ID は同じ呼び出し = 同じ turn のはずで、turn 差で matchKey が変わる余地が
無いため。再配送の検索は「導出した `operationId` 一致」→「`nativeOperationId` 一致」の順に当たるので、
前者で当たった場合は native ID を一度も比べていない。そのため衝突検査は `nativeOperationId` の
直接比較も持つ（後者で当たった場合は常に等しいので効かない）。

**`terminal_orphaned` の隔離には期限が無い**。start が後から来る孤児（順序前後）と、start が二度と
来ない孤児（退避で消えた operation、daemon が実行途中で attach して terminal だけ捕まえた場合）は
還元器の中では区別できない。台帳に入れる側に倒すと前者を永久に殺すので隔離を選んだが、後者は
adapter が再送を続けることになる。

**打ち切りは呼び出し側の責務**とする。`quarantined` + `terminal_orphaned` を受けた delivery 層は、
同じ冪等キーの再送を「その session の `lastIngestSeq` が孤児 terminal の `ingestSeq` を十分に
追い越すまで」に限り、それを過ぎたら unmatched evidence として doctor に出して捨てる。還元器側に
期限を持たせないのは、時刻も試行回数も状態に入れられない（決定的でなくなる・frozen schema に
置き場が無い）ため。退避された operation を状態に残す場所ができれば（#39）この分岐の後者は消える。

### 2.11 event kind の分類（#29）

`operation` envelope を要求する kind の集合は正本に無い。harness の正規化語彙
（`harness/schema/capability.ts` の `EventKind`）に対する分類を
`OPERATION_EVENT_PHASES` / `NON_OPERATION_EVENT_KINDS` として `harness/schema/continuity.ts` に置いた。
test は「2 つの和が `EVENT_KINDS` に過不足なく一致する」ことを `EVENT_KINDS` から導いて検査するので、
kind を足すと分類を決めるまで CI が落ちる。語彙に無い adapter 固有の kind は未分類として
envelope を要求しない（既知の非 operation kind が envelope を持つ場合だけ拒否する）。

同じ理由で、**どの kind が放棄を確定するかも正本に無い**。§4.3 は「放棄・復帰時に証跡が無い
operation は `unknown`」とだけ書く。`finalizeAbandonedState` は export された関数なので、限らないと
routing の取り違えで届いた `user_prompted` 等が同 session の実行中 operation を全部 `unknown` に
したうえで冪等キーを消費する。語彙のうち「その session がもう進まない」と言える
`session_ended` / `session_interrupted` の 2 つに限り、他の kind は throw する。復帰側（resume）は
event ではなく checkpoint 経路なのでここには含めない。

`canonicalFingerprint` は schema の `required` に入っているが `maxLength` しか制約が無いので空文字が届きうる。v6 §8.2 の dedupe authority は「`adapterDeliveryId`、無ければ canonical fingerprint」なので、空文字を「値がある」と読むと
2 通りに壊れる: 配送 ID を持たない event が全部 1 つの鍵に潰れて最初の 1 件以外が診断ゼロで消える／配送 ID を持つ event は
台帳に source hash 無しで載り、同じ配送 ID の訂正版が衝突検査を素通りして重複として捨てられる。空文字の
`adapterDeliveryId` は fingerprint へ落とせるがこちらは落とし先が無いので、`assertIdentityMaterial` で schema violation にする。

同じ関数で `eventId` の空文字も落とす。`deriveOperationId(eventId, matchKey)` の材料なので、空文字だと同じ turn の
rule 2 の start が 2 件とも同じ operationId になり、2 件目が `duplicate_operation_start` として消える
（以後その operation の terminal は照合できない）。

`sessionId` も同じ族。§4.3 の候補選びと放棄はどちらも session で絞るので、空文字だと session を
特定できない adapter の event が全部同じ scope に入り、別 session の terminal が診断ゼロで operation を
閉じ、別 session の `session_ended` がそれを放棄する（実 ID なら `terminal_orphaned` で隔離される）。
`turnId` と違って「不在」を表す語彙が無いので落とすしかない。これは bot 指摘ではなく、同じ族を
schema の `required` 側から棚卸しして見つけたもの。

`turnId` も同じ形の穴を持つ。schema は `maxLength` しか課さないので、`turnIdSource` が native /
synthesized_monotonic のまま空文字が届きうる。空文字を「turn がある」と読むと §4.3 rule 2 の turn 同一性が
空文字同士で成立し、無関係な turn の operation を閉じる。unavailable な turn を全部空文字で表す adapter では
全 operation が 1 つの turn に潰れるので、`assertTurnIdentity` で schema violation にする（`unavailable` の
ときに `turnId` を持てない不変条件は従来どおり）。

envelope の任意欄（`nativeOperationId` / `canonicalInputHash`）は schema が `maxLength` しか持たない
ので空文字が届きうる。空文字を「値がある」と読むと rule 1 が「native ID を持たない operation」
同士を全部同じものとして照合するため、`assertOperationEnvelope` で schema violation に落とす
（正規化を照合側の 5 箇所に散らさない）。この欄の検査は **adapter 固有の kind にも掛ける**。
既知の phase を持たない kind は phase の照合こそできないが、envelope を持つなら還元器の
operation 経路（start / terminal）にそのまま入るので、検査を飛ばすと同じ穴が custom kind 経由で
開いたままになる。

**空判定は「空文字」ではなく「空白・書式制御文字だけ」で行う**（`isBlank`）。schema が課すのは
`maxLength` だけなので、上に並べた実害はどれも空白 1 文字・タブ・改行・U+FEFF・U+200B でそのまま
再現する（`unavailable` を空文字で表す adapter は、同じ理由で空白でも表す）。JS の `\s` は U+FEFF まで
含むが U+200B などの書式制御文字は含まないので `\p{Cf}` を足す。判定は 1 箇所に置いて
`assertIdentityMaterial` / `assertTurnIdentity` / `assertOperationFields` / `idempotencyKeyOf` /
`ledgerKeyOf` / `sourceHashOf` の全部で使う（ゲートを足すたびに同じ穴を作り直さないため）。
空白を**含む**だけの値（`"session 1"`）と `"0"` は identity として妥当なので落とさない。

**残るリスクは state 側に移った**。`CanonicalWorkStateV1` の
`{taskLineageId, sourceAgent, projectId, workspaceId, stateRevision}` はどれも `required` + `maxLength`
だけで、還元器はどれも検査しない。event 側に同じガードを足しても意味は無い（`assertSameScope` が
event の `taskLineageId` / `sourceAgent` を state の値と突き合わせるので、event 側の検査は state 側の
anchor があるぶん構造的に冗長で、唯一残る失敗形「state 側が空」では一致する正しい event まで落として
全停止になるだけ）。**Task 6 の `reconcileWorkspace` が event から state を生む時点で、これらの非空を
保証すること**が本 PR からの前提条件。

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
- **event kind が成否を主張するかは語彙に書かれていない**。`tool_completed` / `tool_failed` は
  `harness/schema/capability.ts` の `EventKind` に列挙があるだけで、意味の定義が正本にも harness にも
  無い。`tool_failed` は名前が失敗を宣言しているので `successful: true` を矛盾として扱うが、
  `tool_completed` が成功まで主張するかは決められないので `successful: false` は矛盾扱いしない
  （`failed` のまま記録する）。語彙側で決めるべき宿題。
- **turn identity の降格を誰が行うかは正本が決めていない**（#41）。§3.1 が intake に与えている
  権限は `evidenceKind` と `ingestAttestation` で、`turnIdSource` の書き換えは明示されていない
  （§14 は未証明時の措置を `turnIdentityDisposition` による delivery 層の downgrade として書く）。
  ここでは fail closed の向きに合わせて intake が `unavailable` へ倒している。
  同じ節で `synthesized_monotonic` は「adapter-assigned monotonic turn counter」とだけ定義され、
  `native` の「proven for that exact version」に相当する認証条件が無い。正本が無言なので
  monotonic は認証されていなくても降格しない実装にしてある。これも #41 で決める。
- **`assertSameScope` の不一致は throw する**。別 Agent / 別 lineage の event を状態に渡すのは
  router のバグなので隔離ではなく例外に倒しているが、`sourceAgent` は event が名乗る値なので、
  scope を event 由来で選ぶ実装だと 1 件の取り違えで stream が止まりうる。daemon 側で
  「state は認証済み peer identity で選ぶ」を守る前提。
- **`sessionId` を束縛する層が無い**。§4.3 の correlation scope は「same session/task lineage」だが、
  §3.1 が intake に導出させるのは「認証済み peer identity・ingest channel・`captureMethod`・
  capability matrix」だけで **session は挙がっていない**。`IntakeContextV1` は `expectedSourceAgent` を
  束縛するが session は素通しで、`assertSameScope` は状態側に session が無いので照合できない。
  結果として、同じ Agent・同じ lineage の別 session を名乗る event が rule 1 で他人の operation を
  閉じられ、安価な start 256 件で他人の実行中 operation を状態から退避させられる（§10 の
  `arrayItems`）。§3.1 に session 束縛の一文が無いこと自体が正本の穴なので、#41 と並べて起票する。
- **還元器は event の schema 妥当性を前提にする**。`ingestSeq` は decimal string として検査するが、
  `occurredAt` の形式・文字列長（§10）・JSON 深さは見ない。壊れた値をそのまま状態に写すので、
  daemon 側で `reduceTaskWorkState` を呼ぶ前に `NormalizedContinuityEvent` schema での検証を
  済ませておく前提。同様に `IntakeStampedEventV1` の目印は型だけのもの（`JSON.parse` や spool を
  跨げば消える）なので、信頼境界ではなく呼び順の lint として扱う。
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
bash harness/continuity/mutate.sh                                 # §5 の変異テスト
```

`harness/fixtures/continuity/tool-lifecycle-reduction.json` の `expected` は参照実装の出力そのもの。
導出（2.1）を変えたら test が期待値との差分で落ちるので、意図した変更であることを確認してから
`expected` を書き直す。

## 5. 変異テスト（2026-08-17）

スクリプトは `harness/continuity/mutate.sh`（`bash harness/continuity/mutate.sh` で再現できる）。
各ゲートをわざと壊し、対応する test が落ちることを確認した。**88 件すべてで 1 件以上が失敗**し、
生存はゼロ、実行件数も期待どおり 88 件（黙って飛ばされた変異ゼロ）、復元後は 108/108 green。

kill 率より先に**実行件数**を見ること。変異はソース中の文字列アンカーで当てるので、実装を直すと
`assert old in s` が落ちて `&&` が短絡し、その変異は**出力に何も出ないまま黙って飛ばされる**
（このラウンドだけで 9 件が外れた）。この突き合わせはスクリプト自身が行うようにした: 末尾で
`実行 N / 期待 M、生存 K` を出し、**M ≠ N（黙って飛ばされた）か K > 0（生存した）なら非ゼロで
終わる**ので、kill 率を人が読んで判断する必要がない。期待件数はスクリプト自身の `run` ラベル数
から数える。変異でソースが壊れて test が 1 つも走らなかった場合も、そのゲートを検証できていない
点は生存と同じなので生存に数える。

この自己検査自体が発火することを確かめてある（先頭 1 変異だけに切り詰めた写しで実測）:

| 写し | exit | 出力 |
|---|---:|---|
| 変異 1 件、正常 | 0 | 実行 1 / 期待 1、生存 0 |
| アンカーが存在しない変異を 1 件追加 | 1 | 実行 1 / 期待 2、生存 0 |
| 何も壊さない変異を 1 件追加 | 1 | 実行 2 / 期待 2、生存 1 |

| 壊した箇所 | 落ちた test 数 |
|---|---:|
| dedupe 判定を外す | 4 |
| lastIngestSeq の max を外す | 1 |
| ingestSeq を数値比較にする | 1 |
| envelope 必須を外す | 3 |
| intake の attestation 必須を外す | 3 |
| caller の attestation を信じる | 1 |
| sourceAgent の束縛を外す | 2 |
| 空の Agent 名を素通しする | 2 |
| native turn の証明要求を外す | 3 |
| turn 証明の version 束縛を外す | 2 |
| turn 降格を黙って行う | 1 |
| turn 同一性の不変条件を外す | 1 |
| state への Agent 束縛を外す | 2 |
| 空 adapterDeliveryId の fallback を外す | 2 |
| rule 1 の排他を外す | 1 |
| rule 2 の turn 同一性要求を外す | 2 |
| 候補が複数のときの拒否を外す | 2 |
| terminal 側に matchKey 一致を要求し直す | 1 |
| identity 衝突を候補 1 件で判定する | 4 |
| terminal の canonicalInputHash 衝突検査を外す | 5 |
| identity 衝突の隔離を外す | 5 |
| kind と successful の矛盾を素通しする | 2 |
| 矛盾診断を照合済み経路だけに戻す | 1 |
| 矛盾した terminal を succeeded にする | 1 |
| start 不在の分岐を外す | 4 |
| terminal の権威順序検査を外す | 2 |
| 順序違反で候補を巻き込む | 1 |
| 候補ゼロの terminal を台帳に入れる | 5 |
| 順序不明で候補を unknown にしない | 4 |
| 退避で順序材料を刈らない | 1 |
| 再配送 start を nativeOperationId で拾わない | 5 |
| 再配送の判定を matchKey にする | 6 |
| start の identity 衝突検査を外す | 6 |
| start の matchKey 衝突検査を外す | 1 |
| start の canonicalInputHash 衝突検査を外す | 1 |
| 放棄を session で絞らない | 1 |
| 候補の unknown 化を外す | 10 |
| unknown 化で証跡を残さない | 2 |
| sourceEventIds の上限を外す | 1 |
| pendingOperations の上限を外す | 1 |
| 退避対象から open を外す（詰まる） | 1 |
| 退避件数の上限を外す | 3 |
| 退避を黙って行う | 2 |
| revision ごとの配列分離を外す | 1 |
| 放棄経路の dedupe を外す | 2 |
| 台帳の keyspace 分離を外す | 1 |
| 空の capabilityHash を素通しする | 2 |
| 未知の sensitivity で fail open する | 1 |
| 空文字の任意欄を素通しする | 2 |
| start の operationKind 比較を外す | 1 |
| start の toolName 存在ガードを外す | 1 |
| 放棄 kind の制限を外す | 1 |
| 配送 ID 衝突の隔離を外す | 1 |
| sensitivity 集約を normal 固定にする | 4 |
| adapter 固有 kind の欄検査を外す | 1 |
| start の nativeOperationId 比較を外す | 1 |
| terminal の operationKind 比較を外す | 1 |
| terminal の toolName 存在ガードを外す | 1 |
| 放棄経路の配送 ID 衝突検査を外す | 1 |
| 空 canonicalFingerprint を素通しする | 2 |
| 確定済み成否との矛盾検査を外す | 2 |
| 成否を主張しない terminal も矛盾扱いにする | 3 |
| 成否が一致する兄弟の検査を外す | 1 |
| 放棄 kind を還元器に通す | 1 |
| 空文字の turnId を素通しする | 2 |
| 空文字の eventId を素通しする | 2 |
| sensitivity の下限に直前の集約値を使わない | 1 |
| 空文字の sessionId を素通しする | 2 |
| 空白文字を identity 材料として通す | 2 |
| 書式制御文字だけの identity 材料を通す | 2 |
| 空の operationMatchKey / operationKind を素通しする | 2 |
| open の選択を identity 互換に絞らない | 1 |
| canonicalInputHash の省略を照合可能として扱う | 1 |
| 再配送 start の session 検査を外す | 1 |
| 放棄で落とした証跡を報告しない | 1 |
| 直接呼びの envelope 検査を外す | 1 |
| 再配送 start の turn 検査を外す | 1 |
| 再配送 start の turn 存在ガードを外す | 1 |
| 候補 1 件でも照合不能ゲートを発火させる | 1 |
| 照合不能ゲートの候補数を 1 件ずらす | 1 |
| 照合不能を成否矛盾検査より先に判定する | 1 |
| 空白だけの capability hash を authority にする | 1 |
| 空白だけの Agent 名を authority にする | 1 |
| 空白だけの exact version を authority にする | 1 |
| 直接呼びの Agent 検査を外す | 1 |
| rule 2 の turn 種別の絞り込みを外す | 2 |
| turn 種別の材料が無い候補も落とす | 1 |
| 種別違いの巻き込み範囲を広げる | 1 |

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
