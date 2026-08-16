/**
 * RFC 8785 JSON Canonicalization Scheme (JCS)。
 *
 * 正本 `agent-memory-final-spec-v6.md` §22.6:
 *
 * > hash/signature 対象 JSON は RFC 8785 JCS 等の標準 canonicalization を使用し、
 * > 独自 canonical JSON を実装しない。
 *
 * harness は依存ゼロで走らせる方針なので library を足せない。ここで書くのは
 * **独自形式ではなく JCS そのもの**で、Rust 側は既存の JCS 実装を使えば同じ bytes になる。
 *
 * JCS が定めるうち、この harness が扱う JSON 部分集合に効くのは次の 3 点:
 *
 * - object のキーは UTF-16 code unit の昇順（JS の `<` がそのまま code unit 比較）
 * - 配列の順序は保持する（並べ替えたいなら hash を取る前に値そのものを正規化する）
 * - 空白なし。文字列のエスケープと数値の表記は ECMAScript の `JSON.stringify` と同じ
 */

/**
 * RFC 8785 §3.2.2.2 は、対になっていない代理（lone surrogate）を含む文字列で
 * canonicalization を**中止**することを求める。`JSON.stringify` は ES2019 の
 * well-formed 化で `"\ud800"` とエスケープして返してしまうため、そのままだと
 * 「TS では hash が出るが、準拠した Rust 実装は計算を拒否する」状態になる。
 */
function encodeString(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    const isHigh = code <= 0xdbff;
    const next = isHigh ? value.charCodeAt(i + 1) : Number.NaN;
    if (isHigh && next >= 0xdc00 && next <= 0xdfff) {
      i++; // 正しい代理対
      continue;
    }
    throw new Error(`JCS: 対になっていない代理を含む文字列は canonicalize できない（位置 ${i}）`);
  }
  return JSON.stringify(value);
}

/** JCS で canonicalize した JSON 文字列を返す。undefined・NaN・関数は入力として認めない */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`JCS: 非有限の数値は表現できない: ${value}`);
    // JCS は -0 を 0 として出す。`JSON.stringify(-0)` も "0" だが意図を明示しておく
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${encodeString(k)}:${canonicalizeJson(v)}`).join(",")}}`;
  }
  throw new Error(`JCS: JSON に無い型は canonicalize できない: ${typeof value}`);
}
