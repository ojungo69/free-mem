# Phase 0 Research: Continuity P0 + source-aware shared memory

**Date**: 2026-08-24  
**Spec**: [spec.md](spec.md)  
**Inventory baseline**: `cdf90f39f642753a9d72297e3fad41c0deeaaafd`（branch baseのpublished `main` ancestor）

## Decision 1: 1つのcontract bundleで4つのartifact successorを同時freezeする

**Decision**: `SourceAwareContinuityContractV1`を1回のfreeze/hash単位にし、
`CanonicalWorkStateV2`、`ContinuationCheckpointV3`、`ResumeCapsuleV2`、
`CanonicalMemoryEntityV1`と`RestoreSemanticValidationContractV1`を同時に含める。

**Rationale**: spec 005と#132を別versionへ分けると、migration、hash、TS/Rust fixtureを連続して
作り直す。artifact固有の整数versionは既存軸を保ちつつ、bundle/hashを1つにすれば再versioningを防げる。

**Alternatives considered**:

- spec 005を先にmergeし、#132で別successorを立てる: 二重migrationになるため不採用。
- 全artifactのversion整数を同じ値にする: 既存checkpoint V2との連続性を壊すため不採用。

## Decision 2: 既存continuity schemaへsuccessor定義を追加し、V1は変更しない

**Decision**: `harness/schema/continuity.ts`と`continuity.schema.json`へsuccessor型/`$defs`を追加する。
V1定義、reference reducer、old-shape corpusは変更しない。

**Rationale**: 既存validator、JCS、schema-freeze gate、共通`Sensitivity`/`Freshness`/provenance型を
そのまま再利用できる。別schema fileは共通定義を複製するか、現validatorが扱わないcross-file `$ref`を
新設する必要がある。

**Alternatives considered**:

- `source-aware-contract.schema.json`を独立作成: 一見小さいがbase型/validatorを重複するため不採用。
- V1のfieldを直接置換: published old-shape parityを壊すため不採用。

## Decision 3: provenance objectをfieldごとに複製せず、source event参照を正本にする

**Decision**: `SourceIdentityV1`はauthenticated event/adapter manifestから一度だけ解決する。
state/checkpoint/memoryのfieldはopaqueな`sourceEventIds`だけを保持し、origin/last/participants/creatorも
代表source-event IDで表す。

**Rationale**: 既存`ContinuityEventProvenanceV1`、`ContinuityIngestAttestationV1`、`sourceEventIds`を
再利用できる。SourceIdentity objectの複製はdriftとrelabelの新しい経路になる。

**Alternatives considered**:

- 各Observed valueへ`SourceIdentityV1`を埋め込む: 重複と更新不整合を増やすため不採用。
- 単数`sourceAgent`をoriginとして再利用: last contributor/creatorとの混同が残るため不採用。

## Decision 4: canonical client vocabularyとauthorityを分離する

**Decision**: Core 1.0 canonical IDsは`claude-code` / `codex-cli`。`claude` / `codex` aliasは、
authenticated adapter contextが一致するときだけcanonicalizeする。provider/model、人、device、session、
producer channelは別identity軸のまま保持する。

**Rationale**: Unix socket DACは同一OS userを認証するが、ClaudeとCodexの区別までは証明しない。
RPC handshakeのversion文字列とspool eventのcaller文字列だけでsource authorityを昇格できない。

**Alternatives considered**:

- caller文字列をcanonical IDとして採用: F6を満たさないため不採用。
- provider/model名をAgent identityへ流用: coding clientと生成modelを混同するため不採用。

## Decision 5: legacy artifactは根拠別の3 dispositionに限定する

**Decision**:

| Artifact | Verified | Unresolved |
|---|---|---|
| `CanonicalWorkStateV1` | `migrate` | `quarantine` |
| `ContinuationCheckpointV2` | `migrate` | `quarantine` |
| `ResumeCapsuleV1` | `legacy_read_only` | `quarantine` |
| DurableMemory legacy row | `migrate` | `legacy_read_only` |

`migrate`にはauthenticated source evidence、subject scope、hash/chain、opaque-ID変換材料が一意に必要。
legacy capsuleはsuccessorへ自動upgradeせずsame-agent manual/hint-onlyだけを許す。

**Rationale**: 推測migrationはsource relabelまたはwrong-scope sharingを作る。全件quarantineは既存memoryの
閲覧/検索まで失うため、automatic deliveryから外したread-only laneを残す。

**Alternatives considered**:

- `sourceAgent`だけでorigin/participantsをbackfill: caller由来値なので不採用。
- `visibility=shared/private`をsharing scopeへ機械変換: 意味が一致しないため不採用。

## Decision 6: memoryの自動dedupeはcanonical contentの完全一致だけにする

**Decision**: 同じsubject scope、kind、normalization profile、canonical contentのJCS bytesが一致する場合だけ
同じ`canonicalFactId`へ自動統合する。言い換え/semantic similarityは別entityのままにし、明示authorityの
auditable mergeだけを許す。

**Rationale**: 決定論、local privacy、ゼロ追加costを守りながら、同一contentのper-Agent duplicateを0にできる。

**Alternatives considered**:

- semantic自動統合: 非決定性、誤統合、provider costをS0へ持ち込むため不採用。
- 明示entity参照だけ: 同一contentの機械的重複まで残るため不採用。

## Decision 7: F0〜F7はexpected-current-failure corpusとしてgreen CIへ載せる

**Decision**: 1つのversioned JSON corpusにF0〜F7をexact setで入れ、各caseへcurrent V1の
`unsupported` / `unsafe` reasonとsuccessor期待値を記録する。新testはschema、参照整合、case固有invariant、
in-memory negative mutationsを検証する。

| Case | Current V1 disposition |
|---|---|
| F0 | `unsafe / agent_local_not_isolated` |
| F1 | `unsupported / shared_projection_not_expressible` |
| F2 | `unsafe / field_provenance_not_immutable` |
| F3 | `unsupported / multi_agent_lineage_not_expressible` |
| F4 | `unsupported / canonical_memory_evidence_union_not_expressible` |
| F5 | `unsupported / source_retrieval_profile_not_expressible` |
| F6 | `unsafe / caller_claimed_source_not_authority_bound` |
| F7 | `unsafe / destination_policy_and_capability_not_expressible` |

**Rationale**: CIをredにしたままcontract PRはmergeできないが、「現V1が非対応」という事実をpassと誤認しても
いけない。dispositionを明示したcontract corpusなら両方を区別できる。

**Alternatives considered**:

- failing testをそのままcommit: merge不能になるため不採用。
- `harness/continuity/mutate.sh`へstatic corpus mutationを追加: reducer mutation gateと責務が違うため不採用。

## Decision 8: 既存hash walkerとCI globを再利用する

**Decision**: `harness/contract-hashes.mjs`と`.github/workflows/ci.yml`は変更しない。新しいschema/manifest/
fixture JSONは既存walkerが自動hashし、新testは既存`harness/continuity/*.test.ts` globが実行する。

**Rationale**: 新しいscript/workflow/dependencyなしでraw-byte drift、TS typecheck、full contract testsを通せる。

## Decision 9: source inventoryをfrozen search + machine manifest + research summaryで閉じる

`harness/schema/source-aware-source-inventory.v1.json`をmachine-readable正本にし、本節を人向け索引にする。
各entryは`surfaceClass`と`disposition`をちょうど1つ持つ。testはbaseline commitに対してfrozen searchを
再実行し、digest/countとmanifestを照合する。Search 1は`coverageMode=partition`として全308 hitを
ordered `candidateRules`でちょうど1つのsemantic ownerまたはsupporting referenceへ分類し、runtime/schema
のhitをsupportingへ逃がさない。Search 2〜4はbroad discovery snapshotであり、4,095 hitを1行1surfaceへ
水増しせず、semantic entry作成時のdrift anchorとして使う。

### Frozen search commands

```bash
S0_BASE=cdf90f39f642753a9d72297e3fad41c0deeaaafd

git grep -n -I -E \
  'sourceAgent(Version)?|expectedSourceAgent|destinationAgent(Version)?|appliesToAgents|platformSource' \
  "$S0_BASE" -- . ':(exclude)vendor/codemem/pnpm-lock.yaml'

git grep -n -I -E \
  'origin_source|originSource|agentInstanceId|parentSessionId|nativeSessionId|sourceSessionId|source_session_id|actor_id|actor_display_name|origin_device_id|device_id|providerId|modelId|observer_(provider|model|auth_source)|captureMethod|capabilityHash|ingestAttestation|ingestReceiptId|peerIdentityId|adapter_version|native_cli_version|visibility|sharingScope|sharing_scope' \
  "$S0_BASE" -- agent-memory-final-spec-v6.md specs harness vendor/codemem

git grep -n -I -E \
  "(^|[^[:alnum:]_])(source|agent|provider|model)[[:space:]]*:|[.](source|agent|provider|model)([^[:alnum:]_]|$)|[\"'](source|agent|provider|model)[\"']" \
  "$S0_BASE" -- harness vendor/codemem/packages vendor/codemem/plugins

git grep -n -I -E \
  'raw_events|raw_event_sessions|opencode_sessions|memory_items|retrieval_attempts|outcome_evidence|include_visibility|exclude_visibility|include_actor_ids|exclude_actor_ids|ownership_scope|widen_shared|originSource|ProvenanceChip|authorLabel|NORMALIZED_EVENT_FIELDS|METHOD_BODY_FIELDS|FILTER_FIELDS' \
  "$S0_BASE" -- vendor/codemem/packages vendor/codemem/docs
```

`platformSource`はbaseline上の実field 0件で、issue本文だけの候補語である。

### Frozen search results

The digest is SHA-256 of the exact `git grep -n` byte stream, including its trailing newlines.

| Search | Mode | Line count | SHA-256 |
|---|---|---:|---|
| 1 — continuity Agent vocabulary | partition | 308 | `420160dde7e3552caaecdb4ae71ebce6eb01b9fadefaaf88fecdf9f9f41e37eb` |
| 2 — concrete identity/sharing fields | snapshot | 1542 | `0827374c9eb87b6c7d67d84dfcd0653b02c732dd84c0ee9255a4ad6d3de5cdfe` |
| 3 — generic source/agent/provider/model access | snapshot | 1094 | `a566fc042c3285c8c5044cade89975d7921c51b44f8a737989aa83e17cbe7198` |
| 4 — DB/filter/public/renderer closure | snapshot | 1459 | `af8d237f06e71a9ad27a87c51d6387fc5cc27cd457ce6fe370bd8e0a4531efa3` |

### Surface classes

| Class | Representative current surfaces |
|---|---|
| persisted | continuity artifacts、SQLite sessions/memory/raw events/retrieval/outcome、spool、provider metadata |
| wire | hook adapters、normalized event、RPC handshake、daemon/MCP search/export payloads |
| user-facing | viewer actor/visibility/origin/device chips、CLI observer status |
| derived | `sourceEventIds`、fingerprints、lineage summary、producer/model metadata |
| diagnostic | retrieval/outcome ledgers、attribution diagnostics、fixtures/generated mirrors |

### Required semantic splits

| Current term | Successor disposition |
|---|---|
| event `sourceAgent` / vendor `agent` | authenticated `clientId` reference (`rename`) |
| state/checkpoint/capsule single `sourceAgent` | origin/last/participants/creator (`split` or legacy disposition) |
| `origin_source` | producer kind (`rename`), never authority |
| raw/retrieval `source` | ingest/retrieval channel (`rename`) |
| `actor_*` | human identity (`retain`) |
| provider/model | generation identity (`retain`) |
| session/device | subject/host identity (`retain`) |
| visibility + workspace fields | subject scope + sharing scope + sensitivity + destination policy (`split`) |
| source/content fingerprints | idempotency/fingerprint namespace (`retain`), explicitly non-identity |

## Decision 10: S0はprogress gateを同期するがruntimeを変更しない

**Decision**: #13のauthoritative spec/tasks/Phase 3 planへS0 bundle/hash gateを追加する。S0差分はdocs、
schema、manifest/corpus、tests、generated hashesに限定し、`vendor/codemem/**`、reference reducer、DB、MCP、
viewer、workflowを変更しない。

**Rationale**: stale ledgerによる再実装と、S0前のpersisted schema先行を同時に防ぐ。

## Decision 11: restore semantic validationをmachine-readable contractとしてfreezeする

**Decision**: source inventoryで`surfaceClass=persisted`かつ`restoreValidationRequired=true`のentryから
artifact setを導出し、`RestoreSemanticValidationContractV1`へ各entryのscope-identity paths、ISO timestamp
paths、cross-field rules、invalid=`quarantine`、user-only repair authority、audit requiredを記録する。
読込後、reducer/router/selectorへ渡す前に1回だけ適用する。

**Rationale**: 4artifactのmigration dispositionだけでは、FR-016〜022 / SC-007〜008のblank scope、invalid
calendar timestamp、permanent wedge、unaudited repairをfreezeできない。runtimeをS0へ入れず、後続TS/Rustが
同じfield/path setを実装できる契約にする。

**Alternatives considered**:

- reducer内の個別guard: 全read pathへ重複し、invalid artifactが別pathから到達するため不採用。
- schema regexだけ: 暦上存在しないtimestampやcross-field scope不整合を判定できないため不採用。

## Decision 12: ordered headとautomatic resume eligibilityを型で分離する

**Decision**: `RevisionHeadSelectionContractV1`は最大daemon-owned lineage ordinalをordered headとし、
workspace compatibility、checkpoint disposition、lineage fork/conflictを別評価する。ordered headがeligibleでない
場合はmanualへ送り、古いrevisionへautomatic fallbackしない。同一ordinal/multiple headはquarantineする。

**Rationale**: 「新しい」と「再開してよい」を1つのfield/algorithmにすると、incompatible/retracted headを
選ぶか、古いstateへ黙って巻き戻る。fail-closedな2 gateをfixture作成前に固定する。

## Decision 13: raw identifierはnew intakeで保存しない

**Decision**: `RawIdentifierEvidencePolicyV1`でnew-intake persistence=`none`、migration scratch=`memory_only`
かつtransaction終了時zeroize、legacy original=`until_user_repair_or_discard`のlocal quarantine、raw readersは
daemon validator/migratorのみ、raw diagnostics/export/egress=`never/prohibited`とする。

**Rationale**: opaque ID発行後にraw mappingを常設する必要はない。保存しない方がretention/access/export
contractも小さく、漏洩面も減る。legacy migrationは原artifactから再開できる。

## Decision 14: 9 Issueのruntime gateをobservation/delta contractへ落とす

**Decision**: contract-only S0はSC-001〜SC-012のruntime passを主張しない。代わりに
`ContinuityP0ObservationContractV1`へ#46/#49/#53/#61/#62/#56/#57/#32/#58のexact 9 entryを置き、
case/input、JSON path/field、current V1、successor、allowed delta kindをhash対象としてfreezeする。

**Rationale**: runtime fixtureを後続へ送る既存owner判断と、追加判断不要なcontract freezeを両立する。
観測点/差分表が無いまま「後でfixtureを書く」とするとFR-029a/029bを満たさない。
