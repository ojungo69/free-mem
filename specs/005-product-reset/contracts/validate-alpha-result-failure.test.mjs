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
const success = JSON.parse(readFileSync(join(fixtureRoot,
  "alpha-result-v1.example.json"), "utf8"));
const successEvidence = JSON.parse(readFileSync(join(fixtureRoot,
  "runner-evidence/alpha-runner-evidence-v1.example.json"), "utf8"));
const evidenceRoot = mkdtempSync(join(tmpdir(), "free-mem-alpha-failure-evidence-"));
process.on("exit", () => rmSync(evidenceRoot, { recursive: true }));
let ordinal = 0;

function validate(result, evidenceTemplate = failureEvidence) {
  const evidence = structuredClone(evidenceTemplate);
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

function assertAccepted(result, label, evidence) {
  const run = validate(result, evidence);
  assert.equal(run.status, 0, `${label}: ${run.stderr}${run.stdout}`);
}

function assertRejected(result, pattern, label, evidence) {
  const run = validate(result, evidence);
  assert.notEqual(run.status, 0, `${label}: unexpectedly accepted`);
  assert.match(`${run.stderr}${run.stdout}`, pattern, label);
}

function runnerEvidenceFor(result, template) {
  const evidence = structuredClone(template);
  const record = evidence.scenarios[0];
  record.hostIdentityEvidence = structuredClone(result.hostIdentityEvidence);
  record.observedMilestones = structuredClone(result.milestones);
  record.processSamples = structuredClone(result.processSamples);
  record.latencyRuns = structuredClone(result.latencyEvidence.runs);
  return evidence;
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

const fabricatedDegradation = structuredClone(failure);
fabricatedDegradation.packDegradations = ["fabricated_degradation"];
assertRejected(fabricatedDegradation, /pack degradations do not match observed capabilities/,
  "resource failure fabricated a pack degradation");

const fabricatedMilestone = structuredClone(failure);
fabricatedMilestone.milestones.find((item) => item.name === "scenario_terminal").name =
  "fabricated_terminal";
assertRejected(fabricatedMilestone, /completed result milestones do not match the pinned lifecycle/,
  "resource failure fabricated a lifecycle milestone",
  runnerEvidenceFor(fabricatedMilestone, failureEvidence));

const inflatedAgentOperations = structuredClone(failure);
inflatedAgentOperations.securityDenominators.agentOperationCount = 999;
assertRejected(inflatedAgentOperations, /independent zero-tolerance safety boundary/,
  "failure inflated the Agent operation denominator");

const unorderedLatency = structuredClone(success);
const unorderedLatencyEvidence = structuredClone(successEvidence);
for (const target of [unorderedLatency.latencyEvidence.runs,
  unorderedLatencyEvidence.scenarios[0].latencyRuns]) {
  const first = target[0].captureTimings[0], second = target[0].captureTimings[1];
  [first.startMonotonicMs, second.startMonotonicMs] =
    [second.startMonotonicMs, first.startMonotonicMs];
  [first.endMonotonicMs, second.endMonotonicMs] =
    [second.endMonotonicMs, first.endMonotonicMs];
}
assertRejected(unorderedLatency, /latency run evidence does not match the pinned sampling protocol/,
  "capture timings contradicted event order", unorderedLatencyEvidence);

const stalePreparationEvidence = structuredClone(successEvidence);
const stalePreparation = stalePreparationEvidence.scenarios[0].runPreparations[0];
stalePreparation.observedAtMonotonicMs = stalePreparation.runStartedMonotonicMs -
  fixture.samplingProtocol.processSampleIntervalMs - 1;
assertRejected(structuredClone(success), /runner preparation evidence does not match latency runs/,
  "cold reset proof was stale before measurement", stalePreparationEvidence);

function timedOutSuccessAt(lastMilestone) {
  const result = structuredClone(success);
  const lastIndex = result.milestones.findIndex((item) => item.name === lastMilestone);
  result.milestones = result.milestones.slice(0, lastIndex + 1);
  result.drain = { ...result.drain, status: "timed_out", timedOut: true };
  result.disposition = {
    state: "failed", reason: "drain_timed_out", successfulComparisonEligible: false,
  };
  result.injectionBeforeModel = null;
  result.packId = null;
  result.finalRenderEvidence = null;
  result.renderedBytes = 0;
  result.injectedTokens = 0;
  result.attemptedRenderedBytes = 0;
  result.attemptedInjectedTokens = 0;
  const start = result.processSamples[0], steady = result.processSamples[1];
  result.processSamples = [];
  for (let monotonicMs = 0; monotonicMs < 30000; monotonicMs += 100) {
    result.processSamples.push({ ...(monotonicMs === 0 ? start : steady), monotonicMs });
  }
  result.processSamples.push({ ...success.processSamples.at(-1), monotonicMs: 30000 });
  return result;
}

const timeoutBeforePersistence = timedOutSuccessAt("source_flush_requested_by_target_prompt");
for (const name of ["inputCandidates", "tracedCandidates", "deadlineUnprocessed",
  "admittedCandidates", "selectedItems"]) timeoutBeforePersistence.counts[name] = 0;
timeoutBeforePersistence.counts.summaryCount = 0;
timeoutBeforePersistence.counts.durableMemoryCount = 0;
timeoutBeforePersistence.injectedItems = [];
timeoutBeforePersistence.omittedItems = [];
timeoutBeforePersistence.attemptedItems = [];
timeoutBeforePersistence.attemptedRenderEvidence = null;
timeoutBeforePersistence.selectionTimingEvidence = null;
timeoutBeforePersistence.selectionElapsedMs = 0;
timeoutBeforePersistence.packDegradations = [];
timeoutBeforePersistence.quality = {
  expectedInjectedItemCount: 4, matchedInjectedItemCount: 0,
  expectedOmissionCount: 0, matchedOmissionCount: 0, forbiddenFactCount: 0,
};
assertAccepted(timeoutBeforePersistence, "timeout before persistence commit",
  runnerEvidenceFor(timeoutBeforePersistence, successEvidence));

const timeoutAfterSelection = timedOutSuccessAt("target_selection_finished");
const timeoutAfterSelectionEvidence = runnerEvidenceFor(timeoutAfterSelection, successEvidence);
assertAccepted(timeoutAfterSelection, "timeout after completed selection",
  timeoutAfterSelectionEvidence);
const erasedSelection = structuredClone(timeoutAfterSelection);
for (const name of ["inputCandidates", "tracedCandidates", "deadlineUnprocessed",
  "admittedCandidates", "selectedItems"]) erasedSelection.counts[name] = 0;
erasedSelection.injectedItems = [];
erasedSelection.omittedItems = [];
erasedSelection.attemptedItems = [];
erasedSelection.quality = {
  expectedInjectedItemCount: 4, matchedInjectedItemCount: 0,
  expectedOmissionCount: 0, matchedOmissionCount: 0, forbiddenFactCount: 0,
};
assertRejected(erasedSelection, /completed selection does not match the pinned item trace/,
  "timeout erased an observed completed selection", timeoutAfterSelectionEvidence);

console.log("Alpha result failed-record invariant checks passed.");
