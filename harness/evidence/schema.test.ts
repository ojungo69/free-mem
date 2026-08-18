// schema 側の検査を固定する。手書き検証との drift 防止で assemble.ts が schema へ委譲している
// 欄（evidence / highLevel / limitationCodes / observedEvents / scenarioId）は、schema を緩めた
// だけで matrix の cell に載る値の制約が消える。unit test は schema ファイルには届かないので
// （config-fix-needs-its-own-mutation）、schema そのものを対象にした test をここに置く。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateFixture } from "../assemble.ts";
import { SUPPORTED_KEYWORDS } from "../schema/validate.ts";
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
  assert.ok(SUPPORTED_KEYWORDS.size > 15, "SUPPORTED_KEYWORDS の取り込みに失敗している");
  const unsupported = [...found].filter((k) => !SUPPORTED_KEYWORDS.has(k)).sort();
  assert.deepEqual(unsupported, [], `validate.ts が解釈しない keyword: ${unsupported.join(", ")}`);
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
