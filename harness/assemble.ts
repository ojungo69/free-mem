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

  if ("evidenceHash" in data && (typeof data.evidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(data.evidenceHash))) {
    errs.push("evidenceHash must be a 64-char lowercase hex SHA-256 if present");
  }

  // highLevel は matrix の cell に直接載る（= 自動配送の判定入力）。schema で enum まで検査する
  if ("highLevel" in data) {
    const hlSchema = SCHEMA.properties?.highLevel;
    if (!hlSchema) {
      errs.push("capability.schema.json に highLevel の定義が無い");
    } else {
      for (const issue of validateAgainstSchema(data.highLevel, hlSchema, SCHEMA, "highLevel")) {
        errs.push(`${issue.path}: ${issue.message}`);
      }
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

    // 高位 cell: fixture が観測結果を書いている場合のみ unknown を上書きする
    const hl = f.highLevel;
    if (hl) {
      for (const key of HIGH_LEVEL_KEYS) {
        const v = hl[key];
        if (!v) continue;
        capabilities[key] = {
          value: v,
          sourceEvents: [],
          nativeVersion,
          evidenceKind: "real-cli-e2e",
          verifiedAt: f.capturedAt,
          limitations: [`observed in ${f.fixtureId}`],
          sourceFixtureId: f.fixtureId,
          evidenceHash: f.evidenceHash ?? null,
        };
      }
      if (hl.compactionRecoveryStrategy) {
        capabilities.compactionRecoveryStrategy = hl.compactionRecoveryStrategy;
      }
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
