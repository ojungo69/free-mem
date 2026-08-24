# Feature Specification: Continuity P0 + source-aware shared memory 契約の凍結

**Feature Branch**: `spec/005-continuity-p0-contract`

**Created**: 2026-08-24

**Status**: Clarified

**Input**: User description: "Continuity P0 cluster 9 件（#46 #49 #53 #61 #62 / #56 #57 / #32 #58）をひとつの schema decision window として凍結する。後発の #132 source-aware shared memory S0 も同じ successor schema へ統合し、source identity と sharing policy を別軸にした contract、source inventory、migration disposition、F0〜F7 contract corpus を同じ work package で確定する。runtime 実装は行わない。"

## 背景と問題

issue #1 の owner sequencing（2026-08-18）は Rust Stage 1 の開始条件を 5 手順で定めている。
手順 1（PR #60）は完了済みで、いま止まっているのは**手順 2 の Continuity P0 cluster 9 件**である。
同じコメントは「まだ行わない scope」に `vendor/codemem` の大規模改変を挙げており、この 9 件を
通すことが継続性と Rust の両方を同時に開く唯一の経路になっている。

9 件はばらばらの欠陥ではない。**互いを名指しして「同じ decision window で判断しろ」と書いている**。
Issue `#62` は本文で「#49 / #53 / #61 と versioning をまとめて判断する」と述べ、その 1 点だけを理由に
`status: blocked` が付いている。#56 と #57 は「同じ restore validation work package で解決する」と
書いている。1 件ずつ切ると、凍結 schema の版・fixture・hash・別言語実装の期待値が
そのたびに動く。#35 / #39 / #43 / #44 を 1 回の拡張でまとめた 002 と同じ理由である。

この feature は**契約の凍結**であって runtime 実装ではない。凍結した契約が Rust prototype と
TypeScript reference の共通入力になり、G1–G7 の実測が「Rust の能力不足」ではなく「fixture 不足」
で不合格になる事態を防ぐ。

2026-08-24 に #132 が source provenance と sharing semantics の正本として追加された。#132 も
`CanonicalWorkState` / checkpoint の versioned schema と migration disposition を要求するため、
この feature と別の successor schema を立てると、migration・contract hash・TS/Rust fixture を
連続して作り直すことになる。したがって**次の persisted schema 版は 1 つだけ**とし、Continuity P0 と
Issue `#132` S0 を同じ decision window で凍結する。

## Clarifications

### Session 2026-08-24

- Q: spec 005 と Issue #132 S0 をどの単位で進めるか？ → A: 同じ successor schema 版へ統合し、F0〜F7 を同じ contract PR に含める。
- Q: Core 1.0で別Agent由来の「同じ事実」を自動統合する境界はどこか？ → A: 同じscope・kind・正規化済みcanonical contentの完全一致でfact identityを決める。union eligibilityはFR-042を正本とし、exact policy tuple、shared contributorごとのauthenticated consent、Agent-privateのexact-source localityを要求する。不一致と言い換えは明示reviewへ送る。

問題は 4 つの層に分かれる。

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

### 層 D — source provenance と sharing policy が混同されている（#132）

normalized event は `sourceAgent`、exact client version、capture method、capability hash、ingest
attestation を持つ一方、canonical work state、checkpoint、resume capsule は単数 `sourceAgent` しか
持たない。同じ task lineage を Claude Code → Codex CLI → Claude Code の順に更新すると、その値が
lineage origin、最後の contributor、checkpoint creator のどれを表すか決められない。

また、native todo、Agent 固有 plan、host metadata と、goal、変更 file、test、pending operation が
同じ state object・同じ visibility で扱われている。source を hard filter すれば cross-agent resume が
壊れ、filter を外すだけなら Agent-local state が別 Agent へ漏れる。source identity（誰が作ったか）と
sharing policy（どこへ共有できるか）を別軸にしなければならない。

既存語彙も一意ではない。`claude` / `claude-code`、`codex` / `codex-cli` が混在し、product の
`raw_events.source`、memory の `origin_source`、human actor、provider/model identity、legacy
`visibility` はそれぞれ別の意味を持つ。caller の文字列や `private/shared` を新しい source / sharing
scope へ機械変換すると、偽装された authority または意図しない共有を作る。

DurableMemory は別 source が同じ事実を裏付けても、現状は既存 memory ID を返すだけで source evidence
を結合しない。逆に source ごとの memory row を作れば canonical duplicate が増える。canonical entity
identity、source evidence の union、conflict / supersession を同時に凍結する必要がある。

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

### User Story 4 - sourceを失わず、共有してよいtask memoryだけを別Agentへ渡す (Priority: P1)

Claude Code で始めた同じ task を Codex CLI が引き継ぎ、さらに Claude Code が再開する。goal、変更
file、test、pending operation は共有される一方、native todo、Agent 固有 plan、host metadata、secret
は別 Agent へ自動注入されない。各 field・checkpoint・memory は、誰が作成・更新・裏付けたかを後から
検証できる。

**Why this priority**: source-aware contract が無いまま state persistence を実装すると、単数
`sourceAgent` の意味、DB、checkpoint、hash、migration、rendererをTSとRustの両方で作り直すことになる。
この story は #13 Phase 3 persistence と #1 S4/S5 の開始 gate である。

**Independent Test**: F0〜F7 の runtime-neutral corpus を current contract と successor contract の
両方へ与える。current contract は各 case を `unsupported` または `unsafe` と判定し、successor
contract は期待する source identity、sharing disposition、participant集合、evidence union、downgrade
理由を一意に表現できる。S0ではruntimeを通すことではなく、この差を機械可読に凍結する。

**Acceptance Scenarios**:

1. **F0 — Agent-local isolation**: Claude Code の native todo / host metadata は Codex CLI の自動
   resume対象にならず、存在を示すprivate metadataも許可なく露出しない。
2. **F1 — Shared task visibility**: 同じ task lineage の goal、constraints、modified files、known tests、
   unknown pending operation は Claude Code → Codex CLI で取得できる。
3. **F2 — Immutable provenance**: Codex CLI が Claude Code 由来checkpointを利用・更新しても、元fieldと
   evidenceのsourceはClaude Codeのまま残り、Codex CLIへrelabelされない。
4. **F3 — Multi-Agent lineage**: Claude Code → Codex CLI → Claude Code の順に更新しても、lineage
   origin、last contributor、participants、checkpoint creatorが別々に決まる。
5. **F4 — Canonical memory dedupe**: 同じscope・同じcanonical fact identityを2 Agentが裏付けても
   memory entityは1件で、source evidenceは2系統になる。同じpolicy tupleでもconsentのないevidenceはactive
   unionへ入れず、`consent_or_source_locality_mismatch`としてreviewに保持する。conflict / supersessionはdedupeと混同しない。
6. **F5 — Retrieval policy**: all-source project search、current-source filter、named-source filter、
   active-task shared injectionが別のprofileとして働き、filterを外してもwrong project/workspaceが0件である。
7. **F6 — Source authority**: callerが`sourceAgent`やcanonical client IDを偽装しても、authenticated
   source provenanceまたはautomatic resume authorityを得ない。
8. **F7 — Privacy / destination capability**: `agent_private`、secret、`local_only`、prohibited-egress、認証済み
   destination identityがprivate非対応、または未対応destination capabilityではfull cross-agent injectionが0件となり、
   明示したhint/manual dispositionへdowngradeする。

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
- 生値が必要なlegacy migrationはmemory-only transaction scratchを使い、原artifactだけをlocal quarantineに
  user repair/discardまで保持する。new intake用のraw mappingや新しい永続storeは作らない。
- 上限強制を新設すると、既存の正常な payload が初めて拒否されうる。上限直下の入力で偽陽性を測る。
- `claude` / `claude-code` や `codex` / `codex-cli` のaliasは、authenticated adapter contextなしに
  canonical IDへ昇格させない。unknown sourceを既知Agentとして推測しない。
- legacy `visibility=private/shared` は sharing scope と意味が一致しないため、`agent_private` /
  `project_shared` へ機械変換しない。判定不能なrowはautomatic sharingから除外する。
- source filterは表示・検索optionであり、task lineage identityやcanonical memory identityを変えない。
- derived/synthesized recordもsource evidenceへ遡れるが、evidence certaintyはinstruction authorityを与えない。
- raw hidden reasoningとprivate scratchpadは、sharing scopeに関係なくshared memoryへ保存しない。

## Requirements *(mandatory)*

### Functional Requirements

**層 A — 公開 revision の契約**

- **FR-001**: task lineage 内の revision commit 順序と、現在選択可能な head は、caller 時刻・
  session 内連番・hash の辞書順に依存せず、daemon が所有する取引メタデータだけから決定できなければならない。
- **FR-002**: 順序の新しさと resume 対象としての正しさは別の gate として評価しなければならない。
  workspace 互換性・disposition・accepted / superseded / retracted・fork / conflict を独立に判定する。
  checkpointの`expired`は`unknown`へ潰さず、既知の不適格理由`checkpoint_expired`として保持する。
- **FR-003**: いったん公開・永続化した revision の canonical bytes は、その後の consumer 操作・
  後続 event・別 revision の構築によって変化してはならない。
- **FR-004**: revision 間の構造共有は、共有される全 node が実行時にも変更不可である場合に限り許可する。
- **FR-005**: canonical work state の意味内容が変わらない event は、同じ state bytes・content hash・
  revision pointerを返さなければならない。current V1の比較観測では`history`長と`updatedAt`も不変とするが、
  successor work stateは両fieldを持たず、`StateNeutralTransitionPolicyV1.canonicalStateEffect="reuse_revision"`と
  separate receipt/diagnostic/watermark authorityで同じ不変条件を表す。
- **FR-006**: FR-005 の場合でも、(a) canonical work-state transition、(b) event / delivery の冪等台帳
  transition、(c) 診断 / 監査 transition、(d) event store の網羅 watermark を分離して記録しなければならない。
- **FR-007**: current V1の`updatedAt`はcaller由来の`occurredAt`により巻き戻ってはならない。successorでは
  state-neutral eventが既存revisionとそのenvelope/`committedAt`をそのまま再利用する。semantic state changeで
  新revisionを作る場合だけ、new `committedAt`をdaemon authorityが発行する。
- **FR-008**: 上限つき証跡 window から個別 entry が落ちても、「何件・どの理由・どの境界以前が
  欠けているか」は canonical state だけで判別できなければならない。
- **FR-009**: overflow した事実は state 内の単調な値として保持し、理由ごとに件数と欠落を区別しなければならない。
- **FR-010**: 一つの理由の flood によって、別の理由の存在自体が state から消えてはならない。
- **FR-011**: 欠落件数は JavaScript の安全整数へ変換せずに表現しなければならない。
- **FR-012**: canonical state・checkpoint・診断・capsule・sync operation には、caller が供給した
  raw identifier / fingerprint を保存してはならない。
- **FR-013**: 相関に必要な情報は、daemon が発行・検証する domain-separated な opaque 表現へ変換しなければならない。
- **FR-014**: new intake raw 値は永続化せず入力中にopaque化する。legacy migrationでraw値が必要な経路は
  transaction内のmemory-only scratchと原artifactのlocal quarantineだけへ隔離し、retention・access・export・
  rollback時を含むzeroizationを明示しなければならない。恒久的なraw→opaque mappingを新設してはならない。
- **FR-015**: 層 A の 5 件（#46 / #49 / #53 / #61 / #62）と層 D（#132）は、schema と versioning を
  ひとつの decision window で決め、**新しい persisted schema 版を 1 つ立てる単一の契約変更**として
  凍結しなければならない。v1 内の追加互換にも、連続する別versionにも分けない。
- **FR-015a**: 既存の永続化状態・checkpoint から新しい版への migration dispositionを凍結し、
  移行の失敗が可用性の全損にならないことを規定しなければならない。S0はDDL/runtime migrationを
  実装せず、移行できない状態を層 B の quarantine 経路へ送る契約までを確定する。
- **FR-015b**: 状態はどの版に属するかが常に一意に決まらなければならない。版が判別できない状態を
  推測で解釈してはならない。
- **FR-015c**: 「successor schema版を1つ」とは各artifactの整数を揃える意味ではなく、1つの
  `SourceAwareContinuityContractV1` bundle/hashで`CanonicalWorkStateV2`、`ContinuationCheckpointV3`、
  `ResumeCapsuleV2`、`CanonicalMemoryEntityV1`を同時にfreezeする意味とする。各artifactは直前版から
  1段だけ進み、別PRで追加のsuccessor版を立ててはならない。
- **FR-015d**: migration dispositionは旧artifact種別ごとに`migrate` / `legacy_read_only` /
  `quarantine`を一意に定めなければならない。authenticated source evidenceとscopeが一意に復元できる
  artifactだけをmigrateし、推測を要するartifactはautomatic cross-agent deliveryから除外する。
- **FR-015e**: legacy `CanonicalWorkStateV1.sourceAgent`をorigin/last contributor/participantsへ黙って
  展開してはならない。全source eventが同じauthenticated sourceへ解決できる場合だけ3値を同じsourceで
  初期化できるが、shared projectionへのmigrationには別の明示・認証済みsharing authorityも必須とし、
  provenanceをconsentへ流用してはならない。いずれかを欠けばquarantineする。legacy checkpoint creatorも同じ根拠を要求し、legacy capsuleは
  successorへ自動upgradeせずsame-agent manual/hint-only profileに限定する。legacy DurableMemoryはsourceと
  sharing scopeを一意にbackfillできるまでlegacy_read_onlyとし、automatic cross-agent injectionへ使わない。

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
  導出できなければならない。shared/Agent-local の全 nested `sourceEventIds` と canonical-memory の
  `sourceEventIds`/`evidenceSnapshotIds`を含み、未解決・未認証・lane不一致・別memory snapshotはquarantineする。

**層 C — 上限の強制と診断の可視化**

- **FR-023**: §10 で凍結した 12 上限すべてを、すべての delivery path で強制しなければならない
  （現在強制されているのは構造系 4 つのみ）。
- **FR-024**: 上限違反の扱いは**上限ごとに規定**し、規定した扱いが全 delivery path で一致しなければならない。
  上限は性質で 2 種に分ける。
  - **選択型**（`rankedCandidates` のように「上位 N 件を選ぶ」ことが元から意味を成すもの）:
    上限まで絞り、絞ったこと自体を診断に残す。
  - **容量型**（payload 総 bytes・最終 wrapper bytes・token 予算 5 種のように「入り切らない」もの）:
    拒否する。黙って内容を落とさない。
- **FR-024a**: 12 上限それぞれがどちらの型かは、実装ではなく契約として一覧で固定しなければならない。
  型の割り当てが実装ごとに漂ってはならない。
- **FR-024b**: 選択型で絞られた件数と、容量型で拒否された理由は、どちらも呼び出し側が
  機械可読に判別できなければならない。
- **FR-025**: terminal path が conflict により候補から除外した operation は、診断に現れなければならない
  （現在は診断が空のまま `started` で残る）。
- **FR-026**: `ContinuityDiagnosticCode` の語彙は runtime / schema / contract hash に拘束し、
  実装ごとに漂わせてはならない。

**全層に共通**

- **FR-027**: 凍結した契約は、TypeScript reference と Rust prototype が同じ入力に対して同一の
  判断・同一の状態・同一の内容 hash に到達できる形でなければならない。
- **FR-028**: 新設した検査は、締めすぎによる偽陽性を測る corpus を伴わなければならない
  （通す側も同じ gate で測る）。
- **FR-029**: この feature の成果物は**契約の凍結までとする**。#132のF0〜F7はcurrent V1の
  `unsupported/unsafe` dispositionとsuccessor contractの期待値を持つruntime-neutral contract corpusとして
  同じS0に含める。層A〜Cのruntime conformance fixtureはowner sequencingの手順3（#66 / #67）と
  手順4（#8）へ委ねる。
- **FR-029a**: 契約は、後から書かれる fixture が**追加の設計判断なしに**書ける粒度で凍結しなければ
  ならない。fixture 作成時に契約へ戻って決め直す必要が生じたら、それは凍結が不十分だったということ。
  checkpoint/canonical-memory hash profileの`transitionKinds`はexact ordered tuple `["initial", "parent"]`とし、
  重複・逆順を拒否する。
- **FR-029b**: 凍結した契約が塞ぐ 9 件の欠陥それぞれについて、後続fixtureが満たすべき観測点
  （何を入力し、何が同一であることを確認するか）を列挙しなければならない。F0〜F7以外のruntime
  fixtureそのものは作らない。
- **FR-029c**: F0〜F7はCIを意図的にredにするtestではなく、current contractの非対応を期待値として
  記録するcorpusにしなければならない。successor実装が存在しないことをpassと誤認してはならない。
- **FR-029d**: S0はsource inventory、normative contract/ADR、successor schema、migration disposition、
  F0〜F7、contract hash、#13 start gateまでに限定し、product runtime、DB、reducer、MCP、viewerを変更しない。
- **FR-029e**: F0〜F7の各recordはnon-empty/nonblank/sorted-uniqueなevent evidence IDを持ち、successorの
  record evidence、canonical-memory union、policy review candidateまでexact IDを保持しなければならない。
  F3 lineageはauthenticated ordered transitionsから導出し、`named_source`はauthenticated requested source IDを
  inputとして明示する。

**層 D — source-aware shared memory**

- **FR-030**: Core 1.0 のcanonical client IDは`claude-code`と`codex-cli`とし、legacy alias、future client、
  provider/model identityとの対応をversioned vocabularyとして凍結しなければならない。
- **FR-031**: source identityはauthenticated peer、adapter manifest、ingest channel、exact client/adapter
  version、session binding、capability evidence、daemon所有の`privateEligible` policyからintakeが導出し、
  callerのAgent名やcapsule内booleanだけを信用してはならない。shared capsuleはdestination capability hashが
  `shared-task-v1`を含む認証済みprofileへ解決する場合だけ許可する。
- **FR-032**: model provider/model identityはcoding Agent/client identityと別fieldに保持し、片方をもう片方の
  代用にしてはならない。
- **FR-033**: 新しいsource contractは既存のevent provenance、ingest attestation、source event参照を
  正本へ統合し、同じprovenance objectをfieldごとに複製する並立schemaを作ってはならない。
  successorのnested JSON object/arrayはrecursive readonly型とし、公開後にhash外から変更可能な型を残さない。
  `SourceIdentityV1.ingestAttestation`の全nested fieldもreadonlyとする。
  `CanonicalMemoryEntityV1.sourceEventIds`はnon-emptyとし、owner不明のAgent-private memoryを許可しない。
- **FR-034**: subject scope（`personal_vault` / project / workspace / branch / task lineage / session / turn）とsharing
  scope（`agent_private` / `task_shared` / `project_shared` / `personal_shared`）を別軸として凍結しなければならない。
- **FR-035**: sharing判定のprecedenceは、secret/`local_only`/prohibited-egress deny、cross-vault/project/workspace deny、
  private shared/memoryのauthority-bound `SharingDecisionV1.privateConsent=true`と認証済みdestination
  `SourceIdentityV1.privateEligible` gate、Agent-local isolation、destination capability
  downgrade、sharing allow、source preference/display filterの順で評価しなければならない。
  automaticだけでなくhint/manualと全retrieval profileも、routeに適用可能なauthentication/scope/consent/privacy/
  egress gateを通す。capability gateはautomaticと`active_task_shared`に追加適用する。
- **FR-036**: callerはsharing scopeのproposalまでしか行えず、自分でscopeを昇格できてはならない。
  authority未確認のrecordはautomatic cross-agent full injectionへ使わない。共有grantはversioned
  `SharingDecisionV1`としてexplicit user authority event、exact subject scope、exact projection/memory targetへ
  結び付け、resolved user-eventのaction/scope/sharing scope/target/privateConsent/decidedAt payloadと完全一致させる。
  unknown/unauthenticated/wrong-scope/wrong-target/payload mismatchを拒否し、decision参照はhash前にsorted uniqueとする。
- **FR-037**: shared task projectionとAgent-local projectionを別のvisibility laneとして表現し、
  native todo、Agent固有plan、last assistant conclusion、host metadataを別Agentへ自動注入してはならない。
  private-only canonical stateはgrantを捏造せずshared projectionを省略できるが、projectionが0件のstate/capsuleは拒否し、
  shared projectionなしcapsuleはsame-agentに限定する。capsuleのprojectionはresolved work-state revisionと、
  その他のauthorization metadataはpersisted delivery claimと一致しなければならず、公開hashの再計算をauthorityにしない。
  各projectionはcontained valueの最大sensitivityを宣言し、canonical stateはpresent projection全体の最大値、
  checkpointはembedded stateと同値、capsuleはincluded projectionから再計算した最大値を使う。いずれの不一致も
  delivery前にquarantineし、宣言値でprivate/secret gateを下げてはならない。
  capsuleのcheckpoint ID/revision/creatorは同じresolved checkpointへ結び付け、`selectedMemoryIds`はsorted uniqueかつ
  hash-valid entityへ解決し、scope/sharing/private consent/lifecycle/sensitivity/egress/destination policyを全件検証する。
  pending operationのouter/correlation operation IDは一致し、authenticated start-phase eventはそのoperation evidenceに
  含め、complete correlation envelope、`startTurnIdSource`、source-identity sessionを完全一致させる。
- **FR-038**: 曖昧な単数`sourceAgent`をmulti-Agent lineageの代表値として再利用せず、lineage origin、
  last contributor、participants、checkpoint creator、field/memory source evidenceを区別しなければならない。
  field/memory refsはartifact hashの自己整合だけで受理せず、認証済みsource/snapshot artifactへ解決しなければならない。
  lineage summaryはID認証だけでなくappend-only event/revision evidenceから導出した完全な期待値と一致させる。
- **FR-039**: lineage origin、last contributor、participantsはappend-only event/revision evidenceから
  決定論的に導出し、participantsはdistinct canonical clientごとのfirst substantive eventをresolved canonical
  client ID順に並べる。checkpoint creatorだけはcheckpoint envelopeへ明示的に保持しなければならない。
  `parentStateRevisions`はhash/publication前にsorted uniqueとし、重複または同じ集合の並べ替えを拒否する。
- **FR-040**: legacy `source` / `origin_source` / actor / provider / visibilityの各語彙にdisposition表を持ち、
  意味が一致しない値を新しいsource identityまたはsharing scopeへ機械変換してはならない。
- **FR-041**: shared lineage適用とAgent-local isolationの判定は、reducer、terminal correlation、abandonの
  全入口で同じcontractに従い、単に既存のsame-Agent guardを削除するだけであってはならない。
- **FR-042**: DurableMemoryはscopeとversioned canonical fact identityで一意なentityを持ち、別sourceの
  同一evidenceはentityを複製せずunionする。Core 1.0の自動同一判定は、同じsubject scope・kind・
  versioned normalization profileで得たcanonical contentの完全一致に限定する。言い換えやsemantic
  similarityは自動統合せず、明示authorityによるauditable mergeだけを許可する。conflict、supersession、
  validity historyはdedupeと別に扱う。evidence unionは`sharingScope`・`sensitivity`・`egressPolicy`が完全一致し、
  shared contributorごとのexact authenticated consentがあるときだけ自動化する。Agent-private evidenceはexact source内だけ
  unionし、cross-sourceでは統合しない。policy/consent/source-locality不一致はactive entityへ
  混ぜず明示user reviewまで別laneに置く。
- **FR-043**: source filterは検索・表示optionであり、filterの有無によってtask lineage identity、
  canonical memory identity、revision historyが変化してはならない。
  `current_source`はdestination source、`named_source`は明示requested sourceのrecordだけを返す。
- **FR-044**: future clientはcore schema forkやAgent別DBではなく、adapter/profile/conformanceの追加で
  接続できなければならない。
- **FR-045**: source inventoryは、source/agent/client/provider/session/device/capture/attestation/sharing/
  visibilityに関する全field、DB column、query/filter、renderer、wire/public surface、derived/diagnostic valueを
  列挙し、各行を`persisted` / `wire` / `user-facing` / `derived` / `diagnostic`と、`retain` / `rename` /
  `split` / `migrate` / `legacy_read_only` / `quarantine`で分類しなければならない。
- **FR-046**: inventoryの全`sourceAgent` occurrenceに、event source、legacy single-source summary、
  lineage origin、last contributor、checkpoint creator、display-onlyのどの意味か、またはambiguousで廃止するかの
  dispositionを1つ割り当てなければならない。
- **FR-047**: #13のPhase 3 start gateとauthoritative task ledgerは、S0 contract bundle/hash、F0〜F7、
  migration dispositionがcompleteになるまでpersisted state/checkpoint、cross-agent renderer、source filterの
  runtime taskを開始不可として表現しなければならない。

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
- **Source Identity**: authenticated intakeが導出したcoding client、version、adapter、session、device、
  capability、capture method、ingest receiptの組。provider/model identityとは別物である。
- **Source Evidence Reference**: field・revision・memoryを裏付けるnormalized event/source identityへの
  参照。同じprovenance objectを各fieldへ複製しない。
- **Shared Task Projection**: goal、constraints、files、commands、tests、pending operations、repository
  stateなど、同じtask lineageの許可されたdestinationへ共有できるstate。
- **Agent-Local Projection**: native todo/plan、last assistant conclusion、host metadataなど、source
  Agentと許可されたsurfaceだけが取得できるstate。
- **Sharing Scope**: source identityとは独立に、recordをAgent-private、task、project、personalのどこへ
  共有できるかを表すpolicy classification。
- **Canonical Memory Entity**: scopeとversioned canonical fact identityで一意なmemory。複数sourceの
  evidenceをunionし、conflict/supersession/validity historyを別に保持する。自動identityは同じscope・
  kind・normalization profile・canonical contentの完全一致であり、semantic similarityを含まない。
- **Revision Head Selection Contract**: daemon-owned ordinalで決めるordered headと、workspace/disposition/
  fork/conflictを通過したautomatic resume eligibilityを別々に表す。ordered headが不適格なら古いrevisionへ
  自動fallbackせずmanualへ送る。
- **Continuity P0 Observation Contract**: 9 Issueそれぞれの入力、観測path、current V1値、successor期待値、
  許容behavior deltaをmachine-readableに固定する。
- **Raw Identifier Evidence Policy**: new intake、migration scratch、quarantined original artifactごとのretention、
  reader、diagnostic、export、egress、zeroizationを固定する。
- **Source-Aware Continuity Contract Bundle**: `SourceAwareContinuityContractV1`としてhashされる1回の
  freeze単位。`CanonicalWorkStateV2`、`ContinuationCheckpointV3`、`ResumeCapsuleV2`、
  `CanonicalMemoryEntityV1`とF0〜F7を同時に含む。
- **Legacy Artifact Disposition**: 旧artifactごとに一意な`migrate` / `legacy_read_only` / `quarantine`。
  source/scopeをauthenticated evidenceから復元できないartifactを推測でsuccessorへ昇格させない。

## Success Criteria *(mandatory)*

### Downstream runtime gates frozen by S0

SC-001〜SC-012は後続runtime/fixtureがpassすべきgateであり、contract-only S0がruntime passを主張するものでは
ない。S0はSC-022のmachine-readable observation/delta contractとして、各gateの入力・観測点・期待値を
追加判断なしに実装できる粒度でfreezeする。

- **SC-001**: 状態と event だけを渡された実装が、daemon と同じ順序判定・同じ head 選択・同じ
  受理／隔離の判断・同じ内容 hash に、パリティ用 fixture の**全件**で到達する。
- **SC-002**: 公開済み revision の canonical bytes と `contentHash` が、後続の consumer 操作・
  後続 event・別 revision 構築のいずれによっても変化しない。変化を試みる操作は失敗する。
- **SC-003**: 意味を変えないeventを任意回数送ったcurrent V1比較では`stateRevision`・`history`長・
  `updatedAt`の変化が**0回**、successorでは`canonicalStateEffect="reuse_revision"`でnew revisionが**0件**で
  ある。どちらも受理・delivery key消費・診断coverage・watermarkの記録を失わず、successorのexact authority/
  key/collision動作は`StateNeutralTransitionPolicyV1`と#46 observation entryから一意に導けなければならない。
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
- **SC-011**: 層A〜Cの契約変更前後で、既存の妥当な状態とeventに対する挙動が、**9件のissueが名指しした
  欠陥の修正を除いて**変わらない。判定は変更前の実装との突き合わせで行い、除外はissue番号ではなく
  具体的な差分（case名・event・JSON path・そのときの値・issue番号）で列挙する。層Dの意図した差分は
  SC-013〜SC-023で別に列挙し、どちらの許容表にも無い差分が1つでもあれば不合格とする。S0では9件の
  exact observation/delta entryをfreezeし、runtime before/after実測は後続fixtureで行う。
- **SC-012**: 凍結した契約が、TypeScript reference と Rust prototype の**両方**で同じ fixture に対し
  同一の結果を出せることを、Stage 1 の実測開始前に確認できる。

### S0 completion outcomes

- **SC-013**: F0〜F7の全8 caseがschema-validなcontract corpusとして存在し、current V1の非対応理由と
  successor contractの期待値が各caseで一意に判別できる。
- **SC-014**: Claude Code → Codex CLI → Claude Code のlineageで、origin、last contributor、participants、
  checkpoint creatorの期待値がF3の全stepで一致し、source relabelが**0件**である。
- **SC-015**: Agent-local state、secret、`local_only`、prohibited-egress、wrong `personal_vault`/project/workspace、
  opt-inなしまたは認証済みdestination `SourceIdentityV1.privateEligible=false`のprivate stateが別Agentへのautomatic full injectionへ入る件数が
  **0件**である。
- **SC-016**: 同じcanonical fact identityを2 Agentが裏付けたF4でmemory entityが**1件**、source
  evidence系統が**2件**となり、per-Agent duplicateが**0件**である。同じpolicy tupleのunconsented recordは
  active evidenceを増やさず、`consent_or_source_locality_mismatch`のreview candidateとして保持される。
- **SC-017**: canonical client ID、legacy alias、unknown/unverified source、provider/modelの全fixtureが
  versioned vocabulary/disposition表のちょうど1行に対応し、callerの自己申告だけでtrustedへ昇格する件数が**0件**である。
- **SC-018**: S0差分にproduct runtime、DB、reducer、MCP、viewerの変更が**0件**で、successor persisted
  schema版とmigration dispositionがspec 005と#132で**1系統**だけ存在する。
- **SC-019**: `coverageMode=partition`のfrozen searchが返す全candidateは、ちょうど1つのinventory行または
  明示したdocumentation/test/fixture/tooling supporting ruleへ分類され、未分類・重複分類が**0件**である。
  runtime/normative schemaの単数`sourceAgent`はsupportingへ送れず、inventory行への未分類が**0件**である。
  広い`coverageMode=snapshot`検索は候補集合のdrift検出に限定し、4,095 hitを偽の1行1surfaceへ膨らませない。
- **SC-020**: `SourceAwareContinuityContractV1.contractHash`はnormative contract §14の完全なmachine-readable
  入力集合（manifestの`contractHash`以外の全field）を含み、4 successor schema、全restore rule、F0〜F7、
  legacy dispositionに加えて9 Issue observation、raw-ID/sharing/opaque-ID/limit/diagnostic/revision/head policyと
  全hash vectorのいずれかを除外して再計算が一致する件数が**0件**である。
- **SC-021**: #13のPhase 3 start gateとauthoritative task ledgerがS0 bundle/hashへ接続され、S0未完了時に
  persisted state/checkpoint、cross-agent renderer、source filterのruntime taskをreadyと示す箇所が**0件**である。
- **SC-022**: `ContinuityP0ObservationContractV1`に#46/#49/#53/#61/#62/#56/#57/#32/#58のexact 9 entryが
  あり、各entryがcase ID、input、JSON path/field、current V1値、successor期待値、許容delta kindを持つ。
  9 Issueの未分類/重複entryは**0件**である。
- **SC-023**: `RawIdentifierEvidencePolicyV1`はnew intake raw IDの永続化**0件**、migration scratchの
  transaction終了時zeroization、quarantined originalのuser repair/discardまでのlocal retention、daemon
  validator/migratorだけのraw access、raw diagnostic/export/egress **0件**を機械可読に固定する。

## Assumptions

- 対象は `vendor/codemem` 配下の継続性実装ではなく、`CanonicalWorkStateV1` を中心とした継続性契約
  そのものである。ADR-001 のピン留め vendor スナップショットに対する大規模改変は、
  owner sequencing が「まだ行わない scope」として明示的に除外している。
- 正典仕様は `agent-memory-final-spec-v6.md`（v6.1）と addendum v6.2 とし、本 feature で凍結する
  契約が両者と矛盾する場合は矛盾自体を記録して解消する（constitution Governance に従う）。
- 層 A の 5 件と層 D（#132）は 1 つのsuccessor schema decisionとして扱う。#62 と #132 の双方が
  versioning/migrationを先にfreezeするよう要求しているため、分割すると二重migrationになる。
- 層 B と層 C はruntime work packageとしては独立に出荷できるが、契約の版は層 A/D で1回だけ決める。
  凍結の順序は A/D → B → C とする。
- #62 はプライバシー境界（constitution Principle III）に該当するため、実装は外部 CLI へ委譲せず
  Claude Code が直接行う。
- 本 feature は契約の凍結までを範囲とし、#132 F0〜F7 contract corpusだけを同梱する。層A〜Cの
  runtime conformance fixtureとRust prototypeの実装・G1–G7の実測は含まない。
- 層 A/D は1つの新しい schema 版として切る。移行が必要になるが、fixture と Rust 側の期待値を一度に
  切り替えられ、どの版の状態かが常に一意に決まる。v1 内の追加互換に収めると、新しい欄を持たない
  状態と持つ状態の二重の挙動を長く抱え、Rust 側も両方に対応する必要が生じる。
- 「1つのschema版」は1つのcontract bundle/hashを意味し、artifact固有の整数versionを揃える意味ではない。
  successorはwork state V2、checkpoint V3、capsule V2、canonical memory entity V1で固定する。
- S0ではmigration dispositionだけをfreezeし、DDL、data rewrite、runtime reader/writerは後続work packageで
  実装する。S0 PRは`Refs #132`とし、umbrella Issue全体をcloseしない。
- `SourceIdentityManager`、client registry/factory、per-Agent DB、source別memory row、新規dependencyは
  作らない。既存のevent provenance、source event参照、contract validatorで必要な契約を表現する。
- §10 の上限は性質で 2 種に分けて扱う。「上位 N 件を選ぶ」ことが元から意味を成す上限は絞り、
  「入り切らない」上限は拒否する。一律 fail-closed は候補が数件多いだけで落ちるため採らず、
  一律の切り詰めは内容が黙って欠ける経路を新設するため採らない。
- constitution Principle VI（ローカル完結）は現在の GitHub PR 運用と矛盾しており、issue #74 で
  `status: decision needed` として追跡されている。本 feature はこの矛盾を解決しないが、
  plan 段階の Constitution Check では未解決として明記する。
