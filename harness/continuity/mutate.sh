#!/usr/bin/env bash
# 変異テスト: 参照模型の各ゲートをわざと壊し、対応する test が落ちることを確かめる。
#
# 使い方: bash harness/continuity/mutate.sh
# 出力の各行は「変異のラベル」と「その変異を入れたときの fail 件数」。
# **fail 0 の行は生存した変異**（そのゲートを壊しても test が落ちない = 検証が効いていない）。
# 期待は全行が fail 1 件以上。evidence/phase3-reference-model.md §5 の表はこの出力から作る。
#
# 実行件数も必ず突き合わせる。アンカー文字列が実装の変更で外れると `assert old in s` が落ちて
# `&&` が短絡し、その変異は **出力に何も出ないまま黙って飛ばされる**:
#   grep -oP '&& run "\K[^"]+' harness/continuity/mutate.sh | grep -v '^\\K' | sort > /tmp/want.txt
#   bash harness/continuity/mutate.sh | grep -oP '^.*?(?=\s+ℹ fail )' | sed 's/ *$//' | sort > /tmp/got.txt
#   comm -23 /tmp/want.txt /tmp/got.txt   # 空でなければ黙って飛ばされている
# （このコメント行自体が 1 行目の grep に引っかかるので `grep -v '^\K'` で落とす）
#
# 中断すると変異が残るので、その場合は `git checkout harness/continuity/reference-model.ts`。
set -u
cd "$(dirname "$0")/../.."
SRC=harness/continuity/reference-model.ts
BAK=$(mktemp)
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT
cp "$SRC" "$BAK"

EXECUTED=0
SURVIVED=0

run() {
  local label="$1"
  local out
  out=$(node --experimental-strip-types --test harness/continuity/reference-model.test.ts 2>&1)
  local failed
  failed=$(printf '%s' "$out" | grep -E '^# fail |^ℹ fail ' | tail -1)
  local n
  n=$(printf '%s' "$failed" | grep -oE '[0-9]+$')
  printf '%-46s %s\n' "$label" "${failed:-<test が走らなかった>}"
  EXECUTED=$((EXECUTED + 1))
  # 件数が取れないのは変異でソースが壊れて test が 1 つも走らなかった場合。
  # そのゲートを検証できていない点は生存と同じなので同じ扱いにする
  if [ -z "$n" ] || [ "$n" -eq 0 ]; then
    SURVIVED=$((SURVIVED + 1))
  fi
  cp "$BAK" "$SRC"
}

mutate() { # python replacement
  python3 - "$1" "$2" <<'PY'
import sys, pathlib
old, new = sys.argv[1], sys.argv[2]
p = pathlib.Path("harness/continuity/reference-model.ts")
s = p.read_text()
assert old in s, f"not found: {old[:60]}"
p.write_text(s.replace(old, new, 1))
PY
}

mutate "  const applied = idempotencyLedger.get(key);
  if (applied !== undefined) {" "  const applied = idempotencyLedger.get(key);
  if (false) {" && run "dedupe 判定を外す"
mutate "  return compareIngestSeq(a, b) >= 0 ? a : b;" "  return b;" && run "lastIngestSeq の max を外す"
mutate "  if (a.length !== b.length) return a.length < b.length ? -1 : 1;" "  return Number(a) === Number(b) ? 0 : Number(a) < Number(b) ? -1 : 1;\n  // eslint-disable-next-line" && run "ingestSeq を数値比較にする"
mutate "  if (operation === undefined) {
    throw new Error(\`§3.1 違反: operation event \${event.kind} に operation envelope が無い\`);
  }" "  if (operation === undefined) {
    return;
  }" && run "envelope 必須を外す"
mutate "    attestation !== undefined &&" "    true &&" && run "intake の attestation 必須を外す"
mutate "  const { ingestAttestation: _claimed, ...provenance } = event.provenance;" "  const provenance = event.provenance;" && run "caller の attestation を信じる"
mutate "    event.sourceAgent === context.expectedSourceAgent &&" "    true &&" && run "sourceAgent の束縛を外す"
mutate "    !isBlank(context.expectedSourceAgent) &&" "    true &&" && run "空の Agent 名を素通しする"
mutate "    event.turnIdSource === \"native\" && !(authenticatedVersion && context.nativeTurnIdentityProven);" "    false;" && run "native turn の証明要求を外す"
mutate "!(authenticatedVersion && context.nativeTurnIdentityProven)" "!context.nativeTurnIdentityProven" && run "turn 証明の version 束縛を外す"
mutate "    diagnostics: turnDowngraded
      ? [" "    diagnostics: false
      ? [" && run "turn 降格を黙って行う"
mutate "export function assertTurnIdentity(event: NormalizedContinuityEvent): void {" "export function assertTurnIdentity(event: NormalizedContinuityEvent): void {\n  if (event) return;" && run "turn 同一性の不変条件を外す"
mutate "  if (event.sourceAgent !== state.sourceAgent) {" "  if (false) {" && run "state への Agent 束縛を外す"
mutate "  const delivery =
    event.adapterDeliveryId !== undefined && isBlank(event.adapterDeliveryId)
      ? undefined
      : event.adapterDeliveryId;" "  const delivery = event.adapterDeliveryId;" && run "空 adapterDeliveryId の fallback を外す"
mutate "    operation.nativeOperationId !== undefined
      ? byNativeId" "    byNativeId.length > 0
      ? byNativeId" && run "rule 1 の排他を外す"
mutate "            pending.correlation.turnId !== undefined &&" "            true &&" && run "rule 2 の turn 同一性要求を外す"
mutate "  if (eligible.length > 1) {" "  if (false) {" && run "候補が複数のときの拒否を外す"
mutate "  const identityConflicts = (pending: PendingOperation): boolean =>" "  const identityConflicts = (pending: PendingOperation): boolean =>
    pending.correlation.operationMatchKey !== operation.operationMatchKey ||" && run "terminal 側に matchKey 一致を要求し直す"
mutate "  const compatible = candidates.filter((pending) => !identityConflicts(pending));" "  const compatible = candidates.some(identityConflicts) ? [] : candidates;" && run "identity 衝突を候補 1 件で判定する"
mutate "      pending.correlation.canonicalInputHash !== operation.canonicalInputHash);" "      false);" && run "terminal の canonicalInputHash 衝突検査を外す"
mutate "  if (compatible.length === 0) {
    return {
      matched: null,
      diagnostic: \"terminal_conflict\"," "  if (false) {
    return {
      matched: null,
      diagnostic: \"terminal_conflict\"," && run "identity 衝突の隔離を外す"
mutate "  return event.kind === \"tool_failed\" && event.successful === true;" "  return false;" && run "kind と successful の矛盾を素通しする"
mutate "      ...contradictionDiagnostics,
    ];" "    ];" && run "矛盾診断を照合済み経路だけに戻す"
mutate "  if (terminalEvidenceContradicts(event)) return \"unknown\";" "  if (false) return \"unknown\";" && run "矛盾した terminal を succeeded にする"
mutate "  if (start === undefined) {" "  if (false) {" && run "start 不在の分岐を外す"
mutate "  if (compareIngestSeq(terminalEvent.ingestSeq, start.ingestSeq) <= 0) {" "  if (false) {" && run "terminal の権威順序検査を外す"
mutate "      detail: \"terminal が start より後でない\",
      // 一致した 1 件だけが unknown。同じ matchKey の無関係な open を巻き込まない
      unresolvedOperationIds: [matched.operationId]," "      detail: \"terminal が start より後でない\",
      unresolvedOperationIds: openIds," && run "順序違反で候補を巻き込む"
mutate "      correlation.diagnostic === \"terminal_orphaned\"" "      false" && run "候補ゼロの terminal を台帳に入れる"
mutate "      detail: \`operation \${matched.operationId} の start が状態に無く、権威順序を確認できない\`,
      unresolvedOperationIds: [matched.operationId]," "      detail: \`operation \${matched.operationId} の start が状態に無く、権威順序を確認できない\`,
      unresolvedOperationIds: []," && run "順序不明で候補を unknown にしない"
mutate "    for (const evictedId of evicted) operationStarts.delete(evictedId);" "    // eslint-disable-next-line" && run "退避で順序材料を刈らない"
mutate "      (operation.nativeOperationId === undefined
        ? undefined
        : previous.state.pendingOperations.find(" "      (true
        ? undefined
        : previous.state.pendingOperations.find(" && run "再配送 start を nativeOperationId で拾わない"
mutate "              pending.correlation.nativeOperationId === operation.nativeOperationId &&" "              pending.correlation.operationMatchKey === operation.operationMatchKey &&" && run "再配送の判定を matchKey にする"
mutate "    if (startConflict) {" "    if (false) {" && run "start の identity 衝突検査を外す"
mutate "      (existing.correlation.operationMatchKey !== operation.operationMatchKey ||" "      (false ||" && run "start の matchKey 衝突検査を外す"
mutate "          existing.correlation.canonicalInputHash !== operation.canonicalInputHash));" "          false));" && run "start の canonicalInputHash 衝突検査を外す"
mutate "      .filter((pending) => pending.status === \"started\" && pending.correlation.sessionId === event.sessionId)" "      .filter((pending) => pending.status === \"started\")" && run "放棄を session で絞らない"
mutate "        unresolved.has(pending.operationId)
          ? withSourceEvent(" "        false
          ? withSourceEvent(" && run "候補の unknown 化を外す"
mutate "          ? withSourceEvent(
              pending.status === \"started\" ? { ...pending, status: \"unknown\" as const } : pending,
              event.eventId,
            )" "          ? (pending.status === \"started\" ? { ...pending, status: \"unknown\" as const } : pending)" && run "unknown 化で証跡を残さない"
mutate "  if (pending.sourceEventIds.length >= CONTINUITY_LIMITS.arrayItems) return pending;" "  // eslint-disable-next-line" && run "sourceEventIds の上限を外す"
mutate "  if (pending.length < CONTINUITY_LIMITS.arrayItems) return pending;" "  return pending;\n  // eslint-disable-next-line" && run "pendingOperations の上限を外す"
mutate "const EVICTION_ORDER: readonly PendingOperation[\"status\"][] = [
  \"succeeded\",
  \"failed\",
  \"unknown\",
  \"started\",
];" "const EVICTION_ORDER: readonly PendingOperation[\"status\"][] = [\"succeeded\", \"failed\"];" && run "退避対象から open を外す（詰まる）"
mutate "      if (dropped.size === dropCount) break;" "      if (false) break;" && run "退避件数の上限を外す"
mutate "        evicted.length === 0
          ? []" "        true
          ? []" && run "退避を黙って行う"
mutate "    pendingOperations: [...pendingOperations]," "    pendingOperations," && run "revision ごとの配列分離を外す"
mutate "  const applied = idempotencyLedger.get(key);
  if (applied !== undefined) {
    // reducer 側と同じ判定にする。" "  const applied = idempotencyLedger.get(key);
  if (false) {
    // reducer 側と同じ判定にする。" && run "放棄経路の dedupe を外す"
mutate "  return event.adapterDeliveryId === undefined || isBlank(event.adapterDeliveryId)
    ? \`f:\${key}\`
    : \`d:\${key}\`;" "  return key;" && run "台帳の keyspace 分離を外す"
mutate "    !isBlank(context.activeCapabilityHash) &&
    provenance.capabilityHash === context.activeCapabilityHash &&" "    provenance.capabilityHash === context.activeCapabilityHash &&" && run "空の capabilityHash を素通しする"
mutate "  return known < 0 ? SENSITIVITIES.length - 1 : known;" "  return known;" && run "未知の sensitivity で fail open する"
mutate "  if (
    (operation.nativeOperationId !== undefined && isBlank(operation.nativeOperationId)) ||
    (operation.canonicalInputHash !== undefined && isBlank(operation.canonicalInputHash))
  ) {" "  if (false) {" && run "空文字の任意欄を素通しする"
mutate "        (existing.correlation.toolName !== undefined &&
          existing.correlation.toolName !== operation.operationKind) ||" "        false ||" && run "start の operationKind 比較を外す"
mutate "        (existing.correlation.toolName !== undefined &&
          existing.correlation.toolName !== operation.operationKind) ||" "        (existing.correlation.toolName !== operation.operationKind) ||" && run "start の toolName 存在ガードを外す"
mutate "  if (!ABANDONMENT_EVENT_KINDS.has(event.kind)) {" "  if (false) {" && run "放棄 kind の制限を外す"
mutate "    if (applied.sourceHash !== undefined && incoming !== undefined && applied.sourceHash !== incoming) {" "    if (false) {" && run "配送 ID 衝突の隔離を外す"
mutate "  visit(content);
  return SENSITIVITIES[rank] as Sensitivity;" "  visit(content);
  return \"normal\";" && run "sensitivity 集約を normal 固定にする"

mutate "    if (operation !== undefined) {
      assertOperationFields(operation);
    }
    return;" "    return;" && run "adapter 固有 kind の欄検査を外す"
mutate "        (existing.correlation.nativeOperationId !== undefined &&
          operation.nativeOperationId !== undefined &&
          existing.correlation.nativeOperationId !== operation.nativeOperationId) ||" "        false ||" && run "start の nativeOperationId 比較を外す"
mutate "    (pending.correlation.toolName !== undefined &&
      pending.correlation.toolName !== operation.operationKind) ||" "    false ||" && run "terminal の operationKind 比較を外す"
mutate "    (pending.correlation.toolName !== undefined &&
      pending.correlation.toolName !== operation.operationKind) ||" "    (pending.correlation.toolName !== operation.operationKind) ||" && run "terminal の toolName 存在ガードを外す"
mutate "    if (applied.sourceHash !== undefined && incoming !== undefined && applied.sourceHash !== incoming) {" "    if (false) {" && run "放棄経路の配送 ID 衝突検査を外す"

mutate "  if (isBlank(event.canonicalFingerprint)) {" "  if (false) {" && run "空 canonicalFingerprint を素通しする"
mutate "    if (contradicted !== undefined) {" "    if (false) {" && run "確定済み成否との矛盾検査を外す"
mutate "      incoming === \"unknown\" || compatible.some((pending) => pending.status === incoming)" "      false" && run "成否を主張しない terminal も矛盾扱いにする"
mutate "      incoming === \"unknown\" || compatible.some((pending) => pending.status === incoming)" "      incoming === \"unknown\"" && run "成否が一致する兄弟の検査を外す"

mutate "  if (ABANDONMENT_EVENT_KINDS.has(event.kind)) {" "  if (false) {" && run "放棄 kind を還元器に通す"
mutate "  if (event.turnId !== undefined && isBlank(event.turnId)) {" "  if (false) {" && run "空文字の turnId を素通しする"
mutate "  if (isBlank(event.eventId)) {" "  if (false) {" && run "空文字の eventId を素通しする"
mutate "  let rank = rankOfSensitivity(floor);" "  let rank = 0;" && run "sensitivity の下限に直前の集約値を使わない"
mutate "  if (isBlank(event.sessionId)) {" "  if (false) {" && run "空文字の sessionId を素通しする"
mutate "  return /^[\\s\\p{Cf}]*\$/u.test(value);" "  return value === \"\";" && run "空白文字を identity 材料として通す"
mutate "  return /^[\\s\\p{Cf}]*\$/u.test(value);" "  return /^\\s*\$/u.test(value);" && run "書式制御文字だけの identity 材料を通す"
mutate "  if (isBlank(operation.operationMatchKey) || isBlank(operation.operationKind)) {" "  if (false) {" && run "空の operationMatchKey / operationKind を素通しする"
mutate "  const open = compatible.filter((pending) => pending.status === \"started\" || pending.status === \"unknown\");" "  const open = candidates.filter((pending) => pending.status === \"started\" || pending.status === \"unknown\");" && run "open の選択を identity 互換に絞らない"
mutate "    pending.correlation.canonicalInputHash !== undefined && operation.canonicalInputHash === undefined;" "    false;" && run "canonicalInputHash の省略を照合可能として扱う"
mutate "        existing.correlation.sessionId !== event.sessionId ||" "        false ||" && run "再配送 start の session 検査を外す"
mutate "    diagnostics: truncated.length === 0 ? [] : [truncationDiagnostic(event, truncated)]," "    diagnostics: []," && run "放棄で落とした証跡を報告しない"
mutate "  assertOperationEnvelope(terminalEvent);" "" && run "直接呼びの envelope 検査を外す"
mutate "        (existing.correlation.turnId !== undefined &&
          event.turnId !== undefined &&
          existing.correlation.turnId !== event.turnId) ||" "        false ||" && run "再配送 start の turn 検査を外す"
mutate "        (existing.correlation.turnId !== undefined &&
          event.turnId !== undefined &&
          existing.correlation.turnId !== event.turnId) ||" "        (existing.correlation.turnId !== event.turnId) ||" && run "再配送 start の turn 存在ガードを外す"
mutate "  const unverifiable = compatible.length > 1 ? compatible.find(identityUnverifiable) : undefined;" "  const unverifiable = compatible.find(identityUnverifiable);" && run "候補 1 件でも照合不能ゲートを発火させる"
mutate "  const unverifiable = compatible.length > 1 ? compatible.find(identityUnverifiable) : undefined;" "  const unverifiable = compatible.length > 2 ? compatible.find(identityUnverifiable) : undefined;" && run "照合不能ゲートの候補数を 1 件ずらす"
mutate "  if (open.length === 0) {" "  if (open.length === 0 && compatible.find(identityUnverifiable) === undefined) {" && run "照合不能を成否矛盾検査より先に判定する"

mutate "    !isBlank(context.activeCapabilityHash) &&" "    context.activeCapabilityHash !== \"\" &&" && run "空白だけの capability hash を authority にする"
mutate "    !isBlank(context.expectedSourceAgent) &&" "    context.expectedSourceAgent !== \"\" &&" && run "空白だけの Agent 名を authority にする"
mutate "    !isBlank(context.exactAgentVersion) &&" "    context.exactAgentVersion !== \"\" &&" && run "空白だけの exact version を authority にする"
mutate "  assertSameScope(previous.state, terminalEvent);" "" && run "直接呼びの Agent 検査を外す"
mutate "          const recorded = previous.operationStarts.get(pending.operationId)?.turnIdSource;
          return recorded === undefined || recorded === terminalEvent.turnIdSource;" "          return true;" && run "rule 2 の turn 種別の絞り込みを外す"
mutate "          return recorded === undefined || recorded === terminalEvent.turnIdSource;" "          return recorded === terminalEvent.turnIdSource;" && run "turn 種別の材料が無い候補も落とす"
mutate "      unresolvedOperationIds: sourceMismatch ? sameTurn.map((pending) => pending.operationId) : openIds," "      unresolvedOperationIds: openIds," && run "種別違いの巻き込み範囲を広げる"

mutate "    !isBlank(attestation.ingestReceiptId) &&" "    true &&" && run "受領証 ID が空でも認証済みとする"
mutate "    !isBlank(attestation.peerIdentityId) &&" "    true &&" && run "peer identity が空でも認証済みとする"
mutate "    !isBlank(attestation.ingestReceiptId) &&" "    attestation.ingestReceiptId !== \"\" &&" && run "空白だけの受領証 ID を authority にする"
mutate "    !isBlank(provenance.scenarioId) &&" "    true &&" && run "空白の scenarioId で proven を成立させる"
cp "$BAK" "$SRC"
echo "--- 復元後 ---"
node --experimental-strip-types --test harness/continuity/reference-model.test.ts 2>&1 | grep -E '^ℹ (pass|fail) '

# 集計は自己申告にしない。生存（fail 0）と、アンカーが外れて `&&` が短絡し黙って飛ばされた変異の
# 両方を数え、どちらかがあれば非ゼロで終わる。期待件数はこのスクリプト自身の `run` ラベル数から
# 数える（末尾の grep -v は、この数え方を説明している冒頭のコメント行自身を除くため）。
echo "--- 集計 ---"
EXPECTED=$(grep -oP '&& run "\K[^"]+' "$0" | grep -v '^\\K' | wc -l)
printf '実行 %d / 期待 %d、生存 %d\n' "$EXECUTED" "$EXPECTED" "$SURVIVED"
if [ "$EXECUTED" -ne "$EXPECTED" ] || [ "$SURVIVED" -ne 0 ]; then
  echo "変異テスト失敗: 生存した変異か、黙って飛ばされた変異がある" >&2
  exit 1
fi
