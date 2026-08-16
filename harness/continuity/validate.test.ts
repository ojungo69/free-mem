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
