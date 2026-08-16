import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findNonJsonValues,
  findStructuralViolations,
  validateAgainstSchema,
  validateContractValue,
  type JsonSchemaDocument,
} from "../schema/validate.ts";

const LIMITS = { jsonDepth: 4, stringUtf8Bytes: 16, arrayItems: 3, objectKeys: 3 };

const ROOT: JsonSchemaDocument = {
  $defs: {
    IsoTimestamp: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$",
    },
    DecimalString: { type: "string", pattern: "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$" },
    Role: { type: "string", enum: ["primary", "side", "subagent"] },
    Binding: {
      type: "object",
      additionalProperties: false,
      required: ["role", "createdAt"],
      properties: {
        role: { $ref: "#/$defs/Role" },
        createdAt: { $ref: "#/$defs/IsoTimestamp" },
        score: { $ref: "#/$defs/DecimalString" },
      },
    },
    Command: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "attemptId"],
          properties: { kind: { const: "accept" }, attemptId: { type: "string" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "reason"],
          properties: { kind: { const: "dismiss" }, reason: { type: "string" } },
        },
      ],
    },
  },
};

test("未知のプロパティを拒否する（additionalProperties: false）", () => {
  const issues = validateAgainstSchema(
    { role: "primary", createdAt: "2026-08-16T00:00:00.000Z", extra: 1 },
    ROOT.$defs!.Binding,
    ROOT,
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /unknown property: extra/);
});

test("required の欠落を拒否する", () => {
  const issues = validateAgainstSchema({ role: "primary" }, ROOT.$defs!.Binding, ROOT);
  assert.match(issues[0].message, /missing required property: createdAt/);
});

test("enum 外の値を拒否する", () => {
  const issues = validateAgainstSchema(
    { role: "owner", createdAt: "2026-08-16T00:00:00.000Z" },
    ROOT.$defs!.Binding,
    ROOT,
  );
  assert.match(issues[0].message, /not in enum/);
});

test("ISO timestamp でない文字列を拒否する", () => {
  for (const bad of ["2026-08-16", "2026-08-16 00:00:00Z", "2026-08-16T00:00:00+09:00", ""]) {
    const issues = validateAgainstSchema(
      { role: "primary", createdAt: bad },
      ROOT.$defs!.Binding,
      ROOT,
    );
    assert.ok(issues.length > 0, `accepted bad timestamp: ${bad}`);
  }
  const ok = validateAgainstSchema(
    { role: "primary", createdAt: "2026-08-16T00:00:00Z" },
    ROOT.$defs!.Binding,
    ROOT,
  );
  assert.deepEqual(ok, []);
});

test("decimal string でない score を拒否する（数値も拒否する）", () => {
  for (const bad of ["1.", ".5", "01", "1e3", "abc"]) {
    const issues = validateAgainstSchema(
      { role: "side", createdAt: "2026-08-16T00:00:00Z", score: bad },
      ROOT.$defs!.Binding,
      ROOT,
    );
    assert.ok(issues.length > 0, `accepted bad decimal: ${bad}`);
  }
  const numeric = validateAgainstSchema(
    { role: "side", createdAt: "2026-08-16T00:00:00Z", score: 0.5 },
    ROOT.$defs!.Binding,
    ROOT,
  );
  assert.match(numeric[0].message, /expected type string/);
});

test("discriminated union はちょうど 1 variant に一致しなければならない", () => {
  assert.deepEqual(validateAgainstSchema({ kind: "accept", attemptId: "a1" }, ROOT.$defs!.Command, ROOT), []);
  const wrongShape = validateAgainstSchema({ kind: "accept", reason: "x" }, ROOT.$defs!.Command, ROOT);
  assert.match(wrongShape[0].message, /expected exactly 1 oneOf match, got 0/);
});

test("未対応の schema キーワードは黙って無視せずエラーにする", () => {
  const issues = validateAgainstSchema("x", { type: "string", multipleOf: 2 }, ROOT);
  assert.match(issues[0].message, /unsupported schema keyword: multipleOf/);
});

test("dangling $ref は例外にする", () => {
  assert.throws(() => validateAgainstSchema({}, { $ref: "#/$defs/Nope" }, ROOT), /dangling \$ref/);
});

test("JSON にできない値を拒否する", () => {
  assert.match(findNonJsonValues({ a: undefined })[0].message, /non-JSON value of type undefined/);
  assert.match(findNonJsonValues({ a: Number.NaN })[0].message, /non-finite number/);
  assert.match(findNonJsonValues({ a: () => 1 })[0].message, /non-JSON value of type function/);
  assert.match(findNonJsonValues({ a: 1n })[0].message, /non-JSON value of type bigint/);
  assert.match(findNonJsonValues({ a: new Date() })[0].message, /unsupported object type/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.match(findNonJsonValues(cyclic)[0].message, /circular reference/);
  assert.deepEqual(findNonJsonValues({ a: [1, "x", null, { b: true }] }), []);
});

test("構造上限（深さ・文字列バイト・要素数・キー数）を拒否する", () => {
  assert.match(
    findStructuralViolations({ a: { b: { c: { d: 1 } } } }, LIMITS)[0].message,
    /exceeds jsonDepth/,
  );
  assert.match(findStructuralViolations({ s: "あ".repeat(6) }, LIMITS)[0].message, /exceeds stringUtf8Bytes/);
  assert.match(findStructuralViolations({ a: [1, 2, 3, 4] }, LIMITS)[0].message, /exceeds arrayItems/);
  assert.match(findStructuralViolations({ a: 1, b: 2, c: 3, d: 4 }, LIMITS)[0].message, /exceeds objectKeys/);
  assert.deepEqual(findStructuralViolations({ a: ["ok"] }, LIMITS), []);
});

test("validateContractValue は JSON 妥当性を schema より先に見る", () => {
  const issues = validateContractValue("Binding", { role: undefined }, ROOT, LIMITS);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /non-JSON value/);
});

test("validateContractValue は未知の $defs 名を拒否する", () => {
  const issues = validateContractValue("Nope", {}, ROOT, LIMITS);
  assert.match(issues[0].message, /unknown \$defs entry: Nope/);
});

test("validateContractValue は schema 通過後に構造上限も見る", () => {
  const issues = validateContractValue(
    "Binding",
    { role: "primary", createdAt: "2026-08-16T00:00:00.000Z" },
    ROOT,
    { ...LIMITS, stringUtf8Bytes: 4 },
  );
  assert.ok(issues.some((i) => /exceeds stringUtf8Bytes/.test(i.message)));
});

// --- プロトタイプ経由のキーを実データと取り違えない（PR #18 レビュー指摘） ---

test("required は継承プロパティを「有る」と数えない", () => {
  const schema = { type: "object", required: ["constructor"], properties: {} };
  const issues = validateAgainstSchema({}, schema, ROOT);
  assert.ok(issues.some((i) => /missing required property: constructor/.test(i.message)));
});

test("properties に無い継承名のキーは additionalProperties: false で弾かれる", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { role: { $ref: "#/$defs/Role" } },
  };
  for (const key of ["constructor", "toString", "hasOwnProperty"]) {
    const issues = validateAgainstSchema({ [key]: 1 }, schema, ROOT);
    assert.ok(issues.some((i) => i.message === `unknown property: ${key}`), key);
  }
});

test("$defs に無い継承名は $ref でも contract 名でも解決されない", () => {
  assert.throws(
    () => validateAgainstSchema({}, { $ref: "#/$defs/__proto__" }, ROOT),
    /dangling \$ref/,
  );
  const issues = validateContractValue("toString", { any: "thing" }, ROOT, LIMITS);
  assert.match(issues[0].message, /unknown \$defs entry: toString/);
});

test("format は未対応キーワードとして拒否する（黙って無視しない）", () => {
  const issues = validateAgainstSchema("not-a-date", { type: "string", format: "date-time" }, ROOT);
  assert.ok(issues.some((i) => i.message === "unsupported schema keyword: format"));
});

test("$ref に併記した兄弟キーワードも評価する（draft 2020-12）", () => {
  const schema = { $ref: "#/$defs/Role", enum: ["primary"] };
  assert.deepEqual(validateAgainstSchema("primary", schema, ROOT), []);
  // $ref は通るが enum で落ちる: 早期 return だと素通りしていた
  const issues = validateAgainstSchema("side", schema, ROOT);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /value not in enum/);
  // $ref 側で落ちる場合も両方報告する
  assert.ok(validateAgainstSchema(1, schema, ROOT).some((i) => /expected type string/.test(i.message)));
});

// --- /code-review の指摘（PR #18）で塞いだ穴の回帰テスト ---

test("__proto__ という名前のデータキーも additionalProperties: false で弾かれる", () => {
  const schema = { type: "object", additionalProperties: false, properties: { role: { type: "string" } } };
  const value = JSON.parse('{"role":"primary","__proto__":{"smuggled":"payload"}}');
  const issues = validateAgainstSchema(value, schema, ROOT);
  assert.ok(issues.some((i) => i.message === "unknown property: __proto__"));
});

test("循環 $ref はスタックオーバーフローでなく診断可能なエラーにする", () => {
  const root: JsonSchemaDocument = { $defs: { Loop: { $ref: "#/$defs/Loop" } } };
  assert.throws(() => validateAgainstSchema("x", { $ref: "#/$defs/Loop" }, root), /circular \$ref/);
});

test("NaN は minimum/maximum を素通りしない", () => {
  const issues = validateAgainstSchema(NaN, { type: "number", minimum: 0, maximum: 1 }, ROOT);
  assert.ok(issues.some((i) => /non-finite number/.test(i.message)));
  assert.deepEqual(validateAgainstSchema(0.5, { type: "number", minimum: 0, maximum: 1 }, ROOT), []);
});

test("const / enum の比較はキー順に依存しない", () => {
  assert.deepEqual(validateAgainstSchema({ b: 2, a: 1 }, { const: { a: 1, b: 2 } }, ROOT), []);
  assert.equal(validateAgainstSchema({ a: 1 }, { const: { a: 1, b: 2 } }, ROOT).length, 1);
  assert.deepEqual(validateAgainstSchema({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }, ROOT), []);
});

test("if / then / else を評価する", () => {
  const schema = {
    type: "object",
    properties: { capability: { type: "string" }, sourceEvents: { type: "array" } },
    if: { required: ["capability"], properties: { capability: { const: "synthesized" } } },
    then: { required: ["sourceEvents"], properties: { sourceEvents: { minItems: 1 } } },
    else: { required: ["capability"] },
  };
  // if 成立 → then が効く
  assert.ok(
    validateAgainstSchema({ capability: "synthesized" }, schema, ROOT).some((i) =>
      /missing required property: sourceEvents/.test(i.message),
    ),
  );
  assert.deepEqual(
    validateAgainstSchema({ capability: "synthesized", sourceEvents: ["x"] }, schema, ROOT),
    [],
  );
  // if 不成立 → else が効く。if 自体の不一致は issue にしない
  assert.ok(validateAgainstSchema({}, schema, ROOT).some((i) => /missing required property: capability/.test(i.message)));
});

test("sparse array の hole を JSON 妥当性検査で見逃さない", () => {
  // JSON.stringify は hole を null にするため「検証した形」と「保存する形」がずれる
  const issues = findNonJsonValues([1, , 3]);
  assert.ok(issues.some((i) => /non-JSON value of type undefined/.test(i.message)));
});
