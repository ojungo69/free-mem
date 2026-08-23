# Feature Specification: Continuity P0 契約の凍結（decision window）

**Feature Branch**: `spec/005-continuity-p0-contract`

**Created**: 2026-08-24

**Status**: Draft

**Input**: User description: "Continuity P0 契約の凍結: issue #1 の owner sequencing 手順2 にあたる Continuity P0 cluster 9 件を、ひとつの decision window としてまとめて仕様化する。対象は #46 #49 #53 #61 #62（CanonicalWorkStateV1 のスキーマとバージョニングを同時に変える組）、#56 #57（復元境界での validation を共通化する組）、#32 #58（宣言のみで未強制の上限と、silent な terminal partial-conflict の可視化）。Rust Stage 1 の開始条件でもあるため、TS と Rust が同じ fixture で同一の結果を出せる契約として書く。実装ではなく契約の凍結が目的。"

## 背景と問題

issue #1 の owner sequencing（2026-08-18）は Rust Stage 1 の開始条件を 5 手順で定めている。
手順 1（PR #60）は完了済みで、いま止まっているのは**手順 2 の Continuity P0 cluster 9 件**である。
同じコメントは「まだ行わない scope」に `vendor/codemem` の大規模改変を挙げており、この 9 件を
通すことが継続性と Rust の両方を同時に開く唯一の経路になっている。

9 件はばらばらの欠陥ではない。**互いを名指しして「同じ decision window で判断しろ」と書いている**。
#62 は本文で「#49 / #53 / #61 と versioning をまとめて判断する」と述べ、その 1 点だけを理由に
`status: blocked` が付いている。#56 と #57 は「同じ restore validation work package で解決する」と
書いている。1 件ずつ切ると、凍結 schema の版・fixture・hash・別言語実装の期待値が
そのたびに動く。#35 / #39 / #43 / #44 を 1 回の拡張でまとめた 002 と同じ理由である。

この feature は**契約の凍結**であって実装ではない。凍結した契約が Rust prototype と TypeScript
reference の共通入力になり、G1–G7 の実測が「Rust の能力不足」ではなく「fixture 不足」で
不合格になる事態を防ぐ。

問題は 3 つの層に分かれる。

### 層 A — 公開した revision の契約が守られていない（#46 / #49 / #53 / #61 / #62）

`CanonicalWorkStateV1` はいま、公開した revision が**後から変わりうる**。reducer は revision ごとに
配列の入れ物を作り直すが、`PendingOperation` 要素や `sourceEventIds` などの入れ子は前の revision と
共有される。公開型も実行時オブジェクトも書き換え可能なので、consumer が新しい revision の入れ子を
触ると、hash を計算し終えた**古い** revision の内容まで変わる。保存された bytes と `contentHash` /
`stateRevision` の対応が壊れる。

同じ状態の別の面として、**新旧を安全に比較できない**。`lastIngestSeq` は session ごとの連番、
`updatedAt` は adapter 由来で単調でない、`stateRevision` は hash 連鎖の同一性であって 2 つの
revision から順序を導けない。resume / checkpoint selection はこの比較の上に立つ。

さらに、意味が変わらない event で状態が動く。既に閉じた operation へ、成否を主張しない terminal を
別の delivery ID で送り続けると、意味状態は変わらないのに `stateRevision`・`history`・`updatedAt` が
毎回変わる。`stateRevision` は checkpoint acceptance の CAS token なので、**無害な event を送るだけで
下流の CAS を永久に空振りさせられる**。history も無制限に伸びる。

証跡側にも同じ根がある。`droppedEvidence` は上限つきの配列で、超過時に古い entry を落とす。
落ちたことは診断に出るが診断は canonical state の外にあるので、**状態だけを受け取った reader は
overflow 前の証跡が存在したことを知れない**。`evicted` と `orphaned_terminal` が同じ FIFO を
共有しているため、片方の大量発生でもう片方の狙った entry を押し出せる。

最後に privacy の面がある。schema は `eventId` / `operationId` / `nativeOperationId` /
`operationMatchKey` / `canonicalFingerprint` を長さ付き文字列としてしか制約せず、取り込み時に
opaque 性を強制していない。adapter が token・path・prompt 断片・command を identifier へ混ぜると、
その生値が canonical state・checkpoint・診断・capsule・backup へそのまま残る。

### 層 B — 復元境界に検査が無く、永久 wedge になる（#56 / #57）

schema としては妥当でも意味として妥当でない状態が、そのまま reducer へ流れる。
`assertSameScope` は空白の `taskLineageId` で throw するが、schema は長さしか制約しないので
空文字・空白だけの identity を受理できる。復元した checkpoint がこの状態だと reducer が毎回
throw し、診断・abandon・repair のどれにも進めない**永久 wedge** になる。scope identity が
未定義の状態を「同じ scope」として扱えば、無関係な task の operation が混ざり、terminal や
session end が別 task の状態を変えうる。空白同士を同一視する fail-open は許されない。

時刻側も同じ形で残っている。event が持つ `occurredAt` と `provenance.ingestAttestation.attestedAt`
の暦検証は #27 で完了したが、`IsoTimestamp` は**永続化された状態**の多数の欄からも参照されている
（`PendingOperation.startedAt` / `terminalAt`、observed item、repository、checkpoint、delivery /
disposition / evidence の各時刻）。復元側は未実装のままである。

### 層 C — 宣言だけの上限と、黙って落ちる候補（#32 / #58）

`CONTINUITY_LIMITS` は §10 で 12 の上限を凍結しているが、実際に強制されているのは構造系の 4 つ
（`jsonDepth` / `stringUtf8Bytes` / `arrayItems` / `objectKeys`）だけである。payload 総 bytes、
最終 wrapper bytes、token 予算 5 種、ranked candidate 数の**8 つは宣言のみ**で、どの delivery path
でも強制されていない。

診断側では、terminal path が conflict した sibling の一部を**黙って**候補から落とす。同じ
session / lineage / turn / match key に「incoming terminal と identity が両立する operation」と
「`canonicalInputHash` が衝突する operation」が並んでいると、後者を候補から除外し、前者を
`succeeded` で閉じ、delivery key を消費し、診断は空のまま、除外された側は `started` のまま残る。
加えて `start_sibling_conflict` を含む `ContinuityDiagnosticCode` が runtime / schema / contract hash
のどれにも拘束されていないので、語彙が実装ごとに漂う。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 公開した revision が後から変わらず、新旧を権威で比較できる (Priority: P1)

別 session が同じ task lineage を更新した 2 つの状態を渡され、どちらが新しく、どちらを resume の
対象にしてよいかを判断する。判断は caller の時刻・session 内連番・hash の辞書順に依存してはならず、
daemon が持つ取引メタデータだけから決まる必要がある。同時に、いったん公開・永続化した revision の
canonical bytes は、その後の consumer 操作・後続 event・別 revision の構築で一切変わってはならない。

この story は #62 の唯一の着手条件でもある。#62 は「#49 / #53 / #61 と versioning を同じ
decision window で判断する」ことだけを理由に blocked になっている。

**Why this priority**: 層 A が閉じないと #62 が着手できず、Rust Stage 1 の開始条件（手順 2）も
満たされない。CAS starvation と revision 書き換えはどちらも再現済みの P0 で、resume /
checkpoint selection の実装はこの契約の上にしか載らない。

**Independent Test**: 同じ lineage を 2 つの session で更新した状態の組を fixture として与え、
(1) 順序の判定が caller 時刻・session 連番・hash 辞書順のいずれを変えても不変であること、
(2) 公開済み revision の入れ子を書き換えようとする操作が失敗し、`contentHash` が保存時の値と
一致し続けること、(3) 意味を変えない event を N 回送っても `stateRevision`・`history` 長・
`updatedAt` が動かないこと、(4) 証跡が上限で落ちても「何件・どの理由・どの境界以前が欠けたか」が
状態だけから判別できること、(5) 生の identifier が canonical state・checkpoint・診断・capsule の
どこにも現れないこと、を状態と event だけで検証できる。

**Acceptance Scenarios**:

1. **Given** 同じ task lineage を別 session が更新した 2 つの公開 revision、**When** どちらが新しいかを
   状態だけから判定する、**Then** caller 由来の時刻・session 内連番・hash の辞書順を任意に入れ替えても
   判定結果が変わらない。
2. **Given** 順序として新しい revision、**When** resume 対象として選ぶ、**Then** 順序が新しいことと
   resume してよいことは別の gate として評価され、workspace 互換性・disposition・
   accepted / superseded / retracted・fork / conflict のいずれかが不適合なら選ばれない。
3. **Given** hash 計算済みで公開された revision、**When** consumer が後続 revision の入れ子要素を
   書き換えようとする、**Then** 操作は失敗し、公開済み revision の canonical bytes と `contentHash` は
   変わらない。
4. **Given** 既に閉じた operation、**When** 成否を主張しない terminal を別 delivery ID で 100 回送る、
   **Then** `stateRevision`・`history`・`updatedAt` は 1 度も動かず、しかし event を受理した事実・
   delivery key を消費した事実・診断は失われない。
5. **Given** `droppedEvidence` が上限を超えた状態、**When** 状態だけを受け取った reader が読む、
   **Then** 欠落の件数・理由の内訳・どの境界以前が欠けたかを判別でき、片方の理由の大量発生で
   もう片方の存在自体が状態から消えることはない。
6. **Given** adapter が token / path / prompt 断片を混ぜた identifier を送った event、**When** 取り込む、
   **Then** canonical state・checkpoint・診断・capsule・sync 対象のいずれにも生値は現れず、
   相関に必要な情報だけが daemon 発行の domain-separated な表現として残る。

---

### User Story 2 - 意味的に不正な復元状態が永久 wedge にならない (Priority: P2)

保存された状態や checkpoint を復元する。schema としては妥当でも、scope identity が空白だったり
時刻が暦上存在しなかったりする状態が混じりうる。そのまま reducer へ渡すと毎回 throw し、
診断・abandon・repair のどれにも進めなくなる。

**Why this priority**: 永久 wedge は可用性の全損で、利用者は自力で復帰できない。ただし層 A と
違って他 issue の着手条件にはなっておらず、読込境界 1 か所で閉じるので層 A とは独立に出荷できる。

**Independent Test**: schema 妥当・意味不正な状態の corpus（空文字 / 空白のみの scope identity、
暦上存在しない日付、相互に矛盾する identity）を復元経路へ与え、(1) reducer へ到達する前に
1 回だけ検証されること、(2) 不正な状態が active state として使われず原 artifact を保持した
quarantine へ送られること、(3) quarantine から診断・abandon・repair のいずれにも進めること、
(4) 妥当な状態が誤って quarantine されないこと、を検証できる。

**Acceptance Scenarios**:

1. **Given** `taskLineageId` が空白だけの永続化状態、**When** 復元する、**Then** reducer へ渡る前に
   拒否され、原 artifact を保持した quarantine に入り、そこから診断・abandon・repair へ進める。
2. **Given** scope identity が未定義な 2 つの状態、**When** 同一 scope かを判定する、**Then** 空白同士を
   同一視せず、無関係な task の operation が混ざらない。
3. **Given** 暦上存在しない日付を含む復元状態、**When** 読み込む、**Then** reducer 内の個別 check ではなく
   読込境界の共通検証で捕まり、永久 wedge にならない。
4. **Given** repair / discard / rebind の要求、**When** 実行する、**Then** daemon も model も推測せず、
   明示的な authority と audit を要求する。
5. **Given** 意味的に妥当な既存状態の corpus、**When** 復元する、**Then** 1 件も quarantine されない。

---

### User Story 3 - 宣言した上限が実際に効き、落ちた候補が見える (Priority: P3)

delivery path に載せる payload が §10 の上限を超えたとき、宣言だけでなく実際に止まる。
terminal 処理で候補から外れた operation があれば、診断からそれが分かる。

**Why this priority**: 上限の未強制は「守られているつもり」の状態であり、silent な候補落ちは
運用者が気づけない。どちらも層 A / B と独立に閉じられ、契約の凍結としては層 A の版が決まった
あとで足せる。

**Independent Test**: §10 の 12 上限それぞれについて、上限直下と上限超過の入力を全 delivery path へ
与え、超過が宣言どおりに扱われることを確認できる。terminal については conflict する sibling を
含む fixture を与え、除外された operation が診断に現れることを確認できる。

**Acceptance Scenarios**:

1. **Given** payload 総 bytes / 最終 wrapper bytes / token 予算 5 種 / ranked candidate 数のいずれかが
   上限を超える入力、**When** どの delivery path から入っても、**Then** 宣言どおりに扱われ、
   path ごとに結果が食い違わない。
2. **Given** 上限のちょうど直下の入力、**When** 処理する、**Then** 通過する（締めすぎによる偽陽性が無い）。
3. **Given** 同じ session / lineage / turn / match key に identity 両立の operation と
   `canonicalInputHash` 衝突の operation が並ぶ状態、**When** 通常の terminal を入れる、
   **Then** 除外された側が診断に現れ、`started` のまま黙って残らない。
4. **Given** `ContinuityDiagnosticCode` の語彙、**When** 別実装と突き合わせる、**Then** 語彙が
   schema と contract hash に拘束されており、実装ごとに漂わない。

---

### Edge Cases

- 意味を変えない event でも、event を受理した事実・delivery key を消費した事実・診断・
  event store の網羅 watermark は失われてはならない。「状態が動かない」と「何も起きなかった」を
  同一視すると冪等台帳が壊れる。
- 順序として新しい revision が、resume 対象として不正なことがある（workspace 不一致、
  retracted、fork 中）。この 2 つを同じ gate にまとめてはならない。
- `evicted` と `orphaned_terminal` が同じ上限を共有する限り、片方の flood でもう片方が消える。
  理由ごとに区別できることが要件であり、単に上限を上げることでは満たされない。
- 欠落件数は JavaScript の安全整数へ丸めずに表現する必要がある。
- 復元時の検証を締めすぎると、妥当な既存状態が quarantine される。偽陽性は自分のテストからは
  漏れやすいので、通す側の corpus も同じ gate で測る。
- 生 identifier の排除は、相関性まで失うことを意味しない。相関に必要な情報は残す。
- 生値がどうしても必要な経路は、local evidence store の別 surface へ隔離し、retention・access・
  export を明示する。
- 上限強制を新設すると、既存の正常な payload が初めて拒否されうる。上限直下の入力で偽陽性を測る。

## Requirements *(mandatory)*

### Functional Requirements

**層 A — 公開 revision の契約**

- **FR-001**: task lineage 内の revision commit 順序と、現在選択可能な head は、caller 時刻・
  session 内連番・hash の辞書順に依存せず、daemon が所有する取引メタデータだけから決定できなければならない。
- **FR-002**: 順序の新しさと resume 対象としての正しさは別の gate として評価しなければならない。
  workspace 互換性・disposition・accepted / superseded / retracted・fork / conflict を独立に判定する。
- **FR-003**: いったん公開・永続化した revision の canonical bytes は、その後の consumer 操作・
  後続 event・別 revision の構築によって変化してはならない。
- **FR-004**: revision 間の構造共有は、共有される全 node が実行時にも変更不可である場合に限り許可する。
- **FR-005**: canonical work state の意味内容が変わらない event は、同じ state bytes・content hash・
  revision pointer・history を返さなければならない。
- **FR-006**: FR-005 の場合でも、(a) canonical work-state transition、(b) event / delivery の冪等台帳
  transition、(c) 診断 / 監査 transition、(d) event store の網羅 watermark を分離して記録しなければならない。
- **FR-007**: `updatedAt` は caller 由来の `occurredAt` によって過去へ巻き戻ってはならない。
- **FR-008**: 上限つき証跡 window から個別 entry が落ちても、「何件・どの理由・どの境界以前が
  欠けているか」は canonical state だけで判別できなければならない。
- **FR-009**: overflow した事実は state 内の単調な値として保持し、理由ごとに件数と欠落を区別しなければならない。
- **FR-010**: 一つの理由の flood によって、別の理由の存在自体が state から消えてはならない。
- **FR-011**: 欠落件数は JavaScript の安全整数へ変換せずに表現しなければならない。
- **FR-012**: canonical state・checkpoint・診断・capsule・sync operation には、caller が供給した
  raw identifier / fingerprint を保存してはならない。
- **FR-013**: 相関に必要な情報は、daemon が発行・検証する domain-separated な opaque 表現へ変換しなければならない。
- **FR-014**: raw 値が必要な経路は local evidence store の別 surface へ隔離し、retention・access・
  export を明示しなければならない。
- **FR-015**: 層 A の 5 件（#46 / #49 / #53 / #61 / #62）は、schema と versioning をひとつの
  decision window で決め、単一の契約変更として凍結しなければならない。
  [NEEDS CLARIFICATION: 新しい schema 版を 1 つ立てて移行を伴わせるか、v1 内の追加互換な変更として
  収めるか。前者は fixture と別言語実装の期待値を一度に切り替えられるが移行が必要、後者は移行が
  不要だが「新しい欄を持たない状態」との二重の挙動を長く抱える]

**層 B — 復元境界の検証**

- **FR-016**: canonical state を routing / reducer / selector へ渡す前に、scope identity の存在・
  正規化・相互整合を**一度だけ**検証しなければならない。
- **FR-017**: 復元された状態内のすべての `IsoTimestamp` を、綴りだけでなく暦上の実在性まで検証しなければならない。
- **FR-018**: FR-016 / FR-017 の検証は reducer 内部の個別 check ではなく、checkpoint / 永続化状態の
  読込直後・reducer へ渡す前の共通境界に置かなければならない。
- **FR-019**: 意味的に不正な状態は active state として使用せず、原 artifact を保持した quarantine へ
  送らなければならない。
- **FR-020**: 空白の scope identity 同士を同一視してはならない（fail-open の禁止）。
- **FR-021**: quarantine からの repair / discard / rebind は、daemon も model も推測せず、明示的な
  authority と audit を要求しなければならない。
- **FR-022**: 検証対象の identity 欄は、schema 版ごとに機械可読な形で列挙または schema 注釈から
  導出できなければならない。

**層 C — 上限の強制と診断の可視化**

- **FR-023**: §10 で凍結した 12 上限すべてを、すべての delivery path で強制しなければならない
  （現在強制されているのは構造系 4 つのみ）。
- **FR-024**: 上限違反の扱いは全 delivery path で一致しなければならない。
  [NEEDS CLARIFICATION: 超過時に event を拒否するか、上限まで切り詰めて劣化を記録するか、
  劣化モードへフェイルするか。拒否は fail-closed だが可用性を落とし、切り詰めは可用性を保つが
  内容の欠落を生む]
- **FR-025**: terminal path が conflict により候補から除外した operation は、診断に現れなければならない
  （現在は診断が空のまま `started` で残る）。
- **FR-026**: `ContinuityDiagnosticCode` の語彙は runtime / schema / contract hash に拘束し、
  実装ごとに漂わせてはならない。

**全層に共通**

- **FR-027**: 凍結した契約は、TypeScript reference と Rust prototype が同じ入力に対して同一の
  判断・同一の状態・同一の内容 hash に到達できる形でなければならない。
- **FR-028**: 新設した検査は、締めすぎによる偽陽性を測る corpus を伴わなければならない
  （通す側も同じ gate で測る）。
- **FR-029**: この契約凍結の成果物の範囲。
  [NEEDS CLARIFICATION: 公開 conformance fixture をこの feature で作るか、契約の凍結までに留めて
  fixture は #66 / #67 / #8（owner sequencing の手順 3 / 4）に委ねるか。前者は手順 2 と 3 を
  一度に進められるが範囲が大きく、後者は手順どおりだが Rust 実測までの往復が 1 回増える]

### Key Entities

- **Canonical Work State**: task lineage の意味状態。公開後は不変で、固定の canonical bytes と
  内容 hash を持つ。revision pointer と history を伴う。
- **Revision Envelope**: revision を包む器。lineage 全体で通用する順序（ordinal）と、head 選択に
  必要な daemon 所有のメタデータを持つ。
- **Pending Operation**: 進行中の operation。identity・相関情報・時刻・terminal fingerprint を持つ。
  相関情報は opaque 表現で保持する。
- **Dropped Evidence Window**: 上限つきの証跡置き場。理由ごとの件数と欠落境界を、entry が落ちた後も
  状態から判別できる形で保持する。
- **Quarantine Entry**: 意味的に不正と判定された状態の隔離先。原 artifact を保持し、明示的な
  authority による repair / discard / rebind を待つ。
- **Continuity Diagnostic**: 受理・除外・隔離の理由を表す機械可読な code と詳細。語彙は schema と
  contract hash に拘束される。
- **Continuity Limits**: §10 で凍結した 12 の上限。すべての delivery path で同一に強制される。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 状態と event だけを渡された実装が、daemon と同じ順序判定・同じ head 選択・同じ
  受理／隔離の判断・同じ内容 hash に、パリティ用 fixture の**全件**で到達する。
- **SC-002**: 公開済み revision の canonical bytes と `contentHash` が、後続の consumer 操作・
  後続 event・別 revision 構築のいずれによっても変化しない。変化を試みる操作は失敗する。
- **SC-003**: 意味を変えない event を任意回数送っても、`stateRevision`・`history` 長・`updatedAt` の
  変化が **0 回**であり、かつ受理・delivery key 消費・診断・watermark の記録は **1 件も失われない**。
- **SC-004**: `stateRevision` を CAS token として使う下流が、無害な event の連続送信によって
  空振りさせられない（現在は送るだけで永久に空振りさせられる）。
- **SC-005**: 証跡が上限で落ちた状態から、欠落の件数・理由の内訳・欠落境界を、状態だけを渡された
  reader が**追加の索引なしで**判別できる。片方の理由を上限の 10 倍 flood しても、もう片方の
  存在は状態から消えない。
- **SC-006**: caller 供給の raw identifier / fingerprint が、canonical state・checkpoint・診断・
  capsule・sync 対象のいずれにも **0 件**現れる（現在は adapter 次第で残る）。
- **SC-007**: 意味的に不正な状態の corpus（空文字 / 空白のみの scope identity、暦上存在しない日付、
  相互矛盾する identity）が、**全件** reducer 到達前に捕まり quarantine へ入り、そこから診断・
  abandon・repair のいずれにも進める。永久 wedge は **0 件**。
- **SC-008**: 意味的に妥当な既存状態の corpus が **0 件**しか quarantine されない（偽陽性ゼロ）。
- **SC-009**: §10 の 12 上限すべてについて、上限超過の入力が全 delivery path で同一に扱われ、
  上限直下の入力が全 delivery path で通過する。現在強制されているのは 4 / 12。
- **SC-010**: conflict により候補から除外された operation が、診断から **100%** 特定でき、
  `started` のまま黙って残る件数が **0** になる。
- **SC-011**: 契約変更の前後で、既存の妥当な状態と event に対する挙動が、**9 件の issue が名指しした
  欠陥の修正を除いて**変わらない。判定は変更前の実装との突き合わせで行い、除外は issue 番号ではなく
  具体的な差分（case 名・event・JSON path・そのときの値・issue 番号）で列挙する。表に無い差分が
  1 つでもあれば不合格とする。
- **SC-012**: 凍結した契約が、TypeScript reference と Rust prototype の**両方**で同じ fixture に対し
  同一の結果を出せることを、Stage 1 の実測開始前に確認できる。

## Assumptions

- 対象は `vendor/codemem` 配下の継続性実装ではなく、`CanonicalWorkStateV1` を中心とした継続性契約
  そのものである。ADR-001 のピン留め vendor スナップショットに対する大規模改変は、
  owner sequencing が「まだ行わない scope」として明示的に除外している。
- 正典仕様は `agent-memory-final-spec-v6.md`（v6.1）と addendum v6.2 とし、本 feature で凍結する
  契約が両者と矛盾する場合は矛盾自体を記録して解消する（constitution Governance に従う）。
- 層 A の 5 件は 1 つの契約変更として扱う。#62 の着手条件がそう書かれているため、分割すると
  #62 が blocked のまま残る。
- 層 B と層 C は層 A とは独立に出荷できるが、契約の版が層 A で決まるため、凍結の順序は A → B → C とする。
- #62 はプライバシー境界（constitution Principle III）に該当するため、実装は外部 CLI へ委譲せず
  Claude Code が直接行う。
- 本 feature は契約の凍結までを範囲とし、Rust prototype の実装・G1–G7 の実測は含まない
  （owner sequencing の手順 5）。
- constitution Principle VI（ローカル完結）は現在の GitHub PR 運用と矛盾しており、issue #74 で
  `status: decision needed` として追跡されている。本 feature はこの矛盾を解決しないが、
  plan 段階の Constitution Check では未解決として明記する。
