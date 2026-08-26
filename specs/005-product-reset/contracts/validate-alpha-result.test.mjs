import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalizeJson } from "../../../harness/schema/jcs.ts";
import { buildRenderPayload, tokenizeRenderPayload } from "./alpha-result-render.mjs";

const contractDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(contractDir, "../../..");
const validatorPath = join(contractDir, "validate-alpha-result.mjs");
const fixture = JSON.parse(readFileSync(join(contractDir,
  "../fixtures/slice1-bidirectional-en-v1.json"), "utf8"));
const success = JSON.parse(readFileSync(join(contractDir,
  "../fixtures/alpha-result-v1.example.json"), "utf8"));
const failure = JSON.parse(readFileSync(join(contractDir,
  "../fixtures/alpha-result-v1.failure-example.json"), "utf8"));

function validate(result) {
  return spawnSync(process.execPath,
    ["--experimental-strip-types", validatorPath, "--result", "-"], {
      cwd: repoRoot,
      input: JSON.stringify(result),
      encoding: "utf8",
    });
}

function assertAccepted(result, label) {
  const run = validate(result);
  assert.equal(run.status, 0, `${label}: ${run.stderr}${run.stdout}`);
}

function assertRejected(result, message, label) {
  const run = validate(result);
  assert.notEqual(run.status, 0, `${label}: unexpectedly accepted`);
  assert.match(`${run.stderr}${run.stdout}`, new RegExp(message), label);
}

function processSamplesThrough(template, endMs, terminalMs = endMs) {
  const start = template.processSamples[0];
  const steady = { ...template.processSamples[1], processCount: 2 };
  const samples = [];
  for (let monotonicMs = 0; monotonicMs < terminalMs; monotonicMs += 100) {
    samples.push({ ...(monotonicMs === 0 ? start : steady), monotonicMs });
  }
  if (endMs > terminalMs && samples.at(-1)?.monotonicMs !== terminalMs) {
    samples.push({ ...steady, monotonicMs: terminalMs });
  }
  samples.push({ ...template.processSamples.at(-1), monotonicMs: endMs });
  return samples;
}

function timedOutBeforeProviderTerminal() {
  const result = structuredClone(failure);
  const terminalIndex = result.milestones.findIndex(
    (item) => item.name === result.drain.terminalMilestone,
  );
  result.drain = { ...result.drain, status: "timed_out", timedOut: true };
  result.milestones = result.milestones.slice(0, terminalIndex);
  result.disposition = {
    state: "failed",
    reason: "drain_timed_out",
    successfulComparisonEligible: false,
  };
  result.retryEvidence = null;
  result.failureMetadata = null;
  result.operationalStatus = null;
  result.outputLimitAtomicityEvidence = null;
  result.processSamples = processSamplesThrough(result, 30000);
  result.resource.maxSteadyProductProcessCount = 2;
  return result;
}

function completedAtBoundary(terminalMs) {
  const result = structuredClone(success);
  const setTime = (name, monotonicMs) => {
    result.milestones.find((item) => item.name === name).monotonicMs = monotonicMs;
  };
  setTime("target_injection_acknowledged", terminalMs);
  setTime("target_model_request_dispatched", terminalMs + 1);
  setTime("scenario_terminal", terminalMs + 2);
  setTime("post_teardown_grace_elapsed", terminalMs + 3);
  result.processSamples = processSamplesThrough(result, terminalMs + 3, terminalMs + 2);
  return result;
}

function renderEvidence(result, scenario, items, packId) {
  const payload = canonicalizeJson(buildRenderPayload(result, scenario, fixture, items, packId));
  return {
    evidence: {
      rendererId: "alpha-jcs-renderer-v1",
      utf8Payload: payload,
      tokenizerId: "deterministic-fixture-tokenizer-v1",
      tokenizerRevision: "1",
      tokenIds: tokenizeRenderPayload(payload),
    },
    bytes: Buffer.byteLength(payload, "utf8"),
  };
}

function unsupportedPackFailure() {
  // Keep this valid under the former contract so the test proves removal, not only schema rejection.
  const result = structuredClone(success);
  const scenario = fixture.scenarios.find((item) => item.scenarioId === result.scenarioId);
  result.packDegradations = ["x".repeat(17000)];
  result.packCompilationFailure = "injection_pack_limit_exceeded";
  result.disposition = {
    state: "failed",
    reason: "injection_pack_limit_exceeded",
    successfulComparisonEligible: false,
  };
  result.injectedItems = [];
  result.omittedItems = [];
  for (const name of ["inputCandidates", "tracedCandidates", "deadlineUnprocessed",
    "admittedCandidates", "selectedItems"]) result.counts[name] = 0;
  result.quality = {
    expectedInjectedItemCount: scenario.expectedInjectedItems.length,
    matchedInjectedItemCount: 0,
    expectedOmissionCount: scenario.expectedOmissions.length,
    matchedOmissionCount: 0,
    forbiddenFactCount: 0,
  };
  result.attemptedItems = [];
  result.packId = null;
  result.finalRenderEvidence = null;
  result.renderedBytes = 0;
  result.injectedTokens = 0;
  const attempted = renderEvidence(result, scenario, [], null);
  result.attemptedRenderEvidence = attempted.evidence;
  result.attemptedRenderedBytes = attempted.bytes;
  result.attemptedInjectedTokens = result.attemptedRenderEvidence.tokenIds.length;
  return result;
}

function oversizedFinalPack(degradation) {
  const result = structuredClone(success);
  const scenario = fixture.scenarios.find((item) => item.scenarioId === result.scenarioId);
  result.packDegradations = [degradation];
  const final = renderEvidence(result, scenario, result.injectedItems, result.packId);
  result.finalRenderEvidence = final.evidence;
  result.attemptedRenderEvidence = "same_as_final";
  result.renderedBytes = final.bytes;
  result.attemptedRenderedBytes = final.bytes;
  result.injectedTokens = final.evidence.tokenIds.length;
  result.attemptedInjectedTokens = final.evidence.tokenIds.length;
  return result;
}

assertAccepted(success, "positive example");
assertAccepted(failure, "failure example");

const timeout = timedOutBeforeProviderTerminal();
assertAccepted(timeout, "timeout before provider terminal");
for (const field of ["retryEvidence", "failureMetadata", "operationalStatus"]) {
  const isolated = structuredClone(timeout);
  isolated[field] = failure[field];
  assertRejected(isolated, "provider failure evidence does not match observed lifecycle",
    `timeout with isolated ${field}`);
}

assertAccepted(completedAtBoundary(29999), "completion before timeout boundary");
assertRejected(completedAtBoundary(30000), "completed drain reached or exceeded the pinned timeout",
  "completion at timeout boundary");
assertRejected(unsupportedPackFailure(), "unknown property",
  "Slice 1 explicit pack-compilation failure");
const byteOversized = oversizedFinalPack("x".repeat(17000));
assert.ok(byteOversized.renderedBytes >
  fixture.effectiveConfiguration.resourceProfile.injectionEnvelope.maxRenderedBytes);
assert.ok(byteOversized.injectedTokens <=
  fixture.effectiveConfiguration.resourceProfile.injectionEnvelope.maxInjectedTokens);
assertRejected(byteOversized, "oversized InjectionPack was recorded as final output",
  "byte-oversized final pack");
const tokenOversized = oversizedFinalPack("x ".repeat(801).trim());
assert.ok(tokenOversized.renderedBytes <=
  fixture.effectiveConfiguration.resourceProfile.injectionEnvelope.maxRenderedBytes);
assert.ok(tokenOversized.injectedTokens >
  fixture.effectiveConfiguration.resourceProfile.injectionEnvelope.maxInjectedTokens);
assertRejected(tokenOversized, "oversized InjectionPack was recorded as final output",
  "token-oversized final pack");

console.log("Alpha result regression checks passed.");
