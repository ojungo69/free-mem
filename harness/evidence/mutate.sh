#!/usr/bin/env bash
# 変異テスト: 証拠 digest まわりの各ゲートをわざと壊し、対応する test が落ちることを確かめる。
#
# 使い方: bash harness/evidence/mutate.sh
# 出力の各行は「M 番号 + ラベル」と、その変異を入れたときの fail 件数。
# **fail 0 の行は生存した変異**（そのゲートを壊しても test が落ちない = 検証が効いていない）。
#
# 実行件数も必ず突き合わせる。アンカーが実装の変更で外れると `assert count == 1` が落ちて
# `&&` が短絡し、その変異は出力に何も出ないまま黙って飛ばされる。
#
# 中断すると変異が残る。その場合は `git checkout harness/`。
set -u
cd "$(dirname "$0")/../.."

ASSEMBLE=harness/assemble.ts
VERIFY=harness/evidence/verify.ts
NORMALIZE=harness/evidence/normalize.ts
SCHEMA=harness/schema/capability.schema.json
IMPORT=harness/rig/import-evidence.mjs
SCHEMAV=harness/schema/validate.ts
# 出荷データ側。kill switch (#90) は実装ではなく commit 済みの成果物を見るので、
# 実装の変異では触れない。fixture 1 件を変異対象に入れて歯止めが本当に鳴るかを見る
FIXTURE=harness/fixtures/claude/lifecycle-basic.json
HASHES=harness/contract-hashes.json
TASKS=specs/003-evidence-hash-normalization/tasks.md

MUTABLE=("$ASSEMBLE" "$VERIFY" "$NORMALIZE" "$SCHEMA" "$SCHEMAV" "$IMPORT" "$HASHES" "$FIXTURE")
TESTS=(
  harness/evidence/hash-inputs.test.ts
  harness/evidence/killswitch.test.ts
  harness/evidence/manifest.test.ts
  harness/evidence/normalize.test.ts
  harness/evidence/promotion.test.ts
  harness/evidence/schema.test.ts
  harness/evidence/secrets.test.ts
  harness/evidence/rig-manifest.test.mjs
)
BAKDIR=$(mktemp -d)
restore_all() { for f in "${MUTABLE[@]}"; do cp "$BAKDIR/$(basename "$f")" "$f"; done; }
trap 'restore_all; rm -rf "$BAKDIR"' EXIT
for f in "${MUTABLE[@]}"; do cp "$f" "$BAKDIR/$(basename "$f")"; done

# --- 変異表との突き合わせ（T042）。長い実行に入る前に済ませる ---
# 表の M 番号がこのスクリプトに実在するか、表が挙げた test 名が本当に存在するかの両方を見る。
# 名前だけ書いて test を書いていない行は、これでしか塞げない
python3 - "$0" "$TASKS" <<'COVERAGE' || exit 1
import pathlib, re, sys
script, tasks = pathlib.Path(sys.argv[1]).read_text(), pathlib.Path(sys.argv[2]).read_text()
rows = re.findall(r"^\| (M\d+b?) \| [^|]+ \| ([^|]+) \|", tasks, re.M)
table = {mid for mid, _ in rows}
in_script = set(re.findall(r"&& run '(M\d+b?):", script)) | set(re.findall(r"&& run_custom '(M\d+b?):", script))
bad = []
if len(table) != 69:
    bad.append(f"変異表の行が {len(table)} 件（69 件でない）")
for missing in sorted(table - in_script):
    bad.append(f"{missing}: 表にあるが mutate.sh に実変異が無い")
for extra in sorted(in_script - table):
    bad.append(f"{extra}: mutate.sh にあるが変異表に行が無い")
for mid, cell in rows:
    if cell.strip().startswith("custom:"):
        continue
    names = re.findall(r"`([\w.-]+\.test\.(?:ts|mjs))::([^`]+)`", cell)
    if not names:
        bad.append(f"{mid}: 殺す test を `file::name` の形で書いていない")
    for f, name in names:
        path = pathlib.Path("harness/evidence") / f
        if not path.exists():
            bad.append(f"{mid}: {f} が無い")
        elif f'"{name}"' not in path.read_text():
            bad.append(f"{mid}: {f} に test \"{name}\" が無い")
if bad:
    print("変異表の突き合わせ失敗:", file=sys.stderr)
    for b in bad:
        print(f"  - {b}", file=sys.stderr)
    raise SystemExit(1)
print(f"変異表 {len(table)} 件と mutate.sh の実変異が一致し、挙げた test 名もすべて実在する")
COVERAGE

EXECUTED=0
SURVIVED=0
BASELINE_TESTS=$(node --experimental-strip-types --test "${TESTS[@]}" 2>&1 \
  | grep -E '^# tests |^ℹ tests ' | tail -1 | grep -oE '[0-9]+$')
if [ -z "${BASELINE_TESTS:-}" ]; then
  echo "変異テスト失敗: baseline の test 件数を取得できない" >&2
  exit 1
fi

run() {
  local label="$1" out failed n ran
  out=$(node --experimental-strip-types --test "${TESTS[@]}" 2>&1)
  failed=$(printf '%s' "$out" | grep -E '^# fail |^ℹ fail ' | tail -1)
  n=$(printf '%s' "$failed" | grep -oE '[0-9]+$')
  # 走った件数も見る。変異でソースが parse できないと node:test は「読み込みに失敗した 1 件」を
  # fail として数えるので、fail 件数だけを見るとゲートを一度も壊していない変異が kill として計上される
  ran=$(printf '%s' "$out" | grep -E '^# tests |^ℹ tests ' | tail -1 | grep -oE '[0-9]+$')
  printf '%-52s %s\n' "$label" "${failed:-<test が走らなかった>}"
  EXECUTED=$((EXECUTED + 1))
  if [ -z "$n" ] || [ "$n" -eq 0 ]; then
    SURVIVED=$((SURVIVED + 1))
  elif [ -z "$ran" ] || [ "$ran" -ne "$BASELINE_TESTS" ]; then
    printf '  ^ 変異が test を走らせていない（tests %s / baseline %s）。ゲート未検証\n' "${ran:-?}" "$BASELINE_TESTS"
    SURVIVED=$((SURVIVED + 1))
  fi
  restore_all
}

# node:test では殺せない変異のための口。殺すのは別のコマンドの終了状態
run_custom() {
  local label="$1"; shift
  EXECUTED=$((EXECUTED + 1))
  if "$@" >/dev/null 2>&1; then
    printf '%-52s ℹ fail 0\n' "$label"
    SURVIVED=$((SURVIVED + 1))
  else
    printf '%-52s ℹ fail 1 (custom)\n' "$label"
  fi
  restore_all
}

mutate() { # file old new
  python3 - "$1" "$2" "$3" <<'PY'
import sys, pathlib
target, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
# `\n` の変換はしない。この表には TS ソース中のリテラル `\n`（文字列内の改行エスケープ）を
# 含むアンカーがあり、変換すると本物の改行になって module が壊れる。改行はそのまま書く
p = pathlib.Path(target)
s = p.read_text()
# アンカーはソース中で一意でなければならない。2 箇所に出ると replace(old, new, 1) は必ず
# 先頭を書き換えるので、2 つ目を狙ったラベルが 1 つ目を壊すだけになる
count = s.count(old)
assert count == 1, f"anchor must be unique in {target} (found {count}): {old[:70]}"
p.write_text(s.replace(old, new, 1))
PY
}

# contract-hashes の変異は node:test では殺せない。再生成との diff で殺す
check_hashes() { diff <(node harness/contract-hashes.mjs) "$HASHES"; }

mutate $ASSEMBLE 'promotion.evidenceKind === "real-cli-e2e" && prev.evidenceKind !== "real-cli-e2e";' 'false;' && run 'M0: 証跡の優劣を無視する'
mutate $ASSEMBLE 'for (const f of fixtures) verifiedByFixture.set(f.fixtureId, verifyEvidence(f, ctx));' 'for (const f of fixtures) verifiedByFixture.set(f.fixtureId, []);' && run 'M1: 証拠の検証を丸ごと飛ばす'
mutate $VERIFY 'if (evidenceHash !== ref.evidenceHash) {' 'if (false) {' && run 'M2: evidenceHash の不一致を通す'
mutate $VERIFY 'if (ref.normalizationVersion !== NORMALIZATION_VERSION) {' 'if (false) {' && run 'M3: 未知の正規化版を通す'
mutate $VERIFY '  "subagentCapture",' '  "subagentCapture",
  "promptAwareInjection",' && run 'M4: 導けない高位主張を導けることにする'
mutate $NORMALIZE 'if (relPath.split(/[\\/]/).includes("..")) fail(' 'if (false) fail(' && run 'M5: 相対 path の .. を通す'
mutate $NORMALIZE 'candidate = realpathSync(join(realRoot, relPath));' 'candidate = join(realRoot, relPath);' && run 'M6: 候補 path を realpath せず symlink を追わない'
mutate $NORMALIZE '  "prompt",
]);' ']);' && run 'M7: prompt を verbatim 集合から外す'
mutate $NORMALIZE 'if (key === "at") continue; // 時刻は取得のたびに変わる' 'if (false) continue; // 時刻は取得のたびに変わる' && run 'M8: at を落とさない'
mutate $NORMALIZE 'if (typeof value === "string") return value === "" ? "<string:empty>" : "<string>";' 'if (typeof value === "string") return value === "" ? "<string:empty>" : value;' && run 'M8b: 深い階層の文字列まで verbatim にする'
mutate $NORMALIZE '    out[key] = redact(value);
  }
  return out;
}' '    if (VERBATIM_PAYLOAD_KEYS.has(key) || ID_KEYS.has(key) || PATH_KEYS.has(key)) out[key] = redact(value);
  }
  return out;
}' && run 'M9: 未知の欄を落とす'
mutate $NORMALIZE 'return `${lines.join("\n")}\n`;' 'return lines.join("\n");' && run 'M10: 最終行の後の LF を落とす'
mutate $NORMALIZE '    for (const item of value) out.push(redact(item));
    return out;' '    for (const item of value) out.push(redact(item));
    return out.slice(0, 1);' && run 'M11: 配列の長さを保たない'
mutate $NORMALIZE 'if (lines.length === 0) fail("capture has 0 usable lines");' 'if (false) fail("capture has 0 usable lines");' && run 'M12: 空の観測記録を通す'
mutate $SCHEMA '    "evidence": {
      "$comment": "実 CLI 観測' '    "evidenceDISABLED": {
      "$comment": "実 CLI 観測' && run 'M13: schema から evidence の定義を落とす'
mutate $VERIFY 'reject(f.fixtureId, `captureRawHash mismatch for ${ref.path}`);' 'reject(f.fixtureId, `captureRawHash mismatch for ${capturePath}`);' && run 'M14: 失敗の説明に絶対 path を載せる'
mutate $SCHEMA '      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,' '      "minItems": 0,
      "items": {
        "type": "object",
        "additionalProperties": false,' && run 'M15: schema の minItems を外す'
mutate $NORMALIZE '      if (ID_KEYS.has(key)) {
        out[key] = tokens.id(value);' '      if (ID_KEYS.has(key)) {
        out[key] = "<id>";' && run 'M16: 識別子の等値関係を捨てる'
mutate $NORMALIZE 'const seen = { id: new Map<string, string>(), path: new Map<string, string>() };' 'const shared = new Map<string, string>();
  const seen = { id: shared, path: shared };' && run 'M17: id と path の番号空間を共有する'
mutate $ASSEMBLE '        if (!observed.has(name)) {' '        if (false) {' && run 'M18: 申告した hook の実在を確かめない'
mutate $ASSEMBLE 'export const shareRef = (a: number[], b: number[]): boolean => a.some((i) => b.includes(i));' 'export const shareRef = (a: number[], b: number[]): boolean => a.length > 0 || b.length > 0;' && run 'M19: 対の成立に共有記録を求めない'
mutate $VERIFY '["captureHash", manifest.captureHash === computed.evidenceHash],' '["captureHash", true],' && run 'M20: manifest の captureHash 照合を外す'
mutate $NORMALIZE '      parsed = parseIJson(rawLine);' '      parsed = JSON.parse(rawLine);' && run 'M21: 重複キーを持つ行を通す'
mutate $NORMALIZE 'if (Object.hasOwn(parsed.payload, "unparsed")) {' 'if (false) {' && run 'M22: payload.unparsed を通す'
mutate $NORMALIZE '  const out = Object.create(null) as { [k: string]: JsonValue };
  // 整列した後の順で走る' '  const out = {} as { [k: string]: JsonValue };
  // 整列した後の順で走る' && run 'M23: 中間 object を素の {} で作る'
mutate $VERIFY '  "cwd",
  "transcript_path",' '  "transcript_path",' && run 'M24: 警報の材料から cwd を外す'
mutate $ASSEMBLE 'const supporting = refs.filter((r) => derive(r) === declared);' 'const supporting = refs.slice();' && run 'M26: 申告値と導出値の照合を外す'
mutate $ASSEMBLE '    if (!derivable || refs.length === 0) {' '    if (refs.length === 0) {' && run 'M27: 導けない主張にも導出を求める'
mutate $ASSEMBLE 'evidenceKind: backed.length > 0 ? "real-cli-e2e" : "source-test",' 'evidenceKind: "real-cli-e2e",' && run 'M28: manifest 無しでも real-cli-e2e にする'
mutate $VERIFY '    if (captureRawHash !== ref.captureRawHash) {' '    if (false) {' && run 'M29: captureRawHash の照合を外す'
mutate $NORMALIZE '  for (const key of Object.keys(payload).sort(byUtf16)) {' '  for (const key of Object.keys(payload)) {' && run 'M30: payload の走査を整列前の書き順にする'
mutate $NORMALIZE '  if (!ArrayBuffer.isView(bytes)) {
    fail("normalizeCapture takes raw bytes (Uint8Array), not a decoded string");
  }' '  if (false) {
    fail("normalizeCapture takes raw bytes (Uint8Array), not a decoded string");
  }' && run 'M31: 復号済み文字列も受け取る'
mutate $ASSEMBLE '  capabilities.capabilityHashInputs = [
    canonicalizeJson({ cli, nativeVersion }),' '  capabilities.capabilityHashInputs = [
    [cli, nativeVersion].join("@") +
    canonicalizeJson({ cli, nativeVersion }).slice(0, 0),' && run 'M32: hash 入力を 1 本の連結文字列に戻す'
mutate $ASSEMBLE 'for (const c of f.limitationCodes ?? []) fixtureLimitations.push(`[${f.fixtureId}] ${c}`);' 'for (const c of f.limitationCodes ?? []) fixtureLimitations.push(`[${f.scenario}] ${c}`);' && run 'M33: 自由文の scenario を成果物へ載せる'
mutate $VERIFY '    const captureRawHash = digestRaw(bytes);
    if (captureRawHash !== ref.captureRawHash) {' '    const captureRawHash = digestRaw(bytes);
    if (ref.manifest !== undefined && captureRawHash !== ref.captureRawHash) {' && run 'M34: legacy ref では生 byte を照合しない'
mutate $ASSEMBLE '    const backed = supporting.filter(' '    const backed = refs.filter(' && run 'M35: 支持しない記録の manifest でも昇格させる'
mutate $ASSEMBLE 'const supporting = refs.filter((r) => derive(r) === declared);' 'const supporting = refs.every((r) => derive(r) === declared) ? refs.slice() : [];' && run 'M36: 全 ref の一致を要求する'
mutate $VERIFY '  if (cli === "codex") {
    if (shares("turn_id")) capture.turn_completed = "native";' '  if (false) {
    if (shares("turn_id")) capture.turn_completed = "native";' && run 'M37: Codex の turn 規則を捨てる'
mutate $VERIFY '["internalRunMarker", manifest.internalRunMarker === true],' '["internalRunMarker", manifest.internalRunMarker === f.rig.internalRunMarker],' && run 'M38: internalRunMarker を fixture との一致で見る'
mutate $IMPORT 'die("the CLI printed more than one line for --version");' 'void 0;' && run 'M39: 複数行の CLI 版を黙って受け取る'
mutate $SCHEMA '            "then": {
              "required": [
                "manifestHash"
              ]
            }' '            "then": {
              "required": [
                "path"
              ]
            }' && run 'M40: manifest 対の要求を別の欄へ向ける'
mutate $ASSEMBLE 'const SECRET_WINDOW = 16;' 'const SECRET_WINDOW = 4096;' && run 'M41: 警報の窓を実質無効な幅へ広げる'
mutate $ASSEMBLE 'for (const c of f.limitationCodes ?? []) fixtureLimitations.push(`[${f.fixtureId}] ${c}`);' 'for (const c of f.limitations ?? []) fixtureLimitations.push(`[${f.fixtureId}] ${c}`);' && run 'M42: 散文の limitations を成果物へ転記する'
mutate $SCHEMA '          "assistant-completion-synthesized-from-stop",
          "codex-home-in-tmp-warns",' '          "assistant-completion-synthesized-from-stop",
          "nope",
          "codex-home-in-tmp-warns",' && run 'M43: 限界コードの enum を緩める'
mutate $SCHEMA '  "title": "CaptureFixture",' '  "title": "CaptureFixture",
  "maxProperties": 500,' && run 'M44: validate.ts が解釈しない keyword を足す'
mutate $VERIFY '    const captureRawHash = digestRaw(bytes);' '    const captureRawHash = ref.captureRawHash;' && run 'M45: 生 byte の digest を申告値で代用する'
mutate $VERIFY '  if (digestRaw(bytes) !== ref.manifestHash) {' '  if (false) {' && run 'M46: manifest を parse する前の照合を外す'
mutate $ASSEMBLE '    if (!derivable || refs.length === 0) {' '    if (!derivable) throw new Error("underivable claim");
    if (refs.length === 0) {' && run 'M47: 導けない主張で組み立てを落とす'
mutate $NORMALIZE 'realRoot = realpathSync(root ?? defaultEvidenceRoot(cli));' 'realRoot = realpathSync(defaultEvidenceRoot(cli));' && run 'M48: root の差し替え口を無視する'
mutate $ASSEMBLE '  const assembled = assembleFromFixtures(fixtures);' '  const assembled = assembleFromFixtures(fixtures, { evidenceRoot: process.env.EVIDENCE_ROOT });' && run 'M49: 組み立ての入口で root を環境変数から取る'
mutate $ASSEMBLE '  for (const issue of validateAgainstSchema(data, SCHEMA, SCHEMA)) {' '  for (const issue of validateAgainstSchema(data.observedEvents ?? [], SCHEMA.properties?.observedEvents, SCHEMA, "observedEvents")) {' && run 'M50: fixture 全体ではなく欄を選んで検査する'
mutate $NORMALIZE '    if (typeof value === "string" && value !== "") {' '    if (typeof value === "string") {' && run 'M60: 空文字にも相関 token を振る'
mutate $VERIFY '  } else if (shares("prompt_id") && !lines.some((l) => tokenOf(l, "turn_id") !== undefined)) {' '  } else if (shares("prompt_id") && !lines.some((l) => has(l, "turn_id"))) {' && run 'M59: turn_id の在不在を伏せ字の綴りで見る'
mutate $VERIFY 'const has = (line: NormalizedLine, key: string): boolean => line.payload[key] === "<string>";' 'const has = (line: NormalizedLine, key: string): boolean => Object.hasOwn(line.payload, key);' && run 'M56: 欄の有無を型を見ずに判定する'
mutate $ASSEMBLE '    canonicalizeJson(evidenceSources),' '    canonicalizeJson(evidenceSources.map((e) => [e.fixtureId, e.path, e.evidenceHash])),' && run 'M57: hash の入力で欄を数え上げる'
mutate $ASSEMBLE '    if (!data.fixtureId.startsWith(`${data.cli}/`)) errs.push("fixtureId must be prefixed with its own cli");' '    if (!data.fixtureId.startsWith(`${data.cli}/`)) errs.push(`fixtureId must be prefixed with ${data.fixtureId}`);' && run 'M58: 診断へ fixture の生値を混ぜる'
mutate $VERIFY '  return typeof v === "string" && CORRELATION_TOKEN.test(v) ? v : undefined;' '  return typeof v === "string" ? v : undefined;' && run 'M53: 伏せ字の綴りを相関 token として受け取る'
mutate $VERIFY '    if (seenPaths.has(ref.path)) reject(f.fixtureId, `evidence names ${ref.path} more than once`);' '    if (false) reject(f.fixtureId, `evidence names ${ref.path} more than once`);' && run 'M54: 同じ記録の重複を通す'
mutate $ASSEMBLE '    if (!data.fixtureId.startsWith(`${data.cli}/`)) errs.push("fixtureId must be prefixed with its own cli");' '    if (false) errs.push("fixtureId must be prefixed with its own cli");' && run 'M55: fixtureId の帰属を確かめない'
mutate $ASSEMBLE '    if (typeof value === "string" && !isRealInstant(value)) {' '    if (false) {' && run 'M52: 暦の検査を外す'
mutate $VERIFY '  if (sessionTokens.length >= 2 && new Set(sessionTokens).size === 1 && sessionTokens[0] !== undefined) {' '  if (new Set(sessionTokens.filter((t) => t !== undefined)).size === 1) {' && run 'M51: 欄の無い行を除いてから安定性を見る'
mutate $VERIFY '    ["capturedAt", manifest.capturedAt === computed.capturedAt],' '    ["capturedAt", manifest.capturedAt === f.capturedAt],' && run 'M61: 記録の時刻を fixture 単位で縛る'
mutate $VERIFY '    const capturedAt = captureCapturedAt(bytes);' '    const capturedAt = (ref as unknown as { capturedAt: string }).capturedAt ?? f.capturedAt;' && run 'M62: 時刻を記録から導かず申告から取る'
mutate $ASSEMBLE '      (r) => r.manifestBacked && claimedEvents.every((n) => r.events.includes(n)),' '      (r) => r.manifestBacked,' && run 'M63: 申告 hook 名を持たない記録で昇格させる'
mutate $ASSEMBLE '        verifiedAt: promotion.verifiedAt ?? f.capturedAt,' '        verifiedAt: f.capturedAt,' && run 'M64: 公開する時刻を fixture の申告から取る'
mutate $ASSEMBLE '    return x >= y ? a : b;' '    return a > b ? a : b;' && run 'M67: 遅いほうの判定を文字列比較へ戻す'
mutate $FIXTURE '      "normalizationVersion": 1' '      "normalizationVersion": 1,
      "manifest": "anything.json",
      "manifestHash": "0000000000000000000000000000000000000000000000000000000000000000"' && run 'M66: 出荷 fixture から manifest を名指しする'
mutate $SCHEMAV '    issues.push({ path, message: "value not in enum" });' '    issues.push({ path, message: `value not in enum: ${JSON.stringify(value)}` });' && run 'M65: 棄却した値を診断へ戻す'
mutate "$HASHES" '"schema/capability.schema.json"' '"schema/capability.schema.json.moved"' \
  && run_custom 'M25: 契約 hash の入力名を書き換える' check_hashes

echo "--- 復元後 ---"
# 目視で終わらせない。`node ... | grep` は grep の終了状態を返すので、件数を取り出して 0 でなければ落とす
BASELINE=$(node --experimental-strip-types --test "${TESTS[@]}" 2>&1)
printf '%s\n' "$BASELINE" | grep -E '^ℹ (pass|fail) '
BASELINE_FAIL=$(printf '%s' "$BASELINE" | grep -E '^ℹ fail ' | tail -1 | grep -oE '[0-9]+$')
if [ -z "$BASELINE_FAIL" ] || [ "$BASELINE_FAIL" -ne 0 ]; then
  echo "変異テスト失敗: 復元後の baseline が green でない（変異が残ったか test が壊れている）" >&2
  exit 1
fi

echo "--- 集計 ---"
EXPECTED=$(grep -cE "&& run(_custom)? 'M[0-9]+b?:" "$0")
printf '実行 %d / 期待 %d、生存 %d\n' "$EXECUTED" "$EXPECTED" "$SURVIVED"
if [ "$EXECUTED" -ne "$EXPECTED" ] || [ "$SURVIVED" -ne 0 ]; then
  echo "変異テスト失敗: 生存した変異か、黙って飛ばされた変異がある" >&2
  exit 1
fi
