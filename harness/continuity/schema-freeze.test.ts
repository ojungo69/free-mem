import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateContractValue, type JsonSchemaDocument } from "../schema/validate.ts";
import * as contract from "../schema/continuity.ts";

const root = JSON.parse(
  readFileSync(new URL("../schema/continuity.schema.json", import.meta.url), "utf8"),
) as JsonSchemaDocument;

const defs = root.$defs ?? {};

test("continuity.schema.json は schema 側の誤記を持たない", () => {
  // validateContractValue は root を 1 度歩いて schema 側の誤記を throw する（値は通らなくてよい）。
  // $ref から辿れない $defs も含めて検査されるので、凍結した 66 定義すべてが対象になる
  assert.doesNotThrow(() =>
    validateContractValue(Object.keys(defs)[0], undefined, root, contract.CONTINUITY_LIMITS),
  );
});

test("object の $defs はすべて closed（additionalProperties: false）", () => {
  const open = Object.entries(defs)
    .filter(([, d]) => (d as Record<string, unknown>).type === "object")
    .filter(([, d]) => (d as Record<string, unknown>).additionalProperties !== false)
    .map(([name]) => name);
  assert.deepEqual(open, []);
});

test("TS の union 定数と schema の enum が一致する", () => {
  // 型と schema の二重定義でいちばん壊れるのは「片方にだけ値を足す」。名前の対応規則は
  // 不規則（SENSITIVITIES ↔ Sensitivity 等）なので、名前ではなく値の集合そのものを突き合わせる
  const norm = (xs: readonly string[]) => JSON.stringify([...xs].sort());
  const fromTs = (Object.values(contract) as unknown[])
    .filter((v): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === "string"))
    .map(norm)
    .sort();
  const fromSchema = Object.values(defs)
    .map((d) => (d as Record<string, unknown>).enum)
    .filter((e): e is string[] => Array.isArray(e))
    .map(norm)
    .sort();
  assert.deepEqual(fromTs, fromSchema);
});
