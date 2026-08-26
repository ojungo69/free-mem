import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { canonicalizeJson } from "../../../harness/schema/jcs.ts";
import { buildRenderPayload, tokenizeRenderPayload } from "./alpha-result-render.mjs";
import { runnerEvidenceFingerprint, runnerResultObservationFingerprint }
  from "./alpha-runner-evidence.mjs";

const contractDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(contractDir, "../../..");
const validatorPath = join(contractDir, "validate-alpha-result.mjs");
const fixtureRoot = join(contractDir, "../fixtures");
const fixture = JSON.parse(readFileSync(join(fixtureRoot,
  "slice1-bidirectional-en-v1.json"), "utf8"));
const failure = JSON.parse(readFileSync(join(fixtureRoot,
  "alpha-result-v1.failure-example.json"), "utf8"));
const failureEvidence = JSON.parse(readFileSync(join(fixtureRoot,
  "runner-evidence/alpha-runner-evidence-v1.failure-example.json"), "utf8"));
const evidenceRoot = mkdtempSync(join(tmpdir(), "free-mem-alpha-failure-evidence-"));
process.on("exit", () => rmSync(evidenceRoot, { recursive: true }));
let ordinal = 0;

function validate(result) {
  const evidence = structuredClone(failureEvidence);
  evidence.scenarios[0].resultObservationFingerprint =
    runnerResultObservationFingerprint(result);
  result.runnerEvidenceFingerprint = runnerEvidenceFingerprint(evidence);
  const path = join(evidenceRoot, `evidence-${ordinal += 1}.json`);
  writeFileSync(path, JSON.stringify(evidence), { mode: 0o600 });
  return spawnSync(process.execPath,
    ["--experimental-strip-types", validatorPath,
      "--runner-evidence-root", evidenceRoot,
      "--runner-evidence", path,
      "--runner-invocation-id", evidence.invocationId, "--result", "-"], {
      cwd: repoRoot,
      input: JSON.stringify(result),
      encoding: "utf8",
    });
}

function assertRejected(result, pattern, label) {
  const run = validate(result);
  assert.notEqual(run.status, 0, `${label}: unexpectedly accepted`);
  assert.match(`${run.stderr}${run.stdout}`, pattern, label);
}

const unobservedInjectionClaim = structuredClone(failure);
unobservedInjectionClaim.injectionBeforeModel = true;
assertRejected(unobservedInjectionClaim, /before-model injection marker/,
  "failure claimed unobserved before-model injection");

const fabricatedFailureCounts = structuredClone(failure);
fabricatedFailureCounts.counts.pending = 0;
fabricatedFailureCounts.counts.summaryCount = 7;
fabricatedFailureCounts.counts.durableMemoryCount = 7;
assertRejected(fabricatedFailureCounts, /scenario counts/,
  "resource failure fabricated persistence counts");

const skippedInjectionRender = structuredClone(failure);
const scenario = fixture.scenarios.find((item) => item.scenarioId === failure.scenarioId);
const payload = canonicalizeJson(
  buildRenderPayload(skippedInjectionRender, scenario, fixture, [], null),
);
skippedInjectionRender.attemptedItems = [];
skippedInjectionRender.attemptedRenderEvidence = {
  rendererId: "alpha-jcs-renderer-v1",
  utf8Payload: payload,
  tokenizerId: "deterministic-fixture-tokenizer-v1",
  tokenizerRevision: "1",
  tokenIds: tokenizeRenderPayload(payload),
};
skippedInjectionRender.attemptedRenderedBytes = Buffer.byteLength(payload, "utf8");
skippedInjectionRender.attemptedInjectedTokens =
  skippedInjectionRender.attemptedRenderEvidence.tokenIds.length;
assertRejected(skippedInjectionRender, /attempted render exists without an injection boundary/,
  "skipped injection claimed an attempted render");

console.log("Alpha result failed-record invariant checks passed.");
