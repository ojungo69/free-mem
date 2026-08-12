import { readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EVENT_KINDS,
  TOOL_FAILURE_PHASES,
  emptyMatrix,
  type AdapterCapabilities,
  type CaptureFixture,
  type EventKind,
  type ToolFailurePhase,
} from "./schema/capability.ts";

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
    fail(`${fileName}: not a JSON object`);
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

  if (!isObject(data.rig)) {
    errs.push("rig must be object");
  } else {
    if (typeof data.rig.isolated !== "boolean") errs.push("rig.isolated must be boolean");
    if (typeof data.rig.internalRunMarker !== "boolean") {
      errs.push("rig.internalRunMarker must be boolean");
    }
  }

  if (errs.length > 0) {
    fail(`${fileName}: ${errs.join("; ")}`);
  }

  return data as unknown as CaptureFixture;
}

export interface AssembledMatrix {
  cli: "claude" | "codex";
  nativeVersion: string;
  generatedAt: string;
  fixtureCount: number;
  fixtureIds: string[];
  capabilities: AdapterCapabilities;
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

  for (const f of fixtures) {
    for (const ev of f.observedEvents) {
      if (ev.kind === "raw") continue;
      const kind = ev.kind as EventKind;
      capabilities.capture[kind] = {
        value: "native",
        sourceEvents: [],
        nativeVersion,
        evidenceKind: "real-cli-e2e",
        verifiedAt: f.capturedAt,
        limitations: [],
      };
    }
    for (const p of f.toolFailurePhasesObserved) {
      phaseSet.add(p);
    }
  }

  capabilities.toolFailurePhases = TOOL_FAILURE_PHASES.filter((p) => phaseSet.has(p));

  return {
    cli,
    nativeVersion,
    generatedAt: new Date().toISOString(),
    fixtureCount: fixtures.length,
    fixtureIds: fixtures.map((f) => f.fixtureId),
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
    fixtures.push(validateFixture(data, name));
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
    assert(cap.trueSessionEnd.value === "unknown", "trueSessionEnd unknown");
    assert(cap.subagentCapture.value === "unknown", "subagentCapture unknown");
    assert(cap.stableNativeSessionId.value === "unknown", "stableNativeSessionId unknown");

    console.log("PASS");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
