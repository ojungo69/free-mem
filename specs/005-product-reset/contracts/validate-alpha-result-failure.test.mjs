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
const fixtureSemanticPath = join(fixtureRoot, "slice1-bidirectional-en-v1.semantic.jq");
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

function assertFixtureRejected(mutant, label) {
  const run = spawnSync("jq", ["-e", "-f", fixtureSemanticPath], {
    input: JSON.stringify(mutant), encoding: "utf8",
  });
  assert.equal(run.error, undefined, `${label}: jq did not start`);
  assert.equal(typeof run.status, "number", `${label}: jq did not report an exit status`);
  assert.notEqual(run.status, 0, label);
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
assertRejected(skippedInjectionRender, /attempted render exists without an observed selection boundary/,
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

const delayedFirstMeasurement = structuredClone(success);
const delayedFirstMeasurementEvidence = structuredClone(successEvidence);
for (const run of [delayedFirstMeasurement.latencyEvidence.runs[0],
  delayedFirstMeasurementEvidence.scenarios[0].latencyRuns[0]]) {
  for (const timing of run.captureTimings) {
    timing.startMonotonicMs += 1000;
    timing.endMonotonicMs += 1000;
  }
  run.coldLexicalInjectionTiming.startMonotonicMs += 1000;
  run.coldLexicalInjectionTiming.endMonotonicMs += 1000;
}
delayedFirstMeasurementEvidence.scenarios[0].runPreparations[0].runFinishedMonotonicMs += 1000;
assertRejected(delayedFirstMeasurement, /runner preparation evidence does not match latency runs/,
  "first measurement was delayed after cold reset", delayedFirstMeasurementEvidence);

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
  result.attemptedItems = structuredClone(result.injectedItems);
  result.attemptedRenderEvidence = null;
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

function clearUnobservedSelection(result) {
  for (const name of ["inputCandidates", "tracedCandidates", "deadlineUnprocessed",
    "admittedCandidates", "selectedItems"]) result.counts[name] = 0;
  result.counts.summaryCount = 0;
  result.counts.durableMemoryCount = 0;
  result.injectedItems = [];
  result.omittedItems = [];
  result.attemptedItems = [];
  result.attemptedRenderEvidence = null;
  result.selectionTimingEvidence = null;
  result.selectionElapsedMs = 0;
  result.packDegradations = [];
  result.quality = {
    expectedInjectedItemCount: 4, matchedInjectedItemCount: 0,
    expectedOmissionCount: 0, matchedOmissionCount: 0, forbiddenFactCount: 0,
  };
}

const timeoutBeforePersistence = timedOutSuccessAt("source_flush_requested_by_target_prompt");
clearUnobservedSelection(timeoutBeforePersistence);
assertAccepted(timeoutBeforePersistence, "timeout before persistence commit",
  runnerEvidenceFor(timeoutBeforePersistence, successEvidence));

const timeoutBeforeCapture = timedOutSuccessAt("source_session_started");
clearUnobservedSelection(timeoutBeforeCapture);
timeoutBeforeCapture.counts.captured = 0;
timeoutBeforeCapture.counts.committed = 0;
timeoutBeforeCapture.securityDenominators = {
  ...Object.fromEntries(Object.keys(timeoutBeforeCapture.securityDenominators)
    .map((name) => [name, 0])),
  agentOperationCount: 1,
};
for (const name of Object.keys(timeoutBeforeCapture.securityEvidence))
  timeoutBeforeCapture.securityEvidence[name] = 0;
assertAccepted(timeoutBeforeCapture, "timeout before event capture",
  runnerEvidenceFor(timeoutBeforeCapture, successEvidence));

const timeoutBeforeProviderAttempt = timedOutSuccessAt("source_events_captured");
clearUnobservedSelection(timeoutBeforeProviderAttempt);
assertRejected(timeoutBeforeProviderAttempt, /provider egress exists before the observed attempt boundary/,
  "timeout before provider attempt claimed egress",
  runnerEvidenceFor(timeoutBeforeProviderAttempt, successEvidence));

const earlyAttemptedRender = structuredClone(timeoutBeforePersistence);
const successScenario = fixture.scenarios.find((item) => item.scenarioId === success.scenarioId);
const earlyPayload = canonicalizeJson(
  buildRenderPayload(earlyAttemptedRender, successScenario, fixture, [], null),
);
earlyAttemptedRender.attemptedRenderEvidence = {
  rendererId: "alpha-jcs-renderer-v1", utf8Payload: earlyPayload,
  tokenizerId: "deterministic-fixture-tokenizer-v1", tokenizerRevision: "1",
  tokenIds: tokenizeRenderPayload(earlyPayload),
};
earlyAttemptedRender.attemptedRenderedBytes = Buffer.byteLength(earlyPayload, "utf8");
earlyAttemptedRender.attemptedInjectedTokens =
  earlyAttemptedRender.attemptedRenderEvidence.tokenIds.length;
assertRejected(earlyAttemptedRender, /attempted render exists without an observed selection boundary/,
  "timeout before selection claimed an attempted render",
  runnerEvidenceFor(earlyAttemptedRender, successEvidence));

const earlyAttemptAliases = structuredClone(timeoutBeforePersistence);
earlyAttemptAliases.attemptedItems = "same_as_final";
earlyAttemptAliases.attemptedRenderEvidence = "same_as_final";
assertRejected(earlyAttemptAliases, /attempted render aliases require an observed final pack/,
  "timeout before selection used final-pack aliases",
  runnerEvidenceFor(earlyAttemptAliases, successEvidence));

const timeoutAfterSelection = timedOutSuccessAt("target_selection_finished");
const timeoutAfterSelectionEvidence = runnerEvidenceFor(timeoutAfterSelection, successEvidence);
assertAccepted(timeoutAfterSelection, "timeout after completed selection",
  timeoutAfterSelectionEvidence);
const postTimeoutMilestone = structuredClone(timeoutAfterSelection);
postTimeoutMilestone.milestones.find((item) => item.name === "target_selection_started").monotonicMs =
  31000;
postTimeoutMilestone.milestones.find((item) => item.name === "target_selection_finished").monotonicMs =
  31100;
postTimeoutMilestone.selectionTimingEvidence = {
  startMonotonicMs: 31000, endMonotonicMs: 31100,
};
postTimeoutMilestone.selectionElapsedMs = 100;
assertRejected(postTimeoutMilestone, /timed-out milestone occurred after the pinned timeout/,
  "timeout record contained a post-expiration milestone",
  runnerEvidenceFor(postTimeoutMilestone, successEvidence));
const postTimeoutCleanup = structuredClone(timeoutAfterSelection);
postTimeoutCleanup.processSamples.at(-1).processCount = 2;
postTimeoutCleanup.processSamples.push({ ...success.processSamples.at(-1), monotonicMs: 30100 });
assertRejected(postTimeoutCleanup, /timed-out resource sample does not match the deadline boundary/,
  "post-timeout cleanup hid live processes at the deadline",
  runnerEvidenceFor(postTimeoutCleanup, successEvidence));
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

const deadlineExceeded = structuredClone(success);
deadlineExceeded.counts.tracedCandidates = 0;
deadlineExceeded.counts.deadlineUnprocessed = deadlineExceeded.counts.inputCandidates;
deadlineExceeded.counts.admittedCandidates = 0;
deadlineExceeded.counts.selectedItems = 0;
deadlineExceeded.injectedItems = [];
deadlineExceeded.omittedItems = [];
deadlineExceeded.attemptedItems = [];
deadlineExceeded.attemptedRenderEvidence = null;
deadlineExceeded.attemptedRenderedBytes = 0;
deadlineExceeded.attemptedInjectedTokens = 0;
deadlineExceeded.packId = null;
deadlineExceeded.finalRenderEvidence = null;
deadlineExceeded.renderedBytes = 0;
deadlineExceeded.injectedTokens = 0;
deadlineExceeded.quality = {
  expectedInjectedItemCount: 4, matchedInjectedItemCount: 0,
  expectedOmissionCount: 0, matchedOmissionCount: 0, forbiddenFactCount: 0,
};
deadlineExceeded.disposition = {
  state: "failed", reason: "selection_deadline_exceeded", successfulComparisonEligible: false,
};
assertAccepted(deadlineExceeded, "completed selection deadline failure",
  runnerEvidenceFor(deadlineExceeded, successEvidence));

const qualityFailure = structuredClone(success);
qualityFailure.injectedItems[0].fact = "Fixture-mismatched selected fact.";
qualityFailure.quality.matchedInjectedItemCount -= 1;
const qualityPayload = canonicalizeJson(
  buildRenderPayload(qualityFailure, successScenario, fixture,
    qualityFailure.injectedItems, qualityFailure.packId),
);
qualityFailure.finalRenderEvidence = {
  rendererId: "alpha-jcs-renderer-v1", utf8Payload: qualityPayload,
  tokenizerId: "deterministic-fixture-tokenizer-v1", tokenizerRevision: "1",
  tokenIds: tokenizeRenderPayload(qualityPayload),
};
qualityFailure.attemptedRenderEvidence = "same_as_final";
qualityFailure.renderedBytes = Buffer.byteLength(qualityPayload, "utf8");
qualityFailure.attemptedRenderedBytes = qualityFailure.renderedBytes;
qualityFailure.injectedTokens = qualityFailure.finalRenderEvidence.tokenIds.length;
qualityFailure.attemptedInjectedTokens = qualityFailure.injectedTokens;
qualityFailure.disposition = {
  state: "failed", reason: "quality_threshold_exceeded", successfulComparisonEligible: false,
};
assertAccepted(qualityFailure, "completed selection quality failure",
  runnerEvidenceFor(qualityFailure, successEvidence));

const unsupportedDeadlineOmission = structuredClone(deadlineExceeded);
const { selectionReason: _selectionReason, ...deadlineOmission } = success.injectedItems[0];
unsupportedDeadlineOmission.omittedItems = [{ ...deadlineOmission, reason: "candidate_limit" }];
unsupportedDeadlineOmission.counts.tracedCandidates = 1;
unsupportedDeadlineOmission.counts.deadlineUnprocessed = 3;
unsupportedDeadlineOmission.quality = {
  expectedInjectedItemCount: 4, matchedInjectedItemCount: 0,
  expectedOmissionCount: 0, matchedOmissionCount: 0, forbiddenFactCount: 0,
};
assertRejected(unsupportedDeadlineOmission, /omission reason outside the Slice 1 contract/,
  "deadline failure used a Slice 2 omission reason",
  runnerEvidenceFor(unsupportedDeadlineOmission, successEvidence));

const fabricatedDeadlineTrace = structuredClone(deadlineExceeded);
const fabricatedOmission = {
  ...deadlineOmission,
  lineageId: "0".repeat(64),
  sourceEventIds: ["fabricated-event"],
  sourceSpans: [{ eventId: "fabricated-event", startByte: 0, endByte: 1 }],
  reason: "omitted_ineligible",
};
fabricatedDeadlineTrace.omittedItems = [fabricatedOmission];
fabricatedDeadlineTrace.counts.tracedCandidates = 1;
fabricatedDeadlineTrace.counts.deadlineUnprocessed = 3;
assertRejected(fabricatedDeadlineTrace, /result trace provenance does not match scenario source events/,
  "deadline failure fabricated trace provenance",
  runnerEvidenceFor(fabricatedDeadlineTrace, successEvidence));

const oversizedDeadlineAttempt = structuredClone(deadlineExceeded);
const oversizedOmission = { ...deadlineOmission, fact: "x".repeat(20000), reason: "omitted_budget" };
oversizedDeadlineAttempt.omittedItems = [oversizedOmission];
oversizedDeadlineAttempt.counts.tracedCandidates = 1;
oversizedDeadlineAttempt.counts.deadlineUnprocessed = 3;
oversizedDeadlineAttempt.counts.admittedCandidates = 1;
const { reason: _reason, ...oversizedAttemptedItem } = oversizedOmission;
oversizedAttemptedItem.selectionReason = oversizedAttemptedItem.sourceLane;
oversizedDeadlineAttempt.attemptedItems = [oversizedAttemptedItem];
const oversizedAttemptPayload = canonicalizeJson(
  buildRenderPayload(oversizedDeadlineAttempt, successScenario, fixture,
    oversizedDeadlineAttempt.attemptedItems, null),
);
oversizedDeadlineAttempt.attemptedRenderEvidence = {
  rendererId: "alpha-jcs-renderer-v1", utf8Payload: oversizedAttemptPayload,
  tokenizerId: "deterministic-fixture-tokenizer-v1", tokenizerRevision: "1",
  tokenIds: tokenizeRenderPayload(oversizedAttemptPayload),
};
oversizedDeadlineAttempt.attemptedRenderedBytes = Buffer.byteLength(oversizedAttemptPayload, "utf8");
oversizedDeadlineAttempt.attemptedInjectedTokens =
  oversizedDeadlineAttempt.attemptedRenderEvidence.tokenIds.length;
oversizedDeadlineAttempt.quality = {
  expectedInjectedItemCount: 4, matchedInjectedItemCount: 0,
  expectedOmissionCount: 0, matchedOmissionCount: 0, forbiddenFactCount: 0,
};
assert.ok(oversizedDeadlineAttempt.attemptedRenderedBytes >
  fixture.effectiveConfiguration.resourceProfile.injectionEnvelope.maxRenderedBytes);
assertRejected(oversizedDeadlineAttempt, /oversized attempted InjectionPack has no valid final output/,
  "deadline failure retained an oversized attempted pack",
  runnerEvidenceFor(oversizedDeadlineAttempt, successEvidence));

const missingRetrievalMilestone = structuredClone(fixture);
missingRetrievalMilestone.lifecycleProfiles.bidirectional_prompt_flush =
  missingRetrievalMilestone.lifecycleProfiles.bidirectional_prompt_flush.filter(
    (name) => name !== "target_retrieval_requested",
  );
assertFixtureRejected(missingRetrievalMilestone,
  "fixture semantics accepted a selection lifecycle without retrieval");

const injectedForbiddenFact = structuredClone(fixture);
const injectedForbiddenScenario = injectedForbiddenFact.scenarios[0];
injectedForbiddenScenario.forbiddenFacts[0] = injectedForbiddenScenario.expectedInjectedItems[0].fact;
assertFixtureRejected(injectedForbiddenFact,
  "fixture semantics accepted an injected forbidden fact");

const inconsistentRevisionIdentity = structuredClone(fixture);
const revisionItems = inconsistentRevisionIdentity.scenarios[0].expectedInjectedItems;
revisionItems[1].lineageId = revisionItems[0].lineageId;
revisionItems[1].revisionOrdinal = revisionItems[0].revisionOrdinal + 1;
assertFixtureRejected(inconsistentRevisionIdentity,
  "fixture semantics accepted two active revisions for one lineage");

console.log("Alpha result failed-record invariant checks passed.");
