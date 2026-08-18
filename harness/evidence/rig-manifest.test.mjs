// rig が書く manifest を、実 CLI 無しで end-to-end に確かめる。
// stub CLI を CLAUDE_BIN として渡し、rig.sh の setup → claude-run → import を実際に走らせる。
// harness ごと複製して走らせるので、既定の証拠置き場（module からの相対）も複製側を指す。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("../", import.meta.url));
const LABEL = "rig-stub";
const VERSION = "9.9.9-stub (Stub Code)";

// 実 CLI の代わり。--version は 1 行返し、それ以外では hook 相当の観測記録を書く
const STUB = `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = --version ]; then printf '%s\\n' '${VERSION}'; exit 0; fi
emit() { printf '{"event":"%s","at":"2026-01-01T00:00:00.000Z","payload":%s}\\n' "$1" "$2" >> "$CAPTURE_FILE"; }
emit SessionStart '{"hook_event_name":"SessionStart","source":"startup","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit UserPromptSubmit '{"hook_event_name":"UserPromptSubmit","prompt_id":"p-stub","prompt":"hello","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit Stop '{"hook_event_name":"Stop","prompt_id":"p-stub","last_assistant_message":"hi","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
emit SessionEnd '{"hook_event_name":"SessionEnd","prompt_id":"p-stub","reason":"other","session_id":"s-stub","cwd":"/w","transcript_path":"/w/t.jsonl"}'
`;

function rigRun() {
  const tmp = mkdtempSync(join(tmpdir(), "rig-manifest-"));
  cpSync(HARNESS, join(tmp, "harness"), { recursive: true });
  const stub = join(tmp, "stub-cli");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);

  const rig = join(tmp, "harness", "rig", "rig.sh");
  const base = join(tmp, "rig-base");
  const env = { ...process.env, RIG_BASE: base, CLAUDE_BIN: stub };
  const sh = (...args) => spawnSync("bash", [rig, ...args], { encoding: "utf8", env });

  const setup = sh("setup");
  assert.equal(setup.status, 0, setup.stderr);
  const run = sh("claude-run", LABEL, "hello");
  assert.equal(run.status, 0, run.stderr);
  const imported = sh("import", "claude", LABEL, "self.stub");
  assert.equal(imported.status, 0, imported.stderr);

  const rawDir = join(tmp, "harness", "fixtures", "claude", "raw");
  return {
    tmp,
    rawDir,
    ref: JSON.parse(imported.stdout),
    capture: join(base, "capture", `claude-${LABEL}.jsonl`),
    manifest: JSON.parse(readFileSync(join(rawDir, `claude-${LABEL}.manifest.json`), "utf8")),
  };
}

test("the rig writes a manifest and imports the capture byte-identically", () => {
  const { rawDir, ref, capture, manifest } = rigRun();

  assert.deepEqual(readFileSync(join(rawDir, `claude-${LABEL}.jsonl`)), readFileSync(capture));
  assert.equal(manifest.cliVersion, VERSION);
  assert.equal(manifest.cli, "claude");
  assert.equal(manifest.scenarioId, "self.stub");
  assert.equal(manifest.isolated, true);
  assert.equal(manifest.internalRunMarker, true);
  assert.equal(manifest.exitStatus, 0);
  assert.equal(manifest.recorderErrors, 0);
  assert.equal(manifest.capture, `claude-${LABEL}.jsonl`);
  // 出力した ref と manifest が同じ digest を指す（貼り間違いではなく機械で一致する）
  assert.equal(ref.evidenceHash, manifest.captureHash);
  assert.equal(ref.captureRawHash, manifest.captureRawHash);
  assert.match(ref.manifestHash, /^[a-f0-9]{64}$/);
});

test("a rig-produced manifest promotes the cell to real-cli-e2e", () => {
  const { tmp, ref, manifest } = rigRun();
  const dir = join(tmp, "harness", "fixtures", "rigtest");
  const at = "2026-01-01T00:00:00.000Z";
  const event = (kind, sourceEvents, capability = "native") => ({ kind, at, capability, sourceEvents });
  cpSync(join(tmp, "harness", "fixtures", "claude"), dir, { recursive: true, filter: (s) => !s.endsWith(".json") });
  writeFileSync(
    join(dir, "rig-stub.json"),
    JSON.stringify(
      {
        fixtureId: "claude/rig-stub",
        cli: "claude",
        nativeVersion: manifest.cliVersion,
        capturedAt: at,
        scenario: "stub lifecycle",
        scenarioId: manifest.scenarioId,
        observedEvents: [
          event("session_started", ["SessionStart"]),
          event("user_prompted", ["UserPromptSubmit"]),
          // Stop から復元する主張なので native ではなく synthesized
          event("assistant_completed", ["Stop"], "synthesized"),
          event("session_ended", ["SessionEnd"]),
        ],
        toolFailurePhasesObserved: [],
        limitations: [],
        limitationCodes: [],
        evidence: [ref],
        rig: { isolated: true, internalRunMarker: true },
      },
      null,
      2,
    ),
  );

  const out = join(tmp, "rigtest.json");
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(tmp, "harness", "assemble.ts"), dir, out],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const matrix = JSON.parse(readFileSync(out, "utf8"));
  for (const kind of ["session_started", "user_prompted", "assistant_completed", "session_ended"]) {
    assert.equal(matrix.capabilities.capture[kind].evidenceKind, "real-cli-e2e", `${kind} が昇格していない`);
  }
  // 昇格した cell に「manifest が無い」の caveat が残らない
  assert.ok(!JSON.stringify(matrix.capabilities.capture).includes("no manifest-backed evidence"));
});
