import { readFileSync } from "node:fs";

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
function encodeString(value: string, where: string): string {
  assertIJsonString(value, where);
  return JSON.stringify(value);
}

/**
 * I-JSON は UTF-8 を必須にする（RFC 7493 §2.1）。Node の `readFileSync(path, "utf8")` は
 * 不正な byte 列を U+FFFD に**置換**して返すので、壊れたファイルでも TS 側は hash を出し、
 * 厳格な decoder を持つ実装は同じ bytes を拒否する。復号の段で落とす。
 */
export function decodeUtf8(bytes: Uint8Array, where: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`I-JSON: ${where} が UTF-8 として不正（置換文字で読み替えない）`);
  }
}

/**
 * RFC 8785 §3.1 は canonicalize する入力を I-JSON（RFC 7493）に限る。RFC 7493 §2.3 は
 * object の重複 property 名を禁じるが、`JSON.parse` は**後勝ちで黙って潰す**。潰れた後の
 * 値は canonicalize できてしまうので、TS 側は hash を出し、準拠した実装は同じファイルを
 * 拒否する、という食い違いが残る。契約 JSON はここを通して読む。
 */
export function parseIJson<T = unknown>(text: string): T {
  const value = JSON.parse(text) as T;
  assertNoDuplicateKeys(text);
  assertIJsonStrings(value, "$");
  return value;
}

/** 契約ファイルを I-JSON として読む。UTF-8 の復号・重複キー・Unicode 制約をまとめて見る */
export function readIJsonFile<T = unknown>(url: URL | string): T {
  return parseIJson<T>(decodeUtf8(readFileSync(url), String(url)));
}

/**
 * RFC 7493 §2.1:
 *
 * > Object member names, and string values in arrays and object members, MUST NOT include
 * > code points that identify Surrogates or Noncharacters as defined by [UNICODE].
 *
 * 直接書いてもエスケープしても同じ扱いで、`"\uDEAD"` は不正・`"𐊭"` は正当。
 * `JSON.parse` はどちらも通すので、読んだ後に見る。`canonicalizeJson` 側の検査
 * （JCS §3.2.2.2）は代理だけが対象で noncharacter は見ないため、ここが I-JSON の担当。
 */
function assertIJsonString(value: string, where: string): void {
  // 不対代理の検出は ES2024 の `isWellFormed` そのもの（JCS §3.2.2.2 が中止を求める形）
  if (!value.isWellFormed()) {
    throw new Error(`I-JSON: ${where} に対になっていない代理が入っている`);
  }
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp & 0xfffe) === 0xfffe || (cp >= 0xfdd0 && cp <= 0xfdef)) {
      throw new Error(`I-JSON: ${where} に noncharacter が入っている: U+${hex(cp)}`);
    }
  }
}

function hex(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, "0");
}

function assertIJsonStrings(value: unknown, path: string): void {
  if (typeof value === "string") {
    assertIJsonString(value, path);
    return;
  }
  // RFC 7493 §2.2 は binary64 で表せない数（例として `1E400` を挙げている）を SHOULD NOT と
  // している。`JSON.parse("1e400")` は Infinity になり、そこから先の比較も hash も意味を
  // 失うので、契約ファイルとしては受け取らない
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`I-JSON: ${path} の数値が binary64 で表せない: ${value}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertIJsonStrings(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assertIJsonString(key, `${path} のキー ${JSON.stringify(key)}`);
    assertIJsonStrings(child, `${path}.${key}`);
  }
}

/**
 * `JSON.parse` が構文を検査した後の生テキストを走査して、同じ object 内の重複キーを見つける。
 * 構文の妥当性は前段で保証済みなので、文字列の範囲と object/array の入れ子だけ追えばよい。
 */
function assertNoDuplicateKeys(text: string): void {
  const stack: (Set<string> | null)[] = []; // object なら見たキーの集合、array なら null
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      stack.push(new Set());
      expectKey = true;
      continue;
    }
    if (ch === "[") {
      stack.push(null);
      expectKey = false;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      expectKey = false;
      continue;
    }
    if (ch === ",") {
      expectKey = stack[stack.length - 1] instanceof Set;
      continue;
    }
    if (ch !== '"') continue;
    const start = i;
    for (i++; i < text.length && text[i] !== '"'; i += text[i] === "\\" ? 2 : 1);
    const seen = stack[stack.length - 1];
    if (!expectKey || !(seen instanceof Set)) continue; // 値の側の文字列
    expectKey = false;
    // エスケープを解いてから比べる。`"\u0061b"` と `"ab"` は同じ property 名
    const key = JSON.parse(text.slice(start, i + 1)) as string;
    if (seen.has(key)) {
      throw new Error(
        `I-JSON: object の property 名が重複している: ${JSON.stringify(key)}（位置 ${start}）`,
      );
    }
    seen.add(key);
  }
}

/**
 * 配列の own key を `length` と 0..length-1 の添字だけに限る。件数だけ数えると、穴の分だけ
 * 空いた枠に別の key（`a.meta`・`Symbol.iterator`）が収まって素通りする。
 */
function assertPlainArray(value: unknown[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const index = typeof key === "string" ? Number(key) : Number.NaN;
    if (!Number.isInteger(index) || String(index) !== key || index < 0 || index >= value.length) {
      throw new Error(
        `JCS: 添字と length 以外の own key を持つ配列は canonicalize できない: ${String(key)}`,
      );
    }
  }
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor) {
      throw new Error(`JCS: 穴のある配列は canonicalize できない（位置 ${i}）`);
    }
    // object 側と同じ理由。添字の getter も読むたびに違う値を返せる
    if (!("value" in descriptor)) {
      throw new Error(`JCS: getter/setter を持つ配列は canonicalize できない（位置 ${i}）`);
    }
  }
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
  if (typeof value === "string") return encodeString(value, "文字列");
  if (Array.isArray(value)) {
    assertPlainArray(value);
    // 添字で回す。`Array.from` や `map` は呼び出し側が差し替えた `Symbol.iterator` を
    // 使ってしまい、実在しない要素の bytes を出せる
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) items.push(canonicalizeJson(value[i]));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    // Date・Map・class instance は enumerable な own property を持たないので、そのまま
    // 通すと `{}` の bytes が出る。値と無関係な hash が出るくらいなら落とす
    // （`validate.ts` の isDataObject と同じ判定）
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `JCS: 素の object でない値は canonicalize できない: ${value.constructor?.name ?? "不明"}`,
      );
    }
    // `Object.entries` は symbol キーと非 enumerable な own property を黙って飛ばすので、
    // それらを持つ object は「空の object」として hash されてしまう
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      throw new Error("JCS: symbol キーまたは非 enumerable な property を持つ object は canonicalize できない");
    }
    // getter は `Object.entries` が呼び出す。副作用や呼ぶたび変わる値があると、同じ object から
    // 違う bytes が出る（hash が決定的でなくなる）
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor)) {
        throw new Error(`JCS: getter/setter を持つ object は canonicalize できない: ${key}`);
      }
    }
    // `JSON.stringify` は undefined の property を黙って落とすが、ここでは落とさない。
    // 落とすと `{ a: 1, b: undefined }` が `{ a: 1 }` と同じ hash になり、組み立て損ねた
    // 契約値が「その欄は元々無かった」ものとして通ってしまう。undefined は下で throw する
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${encodeString(k, `キー ${JSON.stringify(k)}`)}:${canonicalizeJson(v)}`).join(",")}}`;
  }
  throw new Error(`JCS: JSON に無い型は canonicalize できない: ${typeof value}`);
}
