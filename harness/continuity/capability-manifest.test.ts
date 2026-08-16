import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateContractValue, type JsonSchemaDocument } from "../schema/validate.ts";
import * as contract from "../schema/continuity.ts";

/**
 * §13 は capability-scenarios.v1.json を「required scenario ID の唯一の権威」と定めているが、
 * 置いただけでは誰も読まない。ここが manifest に対する実行可能なゲート。
 *
 * §13 は `manifestHash` の不一致を preflight 失敗としながら算出方法を書いていないため、
 * 正規化規則は evidence/phase3-capability-scenario-manifest.md 側で定義してある。
 * この test はその規則どおりに再計算して照合する（手で埋めた値を宣言のまま放置しない）。
 */
const root = JSON.parse(
  readFileSync(new URL("../schema/continuity.schema.json", import.meta.url), "utf8"),
) as JsonSchemaDocument;

const manifest = JSON.parse(
  readFileSync(new URL("../schema/capability-scenarios.v1.json", import.meta.url), "utf8"),
) as contract.CapabilityScenarioManifestV1;

const evidence = readFileSync(
  new URL("../../evidence/phase3-capability-scenario-manifest.md", import.meta.url),
  "utf8",
);

/** evidence に書いた正規化規則。scenarios は scenarioId 昇順、キー順も固定、hash 自身は入力外 */
function computeManifestHash(value: contract.CapabilityScenarioManifestV1): string {
  const canonical = {
    manifestVersion: value.manifestVersion,
    scenarios: [...value.scenarios]
      .sort((a, b) => (a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0))
      .map((s) => ({
        scenarioId: s.scenarioId,
        title: s.title,
        appliesToAgents: s.appliesToAgents,
        requiredFor: s.requiredFor,
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

test("manifest は CapabilityScenarioManifestV1 を満たす", () => {
  assert.deepEqual(
    validateContractValue("CapabilityScenarioManifestV1", manifest, root, contract.CONTINUITY_LIMITS),
    [],
  );
});

test("manifestHash は記録した正規化規則で再計算できる（§13）", () => {
  assert.equal(manifest.manifestHash, computeManifestHash(manifest));
});

test("manifestHash は scenario の変更で必ず変わる", () => {
  // 「hash を計算している」だけでは、入力に含まれない欄を書き換えても通ってしまう。
  // §13 が防ぎたいのは scenario 集合の無言の書き換えなので、そこが効くことを見る
  const [first, ...rest] = manifest.scenarios;
  assert.ok(first, "manifest が空");
  const mutations: contract.CapabilityScenarioManifestV1[] = [
    { ...manifest, scenarios: [{ ...first, scenarioId: `${first.scenarioId}-x` }, ...rest] },
    { ...manifest, scenarios: [{ ...first, title: `${first.title} (x)` }, ...rest] },
    { ...manifest, scenarios: [{ ...first, appliesToAgents: ["claude"] }, ...rest] },
    { ...manifest, scenarios: [{ ...first, requiredFor: ["generic_phase3"] }, ...rest] },
    { ...manifest, scenarios: rest },
    { ...manifest, manifestVersion: "2" },
  ];
  for (const mutated of mutations) {
    assert.notEqual(computeManifestHash(mutated), manifest.manifestHash);
  }
  // 並べ替えは正規化で吸収される（同じ集合なら同じ hash）
  assert.equal(
    computeManifestHash({ ...manifest, scenarios: [...manifest.scenarios].reverse() }),
    manifest.manifestHash,
  );
});

test("scenarioId は重複しない（§13 の exact-set 照合が成立する前提）", () => {
  const ids = manifest.scenarios.map((s) => s.scenarioId);
  assert.deepEqual([...new Set(ids)].sort(), [...ids].sort());
  assert.ok(ids.length > 0, "manifest が空だと preflight が vacuously pass する");
});

test("appliesToAgents は harness が matrix を持つ CLI だけを指す", () => {
  // 対応する fixture / matrix が無い agent を書くと、その scenario は永久に
  // disposition が付かず、exact-set 照合が必ず落ちる（または黙って無視される）
  const known = new Set(["claude", "codex"]);
  for (const scenario of manifest.scenarios) {
    assert.ok(scenario.appliesToAgents.length > 0, `${scenario.scenarioId}: appliesToAgents が空`);
    // requiredFor が空だと「manifest に居るがどの preflight/Tier にも必須でない」scenario になり、
    // §13 の exact-set 照合を通ったまま何も要求しない。schema 側は正本どおり空を許すので
    // （addendum は `Array<...>` としか書いていない）、manifest のデータとしてここで弾く
    assert.ok(scenario.requiredFor.length > 0, `${scenario.scenarioId}: requiredFor が空`);
    for (const agent of scenario.appliesToAgents) {
      assert.ok(known.has(agent), `${scenario.scenarioId}: 未知の agent ${agent}`);
    }
  }
});

/** `## manifestVersion N` の節から、その版に属する scenarioId 集合と記録された hash を取る */
function evidenceEntry(version: string): { ids: string[]; hash: string | undefined } {
  const section = evidence
    .split(/^## /m)
    .find((s) => s.startsWith(`manifestVersion ${version} `) || s.startsWith(`manifestVersion ${version}\n`));
  assert.ok(section, `evidence に manifestVersion ${version} の節が無い`);
  return {
    ids: [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1] as string),
    hash: /^manifestHash: `([0-9a-f]{64})`$/m.exec(section)?.[1],
  };
}

test("evidence が版ごとの scenario 集合を固定している（§13 の version bump 要件）", () => {
  // §13「Adding or removing a required scenario requires a manifest version bump
  // recorded in the evidence file」。ID の出現を数えるだけだと、scenario を 1 つ削って
  // hash を再計算し、evidence の表も直して version は据え置き——が素通りする。
  // 版の節を「その版の集合そのもの」として exact-set で照合し、hash も版に紐付ける。
  // ただし manifest・hash・evidence は同じ変更の中で一緒に書き換えられるので、この test
  // だけでは版の据え置きを塞げない。「公開済みの版のファイルは変更しない」は CI の
  // Published manifest versions are immutable が origin/main を基準に見る
  const entry = evidenceEntry(manifest.manifestVersion);
  assert.deepEqual(
    entry.ids.slice().sort(),
    manifest.scenarios.map((s) => s.scenarioId).sort(),
  );
  assert.equal(entry.hash, manifest.manifestHash);
  assert.equal(entry.hash, computeManifestHash(manifest));
});
