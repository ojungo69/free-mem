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
| 受領証は「その認証済み取り込みの receipt」であって、在ることだけでは認証の証拠にならない | §3.1 | `ingestReceiptId` / `peerIdentityId` が空白だけの受領証は `authenticatedVersion` を成立させない。認証できない経路を `undefined` ではなく**欄が空の受領証**で表す daemon では、存在だけを見ると誰も名乗っていない受領証が native authority の根拠になる。§3.1 は kind を「認証済み peer identity」から導けと言うので、peer を指していない受領証は根拠にならない。`channel` は閉じた union（`rpc` / `spool`）なので空白形が存在せず、検査を足していない。**検査を足す欄と足さない欄は schema で決まる**: 凍結 schema で `ingestReceiptId` / `peerIdentityId` / `scenarioId` は `type: string` + `maxLength` だけ = 空白が schema 妥当なので検査が要り、`channel` / `captureMethod` は enum なので閉じている（下記「還元器は event の schema 妥当性を前提にする」と同じ原則）。理由は欄ごとに違う: `channel` は authority 対 authority で caller が触れず、`captureMethod` は caller 側の値だが enum で閉じている |
| `scenarioId` は proven な scenario を **naming** していなければならない | §3.1 | 空白だけの `scenarioId` は proven の根拠にならない。matrix 側にも空白 entry を持つ daemon で caller が同じ空白を名乗ると等値で proven が成立する。caller 側を非空白に固定すれば matrix 側の空白 entry とは等値にならないので、検査は片側で足りる。`captureMethod` は閉じた union なので同様に検査不要 |
| exact version でない `sourceAgentVersion` は native authority を失う | §3.1 | `IntakeContextV1.exactAgentVersion` との一致を要求 |
| kind は「認証済み peer identity・channel・captureMethod・capability matrix」から導く | §3.1 | **`event.sourceAgent` が受領証の Agent（`expectedSourceAgent`）と食い違う event は、降格ではなく intake が受け取らない**（throw）。§3.1 は検査に落ちた event を `synthesized` へ降格せよと言うが、それは**証跡の質**の規定で、`sourceAgent` は質ではなく **scope selector** として使われる: `assertSameScope` が「どの状態を書き換えてよいか」をこの値の等値だけで決める。降格しても値そのものは残るので、外部のセキュリティレビューが指摘したとおり、peer=codex として認証された event が `sourceAgent: "claude"` を名乗ると `synthesized` の札を貼られたまま **claude の operation を診断ゼロで `succeeded` にできた**（実測）。correlation は `evidenceKind` を一度も読まないので、札は何も束縛しない——**wire が運ぶ値を authority にしない**という同じ原則の適用漏れだった。空白の `sourceAgent` を還元器が落とすのと同じ形で、他人の名前はそれより悪い（空白は「誰も名乗っていない」、他人の名前は「scope が矛盾する」）。認証できない経路（`expectedSourceAgent` が空 = 受領証が peer を名乗っていない）は「違う」と言える相手が居ないので従来どおり降格で扱い、締めすぎていないことも test と変異の両方向で固定した。intake は台帳より前なので throw しても配送鍵は消費されず、訂正版の再送はそのまま効く。**この棄却形は fixture 側にも持たせた**: `rejected-events.json` の `rejectedBy` に `intake-reject` を足し、降格（`intake`）と区別する。区別しないと、降格しか実装しない移植でも negative fixture が緑になり、TS/Rust parity の基準がこの規則を守らせない。この結果 `authenticatedVersion` の中の `event.sourceAgent === context.expectedSourceAgent` は到達時点で必ず true になるため削除した（証明済みに死んだ条件を authority 述語に残すと、検査が行われているように読める）。**境界**: intake を経由せず `reduceTaskWorkState` を直接呼ぶ経路では、状態と一致する `sourceAgent` を詐称した event を止められない。参照模型は認証済み peer を知らないので、そこは daemon の trust boundary であり、還元器側に検査を二重化はしない |
| `turnIdSource="native"` は exact version について proven な native turn identifier を要求する | §3.1 | `IntakeContextV1.nativeTurnIdentityProven` が false なら caller の native 主張を `unavailable` へ降格し `turnId` を落とす。証明は version に紐づくので、受領証・`sourceAgent`・`sourceAgentVersion` の束縛（`authenticatedVersion`）が成り立たない event にも適用しない。`capabilityHash` は capability matrix にまだ turn identity の cell が無い（#40）ため turn の判定には使わない。`synthesized_monotonic` は adapter 由来なので触らない。**この帰結として `activeCapabilityHash` または `scenarioId` だけが空白の場合、`evidenceKind` は `synthesized` に落ちるが `turnIdSource` は `native` のまま残る**（降格は `authenticatedVersion` だけに依存する）。turn identity の cell が matrix に入る（#40）まではこの非対称が正しい振る舞いで、回帰ではない |
| どちらかの turn が unavailable なら rule 2 は適用されず operation は `unknown` になる | §4.3 | 同じ match key の open な候補を `unresolved`（候補の参照）として返し、還元側で `unknown` にする。閉じられるのは rule 1 だけ。**turn 種別（`turnIdSource`）の一致は候補の絞り込みで見る**: 種別は start 側の材料（`operationStarts`。凍結 schema の外・#35）にしかないので、以前は候補を 1 件に絞ってから最後に比べていた。それだと「同じ matchKey・同じ turnId で種別だけ違う」候補が 2 件並んだとき、種別で 1 件に決まるはずのものが `terminal_ambiguous` になって**両方 `unknown` に倒れ、配送鍵も消費される**。絞り込み時に見れば rule 2 の「exactly one open candidate」が成立して閉じられる。ただし**材料がある候補だけ**種別で絞る（復元直後は `operationStarts` が空なので、材料が無いことを「種別が違う」と読むと理由を取り違える。§3.1 は降格の理由を doctor が報告することを求めている）。候補ゼロのときの診断も「turn 同一性が無い」と「種別が違う」で書き分け、`unknown` に倒す相手は種別違いならその候補だけにする。**open / 確定済みの切り分けもこの絞り込みの後で行う**: 先に切り分けると、turn が両立しない open な兄弟が「open が居る」と数えられて確定済み経路が飛ばされ、確定済み候補への健全な再配送が `terminal_unmatched` に化けて、その兄弟を `unknown` に倒し台帳まで消費する（兄弟はこの terminal では閉じえないので巻き込む理由が無い）。ただしその結果、確定済み経路には turn が両立しない **open な**候補が残りうるので、成否の矛盾判定は**確定済みの候補だけ**を見る（`started` は成否を主張していないので、それを矛盾として隔離すると健全な terminal が台帳に入らず無限再送になる）。**§4.3 の順序要件も同じく絞り込みで見る**。start より後の terminal だけがその operation を閉じられるという要件は、これまで候補を 1 件に決めたあとの検査だった。それだと start が 10 と 20 の候補が並ぶとき、`ingestSeq` 15 の terminal は「10 の側しか閉じえない」のに両方が候補として数えられ、`terminal_ambiguous` で**両方 `unknown` に倒れて台帳まで消費される**（実測。隔離と違って訂正版が重複 no-op になるので隔離より悪い）。`turnIdSource` と同じく材料がある候補だけを対象にし、rule 1 を名乗った terminal は絞らない。**全件が順序不適合なら絞らない**——そこで空にすると、候補 1 件が順序違反というだけの場合に `terminal_out_of_order`（何が起きたかを名指しする診断）が `terminal_unmatched` に化ける。通す側も test で固定した。**同じ絞り込みは、確定済みの候補で再配送を説明するときにも要る**（open な候補を選ぶときだけではない）: これは「この terminal が閉じえた候補」の定義なので、素の候補集合で説明を許すと、`native` の failed と `synthesized_monotonic` の succeeded が同じ matchKey・同じ turnId で並ぶとき、succeeded を名乗る `native` の 2 通目が**兄弟に説明されて** `terminal_already_applied` になる。隔離（台帳を消費しない）を回避して台帳を消費するので、後から届く訂正版が重複 no-op として捨てられる。絞り込みは `sameTurnOf` / `eligibleOf` の 2 つに切り出して、確定済みの説明・open な候補選びの両方で同じものを使う（rule 1 を名乗った terminal は turn 両立を要求しないので、どちらも `byNativeId` があれば素通しする）。**ただし絞るのは「説明がつくか」だけで、「成否が矛盾しているか」は絞らない**: この分岐は性質の違う 2 つの問いを続けて解いていて、(i)「この terminal は候補の再配送として説明がつくか」は閉じえた候補だけが説明役になれるので turn 両立が要るが、(ii)「確定済みの候補と成否が矛盾していないか」は**閉じる権限ではなく壊れた証跡かの判定**なので turn 両立は要らない。matchKey・kind・input hash まで同じ terminal が確定済みの status と逆を主張しているなら、turn の導出が §4.3 どおりでない adapter だとしても矛盾は矛盾。(ii) まで絞ると候補が全部落ちた場合に `find` が undefined を返し、隔離（台帳を消費しない）が `terminal_already_applied`（台帳を消費する）に化けて訂正版が重複 no-op になる。**判定の順序は原則として隔離が先**（台帳を消費しない分岐を、消費する分岐より先に置く）。**ただし「記録できる open な候補が居るか」がそれより優先する**。§4.3:368 は「zero か複数の open にマッチした terminal は何も閉じず、unmatched な証跡として保存し candidates を `unknown` にする」と終状態まで名指ししているので、記録できる候補が 1 件でも居るなら台帳を消費してでもそちらに従う。この優先順位は最初から在ったものではなく、隔離ゲートの優先度を `terminal_already_applied` に対してだけ決めていたところへ、open / 確定済みの切り分けを turn 絞り込みの後ろへ移して `open.length === 0` の到達範囲を広げたときに、`terminal_unmatched` に対して決め直していなかった穴を塞いだもの（**門を足すと隣に順序依存が生まれる**の実例で、外部レビューが実測で指摘した）。塞がないと「確定済みの兄弟が居て、turn が両立しない open な候補も居る」形が隔離に落ち、open な候補は `started` のまま残って状態が嘘をつく。しかも `turnIdSource` の食い違いは adapter の捕捉経路という**定常的な性質**なので「訂正版」が存在せず、還元器は純関数なので再送は毎回同じ隔離になる——`started` を矛盾集合から外した理由（無限再送）と同型の失敗が、確定済みの兄弟経由で残っていた。逆に、その terminal が**閉じえた**確定済み候補（turn 両立する候補）と成否が矛盾している場合は、記録できる open が居ても隔離のままにする（訂正版が存在しうる形なので、台帳を消費しないほうが回復に効く）。矛盾もしておらず記録できる候補も居ない場合だけ `unresolved` が空の `terminal_unmatched` になる。**照合不能（`terminal_identity_unverifiable`）で `unknown` に倒す相手も turn 両立する候補だけ**にする: 照合不能は「どの候補を指すか決められない」であって、rule 2 で閉じえない候補まで巻き込んでよい話ではない。rule 1 では `sameTurnOf` / `eligibleOf` が素通しなので `settled` が空になるのは rule 2 だけ |
| `turnIdSource` は凍結 schema の語彙（`native` / `synthesized_monotonic` / `unavailable`）だけを受ける | §3.1 | `assertTurnIdentity` の先頭で `TURN_ID_SOURCES` と突き合わせて落とす（語彙は手で並べず schema 側の定数から引く）。参照模型は event が schema 検証を通ってから届くとは限らない（intake も還元器も生の値を読む）ので、**語彙外の綴りは `unavailable` の分岐にも intake の `native` 証明要求にも当たらず、降格を丸ごと迂回して自称 `turnId` を保持できた**（実測: `"Native"` / `"NATIVE"` / 末尾空白の `"native "` / キリル а の同形異字 / `"bogus"` がいずれも診断ゼロで通り、`turnId` は `"turn-FORGED"` のまま残った。外部のコードレビューが指摘した）。そのまま §4.3 rule 2 に入ると `sameTurnOf` は `turnId` の等値、`eligibleOf` は記録と event の**自己一致**で通るので、捏造した turn 同一性で turn scope がまるごと成立する。空白の identity 材料に実行時ガードを置きながら、identity 上いちばん効くこの欄だけ素通しだった。還元器・correlate・放棄の 3 入口すべてで落ちることを test で固定した |
| turn scoping を要求する規則は unavailable に fail closed になり、downgrade の理由は doctor が報告する | §3.1 | intake の降格は `turn_identity_downgraded` 診断を返す。`stampIntakeEvidence` の戻り値は `{ event, diagnostics }` |
| `turnId` は native / synthesized_monotonic のとき必須、unavailable のとき不在 | §3.1 | `assertTurnIdentity`（schema 側にも if/then があり二重に守る） |
| operation event は `operation` envelope 必須。correlation 値を `payload` から読まない | §3.1 | `assertOperationEnvelope`。correlation 関数は `payload` を参照しない。公開している `correlateTerminalEvent` も入口で同じ検査を行う（還元器を経由しない呼び出しで飛ばすと、既知の terminal kind が envelope 無しで届いたとき §3.1 違反が「照合できなかっただけ」の `terminal_unmatched` に化けて、壊れた adapter の証跡がそのまま保存される）。同じ理由で `assertSameScope` も入口で行う: 候補の絞り込みは session と lineage しか見ず、状態は Agent を 1 つしか持たないので、ここで比べないと別 Agent の terminal が「権威ある一致」として返り、consumer がそれを適用する。**§22.6 の `ingestSeq` decimal string 制約も同じ理由で入口に置く**: `compareIngestSeq` は start を選んだ後の順序比較でしか走らないので、候補ゼロ・適用済み・曖昧・照合不能で早期 return する経路では検査されず、還元器が入口で落とす入力を直接呼びだけが `terminal_orphaned` として返していた。同じ突き合わせで `assertIdentityMaterial` の欠落も見つけた: `assertSameScope` は lineage と Agent しか束縛せず、候補の絞り込みは `sessionId` の等値だけを見るので、**空白の `sessionId` を持つ terminal が、同じく空白の `sessionId` を持つ pending（復元した checkpoint や別実装が書いた状態。凍結 schema に minLength は無い）を診断ゼロで閉じられた**。空白同士は「同じ session」ではなく「どちらも名乗っていない」。**同じことが `sourceAgent` にもある**: `assertSameScope` は `event.sourceAgent === state.sourceAgent` の等値しか見ず、凍結 schema は event 側にも状態側にも `maxLength` しか課さないので、Agent 同一性を「不明」として空白で表す adapter が 2 つあると互いの状態を同じ scope として書き換えられる（intake の降格は `evidenceKind` を落とすだけで scope は縛らないので、ここで落とさないと誰も落とさない）。`assertIdentityMaterial` で `canonicalFingerprint` / `eventId` / `sessionId` / `sourceAgent` の 4 欄を落とす。**`occurredAt` も同じ関数で落とす**（#27・§22.6）: 凍結 `IsoTimestamp` の綴りに合わない値と、綴りは合うが暦として実在しない値の 2 段で拒否する。綴りを先に当てないと `slice(0, 19)` の後ろが見られず、数値 offset・offset 無し・末尾ゴミ・切り詰めた値が通って**還元器が凍結 schema に適合しない状態を出す**。公開入口で守る不変条件は envelope・turn 同一性・identity 材料（`occurredAt` を含む）・`ingestSeq`・scope の 5 つになり、還元器および `finalizeAbandonedState` と同じ集合になった。**この「公開 API と還元器で守る不変条件の集合がずれる」形は round 12・14 と合わせて 3 回出ているので、export を増やすときは還元器入口の集合と突き合わせること**。**`correlateTerminalEvent` の引数型も `IntakeStampedEventV1` に揃えた**。当初は素の `NormalizedContinuityEvent` を受けていて、evidence にも「これは意図どおりで、correlate は `provenance` を一度も読まない = authority label を消費しないので、intake を経由しない event を受けても authority 判定の迂回にはならない」と書いていたが、**これは誤りだったので撤回する**（外部のセキュリティレビューが指摘し、実測で確認した）。correlate は `provenance` こそ読まないが、rule 2 の候補選びで `turnIdSource` を、`assertSameScope` で `sourceAgent` を見ており、**どちらも intake が認証結果に応じて書き換える欄**。つまり「読んでいる authority label が別の名前で存在していた」ので、intake を飛ばせば証明の無い native turn 主張がそのまま照合権限になる（実測: 未証明 native の rule 2 terminal は直接呼びだと `matched` になり、`stampIntakeEvidence` を通すと `unavailable` へ降格して `terminal_unmatched` になる）。型で intake の通過を要求すれば、還元器・放棄・公開入口の 3 つで前提が揃う。**この境界は実行時 test では固定できない**（test helper が `IntakeStampedEventV1` へキャストして返すので、引数型を戻しても実行結果は変わらない——外部レビューの advisory）。素の `NormalizedContinuityEvent` を渡す到達しない呼び出しに `@ts-expect-error` を置いて tsc で固定した。引数型が広がると「未使用の抑止」で tsc が落ちるので、締めた側と緩めた側の両方向で発火する（実測で確認）。**判断を誤った理由**は、authority を `provenance`（label の置き場）だけで探して、label が**書き換える対象の欄**を探さなかったこと |
| dedupe authority は `adapterDeliveryId`、無ければ canonical fingerprint | v6 §8.2 | `idempotencyKeyOf` は fallback（union ではない。正本の導出式が `??` で書かれている）。schema が `adapterDeliveryId` に minLength を持たないので、空白だけの値は「無い」として fingerprint へ落とす（`isBlank` なので空文字だけでなく空白・タブ・U+200B・U+FEFF も含む） |
| dedupe は revision 採番の**前** | §4.2 | `reduceTaskWorkState` は ledger 照合を最初に行い、重複なら何も採番しない |
| 重複した論理 event は no-op（同じ state bytes・content hash・revision・history） | §4.2 | 重複経路は入力の snapshot をそのまま返す。ledger も同一参照 |
| 遅れて届いた event も後続 revision を作り、証跡を書き換えない | §4.2 | 適用は常に新しい revision を作る。既存 `sourceEventIds` は追記のみ |
| terminal 照合は 1) `nativeOperationId` 一致 2) `operationMatchKey` + turn/kind 一致かつ open な候補が 1 件 3) それ以外は不一致 | §4.3 | `correlateTerminalEvent`。`nativeOperationId` を名乗った terminal は rule 1 だけで判定する（一致しないときに rule 2 へ落とすと、matchKey の導出が §4.3 どおりでない adapter 相手に別 operation を診断なしで閉じてしまう。wire 越しに導出は検証できない） |
| terminal は start より後（権威順序）・未適用・payload/source hash 非衝突 | §4.3 | ingestSeq 比較 / status 判定 / `canonicalInputHash` 比較。**「未適用」と「非衝突」は配送 ID が違う 2 通目で同時に問題になる**: dedupe は内容を比べられず、identity 衝突検査は kind と input hash しか見ないので、成否だけが逆の terminal が「適用済み」として黙って通っていた。受理済み terminal の source hash は状態に持っていない（凍結 schema に置き場が無い。#43）が、確定した status は持っているので、**成否の矛盾は `terminal_conflict` で隔離する**（どちらかが `unknown` = 成否を主張していない場合は矛盾ではない）。rule 2 の候補は同じ matchKey の兄弟をまとめて拾う（同じ turn で同じ tool を同じ入力で 2 回動かした場合など）ので、矛盾の判定は候補集合全体に対して行う: **成否が一致する候補が 1 件でもあれば再配送として説明がつく**ので隔離しない。兄弟の成否だけを見て隔離すると、健全な再配送が台帳に入らないまま無限に再送される。source hash（`canonicalFingerprint`）の衝突は correlation より前の dedupe で見る。冪等台帳が eventId だけを持つと、同じ配送 ID で内容が違う event が `duplicate` として捨てられて衝突検査が到達不能になるので、台帳は適用時の source hash も保持する（`LedgerEntryV1`）。衝突は `delivery_conflict` で隔離 |
| 台帳の鍵は `ledgerKeyOf`（`d:` / `f:` で keyspace を分けたもの）で、caller にも公開する | v6 §8.2 | `IdempotencyLedger` は caller が渡して caller に返るので、構築・永続化・復元は caller の責務。それなのに公開していたのは接頭辞の無い `idempotencyKeyOf` だけだった（実測: 還元器が引くのは `"d:delivery-start"`、公開関数が返すのは `"delivery-start"`）。公開関数で台帳を組み立て直した daemon は全 entry で還元器と食い違い、重複判定が一度も発火しないまま再配送が新規 event として適用される。`d:` / `f:` の分割は wire にも hash にも出ない内部詳細なので、caller が自力で再現しようと思う類の知識ではない（外部のコードレビューが指摘）。両方の鍵が違うこと自体も test で固定した |
| 状態を変えた経路はすべて原因 event を operation に残す | §3.1 | `withSourceEvent`。照合できた terminal・`unknown` に倒した候補・放棄はどれも呼んでいたのに、**再配送 start の経路だけ呼んでいなかった**（外部のコードレビューが指摘）。この経路は配送鍵を消費して revision も進め、さらに記録に欠けている識別材料を埋めるので、呼ばないと**状態が変わった理由が状態からも辿れない**（`history` は `CanonicalWorkStateV1` の欄ではないので永続的な provenance にならない）。`withSourceEvent` が早期 return する条件は **2 つあり、意味が違う**: (a) 既に記録済み（同じ eventId の再配送＝台帳だけ失った復元。何も失っていない）、(b) `sourceEventIds` が上限 256 件（**記録できなかった**）。増えるのは eventId が変わる本来の再配送契約で、かつ上限に達していないときだけ。**再配送 start の経路でも (b) は起こる**ので、この経路は `duplicate_operation_start` に加えて `source_events_truncated` を出す（片方だけだと「記録できなかった」ことが状態にも診断にも残らない）。**同じ「片方だけ揃っていない」は `source_events_truncated` の判定にもあった**: `withSourceEvent` は「既に記録済みなら何もしない」を先に見るのに、診断側は配列長しか見ていなかったので、**何も失っていないのに truncation を報告する**（診断文は「この event を記録できない」と event について断言する形なので、本当に記録できなかった場合と区別がつかない）。両方に同じ `includes` を置いた |
| 隔離するのは「状態に記録できる相手が居ない」場合だけ | §4.3・§3.1 | 判定は**診断コードの列挙ではなく結果**から導く: `unresolved` が空なら、その commit は候補を 1 件も `unknown` にしないので状態に何も残さない（#43 のとおり unmatched evidence の置き場が凍結 schema に無いので history にしか残らない）。それでいて配送鍵は消費するので、隔離との差は「鍵を焼くかどうか」しかない。当初はコード名で `terminal_conflict` / `terminal_orphaned` を並べていたが、**同じ状態に別のコードで到達する経路が漏れていた**（外部のコードレビューが指摘し、実測で確認した: 確定済みで同じ matchKey の兄弟が 1 件居るだけで、start より先に届いた terminal が `terminal_orphaned`（隔離・鍵を残す）ではなく `terminal_unmatched`（commit・鍵を消費）に落ちた。start より先に terminal が届くのは正常運用——hook と transcript scan の取り込み順、再起動後の catch-up——なので、鍵を焼くと後から start が届いてからの再配送が重複 no-op になり operation は永久に `started`。この失敗はこの分岐のコメントが `terminal_orphaned` について既に書いていたもので、**規則を名前で並べたせいで規則自身の対象が漏れた**）。例外は `terminal_already_applied` で、これは「既に閉じた operation の再配送」= 本当に重複なので鍵を消費する（隔離すると adapter が無限に再送する）。両方向を test と変異で固定した |
| terminal は照合された 1 件だけを閉じる | §4.3 | 適用は `operationId` の等値ではなく**照合結果の参照**で当てる。`operationId` は `eventId` + matchKey からの導出なので還元器は重複を作らないが、凍結 schema は `maxLength` しか課さず一意性も要求しないため、復元した checkpoint や別実装が書いた状態では schema 妥当なまま重複しうる。等値で当てると terminal 1 通が複数の operation を**診断ゼロで**閉じる（空文字の重複でも非空の重複でも同じ）。候補の絞り込みは `.filter` だけなので照合結果は状態の配列の要素そのもので、参照で当てれば重複があっても 1 件に限定できる。**同じ当て方は放棄経路にもある**: `finalizeAbandonedState` は「自 session の operation だけを `unknown` にする」ために session で絞ってから id の集合を作っていたので、id が重複していると絞り込みが無意味になり、**旧 session の `session_ended` が resume 先の live な operation まで `unknown` にする**（このコード自身のコメントが防ごうとしている事象そのもの）。共有している当て方ごと直し、`sourceEventsFull` も対象を id ではなく参照で受け取る。**照合結果が返す「閉じられなかった候補」も id ではなく参照で返す**（`unresolved: readonly PendingOperation[]`）。id で当てると、状態側で id が重複しているとき**候補ですらない operation**——別 session のもの——まで `unknown` になる。§4.3 が集合単位で指示しているのは「candidates を `unknown` のままにする」であって、候補の外へ広げてよいとは言っていない。**巻き込みが可逆でないことも記録しておく**: `unknown` に倒された候補は status としては回復できる（`open` は `started` だけでなく `unknown` も拾うので、rule 1 だけでなく rule 2 の terminal でも閉じられる）が、`sourceEventIds` は append-only なので、巻き込んだ terminal の `eventId` は残る。だから「回復できるから広くてよい」ではなく、倒す相手は候補に限る。**`nativeOperationId` にも同じことが起きる**: 凍結 schema は native id にも一意性を課さないので、復元した checkpoint には同じ native id の確定済みと live が並びうる。§4.3 の rule 1 は「exact `nativeOperationId` + 同じ session/lineage」で operation を**一意に**指す規則なので、2 件当たった時点で指せていない。件数を見ずに open だけで選ぶと**確定済み operation 宛ての再配送が live な兄弟を閉じる**（実測）。rule 1 を名乗った terminal については `compatible.length > 1` を `terminal_ambiguous` にして、候補は `unknown` までに留める。**数えるのは `byNativeId` ではなく `compatible`**——最初は絞り込み前の集合を数えていたが、それだと native id は同じでも input hash や kind が違う（= 既に候補から外れている）兄弟まで数に入り、健全な terminal が `terminal_ambiguous` で `unknown` に倒れて台帳まで消費される（隔離と違って訂正版が重複 no-op になるので隔離より悪い）。門を足すときに母数だけ他の判断と違うものを使っていた（この関数の他の判断はすべて `compatible` を見る）。通す側の 3 形（hash 違い・kind 違い・native id 違い）を test と変異で固定した（全件が確定済みなら手前の `open.length === 0` で `terminal_already_applied` に落ちるので、再配送の扱いは変わらない——通す側も test で固定した）。**選ぶ側の非対称も残っていた**: 同じ native id の兄弟から互換な候補を優先する修正を入れたとき、**derived `operationId` の枝は先頭 1 件のまま**だったので、`operationId` が衝突する状態では配列順で結果が割れた（実測: 衝突する兄弟が先頭なら `start_conflict`、互換な兄弟が先頭なら `duplicate_operation_start`。隔離は鍵を消費せず還元器は純関数なので、前者は同じ再配送が永久に収束しない）。選び方を `preferCompatible` に括り出して両方の枝が同じものを使う形にした——**片方の枝を直したらもう片方の枝が残る**のも同じ「軸を変えて確かめる」の対象。**同じ形は 4 箇所目、上限退避（`retainPendingOperations`）にも残っていた**（外部のセキュリティレビューが指摘し、実測で確認した。上の 3 箇所を直した時点で「この形は潰した」と書いていたのは誤りで、探し方が呼び出し側に寄っていて保持側を見ていなかった）。落とす相手を id の集合で持つと、(a) 1 件分の枠を空けるつもりで**同名の兄弟までまとめて消え**（実測: 上限 256 件・同名 2 件の状態に start を 1 通入れると 256 件のはずが 255 件になり、生きている `started` が消えた）、(b) `dropped.size` が件数でなく**異なり数**になるので退避件数の判定自体がずれ、(c) 診断の `evicted` も id 経由なので**落とした件数を過少に報告する**。保持判定を参照に変えた。ただし `operationStarts` の鍵は `operationId` そのものなので、こちらは id で消すしかない。ここで一度「**同名の兄弟が残っているなら消さない**」という条件を足したが、**これは fail open だったので撤回した**（外部のセキュリティレビューが次のラウンドで指摘し、実測で確認した）。id が衝突していると、その表は**どちらの兄弟の材料かを原理的に判別できない**。退避した側の材料を残すと、生き残った側の順序検査が他人の材料で通り、**順序違反の terminal が診断ゼロで適用され台帳まで消費される**（実測: 退避側 start=`10`・生存側の実 start=`100` の状態に `ingestSeq` 50 の terminal を当てると `succeeded` になった）。「生きている operation の材料を消したくない」は動機としては正しいが、**消さないことの代償は fail open で、消すことの代償は fail closed な降格**（`terminal_order_unverifiable` → `unknown`）なので、比較する対象を取り違えていた。無条件に消す。材料の復旧は #35（状態に持たせる）が本筋。状態側 identity 欄そのものの検査は Task 6 `reconcileWorkspace` 待ち。**同じ「凍結 schema が課さない一致」は `taskLineageId` にもある**（外部レビューが start 側を指摘し、実測で確認した）。schema は `correlation.taskLineageId` が `state.taskLineageId` と一致することを要求しないので、復元した checkpoint や別実装が書いた状態には別 lineage の pending が schema 妥当なまま並ぶ。`assertSameScope` が束縛するのは **event** のlineage なので、**状態の中身**は誰も絞っていなかった。`operationId` は eventId + matchKey からの導出で lineage を含まないため、同じ derived id の別 lineage の pending が居ると **現 lineage 宛ての start が「自分の再配送」と見なされて重複になり、鍵を消費したまま現 lineage には operation が 1 件も残らない**（実測: 状態 `lineage-1` / pending `lineage-OTHER` で `applied` + `duplicate_operation_start`）。ここも隔離ではなく**絞り込み**で直す（衝突扱いにすると、その checkpoint がある限り毎回同じ隔離になる決定論的な永久隔離になる）。軸で洗い直した結果、`pendingOperations` を触る 4 箇所の内訳はこうなった: (1) start の再配送相手 = 絞る（今回修正）、(2) terminal の候補 = 元から絞っていたが、母数の lineage を `terminalEvent.taskLineageId ?? state...` で取っていた。`assertSameScope` を入口で通しているので値は同じ（死んだ `??`）だが、wire が運ぶ値を候補選びの権威に見せる書き方なので state 固定にした、(3) 放棄の対象 = **絞っていなかった**（実測で別 lineage の operation が `unknown` に倒れた。`sourceEventIds` は append-only なので巻き込んだ `session_ended` の eventId が別 lineage の記録に永久に残る）ので session と同じ理由で絞る、(4) 上限退避 = **lineage 外を status 順より先に落とす**。ここは一度「別 lineage の pending も 256 件の枠を占めるので、退避の対象から外すと自 lineage の live な operation が代わりに落ちる。scope の判断ではなく容量の判断」として**絞らない**と書いたが、**これは誤りだったので撤回する**（外部のセキュリティレビューが指摘し、実測で確認した）。「絞らない」と「lineage 外を優先して落とす」は別の選択肢で、前者を選ぶと**別 lineage の要素で自 lineage の証跡を押し出せる**（実測: 自 lineage の `succeeded` 1 件 + 別 lineage の `started` 255 件で満杯の状態に自 lineage の start を入れると、自 lineage の `succeeded` が退避されて別 lineage 255 件は全て残った）。lineage 外の要素は照合・放棄のどの経路からも候補にならないので、状態に残しておく価値が自 lineage の確定済み証跡より低い——**容量の判断だからこそ価値の低いものから落とす**のであって、容量の判断であることは「順序を決めない」理由にならなかった。**絞り込みにした帰結として、別 lineage の双子が居ると現 lineage 側に新しい pending が積まれ、`operationId` は lineage を含まないので状態に同じ id が 2 件並ぶ**。ここで一度「どちらの材料か判別できないので材料なしに倒す」としたが、**これは誤りだったので撤回する**（外部のコードレビューが指摘し、実測で確認した）。`operationStarts` は**凍結 schema の外**にあるので checkpoint から復元されることが無く、entry を書けるのは `assertSameScope` を通った**自 lineage の start だけ**（書く側も読む側も 1 箇所）。よって別 lineage の双子は entry の帰属を曖昧にしない。数に入れると「曖昧でないものを曖昧と読む」ことになり、しかもその代償は fail closed 一方向ではなかった: `startConflictsWith` の `recordedSource !== undefined` 節が常に false になって **`turnIdSource` のすり替え検査が無効化される**（実測: 別 lineage の双子を 1 件置くと、native → synthesized_monotonic にすり替えた再配送が `start_conflict` から `duplicate_operation_start` に変わり、配送鍵まで消費した = **fail open**）。`startFactsFor` の同名判定を自 lineage に絞った。自 lineage で id が衝突する場合だけは帰属を判別できないので従来どおり材料なしに倒す（両方向を test で固定した）。**この誤りの教訓**は、「fail closed 側を選んだ」と思った判断でも、その材料を**別の検査が使っていれば**そちらでは fail open になりうること。材料を落とす判断は、その材料の consumer を全部数えてから決める |
| 0 件または複数一致の terminal は何も閉じず、診断を出す | §4.3 | `terminal_orphaned`（候補ゼロ）/ `terminal_unmatched` / `terminal_ambiguous` を返す。候補が居る場合は open のまま `unknown` にする |
| correlation / hash の衝突は隔離する | §4.3・v6「same op ID + different hash: quarantine corruption」 | `outcome: "quarantined"`。状態にも台帳にも入れない（入れると訂正版の再配送が重複 no-op になる）。判定材料は `operationKind`（= 保持側の `toolName`）と `canonicalInputHash` の直接比較で、terminal 側では `operationMatchKey` を比べない（§4.3 の matchKey は入力に「turn when present」を含むので、turn をまたいだ terminal が start と違う matchKey を持つのは仕様どおり。rule 1 は turn を要求しない = turn 両立は rule 2 の要件なので、ここで一致を求めると背景実行の完了や prompt 境界をまたいだ tool が永久に閉じない）。kind は matchKey の入力に含まれる identity の一部だが turn と違って start から terminal の間に変わらないので、rule 1 で選んだ候補にも要求できる（**§4.3 の rule 1 の字義は native ID + session/lineage だけなので、kind で絞るのは harness 判断**。identity の一部であること自体は §4.3 の matchKey 導出が担保している）。ただし `toolName` は凍結 schema の `required` に無いので、checkpoint から復元した状態や別実装が書いた状態では schema 妥当なまま欠けうる。素で比べると健全な terminal が永久に隔離され台帳にも入らない（= adapter が無限再送）ため、兄弟の `canonicalInputHash` と同じく**両方 present のときだけ**比べる。start の再配送側は `operationMatchKey` / `operationKind` / `nativeOperationId` / `canonicalInputHash` / `sessionId` / `turnId` を見る（同じ native ID は同じ呼び出しなので turn も同じはず）。`sessionId` を含めるのは、`operationId` が `eventId` + `matchKey` からの導出で session を含まず、`assertSameScope` も lineage と Agent しか束縛せず、状態が session を持たない（lineage は session をまたぐ）ため、ここで比べないと誰も比べないから。`OperationCorrelationV1` の `required` なので任意欄と違って両方 present ガードは要らない。**両方 present ガードには裏側の責務がある**: 記録に欠けている任意欄を再配送が持っているなら、**鍵を消費する前に埋める**。凍結 schema は `nativeOperationId` / `canonicalInputHash` / `toolName` を required にしていないので復元した状態では欠けうる。欠けたまま重複として鍵だけ消費すると、その material を使う照合が永久に成立しない（実測: native id を持たない pending に native id 付きの start を再配送すると重複になり、その native id を名乗る terminal は rule 1 で候補ゼロ = `terminal_orphaned` の隔離を繰り返し、operation は `started` のまま止まる）。埋めて安全なのは、この分岐に来た時点で `startConflictsWith` が false = **両方が持つ欄はすべて一致済み**だから。欠けた欄を埋めるだけなら矛盾は作れない。**ただし `turnId` と `turnIdSource` は埋めない**: どちらも turn scoped で、再配送は元の start と違う turn で届きうる。記録が turn 同一性を持たないときに再配送側の turn を書くと、rule 2 の照合権限を「元の start に無かった turn」で与えることになる（欠落を埋めるのと違い、記録の**意味**を変える）。外部レビューは降格された turn の回復もここで行うことを提案したが、実測すると隔離に倒しても結果は変わらない（記録は `unavailable` のまま残り、native の terminal は同じく `terminal_unmatched` になる）ので、**塞ぐ側にも守る対象が無い**。降格された turn identity の回復は #35 の本筋で扱う。埋めた欄の判定は `recovered` object から導く（欄を別の場所に手で並べると、欄が増えたとき片方だけ更新されて緑のまま守らなくなる）。`turnId` も同じく誰も比べていなかった（§4.3 は matchKey の入力に「turn when present」を含むので、正しく導出された matchKey なら turn が違えば matchKey も違うが、導出は wire 越しに検証できない）。記録された turn は rule 2 の候補選び（`eligible`）が使うので、古い turn のまま重複として台帳に入れると、その operation は本来の turn の terminal で閉じられず `terminal_unmatched` で `unknown` に倒れる。`turnId` は `required` に無く `turnIdSource: unavailable` では正当に不在なので、こちらは両方 present のときだけ比べる。**`turnIdSource` も識別材料に含める**（当初は「凍結 schema の外（`operationStarts`・#35）にあり復元直後は空でちょうど必要なときに比べられない」として外していたが、これは誤りだったので撤回する）。材料が無いことを「比べない」で済ませると、`turnId` の文字列だけ同じで種別をすり替えた再配送が `duplicate_operation_start` として台帳に入り、記録は元の種別のまま残る（再配送された start で `operationStarts` は埋めない）ので、**再配送側の種別で来た terminal は rule 2 の候補選び（`eligibleOf`）で落ちて `terminal_unmatched` になり、健全な証跡が `unknown` に倒れたうえに配送鍵まで消費済み**になる（実測）。復元直後の空は `eligibleOf` と同じ扱い——材料があるときだけ比べる——で足りる。ただし**矛盾と言えるのは双方が具体的な turn 同一性を主張している場合だけ**にする: `unavailable` は「turn 同一性を主張していない」という表明で、§4.3 もどちらかが `unavailable` なら rule 2 を適用しないと言うだけで矛盾とは言わない。片側でも `unavailable` を衝突にすると、intake が降格した start（proven でない version の native 主張はここへ落ちる）と、証明が回復した後の同じ start の再配送とが噛み合わず、還元器は純関数なので**毎回同じ隔離 = 決定論的な永久隔離と無限再送**になる（`started` を矛盾集合から外した理由と同型）。ここは 2 人のレビュアーが逆向きの結論を出した箇所で（外部のセキュリティレビューは「再配送側の `unavailable` 免除は caller が指定できるので塞げ」、コードレビューは「免除が片側だけなのが非対称なので対称にせよ」）、決め手は**再配送は `operationStarts` を書かない**という実測だった: 記録された種別はどちらの経路でも元のまま残るので、免除しても記録は汚れず、「訂正版の再配送で記録を直す」経路もそもそも存在しない（塞いでも守るものが無い）。caller が `unavailable` を名乗って得られるのは自分の配送鍵の消費だけで、状態も台帳の他の鍵も動かせない。塞ぐのは種別の**すり替え**（native ⇄ synthesized_monotonic）だけで、そこは 2 つの具体的な主張が食い違っている。**隔離するのは候補が全件衝突する場合だけ**にする: §4.3 どおりに matchKey を導出しない adapter では同じ matchKey で input hash が違う pending が並びうるので、identity が衝突する候補は「この terminal のものである可能性」から外すだけにして、他の候補の照合を妨げない。兄弟の identity を根拠に隔離すると live な operation が永久に閉じない。**免除ではなく絞り込みにする**のが要点で、「互換な候補が 1 件でもあれば全体を免除する」形にすると、確定済みの互換候補が囮になって衝突する open な候補に terminal が付く（確定済み A（hash A）＋ open な B（hash B）に A の terminal を再配送すると、B が診断ゼロで `succeeded` になる）。以降の open 選択・確定済み成否の照合はすべて互換な候補だけを見る。**terminal が識別材料を省いた場合は「衝突しない」ではなく「照合できない」**: 両方 present ガードは復元耐性のためにあるが、そのままだと `canonicalInputHash` を省くだけで検査を無効化でき、同じ matchKey の別 operation を閉じられる（省略は wire 側の自由なので攻撃者が選べる経路）。記録側が持つ欄を terminal が省いていたら適用せず、`terminal_identity_unverifiable` で候補を `unknown` に倒す（隔離ではないので台帳には入り、後から届いた本物の terminal がそのまま閉じられる）。`toolName` 側に対称のものが要らないのは、`operationKind` が envelope の必須欄で空も許さないため terminal から省けないから。**ただし候補の絞り込み側には両方 present ガードが要る**（外部のコードレビューが指摘し、実測で確認した）: rule 2 の候補を選ぶ `.filter` だけ `toolName` を素で比べていたので、`toolName` を持たない状態（凍結 schema の required に無いので復元した checkpoint では欠けうる）では `undefined === "Bash"` が false になり候補ゼロ = `terminal_orphaned` の隔離になる。隔離は台帳を消費せず還元器は純関数なので、**同じ terminal が毎回同じ隔離で収束しない**（実測: `toolName` を消すだけで `succeeded` が `terminal_orphaned` に変わった）。兄弟の 2 箇所（`startConflictsWith` / `identityConflicts`）は最初から両方 present ガードを持っていたので、**同じ形の 3 箇所目でここだけ落ちていた**。§4.3 の matchKey は tool 名を入力に含むので、仕様どおりに導出する adapter では matchKey 一致が既に kind を束縛している。**発火の母数は `plausible`（turn と順序が両立する候補。open / 確定済みの切り分け前）**にする。当初は `compatible` で数えていたが、それだと**この terminal の付け替え先になりえない兄弟が健全な照合を潰す**（実測: open な候補（hash あり）に、確定済みで**別 turn**の兄弟が 1 件並ぶだけで、診断ゼロの `succeeded` が `terminal_identity_unverifiable` に変わり、open な候補が `unknown` に倒れて台帳まで消費された。外部のコードレビューが指摘）。別 turn の兄弟は `sameTurnOf` で落ちるので、この terminal の再配送先ですらない。**母数は `open` でもない**: 確定済みでも**同じ turn** の兄弟は「この terminal はそちらの再配送だった」がありうるので、hash の省略で付け替えが起きる。`plausible` がちょうどその集合。rule 1 の候補数を `byNativeId` から `compatible` へ直したのと同じ「母数の取り違え」で、**この形はこの関数で 3 回目**（rule 1 の件数・矛盾判定・照合不能）。母数を `plausible` にすると `unresolved: open` は `open ⊆ plausible ⊆ sameTurn` から自動的に turn 両立になるが、`compatible` を混ぜる変異が観測できるよう「発火する形のうえで turn 非両立の open な兄弟が巻き込まれない」fixture を別に置いた。**なお発火は互換な候補が 2 件以上あるときに限る**: `canonicalInputHash` は凍結 envelope の任意欄（§3.1）なので省略自体は schema 妥当で、§4.3 が terminal に課すのは「non-conflicting な payload/source hash」＝衝突しないことであって不在は衝突ではない。§4.3 の matchKey は canonical input hash を入力に含むので、仕様どおりに導出する adapter では hash 違いの兄弟はそもそも候補に並ばず、候補が 1 件なら省略で付け替えられる相手が居ない（照合権限は rule 1 = `nativeOperationId`、rule 2 = matchKey + 互換な turn/kind が既に一意に決めている）。素で発火させると「terminal は入力ではなく結果なので hash を載せない」adapter の terminal が 1 通残らず閉じなくなる。候補が 2 件以上並ぶのは matchKey を仕様どおりに導出しない adapter だけで、そこでは hash が唯一の弁別子なので省略された時点で倒す。**判定の位置は成否矛盾検査より後**にする: 前に置くと、確定済みの候補に矛盾する terminal が hash を省くだけで隔離（台帳を消費しないので訂正版が後から効く）を回避して照合不能（台帳を消費する）に化け、訂正版の再配送が重複 no-op として捨てられる |
| 成否が曖昧な terminal は `unknown` を確定する | §4.3 | `successful` が無い場合に加え、kind が失敗を宣言しているのに `successful: true` を名乗る自己矛盾も `unknown` に倒し `terminal_evidence_contradicts` を出す（schema はどちらの欄も valid なので通るが、`succeeded` にすると壊れた adapter が失敗を握り潰せる）。矛盾は照合の成否と無関係な event 自身の性質なので、**照合前に判定して全経路（隔離・unmatched・適用）で出す**。照合できた場合しか出さないと、同じ壊れた adapter でも operation が既に閉じているときだけ `terminal_already_applied` に埋もれて見えなくなる |
| rule 2 は双方が同じ `turnIdSource` 種別の turn 同一性を持つことを要求する | §4.3 | start 側の種別を側索引 `operationStarts` に保持して照合する。**照合は候補の絞り込み時に行い、材料がある候補だけを対象にする**（上の行に詳細）。材料が無い候補を落とさないのは、`operationStarts` が空になるのが復元直後だけではないため: 側索引は**退避時にも delete される**ので、live な候補でも `recorded === undefined` になりうる。どちらの経路でも「材料が無いものは種別違いとして落とさない」で一貫しており、材料が無い候補は rule 1 経由なら `terminal_order_unverifiable` に落ちるので誤って閉じることはない |
| 放棄・復帰時に証跡が無い operation は `unknown` | §4.3 | `finalizeAbandonedState`。§4.2 の重複 no-op はこの経路にも掛かるので、台帳を受け取り、同じ放棄 event の再配送では revision を採番し直さない。配送 ID の衝突判定も還元器と同じで、同じ配送 ID で source hash が違う放棄 event は `outcome: "quarantined"` にする（重複として黙って捨てると放棄が落ちて operation が `started` のまま残る）。放棄の kind は還元器の入口でも弾く（`reduceTaskWorkState` に渡すと operation envelope を持たないので汎用 commit に落ち、状態を変えないまま台帳の鍵だけ消費する。その台帳を渡された `finalizeAbandonedState` は重複として捨てるので、放棄が永久に適用されず operation が `started` のまま残る）。放棄するのはその event の session の operation だけ（lineage は session をまたいで続く。§5 の checkpoint は `sourceSessionId` と `taskLineageId` を別に持つので、絞らないと遅れて届いた旧 session の `session_ended` が resume 先の live な operation を潰す）。還元器の terminal 経路と同じく**黙って間引かない**: `sourceEventIds` が上限の operation は status だけ `unknown` に変わって、そう変えた理由の event が状態から落ちるので、`AbandonmentResultV1.diagnostics` に `source_events_truncated` を出す。**隔離するときの診断も還元器側と同じ `delivery_conflict` を出す**（同じ配送 ID で source hash が違う放棄）。以前は outcome だけで区別できると考えて空で返していたが、§3.1 が求めるのは doctor が理由を報告できることで、doctor が受け取るのは診断の側。空で返すと「なぜ放棄が落ちたか」が経路ごとに違う形でしか分からない |
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
各ゲートをわざと壊し、対応する test が落ちることを確認した。**145 件すべてで 1 件以上が失敗**し、
生存はゼロ、実行件数も期待どおり 145 件（黙って飛ばされた変異ゼロ）、復元後は 168/168 green。

**下の表は `mutate.sh` の出力から作る**（同スクリプトの header がそう宣言している）。ラベルを足し引き
したら、次で突き合わせてから doc を直す。CI は `mutate.sh` を走らせるが doc は見ないので、
この乖離を検出するのはこの手順だけ:

```sh
grep -oP '&& run "\K[^"]+' harness/continuity/mutate.sh | grep -v '^\\K' | sort > /tmp/want.txt
awk 'NR>=410' evidence/phase3-reference-model.md \
  | grep -oP '^\| \K.+?(?= \| [0-9]+ \|$)' | sed 's/ *$//' | sort > /tmp/got.txt
comm -3 /tmp/want.txt /tmp/got.txt   # 空でなければ乖離している
```

**この harness 自身が 3 つの穴を持っていた**（外部のコードレビューが指摘し、実測で全部再現した）。どれも「壊していないゲートを kill として計上する」形で、**kill 率も実行件数も緑のまま嘘をつく**:

1. **置換後の文字列に書いた `\n` が改行にならない**。bash の二重引用符は `\n` を展開しないので、リテラルのバックスラッシュ n が TS に埋まり module が parse できなくなる。それでも node:test は「読み込みに失敗した 1 件」を fail として数えるので、`fail 1` だけを見ている `run()` は kill と判定した（**5 件が空証明**。うち 1 件は外部レビューで撤回した fail open の回帰ガードそのもので、そこが無検証だった）
2. **アンカーがソース中で一意でない**。`replace(old, new, 1)` は必ず先頭を書き換えるので、2 つ目の site を狙ったラベルは 1 つ目を二重に壊すだけになる（**3 件**。還元器と放棄で同じ形の guard を持つ箇所）。ラベル数しか数えない実行件数の突き合わせには映らない
3. **「変異で test が 1 件も走らなかった」を生存扱いにする safeguard が死んでいた**。node:text は読み込み失敗を fail 1 件として数えるので `[ -z "$n" ] || [ "$n" -eq 0 ]` が成立しない。1 と 2 がすり抜けたのはこれが原因

塞ぎ方は**個別のエントリ修正ではなく構造側**にした: `mutate()` は `s.count(old) == 1` を要求し（一意でないアンカーは即エラー）、`run()` は baseline の test 件数を測っておいて「変異が baseline と同じ件数の test を走らせたか」を突き合わせる。`\n` は `mutate()` 側で改行に解釈する。**さらに CI から呼ぶようにした**——人が手で叩いたときしか走らないと、アンカー外れも空証明も次のラウンドまで見つからない。8 件を実際に走る形へ直した結果、いずれも正しく kill された（ゲートは正しく、空だったのは証明のほうだった）。

kill 率より先に**実行件数**を見ること。変異はソース中の文字列アンカーで当てるので、実装を直すと
`assert old in s` が落ちて `&&` が短絡し、その変異は**出力に何も出ないまま黙って飛ばされる**
（round 12 で 3 件、round 13 で 1 件、round 15 で 2 件、round 16 で 1 件、round 17 で 9 件、round 18 で 1 + 4 + 1 件、round 19 で 11 + 3 + 1 件が外れ、いずれもこの自己検査が検出した。round 17 では**再構成で無意味化した変異**（`open` が `[matched]` と同一になり差が出なくなったもの）も生存として検出できた。round 21 でも 1 件出た: 再配送で `toolName` を無条件に上書きする変異は、`startConflictsWith` が「両方 present なら一致」を既に保証しているので上書きしても同じ値しか書けず観測できない。空虚な変異は差し替えでなく削除した）。この突き合わせはスクリプト自身が行うようにした: 末尾で
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
| 復元後の baseline を赤くする（BAK に壊れたソースを入れる） | 1 | `変異テスト失敗: 復元後の baseline が green でない` |

| 壊した箇所 | 落ちた test 数 |
|---|---:|
| dedupe 判定を外す | 4 |
| lastIngestSeq の max を外す | 1 |
| ingestSeq を数値比較にする | 1 |
| envelope 必須を外す | 3 |
| intake の attestation 必須を外す | 3 |
| caller の attestation を信じる | 1 |
| sourceAgent の束縛を外す | 2 |
| 認証できない経路でも Agent 名で落とす | 2 |
| 空の Agent 名を素通しする | 4 |
| native turn の証明要求を外す | 4 |
| turn 証明の version 束縛を外す | 3 |
| turn 降格を黙って行う | 1 |
| turn 同一性の不変条件を外す | 1 |
| state への Agent 束縛を外す | 2 |
| 空 adapterDeliveryId の fallback を外す | 2 |
| rule 1 の排他を外す | 1 |
| rule 2 の turn 同一性要求を外す | 2 |
| 候補が複数のときの拒否を外す | 2 |
| terminal 側に matchKey 一致を要求し直す | 3 |
| identity 衝突を候補 1 件で判定する | 5 |
| terminal の canonicalInputHash 衝突検査を外す | 6 |
| identity 衝突の隔離を外す | 5 |
| kind と successful の矛盾を素通しする | 2 |
| 矛盾診断を照合済み経路だけに戻す | 1 |
| 矛盾した terminal を succeeded にする | 1 |
| start 不在の分岐を外す | 7 |
| terminal の権威順序検査を外す | 2 |
| 順序違反で候補を巻き込む | 1 |
| 候補ゼロの terminal を台帳に入れる | 5 |
| 順序不明で候補を unknown にしない | 7 |
| 退避で順序材料を刈らない | 2 |
| 同名が残るなら退避側の順序材料を残す | 1 |
| 再配送 start を nativeOperationId で拾わない | 6 |
| 再配送の判定を matchKey にする | 8 |
| start の identity 衝突検査を外す | 7 |
| start の matchKey 衝突検査を外す | 1 |
| start の canonicalInputHash 衝突検査を外す | 1 |
| 放棄を session で絞らない | 2 |
| 候補の unknown 化を外す | 17 |
| unknown 化で証跡を残さない | 2 |
| sourceEventIds の上限を外す | 1 |
| pendingOperations の上限を外す | 1 |
| 退避対象から open を外す（詰まる） | 1 |
| 退避件数の上限を外す | 5 |
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
| terminal の operationKind 比較を外す | 2 |
| terminal の toolName 存在ガードを外す | 1 |
| 放棄経路の配送 ID 衝突検査を外す | 1 |
| 空 canonicalFingerprint を素通しする | 2 |
| 確定済み成否との矛盾検査を外す | 5 |
| 成否を主張しない terminal も矛盾扱いにする | 4 |
| 成否が一致する兄弟の検査を外す | 2 |
| 放棄 kind を還元器に通す | 1 |
| 空文字の turnId を素通しする | 2 |
| 空文字の eventId を素通しする | 2 |
| sensitivity の下限に直前の集約値を使わない | 1 |
| 空文字の sessionId を素通しする | 3 |
| 空白文字を identity 材料として通す | 5 |
| 書式制御文字だけの identity 材料を通す | 5 |
| 空の operationMatchKey / operationKind を素通しする | 2 |
| open の選択を identity 互換に絞らない | 2 |
| canonicalInputHash の省略を照合可能として扱う | 2 |
| 再配送 start の session 検査を外す | 1 |
| 放棄で落とした証跡を報告しない | 1 |
| 直接呼びの envelope 検査を外す | 1 |
| 再配送 start の turn 検査を外す | 1 |
| 再配送 start の turn 存在ガードを外す | 1 |
| 候補 1 件でも照合不能ゲートを発火させる | 1 |
| 照合不能ゲートの候補数を 1 件ずらす | 2 |
| 照合不能を成否矛盾検査より先に判定する | 1 |
| 空白だけの capability hash を authority にする | 1 |
| 空白だけの Agent 名を authority にする | 1 |
| 空白だけの exact version を authority にする | 1 |
| 直接呼びの Agent 検査を外す | 1 |
| rule 2 の turn 種別の絞り込みを外す | 8 |
| turn 種別の材料が無い候補も落とす | 1 |
| 種別違いの巻き込み範囲を広げる | 1 |
| 受領証 ID が空でも認証済みとする | 1 |
| peer identity が空でも認証済みとする | 1 |
| 空白だけの受領証 ID を authority にする | 1 |
| 空白の scenarioId で proven を成立させる | 1 |
| 直接呼びの ingestSeq 検査を外す | 1 |
| 直接呼びの identity 材料検査を外す | 1 |
| 空白の sourceAgent を素通しする | 1 |
| turn 両立ゼロの確定済みを適用済みにする | 6 |
| 矛盾判定の母数まで turn で絞る | 2 |
| 候補の unknown 化を operationId の等値で当てる | 3 |
| 放棄の適用先を operationId の等値で当てる | 2 |
| 確定済みの説明に turn 両立を求めない | 1 |
| 確定済みの説明で turn 種別だけ見ない | 1 |
| open の切り分けを turn 絞り込みより前にする | 12 |
| 矛盾判定に open な候補も混ぜる | 2 |
| 退避の保持判定を operationId の一致に戻す | 2 |
| 記録できる候補が居ても隔離を優先する | 1 |
| 抑止した矛盾を報告に残さない | 1 |
| 照合不能で turn 非両立の候補も巻き込む | 1 |
| rule 1 の候補が複数でも 1 件選ぶ | 1 |
| rule 1 の候補数を identity 絞り込み前で数える | 1 |
| 再配送 start の turn 種別を見ない | 1 |
| 降格した再配送 start も隔離する | 1 |
| 記録が降格されていても再配送を隔離する | 1 |
| 別 lineage の pending も再配送の相手にする | 1 |
| 放棄が別 lineage の operation も倒す | 1 |
| 退避で lineage 外を優先しない | 1 |
| 再配送が持つ native id を記録に埋めない | 1 |
| 候補を start の順序で絞らない | 1 |
| 全件順序不適合でも空に絞る | 1 |
| turnIdSource の語彙検査を外す | 2 |
| 側索引の同名判定で別 lineage も数える | 2 |
| 状態側の空白 lineage を通す | 1 |
| event 側の空白 lineage を通す | 1 |
| IsoTimestamp の暦検査を外す | 4 |
| 受領証の時刻を暦検査から外す | 1 |
| 暦検査の前に綴りを当てない | 1 |
| offset の Z 固定を外す | 1 |
| 小数部の綴りを見ない | 1 |
| 再配送 start の truncation 診断を落とす | 1 |
| 再配送 start の truncation 対象を全 pending にする | 18 |
| truncation の対象を照合相手の外へ広げる | 1 |
| 任意欄の空白を present として読む | 8 |
| 候補の toolName を素で比べる | 1 |
| 照合不能ゲートの母数を compatible に戻す | 1 |
| 適用済みの再配送も隔離する | 1 |
| 記録済みの event でも truncation を出す | 1 |
| 再配送 start の原因 event を残さない | 1 |
| 放棄の配送衝突を診断に出さない | 1 |
| 同名 id でも側索引を引く | 2 |
| correlate の入口で terminal 相を要求しない | 1 |
| 兄弟から互換な候補を選ばない（derived id / native id 両方） | 3 |
| 再配送の相手を集合ごとに選ぶ | 1 |
| 兄弟の連結順を入れ替える | 1 |
| 飛ばした衝突兄弟を報告しない | 3 |

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
