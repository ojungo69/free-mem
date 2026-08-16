import { readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  EVENT_KINDS,
  TOOL_FAILURE_PHASES,
  emptyMatrix,
  resolveResumeDeliveryStrategy,
  type AdapterCapabilities,
  type CaptureFixture,
  type EventKind,
  type ObservedCapability,
  type ToolFailurePhase,
} from "./schema/capability.ts";
import { validateAgainstSchema, type JsonSchemaDocument } from "./schema/validate.ts";

// JSON Schema は「置いてあるだけ」にせず、キー集合の正本として実際に読む
const SCHEMA = JSON.parse(
  readFileSync(new URL("./schema/capability.schema.json", import.meta.url), "utf8"),
) as JsonSchemaDocument & { properties?: Record<string, any> };

const EVENT_KIND_SET = new Set<string>(EVENT_KINDS);
const TOOL_FAILURE_PHASE_SET = new Set<string>(TOOL_FAILURE_PHASES);
const CLI_SET = new Set(["claude", "codex"]);

// 高位 cell の強さ。後勝ちで降格させないための順序（capture[kind] の native>synthesized と同じ考え）
const CAPABILITY_STRENGTH: Record<string, number> = { unsupported: 0, synthesized: 1, native: 2 };

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Minimal CaptureFixture validation (no ajv; required keys + enum checks). */
export function validateFixture(data: unknown, fileName: string): CaptureFixture {
  const errs: string[] = [];
  if (!isObject(data)) {
    throw new Error(`${fileName}: not a JSON object`);
  }

  const req = [
    "fixtureId",
    "cli",
    "nativeVersion",
    "capturedAt",
    "scenario",
    "observedEvents",
    "toolFailurePhasesObserved",
    "limitations",
    "rig",
  ] as const;
  for (const k of req) {
    if (!(k in data)) errs.push(`missing required key: ${k}`);
  }

  if (typeof data.fixtureId !== "string" || data.fixtureId.length === 0) {
    errs.push("fixtureId must be non-empty string");
  }
  if (typeof data.cli !== "string" || !CLI_SET.has(data.cli)) {
    errs.push('cli must be "claude" | "codex"');
  }
  if (typeof data.nativeVersion !== "string" || data.nativeVersion.length === 0) {
    errs.push("nativeVersion must be non-empty string");
  }
  if (typeof data.capturedAt !== "string" || data.capturedAt.length === 0) {
    errs.push("capturedAt must be non-empty string");
  }
  if (typeof data.scenario !== "string" || data.scenario.length === 0) {
    errs.push("scenario must be non-empty string");
  }

  if (!Array.isArray(data.observedEvents)) {
    errs.push("observedEvents must be array");
  } else {
    data.observedEvents.forEach((ev, i) => {
      if (!isObject(ev)) {
        errs.push(`observedEvents[${i}] must be object`);
        return;
      }
      if (typeof ev.kind !== "string") {
        errs.push(`observedEvents[${i}].kind must be string`);
      } else if (ev.kind !== "raw" && !EVENT_KIND_SET.has(ev.kind)) {
        errs.push(`observedEvents[${i}].kind invalid: ${ev.kind}`);
      }
      if ("at" in ev && typeof ev.at !== "string") {
        errs.push(`observedEvents[${i}].at must be string if present`);
      }
      if ("capability" in ev && ev.capability !== "native" && ev.capability !== "synthesized") {
        errs.push(`observedEvents[${i}].capability must be "native" | "synthesized"`);
      }
      if (ev.capability === "synthesized" && (!Array.isArray(ev.sourceEvents) || ev.sourceEvents.length === 0)) {
        errs.push(`observedEvents[${i}]: synthesized requires non-empty sourceEvents (§7.2)`);
      }
    });
  }

  if (!Array.isArray(data.toolFailurePhasesObserved)) {
    errs.push("toolFailurePhasesObserved must be array");
  } else {
    data.toolFailurePhasesObserved.forEach((p, i) => {
      if (typeof p !== "string" || !TOOL_FAILURE_PHASE_SET.has(p)) {
        errs.push(`toolFailurePhasesObserved[${i}] invalid: ${String(p)}`);
      }
    });
  }

  if (!Array.isArray(data.limitations)) {
    errs.push("limitations must be array");
  } else if (!data.limitations.every((x) => typeof x === "string")) {
    errs.push("limitations items must be strings");
  }

  // この 2 つは schema 側を正本にして検査する。highLevel は matrix の cell に直接載る
  // （= 自動配送の判定入力）ので enum まで見る必要があり、evidenceHash は同じ正規表現を
  // 2 箇所に書くと片方だけ古くなるため
  for (const key of ["evidenceHash", "highLevel"] as const) {
    if (!(key in data)) continue;
    const sub = SCHEMA.properties?.[key];
    if (!sub) {
      errs.push(`capability.schema.json に ${key} の定義が無い`);
      continue;
    }
    for (const issue of validateAgainstSchema(data[key], sub, SCHEMA, key)) {
      errs.push(`${issue.path}: ${issue.message}`);
    }
  }

  if (!isObject(data.rig)) {
    errs.push("rig must be object");
  } else {
    // 隔離 rig 外で取った capture を real-cli-e2e として matrix に載せない
    if (data.rig.isolated !== true) errs.push("rig.isolated must be true (隔離 rig 外の capture は採用しない)");
    if (typeof data.rig.internalRunMarker !== "boolean") {
      errs.push("rig.internalRunMarker must be boolean");
    }
  }

  // JSON Schema と手書き検証の drift 防止: schema が知らないキーは弾く
  const known = new Set(Object.keys(SCHEMA.properties ?? {}));
  for (const k of Object.keys(data)) {
    if (!known.has(k)) errs.push(`unknown top-level key (capability.schema.json 未定義): ${k}`);
  }
  const evKnown = new Set(Object.keys(SCHEMA.properties?.observedEvents?.items?.properties ?? {}));
  if (Array.isArray(data.observedEvents)) {
    for (const [i, ev] of data.observedEvents.entries()) {
      if (!isObject(ev)) continue;
      for (const k of Object.keys(ev)) {
        if (!evKnown.has(k)) errs.push(`observedEvents[${i}]: unknown key (schema 未定義): ${k}`);
      }
    }
  }

  // throw にしておく（呼び出し側の loadFixtures が exit へ変換する）。
  // process.exit だと不正 fixture の棄却をテストから確認できない
  if (errs.length > 0) {
    throw new Error(`${fileName}: ${errs.join("; ")}`);
  }

  return data as unknown as CaptureFixture;
}

export interface AssembledMatrix {
  cli: "claude" | "codex";
  nativeVersion: string;
  generatedAt: string;
  fixtureCount: number;
  fixtureIds: string[];
  fixtureLimitations: string[]; // fixture 単位の caveat（cell に紐づかないもの）
  capabilities: AdapterCapabilities;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function assembleFromFixtures(fixtures: CaptureFixture[]): AssembledMatrix {
  if (fixtures.length === 0) {
    fail("no valid fixtures to assemble");
  }

  const cli = fixtures[0].cli;
  const nativeVersion = fixtures[0].nativeVersion;
  // fixtureId は cell 間の「同一の実測か」の照合キー（capability.ts sameEvidenceSource）。
  // 重複したまま通すと別 run 同士を同一実測と誤認する
  const seenIds = new Set<string>();
  for (const f of fixtures) {
    if (seenIds.has(f.fixtureId)) fail(`duplicate fixtureId: ${f.fixtureId}`);
    seenIds.add(f.fixtureId);
  }
  for (const f of fixtures) {
    if (f.cli !== cli) {
      fail(`cli mismatch: ${fixtures[0].fixtureId}=${cli} vs ${f.fixtureId}=${f.cli}`);
    }
    if (f.nativeVersion !== nativeVersion) {
      fail(
        `version-pin violation: ${fixtures[0].fixtureId}=${nativeVersion} vs ${f.fixtureId}=${f.nativeVersion}`,
      );
    }
  }

  const capabilities = emptyMatrix(nativeVersion);
  const phaseSet = new Set<ToolFailurePhase>();
  const fixtureLimitations: string[] = [];
  const HIGH_LEVEL_KEYS = [
    "sessionStartInjection",
    "promptAwareInjection",
    "promptDeliveryBeforeModel",
    "compactSingleDelivery",
    "trueSessionEnd",
    "subagentCapture",
    "stableNativeSessionId",
  ] as const;
  type HighLevelObservation = { fixture: CaptureFixture; value: ObservedCapability };
  const highLevelObs: Partial<Record<(typeof HIGH_LEVEL_KEYS)[number], HighLevelObservation[]>> = {};

  for (const f of fixtures) {
    for (const ev of f.observedEvents) {
      if (ev.kind === "raw") continue;
      const kind = ev.kind as EventKind;
      const prev = capabilities.capture[kind];
      // native は synthesized に降格させない（別 fixture で native 観測済みなら維持）
      const demoting = prev.value === "native" && ev.capability === "synthesized";
      // limitations / sourceEvents は上書きせず統合する（後勝ちで caveat を消さない）
      const mergedLimits = dedupe([
        ...(prev.value === "unknown" ? [] : prev.limitations),
        ...(ev.limitations ?? []),
      ]);
      const mergedSources = dedupe([
        ...(prev.value === "unknown" ? [] : prev.sourceEvents),
        ...(ev.sourceEvents ?? []),
      ]);
      if (demoting) {
        capabilities.capture[kind] = { ...prev, limitations: mergedLimits, sourceEvents: mergedSources };
        continue;
      }
      const coverage = ev.coverage ?? (prev.value !== "unknown" ? prev.coverage : undefined);
      capabilities.capture[kind] = {
        value: ev.capability ?? "native",
        sourceEvents: mergedSources,
        nativeVersion,
        evidenceKind: "real-cli-e2e",
        verifiedAt: f.capturedAt,
        limitations: mergedLimits,
        ...(coverage !== undefined ? { coverage } : {}),
      };
    }
    for (const p of f.toolFailurePhasesObserved) {
      phaseSet.add(p);
    }
    for (const l of f.limitations ?? []) fixtureLimitations.push(`[${f.fixtureId}] ${l}`);

    // 高位 cell は観測を集めるだけにして、畳むのは全 fixture を読んだ後（下の 1 パス）。
    // cell ごとに後勝ちで畳むと fixture の並び順で結果が変わる:
    // 補強証拠を足すと prompt 経路の対が壊れ、否定的な実測は先に来たか後に来たかで消える
    const hl = f.highLevel;
    if (hl) {
      for (const key of HIGH_LEVEL_KEYS) {
        const v = hl[key];
        if (v) (highLevelObs[key] ??= []).push({ fixture: f, value: v });
      }
      if (hl.compactionRecoveryStrategy) {
        capabilities.compactionRecoveryStrategy = hl.compactionRecoveryStrategy;
      }
    }
  }

  for (const key of HIGH_LEVEL_KEYS) {
    const obs = highLevelObs[key];
    if (!obs) continue;
    // 「支持あり（native / synthesized）」と「支持なし（unsupported）」が両方観測されたら
    // 実測どうしの矛盾。key の欠落は未観測として無視しているので、unsupported は
    // 「その run では明示的に否定された」という主張になる。矛盾したまま自動配送を
    // 有効化しないよう証跡を落とす（isProven が false = fail closed）。
    // native と synthesized の食い違いは達成手段の差で、支持の有無は割れていないため矛盾としない
    const contradicted =
      obs.some((o) => o.value === "unsupported") && obs.some((o) => o.value !== "unsupported");
    // 値は最も強い観測を採る。同強度なら後の fixture（並び順の影響は下の pairFixture が均す）
    const best = obs.reduce((a, b) => (CAPABILITY_STRENGTH[b.value] >= CAPABILITY_STRENGTH[a.value] ? b : a));
    // highLevel は fixture の自己申告で、observedEvents のような file 内証跡を伴わない。
    // hash で transcript に紐付いていないものを real-cli-e2e と刻むのは provenance の
    // 捏造になるため、hash が無い間は弱い証跡種別に落とす。
    // Task 2/3 の実 CLI rig が hash を記録したら昇格する
    const hashed = Boolean(best.fixture.evidenceHash);
    capabilities[key] = {
      value: best.value,
      sourceEvents: [],
      nativeVersion,
      evidenceKind: contradicted ? null : hashed ? "real-cli-e2e" : "source-test",
      verifiedAt: contradicted ? null : best.fixture.capturedAt,
      limitations: dedupe([
        ...obs.map((o) => `observed ${o.value} in ${o.fixture.fixtureId}`),
        ...(contradicted ? ["conflicting observations: evidence dropped"] : []),
        ...(!contradicted && !hashed ? ["no evidenceHash: transcript に紐付いていない自己申告"] : []),
      ]),
      sourceFixtureId: best.fixture.fixtureId,
      evidenceHash: contradicted ? null : best.fixture.evidenceHash ?? null,
    };
  }

  // addendum §8 の synthesized tier は「1 つの実測が prompt 経路の両 cell を同時に証明した」
  // ことを要求する。cell ごとに後勝ちで畳むと、別 fixture の等強度の観測が片側だけ
  // provenance を差し替え、実在する対が消える（証拠を足したのに tier が下がる）。
  // 畳んだ後に、対を証明した fixture があればその provenance へ揃え直す。
  const pairFixture = fixtures.findLast(
    (f) =>
      f.evidenceHash &&
      f.highLevel?.promptAwareInjection === "synthesized" &&
      f.highLevel?.promptDeliveryBeforeModel === "synthesized",
  );
  if (pairFixture) {
    for (const key of ["promptAwareInjection", "promptDeliveryBeforeModel"] as const) {
      const cell = capabilities[key];
      // native に昇格した cell や、矛盾で証跡を落とした cell には触らない
      if (cell.value !== "synthesized" || cell.evidenceKind === null) continue;
      capabilities[key] = {
        ...cell,
        evidenceKind: "real-cli-e2e",
        verifiedAt: pairFixture.capturedAt,
        sourceFixtureId: pairFixture.fixtureId,
        evidenceHash: pairFixture.evidenceHash ?? null,
        limitations: dedupe([...cell.limitations, `prompt pair proven together in ${pairFixture.fixtureId}`]),
      };
    }
  }

  capabilities.toolFailurePhases = TOOL_FAILURE_PHASES.filter((p) => phaseSet.has(p));
  capabilities.toolFailurePhasesUntested = TOOL_FAILURE_PHASES.filter((p) => !phaseSet.has(p));

  // capability hash の入力: exact version と、各 fixture の evidence hash。
  // fixture 順に依らないよう sort する（同じ証拠集合なら同じ入力列になる）
  capabilities.capabilityHashInputs = [
    `cli:${cli}`,
    `nativeVersion:${nativeVersion}`,
    ...fixtures.map((f) => `fixture:${f.fixtureId}@${f.evidenceHash ?? "no-evidence-hash"}`).sort(),
  ];
  capabilities.resumeDeliveryStrategy = resolveResumeDeliveryStrategy(capabilities);

  return {
    cli,
    nativeVersion,
    generatedAt: new Date().toISOString(),
    fixtureCount: fixtures.length,
    fixtureIds: fixtures.map((f) => f.fixtureId),
    fixtureLimitations,
    capabilities,
  };
}

async function loadFixtures(fixturesDir: string): Promise<CaptureFixture[]> {
  let names: string[];
  try {
    names = await readdir(fixturesDir);
  } catch (e) {
    fail(`cannot read fixturesDir: ${fixturesDir}: ${String(e)}`);
  }

  const jsonFiles = names.filter((n) => n.endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    fail(`no *.json fixtures in ${fixturesDir}`);
  }

  const fixtures: CaptureFixture[] = [];
  for (const name of jsonFiles) {
    const path = join(fixturesDir, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      fail(`${name}: read failed: ${String(e)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      fail(`${name}: invalid JSON: ${String(e)}`);
    }
    try {
      fixtures.push(validateFixture(data, name));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }
  return fixtures;
}

async function runAssemble(fixturesDir: string, outFile: string): Promise<void> {
  const fixtures = await loadFixtures(fixturesDir);
  const assembled = assembleFromFixtures(fixtures);
  await writeFile(outFile, JSON.stringify(assembled, null, 2) + "\n", "utf8");
  console.log(`wrote ${outFile} (${assembled.fixtureCount} fixtures, ${assembled.cli} ${assembled.nativeVersion})`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

async function selfTest(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "harness-self-test-"));
  try {
    const v = "1.2.3-test";
    const at1 = "2026-08-12T00:00:00.000Z";
    const at2 = "2026-08-12T01:00:00.000Z";

    const f1: CaptureFixture = {
      fixtureId: "claude/lifecycle-basic",
      cli: "claude",
      nativeVersion: v,
      capturedAt: at1,
      scenario: "session start + prompt",
      observedEvents: [
        { kind: "session_started", at: at1 },
        { kind: "user_prompted", at: at1 },
        { kind: "raw", raw: { note: "ignored" } },
      ],
      toolFailurePhasesObserved: [],
      limitations: [],
      rig: { isolated: true, internalRunMarker: true },
    };

    const f2: CaptureFixture = {
      fixtureId: "claude/tool-fail",
      cli: "claude",
      nativeVersion: v,
      capturedAt: at2,
      scenario: "tool lifecycle + executed fail",
      observedEvents: [
        { kind: "tool_started", at: at2 },
        { kind: "tool_completed", at: at2 },
        { kind: "tool_failed", at: at2 },
      ],
      toolFailurePhasesObserved: ["executed", "permission_denied"],
      limitations: ["schema_invalid not observed"],
      rig: { isolated: true, internalRunMarker: true },
    };

    await writeFile(join(dir, "lifecycle-basic.json"), JSON.stringify(f1), "utf8");
    await writeFile(join(dir, "tool-fail.json"), JSON.stringify(f2), "utf8");

    const fixtures = await loadFixtures(dir);
    const assembled = assembleFromFixtures(fixtures);

    assert(assembled.cli === "claude", "cli");
    assert(assembled.nativeVersion === v, "nativeVersion");
    assert(assembled.fixtureCount === 2, "fixtureCount");
    assert(assembled.fixtureIds.includes("claude/lifecycle-basic"), "id1");
    assert(assembled.fixtureIds.includes("claude/tool-fail"), "id2");

    const cap = assembled.capabilities;
    for (const kind of ["session_started", "user_prompted"] as EventKind[]) {
      assert(cap.capture[kind].value === "native", `${kind} native`);
      assert(cap.capture[kind].verifiedAt === at1, `${kind} verifiedAt`);
      assert(cap.capture[kind].evidenceKind === "real-cli-e2e", `${kind} evidenceKind`);
      assert(cap.capture[kind].nativeVersion === v, `${kind} nativeVersion`);
    }
    for (const kind of ["tool_started", "tool_completed", "tool_failed"] as EventKind[]) {
      assert(cap.capture[kind].value === "native", `${kind} native`);
      assert(cap.capture[kind].verifiedAt === at2, `${kind} verifiedAt`);
    }
    for (const kind of EVENT_KINDS) {
      if (
        kind === "session_started" ||
        kind === "user_prompted" ||
        kind === "tool_started" ||
        kind === "tool_completed" ||
        kind === "tool_failed"
      ) {
        continue;
      }
      assert(cap.capture[kind].value === "unknown", `${kind} stays unknown`);
    }

    assert(
      JSON.stringify(cap.toolFailurePhases) === JSON.stringify(["executed", "permission_denied"]),
      "toolFailurePhases union ordered",
    );
    assert(cap.sessionStartInjection.value === "unknown", "sessionStartInjection unknown");
    assert(cap.promptAwareInjection.value === "unknown", "promptAwareInjection unknown");
    assert(cap.promptDeliveryBeforeModel.value === "unknown", "promptDeliveryBeforeModel unknown");
    assert(cap.compactSingleDelivery.value === "unknown", "compactSingleDelivery unknown");
    assert(cap.resumeDeliveryStrategy === "manual_only", "no proof ⇒ manual_only");
    assert(cap.capabilityHashInputs[0] === "cli:claude", "capabilityHashInputs starts with cli");
    assert(cap.capabilityHashInputs.includes(`nativeVersion:${v}`), "capabilityHashInputs pins version");
    assert(cap.trueSessionEnd.value === "unknown", "trueSessionEnd unknown");
    assert(cap.subagentCapture.value === "unknown", "subagentCapture unknown");
    assert(cap.stableNativeSessionId.value === "unknown", "stableNativeSessionId unknown");

    const hlBase = {
      cli: "claude" as const,
      nativeVersion: v,
      observedEvents: [],
      toolFailurePhasesObserved: [],
      limitations: [],
      rig: { isolated: true, internalRunMarker: true },
    };

    // §8: 対で証明した fixture の後に片側だけを重ねて観測しても tier は落ちない
    const withPair = assembleFromFixtures([
      {
        ...hlBase,
        fixtureId: "claude/prompt-pair",
        capturedAt: at1,
        scenario: "prompt pair",
        evidenceHash: "a".repeat(64),
        highLevel: { promptAwareInjection: "synthesized", promptDeliveryBeforeModel: "synthesized" },
      },
      {
        ...hlBase,
        fixtureId: "claude/prompt-echo",
        capturedAt: at2,
        scenario: "prompt-aware only",
        evidenceHash: "b".repeat(64),
        highLevel: { promptAwareInjection: "synthesized" },
      },
    ]).capabilities;
    assert(withPair.resumeDeliveryStrategy === "next_prompt_synthesized", "corroboration must not demote the tier");
    assert(withPair.promptAwareInjection.sourceFixtureId === "claude/prompt-pair", "pair provenance retained");

    // 実測どうしが矛盾したら、値は強いほうを残しても証跡は落として自動配送を止める。
    // 並び順で結果が変わらないこと（否定的な観測が先でも後でも同じ）まで確認する
    const ssNative = {
      ...hlBase,
      fixtureId: "claude/ss-native",
      capturedAt: at1,
      scenario: "session start native",
      evidenceHash: "c".repeat(64),
      highLevel: { sessionStartInjection: "native" as const },
    };
    const ssUnsupported = {
      ...hlBase,
      fixtureId: "claude/ss-unsupported",
      capturedAt: at2,
      scenario: "session start unsupported",
      evidenceHash: "d".repeat(64),
      highLevel: { sessionStartInjection: "unsupported" as const },
    };
    for (const [label, order] of [
      ["positive first", [ssNative, ssUnsupported]],
      ["negative first", [ssUnsupported, ssNative]],
    ] as const) {
      const conflicted = assembleFromFixtures([...order]).capabilities;
      assert(conflicted.sessionStartInjection.value === "native", `${label}: keeps the stronger value`);
      assert(conflicted.sessionStartInjection.evidenceKind === null, `${label}: drops the proof`);
      assert(conflicted.resumeDeliveryStrategy === "manual_only", `${label}: must not enable delivery`);
    }

    // 3 つ目の肯定的な観測で証跡が復活しない（矛盾は打ち消せない）
    const reasserted = assembleFromFixtures([
      ssUnsupported,
      ssNative,
      { ...ssNative, fixtureId: "claude/ss-native-2", capturedAt: at2 },
    ]).capabilities;
    assert(reasserted.sessionStartInjection.evidenceKind === null, "contradiction is sticky");

    console.log("PASS");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// import されたとき（テストから validateFixture を呼ぶ場合）は CLI を起動しない
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    selfTest().catch((e) => {
      console.error(String(e));
      process.exit(1);
    });
  } else if (args.length === 2) {
    runAssemble(args[0], args[1]).catch((e) => {
      console.error(String(e));
      process.exit(1);
    });
  } else {
    fail(
      "usage: node --experimental-strip-types harness/assemble.ts <fixturesDir> <outFile>\n" +
        "       node --experimental-strip-types harness/assemble.ts --self-test",
    );
  }
}
