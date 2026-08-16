// JSON Schema (draft 2020-12) の必要な部分だけを解釈する検証器。
//
// なぜ ajv を使わないか: harness は依存ゼロで動く前提（`node --experimental-strip-types` だけで
// 実行する）。加えて jsonDepth / objectKeys のような「文書全体の構造上限」は JSON Schema の
// 語彙では表現できず、どのみち独自に歩く必要がある。
//
// 対応キーワード: $ref, type, enum, const, required, properties, additionalProperties,
// items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum,
// oneOf, anyOf, allOf, if/then/else。これ以外が schema に現れたら「未対応」として
// *エラーにする*（黙って無視すると、書いたつもりの制約が効いていないことに気付けない）。
//
// schema 自体の書き間違い（dangling / 循環 $ref、不正な pattern）は issue ではなく throw する。
// データの不正とは層が違い、握り潰すと「制約が無いのに妥当」と誤認するため。
//
// ponytail: 自前実装の天井は「draft 2020-12 の一部しか解釈しない」こと。対応キーワードを
// 増やし続けるくらいなら ajv へ移す（vendor/codemem の lockfile に既に解決済みで、
// harness/phase1-static-scan.ts が vendor の node_modules を相対 import する前例もある）。
// 移さない理由は、ajv が vendor の推移的依存でしかなく vendor 更新で消え得ること、
// jsonDepth / stringUtf8Bytes などの構造上限は JSON Schema の語彙で表現できずどのみち
// 自前で歩く必要があること、ADR-003 G7 が harness の runtime 非依存を要求していること。

import { isDeepStrictEqual } from "node:util";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface JsonSchemaDocument {
  $defs?: Record<string, unknown>;
  [key: string]: unknown;
}

const SUPPORTED_KEYWORDS = new Set([
  "$ref",
  "$schema",
  "$id",
  "$defs",
  "$comment",
  "title",
  "description",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "oneOf",
  "anyOf",
  "allOf",
  "if",
  "then",
  "else",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * プロトタイプ経由のキーを実データと取り違えないための own-key 判定。
 * `"constructor" in {}` は true になるため、`in` で書くと required が素通りし、
 * schema.properties の探索が `Object.prototype` の関数を schema として拾ってしまう。
 */
function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** `{}` か `Object.create(null)` 由来のものだけを data object とみなす。 */
function isDataObject(v: unknown): v is Record<string, unknown> {
  if (!isPlainObject(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(actual: string, expected: string): boolean {
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function resolveRef(ref: string, root: JsonSchemaDocument): unknown {
  const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m) throw new Error(`unsupported $ref form: ${ref}`);
  const defs = root.$defs;
  // `#/$defs/__proto__` は `?.[]` だと Object.prototype を拾い、制約ゼロの schema として通ってしまう
  if (!isPlainObject(defs) || !own(defs, m[1])) throw new Error(`dangling $ref: ${ref}`);
  return defs[m[1]];
}

/** JSON として表現できない値（undefined / NaN / Infinity / function / symbol / bigint / 循環）を弾く。 */
export function findNonJsonValues(value: unknown, path = "$", seen = new Set<object>()): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const t = typeof value;
  if (value === null || t === "string" || t === "boolean") return issues;
  if (t === "number") {
    if (!Number.isFinite(value as number)) issues.push({ path, message: `non-finite number: ${String(value)}` });
    return issues;
  }
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
    issues.push({ path, message: `non-JSON value of type ${t}` });
    return issues;
  }
  const obj = value as object;
  if (seen.has(obj)) {
    issues.push({ path, message: "circular reference" });
    return issues;
  }
  seen.add(obj);
  if (Array.isArray(value)) {
    // forEach は hole を飛ばすが JSON.stringify は null にする。ずれを見逃さないよう添字で歩く
    for (let i = 0; i < value.length; i++) {
      issues.push(...findNonJsonValues(value[i], `${path}[${i}]`, seen));
    }
  } else if (isDataObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      issues.push(...findNonJsonValues(v, `${path}.${k}`, seen));
    }
  } else {
    // Date / Map / class instance など。toJSON で通ってしまう型を素通しすると
    // 「保存した形」と「検証した形」がずれるため、素の data object 以外は拒否する
    issues.push({ path, message: `unsupported object type: ${Object.prototype.toString.call(value)}` });
  }
  seen.delete(obj);
  return issues;
}

export interface StructuralLimits {
  jsonDepth: number;
  stringUtf8Bytes: number;
  arrayItems: number;
  objectKeys: number;
}

/** 文書全体の構造上限。JSON Schema では表現できないので値を直接歩く。 */
export function findStructuralViolations(
  value: unknown,
  limits: StructuralLimits,
  path = "$",
  depth = 1,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (depth > limits.jsonDepth) {
    issues.push({ path, message: `depth ${depth} exceeds jsonDepth ${limits.jsonDepth}` });
    return issues;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > limits.stringUtf8Bytes) {
      issues.push({ path, message: `string ${bytes}B exceeds stringUtf8Bytes ${limits.stringUtf8Bytes}` });
    }
    return issues;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.arrayItems) {
      issues.push({ path, message: `array of ${value.length} exceeds arrayItems ${limits.arrayItems}` });
    }
    for (let i = 0; i < value.length; i++) {
      issues.push(...findStructuralViolations(value[i], limits, `${path}[${i}]`, depth + 1));
    }
    return issues;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > limits.objectKeys) {
      issues.push({ path, message: `object with ${keys.length} keys exceeds objectKeys ${limits.objectKeys}` });
    }
    for (const k of keys) {
      issues.push(...findStructuralViolations(value[k], limits, `${path}.${k}`, depth + 1));
    }
  }
  return issues;
}

export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  root: JsonSchemaDocument,
  path = "$",
  refStack: readonly string[] = [],
): ValidationIssue[] {
  if (schema === true) return [];
  if (schema === false) return [{ path, message: "schema is false (nothing is valid here)" }];
  if (!isPlainObject(schema)) return [{ path, message: "schema must be an object or boolean" }];

  const issues: ValidationIssue[] = [];

  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      issues.push({ path, message: `unsupported schema keyword: ${key}` });
    }
  }

  // draft 2020-12 では $ref に兄弟キーワードを併記できる（`{$ref, maxLength}` など）。
  // ここで return すると併記した制約が黙って落ちるので、参照先を検査してから残りも続ける
  if (typeof schema.$ref === "string") {
    // 自己参照 schema はスタックオーバーフローになる。この検証器は再帰型を扱わないので
    // 「未対応の schema」として診断可能なエラーにする
    if (refStack.includes(schema.$ref)) {
      throw new Error(`circular $ref: ${[...refStack, schema.$ref].join(" -> ")}`);
    }
    issues.push(
      ...validateAgainstSchema(value, resolveRef(schema.$ref, root), root, path, [...refStack, schema.$ref]),
    );
  }

  const actual = typeOf(value);

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!expected.some((t) => typeMatches(actual, t))) {
      issues.push({ path, message: `expected type ${expected.join("|")}, got ${actual}` });
      return issues; // 型が違う時点で以降の制約は意味を成さない
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => isDeepStrictEqual(e, value))) {
    issues.push({ path, message: `value not in enum: ${JSON.stringify(value)}` });
  }
  if (own(schema, "const") && !isDeepStrictEqual(schema.const, value)) {
    issues.push({ path, message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
  }

  if (typeof value === "number") {
    // NaN は < も > も false になるため、先に弾かないと minimum/maximum を素通りする
    if (!Number.isFinite(value)) {
      issues.push({ path, message: `non-finite number: ${String(value)}` });
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `number below minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `number above maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push({ path, message: `array longer than maxItems ${schema.maxItems}` });
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) =>
        issues.push(...validateAgainstSchema(item, schema.items, root, `${path}[${i}]`, refStack)),
      );
    }
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!own(value, req)) issues.push({ path, message: `missing required property: ${req}` });
    }
    for (const [k, v] of Object.entries(value)) {
      if (own(props, k)) {
        issues.push(...validateAgainstSchema(v, props[k], root, `${path}.${k}`, refStack));
      } else if (schema.additionalProperties === false) {
        issues.push({ path, message: `unknown property: ${k}` });
      } else if (schema.additionalProperties !== undefined) {
        issues.push(...validateAgainstSchema(v, schema.additionalProperties, root, `${path}.${k}`, refStack));
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) issues.push(...validateAgainstSchema(value, sub, root, path, refStack));
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((sub) => validateAgainstSchema(value, sub, root, path, refStack).length === 0);
    if (!ok) issues.push({ path, message: "value matches none of anyOf" });
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(
      (sub) => validateAgainstSchema(value, sub, root, path, refStack).length === 0,
    );
    if (matched.length !== 1) {
      issues.push({ path, message: `expected exactly 1 oneOf match, got ${matched.length}` });
    }
  }

  // if/then/else: capability.schema.json §7.2（synthesized なら sourceEvents 必須）が使う。
  // `if` は「合致するか」の判定にだけ使い、その issue 自体は結果に混ぜない
  if (schema.if !== undefined) {
    const branch =
      validateAgainstSchema(value, schema.if, root, path, refStack).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) {
      issues.push(...validateAgainstSchema(value, branch, root, path, refStack));
    }
  }

  return issues;
}

/** `$defs` の 1 つを名前で選び、JSON 妥当性・schema・構造上限をこの順で検査する。 */
export function validateContractValue(
  defName: string,
  value: unknown,
  root: JsonSchemaDocument,
  limits: StructuralLimits,
): ValidationIssue[] {
  const nonJson = findNonJsonValues(value);
  if (nonJson.length > 0) return nonJson;
  const defs = root.$defs;
  if (!isPlainObject(defs) || !own(defs, defName)) {
    return [{ path: "$", message: `unknown $defs entry: ${defName}` }];
  }
  const def = defs[defName];
  return [
    ...validateAgainstSchema(value, def, root, "$"),
    ...findStructuralViolations(value, limits),
  ];
}
