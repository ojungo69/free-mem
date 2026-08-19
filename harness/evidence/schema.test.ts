// schema 側の検査を固定する。手書き検証との drift 防止で assemble.ts が schema へ委譲している
// 欄（evidence / highLevel / limitationCodes / observedEvents / scenarioId）は、schema を緩めた
// だけで matrix の cell に載る値の制約が消える。unit test は schema ファイルには届かないので
// （config-fix-needs-its-own-mutation）、schema そのものを対象にした test をここに置く。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateFixture } from "../assemble.ts";
import { SUPPORTED_KEYWORDS, validateAgainstSchema } from "../schema/validate.ts";
import { fixtureBase } from "./synthetic.ts";

const HEX = "a".repeat(64);
// ref が持つのは manifest 本体ではなく置き場からの相対 path。読むのは verify 側
const MANIFEST_PATH = "claude-lifecycle-basic.manifest.json";
const readSchema = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8"));

const ref = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: "claude-lifecycle-basic.jsonl",
  evidenceHash: HEX,
  captureRawHash: HEX,
  normalizationVersion: 1,
  ...extra,
});

// schema の「どこが schema 位置か」は容器キーワードで決まる。値が任意名の器
// （properties / $defs / patternProperties）とそれ以外を分けないと、property 名を
// keyword と読んで偽陽性になる。
const NAMED_SCHEMA_MAPS = new Set(["properties", "$defs", "patternProperties"]);
const SCHEMA_VALUES = new Set(["items", "additionalProperties", "not", "if", "then", "else", "contains"]);
const SCHEMA_LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function collectKeywords(node: unknown, out: Set<string>): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out.add(key);
    if (NAMED_SCHEMA_MAPS.has(key)) {
      for (const child of Object.values(value as Record<string, unknown>)) collectKeywords(child, out);
    } else if (SCHEMA_VALUES.has(key)) {
      collectKeywords(value, out);
    } else if (SCHEMA_LISTS.has(key)) {
      for (const child of value as unknown[]) collectKeywords(child, out);
    }
  }
}

test("capability schema uses only supported keywords", () => {
  const found = new Set<string>();
  for (const name of ["capability.schema.json", "evidence-manifest.schema.json"]) {
    collectKeywords(readSchema(name), found);
  }
  // 走査自体が空振りしていないことを先に見る（歩き方を壊すと全件 pass になる）
  assert.ok(found.size > 15, `keyword が ${found.size} 件しか集まっていない`);
  assert.ok(SUPPORTED_KEYWORDS.length > 15, "SUPPORTED_KEYWORDS の取り込みに失敗している");
  const unsupported = [...found].filter((k) => !SUPPORTED_KEYWORDS.includes(k)).sort();
  assert.deepEqual(unsupported, [], `validate.ts が解釈しない keyword: ${unsupported.join(", ")}`);
});

test("the accepted keywords cannot be widened at run time", () => {
  // export しているのは複製で、検証が見る集合は module の中にある。型の `readonly` は実行前に
  // 剥がされるので、同じ process の別 module は export された配列を書き換えられる——それでも
  // 「対応していない keyword」は落ち続ける（広がると、その keyword の制約が黙って無効になる）
  const widened = SUPPORTED_KEYWORDS as string[];
  widened.push("unevaluatedProperties");
  try {
    const schema = { type: "object", unevaluatedProperties: false };
    assert.throws(
      () => validateAgainstSchema({}, schema, schema as never),
      /unsupported schema keyword/,
      "export した一覧へ足しただけで、検証が受け付ける keyword が広がった",
    );
  } finally {
    widened.pop();
  }
});

test("fixture with evidence is rejected when the schema lacks it", () => {
  // schema の properties が KNOWN_KEYS の正本。evidence の定義を落とすと、この fixture が
  // 「unknown top-level key」で落ちるようになる
  validateFixture(fixtureBase({ evidence: [ref()] }), "f.json");
  assert.throws(() => validateFixture(fixtureBase({ bogusKey: 1 }), "f.json"), /unknown top-level key/);
});

test("manifest and manifestHash must appear together", () => {
  validateFixture(fixtureBase({ evidence: [ref({ manifest: MANIFEST_PATH, manifestHash: HEX })] }), "f.json");
  assert.throws(() => validateFixture(fixtureBase({ evidence: [ref({ manifest: MANIFEST_PATH })] }), "f.json"), /manifest/);
  assert.throws(() => validateFixture(fixtureBase({ evidence: [ref({ manifestHash: HEX })] }), "f.json"), /manifest/);
});

test("unknown limitation code is rejected", () => {
  assert.throws(() => validateFixture(fixtureBase({ limitations: ["x"], limitationCodes: ["nope"] }), "f.json"), /enum/);
  // 事象側の code は mergedLimits を通って cell の limitations に載るので、同じ検査が要る
  assert.throws(
    () =>
      validateFixture(
        fixtureBase({
          observedEvents: [
            {
              kind: "session_started",
              at: "2026-01-01T00:00:00.000Z",
              capability: "native",
              sourceEvents: ["SessionStart"],
              limitations: ["x"],
              limitationCodes: ["nope"],
            },
          ],
        }),
        "f.json",
      ),
    /enum/,
  );
});

test("empty evidence array is rejected", () => {
  assert.throws(() => validateFixture(fixtureBase({ evidence: [] }), "f.json"), /minItems|少なく|at least/);
});

test("provenance fields that reach the matrix are pattern-constrained", () => {
  // schema に pattern を書いても、検査が欄を選んで委譲していれば誰も読まない。
  // fixtureId は sourceFixtureId・evidenceSources へ、nativeVersion と capturedAt は
  // matrix と cell の verifiedAt へそのまま出るので、自由文と制御文字を通さない
  validateFixture(fixtureBase(), "f.json");
  for (const [label, override] of [
    ["制御文字入りの版", { nativeVersion: `1.0${String.fromCharCode(27)}[31m` }],
    ["絶対 path 風の fixtureId", { fixtureId: "/home/someone/secret/x" }],
    ["自由文の capturedAt", { capturedAt: "きのう" }],
    ["区切りが違う capturedAt", { capturedAt: "2026-08-12 11:00:00" }],
    ["13 月", { capturedAt: "2026-13-01T00:00:00.000Z" }],
    ["24 時", { capturedAt: "2026-08-12T24:00:00.000Z" }],
    ["60 分", { capturedAt: "2026-08-12T11:60:00.000Z" }],
    ["うるう秒", { capturedAt: "2026-08-12T11:00:60.000Z" }],
  ] as const) {
    assert.throws(() => validateFixture(fixtureBase(override), "f.json"), /does not match pattern/, label);
  }
});

test("timestamps that pass the pattern but do not exist on the calendar are rejected", () => {
  // pattern は桁数と範囲しか見ない。2 月 30 日と 4 月 31 日は綴りとしては通る
  for (const bad of ["2026-02-30T00:00:00.000Z", "2026-04-31T00:00:00.000Z", "2025-02-29T00:00:00.000Z"]) {
    assert.throws(() => validateFixture(fixtureBase({ capturedAt: bad }), "f.json"), /not a real instant/, bad);
  }
  // 事象側の at も同じ検査に載る（cell の verifiedAt へは出ないが、同じ自由文の経路）
  assert.throws(
    () =>
      validateFixture(
        fixtureBase({
          observedEvents: [
            { kind: "session_started", at: "2026-02-30T00:00:00.000Z", capability: "native", sourceEvents: ["SessionStart"] },
          ],
        }),
        "f.json",
      ),
    /not a real instant/,
  );
  // 通す側: うるう年の 2 月 29 日は実在する
  validateFixture(fixtureBase({ capturedAt: "2024-02-29T00:00:00.000Z" }), "f.json");
});
