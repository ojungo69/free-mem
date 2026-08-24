# ADR-006: source provenance と sharing policy を分離する

- Status: **Accepted**
- Date: 2026-08-24
- Decider: repository owner
- Related: GitHub issues #1, #8, #11, #13, #24, #32, #46, #49, #53, #56, #57, #58, #61, #62, #132
- Normative contract: `specs/005-continuity-p0-contract/contracts/source-aware-continuity-v1.md`
- Machine bundle: `SourceAwareContinuityContractV1`

## 背景

現continuity eventは`sourceAgent`、exact version、capture method、capability hash、ingest attestationを持つ。
一方、`CanonicalWorkStateV1`、`ContinuationCheckpointV2`、`ResumeCapsuleV1`は単数`sourceAgent`しか持たず、
複数Agentが同じlineageへ寄与したときにorigin、last contributor、checkpoint creatorを区別できない。

また、native todo/plan/host metadataとgoal/files/tests/pending operationが同じstate/visibilityに混在する。
sourceをhard partitionすればcross-agent resumeが壊れ、filterを外すだけならAgent-local stateが漏れる。

spec 005はContinuity P0のため「次のpersisted schema版を1つだけ切る」と決定済みだった。#132を別versionで
実装すると、migration、hash、TS/Rust fixtureを連続して作り直す。

## 決定

### 1. 1つのsuccessor bundleへ統合する

Continuity P0と#132 S0を`SourceAwareContinuityContractV1`として同時にfreezeする。bundleは次を含む。

- `CanonicalWorkStateV2`
- `ContinuationCheckpointV3`
- `ResumeCapsuleV2`
- `CanonicalMemoryEntityV1`
- source inventory、restore semantic validation、F0〜F7、9-Issue observation/delta contract
- legacy migration rules、raw-ID policy、limit/diagnostic vocabulary、contract hash

artifactごとのversion整数は独立に保つ。「1つの版」は1つのbundle/hashとmigration decisionを意味する。

### 2. source identity と sharing policy を別軸にする

source identityはauthenticated intake contextから導出する。callerのAgent名、provider/model、人、device、session、
producer markerはそれぞれ別identity軸として扱う。

subject scopeは`personal_vault -> project -> workspace -> branch -> task_lineage -> session -> turn`、sharing scopeは
`agent_private | task_shared | project_shared | personal_shared`とする。sharingのprecedenceは次で固定する。
grant levelは`task_shared -> task_lineage`、`project_shared -> project`、`personal_shared -> personal_vault`へ
exact mappingする。task grantはmatching shared projectionまたはcanonical fact、project/personal grantはcanonical factだけをtargetにする。

```text
secret / local_only / prohibited-egress deny
  > cross-vault / project / workspace deny
  > authority-bound privateConsent + authenticated destination eligibility
  > agent_private isolation
  > destination capability downgrade
  > sharing allow
  > source preference / display filter
```

repository snapshotは独自sensitivityをshared集約へ渡し、subject workspaceと一致する。subject branchがある場合は
repository branchも必須かつ一致する。state/memoryのopaque keyはsubject personal vaultのkeyringで32 bytes以上へ
解決できない限り、再hashされていてもquarantineする。artifact subjectは先にauthoritative scope registryのexact
chainへ解決し、別scopeへのrehash移送を許さない。

### 3. provenanceはsource event参照で保持する

`SourceIdentityV1`を各fieldへ複製しない。既存event provenance/readonly attestationとdaemon所有のprivate-eligibility policyを
一度だけ解決し、state/checkpoint/memoryはsorted uniqueなopaque source-event refsを保持する。全nested refsは
authenticated sourceへ、Agent-local refsは同じclient/sessionへ解決する。memory snapshotはhash-validかつsame-memory
bindingを要求する。lineage origin/last/participantsはappend-only evidenceから導出し、checkpoint creatorだけ
envelopeへ明示する。

private-only stateはshared grantを捏造せずshared projectionを省略する。state/capsuleはいずれかのprojectionを必須とし、
shared projectionを持たないcapsuleはsame-agentだけに限定する。
private shared/memory deliveryはauthenticated grant payloadの`privateConsent=true`も必須とする。capsuleのcheckpoint
ID/revision/creatorは同じresolved checkpointへ、selected memory IDはhash-valid entityへ解決し、同じscope・sharing・
sensitivity・egress・destination policyを通す。

### 4. memory identityは完全一致だけ自動統合する

同じsubject scope、kind、normalization profile、canonical contentのJCS bytesだけを同一factと判定する。
別Agent evidenceを1つのentityへ自動unionするには、`sharingScope`、`sensitivity`、`egressPolicy`の完全一致に加え、
shared contributorごとのexact authenticated consentを要求し、Agent-private evidenceはexact source内だけに限定する。
policy、consent、source localityの不一致はreview candidateへ分離し、semantic similarity/言い換えは別entityのまま
明示authorityのauditable mergeだけを許す。

### 5. raw identifierを新規永続化しない

new intakeはraw IDをopaque化した後に保存しない。legacy migration scratchはmemory-only/transaction lifetimeで
commit/rollback時にzeroizeする。raw値が必要なlegacy originalはlocal quarantine内にuser repair/discardまで
保持し、daemon validator/migratorだけが読む。raw diagnostic、export、external egressは0件とする。

### 6. S0はcontractだけに限定する

S0はinventory、ADR/normative contract、TS/JSON Schema mirror、migration disposition、restore rules、F0〜F7、
hash、#13 start gateまで。product runtime、DB/DDL/data rewrite、reference reducer、MCP、viewer、CI workflowは
変更しない。S0 PRは`Refs #132`でありumbrellaをcloseしない。

## Migration disposition

| Artifact | Verified | Unresolved |
|---|---|---|
| `CanonicalWorkStateV1` | `migrate` | `quarantine` |
| `ContinuationCheckpointV2` | `migrate` | `quarantine` |
| `ResumeCapsuleV1` | `legacy_read_only` | `quarantine` |
| legacy DurableMemory | `migrate` | `legacy_read_only` |

source/scope/hash/chain/opaque-ID材料をauthenticated evidenceから一意に復元できないartifactは推測しない。
`legacy_read_only`はlocal search/inspectionだけを許し、automatic cross-agent full injectionへ使わない。

## 採用理由

- 二重schema/migrationを1系統へ減らす。
- claude-mem型same-agent source scopingを保ちながらcross-agent task sharingを可能にする。
- Agent-local/secret/wrong-scope leakageをfail-closedにする。
- sourceごとのmemory row、registry/factory、追加dependencyを作らない。
- TS/Rustが同じclosed schema/corpus/hashを利用できる。

## 却下した案

- AgentごとのDB/同一memory複製: canonical duplicateとmigrationを増やす。
- `sourceAgent == destinationAgent`だけのallow/deny: sourceとsharing policyを混同する。
- legacy `visibility=private/shared`の機械変換: sharing intentと一致しない。
- semantic自動dedupe: 非決定性、誤統合、追加cost/privacy面を持ち込む。
- V1 fieldの直接書換え: published old-shape contractを壊す。
- 独立schema root: 共通型とvalidatorを重複する。

## 帰結

- #13のpersisted state/checkpoint、cross-agent renderer、source-filter runtimeはS0 bundle/hash完了まで待つ。
- #1のdaemon/RPC/sole-writer/spool/backup骨格はpersisted source-sharing schemaへ依存しない範囲で並行可能。
- S1 reference projection、S2 TS/Rust conformance、S3 storage/migration、S4 retrieval/MCP、S5 product surfaces、
  S6 benchmark/E2Eの順に進める。
- future clientはcore schema forkではなくadapter/profile/conformanceの追加で接続する。
